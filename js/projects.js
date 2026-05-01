/* MarkdownLab — project / file / tab state manager.
 *
 * State shape held in memory (mirrored to IndexedDB):
 *   projects: Map<id, Project>     Project = { id, name, color, order, createdAt, collapsed }
 *   files:    Map<id, File>        File    = { id, projectId, name, content, order,
 *                                              createdAt, updatedAt, cursor,
 *                                              scrollEditor, scrollPreview }
 *   openIds:  string[]             Ordered list of open tabs.
 *   activeId: string | null        Currently active tab.
 *
 * Mutations go through this module so every UI surface (sidebar, tabs,
 * editor, status bar) can subscribe to a single event bus.
 *
 * We also carry per-file dirty state in a Set<id> for the in-memory session;
 * tabs show a `●` while a file has pending writes.
 */

import { DB, newId } from './db.js';

// Project colors cycle through the brand palette; each project gets a
// deterministic color based on creation order so the sidebar stays varied
// without requiring manual picks.
export const PROJECT_COLORS = [
  { id: 'emerald', hex: '#10b981' },
  { id: 'cyan',    hex: '#06b6d4' },
  { id: 'violet',  hex: '#8b5cf6' },
  { id: 'amber',   hex: '#f59e0b' },
  { id: 'rose',    hex: '#f43f5e' },
  { id: 'sky',     hex: '#0ea5e9' },
  { id: 'lime',    hex: '#84cc16' },
  { id: 'fuchsia', hex: '#d946ef' },
];

const DEFAULT_FILE_NAME = 'Untitled.md';

export const Store = {
  projects: new Map(),
  files:    new Map(),
  openIds:  [],
  activeId: null,
  dirty:    new Set(),

  _listeners: new Set(),

  on(fn)  { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  emit(kind, payload) {
    for (const fn of this._listeners) {
      try { fn(kind, payload); } catch (e) { console.error(e); }
    }
  },

  // ---- Derived selectors --------------------------------------------------
  projectList() {
    return Array.from(this.projects.values()).sort((a, b) => a.order - b.order);
  },
  filesIn(projectId) {
    return Array.from(this.files.values())
      .filter(f => f.projectId === projectId)
      .sort((a, b) => a.order - b.order);
  },
  openFiles() {
    return this.openIds.map(id => this.files.get(id)).filter(Boolean);
  },
  activeFile() {
    return this.activeId ? this.files.get(this.activeId) : null;
  },
  activeProject() {
    const f = this.activeFile();
    return f ? this.projects.get(f.projectId) : null;
  },
};

// ---- Load / seed --------------------------------------------------------

const LEGACY_DOC_KEY = 'mdlab.doc.v1';
const LEGACY_MIGRATED_FLAG = 'mdlab.doc.v1.migrated';

function readLegacyDoc() {
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_FLAG)) return null;
    const raw = localStorage.getItem(LEGACY_DOC_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d && typeof d.source === 'string' && d.source.length > 0) {
      return { source: d.source, filename: d.filename || 'Untitled.md' };
    }
  } catch {}
  return null;
}

function markLegacyMigrated() {
  try {
    localStorage.setItem(LEGACY_MIGRATED_FLAG, '1');
  } catch {}
}

export async function loadAll({ fallbackContent } = {}) {
  await DB.ready();

  const [projects, files] = await Promise.all([
    DB.getAll('projects'),
    DB.getAll('files'),
  ]);

  Store.projects = new Map(projects.map(p => [p.id, p]));
  Store.files    = new Map(files.map(f => [f.id, f]));

  const [openIds, activeId] = await Promise.all([
    DB.sessionGet('openIds'),
    DB.sessionGet('activeId'),
  ]);
  Store.openIds  = Array.isArray(openIds) ? openIds.filter(id => Store.files.has(id)) : [];
  Store.activeId = Store.files.has(activeId) ? activeId : (Store.openIds[0] || null);

  // First-run seed: create a "My documents" project + welcome file if the
  // DB is empty.
  if (Store.projects.size === 0 && Store.files.size === 0) {
    const legacy = readLegacyDoc();
    if (legacy) {
      await seedFromLegacy(legacy);
      markLegacyMigrated();
    } else {
      await seedEmpty({ fallbackContent });
    }
  }

  Store.emit('load');
  return Store;
}

async function seedEmpty({ fallbackContent }) {
  const project = await createProject({ name: 'My documents', emit: false });
  if (fallbackContent) {
    await createFile({
      projectId: project.id,
      name: 'welcome.md',
      content: fallbackContent,
      emit: false,
    });
  }
  const first = Store.filesIn(project.id)[0];
  if (first) {
    Store.openIds  = [first.id];
    Store.activeId = first.id;
    await persistSession();
  }
}

async function seedFromLegacy({ source, filename }) {
  const project = await createProject({ name: 'My documents', emit: false });
  const file = await createFile({
    projectId: project.id,
    name: filename,
    content: source,
    emit: false,
  });
  Store.openIds  = [file.id];
  Store.activeId = file.id;
  await persistSession();
}

// ---- Projects -----------------------------------------------------------

export async function createProject({ name = 'New project', emit = true } = {}) {
  const order = Store.projects.size;
  const color = PROJECT_COLORS[order % PROJECT_COLORS.length].id;
  const project = {
    id: newId(),
    name,
    color,
    order,
    collapsed: false,
    createdAt: Date.now(),
  };
  Store.projects.set(project.id, project);
  await DB.put('projects', project);
  if (emit) Store.emit('project:created', { project });
  return project;
}

export async function renameProject(id, name) {
  const p = Store.projects.get(id);
  if (!p) return;
  p.name = name.trim() || 'Untitled project';
  await DB.put('projects', p);
  Store.emit('project:renamed', { project: p });
}

export async function setProjectCollapsed(id, collapsed) {
  const p = Store.projects.get(id);
  if (!p) return;
  p.collapsed = !!collapsed;
  await DB.put('projects', p);
  Store.emit('project:updated', { project: p });
}

// Delete a project and its files. State mutations complete before any
// `file:deleted` events are emitted so subscribers never observe an
// intermediate state where openIds references a missing file.
export async function deleteProject(id) {
  const project = Store.projects.get(id);
  if (!project) return null;
  const filesToRemove = Store.filesIn(id).map(f => ({ ...f }));
  const removedIds = new Set(filesToRemove.map(f => f.id));
  const wereOpen = new Map(filesToRemove.map(f => [f.id, Store.openIds.includes(f.id)]));
  const prevOpenIds = Store.openIds.slice();
  const prevActiveId = Store.activeId;
  const wasAnyOpen = [...wereOpen.values()].some(Boolean);

  for (const f of filesToRemove) {
    Store.files.delete(f.id);
    Store.dirty.delete(f.id);
  }
  Store.openIds = Store.openIds.filter(fid => !removedIds.has(fid));
  if (!Store.openIds.includes(Store.activeId)) Store.activeId = Store.openIds[0] || null;
  Store.projects.delete(id);

  await Promise.all([
    ...filesToRemove.map(f => DB.del('files', f.id)),
    DB.del('projects', id),
  ]);
  if (wasAnyOpen) await persistSession();
  await reorderProjects();

  for (const f of filesToRemove) {
    Store.emit('file:deleted', { id: f.id, wasOpen: wereOpen.get(f.id), cascadeFromProject: id });
  }
  Store.emit('project:deleted', { id });

  return {
    kind: 'project',
    project: { ...project },
    files: filesToRemove,
    openIds: prevOpenIds,
    activeId: prevActiveId,
  };
}

export async function restoreProject(snapshot) {
  if (!snapshot || snapshot.kind !== 'project') return;
  const { project, files, openIds, activeId } = snapshot;
  Store.projects.set(project.id, { ...project });
  await DB.put('projects', { ...project });
  for (const f of files) {
    Store.files.set(f.id, { ...f });
    await DB.put('files', { ...f });
  }
  await reorderProjects();
  await reorderFiles(project.id);
  if (openIds && openIds.length) {
    Store.openIds = openIds.filter(fid => Store.files.has(fid));
    Store.activeId = activeId && Store.files.has(activeId) ? activeId : (Store.openIds[0] || null);
    await persistSession();
    Store.emit('tabs:reordered');
    if (Store.activeId) Store.emit('tab:activated', { id: Store.activeId });
  }
  Store.emit('project:created', { project: Store.projects.get(project.id) });
  for (const f of files) Store.emit('file:created', { file: Store.files.get(f.id) });
}

export async function reorderProjects(newOrder /* optional: array of ids */) {
  const list = newOrder
    ? newOrder.map(id => Store.projects.get(id)).filter(Boolean)
    : Store.projectList();
  list.forEach((p, i) => { p.order = i; });
  await DB.bulkPut('projects', list);
  Store.emit('projects:reordered');
}

// ---- Files --------------------------------------------------------------

export async function createFile({ projectId, name = DEFAULT_FILE_NAME, content = '', emit = true } = {}) {
  if (!Store.projects.get(projectId)) throw new Error('Unknown project');
  const siblings = Store.filesIn(projectId);
  const file = {
    id: newId(),
    projectId,
    name: ensureMdExt(name),
    content,
    order: siblings.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cursor: 0,
    scrollEditor: 0,
    scrollPreview: 0,
  };
  Store.files.set(file.id, file);
  await DB.put('files', file);
  if (emit) Store.emit('file:created', { file });
  return file;
}

// Rename a file. On sibling-name collision, auto-uniquifies (`foo.md` →
// `foo 2.md`) and fires `file:rename-collision` so the UI can notify.
// Returns the committed name.
export async function renameFile(id, name) {
  const f = Store.files.get(id);
  if (!f) return null;
  const requested = ensureMdExt((name || '').trim() || DEFAULT_FILE_NAME);
  if (requested === f.name) return f.name;
  const collision = Store.filesIn(f.projectId)
    .some(other => other.id !== id && other.name.toLowerCase() === requested.toLowerCase());
  let finalName = requested;
  if (collision) {
    // Exclude this file from the taken-set so a case-only rename doesn't
    // collide with itself and produce `name 2.md`.
    const taken = new Set(
      Store.filesIn(f.projectId)
        .filter(other => other.id !== id)
        .map(other => other.name.toLowerCase())
    );
    const stem = requested.replace(/\.md$/i, '');
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} ${i}.md`;
      if (!taken.has(candidate.toLowerCase())) { finalName = candidate; break; }
    }
  }
  f.name = finalName;
  f.updatedAt = Date.now();
  await DB.put('files', f);
  if (collision) Store.emit('file:rename-collision', { file: f, requested, finalName });
  Store.emit('file:renamed', { file: f });
  return finalName;
}

export async function duplicateFile(id) {
  const f = Store.files.get(id);
  if (!f) return null;
  const baseName = f.name.replace(/\.md$/i, '');
  const copy = await createFile({
    projectId: f.projectId,
    name: `${baseName} (copy).md`,
    content: f.content,
  });
  return copy;
}

export async function deleteFile(id) {
  const f = Store.files.get(id);
  if (!f) return null;
  const snapshot = { ...f };
  const prevOpenIds = Store.openIds.slice();
  const prevActiveId = Store.activeId;
  Store.files.delete(id);
  Store.dirty.delete(id);
  await DB.del('files', id);

  const wasOpen = Store.openIds.includes(id);
  Store.openIds = Store.openIds.filter(oid => oid !== id);
  if (Store.activeId === id) Store.activeId = Store.openIds[Store.openIds.length - 1] || null;

  Store.emit('file:deleted', { id, wasOpen });
  if (wasOpen) await persistSession();
  await reorderFiles(f.projectId);

  return {
    kind: 'file',
    file: snapshot,
    wasOpen,
    openIds: prevOpenIds,
    activeId: prevActiveId,
  };
}

export async function restoreFile(snapshot) {
  if (!snapshot || snapshot.kind !== 'file') return null;
  const { file, wasOpen, openIds, activeId } = snapshot;
  if (!Store.projects.has(file.projectId)) return null;
  Store.files.set(file.id, { ...file });
  await DB.put('files', { ...file });
  await reorderFiles(file.projectId);
  if (wasOpen) {
    Store.openIds = (openIds || []).filter(fid => Store.files.has(fid));
    if (!Store.openIds.includes(file.id)) Store.openIds.push(file.id);
    Store.activeId = activeId && Store.files.has(activeId) ? activeId : file.id;
    await persistSession();
    Store.emit('tabs:reordered');
    if (Store.activeId) Store.emit('tab:activated', { id: Store.activeId });
  }
  Store.emit('file:created', { file: Store.files.get(file.id) });
  return Store.files.get(file.id);
}

// Writes file content + marks clean; callers should debounce this in the UI.
export async function saveFileContent(id, content, { cursor, scrollEditor, scrollPreview } = {}) {
  const f = Store.files.get(id);
  if (!f) return;
  f.content = content;
  f.updatedAt = Date.now();
  if (typeof cursor        === 'number') f.cursor        = cursor;
  if (typeof scrollEditor  === 'number') f.scrollEditor  = scrollEditor;
  if (typeof scrollPreview === 'number') f.scrollPreview = scrollPreview;
  await DB.put('files', f);
  Store.dirty.delete(id);
  Store.emit('file:saved', { file: f });
}

export function markDirty(id) {
  if (!Store.dirty.has(id)) {
    Store.dirty.add(id);
    Store.emit('file:dirty', { id });
  }
}

export async function reorderFiles(projectId, newOrderIds) {
  const list = newOrderIds
    ? newOrderIds.map(id => Store.files.get(id)).filter(f => f && f.projectId === projectId)
    : Store.filesIn(projectId);
  list.forEach((f, i) => { f.order = i; });
  await DB.bulkPut('files', list);
  Store.emit('files:reordered', { projectId });
}

export async function moveFile(fileId, targetProjectId, targetIndex) {
  const f = Store.files.get(fileId);
  if (!f) return;
  const fromProjectId = f.projectId;
  f.projectId = targetProjectId;

  // Reorder targets, inserting at targetIndex.
  const targetList = Store.filesIn(targetProjectId).filter(x => x.id !== fileId);
  const clampedIdx = Math.max(0, Math.min(targetIndex, targetList.length));
  targetList.splice(clampedIdx, 0, f);
  targetList.forEach((x, i) => { x.order = i; });
  await DB.bulkPut('files', targetList);

  if (fromProjectId !== targetProjectId) {
    // Compact source ordering.
    const fromList = Store.filesIn(fromProjectId);
    fromList.forEach((x, i) => { x.order = i; });
    await DB.bulkPut('files', fromList);
  }
  Store.emit('files:reordered', { projectId: targetProjectId });
  Store.emit('files:reordered', { projectId: fromProjectId });
}

// ---- Tabs / session -----------------------------------------------------

export async function closeFile(id) {
  const idx = Store.openIds.indexOf(id);
  if (idx === -1) return;
  Store.openIds.splice(idx, 1);
  if (Store.activeId === id) {
    Store.activeId = Store.openIds[idx] || Store.openIds[idx - 1] || Store.openIds[0] || null;
  }
  await persistSession();
  Store.emit('tab:closed', { id });
}

export async function activateFile(id) {
  if (!Store.files.has(id)) return;
  if (!Store.openIds.includes(id)) Store.openIds.push(id);
  Store.activeId = id;
  await persistSession();
  Store.emit('tab:activated', { id });
}

export async function reorderTabs(newOrderIds) {
  Store.openIds = newOrderIds.filter(id => Store.files.has(id));
  await persistSession();
  Store.emit('tabs:reordered');
}

async function persistSession() {
  await Promise.all([
    DB.sessionSet('openIds', Store.openIds),
    DB.sessionSet('activeId', Store.activeId),
  ]);
}

// ---- Search -------------------------------------------------------------

// Fuzzy subsequence match with positional scoring. Lightweight enough to run
// per-keystroke on thousands of files without instrumentation.
export function fuzzyScore(needle, haystack) {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let ni = 0, score = 0, prev = -1, streak = 0;
  for (let i = 0; i < h.length && ni < n.length; i++) {
    if (h[i] === n[ni]) {
      // Consecutive chars and word-boundary matches score higher.
      if (prev === i - 1) streak++;
      else streak = 1;
      let points = 1 + streak;
      if (i === 0 || /[\s_\-/.]/.test(h[i - 1])) points += 2;
      score += points;
      prev = i;
      ni++;
    }
  }
  if (ni < n.length) return 0;
  // Shorter matches rank higher so "rfc" beats "reference.md" on input "rfc".
  return score / (1 + h.length - n.length);
}

export function searchFiles(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const results = [];
  for (const f of Store.files.values()) {
    const project = Store.projects.get(f.projectId);
    const label = project ? `${project.name} / ${f.name}` : f.name;
    const nameScore    = fuzzyScore(q, f.name)    * 2;
    const labelScore   = fuzzyScore(q, label)     * 1;
    const contentScore = fuzzyScore(q, (f.content || '').slice(0, 4000)) * 0.25;
    const total = nameScore + labelScore + contentScore;
    if (total > 0) results.push({ file: f, project, score: total });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 50);
}

// ---- Utilities ----------------------------------------------------------

function ensureMdExt(name) {
  return /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`;
}

export function uniqueFileName(projectId, base) {
  const siblings = Store.filesIn(projectId).map(f => f.name.toLowerCase());
  const baseClean = ensureMdExt(base);
  if (!siblings.includes(baseClean.toLowerCase())) return baseClean;
  const stem = baseClean.replace(/\.md$/i, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} ${i}.md`;
    if (!siblings.includes(candidate.toLowerCase())) return candidate;
  }
  return `${stem} ${Date.now()}.md`;
}

export function projectColor(id) {
  return PROJECT_COLORS.find(c => c.id === id)?.hex || PROJECT_COLORS[0].hex;
}
