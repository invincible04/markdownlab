import { Store, searchFiles, fuzzyScore, createFile, uniqueFileName } from './projects.js';
import { escapeHtml } from './utils.js';

function safeIconHtml(raw) {
  if (!raw) return '';
  if (typeof window === 'undefined' || !window.DOMPurify) return '';
  return window.DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true, svgFilters: true } });
}

function highlightSubsequence(text, query) {
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const marks = new Array(text.length).fill(false);
  let ni = 0;
  for (let i = 0; i < text.length && ni < needle.length; i++) {
    if (lower[i] === needle[ni]) { marks[i] = true; ni++; }
  }
  if (ni < needle.length) return escapeHtml(text);
  let out = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !inMark) { out += '<mark>'; inMark = true; }
    else if (!marks[i] && inMark) { out += '</mark>'; inMark = false; }
    out += escapeHtml(text[i]);
  }
  if (inMark) out += '</mark>';
  return out;
}

function snippetFor(content, q, radius = 40) {
  if (!q || !content) return '';
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return content.slice(0, 80).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - 18);
  const end   = Math.min(content.length, idx + q.length + radius);
  return (start > 0 ? '\u2026' : '') + content.slice(start, end).replace(/\s+/g, ' ').trim();
}

let els = {};
let hooks = {
  onOpenFile: () => {},
  runCommand: () => {},
  commands:   () => [],
};
let currentResults = [];
let currentIndex = 0;
let _focusBeforeOpen = null;

export function initPalette(callbacks = {}) {
  hooks = { ...hooks, ...callbacks };
  els = {
    root:  document.getElementById('palette'),
    input: document.getElementById('palette-input'),
    list:  document.getElementById('palette-list'),
  };

  els.root?.addEventListener('click', (e) => {
    if (e.target === els.root) closePalette();
  });
  els.input?.addEventListener('input', update);
  els.input?.addEventListener('keydown', onKeydown);

  els.list?.addEventListener('click', (e) => {
    const item = e.target.closest('.palette-item');
    if (!item) return;
    const idx = Number(item.dataset.idx);
    runSelected(idx);
  });

  Store.on(() => { if (isOpen()) update(); });

  els.root?.addEventListener('keydown', (e) => {
    if (!isOpen() || e.key !== 'Tab') return;
    e.preventDefault();
    els.input?.focus();
  });
}

export function openPalette(initial = '') {
  if (!els.root) return;
  _focusBeforeOpen = document.activeElement;
  els.root.classList.add('is-open');
  els.root.setAttribute('aria-hidden', 'false');
  els.input.value = initial;
  update();
  setTimeout(() => els.input.focus(), 10);
}

export function closePalette() {
  if (!els.root) return;
  els.root.classList.remove('is-open');
  els.root.setAttribute('aria-hidden', 'true');
  els.input?.removeAttribute('aria-activedescendant');
  const prev = _focusBeforeOpen;
  _focusBeforeOpen = null;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
}

function isOpen() { return els.root?.classList.contains('is-open'); }

function update() {
  const q = els.input.value.trim();
  currentIndex = 0;

  const fileResults = q ? searchFiles(q).slice(0, 20) : recentFiles();
  const commandResults = rankCommands(q);

  currentResults = [
    ...fileResults.map(r => ({ kind: 'file', file: r.file, project: r.project, score: r.score })),
    ...commandResults,
  ];

  render();
}

function recentFiles() {
  const all = Array.from(Store.files.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 8);
  return all.map(f => ({ file: f, project: Store.projects.get(f.projectId), score: 1 }));
}

function rankCommands(q) {
  const cmds = hooks.commands() || [];
  if (!q) return cmds.slice(0, 8).map(c => ({ kind: 'command', command: c, score: 1 }));
  const scored = cmds
    .map(c => {
      const label = c.title + ' ' + (c.subtitle || '');
      return { command: c, score: fuzzyScore(q, label) };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return scored.map(x => ({ kind: 'command', command: x.command, score: x.score }));
}

function render() {
  if (!els.list) return;

  if (currentResults.length === 0) {
    const q = els.input.value.trim();
    els.list.innerHTML = q
      ? `<li class="palette__empty">
           <div>No matches for &ldquo;${escapeHtml(q)}&rdquo;</div>
           <small>Press <kbd>\u2318</kbd><kbd>Enter</kbd> to create a new file with this name</small>
         </li>`
      : `<li class="palette__empty">
           <div>Type to find files or run commands</div>
           <small>Fuzzy search matches file names, paths, and content</small>
         </li>`;
    els.input?.removeAttribute('aria-activedescendant');
    return;
  }

  const frag = document.createDocumentFragment();
  currentResults.forEach((r, i) => frag.appendChild(renderItem(r, i)));
  els.list.replaceChildren(frag);
  highlight();
}

function renderItem(r, i) {
  const li = document.createElement('li');
  li.className = 'palette-item';
  li.dataset.idx = String(i);
  li.id = `palette-item-${i}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');

  const q = els.input.value.trim();

  if (r.kind === 'file') {
    const projName = r.project?.name || '\u2014';
    const snippet = q ? snippetFor(r.file.content || '', q) : '';
    li.innerHTML = `
      <span class="palette-item__icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </span>
      <span class="palette-item__text">
        <span class="palette-item__title">${highlightSubsequence(r.file.name, q)}</span>
        <span class="palette-item__subtitle">${escapeHtml(projName)}${snippet ? ` \u00b7 ${highlightSubsequence(snippet, q)}` : ''}</span>
      </span>
      <span class="palette-item__kind">file</span>
    `;
    return li;
  }

  const c = r.command;
  const fallbackIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
  li.innerHTML = `
    <span class="palette-item__icon">${safeIconHtml(c.icon || fallbackIcon)}</span>
    <span class="palette-item__text">
      <span class="palette-item__title">${highlightSubsequence(c.title, q)}</span>
      ${c.subtitle ? `<span class="palette-item__subtitle">${escapeHtml(c.subtitle)}</span>` : ''}
    </span>
    ${c.shortcut ? `<span class="palette-item__kbd">${escapeHtml(c.shortcut)}</span>` : '<span class="palette-item__kind">action</span>'}
  `;
  return li;
}

function highlight() {
  if (!els.list) return;
  let active = null;
  els.list.querySelectorAll('.palette-item').forEach((el, i) => {
    const on = i === currentIndex;
    el.classList.toggle('is-selected', on);
    el.setAttribute('aria-selected', String(on));
    if (on) active = el;
  });
  if (active) {
    els.input?.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    els.input?.removeAttribute('aria-activedescendant');
  }
}

function onKeydown(e) {
  if (!isOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    currentIndex = Math.min(currentResults.length - 1, currentIndex + 1);
    highlight();
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    currentIndex = Math.max(0, currentIndex - 1);
    highlight();
  }
  if (e.key === 'Home') { e.preventDefault(); currentIndex = 0; highlight(); }
  if (e.key === 'End') { e.preventDefault(); currentIndex = Math.max(0, currentResults.length - 1); highlight(); }
  if (e.key === 'Enter') {
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && els.input.value.trim()) {
      createQuickFile(els.input.value.trim());
      return;
    }
    if (currentResults.length > 0) runSelected(currentIndex);
    else if (els.input.value.trim()) createQuickFile(els.input.value.trim());
  }
}

async function createQuickFile(name) {
  const active = Store.activeProject() || Store.projectList()[0];
  if (!active) return;
  const finalName = uniqueFileName(active.id, name);
  const f = await createFile({ projectId: active.id, name: finalName, content: '' });
  hooks.onOpenFile(f.id);
  closePalette();
}

function runSelected(idx) {
  const r = currentResults[idx];
  if (!r) return;
  if (r.kind === 'file') {
    hooks.onOpenFile(r.file.id);
  } else {
    hooks.runCommand(r.command);
  }
  closePalette();
}
