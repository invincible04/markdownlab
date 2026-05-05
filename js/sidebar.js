/* MarkdownLab — sidebar UI for projects + files.
 *
 * Renders a two-level tree: projects → files. Handles:
 *   · click to open a file (delegates to the tabs/editor layer via callbacks)
 *   · inline rename (double-click / F2 / context menu)
 *   · new project / new file / delete / duplicate
 *   · drag-and-drop (files within a project, files across projects,
 *     project reorder)
 *   · search-as-you-type with inline match highlighting
 *   · collapsible project sections with persisted state (in DB)
 *   · resize handle with keyboard support
 *   · mobile drawer open/close
 *
 * Subscribes to Store events and re-renders the affected section; the whole
 * tree is cheap to rebuild (usually < 1 ms on < 500 files), so we just
 * rebuild on every mutation rather than maintaining partial-update logic.
 */

import {
  Store,
  createProject, renameProject, setProjectCollapsed, deleteProject, reorderProjects,
  createFile, renameFile, duplicateFile, deleteFile, reorderFiles, moveFile,
  searchFiles, uniqueFileName, projectColor,
} from './projects.js';
import { DB, onBlocked } from './db.js';
import { escapeHtml, cssEscape } from './utils.js';

// Default width lives in CSS (`--sidebar-width`); JS only clamps manual
// resizes. WIDE_QUERY must match the `@media (max-width: 880px)` boundary
// in styles.css.
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
const WIDE_QUERY = '(min-width: 881px)';

let hooks = {
  onOpenFile: () => {},
  onFileDeleted: () => {},
  onUndoableDelete: null,
  onDbBlocked: null,
};

let els = {};
let searchMode = false;

export async function initSidebar(callbacks = {}) {
  hooks = { ...hooks, ...callbacks };

  els = {
    shell:       document.getElementById('shell'),
    sidebar:     document.getElementById('sidebar'),
    tree:        document.getElementById('sidebar-tree'),
    search:      document.getElementById('sidebar-search'),
    storageLbl:  document.getElementById('sidebar-storage-label'),
    btnNewFile:  document.getElementById('btn-new-file'),
    btnNewProj:  document.getElementById('btn-new-project'),
    btnToggle:   document.getElementById('btn-sidebar'),
    resizer:     document.getElementById('sidebar-resizer'),
  };

  // Await saved sidebar width/collapsed state BEFORE the first render so the
  // UI doesn't flash with the default then jump to the stored width.
  await restoreSidebarState();
  bindControls();
  bindResize();
  bindDragReset();
  bindResponsiveScrim();
  bindDrawerSwipe();

  Store.on((kind) => {
    if (['tab:activated', 'tab:closed', 'tabs:reordered'].includes(kind)) {
      renderActiveHighlight();
      return;
    }
    if (kind === 'file:dirty' || kind === 'file:saved') {
      renderDirtyMarkers();
      return;
    }
    render();
  });

  render();
}

async function restoreSidebarState() {
  const [saved, collapsed] = await Promise.all([
    DB.sessionGet('sidebarWidth'),
    DB.sessionGet('sidebarCollapsed'),
  ]);
  if (saved && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
    els.shell.style.setProperty('--sidebar-width', `${saved}px`);
  }
  const wide = window.matchMedia(WIDE_QUERY).matches;
  if (collapsed && wide) {
    els.shell.dataset.sidebar = 'collapsed';
    els.btnToggle?.setAttribute('aria-pressed', 'false');
  } else {
    els.shell.dataset.sidebar = wide ? 'open' : 'closed';
    els.btnToggle?.setAttribute('aria-pressed', wide ? 'true' : 'false');
  }

  const useIdb = await DB.ready();
  if (els.storageLbl) els.storageLbl.textContent = useIdb ? 'Local' : 'Local (fallback)';

  onBlocked((err) => {
    // Blocked state wins over usage indicator — stop updating the label once
    // we can't talk to IDB, since any numbers would be misleading.
    _storageCtx.blocked = true;
    if (els.storageLbl) {
      els.storageLbl.textContent = 'Local (blocked)';
      const container = els.storageLbl.parentElement;
      if (container) {
        container.dataset.storageState = 'critical';
        container.setAttribute('title', err?.message || 'Storage upgrade blocked by another tab.');
      }
    }
    hooks.onDbBlocked?.(err);
  });

  initStorageIndicator({ useIdb });
}

// Storage indicator: compact footer label backed by navigator.storage.estimate(),
// throttled to avoid thrashing on bursty saves.

const STORAGE_WARN_RATIO = 0.8;
const STORAGE_CRIT_RATIO = 0.95;
const STORAGE_THROTTLE_MS = 1500;

let _storageCtx = { useIdb: true, persisted: false, persistAttempted: false };
let _storageTimer = 0;
let _storageLastRun = 0;
let _storagePending = false;

function initStorageIndicator({ useIdb }) {
  _storageCtx.useIdb = useIdb;

  // Ask browsers to make IndexedDB persistent so data isn't evicted under
  // storage pressure. Many browsers grant silently when the site is engaged
  // (bookmarked, frequently visited, PWA-installed); denial is fine and we
  // just reflect that in the tooltip.
  if (useIdb) tryRequestPersist();

  scheduleStorageUpdate({ immediate: true });

  Store.on((kind) => {
    // Recompute on events that change on-disk volume or counts. We ignore
    // high-frequency, pure-UI events (tab activation, dirty markers) to avoid
    // thrashing navigator.storage.estimate().
    const relevant =
      kind === 'file:saved' ||
      kind === 'file:created' ||
      kind === 'file:deleted' ||
      kind === 'file:renamed' ||
      kind === 'project:created' ||
      kind === 'project:deleted' ||
      kind === 'project:renamed' ||
      kind === 'load';
    if (relevant) scheduleStorageUpdate();
  });
}

async function tryRequestPersist() {
  if (_storageCtx.persistAttempted) return;
  _storageCtx.persistAttempted = true;
  try {
    if (navigator.storage?.persisted) {
      _storageCtx.persisted = await navigator.storage.persisted();
    }
    if (!_storageCtx.persisted && navigator.storage?.persist) {
      _storageCtx.persisted = await navigator.storage.persist();
    }
  } catch {
    // Ignore — some browsers throw in insecure contexts or private mode.
  }
}

function scheduleStorageUpdate({ immediate = false } = {}) {
  if (immediate) {
    _storageLastRun = 0;
    clearTimeout(_storageTimer);
    _storageTimer = 0;
    _storagePending = false;
    runStorageUpdate();
    return;
  }
  if (_storageTimer) { _storagePending = true; return; }
  const now = performance.now();
  const wait = Math.max(0, STORAGE_THROTTLE_MS - (now - _storageLastRun));
  _storageTimer = setTimeout(() => {
    _storageTimer = 0;
    runStorageUpdate();
    if (_storagePending) {
      _storagePending = false;
      scheduleStorageUpdate();
    }
  }, wait);
}

async function runStorageUpdate() {
  _storageLastRun = performance.now();
  if (!els.storageLbl) return;
  // Once the DB is blocked any estimate or count is stale/misleading, so the
  // onBlocked handler owns the label from that point on.
  if (_storageCtx.blocked) return;

  const projectCount = Store.projects.size;
  const fileCount = Store.files.size;

  let usage = null;
  let quota = null;
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usage = typeof est.usage === 'number' ? est.usage : null;
      quota = typeof est.quota === 'number' ? est.quota : null;
    }
  } catch {}

  // Fallback: derive an approximate byte count from in-memory content lengths
  // when the Storage API is unavailable (older Safari, insecure contexts).
  if (usage == null) usage = approximateLocalBytes();

  applyStorageView({ usage, quota, projectCount, fileCount });
}

function approximateLocalBytes() {
  let bytes = 0;
  for (const f of Store.files.values()) {
    bytes += (f.name?.length || 0) + (f.content?.length || 0);
  }
  // Rough UTF-8 overhead; good enough for a fallback label.
  return Math.round(bytes * 1.2);
}

function applyStorageView({ usage, quota, projectCount, fileCount }) {
  const container = els.storageLbl.parentElement;
  const usageStr = usage != null ? formatBytes(usage) : '\u2014';
  const countStr = `${projectCount} project${projectCount === 1 ? '' : 's'} \u00b7 ${fileCount} file${fileCount === 1 ? '' : 's'}`;

  els.storageLbl.textContent = usage != null ? `${usageStr} \u00b7 ${countStr}` : `Local \u00b7 ${countStr}`;

  const ratio = (usage != null && quota) ? usage / quota : 0;
  let state = 'ok';
  if (ratio >= STORAGE_CRIT_RATIO) state = 'critical';
  else if (ratio >= STORAGE_WARN_RATIO) state = 'warn';

  if (container) {
    container.dataset.storageState = state;
    container.setAttribute('title', buildStorageTooltip({
      usage, quota, ratio, projectCount, fileCount,
    }));
  }
}

function buildStorageTooltip({ usage, quota, ratio, projectCount, fileCount }) {
  const lines = [];
  lines.push('Local storage (this browser only)');
  if (usage != null) lines.push(`Used: ${formatBytes(usage)}`);
  if (quota) {
    lines.push(`Available: ${formatBytes(quota)}`);
    lines.push(`${(ratio * 100).toFixed(ratio < 0.01 ? 4 : 1)}% of quota`);
  }
  lines.push(`${projectCount} project${projectCount === 1 ? '' : 's'}, ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (!_storageCtx.useIdb) {
    lines.push('');
    lines.push('IndexedDB unavailable — using localStorage fallback (limited capacity).');
  } else {
    lines.push('');
    lines.push(_storageCtx.persisted
      ? 'Persistent: yes — browser will not auto-evict this data.'
      : 'Persistent: no — browser may evict data under storage pressure.');
  }
  if (ratio >= STORAGE_CRIT_RATIO) lines.push('\nStorage almost full — export and clear old projects.');
  else if (ratio >= STORAGE_WARN_RATIO) lines.push('\nStorage getting full.');
  return lines.join('\n');
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '\u2014';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Clean up scrim on media-query change so a stale drawer scrim doesn't
// linger when the window resizes narrow→wide.
function bindResponsiveScrim() {
  const mq = window.matchMedia(WIDE_QUERY);
  const onChange = () => {
    if (mq.matches) {
      // Wide: remove any leftover scrim and revert to saved collapsed state.
      document.getElementById('sidebar-scrim')?.remove();
      if (els.shell.dataset.sidebar === 'closed') {
        // On first resize to wide without stored preference, default to open.
        els.shell.dataset.sidebar = 'open';
      }
      els.btnToggle?.setAttribute('aria-pressed', String(els.shell.dataset.sidebar !== 'collapsed'));
    } else {
      // Narrow: force drawer closed (not collapsed).
      if (els.shell.dataset.sidebar === 'collapsed' || els.shell.dataset.sidebar === 'open') {
        els.shell.dataset.sidebar = 'closed';
        els.btnToggle?.setAttribute('aria-pressed', 'false');
      }
    }
  };
  // addEventListener is preferred; addListener is a legacy Safari fallback.
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

function bindControls() {
  els.btnNewFile?.addEventListener('click', async () => {
    const active = Store.activeProject() || Store.projectList()[0];
    if (!active) {
      const p = await createProject({ name: 'My documents' });
      await createAndOpenFile(p.id);
    } else {
      await createAndOpenFile(active.id);
    }
  });

  els.btnNewProj?.addEventListener('click', async () => {
    const p = await createProject({ name: `Project ${Store.projects.size + 1}` });
    // Auto-enter rename mode for the new project.
    requestAnimationFrame(() => startRenameProject(p.id));
  });

  els.btnToggle?.addEventListener('click', () => toggleSidebar());

  els.search?.addEventListener('input', () => {
    searchMode = !!els.search.value.trim();
    render();
  });
  els.search?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      els.search.value = '';
      searchMode = false;
      render();
      els.search.blur();
    }
    if (e.key === 'Enter' && searchMode) {
      const first = els.tree.querySelector('.search-result');
      first?.click();
    }
  });
}

export function toggleSidebar(force) {
  const wide = window.matchMedia(WIDE_QUERY).matches;
  const cur = els.shell.dataset.sidebar;
  let next;
  if (typeof force === 'boolean') {
    // force=true always opens; force=false collapses on wide / closes on narrow.
    next = force ? 'open' : (wide ? 'collapsed' : 'closed');
  } else {
    if (wide) next = cur === 'collapsed' ? 'open' : 'collapsed';
    else      next = cur === 'open'      ? 'closed' : 'open';
  }
  els.shell.dataset.sidebar = next;
  els.btnToggle?.setAttribute('aria-pressed', String(next !== 'collapsed' && next !== 'closed'));
  if (wide) DB.sessionSet('sidebarCollapsed', next === 'collapsed');
  ensureScrim();
}

function ensureScrim() {
  let scrim = document.getElementById('sidebar-scrim');
  const wide = window.matchMedia(WIDE_QUERY).matches;
  const drawerOpen = els.shell.dataset.sidebar === 'open' && !wide;
  if (wide) {
    scrim?.remove();
    document.body.classList.remove('is-drawer-open');
    return;
  }
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.id = 'sidebar-scrim';
    scrim.className = 'sidebar-scrim';
    scrim.addEventListener('click', () => toggleSidebar(false));
    // Prevent iOS from scrolling the body underneath the drawer.
    scrim.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    els.shell.appendChild(scrim);
  }
  // Body-scroll lock pairs with the `body.is-drawer-open` rule in CSS.
  document.body.classList.toggle('is-drawer-open', drawerOpen);
}

// Left-swipe on the drawer to close it. Claims the gesture only when
// horizontal motion dominates vertical, so the file list can still scroll
// normally. Closes on distance (≥35% of drawer width) or flick velocity.
function bindDrawerSwipe() {
  const INTENT_THRESHOLD = 10;
  const CLOSE_DISTANCE_RATIO = 0.35;
  const CLOSE_VELOCITY = -0.4;       // px/ms
  const ANIM_MS = 280;

  let startX = 0, startY = 0, startTime = 0;
  let width = 0;
  let state = 'idle';  // 'idle' | 'undecided' | 'swiping' | 'locked-vertical'

  const isDrawerOpen = () =>
    els.shell.dataset.sidebar === 'open' &&
    !window.matchMedia(WIDE_QUERY).matches;

  const scrimEl = () => document.getElementById('sidebar-scrim');

  const setDragging = (on) => {
    els.sidebar.classList.toggle('is-swiping', on);
    scrimEl()?.classList.toggle('is-swiping', on);
  };

  const clearInlineStyles = () => {
    els.sidebar.style.transform = '';
    const s = scrimEl();
    if (s) s.style.opacity = '';
  };

  els.sidebar.addEventListener('touchstart', (e) => {
    if (!isDrawerOpen()) return;
    // Skip text-entry controls so caret/selection gestures work normally.
    if (e.target?.closest('input, textarea, [contenteditable="true"]')) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startTime = performance.now();
    width = els.sidebar.offsetWidth;
    state = 'undecided';
  }, { passive: true });

  els.sidebar.addEventListener('touchmove', (e) => {
    if (state === 'idle' || state === 'locked-vertical') return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (state === 'undecided') {
      if (Math.abs(dx) < INTENT_THRESHOLD && Math.abs(dy) < INTENT_THRESHOLD) return;
      if (Math.abs(dy) > Math.abs(dx) || dx >= 0) {
        state = 'locked-vertical';
        return;
      }
      state = 'swiping';
      setDragging(true);
    }

    const offset = Math.max(-width, Math.min(0, dx));
    els.sidebar.style.transform = `translateX(${offset}px)`;
    const s = scrimEl();
    if (s) s.style.opacity = String(1 + offset / width);
    // preventDefault can fail with cancelable=false once the browser commits
    // to native scrolling; guard to avoid console intervention warnings.
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  const end = (e) => {
    if (state !== 'swiping') {
      state = 'idle';
      return;
    }
    const t = e.changedTouches?.[0] || null;
    const dx = t ? t.clientX - startX : 0;
    const elapsed = performance.now() - startTime || 1;
    const velocity = dx / elapsed;
    const shouldClose =
      dx < -width * CLOSE_DISTANCE_RATIO ||
      velocity < CLOSE_VELOCITY;

    setDragging(false);
    state = 'idle';

    // Animate the final segment via inline transform (CSS transition is back
    // on now that .is-swiping is gone), then commit state & clear inline.
    if (shouldClose) {
      els.sidebar.style.transform = `translateX(${-width}px)`;
      const s = scrimEl();
      if (s) s.style.opacity = '0';
      // Flip data-sidebar BEFORE clearing inline, so the CSS closed-state
      // transform matches what's on screen (no one-frame snap to 0).
      setTimeout(() => {
        toggleSidebar(false);
        clearInlineStyles();
      }, ANIM_MS);
    } else {
      els.sidebar.style.transform = 'translateX(0)';
      const s = scrimEl();
      if (s) s.style.opacity = '1';
      setTimeout(clearInlineStyles, ANIM_MS);
    }
  };

  els.sidebar.addEventListener('touchend', end, { passive: true });
  els.sidebar.addEventListener('touchcancel', end, { passive: true });
}

function bindResize() {
  let dragging = false, startX = 0, startWidth = 0;
  // Invoked from every drop path — including mouseleave / blur — so the
  // global cursor + userSelect never stick when the mouse is released
  // outside the browser viewport.
  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    els.resizer.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const w = els.sidebar.offsetWidth;
    DB.sessionSet('sidebarWidth', w);
  };
  const onDown = (e) => {
    dragging = true;
    els.resizer.classList.add('is-dragging');
    startX = e.clientX;
    startWidth = els.sidebar.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onMove = (e) => {
    if (!dragging) return;
    const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + (e.clientX - startX)));
    els.shell.style.setProperty('--sidebar-width', `${w}px`);
  };
  els.resizer?.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', stopDrag);
  document.addEventListener('mouseleave', stopDrag);
  window.addEventListener('blur', stopDrag);

  els.resizer?.addEventListener('keydown', (e) => {
    const cur = els.sidebar.offsetWidth;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); const w = Math.max(SIDEBAR_MIN, cur - 16); els.shell.style.setProperty('--sidebar-width', `${w}px`); DB.sessionSet('sidebarWidth', w); }
    if (e.key === 'ArrowRight') { e.preventDefault(); const w = Math.min(SIDEBAR_MAX, cur + 16); els.shell.style.setProperty('--sidebar-width', `${w}px`); DB.sessionSet('sidebarWidth', w); }
  });
}

function bindDragReset() {
  // Clear drag-over visual state if a drag is cancelled anywhere.
  document.addEventListener('dragend', () => {
    els.tree?.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
  });
}

// ---- Rendering ----------------------------------------------------------

function render() {
  if (!els.tree) return;
  if (searchMode) {
    renderSearchResults();
    return;
  }
  const projects = Store.projectList();
  if (projects.length === 0) {
    els.tree.innerHTML = `
      <div class="sidebar__empty">
        <p>No projects yet. Create one to start organizing your markdown.</p>
        <button class="btn btn--primary" data-empty-new-project>New project</button>
      </div>`;
    els.tree.querySelector('[data-empty-new-project]')?.addEventListener('click', async () => {
      const p = await createProject({ name: 'My documents' });
      requestAnimationFrame(() => startRenameProject(p.id));
    });
    return;
  }

  const frag = document.createDocumentFragment();
  projects.forEach(p => frag.appendChild(renderProject(p)));
  els.tree.replaceChildren(frag);
  renderActiveHighlight();
}

function renderProject(project) {
  const node = document.createElement('div');
  node.className = 'project';
  if (project.collapsed) node.classList.add('is-collapsed');
  node.dataset.projectId = project.id;
  node.style.setProperty('--project-color', projectColor(project.color));
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-expanded', String(!project.collapsed));

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'project__header';
  header.setAttribute('aria-expanded', String(!project.collapsed));
  header.innerHTML = `
    <svg class="project__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    <span class="project__dot" aria-hidden="true"></span>
    <span class="project__name" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</span>
    <span class="project__count" aria-label="${Store.filesIn(project.id).length} files">${Store.filesIn(project.id).length}</span>
    <span class="project__actions">
      <button class="project__action" data-project-act="new-file" aria-label="New file in ${escapeHtml(project.name)}" title="New file">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
      </button>
      <button class="project__action" data-project-act="rename" aria-label="Rename ${escapeHtml(project.name)}" title="Rename">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button class="project__action" data-project-act="delete" aria-label="Delete ${escapeHtml(project.name)}" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
      </button>
    </span>
  `;
  header.addEventListener('click', (e) => {
    if (e.target.closest('[data-project-act]')) return;
    toggleProject(project.id);
  });
  header.addEventListener('dblclick', () => startRenameProject(project.id));

  header.querySelector('[data-project-act="new-file"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    createAndOpenFile(project.id);
  });
  header.querySelector('[data-project-act="rename"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startRenameProject(project.id);
  });
  header.querySelector('[data-project-act="delete"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const files = Store.filesIn(project.id).length;
    const snap = await deleteProject(project.id);
    if (!snap) return;
    const label = files > 0
      ? `Deleted "${project.name}" and ${files} file${files === 1 ? '' : 's'}`
      : `Deleted "${project.name}"`;
    hooks.onUndoableDelete?.({ snapshot: snap, message: label });
  });

  header.setAttribute('draggable', 'true');
  header.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/mdlab-project', project.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  let projectEnterCount = 0;
  node.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('text/mdlab-file') && !e.dataTransfer.types.includes('text/mdlab-project')) return;
    projectEnterCount++;
    node.classList.add('is-drag-over');
  });
  node.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/mdlab-file') || e.dataTransfer.types.includes('text/mdlab-project')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });
  node.addEventListener('dragleave', () => {
    projectEnterCount = Math.max(0, projectEnterCount - 1);
    if (projectEnterCount === 0) node.classList.remove('is-drag-over');
  });
  node.addEventListener('drop', async (e) => {
    projectEnterCount = 0;
    node.classList.remove('is-drag-over');
    const fileId    = e.dataTransfer.getData('text/mdlab-file');
    const projectId = e.dataTransfer.getData('text/mdlab-project');
    if (fileId) {
      e.preventDefault();
      await moveFile(fileId, project.id, Store.filesIn(project.id).length);
    } else if (projectId && projectId !== project.id) {
      e.preventDefault();
      const list = Store.projectList().map(p => p.id);
      const from = list.indexOf(projectId);
      const to   = list.indexOf(project.id);
      if (from !== -1 && to !== -1) {
        list.splice(from, 1);
        list.splice(to, 0, projectId);
        await reorderProjects(list);
      }
    }
  });

  node.appendChild(header);

  const files = Store.filesIn(project.id);
  const fileList = document.createElement('div');
  fileList.className = 'project__files';
  fileList.setAttribute('role', 'group');

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'file file--empty';
    empty.textContent = 'No files — click + to add';
    fileList.appendChild(empty);
  }

  files.forEach(f => fileList.appendChild(renderFile(f, project)));
  node.appendChild(fileList);

  return node;
}

function renderFile(file, project) {
  const row = document.createElement('div');
  row.className = 'file';
  if (Store.activeId === file.id) row.classList.add('is-active');
  row.dataset.fileId = file.id;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('tabindex', '0');
  row.setAttribute('draggable', 'true');

  row.innerHTML = `
    <svg class="file__icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
    <span class="file__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
    ${Store.dirty.has(file.id) ? '<span class="file__dirty" aria-label="Unsaved changes"></span>' : ''}
    <span class="file__actions">
      <button class="file__action" data-file-act="rename" aria-label="Rename ${escapeHtml(file.name)}" title="Rename">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button class="file__action" data-file-act="duplicate" aria-label="Duplicate ${escapeHtml(file.name)}" title="Duplicate">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="file__action" data-file-act="delete" aria-label="Delete ${escapeHtml(file.name)}" title="Delete">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
      </button>
    </span>
  `;

  row.addEventListener('click', (e) => {
    if (e.target.closest('[data-file-act]')) return;
    hooks.onOpenFile(file.id, { activate: true });
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-file-act]')) return;
    startRenameFile(file.id);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      hooks.onOpenFile(file.id, { activate: true });
    }
    if (e.key === 'F2') {
      e.preventDefault();
      startRenameFile(file.id);
    }
    if (e.key === 'Delete' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      confirmAndDelete(file);
    }
  });

  row.querySelector('[data-file-act="rename"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startRenameFile(file.id);
  });
  row.querySelector('[data-file-act="duplicate"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await duplicateFile(file.id);
  });
  row.querySelector('[data-file-act="delete"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmAndDelete(file);
  });

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/mdlab-file', file.id);
    e.dataTransfer.setData('text/mdlab-file-from', file.projectId);
    e.dataTransfer.effectAllowed = 'move';
  });
  let fileEnterCount = 0;
  row.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('text/mdlab-file')) return;
    fileEnterCount++;
    row.classList.add('is-drag-over');
  });
  row.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/mdlab-file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });
  row.addEventListener('dragleave', () => {
    fileEnterCount = Math.max(0, fileEnterCount - 1);
    if (fileEnterCount === 0) row.classList.remove('is-drag-over');
  });
  row.addEventListener('drop', async (e) => {
    fileEnterCount = 0;
    row.classList.remove('is-drag-over');
    const draggedId = e.dataTransfer.getData('text/mdlab-file');
    if (!draggedId || draggedId === file.id) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    const siblings = Store.filesIn(project.id).filter(f => f.id !== draggedId);
    const idx = siblings.findIndex(f => f.id === file.id);
    const insertAt = below ? idx + 1 : idx;
    const draggedFromProject = Store.files.get(draggedId)?.projectId;
    if (draggedFromProject === project.id) {
      const newOrder = siblings.map(f => f.id);
      newOrder.splice(insertAt, 0, draggedId);
      await reorderFiles(project.id, newOrder);
    } else {
      await moveFile(draggedId, project.id, insertAt);
    }
  });

  return row;
}

function renderSearchResults() {
  const q = els.search.value.trim();
  const results = searchFiles(q);
  els.tree.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'search-results';
  if (results.length === 0) {
    wrap.innerHTML = `<div class="search-results__empty">No files match “${escapeHtml(q)}”</div>`;
  } else {
    results.forEach(({ file, project }) => {
      const btn = document.createElement('button');
      btn.className = 'search-result';
      btn.type = 'button';
      const path = project ? `${project.name} /` : '';
      btn.innerHTML = `
        <span class="search-result__name">${highlightMatch(file.name, q)}</span>
        <span class="search-result__path">${escapeHtml(path)} ${highlightMatch(snippetFor(file.content, q), q)}</span>
      `;
      btn.addEventListener('click', () => {
        hooks.onOpenFile(file.id, { activate: true });
      });
      wrap.appendChild(btn);
    });
  }
  els.tree.appendChild(wrap);
}

function snippetFor(content, q) {
  if (!q) return '';
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return content.slice(0, 60).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - 18);
  const end   = Math.min(content.length, idx + q.length + 40);
  return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  // Fuzzy-style: mark every character of q that appears in sequence.
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const marks = new Array(text.length).fill(false);
  let ni = 0;
  for (let i = 0; i < text.length && ni < needle.length; i++) {
    if (lower[i] === needle[ni]) { marks[i] = true; ni++; }
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += marks[i] ? `<mark>${escapeHtml(text[i])}</mark>` : escapeHtml(text[i]);
  }
  return out;
}

function renderActiveHighlight() {
  if (!els.tree) return;
  els.tree.querySelectorAll('.file.is-active').forEach(el => el.classList.remove('is-active'));
  if (Store.activeId) {
    const row = els.tree.querySelector(`.file[data-file-id="${cssEscape(Store.activeId)}"]`);
    row?.classList.add('is-active');
  }
}

function renderDirtyMarkers() {
  if (!els.tree) return;
  // Just re-render the affected rows to add/remove the dirty dot.
  els.tree.querySelectorAll('.file[data-file-id]').forEach(row => {
    const id = row.dataset.fileId;
    const has = !!row.querySelector('.file__dirty');
    const should = Store.dirty.has(id);
    if (has === should) return;
    if (should) {
      const dot = document.createElement('span');
      dot.className = 'file__dirty';
      dot.setAttribute('aria-label', 'Unsaved changes');
      row.insertBefore(dot, row.querySelector('.file__actions'));
    } else {
      row.querySelector('.file__dirty')?.remove();
    }
  });
}

// ---- Actions -----------------------------------------------------------

async function toggleProject(id) {
  const p = Store.projects.get(id);
  if (!p) return;
  await setProjectCollapsed(id, !p.collapsed);
}

async function createAndOpenFile(projectId) {
  const name = uniqueFileName(projectId, 'Untitled.md');
  const file = await createFile({ projectId, name, content: '' });
  hooks.onOpenFile(file.id, { activate: true });
  requestAnimationFrame(() => startRenameFile(file.id));
}

function confirmAndDelete(file) {
  deleteFile(file.id).then((snap) => {
    if (!snap) return;
    hooks.onFileDeleted(file.id);
    hooks.onUndoableDelete?.({ snapshot: snap, message: `Deleted "${file.name}"` });
  });
}

function startRenameFile(id) {
  const row = els.tree?.querySelector(`.file[data-file-id="${cssEscape(id)}"]`);
  const nameEl = row?.querySelector('.file__name');
  if (!row || !nameEl) return;
  const file = Store.files.get(id);
  if (!file) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file__name-input';
  input.value = file.name;
  nameEl.replaceWith(input);
  input.focus();
  // Preselect just the stem so renames don't require the user to retype
  // the extension. Handles .md / .markdown / .txt consistently with
  // `ensureMdExt` in projects.js.
  const stemEnd = file.name.replace(/\.(md|markdown|txt)$/i, '').length;
  try { input.setSelectionRange(0, stemEnd); } catch {}

  const commit = async () => {
    const v = input.value.trim();
    input.onblur = null; input.onkeydown = null;
    if (v && v !== file.name) await renameFile(id, v);
    else render();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); render(); }
  };
}

function startRenameProject(id) {
  const node = els.tree?.querySelector(`.project[data-project-id="${cssEscape(id)}"]`);
  const nameEl = node?.querySelector('.project__name');
  if (!node || !nameEl) return;
  const project = Store.projects.get(id);
  if (!project) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file__name-input';
  input.value = project.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const v = input.value.trim();
    input.onblur = null; input.onkeydown = null;
    if (v && v !== project.name) await renameProject(id, v);
    else render();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); render(); }
  };
}
