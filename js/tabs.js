/* MarkdownLab — file tab strip above the editor.
 *
 * Renders one `.tab` per open file. A tab shows the filename, a dirty dot
 * while pending writes exist, and a close button. The active tab is
 * underlined with an accent bar. Tabs are:
 *   · click to activate
 *   · middle-click or `×` to close (with confirmation if dirty)
 *   · drag-and-drop to reorder (HTML5 DnD API)
 *   · keyboard-navigable (Ctrl+Tab and Ctrl+Shift+Tab cycle)
 *   · horizontally scrollable when they overflow
 *
 * The tabs scroll container auto-scrolls the active tab into view.
 */

import { Store, activateFile, closeFile, reorderTabs, createFile, uniqueFileName } from './projects.js';
import { escapeHtml, cssEscape } from './utils.js';

let els = {};
let hooks = {
  onActivate: () => {},
  onClose: () => {},
  onCreate: () => {},
};

export function initTabs(callbacks = {}) {
  hooks = { ...hooks, ...callbacks };
  els = {
    scroll: document.getElementById('tabs-scroll'),
    add:    document.getElementById('btn-tabs-add'),
  };

  els.add?.addEventListener('click', async () => {
    const active = Store.activeProject() || Store.projectList()[0];
    if (!active) return;
    const name = uniqueFileName(active.id, 'Untitled.md');
    const f = await createFile({ projectId: active.id, name, content: '' });
    hooks.onActivate(f.id);
    hooks.onCreate(f.id);
  });

  els.scroll?.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      els.scroll.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('dragend', () => {
    els.scroll?.querySelectorAll('.tab').forEach(el => {
      el.classList.remove('is-drag-over', 'is-drop-before', 'is-drop-after');
    });
  });

  Store.on((kind, payload) => {
    if (kind === 'file:renamed') {
      const t = els.scroll?.querySelector(`.tab[data-file-id="${cssEscape(payload.file.id)}"] .tab__name`);
      if (t) t.textContent = payload.file.name;
      return;
    }
    if (kind === 'file:dirty' || kind === 'file:saved') {
      renderDirtyState();
      return;
    }
    render();
  });

  render();
}

function render() {
  if (!els.scroll) return;
  const open = Store.openFiles();
  if (open.length === 0) {
    els.scroll.innerHTML = `<div class="tabs__empty">No files open · pick one from the sidebar</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  open.forEach(f => frag.appendChild(renderTab(f)));
  els.scroll.replaceChildren(frag);
  scrollActiveIntoView();
}

function renderTab(file) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tab';
  if (Store.activeId === file.id) el.classList.add('is-active');
  el.dataset.fileId = file.id;
  el.setAttribute('role', 'tab');
  el.setAttribute('aria-selected', String(Store.activeId === file.id));
  el.setAttribute('draggable', 'true');

  el.innerHTML = `
    <svg class="tab__icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
    <span class="tab__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
    ${Store.dirty.has(file.id) ? '<span class="tab__dirty" aria-label="Unsaved changes"></span>' : ''}
    <button type="button" class="tab__close" aria-label="Close ${escapeHtml(file.name)}" title="Close (middle-click / Ctrl/Cmd + W)">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  el.addEventListener('click', (e) => {
    if (e.target.closest('.tab__close')) {
      e.preventDefault();
      handleClose(file.id);
      return;
    }
    hooks.onActivate(file.id);
  });

  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); handleClose(file.id); }
  });

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/mdlab-tab', file.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  let tabEnterCount = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('text/mdlab-tab')) return;
    tabEnterCount++;
    el.classList.add('is-drag-over');
  });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/mdlab-tab')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const afterMid = e.clientX > rect.left + rect.width / 2;
    el.classList.toggle('is-drop-after', afterMid);
    el.classList.toggle('is-drop-before', !afterMid);
  });
  el.addEventListener('dragleave', () => {
    tabEnterCount = Math.max(0, tabEnterCount - 1);
    if (tabEnterCount === 0) {
      el.classList.remove('is-drag-over', 'is-drop-before', 'is-drop-after');
    }
  });
  el.addEventListener('drop', async (e) => {
    tabEnterCount = 0;
    const rect = el.getBoundingClientRect();
    const afterMid = e.clientX > rect.left + rect.width / 2;
    el.classList.remove('is-drag-over', 'is-drop-before', 'is-drop-after');
    const dragged = e.dataTransfer.getData('text/mdlab-tab');
    if (!dragged || dragged === file.id) return;
    e.preventDefault();
    const order = Store.openIds.filter(id => id !== dragged);
    const idx = order.indexOf(file.id);
    const insertAt = afterMid ? idx + 1 : idx;
    order.splice(insertAt, 0, dragged);
    await reorderTabs(order);
  });

  return el;
}

function handleClose(id) {
  if (Store.dirty.has(id)) {
    const file = Store.files.get(id);
    if (!confirm(`"${file?.name || 'This file'}" has unsaved changes. Close anyway?`)) return;
  }
  closeFile(id).then(() => hooks.onClose(id));
}

function renderDirtyState() {
  if (!els.scroll) return;
  els.scroll.querySelectorAll('.tab').forEach(row => {
    const id = row.dataset.fileId;
    const has = !!row.querySelector('.tab__dirty');
    const should = Store.dirty.has(id);
    if (has === should) return;
    if (should) {
      const dot = document.createElement('span');
      dot.className = 'tab__dirty';
      dot.setAttribute('aria-label', 'Unsaved changes');
      row.insertBefore(dot, row.querySelector('.tab__close'));
    } else {
      row.querySelector('.tab__dirty')?.remove();
    }
  });
}

function scrollActiveIntoView() {
  const active = els.scroll?.querySelector('.tab.is-active');
  if (!active) return;
  const cR = els.scroll.getBoundingClientRect();
  const aR = active.getBoundingClientRect();
  if (aR.left < cR.left) els.scroll.scrollBy({ left: aR.left - cR.left - 12, behavior: 'smooth' });
  else if (aR.right > cR.right) els.scroll.scrollBy({ left: aR.right - cR.right + 12, behavior: 'smooth' });
}

export function cycleTab(dir) {
  const ids = Store.openIds;
  if (ids.length < 2) return;
  const idx = ids.indexOf(Store.activeId);
  const next = ids[(idx + dir + ids.length) % ids.length];
  activateFile(next);
}
