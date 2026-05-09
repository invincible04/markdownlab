/**
 * Modal / overlay helpers — Shortcuts dialog, About dialog, and shared
 * focus-trap utilities (also used by the lightbox in app.js).
 *
 * Visibility contract for both dialogs:
 *   - `.is-open` drives display + animations.
 *   - `hidden` is authoritative for closed state on the About modal
 *     (whose markup lives in index.html for crawler/AI-bot consumption).
 *     The Shortcuts overlay is built lazily so it has no `hidden` phase.
 *   - aria-hidden is never toggled on role="dialog" — WAI-ARIA APG
 *     anti-pattern that can trigger "hidden dialog" SR announcements.
 */

// ─── Focus trap ──────────────────────────────────────────────────────

/**
 * Constrain keyboard focus to descendants of `root` until
 * `releaseFocusTrap(root)` is called. Handles Shift+Tab wrap in both
 * directions. Idempotent — double-calls are no-ops.
 * @param {HTMLElement} root
 */
export function installFocusTrap(root) {
  if (!root || root._focusTrap) return;
  // offsetParent is null for position:fixed regardless of visibility;
  // use bounding-box + computed style instead.
  const isVisible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusables = Array.from(root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(isVisible);
    if (focusables.length === 0) { e.preventDefault(); return; }
    const first = focusables[0], last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener('keydown', handler);
  root._focusTrap = handler;
}

/** @param {HTMLElement} root */
export function releaseFocusTrap(root) {
  if (!root || !root._focusTrap) return;
  root.removeEventListener('keydown', root._focusTrap);
  root._focusTrap = null;
}

// ─── Shortcuts ───────────────────────────────────────────────────────

const SHORTCUTS = [
  { group: 'View', items: [
    ['⌘ / Ctrl + 1', 'Editor only'],
    ['⌘ / Ctrl + 2', 'Split view'],
    ['⌘ / Ctrl + 3', 'Preview only'],
    ['⌘ / Ctrl + .', 'Toggle focus mode'],
    ['⌘ / Ctrl + ⇧ + B', 'Toggle sidebar'],
    ['Esc',          'Exit focus / close dialog'],
  ]},
  { group: 'Files & tabs', items: [
    ['⌘ / Ctrl + P', 'Quick open / palette'],
    ['⌘ / Ctrl + N', 'New file'],
    ['⌘ / Ctrl + W', 'Close tab'],
    ['⌘ / Ctrl + Tab', 'Next tab'],
    ['⌘ / Ctrl + ⇧ + Tab', 'Previous tab'],
    ['⌘ / Ctrl + O', 'Open .md file'],
    ['F2',           'Rename file (in sidebar)'],
    ['/',            'Focus sidebar search'],
  ]},
  { group: 'Editor', items: [
    ['⌘ / Ctrl + B', 'Bold selection (**…**)'],
    ['⌘ / Ctrl + I', 'Italic selection (_…_)'],
    ['⌘ / Ctrl + K', 'Insert / edit link'],
    ['⌘ / Ctrl + F', 'Find in file'],
    ['⌘ / Ctrl + ⇧ + F', 'Find and replace'],
    ['⌘ / Ctrl + H', 'Find and replace'],
    ['Tab',          'Indent list item (or insert 2 spaces)'],
    ['⇧ + Tab',      'Outdent list item'],
    ['Enter',        'Continue list — blank line to exit'],
  ]},
  { group: 'Document', items: [
    ['⌘ / Ctrl + ⇧ + K', 'Toggle theme'],
    ['⌘ / Ctrl + L', 'Toggle outline'],
    ['⌘ / Ctrl + S', 'Download markdown'],
    ['⌘ / Ctrl + /', 'Show shortcuts'],
  ]},
  { group: 'Diagram viewer', items: [
    ['+ / −',        'Zoom in / out'],
    ['0',            'Fit to screen'],
    ['Arrows',       'Pan'],
    ['Scroll',       'Zoom at cursor'],
    ['Double-click', 'Reset zoom'],
    ['Drag',         'Pan'],
  ]},
];

// Split on " + " only between two non-plus chars so tokens like "+ / −"
// aren't misread as the separator.
function renderShortcutKeys(s) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ' && s[i + 1] === '+' && s[i + 2] === ' ' &&
        buf.length > 0 && buf[buf.length - 1] !== '+' && buf[buf.length - 1] !== '−' &&
        i + 3 < s.length && s[i + 3] !== '+' && s[i + 3] !== '−') {
      parts.push(buf);
      buf = '';
      i += 2;
      continue;
    }
    buf += s[i];
  }
  if (buf) parts.push(buf);
  return parts.map(p => p === '⌘ / Ctrl' ? '<kbd>⌘</kbd>/<kbd>Ctrl</kbd>' : `<kbd>${p}</kbd>`).join(' + ');
}

function buildShortcutsOverlay() {
  if (document.getElementById('shortcuts-overlay')) return;
  const root = document.createElement('div');
  root.className = 'shortcuts';
  root.id = 'shortcuts-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Keyboard shortcuts');

  const body = SHORTCUTS.map(g => `
    <section class="shortcuts__group">
      <h3>${g.group}</h3>
      <dl>${g.items.map(([k, v]) =>
        `<div><dt>${renderShortcutKeys(k)}</dt><dd>${v}</dd></div>`
      ).join('')}</dl>
    </section>
  `).join('');

  root.innerHTML = `
    <div class="shortcuts__card" role="document">
      <header class="shortcuts__header">
        <h2>Keyboard shortcuts</h2>
        <button class="shortcuts__close" aria-label="Close" title="Close (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div class="shortcuts__body">${body}</div>
    </div>
  `;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => { if (e.target === root) hideShortcuts(); });
  root.querySelector('.shortcuts__close').addEventListener('click', hideShortcuts);
}

export function showShortcuts() {
  buildShortcutsOverlay();
  const root = document.getElementById('shortcuts-overlay');
  root.classList.add('is-open');
  root._returnFocusTo = document.activeElement;
  installFocusTrap(root);
  setTimeout(() => root.querySelector('.shortcuts__close')?.focus(), 10);
}

export function hideShortcuts() {
  const root = document.getElementById('shortcuts-overlay');
  if (!root) return;
  root.classList.remove('is-open');
  releaseFocusTrap(root);
  const prev = root._returnFocusTo;
  root._returnFocusTo = null;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
}

export function toggleShortcuts() {
  const root = document.getElementById('shortcuts-overlay');
  if (root?.classList.contains('is-open')) hideShortcuts();
  else showShortcuts();
}

// ─── About modal ─────────────────────────────────────────────────────

export function showAbout() {
  const root = document.getElementById('about-modal');
  if (!root) return;
  root.hidden = false;
  root.classList.add('is-open');
  root._returnFocusTo = document.activeElement;
  installFocusTrap(root);
  // Wire once, lazily — users who never open it pay nothing.
  if (!root._initialized) {
    root.addEventListener('click', (e) => { if (e.target === root) hideAbout(); });
    root.querySelector('#btn-about-close')?.addEventListener('click', hideAbout);
    initAboutFaqTabs(root);
    root._initialized = true;
  }
  setTimeout(() => root.querySelector('#btn-about-close')?.focus(), 10);
}

export function hideAbout() {
  const root = document.getElementById('about-modal');
  if (!root) return;
  root.classList.remove('is-open');
  // Defer `hidden` so the fade-out animation plays; re-check inside in
  // case the dialog was reopened within the 200ms window.
  setTimeout(() => { if (!root.classList.contains('is-open')) root.hidden = true; }, 200);
  releaseFocusTrap(root);
  const prev = root._returnFocusTo;
  root._returnFocusTo = null;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
}

export function toggleAbout() {
  const root = document.getElementById('about-modal');
  if (root?.classList.contains('is-open')) hideAbout();
  else showAbout();
}

// WAI-ARIA "Tabs with Automatic Activation": click or arrow-key selects
// and activates the panel. Only the active tab is tabbable; Tab exits
// the tablist. Panels stay in the DOM (only `hidden` flips) so crawlers
// see every FAQ regardless of active tab.
function initAboutFaqTabs(root) {
  const tabs = Array.from(root.querySelectorAll('.about-modal__faq-tab'));
  if (!tabs.length) return;

  const activate = (tab, focus) => {
    tabs.forEach(t => {
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      const isActive = t === tab;
      t.setAttribute('aria-selected', String(isActive));
      t.tabIndex = isActive ? 0 : -1;
      t.classList.toggle('is-active', isActive);
      if (panel) panel.hidden = !isActive;
    });
    if (focus) tab.focus();
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab, false));
    tab.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          activate(tabs[(i + 1) % tabs.length], true);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          activate(tabs[(i - 1 + tabs.length) % tabs.length], true);
          break;
        case 'Home':
          e.preventDefault();
          activate(tabs[0], true);
          break;
        case 'End':
          e.preventDefault();
          activate(tabs[tabs.length - 1], true);
          break;
      }
    });
  });
}
