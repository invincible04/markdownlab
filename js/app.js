/**
 * MarkdownLab — render pipeline:
 *   editor → extractMath → marked → reinjectMath → DOMPurify → Mermaid → postProcess
 *
 * State model: projects → files → tabs. All persistence lives in
 * IndexedDB (via ./db.js); the render / scroll / TOC / Mermaid / KaTeX
 * pipeline below reads `editor.value` and paints into `preview`,
 * independent of which file is active.
 */

import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
// Mermaid v11 built-in diagrams used by the app (architecture-beta, packet-beta,
// block, sankey, xychart, kanban, radar, treemap, mindmap, gantt, gitGraph,
// etc.) self-register on import. No external diagram plugins are loaded:
// zenuml was removed because its foreignObject output (Vue + runtime Tailwind
// JIT) cannot be serialized into offline HTML exports reliably.
import { EXAMPLES } from './examples.js';
import {
  Store, loadAll,
  createProject, createFile, saveFileContent, markDirty,
  activateFile, closeFile as storeCloseFile,
  renameFile, duplicateFile, deleteFile, restoreFile, restoreProject,
  uniqueFileName,
} from './projects.js';
import { initSidebar, toggleSidebar } from './sidebar.js';
import { initTabs, cycleTab } from './tabs.js';
import { initPalette, openPalette, closePalette } from './palette.js';
import { escapeHtml, cssEscape } from './utils.js';
import { extractFrontmatter } from './frontmatter.js';
import { extractMath, reinjectMath } from './math.js';
import {
  installFocusTrap, releaseFocusTrap,
  showShortcuts, hideShortcuts, toggleShortcuts,
  showAbout, hideAbout, toggleAbout,
} from './overlays.js';

// ── DOM refs ─────────────────────────────────────────────────────────
const editor         = document.getElementById('editor');
if (editor) editor.setAttribute('autocorrect', 'off');
const editorMirror   = document.getElementById('editor-mirror');
const preview        = document.getElementById('preview');
const previewWrap    = document.getElementById('preview-wrap');
const gutter         = document.getElementById('editor-gutter');
const workspace      = document.querySelector('.workspace');
const dropOverlay    = document.getElementById('drop-overlay');
const fileInput      = document.getElementById('file-input');
const folderInput    = document.getElementById('folder-input');
if (folderInput) {
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.setAttribute('directory', '');
}
// Per-upload target project. Set by the sidebar's per-project upload
// button; consumed (and cleared) on the next loadFile() call.
let _pendingUploadProjectId = null;
const btnUpload      = document.getElementById('btn-upload');
const btnTheme       = document.getElementById('btn-theme');
const btnFocus       = document.getElementById('btn-focus');
const focusDock      = document.getElementById('focus-dock');
const dockTheme      = document.getElementById('dock-theme');
const dockReading    = document.getElementById('dock-reading');
const dockOutline    = document.getElementById('dock-outline');
const dockExit       = document.getElementById('dock-exit');
const btnSync        = document.getElementById('btn-sync');
const toggleProse    = document.getElementById('toggle-prose');
const resizer        = document.getElementById('resizer');
const fileIndicator  = document.getElementById('file-indicator');
const toast          = document.getElementById('toast');
const hljsTheme      = document.getElementById('hljs-theme');

const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const statWords      = document.getElementById('stat-words');
const statChars      = document.getElementById('stat-chars');
const statLines      = document.getElementById('stat-lines');
const statRead       = document.getElementById('stat-read');
const statRender     = document.getElementById('stat-render');

const examplesMenu   = document.getElementById('examples-menu');

const toc            = document.getElementById('toc');
const tocNav         = document.getElementById('toc-nav');
const btnToc         = document.getElementById('btn-toc');
const btnTocClose    = document.getElementById('btn-toc-close');

const marked         = window.marked;
const DOMPurify      = window.DOMPurify;
const hljs           = window.hljs;
const katex          = window.katex;

const THEME_KEY      = 'mdlab.theme.v1';
const VIEW_KEY       = 'mdlab.view.v1';
// v2 discards any v1 split saved before the outline-offset fix.
const SPLIT_KEY      = 'mdlab.split.v2';
const PROSE_KEY      = 'mdlab.prose.v1';
const SYNC_KEY       = 'mdlab.sync.v1';
const TOC_KEY        = 'mdlab.toc.v1';

let toastTimer;
let mermaidCounter = 0;
let _anchorRebuildTimer;
let _lastPreviewHtml = null;
let _renderGen = 0;
// `_lastSrcLen = -1` forces the first render. Hash gate skips re-renders
// when the source is unchanged.
let _lastSrcHash = 0;
let _lastSrcLen = -1;

// Cached math ranges (full-source coords). Find treats text inside
// $…$ / $$…$$ as hidden; `_lastMathSrc` guards against stale reads
// mid-keystroke (find bar reads these while render() is debouncing).
let _lastMathRanges = [];
let _lastMathSrc = null;

// FNV-1a 32-bit. Shared by hljs / sanitize / mermaid cache keys and
// render()'s input-hash gate.
function fnv1a32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Reset after programmatic editor.value assignment so the next render runs.
function invalidateRenderCache() {
  _lastSrcLen = -1;
  _lastSrcHash = 0;
}

function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => { clearTimeout(t); t = 0; };
  wrapped.flush = () => { if (t) { clearTimeout(t); t = 0; fn(); } };
  return wrapped;
}

// Microtask defer — all module-level bindings init before any code path
// (init → render → persist) touches them, avoiding TDZ errors.
Promise.resolve().then(() => init()).catch(err => {
  console.error('Init failed:', err);
  setStatus('error', 'Failed to initialize');
  preview.innerHTML = '<pre style="color:var(--danger);padding:16px;font-size:12px;white-space:pre-wrap;">' +
    String(err?.stack || err?.message || err).replace(/</g,'&lt;') + '</pre>';
});

// Service worker: offline support + update prompt. Deferred to `load`
// so cache warmup doesn't compete with critical resources.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then((reg) => {
        // Poll on visibility/focus (not setInterval) so idle tabs don't
        // hammer the network. Throttle to once per 24h.
        const UPDATE_COOLDOWN = 24 * 60 * 60 * 1000;
        let lastUpdateCheck = 0;
        const maybeUpdate = () => {
          if (document.visibilityState !== 'visible') return;
          const now = Date.now();
          if (now - lastUpdateCheck < UPDATE_COOLDOWN) return;
          lastUpdateCheck = now;
          reg.update().catch(() => {});
        };
        document.addEventListener('visibilitychange', maybeUpdate);
        window.addEventListener('focus', maybeUpdate);

        // Persistent "new version" toast with a Reload action.
        function onUpdateReady(worker) {
          if (worker.state !== 'installed' || !navigator.serviceWorker.controller) return;
          if (!toast) return;
          clearTimeout(toastTimer);
          toast.dataset.variant = 'info';
          toast.classList.add('is-show', 'has-action');
          toast.textContent = '';
          const label = document.createElement('span');
          label.className = 'toast__label';
          label.textContent = 'A new version is available';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'toast__action';
          btn.textContent = 'Reload';
          btn.addEventListener('click', () => {
            toast.classList.remove('is-show', 'has-action');
            worker.postMessage({ type: 'SKIP_WAITING' });
          });
          toast.append(label, btn);
        }

        if (reg.waiting) onUpdateReady(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', () => onUpdateReady(incoming));
        });
      })
      .catch(err => console.warn('Service worker registration failed:', err));

    // Reload when the new SW takes control. Skipped on first install.
    if (navigator.serviceWorker.controller) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    }
  });
}

async function init() {
  await waitForLibs();
  installDomPurifyHooks();
  setupMarked();
  setupMermaid();
  restoreTheme();
  restoreView();
  restoreSplit();
  restoreProse();
  restoreSyncPref();
  restoreTocPref();
  buildExamplesMenu();
  bindUI();
  registerKeyboardShortcuts();

  await bootstrapProjects();

  ensureEditorObserver();

  await initSidebar({
    onOpenFile: (id) => switchToFile(id),
    onFileDeleted: () => {},
    onUndoableDelete: (info) => showUndoableDeleteToast(info),
    onDbBlocked: (err) => showToast(err?.message || 'Storage blocked by another tab', 'error'),
    onUploadToProject: (projectId) => {
      _pendingUploadProjectId = projectId;
      fileInput.click();
    },
  });

  initTabs({
    onActivate: (id) => switchToFile(id),
    onClose: () => {
      // If we closed the currently loaded tab, swap to whatever's active now.
      if (Store.activeId && Store.activeId !== _loadedFileId) switchToFile(Store.activeId);
      else if (!Store.activeId) {
        editor.value = '';
        invalidateRenderCache();
        updateFileIndicator();
        safeUpdateGutter();
        scheduleRender();
      }
    },
    onCreate: (id) => switchToFile(id),
  });

  // Consume `?action=new` from the PWA manifest shortcut. Runs after
  // projects + tabs init so newFileInActive can attach and open a tab.
  // replaceState strips the param so reloads don't keep spawning files.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('action') === 'new') {
      await newFileInActive();
      history.replaceState(null, '', location.pathname);
    }
  } catch (err) {
    console.warn('Ignoring query-param action:', err);
  }

  initPalette({
    onOpenFile: (id) => switchToFile(id),
    runCommand: (cmd) => {
      try {
        cmd.run?.();
      } catch (err) {
        console.error('Palette command failed:', err);
        showToast(`Command failed: ${cmd.title}`, 'error');
      }
    },
    commands: buildCommandList,
  });

  await render();

  // First render may have short-circuited the retry via hash cache.
  if (editor.value.trim().length > 0 && preview.innerText.trim().length < 10) {
    console.warn('Preview empty after init — forcing re-render');
    invalidateRenderCache();
    await render();
  }

  // Two-frame defer so Mermaid/KaTeX have settled before we restore scrollTop.
  requestAnimationFrame(() => requestAnimationFrame(restoreActiveFileScroll));
}

async function waitForLibs() {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (window.marked && window.DOMPurify && window.hljs && window.katex) return;
    await new Promise(r => setTimeout(r, 50));
  }
  const missing = ['marked', 'DOMPurify', 'hljs', 'katex'].filter(n => !window[n]);
  throw new Error(`Libraries failed to load: ${missing.join(', ')}. Check network.`);
}

function installDomPurifyHooks() {
  if (!window.DOMPurify || DOMPurify._mdlabHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' && node.hasAttribute('target')) {
      const target = node.getAttribute('target');
      if (target && target.toLowerCase() === '_blank') {
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
  DOMPurify._mdlabHookInstalled = true;
}

function setupMarked() {
  marked.setOptions({ gfm: true, breaks: true, pedantic: false });

  try {
    const ext = window.markedGfmHeadingId;
    const fn = ext?.gfmHeadingId || ext?.default || (typeof ext === 'function' ? ext : null);
    if (fn) marked.use(fn());
  } catch (e) { console.warn('marked-gfm-heading-id skipped:', e); }

  try {
    const ext = window.markedFootnote;
    const fn = (typeof ext === 'function' ? ext : ext?.default);
    if (fn) marked.use(fn());
  } catch (e) { console.warn('marked-footnote skipped:', e); }

  marked.use({
    renderer: {
      code(code, infostring) {
        const lang = (infostring || '').match(/^\S*/)?.[0] || '';
        if (lang === 'mermaid') {
          return `<div class="mermaid" data-mermaid-src="${encodeURIComponent(code)}">${escapeHtml(code)}</div>`;
        }
        const highlighted = highlightCached(code, lang);
        const cls = lang ? ` class="hljs language-${lang}"` : ' class="hljs"';
        return `<pre><code${cls}>${highlighted}</code></pre>`;
      },
      blockquote(quote) {
        const match = quote.match(/^<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*(.*?)<\/p>\s*/is);
        if (match) {
          const kind = match[1].toLowerCase();
          const rest = quote.slice(match[0].length);
          const trailing = match[2].replace(/^(?:<br\s*\/?>\s*)+/i, '').trim();
          const title = kind.charAt(0).toUpperCase() + kind.slice(1);
          const titleHtml = `<p class="markdown-alert-title">${ALERT_ICONS[kind] || ''} ${title}</p>`;
          const body = trailing ? `<p>${trailing}</p>${rest}` : rest;
          return `<blockquote class="markdown-alert markdown-alert-${kind}">${titleHtml}${body}</blockquote>`;
        }
        return `<blockquote>${quote}</blockquote>`;
      },
    },
  });
}

const HLJS_CACHE_MAX = 256;
const _hljsCache = new Map();

// Post-sanitize HTML cache — fast path for file-switch round-trips and
// edit/undo/retype.
const SANITIZE_CACHE_MAX = 24;
const _sanitizeCache = new Map();

const DOMPURIFY_CONFIG = Object.freeze({
  ADD_TAGS: ['foreignObject', 'annotation-xml', 'semantics', 'annotation', 'math', 'mi', 'mo', 'mn', 'mrow', 'msup', 'msub', 'msubsup', 'mfrac', 'mspace', 'mtext', 'menclose', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle'],
  ADD_ATTR: ['target', 'mathvariant', 'displaystyle', 'mathcolor'],
  ALLOW_UNKNOWN_PROTOCOLS: false,
});

function hljsKey(code, lang) {
  return `${lang || ''}\0${code.length}\0${fnv1a32(code)}`;
}

function highlightCached(code, lang) {
  const key = hljsKey(code, lang);
  const hit = _hljsCache.get(key);
  if (hit !== undefined) {
    _hljsCache.delete(key);
    _hljsCache.set(key, hit);
    return hit;
  }
  let result;
  try {
    if (lang && hljs.getLanguage(lang)) {
      result = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } else if (code.length <= 4000) {
      result = hljs.highlightAuto(code).value;
    } else {
      result = escapeHtml(code);
    }
  } catch {
    result = escapeHtml(code);
  }
  _hljsCache.set(key, result);
  if (_hljsCache.size > HLJS_CACHE_MAX) {
    const firstKey = _hljsCache.keys().next().value;
    _hljsCache.delete(firstKey);
  }
  return result;
}

// Mermaid SVG LRU cache. Keyed on (theme, length, hash). Diagrams using
// `click` directives are skipped — bindFunctions can't be reconstructed.
const MERMAID_CACHE_MAX = 64;
const _mermaidCache = new Map();

function mermaidKey(code, theme) {
  return `${theme}\0${code.length}\0${fnv1a32(code)}`;
}

function mermaidCodeIsCacheable(code) {
  return !/^\s*click\s+/m.test(code);
}

function mermaidCacheGet(key) {
  const hit = _mermaidCache.get(key);
  if (hit === undefined) return undefined;
  _mermaidCache.delete(key);
  _mermaidCache.set(key, hit);
  return hit;
}

function mermaidCacheSet(key, svg) {
  _mermaidCache.set(key, svg);
  if (_mermaidCache.size > MERMAID_CACHE_MAX) {
    _mermaidCache.delete(_mermaidCache.keys().next().value);
  }
}

// Uniquify ids + internal refs so a cached SVG can paint multiple times
// without duplicate-id collisions. Also rewrites the embedded <style>
// block's `#<svgId>` selectors — mermaid scopes every rule by the root
// svg id, so leaving those stale strips fills, strokes, and markers.
function uniquifyMermaidSvgIds(svg, seed) {
  const suffix = `-c${seed}`;
  const rootIdMatch = svg.match(/<svg[^>]*\bid="([^"]+)"/);
  const rootId = rootIdMatch ? rootIdMatch[1] : null;

  let out = svg
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${id}${suffix}"`)
    .replace(/\burl\(#([^)]+)\)/g, (_, id) => `url(#${id}${suffix})`)
    // (xlink:)? avoids a negative lookbehind — iOS Safari <16.4 fails to parse.
    .replace(/\b(xlink:)?href="#([^"]+)"/g,
      (_, xlink, id) => `${xlink || ''}href="#${id}${suffix}"`)
    .replace(/\baria-(labelledby|describedby)="([^"]+)"/g,
      (_, attr, idList) => {
        const rewritten = idList.split(/\s+/).filter(Boolean).map(id => id + suffix).join(' ');
        return `aria-${attr}="${rewritten}"`;
      });

  if (rootId) {
    const escaped = rootId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorRe = new RegExp(`#${escaped}(?![\\w-])`, 'g');
    out = out.replace(/<style>([\s\S]*?)<\/style>/g,
      (_, css) => `<style>${css.replace(selectorRe, `#${rootId}${suffix}`)}</style>`);
  }
  return out;
}

const ALERT_ICONS = {
  note:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  tip:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.8.6 1 1.6 1 2.3h6c0-.7.2-1.7 1-2.3A7 7 0 0 0 12 2z"/></svg>',
  important: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l9 16H3l9-16z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warning:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  caution:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

function setupMermaid() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'strict',
    fontFamily: 'Inter, system-ui, sans-serif',
    themeVariables: mermaidThemeVars(theme),
    flowchart: { curve: 'basis', htmlLabels: true },
    sequence: { showSequenceNumbers: false, actorMargin: 50 },
    gantt: {
      fontSize: 12,
      sectionFontSize: 13,
      barHeight: 26,
      barGap: 6,
      topPadding: 56,
      leftPadding: 90,
      gridLineStartPadding: 35,
      useWidth: undefined,
      numberSectionStyles: 4,
    },
  });
}

function mermaidThemeVars(theme) {
  // Dark-mode palette audited for WCAG AA (≥ 4.5:1) fg/bg pairs. Every
  // text-on-fill combination below has been checked; see the detailed notes
  // below each group. Light-mode mirrors the same discipline.
  if (theme === 'dark') {
    return {
      // Surfaces
      background: '#0f141c',              // diagram canvas
      mainBkg: '#134e4a',                 // teal-900 — primary node fill
      secondBkg: '#1e293b',               // slate-800 — secondary node
      tertiaryColor: '#0f172a',
      primaryColor: '#134e4a',
      secondaryColor: '#1e293b',

      // Text — all on mid/dark fills (AA ≥ 4.5:1)
      textColor: '#f1f5f9',
      primaryTextColor: '#f0fdfa',        // teal-50 on teal-900 → 12.4:1
      secondaryTextColor: '#e2e8f0',      // slate-200 on slate-800 → 10.1:1
      tertiaryTextColor: '#f8fafc',
      nodeTextColor: '#f0fdfa',
      titleColor: '#f8fafc',
      labelTextColor: '#f8fafc',
      classText: '#f8fafc',

      // Borders
      primaryBorderColor: '#2dd4bf',      // teal-400 — glows against teal-900
      secondaryBorderColor: '#94a3b8',
      tertiaryBorderColor: '#cbd5e1',
      nodeBorder: '#2dd4bf',

      // Edges
      lineColor: '#cbd5e1',
      edgeLabelBackground: '#1e293b',     // slate-800 for edge-label bg

      // Clusters
      clusterBkg: '#14222b',
      clusterBorder: '#475569',

      // Sequence diagrams
      actorBkg: '#134e4a',
      actorBorder: '#2dd4bf',
      actorTextColor: '#f0fdfa',          // 12.4:1
      actorLineColor: '#cbd5e1',
      signalColor: '#e2e8f0',
      signalTextColor: '#f8fafc',
      labelBoxBkgColor: '#334155',        // slate-700
      labelBoxBorderColor: '#94a3b8',
      loopTextColor: '#f8fafc',

      // Notes — desaturated amber card w/ legible amber-100 text (7.8:1).
      // Previously used bright #fde68a on dark canvas which looked jarring.
      noteBkgColor: '#422006',
      noteTextColor: '#fde68a',
      noteBorderColor: '#f59e0b',

      // Activation bars (sequence) — cyan to differentiate from emerald nodes
      activationBkgColor: '#0e7490',
      activationBorderColor: '#67e8f9',

      // State diagrams
      stateBkg: '#134e4a',
      altBackground: '#14222b',           // subtle alt row, distinct from tertiary

      // Git graph — all branch fills are mid/light so BOTH primary branch
      // labels AND inverse (commit dot) labels use dark foreground text to
      // meet WCAG AA (≥ 4.5:1). White text on light-cyan/teal/amber was
      // failing ~1.5:1. Dark-on-light is the safe choice across the board.
      git0: '#2dd4bf', git1: '#22d3ee', git2: '#a78bfa', git3: '#fbbf24',
      git4: '#60a5fa', git5: '#f472b6', git6: '#fb7185', git7: '#4ade80',
      gitBranchLabel0: '#0f172a', gitBranchLabel1: '#0f172a',
      gitBranchLabel2: '#0f172a', gitBranchLabel3: '#0f172a',
      gitBranchLabel4: '#0f172a', gitBranchLabel5: '#0f172a',
      gitBranchLabel6: '#0f172a', gitBranchLabel7: '#0f172a',
      gitInv0: '#0f172a', gitInv1: '#0f172a', gitInv2: '#0f172a',
      gitInv3: '#0f172a', gitInv4: '#0f172a', gitInv5: '#0f172a',
      gitInv6: '#0f172a', gitInv7: '#0f172a',
      commitLabelColor: '#f8fafc',
      commitLabelBackground: '#14222b',
      commitLabelFontSize: '12px',
      tagLabelColor: '#0f172a',
      tagLabelBackground: '#2dd4bf',
      tagLabelBorder: '#0f172a',

      // Class/flowchart color scale — all with white labels (AA verified
      // against 4.5:1 except cScale1 which uses dark text).
      cScale0: '#0d9488', cScale1: '#67e8f9', cScale2: '#0369a1',
      cScale3: '#1d4ed8', cScale4: '#b45309', cScale5: '#6d28d9',
      cScale6: '#b91c1c', cScale7: '#15803d',
      cScaleLabel0: '#ffffff', cScaleLabel1: '#0f172a',
      cScaleLabel2: '#ffffff', cScaleLabel3: '#ffffff',
      cScaleLabel4: '#ffffff', cScaleLabel5: '#ffffff',
      cScaleLabel6: '#ffffff', cScaleLabel7: '#ffffff',

      // Pie — light/mid slice colors + dark labels (AA: each slice >= 4.5:1
      // against #0f172a). Replaces the earlier all-dark label scheme that
      // failed on darker slice colors.
      pie1: '#34d399', pie2: '#22d3ee', pie3: '#60a5fa', pie4: '#fbbf24',
      pie5: '#f472b6', pie6: '#fca5a5', pie7: '#a78bfa', pie8: '#2dd4bf',
      pie9: '#fb923c', pie10: '#4ade80', pie11: '#fcd34d', pie12: '#c084fc',
      pieTitleTextColor: '#f8fafc',
      pieSectionTextColor: '#0f172a',     // dark label on all light slice fills
      pieLegendTextColor: '#e2e8f0',
      pieStrokeColor: '#14222b',

      // Gantt — distinct section shading (previously 1.1× ratio; now ~2.5×),
      // done tasks darkened from slate-500 → slate-600 for AA white text.
      gridColor: '#334155',
      taskBkgColor: '#0d9488',
      taskBorderColor: '#2dd4bf',
      taskTextColor: '#ffffff',
      taskTextDarkColor: '#0f172a',
      taskTextLightColor: '#ffffff',
      taskTextOutsideColor: '#f1f5f9',
      taskTextClickableColor: '#ffffff',
      activeTaskBkgColor: '#0e7490',
      activeTaskBorderColor: '#67e8f9',
      doneTaskBkgColor: '#475569',        // slate-600 (4.9:1 w/ white)
      doneTaskBorderColor: '#cbd5e1',
      critBkgColor: '#b91c1c',            // red-700 (5.9:1 w/ white)
      critBorderColor: '#fecaca',
      sectionBkgColor: '#0f2027',
      sectionBkgColor2: '#1c3540',        // 2.5× separation from Color1
      altSectionBkgColor: '#0f2027',
      todayLineColor: '#f87171',
      titleColor2: '#e2e8f0',
      tickColor: '#cbd5e1',
      ganttFontSize: '12px',
    };
  }
  // ---- Light mode — WCAG-audited parity ---------------------------------
  return {
    background: '#ffffff',
    primaryColor: '#ccfbf1',              // teal-100
    primaryTextColor: '#134e4a',          // teal-900 on teal-100 → 8.7:1
    primaryBorderColor: '#0d9488',
    secondaryColor: '#f1f5f9',
    secondaryTextColor: '#0f172a',
    secondaryBorderColor: '#94a3b8',
    tertiaryColor: '#ffffff',
    tertiaryTextColor: '#0f172a',
    tertiaryBorderColor: '#cbd5e1',

    mainBkg: '#ccfbf1',
    secondBkg: '#f1f5f9',
    nodeBorder: '#0d9488',
    nodeTextColor: '#134e4a',
    textColor: '#0f172a',
    titleColor: '#0f172a',
    labelTextColor: '#0f172a',

    lineColor: '#475569',
    edgeLabelBackground: '#ffffff',

    clusterBkg: '#f8fafc',
    clusterBorder: '#e2e8f0',

    actorBkg: '#ccfbf1',
    actorBorder: '#0d9488',
    actorTextColor: '#134e4a',            // 8.7:1
    actorLineColor: '#475569',
    signalColor: '#1e293b',
    signalTextColor: '#0f172a',
    labelBoxBkgColor: '#f1f5f9',
    labelBoxBorderColor: '#94a3b8',
    loopTextColor: '#0f172a',
    noteBkgColor: '#fef3c7',
    noteTextColor: '#78350f',             // amber-900 on amber-100 → 9.4:1
    noteBorderColor: '#f59e0b',
    activationBkgColor: '#0e7490',        // teal-700
    activationBorderColor: '#0d9488',

    classText: '#0f172a',
    stateBkg: '#ccfbf1',
    altBackground: '#f8fafc',

    git0: '#0d9488', git1: '#0891b2', git2: '#7c3aed', git3: '#b45309',
    git4: '#1d4ed8', git5: '#be185d', git6: '#b91c1c', git7: '#0e7490',
    gitBranchLabel0: '#ffffff', gitBranchLabel1: '#ffffff',
    gitBranchLabel2: '#ffffff', gitBranchLabel3: '#ffffff',
    gitBranchLabel4: '#ffffff', gitBranchLabel5: '#ffffff',
    gitBranchLabel6: '#ffffff', gitBranchLabel7: '#ffffff',
    gitInv0: '#0f172a', gitInv1: '#0f172a', gitInv2: '#0f172a',
    gitInv3: '#0f172a', gitInv4: '#0f172a', gitInv5: '#0f172a',
    gitInv6: '#0f172a', gitInv7: '#0f172a',
    commitLabelColor: '#0f172a',
    commitLabelBackground: '#ffffff',
    commitLabelFontSize: '12px',
    tagLabelColor: '#0f172a',
    tagLabelBackground: '#ccfbf1',
    tagLabelBorder: '#0d9488',

    cScale0: '#0d9488', cScale1: '#0891b2', cScale2: '#1d4ed8',
    cScale3: '#7c3aed', cScale4: '#b45309', cScale5: '#be185d',
    cScale6: '#b91c1c', cScale7: '#15803d',
    cScaleLabel0: '#ffffff', cScaleLabel1: '#ffffff',
    cScaleLabel2: '#ffffff', cScaleLabel3: '#ffffff',
    cScaleLabel4: '#ffffff', cScaleLabel5: '#ffffff',
    cScaleLabel6: '#ffffff', cScaleLabel7: '#ffffff',

    pie1: '#0d9488', pie2: '#0891b2', pie3: '#1d4ed8', pie4: '#b45309',
    pie5: '#be185d', pie6: '#b91c1c', pie7: '#7c3aed', pie8: '#0e7490',
    pie9: '#c2410c', pie10: '#15803d', pie11: '#a16207', pie12: '#6b21a8',
    pieTitleTextColor: '#0f172a',
    pieSectionTextColor: '#ffffff',       // dark slices, white labels
    pieLegendTextColor: '#0f172a',
    pieStrokeColor: '#ffffff',

    gridColor: '#e2e8f0',
    taskBkgColor: '#0d9488',
    taskBorderColor: '#14b8a6',
    taskTextColor: '#ffffff',
    taskTextDarkColor: '#0f172a',
    taskTextLightColor: '#ffffff',
    taskTextOutsideColor: '#0f172a',
    taskTextClickableColor: '#ffffff',
    activeTaskBkgColor: '#0e7490',
    activeTaskBorderColor: '#0891b2',
    doneTaskBkgColor: '#94a3b8',
    doneTaskBorderColor: '#475569',
    critBkgColor: '#b91c1c',
    critBorderColor: '#7f1d1d',
    sectionBkgColor: '#f8fafc',
    sectionBkgColor2: '#e2e8f0',
    altSectionBkgColor: '#ffffff',
    todayLineColor: '#b91c1c',
    titleColor2: '#334155',
    tickColor: '#64748b',
    ganttFontSize: '12px',
  };
}



// Block-level diff: replace only the changed middle of the preview tree.
// Mermaid matches on data-mermaid-src so rendered SVGs survive re-renders.
const _previewParser = new DOMParser();

function blockSig(el) {
  if (el.classList?.contains('mermaid')) {
    return `mermaid\0${fnv1a32(el.getAttribute('data-mermaid-src') || '')}`;
  }
  // postProcess wraps <table> in .table-wrap; normalise to match bare <table>.
  if (el.classList?.contains('table-wrap')) {
    const inner = el.firstElementChild;
    if (inner && inner.tagName === 'TABLE') return `table\0${fnv1a32(inner.outerHTML)}`;
  }
  if (el.tagName === 'TABLE') return `table\0${fnv1a32(el.outerHTML)}`;
  // postProcess decorates <pre> (copy button, lang badge) — hash inner <code>.
  if (el.tagName === 'PRE') {
    const code = el.querySelector('code');
    if (code) return `pre\0${fnv1a32(code.outerHTML)}`;
  }
  // postProcess mutates task-list checkbox attributes — hash text + state.
  if ((el.tagName === 'UL' || el.tagName === 'OL') &&
      el.querySelector(':scope > li.task-list-item')) {
    const parts = [];
    for (const li of el.children) {
      const cb = li.querySelector(':scope > input[type="checkbox"]');
      parts.push((cb?.checked ? '1' : '0') + '\0' + (li.textContent || ''));
    }
    return `tasklist\0${fnv1a32(parts.join('\n'))}`;
  }
  return fnv1a32(el.outerHTML);
}

function applyPreviewHtml(html) {
  const old = preview;
  const oldCount = old.children.length;
  if (oldCount < 3) { old.innerHTML = html; return; }

  const doc = _previewParser.parseFromString(
    `<!doctype html><body>${html}</body>`, 'text/html'
  );
  const incoming = doc.body;
  const newCount = incoming.children.length;
  if (newCount < 3) { old.innerHTML = html; return; }

  const oldSigs = new Array(oldCount);
  const newSigs = new Array(newCount);
  for (let i = 0; i < oldCount; i++) oldSigs[i] = blockSig(old.children[i]);
  for (let i = 0; i < newCount; i++) newSigs[i] = blockSig(incoming.children[i]);

  let p = 0;
  const minCount = Math.min(oldCount, newCount);
  while (p < minCount && oldSigs[p] === newSigs[p]) p++;

  let sOld = oldCount - 1, sNew = newCount - 1;
  while (sOld >= p && sNew >= p && oldSigs[sOld] === newSigs[sNew]) { sOld--; sNew--; }

  const oldReplace = sOld - p + 1;
  const newInsert  = sNew - p + 1;

  // >40% changed — full replace is simpler than splice.
  if (Math.max(oldReplace, newInsert) > Math.max(oldCount, newCount) * 0.4) {
    old.innerHTML = html;
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < newInsert; i++) frag.appendChild(incoming.children[p]);
  for (let k = 0; k < oldReplace; k++) old.children[p].remove();

  const anchor = old.children[p] || null;
  if (anchor) old.insertBefore(frag, anchor);
  else old.appendChild(frag);
}

async function render() {
  const src = editor.value;

  // Stats + persist run before the hash gate so out-of-band f.content
  // mutations still surface in the footer and IndexedDB.
  updateStats(src);
  persist();

  // Byte-identical input: skip the entire pipeline.
  const srcLen = src.length;
  const srcHash = fnv1a32(src);
  if (srcLen === _lastSrcLen && srcHash === _lastSrcHash) return;
  _lastSrcLen = srcLen;
  _lastSrcHash = srcHash;
  const gen = ++_renderGen;
  const nextBlockLines = computeSourceBlockLines(src);
  const blockLinesChanged =
    nextBlockLines.length !== sourceBlockLines.length ||
    nextBlockLines.some((v, i) => v !== sourceBlockLines[i]);
  sourceBlockLines = nextBlockLines;

  if (!src.trim()) {
    preview.innerHTML = emptyStateHtml();
    _lastPreviewHtml = null;
    setStatus('ready', 'Ready');
    statRender.textContent = '—';
    preview.querySelector('[data-empty-action="upload"]')?.addEventListener('click', () => fileInput.click());
    preview.querySelector('[data-empty-action="welcome"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const project =
          Store.focusedProject() ||
          (await createProject({ name: 'My documents' }));
        const name = uniqueFileName(project.id, 'welcome.md');
        const f = await createFile({ projectId: project.id, name, content: EXAMPLES.welcome.content });
        await switchToFile(f.id);
      } finally {
        if (document.contains(btn)) btn.disabled = false;
      }
    });
    buildToc();
    return;
  }

  const t0 = performance.now();
  setStatus('busy', 'Rendering…');

  try {
    const { frontmatterHtml, body } = extractFrontmatter(src);
    const { processed, renders, mathRanges } = extractMath(body);

    // Shift math ranges into full-source coords once so find doesn't have
    // to re-apply the frontmatter offset on every read.
    const bodyOffset = src.length - body.length;
    _lastMathRanges = mathRanges.map(r => ({
      start: r.start + bodyOffset,
      end: r.end + bodyOffset,
      display: r.display,
    }));
    _lastMathSrc = src;

    // Pasted tables often carry trailing tabs in separator rows, which
    // break the marked tokenizer. Normalize them to spaces.
    const tableNormalized = processed.replace(
      /^(\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*)$/gm,
      (line) => line.replace(/\t/g, ' ')
    );

    // Math placeholders are index-only, so TeX source must be hashed
    // into the cache key or distinct formulas at the same index collide.
    const mathKey = renders.length ? fnv1a32(renders.join('\0')) : 0;
    const parseKey =
      `${tableNormalized.length}\0${fnv1a32(tableNormalized)}\0` +
      `${frontmatterHtml.length}\0${frontmatterHtml ? fnv1a32(frontmatterHtml) : 0}\0` +
      `${renders.length}\0${mathKey}`;
    let clean = _sanitizeCache.get(parseKey);
    if (clean !== undefined) {
      _sanitizeCache.delete(parseKey);
      _sanitizeCache.set(parseKey, clean);
    } else {
      let html = marked.parse(tableNormalized);
      html = reinjectMath(html, renders);
      if (frontmatterHtml) html = frontmatterHtml + html;
      clean = DOMPurify.sanitize(html, DOMPURIFY_CONFIG);
      _sanitizeCache.set(parseKey, clean);
      if (_sanitizeCache.size > SANITIZE_CACHE_MAX) {
        _sanitizeCache.delete(_sanitizeCache.keys().next().value);
      }
    }

    // Skip DOM work when the sanitized HTML is unchanged (trailing whitespace
    // edits, typo-and-undo). Rebuilding would tear down every Mermaid SVG.
    const changed = clean !== _lastPreviewHtml;
    if (changed) {
      // Harvest before the swap so runMermaid Pass 1 can transplant live
      // SVGs for diagrams whose source didn't change.
      _mermaidHarvest = harvestRenderedMermaid();
      applyPreviewHtml(clean);
      _lastPreviewHtml = clean;
      await runMermaid(gen);
      if (gen !== _renderGen) return;
      postProcess();
      buildToc();
      // Preview DOM was replaced — re-run find against the fresh tree.
      if (isFindBarOpen()) {
        const q = document.getElementById('find-input')?.value || '';
        if (q) runFind(q);
      }
    }

    // No-op render with identical block structure: mirror + anchor maps
    // are still valid, skip the O(N) rebuilds.
    if (changed || blockLinesChanged) {
      // Rebuild now (best-effort) and again after Mermaid/KaTeX inflation
      // settles; ResizeObserver catches anything that shifts afterwards.
      syncEditorMirror();
      rebuildAnchorMap();
      scheduleAnchorRebuild();
      ensurePreviewObserver();
    }

    statRender.textContent = `${(performance.now() - t0).toFixed(0)} ms`;
    setStatus('ready', 'Rendered');
  } catch (err) {
    console.error('Render error:', err);
    setStatus('error', 'Render failed');
    statRender.textContent = '\u2014';
    preview.innerHTML = `<div class="render-error" role="alert"><strong>Render failed</strong><code>${escapeHtml(String(err?.message || err))}</code></div>`;
    _lastPreviewHtml = null;
  }
}

// Restore raw Mermaid source + clear processed/error flags. Used by the
// PDF export path before re-running mermaid inside a print iframe.
function resetMermaidNodes(nodes) {
  nodes.forEach((el) => {
    el.removeAttribute('data-processed');
    el.classList.remove('is-error');
    const raw = el.getAttribute('data-mermaid-src');
    if (raw) el.textContent = decodeURIComponent(raw);
    if (!el.id) el.id = `mermaid-${++mermaidCounter}`;
  });
}

// Offscreen sandbox for mermaid.render(). A display:none pane would return
// 0×0 rects and Dagre emits NaN transforms; off-screen-but-laid-out works.
// `markdown-body` keeps htmlLabel text measurements consistent with preview.
let _mermaidSandbox = null;
function ensureMermaidSandbox() {
  if (_mermaidSandbox && _mermaidSandbox.isConnected) return _mermaidSandbox;
  _mermaidSandbox = document.createElement('div');
  _mermaidSandbox.id = 'mermaid-sandbox';
  _mermaidSandbox.className = 'markdown-body';
  _mermaidSandbox.setAttribute('aria-hidden', 'true');
  // 1200px mirrors a typical preview column width.
  _mermaidSandbox.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1200px;height:auto;' +
    'pointer-events:none;contain:layout style;';
  document.body.appendChild(_mermaidSandbox);
  return _mermaidSandbox;
}

const isStaleRender = (gen) => gen !== undefined && gen !== _renderGen;

// SVGs harvested from the outgoing preview, keyed by (theme, source-hash).
// Populated before applyPreviewHtml; consumed by runMermaid's transplant pass.
let _mermaidHarvest = null;

function harvestRenderedMermaid() {
  const map = new Map();
  if (!preview) return map;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const existing = preview.querySelectorAll('.mermaid[data-processed="true"]');
  for (const el of existing) {
    // Skip mismatched-theme SVGs — transplanting them would paint stale colors.
    if (el.getAttribute('data-theme') !== theme) continue;
    const raw = el.getAttribute('data-mermaid-src');
    if (!raw) continue;
    const svg = el.querySelector('svg');
    if (!svg) continue;
    let code;
    try { code = decodeURIComponent(raw); } catch { continue; }
    if (!mermaidCodeIsCacheable(code)) continue;
    const key = mermaidKey(code, theme);
    if (!map.has(key)) map.set(key, svg);
  }
  return map;
}

// Yield to the browser between work units. scheduler.yield where available
// (Chrome 129+, Edge 129+, Firefox 142+), setTimeout(0) elsewhere.
function yieldToMain() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Three passes: (1) keep diagrams already rendered under the current theme,
// (2) transplant harvested SVGs for unchanged sources, (3) render remaining
// diagrams — eager for those in or near the viewport, lazy for the rest.
async function runMermaid(gen) {
  const nodes = Array.from(preview.querySelectorAll('.mermaid'));
  if (!nodes.length) {
    _mermaidHarvest = null;
    return;
  }

  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const harvest = _mermaidHarvest;
  _mermaidHarvest = null;

  // Pass 1: strip nodes whose cached SVG was rendered under a different theme
  // (block diff may preserve them across theme toggles); force a re-render.
  nodes.forEach((el) => {
    const ready = el.getAttribute('data-processed') === 'true'
      && el.getAttribute('data-theme') === theme
      && el.querySelector('svg');
    if (ready) {
      if (!el.id) el.id = `mermaid-${++mermaidCounter}`;
      return;
    }
    el.removeAttribute('data-processed');
    el.removeAttribute('data-theme');
    el.classList.remove('is-error');
    if (!el.id) el.id = `mermaid-${++mermaidCounter}`;
  });

  const deferred = [];
  for (const el of nodes) {
    if (el.getAttribute('data-processed') === 'true') continue;
    const raw = el.getAttribute('data-mermaid-src');
    const code = raw ? safeDecode(raw) : el.textContent;
    if (!code || !code.trim()) continue;
    if (harvest && mermaidCodeIsCacheable(code)) {
      const key = mermaidKey(code, theme);
      const svg = harvest.get(key);
      if (svg) {
        el.replaceChildren(svg);
        el.setAttribute('data-processed', 'true');
        el.setAttribute('data-theme', theme);
        harvest.delete(key);
        attachDiagramControls(el);
        continue;
      }
    }
    deferred.push({ el, code });
  }

  if (!deferred.length) {
    preview.querySelectorAll('.mermaid').forEach(attachDiagramControls);
    return;
  }

  const viewportH = previewWrap.clientHeight || window.innerHeight;
  const wrapRect = previewWrap.getBoundingClientRect();
  const eagerMin = -viewportH;
  const eagerMax = viewportH * 2;
  const visible = [];
  const offscreen = [];
  for (const d of deferred) {
    const top = d.el.getBoundingClientRect().top - wrapRect.top;
    if (top >= eagerMin && top <= eagerMax) visible.push(d);
    else offscreen.push(d);
  }

  const sandbox = ensureMermaidSandbox();
  for (let i = 0; i < visible.length; i++) {
    if (isStaleRender(gen)) return;
    await renderOneMermaid(visible[i], theme, sandbox);
    if (i < visible.length - 1) await yieldToMain();
  }
  sandbox.innerHTML = '';
  if (isStaleRender(gen)) return;

  if (offscreen.length) scheduleOffscreenMermaid(offscreen, theme, gen);
}

async function renderOneMermaid({ el, code }, theme, sandbox) {
  // Re-read the theme: for offscreen diagrams it may have flipped between
  // queue-time and render-time.
  const liveTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const cacheable = mermaidCodeIsCacheable(code);
  const cacheKey = cacheable ? mermaidKey(code, liveTheme) : null;
  if (cacheKey) {
    const cachedSvg = mermaidCacheGet(cacheKey);
    if (cachedSvg !== undefined) {
      el.innerHTML = uniquifyMermaidSvgIds(cachedSvg, ++mermaidCounter);
      el.setAttribute('data-processed', 'true');
      el.setAttribute('data-theme', liveTheme);
      applyMermaidContrast(el);
      attachDiagramControls(el);
      return;
    }
  }

  const renderId = `mmd-${el.id}-${++mermaidCounter}`;
  try {
    const { svg, bindFunctions } = await mermaid.render(renderId, code, sandbox);
    // Theme may have flipped mid-await; re-read before caching/stamping.
    const postTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    el.innerHTML = svg;
    el.setAttribute('data-processed', 'true');
    el.setAttribute('data-theme', postTheme);
    if (cacheable) mermaidCacheSet(mermaidKey(code, postTheme), svg);
    if (typeof bindFunctions === 'function') bindFunctions(el);
    applyMermaidContrast(el);
    attachDiagramControls(el);
  } catch (err) {
    console.warn('Mermaid render error:', err);
    renderMermaidError(el, err, code);
  }
}

// Lazy-render off-screen diagrams via a single reused IntersectionObserver.
let _mermaidLazyObserver = null;
let _mermaidLazyQueue = new WeakMap();
function scheduleOffscreenMermaid(items, theme, gen) {
  if (!('IntersectionObserver' in window)) {
    const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 300));
    ric(async () => {
      if (isStaleRender(gen)) return;
      const sandbox = ensureMermaidSandbox();
      for (const d of items) {
        if (isStaleRender(gen)) return;
        if (d.el.getAttribute('data-processed') === 'true' &&
            d.el.getAttribute('data-theme') === (document.documentElement.getAttribute('data-theme') || 'dark')) continue;
        await renderOneMermaid(d, theme, sandbox);
        await yieldToMain();
      }
      sandbox.innerHTML = '';
    });
    return;
  }

  if (!_mermaidLazyObserver) {
    _mermaidLazyObserver = new IntersectionObserver(async (entries) => {
      const sandbox = ensureMermaidSandbox();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const info = _mermaidLazyQueue.get(el);
        if (!info) { _mermaidLazyObserver.unobserve(el); continue; }
        _mermaidLazyObserver.unobserve(el);
        _mermaidLazyQueue.delete(el);
        if (isStaleRender(info.gen)) continue;
        const liveTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        // Skip if already processed under the CURRENT theme.
        if (el.getAttribute('data-processed') === 'true' &&
            el.getAttribute('data-theme') === liveTheme) continue;
        // renderOneMermaid re-reads the live theme, so stale info.theme is safe.
        await renderOneMermaid({ el, code: info.code }, liveTheme, sandbox);
        await yieldToMain();
      }
    }, { root: previewWrap, rootMargin: '400px 0px' });
  }

  for (const d of items) {
    _mermaidLazyQueue.set(d.el, { code: d.code, gen, theme });
    _mermaidLazyObserver.observe(d.el);
  }
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Lucide alert-triangle, inlined so the error card has no external deps.
const MERMAID_ERROR_ICON = `
  <svg class="mermaid-error__icon" width="16" height="16" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`;

// Parse Mermaid's Jison error into { line, summary }. Prefers err.hash
// (structured) and falls back to regex on the message string.
function parseMermaidError(err) {
  const hash = err?.hash;
  const msg = String(err?.message || 'Parse error');
  let line = null;
  let summary = '';

  if (typeof hash?.line === 'number') {
    line = hash.line + 1;
  } else {
    const m = /Parse error on line (\d+)/i.exec(msg);
    if (m) line = Number(m[1]);
  }

  if (hash?.token) {
    const expected = Array.isArray(hash.expected)
      ? hash.expected.map(s => String(s).replace(/^'|'$/g, '')).slice(0, 4).join(', ')
      : '';
    summary = `Unexpected \`${hash.text ?? hash.token}\``
      + (expected ? ` — expected ${expected}` : '');
  } else {
    const em = /Expecting ([^\n]+?),?\s*got\s*'?([^'\n]+)'?/i.exec(msg);
    if (em) {
      const exp = em[1].split(',').slice(0, 4).map(s => s.replace(/'/g, '').trim()).join(', ');
      summary = `Unexpected \`${em[2].trim()}\` — expected ${exp}`;
    } else {
      summary = msg.split('\n')[0];
    }
  }

  return { line, summary };
}

// Render a readable error card in place of a failed diagram.
function renderMermaidError(el, err, code) {
  el.classList.add('is-error');
  el.setAttribute('role', 'alert');
  el.innerHTML = '';

  const { line: badLine, summary } = parseMermaidError(err);

  const header = document.createElement('div');
  header.className = 'mermaid-error__header';
  header.innerHTML = `${MERMAID_ERROR_ICON}
    <div class="mermaid-error__titles">
      <strong>Couldn't render diagram</strong>
      <span class="mermaid-error__summary"></span>
    </div>`;
  header.querySelector('.mermaid-error__summary').textContent =
    (badLine ? `Line ${badLine}: ` : '') + summary;
  el.appendChild(header);

  const pre = document.createElement('pre');
  pre.className = 'mermaid-error__source';
  const lines = code.split('\n');
  pre.innerHTML = lines.map((text, i) => {
    const n = i + 1;
    const cls = n === badLine ? ' is-bad' : '';
    return `<span class="mermaid-error__line${cls}">`
      + `<span class="mermaid-error__ln" aria-hidden="true">${n}</span>`
      + `<span class="mermaid-error__code">${escapeHtml(text) || ' '}</span>`
      + `</span>`;
  }).join('');
  el.appendChild(pre);

  // Fenced clipboard payload — re-renderable when pasted elsewhere.
  const errorLine = (badLine ? `Line ${badLine}: ` : '') + summary;
  const clipboardText =
    `Mermaid render failed — ${errorLine}\n\n`
    + '```mermaid\n' + code.replace(/\n+$/, '') + '\n```\n';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mermaid-error__copy';
  btn.textContent = 'Copy source';
  let copyResetTimer = 0;
  btn.addEventListener('click', async () => {
    const ok = await copyToClipboard(clipboardText);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('is-copied', ok);
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      btn.textContent = 'Copy source';
      btn.classList.remove('is-copied');
    }, 1400);
  });
  el.appendChild(btn);
}

// ── Mermaid contrast normalization ───────────────────────────────────
// Mermaid's theme-level text color can't see per-node `style X fill:#...`
// overrides. We post-process: pick dark or light FG per node based on
// WCAG luminance of the actual fill. `data-mdlab-contrast` makes CSS
// fallbacks defer to the inline styles.
const MDLAB_DARK_FG  = '#0f172a';
const MDLAB_LIGHT_FG = '#f8fafc';
// Canvas background behind untouched edge labels; reads active theme token.
function mdlabEdgeBg() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--mermaid-bg').trim();
    return v || '#0f141c';
  } catch { return '#0f141c'; }
}

function applyMermaidContrast(mermaidEl) {
  const svg = mermaidEl.querySelector('svg');
  if (!svg) return;

  svg.querySelectorAll('g.node').forEach((nodeG) => {
    const fill = resolveShapeFill(nodeG);
    if (!fill) return;
    paintNodeText(nodeG, pickForegroundFor(fill));
    nodeG.setAttribute('data-mdlab-contrast', '1');
  });

  svg.querySelectorAll('g.cluster').forEach((clusterG) => {
    const fill = resolveShapeFill(clusterG);
    if (!fill) return;
    paintNodeText(clusterG, pickForegroundFor(fill));
    clusterG.setAttribute('data-mdlab-contrast', '1');
  });

  // Edge labels: label's own rect first, foreignObject div's CSS bg second,
  // diagram canvas colour last (edges without a pill sit on the page).
  svg.querySelectorAll('.edgeLabel').forEach((labelG) => {
    const rect = labelG.querySelector('rect, .label-container');
    let bg = rect ? readFillColor(rect) : null;
    if (!bg) {
      const fo = labelG.querySelector('foreignObject div, foreignObject span');
      if (fo) bg = readComputedBg(fo);
    }
    if (!bg || bg === 'transparent') bg = mdlabEdgeBg();
    paintLabelText(labelG, pickForegroundFor(bg));
    labelG.setAttribute('data-mdlab-contrast', '1');
  });
}

// First shape with a real fill. Order matters — transparent hit-targets layer on top.
function resolveShapeFill(group) {
  const shapes = group.querySelectorAll('rect, polygon, path, circle, ellipse');
  for (const shape of shapes) {
    const c = readFillColor(shape);
    if (c && c !== 'transparent' && c !== 'none') return c;
  }
  return null;
}

// Inline style > attribute > computed style.
function readFillColor(el) {
  const inline = el.style && el.style.fill;
  if (inline) return inline;
  const attr = el.getAttribute('fill');
  if (attr && attr !== 'none') return attr;
  try {
    const cs = getComputedStyle(el).fill;
    if (cs && cs !== 'none') return cs;
  } catch { /* detached nodes */ }
  return null;
}

function readComputedBg(el) {
  try {
    const cs = getComputedStyle(el);
    const c = cs.backgroundColor;
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
  } catch { /* noop */ }
  return null;
}

function paintNodeText(group, fg) {
  group.querySelectorAll('text, tspan').forEach((t) => {
    t.style.setProperty('fill', fg, 'important');
  });
  group.querySelectorAll('foreignObject div, foreignObject span, foreignObject p, .nodeLabel, .label').forEach((d) => {
    d.style.setProperty('color', fg, 'important');
    d.style.setProperty('fill', fg, 'important');
  });
}

function paintLabelText(labelG, fg) {
  labelG.querySelectorAll('text, tspan').forEach((t) => {
    t.style.setProperty('fill', fg, 'important');
  });
  labelG.querySelectorAll('foreignObject div, foreignObject span, foreignObject p').forEach((d) => {
    d.style.setProperty('color', fg, 'important');
    d.style.setProperty('background', 'transparent', 'important');
  });
}

// WCAG relative luminance; pick the neutral with higher contrast.
function pickForegroundFor(color) {
  const rgb = toRgb(color);
  if (!rgb) return MDLAB_LIGHT_FG;
  const L = relativeLuminance(rgb);
  const contrastWithDark  = contrastRatio(L, 0.01316);  // #0f172a
  const contrastWithLight = contrastRatio(L, 0.94230);  // #f8fafc
  return contrastWithDark >= contrastWithLight ? MDLAB_DARK_FG : MDLAB_LIGHT_FG;
}

function relativeLuminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrastRatio(L1, L2) {
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// Parse any CSS color → {r,g,b}. Fast paths for hex + rgb(); canvas fallback
// for named/hsl/oklch/color-mix. Returns null only for truly unparseable input.
let _mdlabColorCanvasCtx = null;
function toRgb(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent' || s.startsWith('url(')) return null;

  // Fast path: hex
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    if (hex.length === 8) { // #rrggbbaa — ignore alpha channel
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  // Fast path: rgb()/rgba()
  const m = s.match(/^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,?\s+?(-?\d+(?:\.\d+)?)\s*,?\s+?(-?\d+(?:\.\d+)?)/)
         || s.match(/^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    return {
      r: Math.max(0, Math.min(255, +m[1] | 0)),
      g: Math.max(0, Math.min(255, +m[2] | 0)),
      b: Math.max(0, Math.min(255, +m[3] | 0)),
    };
  }

  // Universal fallback: let the browser parse it. Covers named colors
  // (aliceblue, tomato, …), hsl(), oklch(), color-mix(), and currentcolor.
  try {
    if (!_mdlabColorCanvasCtx) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      _mdlabColorCanvasCtx = c.getContext('2d', { willReadFrequently: true });
    }
    const ctx = _mdlabColorCanvasCtx;
    if (!ctx) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = s;  // browser silently ignores invalid
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    // If the alpha is 0, the color was invalid or fully transparent.
    if (d[3] === 0 && s !== 'black' && s !== '#000' && s !== '#000000') return null;
    return { r: d[0], g: d[1], b: d[2] };
  } catch { /* canvas blocked (strict CSP, some test envs) */ }
  return null;
}

function attachDiagramControls(el) {
  // Error cards contain their own warning <svg>; don't attach expand control.
  if (el.classList.contains('is-error')) return;
  if (!el.querySelector('svg') || el.querySelector('.diagram-expand')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'diagram-expand';
  btn.setAttribute('aria-label', 'Expand diagram');
  btn.title = 'Expand diagram (opens zoom viewer)';
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Expand</span>`;
  btn.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(el); });
  el.appendChild(btn);
}

function postProcess() {
  preview.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (pre.querySelector('.code-copy')) return;

    // marked emits class="hljs language-<x>" — strip the prefix for display.
    const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
    if (langClass) {
      const lang = langClass.slice('language-'.length);
      if (lang && lang !== 'plaintext' && lang !== 'text') {
        const badge = document.createElement('span');
        badge.className = 'code-lang';
        badge.textContent = lang;
        pre.appendChild(badge);
      }
    }

    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const ok = await copyToClipboard(code.textContent);
      btn.textContent = ok ? 'Copied' : 'Failed';
      btn.classList.toggle('is-copied', ok);
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-copied'); }, 1400);
    });
    pre.appendChild(btn);
  });

  preview.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href) && !href.includes(location.host)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    if (href.startsWith('#') && href.length > 1) {
      a.addEventListener('click', (e) => {
        const id = href.slice(1);
        const target = preview.querySelector(`#${cssEscape(id)}`);
        if (!target) return;
        e.preventDefault();
        scrollPreviewToHeading(target);
      });
    }

    // Relative .md link → in-app navigation, preserving #fragment scroll.
    if (!/^(?:https?:|mailto:|#)/i.test(href) && /\.md(?:#|$)/i.test(href)) {
      const [rawPath, fragment] = href.split('#');
      let filename;
      try {
        filename = decodeURIComponent(rawPath.replace(/^\.\//, '').split('/').pop() || '');
      } catch { filename = rawPath.replace(/^\.\//, '').split('/').pop() || ''; }
      if (filename) {
        a.title = `Open ${filename}`;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const proj = Store.activeProject();
          if (!proj) return;
          const match = Store.filesIn(proj.id).find((f) => f.name.toLowerCase() === filename.toLowerCase());
          if (match) {
            switchToFile(match.id).then(() => {
              if (!fragment) return;
              // Double-rAF waits for render() layout to settle.
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const heading = preview.querySelector(`#${cssEscape(fragment)}`);
                if (heading) scrollPreviewToHeading(heading);
              }));
            }).catch(() => {});
          } else {
            showToast(`File "${filename}" not found in this project`, 'warning');
          }
        });
      }
    }
  });

  // Wrap each top-level table in a scroll container so wide tables scroll
  // horizontally without breaking the natural 100% width of narrow tables.
  // Skip the frontmatter table — it has its own border/radius and the
  // overflow wrapper traps its margin-bottom, producing a visible gap.
  preview.querySelectorAll('table').forEach((t) => {
    if (t.parentElement?.classList.contains('table-wrap')) return;
    if (t.classList.contains('markdown-frontmatter')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });

  let taskIndex = 0;
  preview.querySelectorAll('li.task-list-item input[type="checkbox"]').forEach((cb) => {
    cb.disabled = false;
    cb.removeAttribute('disabled');
    cb.classList.add('task-checkbox');
    cb.dataset.taskIndex = String(taskIndex++);
  });
}

function toggleTaskAtIndex(targetIdx) {
  const src = editor.value;
  const lines = src.split('\n');
  let count = 0;
  const taskRe = /^(\s*[-*+]\s+)\[( |x|X)\](\s)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(taskRe);
    if (!m) continue;
    if (count === targetIdx) {
      const checked = m[2] !== ' ';
      lines[i] = lines[i].replace(taskRe, `$1[${checked ? ' ' : 'x'}]$3`);
      const newVal = lines.join('\n');
      const selStart = editor.selectionStart;
      const selEnd = editor.selectionEnd;
      editor.value = newVal;
      try { editor.selectionStart = selStart; editor.selectionEnd = selEnd; } catch {}
      editor.dispatchEvent(new Event('input'));
      return true;
    }
    count++;
  }
  return false;
}

// ── Table of contents ────────────────────────────────────────────────

const TOC_ACTIVE_THRESHOLD_PX = 88;
// Clears pane__header (40px) plus breathing room.
const TOC_SCROLL_OFFSET_PX = 24;
// Covers late layout shifts (Mermaid/images settling) after a scroll.
const TOC_LOCK_GRACE_MS = 220;

let _tocHeadingsCache = [];
let _tocHeadingTops = [];
let _tocSignature = '';
let _tocActiveId = null;
// While non-null, scroll listeners must not change the active marker.
let _tocScrollLock = null;
let _tocScrollAnimId = 0;
let _tocScrollAbortController = null;
let _tocUpdateQueued = false;

function buildToc() {
  if (!toc || !tocNav) return;

  const headings = Array.from(
    preview.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
  ).filter(h => !h.closest('.footnotes'));

  // Skip the DOM rebuild when the heading set (id + level + text) is identical.
  // Prevents tearing down the outline list on every keystroke that doesn't
  // touch a heading — avoids screen-reader announcement churn and layout work.
  const signature = headings.map(h => `${h.tagName}:${h.id}:${(h.textContent || '').replace(/\s+/g, ' ').trim()}`).join('|');
  if (signature === _tocSignature && _tocHeadingsCache.length) {
    _tocHeadingsCache = headings;
    return;
  }
  _tocSignature = signature;

  // Preserve previous active id across re-renders to avoid flicker while typing.
  const prevActiveId = _tocActiveId;
  _tocHeadingsCache = headings;

  if (!headings.length) {
    // Keep the .toc__indicator alive so CSS transitions persist.
    tocNav.querySelector('.toc__list')?.remove();
    toc.dataset.empty = 'true';
    _tocActiveId = null;
    hideTocIndicator();
    return;
  }
  toc.dataset.empty = 'false';

  // Normalize so the shallowest heading in the doc becomes depth 1.
  const minLevel = Math.min(...headings.map(h => Number(h.tagName[1])));

  const list = document.createElement('ul');
  list.className = 'toc__list';

  for (const h of headings) {
    const level = Number(h.tagName[1]);
    const depth = Math.min(6, level - minLevel + 1);

    const li = document.createElement('li');
    li.className = `toc__item toc__item--l${depth}`;

    const a = document.createElement('a');
    a.className = 'toc__link';
    a.href = `#${h.id}`;
    a.dataset.id = h.id;
    const label = (h.textContent || '').replace(/\s+/g, ' ').trim();
    a.textContent = label;
    a.title = label;

    li.appendChild(a);
    list.appendChild(li);
  }

  // Swap only the <ul>; the .toc__indicator sibling must survive rebuilds.
  const existingList = tocNav.querySelector('.toc__list');
  if (existingList) existingList.replaceWith(list);
  else tocNav.appendChild(list);

  if (prevActiveId && headings.some(h => h.id === prevActiveId)) {
    setActiveTocLink(prevActiveId);
  } else {
    _tocActiveId = null;
  }

  // Re-observe for late layout shifts (Mermaid/KaTeX/images).
  observeTocHeadings();

  scheduleTocActiveUpdate();
}

function scheduleTocActiveUpdate() {
  if (_tocUpdateQueued) return;
  _tocUpdateQueued = true;
  requestAnimationFrame(() => {
    _tocUpdateQueued = false;
    updateActiveTocItem();
  });
}

function rebuildTocHeadingTops() {
  const headings = _tocHeadingsCache;
  const tops = new Array(headings.length);
  if (headings.length && previewWrap) {
    const wrapTop = previewWrap.getBoundingClientRect().top;
    const scrollTop = previewWrap.scrollTop;
    for (let i = 0; i < headings.length; i++) {
      tops[i] = headings[i].getBoundingClientRect().top - wrapTop + scrollTop;
    }
  }
  _tocHeadingTops = tops;
}

function updateActiveTocItem() {
  if (!toc || toc.dataset.empty === 'true' || toc.dataset.collapsed === 'true') return;
  const headings = _tocHeadingsCache;
  if (!headings.length) return;

  if (_tocScrollLock) {
    const stillExists = headings.some(h => h.id === _tocScrollLock.id);
    if (stillExists) {
      if (_tocActiveId !== _tocScrollLock.id) setActiveTocLink(_tocScrollLock.id);
      return;
    }
    _tocScrollLock = null;
  }

  // Heading Y positions are cached (rebuildTocHeadingTops) so we don't
  // thrash layout with per-heading getBoundingClientRect on every scroll frame.
  const tops = _tocHeadingTops;
  if (tops.length !== headings.length) rebuildTocHeadingTops();

  const scrollTop = previewWrap.scrollTop;
  const viewportBottom = scrollTop + previewWrap.clientHeight;
  const threshold = scrollTop + TOC_ACTIVE_THRESHOLD_PX;

  // Binary search for the last heading whose top <= threshold.
  let lo = 0, hi = _tocHeadingTops.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (_tocHeadingTops[mid] <= threshold) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }

  let activeId = idx >= 0 ? headings[idx].id : headings[0].id;

  const atBottom = viewportBottom >= previewWrap.scrollHeight - 4;
  if (atBottom) {
    for (let i = _tocHeadingTops.length - 1; i > idx; i--) {
      if (_tocHeadingTops[i] >= scrollTop && _tocHeadingTops[i] < viewportBottom) {
        activeId = headings[i].id;
        break;
      }
    }
  }

  if (idx < 0 && scrollTop < 4) activeId = null;

  if (activeId === _tocActiveId) return;
  setActiveTocLink(activeId);
}

function setActiveTocLink(id) {
  _tocActiveId = id;
  if (!tocNav) return;
  let activeLink = null;
  tocNav.querySelectorAll('.toc__link').forEach(link => {
    const on = id !== null && link.dataset.id === id;
    link.classList.toggle('is-active', on);
    if (on) {
      link.setAttribute('aria-current', 'location');
      activeLink = link;
    } else if (link.hasAttribute('aria-current')) {
      link.removeAttribute('aria-current');
    }
  });
  positionTocIndicator(activeLink);
  if (activeLink) keepTocLinkVisible(activeLink);
  else hideTocIndicator();
}

// Sum offsetTop through offsetParents up to `ancestor`. Shared by indicator
// positioning and center-follow so both agree on link Y.
function offsetRelativeTo(child, ancestor) {
  let top = 0;
  let el = child;
  while (el && el !== ancestor) {
    top += el.offsetTop;
    el = el.offsetParent;
  }
  return top;
}

// Slide the single .toc__indicator bar to `link` via composited transform
// + height — no per-link border repaints.
function positionTocIndicator(link) {
  if (!tocNav) return;
  const indicator = tocNav.querySelector('.toc__indicator');
  if (!indicator) return;
  if (!link) {
    indicator.classList.remove('is-visible');
    return;
  }
  const top = offsetRelativeTo(link, tocNav);
  indicator.style.transform = `translateY(${top}px)`;
  indicator.style.height = `${link.offsetHeight}px`;
  indicator.classList.add('is-visible');
}

function hideTocIndicator() {
  if (!tocNav) return;
  tocNav.querySelector('.toc__indicator')?.classList.remove('is-visible');
}

// Re-pin indicator + recentre active link. Invoked after resize, outline
// toggle, and any path that invalidates cached offsets.
function resyncTocActiveLink() {
  if (!toc || toc.dataset.empty === 'true') return;
  _tocHeadingTops = [];
  if (!_tocActiveId) return;
  const link = tocNav?.querySelector(`.toc__link[data-id="${cssEscape(_tocActiveId)}"]`);
  if (!link) return;
  positionTocIndicator(link);
  keepTocLinkVisible(link);
}

// Centre-follow: scroll TOC so the active link sits at mid-height, clamped.
// 4px dead-band prevents jitter when scrollspy + follow resolve same frame.
function keepTocLinkVisible(link) {
  if (!tocNav || !link) return;
  const maxScroll = tocNav.scrollHeight - tocNav.clientHeight;
  if (maxScroll <= 1) return;

  const linkTop = offsetRelativeTo(link, tocNav);
  const linkCenter = linkTop + (link.offsetHeight / 2);
  const viewHalf = tocNav.clientHeight / 2;
  const target = Math.max(0, Math.min(maxScroll, linkCenter - viewHalf));

  if (Math.abs(target - tocNav.scrollTop) < 4) return;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  try {
    tocNav.scrollTo({ top: target, behavior: reduceMotion ? 'auto' : 'smooth' });
  } catch {
    tocNav.scrollTop = target;
  }
}

const _elScrollAnimIds = new WeakMap();

function smoothScrollTo(el, top, { duration = 360, signal } = {}) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    const prev = _elScrollAnimIds.get(el);
    if (prev) cancelAnimationFrame(prev);
    _elScrollAnimIds.delete(el);
    el.scrollTop = Math.round(top);
    if (el === previewWrap) _tocScrollAnimId = 0;
    return Promise.resolve();
  }
  const prev = _elScrollAnimIds.get(el);
  if (prev) cancelAnimationFrame(prev);
  if (el === previewWrap) {
    cancelAnimationFrame(_tocScrollAnimId);
    _tocScrollAnimId = 0;
  }
  return new Promise((resolve) => {
    const start = el.scrollTop;
    const distance = Math.round(top) - start;
    if (Math.abs(distance) < 1) { el.scrollTop = Math.round(top); resolve(); return; }
    if (signal?.aborted) { resolve(); return; }

    const startTime = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    const onAbort = () => {
      const id = _elScrollAnimIds.get(el);
      if (id) cancelAnimationFrame(id);
      _elScrollAnimIds.delete(el);
      if (el === previewWrap) _tocScrollAnimId = 0;
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const tick = (now) => {
      if (signal?.aborted) { resolve(); return; }
      const t = Math.min(1, (now - startTime) / duration);
      el.scrollTop = start + distance * ease(t);
      if (t < 1) {
        const id = requestAnimationFrame(tick);
        _elScrollAnimIds.set(el, id);
        if (el === previewWrap) _tocScrollAnimId = id;
      } else {
        el.scrollTop = Math.round(top);
        _elScrollAnimIds.delete(el);
        if (el === previewWrap) _tocScrollAnimId = 0;
        resolve();
      }
    };
    const id = requestAnimationFrame(tick);
    _elScrollAnimIds.set(el, id);
    if (el === previewWrap) _tocScrollAnimId = id;
  });
}

function targetScrollTopForHeading(heading) {
  const wrapTop = previewWrap.getBoundingClientRect().top;
  const headingTop = heading.getBoundingClientRect().top;
  const max = Math.max(0, previewWrap.scrollHeight - previewWrap.clientHeight);
  const desired = previewWrap.scrollTop + headingTop - wrapTop - TOC_SCROLL_OFFSET_PX;
  return Math.max(0, Math.min(max, desired));
}

async function scrollPreviewToHeading(heading, { pinTocLink = null } = {}) {
  if (!heading) return;
  const id = heading.id;
  if (!id) return;

  if (_tocScrollAbortController) _tocScrollAbortController.abort();
  _tocScrollAbortController = new AbortController();
  const { signal } = _tocScrollAbortController;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const target = targetScrollTopForHeading(heading);

// TOC scroll lock: stashes expected scroll position so the preview scroll
// handler can detect user-drift with a single scalar compare per frame.
  if (_tocHeadingsCache.some(h => h.id === id)) {
    _tocScrollLock = { id, expectedTop: target };
    setActiveTocLink(id);
  }

  if (reduceMotion) {
    previewWrap.scrollTop = target;
  } else {
    await smoothScrollTo(previewWrap, target, { duration: 360, signal });
    if (signal.aborted) return;

    // Re-resolve in case the DOM was replaced by a render mid-scroll.
    let liveHeading = heading;
    if (!liveHeading.isConnected) {
      liveHeading = preview.querySelector(`#${cssEscape(id)}`);
      if (!liveHeading) { _tocScrollLock = null; _tocScrollAbortController = null; return; }
    }

    // Layout may have shifted (Mermaid/images settling) — nudge to corrected position.
    const corrected = targetScrollTopForHeading(liveHeading);
    if (_tocScrollLock && _tocScrollLock.id === id) _tocScrollLock.expectedTop = corrected;
    if (Math.abs(corrected - previewWrap.scrollTop) > 2) {
      await smoothScrollTo(previewWrap, corrected, { duration: 180, signal });
      if (signal.aborted) return;
    }
  }

  // Grace period: final snap-correct after any late layout settling.
  setTimeout(() => {
    if (_tocScrollLock?.id !== id) return;
    const live = heading.isConnected ? heading : preview.querySelector(`#${cssEscape(id)}`);
    if (live) {
      const finalTop = targetScrollTopForHeading(live);
      if (Math.abs(finalTop - previewWrap.scrollTop) > 2) {
        previewWrap.scrollTop = finalTop;
      }
    }
    _tocScrollAbortController = null;
  }, TOC_LOCK_GRACE_MS);
}

tocNav?.addEventListener('click', (e) => {
  const link = e.target.closest('.toc__link');
  if (!link) return;
  e.preventDefault();
  const id = link.dataset.id;
  if (!id) return;
  const heading = preview.querySelector(`#${cssEscape(id)}`);
  if (!heading) return;
  try {
    const newUrl = `${location.pathname}${location.search}#${encodeURIComponent(id)}`;
    history.replaceState(history.state, '', newUrl);
  } catch {}
  scrollPreviewToHeading(heading, { pinTocLink: link });
  // On tablet/mobile the drawer covers the preview — close it after a tap so
  // users can actually see the heading they navigated to.
  if (isTocDrawerMode()) {
    applyTocToggle(false, { silent: true });
  }
});

['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((ev) => {
  previewWrap?.addEventListener(ev, () => {
    if (_tocScrollAbortController) {
      _tocScrollAbortController.abort();
      _tocScrollAbortController = null;
    }
    if (_tocScrollLock) {
      _tocScrollLock = null;
    }
  }, { passive: true });
});

function scrollToHashIfAny() {
  const raw = (location.hash || '').slice(1);
  if (!raw) return;
  let hash = raw;
  try { hash = decodeURIComponent(raw); } catch {}
  let tries = 0;
  const attempt = () => {
    const heading = preview?.querySelector(`#${cssEscape(hash)}`);
    if (heading) {
      scrollPreviewToHeading(heading);
      return;
    }
    if (++tries < 20) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
window.addEventListener('hashchange', scrollToHashIfAny);
scrollToHashIfAny();

function applyTocToggle(visible, { silent = false } = {}) {
  if (!toc) return;
  const on = !!visible;
  toc.dataset.collapsed = on ? 'false' : 'true';
  // Mirror state on .panes so CSS can apply --toc-offset and re-center the divider.
  const panes = document.getElementById('panes');
  if (panes) panes.dataset.toc = on ? 'open' : 'closed';
  if (btnToc) {
    btnToc.setAttribute('aria-pressed', String(on));
    btnToc.title = on
      ? 'Outline is on — click to hide (Ctrl/Cmd + L)'
      : 'Outline is off — click to show (Ctrl/Cmd + L)';
    const label = btnToc.querySelector('.pane__toggle-label');
    if (label) label.textContent = on ? 'Outline' : 'Outline off';
  }
  try { localStorage.setItem(TOC_KEY, on ? '1' : '0'); } catch {}
  // Drawer-mode side-effects (scrim, body lock, scroll-into-active). These
  // are no-ops above the 1100px breakpoint — driven entirely by media query.
  updateTocDrawerState(on);
  if (on) {
    // Defer one frame — the panel may still be expanding, so offset
    // reads need fresh layout.
    requestAnimationFrame(resyncTocActiveLink);
    scheduleTocActiveUpdate();
  }
  if (!silent) showToast(on ? 'Outline on' : 'Outline off', 'info');
}

// ─────────────────────────────────────────────────────────────────────
// TOC drawer (≤1100px): slide-in right panel with scrim + ESC-to-close.
// Above 1100px the TOC is an in-flow column and none of this runs.
// ─────────────────────────────────────────────────────────────────────
const TOC_DRAWER_MQ = window.matchMedia('(max-width: 1100px)');

function isTocDrawerMode() {
  return TOC_DRAWER_MQ.matches;
}

function ensureTocScrim() {
  let scrim = document.getElementById('toc-scrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.id = 'toc-scrim';
    scrim.className = 'toc-scrim';
    scrim.addEventListener('click', () => applyTocToggle(false));
    // Prevent rubber-band scrolling of the body through the scrim on iOS.
    scrim.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    document.body.appendChild(scrim);
  }
  return scrim;
}

function updateTocDrawerState(open) {
  if (!toc) return;
  const drawerMode = isTocDrawerMode();
  const scrim = document.getElementById('toc-scrim');
  if (!drawerMode) {
    // Tear down any drawer chrome when resizing back to desktop.
    scrim?.classList.remove('is-open');
    document.body.classList.remove('is-toc-drawer-open');
    return;
  }
  if (open && toc.dataset.empty !== 'true') {
    ensureTocScrim().classList.add('is-open');
    document.body.classList.add('is-toc-drawer-open');
  } else {
    scrim?.classList.remove('is-open');
    document.body.classList.remove('is-toc-drawer-open');
  }
}

// Close the drawer when the viewport crosses back above 1100px, and clean up
// DOM state. Fires on every MQ change (both directions).
TOC_DRAWER_MQ.addEventListener?.('change', () => {
  if (!isTocDrawerMode()) {
    document.getElementById('toc-scrim')?.classList.remove('is-open');
    document.body.classList.remove('is-toc-drawer-open');
  } else {
    // Entering drawer mode: if the saved pref was "on", force it closed so
    // users aren't surprised by a drawer covering their content on rotate.
    if (toc && toc.dataset.collapsed === 'false') {
      applyTocToggle(false, { silent: true });
    }
  }
});

// ESC closes the drawer (only when it's actually the active UI affordance).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!isTocDrawerMode()) return;
  if (!toc || toc.dataset.collapsed === 'true') return;
  // Don't steal ESC from the palette, lightbox, or find-bar.
  const blocker = document.querySelector('.palette.is-open, .lightbox.is-open, .find-bar');
  if (blocker) return;
  applyTocToggle(false);
});

function restoreTocPref() {
  if (!toc) return;
  const raw = localStorage.getItem(TOC_KEY);
  // On drawer-mode breakpoints we always boot closed so the drawer doesn't
  // cover the preview on page load. Saved pref still wins at ≥1101px.
  const desired = raw === null ? true : raw === '1';
  applyTocToggle(isTocDrawerMode() ? false : desired, { silent: true });
}

btnToc?.addEventListener('click', () => {
  const isOn = toc.dataset.collapsed !== 'true';
  applyTocToggle(!isOn);
});
btnTocClose?.addEventListener('click', () => applyTocToggle(false));

// Viewport resize reflows link text — offsetTop/Height shift, so re-sync.
function syncTocOnReflow() {
  resyncTocActiveLink();
  if (toc && toc.dataset.empty !== 'true') scheduleTocActiveUpdate();
}
window.addEventListener('resize', syncTocOnReflow, { passive: true });

// Catch late layout shifts (Mermaid/KaTeX/images) that don't fire scroll.
// Re-observed on every buildToc() to track the current document.
let _tocHeadingObserver = null;
function observeTocHeadings() {
  if (!('IntersectionObserver' in window)) return;
  if (_tocHeadingObserver) {
    _tocHeadingObserver.disconnect();
    _tocHeadingObserver = null;
  }
  if (!_tocHeadingsCache.length) return;
  _tocHeadingObserver = new IntersectionObserver(() => {
    _tocHeadingTops = [];
    scheduleTocActiveUpdate();
  }, { root: previewWrap || null, threshold: [0, 1] });
  for (const h of _tocHeadingsCache) _tocHeadingObserver.observe(h);
}

/**
 * Lightbox: pan + zoom viewer for Mermaid SVGs.
 *
 * Zoom writes width/height ATTRIBUTES on the SVG (not CSS scale), so
 * the browser re-rasterizes at each level — labels stay crisp, incl.
 * HTML inside <foreignObject>. Pan uses a translate() transform.
 * `scale=1` means the SVG's natural pixel size ("100%" label).
 */
const LB_PAD        = 90;    // stage-edge padding in fit calc
const LB_MAX_FIT    = 4;     // cap so small diagrams don't balloon
const LB_ZOOM_STEP  = 1.2;   // button / keyboard zoom factor
const LB_ARROW_PAN  = 60;    // px per arrow-key press
const LB_HINT_MS    = 3200;  // hint auto-hide delay

const lightbox = {
  root:   document.getElementById('lightbox'),
  stage:  document.getElementById('lightbox-stage'),
  canvas: document.getElementById('lightbox-canvas'),
  zoomLbl:document.getElementById('lightbox-zoom'),
  scale: 1, tx: 0, ty: 0,
  minScale: 0.1, maxScale: 8,
  sourceTitle: '',
  renderSize: { w: 0, h: 0 }, // natural SVG pixel size (from viewBox)
};

const clampScale = (s) => Math.max(lightbox.minScale, Math.min(lightbox.maxScale, s));

// Read the SVG's natural bounds. Falls back to its rendered box when the
// diagram has no viewBox (rare — custom / hand-authored SVG).
function readNaturalSize(svg) {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) {
    return { w: vb.width, h: vb.height, hasViewBox: true };
  }
  const rect = svg.getBoundingClientRect();
  return { w: rect.width || 800, h: rect.height || 600, hasViewBox: false };
}

function applyLightboxTransform() {
  const svg = lightbox.canvas.querySelector('svg');
  if (!svg || !lightbox.renderSize.w) return;
  // Attribute writes force a vector re-render at the new resolution.
  svg.setAttribute('width',  String(lightbox.renderSize.w * lightbox.scale));
  svg.setAttribute('height', String(lightbox.renderSize.h * lightbox.scale));
  lightbox.canvas.style.transform =
    `translate(-50%, -50%) translate(${lightbox.tx}px, ${lightbox.ty}px)`;
  lightbox.zoomLbl.textContent = Math.round(lightbox.scale * 100) + '%';
}

// Fit to stage and reset pan. Re-derives from current stage size each call
// so window resize + 'reset' both route through here.
function fitLightbox() {
  if (!lightbox.renderSize.w) return;
  const { width, height } = lightbox.stage.getBoundingClientRect();
  const fit = Math.min(
    (width  - LB_PAD) / lightbox.renderSize.w,
    (height - LB_PAD) / lightbox.renderSize.h,
    LB_MAX_FIT
  );
  lightbox.scale = fit > 0 ? fit : 1;
  lightbox.tx = lightbox.ty = 0;
  applyLightboxTransform();
}

// Clone `svg` into the canvas and record its natural pixel size. Strips
// inline sizing so our zoom attribute writes fully own width/height.
function mountLightboxSvg(svg) {
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style');
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  const { w, h, hasViewBox } = readNaturalSize(svg);
  if (!hasViewBox) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  lightbox.renderSize = { w, h };
  lightbox.canvas.innerHTML = '';
  lightbox.canvas.appendChild(clone);
}

function openLightbox(mermaidEl) {
  const svg = mermaidEl.querySelector('svg');
  if (!svg || !lightbox.root) return;
  mountLightboxSvg(svg);
  lightbox.sourceTitle = mermaidEl.id || 'diagram';
  // Keep a live ref; rethemeMermaid swaps innerHTML inside this element.
  lightbox._sourceEl = mermaidEl;
  lightbox.root.classList.add('is-open');
  document.body.style.overflow = 'hidden';
  lightbox._returnFocusTo = document.activeElement;
  installFocusTrap(lightbox.root);
  setTimeout(() => document.getElementById('lightbox-close')?.focus(), 10);

  fitLightbox();
  showLightboxHint();
}

function closeLightbox() {
  lightbox.root.classList.remove('is-open');
  lightbox.canvas.innerHTML = '';
  lightbox.renderSize = { w: 0, h: 0 };
  lightbox._sourceEl = null;
  document.body.style.overflow = '';
  releaseFocusTrap(lightbox.root);
  const prev = lightbox._returnFocusTo;
  lightbox._returnFocusTo = null;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
}

// Re-mount the freshly themed SVG from the source element, preserving pan/zoom.
function refreshLightboxSvg() {
  const src = lightbox._sourceEl;
  if (!src || !lightbox.root?.classList.contains('is-open')) return;
  const svg = src.querySelector('svg');
  if (!svg) return;
  mountLightboxSvg(svg);
  applyLightboxTransform();
}

// Theme toggle from inside the lightbox. Awaits rethemeMermaid so the
// clone swap lands on the repainted SVG; scale/pan are preserved.
async function toggleLightboxTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next, true);
  try {
    await rethemeMermaid();
  } catch (err) {
    console.warn('Lightbox theme re-render error:', err);
  }
  refreshLightboxSvg();
}

// Shared modal focus trap lives in overlays.js (installFocusTrap /
// releaseFocusTrap). Lightbox + Shortcuts + About all share it.

let lightboxHintTimer;
function showLightboxHint() {
  const hints = document.querySelectorAll('.lightbox__hint');
  if (!hints.length) return;
  hints.forEach(h => h.classList.add('is-show'));
  clearTimeout(lightboxHintTimer);
  lightboxHintTimer = setTimeout(() => hints.forEach(h => h.classList.remove('is-show')), LB_HINT_MS);
}

// Cursor-focused zoom: the point at (cx, cy) stays fixed as we scale.
function zoomBy(factor, cx, cy) {
  const next = clampScale(lightbox.scale * factor);
  if (next === lightbox.scale) return;
  if (cx !== undefined && cy !== undefined) {
    const r = lightbox.stage.getBoundingClientRect();
    const ax = cx - r.left - r.width  / 2;
    const ay = cy - r.top  - r.height / 2;
    const k  = next / lightbox.scale;
    lightbox.tx = ax - (ax - lightbox.tx) * k;
    lightbox.ty = ay - (ay - lightbox.ty) * k;
  }
  lightbox.scale = next;
  applyLightboxTransform();
}

document.querySelectorAll('[data-zoom]').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.zoom;
    if (k === 'in')         zoomBy(LB_ZOOM_STEP);
    else if (k === 'out')   zoomBy(1 / LB_ZOOM_STEP);
    else if (k === 'reset') fitLightbox();
  });
});
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-theme')?.addEventListener('click', () => { toggleLightboxTheme(); });
document.getElementById('lightbox-download').addEventListener('click', async () => {
  const svg = lightbox.canvas.querySelector('svg');
  if (!svg) return;
  const name = (lightbox.sourceTitle || 'diagram').replace(/\.(svg|png)$/i, '');
  // downloadSvgAsPng sizes from viewBox (never touched by zoom), so the
  // export is always the full diagram at native resolution.
  try {
    await downloadSvgAsPng(svg, `${name}.png`);
    showToast('PNG downloaded', 'success');
  } catch (err) {
    console.error('PNG export failed', err);
    showToast('PNG export failed', 'error');
  }
});

// Copy computed paint styles from live SVG onto clone as inline attributes.
// Needed because the clone is rasterized via <img>, which has no CSS context
// and can't resolve our CSS variables or Mermaid's <style> rules.
const SVG_PAINT_PROPS = [
  'fill', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin',
  'opacity', 'color',
  'font-size', 'font-weight', 'font-style', 'font-family',
  'text-anchor', 'dominant-baseline',
];
function inlineComputedStyles(liveRoot, cloneRoot) {
  const liveWalker = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT);
  const cloneWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);
  let live = liveWalker.nextNode();
  let cln  = cloneWalker.nextNode();
  while (live && cln) {
    if (live.namespaceURI === 'http://www.w3.org/2000/svg') {
      const cs = getComputedStyle(live);
      for (const prop of SVG_PAINT_PROPS) {
        const value = cs.getPropertyValue(prop);
        if (!value) continue;
        if (value === 'none' && (prop === 'fill' || prop === 'stroke')) {
          cln.setAttribute(prop, 'none');
          continue;
        }
        if (value === 'rgba(0, 0, 0, 0)' || value === 'transparent') continue;
        if (value === 'normal' || value === 'auto') continue;
        cln.setAttribute(prop, value.trim());
      }
    }
    live = liveWalker.nextNode();
    cln  = cloneWalker.nextNode();
  }
}

// SVG → 2× PNG. Handles: <foreignObject> (replaced with native <text> —
// no browser rasterizes FO via <img>); class-based <style> (inlined as
// computed paint styles); multi-byte chars (TextEncoder + chunked btoa).
function bytesToBinaryString(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

async function downloadSvgAsPng(svg, filename) {
  const vb = svg.viewBox?.baseVal;
  const rect = svg.getBoundingClientRect();
  const innerW = Math.ceil(vb?.width  || rect.width  || 800);
  const innerH = Math.ceil(vb?.height || rect.height || 600);
  const pad = 48;
  const w = innerW + pad * 2;
  const h = innerH + pad * 2;
  const scale = 2;

  // Build a fresh root with a predictable viewBox and translated inner group.
  // Mutating the original viewBox was unreliable — negative-origin viewBoxes
  // (some Mermaid charts) pushed content off-canvas.
  const svgNS = 'http://www.w3.org/2000/svg';
  const clone = document.createElementNS(svgNS, 'svg');
  clone.setAttribute('xmlns', svgNS);
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width',  String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const bg = theme === 'dark' ? '#141824' : '#ffffff';
  const bgRect = document.createElementNS(svgNS, 'rect');
  bgRect.setAttribute('x', '0'); bgRect.setAttribute('y', '0');
  bgRect.setAttribute('width',  String(w));
  bgRect.setAttribute('height', String(h));
  bgRect.setAttribute('fill', bg);
  clone.appendChild(bgRect);

  const styleEl = document.createElementNS(svgNS, 'style');
  styleEl.textContent = `text, tspan { font-family: 'Inter', system-ui, -apple-system, sans-serif; }`;
  clone.appendChild(styleEl);

  const vbX = vb ? vb.x : 0;
  const vbY = vb ? vb.y : 0;
  const inner = document.createElementNS(svgNS, 'g');
  inner.setAttribute('transform', `translate(${pad - vbX}, ${pad - vbY})`);
  Array.from(svg.childNodes).forEach(n => inner.appendChild(n.cloneNode(true)));
  clone.appendChild(inner);

  inlineComputedStyles(svg, inner);

  const liveForeigns = Array.from(svg.querySelectorAll('foreignObject'));
  const clonedForeigns = Array.from(inner.querySelectorAll('foreignObject'));
  clonedForeigns.forEach((fo, idx) => {
    const liveFo = liveForeigns[idx];
    if (!liveFo) { fo.remove(); return; }
    const div = liveFo.querySelector(':scope > div') || liveFo.firstElementChild;
    const cs = div ? getComputedStyle(div) : null;
    const color = cs?.color || '#111827';
    const fontSize = cs ? parseFloat(cs.fontSize) : 14;
    const fontWeight = cs?.fontWeight || '500';
    const rawText = (div?.innerText || liveFo.textContent || '').replace(/\s+$/, '');
    if (!rawText.trim()) { fo.remove(); return; }
    const lines = rawText.split(/\n+/).map(s => s.trim()).filter(Boolean);

    const foX = parseFloat(fo.getAttribute('x')) || 0;
    const foY = parseFloat(fo.getAttribute('y')) || 0;
    const foW = parseFloat(fo.getAttribute('width'))  || 100;
    const foH = parseFloat(fo.getAttribute('height')) || 20;

    const textEl = document.createElementNS(svgNS, 'text');
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('fill', color);
    textEl.setAttribute('font-size', String(fontSize));
    textEl.setAttribute('font-weight', fontWeight);
    textEl.setAttribute('font-family', 'Inter, system-ui, -apple-system, sans-serif');
    const lineHeight = fontSize * 1.2;
    const totalH = lineHeight * lines.length;
    const firstBaseline = foY + (foH - totalH) / 2 + fontSize;
    lines.forEach((ln, i) => {
      const tspan = document.createElementNS(svgNS, 'tspan');
      tspan.setAttribute('x', String(foX + foW / 2));
      tspan.setAttribute('y', String(firstBaseline + i * lineHeight));
      tspan.textContent = ln;
      textEl.appendChild(tspan);
    });
    fo.parentNode.replaceChild(textEl, fo);
  });

  const xml = new XMLSerializer().serializeToString(clone);
  const loadImg = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload  = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });

  let img;
  const blobUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    img = await loadImg(blobUrl);
  } catch {
    try {
      const b64 = typeof btoa === 'function' ? btoa(bytesToBinaryString(new TextEncoder().encode(xml))) : null;
      if (!b64) throw new Error('Cannot base64-encode SVG');
      img = await loadImg(`data:image/svg+xml;base64,${b64}`);
    } catch (e) {
      URL.revokeObjectURL(blobUrl);
      throw new Error('Browser could not load the SVG for rasterization: ' + (e?.message || e));
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width  = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(blobUrl);

  let pngBlob = await new Promise((resolve) => {
    try { canvas.toBlob(resolve, 'image/png'); } catch { resolve(null); }
  });
  if (!pngBlob) {
    const dataUrl = canvas.toDataURL('image/png');
    const bin = atob(dataUrl.split(',')[1]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    pngBlob = new Blob([buf], { type: 'image/png' });
  }
  const pngUrl = URL.createObjectURL(pngBlob);
  const a = document.createElement('a');
  a.href = pngUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(pngUrl), 1500);
}

lightbox.root.addEventListener('click', (e) => {
  if (e.target === lightbox.root) closeLightbox();
});

lightbox.stage.addEventListener('dblclick', fitLightbox);

// Wheel zoom. Normalizes mouse wheels (discrete ticks) and trackpad pinch
// (continuous, fires with ctrlKey). Exponential mapping keeps in/out
// symmetric; per-event step clamped to ±15% to tame buffered bursts.
{
  lightbox.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1)      dy *= 16;   // lines → px
    else if (e.deltaMode === 2) dy *= 400;  // pages → px
    const sensitivity = e.ctrlKey ? 0.01 : 0.0007;
    const step = Math.max(-0.15, Math.min(0.15, -dy * sensitivity));
    zoomBy(Math.exp(step), e.clientX, e.clientY);
  }, { passive: false });
}

// Two-finger pinch-zoom. Midpoint stays under the fingers; finger drag
// during the pinch translates the view.
{
  let pinching = false;
  let initDist = 0, initScale = 1;
  let initMidX = 0, initMidY = 0;
  let initTx = 0, initTy = 0;

  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  lightbox.stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    pinching = true;
    const [a, b] = e.touches;
    initDist  = dist(a, b) || 1;
    initScale = lightbox.scale;
    const m   = mid(a, b);
    initMidX  = m.x; initMidY = m.y;
    initTx    = lightbox.tx; initTy = lightbox.ty;
  }, { passive: false });

  lightbox.stage.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const m = mid(a, b);
    const next = clampScale(initScale * ((dist(a, b) || 1) / initDist));

    const r  = lightbox.stage.getBoundingClientRect();
    const ax = initMidX - r.left - r.width  / 2;
    const ay = initMidY - r.top  - r.height / 2;
    const k  = next / initScale;
    lightbox.tx = ax - (ax - initTx) * k + (m.x - initMidX);
    lightbox.ty = ay - (ay - initTy) * k + (m.y - initMidY);
    lightbox.scale = next;
    applyLightboxTransform();
  }, { passive: false });

  const endPinch = () => { pinching = false; };
  lightbox.stage.addEventListener('touchend', (e) => {
    if (pinching && e.touches.length < 2) endPinch();
  });
  lightbox.stage.addEventListener('touchcancel', endPinch);

  // Exposed so the pointer pan handler can yield during a pinch.
  lightbox._isPinching = () => pinching;
}

// Pointer-based pan. Yields to pinch when the touch handler claims the gesture.
{
  let panning = false, pointerId = 0;
  let startX = 0, startY = 0, startTx = 0, startTy = 0;

  lightbox.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || lightbox._isPinching()) return;
    panning = true;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    startTx = lightbox.tx; startTy = lightbox.ty;
    try { lightbox.stage.setPointerCapture(pointerId); } catch {}
    lightbox.stage.style.cursor = 'grabbing';
  });
  lightbox.stage.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== pointerId || lightbox._isPinching()) return;
    lightbox.tx = startTx + (e.clientX - startX);
    lightbox.ty = startTy + (e.clientY - startY);
    applyLightboxTransform();
  });
  const endPan = (e) => {
    if (!panning || (e && e.pointerId !== pointerId)) return;
    panning = false;
    try { lightbox.stage.releasePointerCapture(pointerId); } catch {}
    lightbox.stage.style.cursor = '';
  };
  lightbox.stage.addEventListener('pointerup', endPan);
  lightbox.stage.addEventListener('pointercancel', endPan);
  // Release the pan if focus leaves mid-drag (alt-tab, etc).
  window.addEventListener('blur', () => {
    if (panning) { panning = false; lightbox.stage.style.cursor = ''; }
  });
}

document.addEventListener('keydown', (e) => {
  if (!lightbox.root.classList.contains('is-open')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); return; }

  const nudge = (dx, dy) => {
    lightbox.tx += dx; lightbox.ty += dy;
    applyLightboxTransform();
  };
  switch (e.key) {
    case '+': case '=': e.preventDefault(); zoomBy(LB_ZOOM_STEP); break;
    case '-': case '_': e.preventDefault(); zoomBy(1 / LB_ZOOM_STEP); break;
    case '0':           e.preventDefault(); fitLightbox(); break;
    case 'ArrowLeft':   e.preventDefault(); nudge( LB_ARROW_PAN, 0); break;
    case 'ArrowRight':  e.preventDefault(); nudge(-LB_ARROW_PAN, 0); break;
    case 'ArrowUp':     e.preventDefault(); nudge(0,  LB_ARROW_PAN); break;
    case 'ArrowDown':   e.preventDefault(); nudge(0, -LB_ARROW_PAN); break;
  }
});

window.addEventListener('resize', () => {
  if (lightbox.root.classList.contains('is-open')) fitLightbox();
  syncEditorMirror();
  scheduleAnchorRebuild();
  scheduleTocActiveUpdate();
});

preview.addEventListener('click', (e) => {
  const cb = e.target.closest('input.task-checkbox[type="checkbox"]');
  if (!cb) return;
  const idx = Number(cb.dataset.taskIndex);
  if (Number.isNaN(idx)) return;
  e.preventDefault();
  toggleTaskAtIndex(idx);
});

// Adaptive debounce. Size thresholds: 8K/40K/80K → 90/140/220/320 ms.
// Mermaid penalty: +80 ms at 6+ diagrams, +160 ms total at 16+.
let _renderTimer = 0;
function scheduleRender() {
  const src = editor.value;
  const size = src.length;
  const mermaidBlocks = (size > 4096) ? countMermaidFences(src) : 0;
  let delay;
  if (size < 8 * 1024)       delay = 90;
  else if (size < 40 * 1024) delay = 140;
  else if (size < 80 * 1024) delay = 220;
  else                       delay = 320;
  if (mermaidBlocks >= 6) delay += 80;
  if (mermaidBlocks >= 16) delay += 80;
  if (_renderTimer) clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => { _renderTimer = 0; render(); }, delay);
}

function countMermaidFences(src) {
  let count = 0;
  let idx = 0;
  while ((idx = src.indexOf('```mermaid', idx)) !== -1) { count++; idx += 10; }
  return count;
}

// rAF-coalesced gutter update. Keeps the `input` handler non-blocking;
// updateGutter rebuilds the mirror and forces layout on large docs.
let _gutterRafId = 0;
function scheduleGutterUpdate() {
  if (_gutterRafId) return;
  _gutterRafId = requestAnimationFrame(() => {
    _gutterRafId = 0;
    updateGutter();
  });
}

editor.addEventListener('input', () => {
  scheduleGutterUpdate();
  scheduleRender();
});

// Editor key dispatcher — Cmd/Ctrl+B/I/K formatting, Tab/Shift+Tab list
// indent, Enter list continuation. Each handler issues one value-swap +
// a synthetic `input` event so render + persist run as if typed.
editor.addEventListener('keydown', (e) => {
  const modKey = e.metaKey || e.ctrlKey;

  if (modKey && !e.altKey) {
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); wrapSelection('**', '**'); return; }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); wrapSelection('_', '_'); return; }
    // Cmd+K → insert link (editor-owned). Cmd+Shift+K falls through to
    // the global theme-toggle shortcut.
    if (e.key === 'k' || e.key === 'K') {
      if (e.shiftKey) return;
      e.preventDefault(); insertLink(); return;
    }
  }

  if (e.key === 'Tab' && !modKey) {
    e.preventDefault();
    if (e.shiftKey) outdentSelection();
    else indentSelection();
    return;
  }

  if (e.key === 'Enter' && !modKey && !e.shiftKey) {
    if (maybeContinueList(e)) return;
  }
});

function replaceEditorRange(rangeStart, rangeEnd, newText) {
  editor.focus();
  editor.selectionStart = rangeStart;
  editor.selectionEnd = rangeEnd;
  try {
    if (document.execCommand('insertText', false, newText)) return true;
  } catch {}
  const v = editor.value;
  editor.value = v.slice(0, rangeStart) + newText + v.slice(rangeEnd);
  return false;
}

// Toggle-wrap selection with `left`/`right` markers. Empty selection leaves
// the cursor between the markers; an already-wrapped selection is unwrapped.
function wrapSelection(left, right) {
  const s = editor.selectionStart, ee = editor.selectionEnd;
  const v = editor.value;
  const sel = v.slice(s, ee);
  const before = v.slice(s - left.length, s);
  const after = v.slice(ee, ee + right.length);
  let execUsed;
  if (before === left && after === right) {
    execUsed = replaceEditorRange(s - left.length, ee + right.length, sel);
    editor.selectionStart = s - left.length;
    editor.selectionEnd = ee - left.length;
  } else {
    execUsed = replaceEditorRange(s, ee, left + sel + right);
    if (sel) {
      editor.selectionStart = s + left.length;
      editor.selectionEnd = ee + left.length;
    } else {
      editor.selectionStart = editor.selectionEnd = s + left.length;
    }
  }
  if (!execUsed) editor.dispatchEvent(new Event('input'));
}

// Insert `[label](url)`. Selection becomes the label; `url` is pre-selected
// for immediate paste. Empty selection inserts `[text](url)` with `text`
// pre-selected.
function insertLink() {
  const s = editor.selectionStart, ee = editor.selectionEnd;
  const v = editor.value;
  const sel = v.slice(s, ee);
  let execUsed;
  if (sel) {
    const snippet = `[${sel}](url)`;
    execUsed = replaceEditorRange(s, ee, snippet);
    const urlStart = s + sel.length + 3; // after `[${sel}](`
    editor.selectionStart = urlStart;
    editor.selectionEnd = urlStart + 3;
  } else {
    const snippet = `[text](url)`;
    execUsed = replaceEditorRange(s, ee, snippet);
    editor.selectionStart = s + 1;
    editor.selectionEnd = s + 5;
  }
  if (!execUsed) editor.dispatchEvent(new Event('input'));
}

// Add 2 spaces at the start of every line the selection touches.
function indentSelection() {
  const s = editor.selectionStart, ee = editor.selectionEnd;
  const v = editor.value;
  let execUsed;
  if (s === ee) {
    execUsed = replaceEditorRange(s, s, '  ');
    editor.selectionStart = editor.selectionEnd = s + 2;
  } else {
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const block = v.slice(lineStart, ee);
    const indented = block.replace(/^/gm, '  ');
    execUsed = replaceEditorRange(lineStart, ee, indented);
    const delta = indented.length - block.length;
    editor.selectionStart = s + 2;
    editor.selectionEnd = ee + delta;
  }
  if (!execUsed) editor.dispatchEvent(new Event('input'));
}

// Remove up to 2 leading spaces (or 1 tab) from every line the selection
// touches. Lines with no leading whitespace are left alone.
function outdentSelection() {
  const s = editor.selectionStart, ee = editor.selectionEnd;
  const v = editor.value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const block = v.slice(lineStart, ee);
  let removedOnFirstLine = 0;
  let totalRemoved = 0;
  const outdented = block.replace(/^(\t| {1,2})/gm, (match, _g, offset) => {
    totalRemoved += match.length;
    if (offset === 0) removedOnFirstLine = match.length;
    return '';
  });
  if (totalRemoved === 0) return;
  const execUsed = replaceEditorRange(lineStart, ee, outdented);
  editor.selectionStart = Math.max(lineStart, s - removedOnFirstLine);
  editor.selectionEnd = Math.max(editor.selectionStart, ee - totalRemoved);
  if (!execUsed) editor.dispatchEvent(new Event('input'));
}

// Continue the current list on Enter, or exit if the current item is
// empty. Returns true when handled.
function maybeContinueList(e) {
  const s = editor.selectionStart, ee = editor.selectionEnd;
  if (s !== ee) return false;
  const v = editor.value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const line = v.slice(lineStart, s);
  const match = line.match(/^(\s*)([-*+]|(\d+)\.)(\s+)(.*)$/);
  if (!match) return false;
  const [, indent, marker, num, ws, rest] = match;
  const hasCursorContent = rest.length > 0 || v.slice(s, v.indexOf('\n', s) === -1 ? v.length : v.indexOf('\n', s)).length > 0;
  if (!rest.trim() && !hasCursorContent) {
    // Empty list item — strip the marker so Enter exits the list.
    e.preventDefault();
    const execUsed = replaceEditorRange(lineStart, s, '');
    editor.selectionStart = editor.selectionEnd = lineStart;
    if (!execUsed) editor.dispatchEvent(new Event('input'));
    return true;
  }
  e.preventDefault();
  const nextMarker = num ? `${Number(num) + 1}.` : marker;
  const insert = `\n${indent}${nextMarker}${ws}`;
  const execUsed = replaceEditorRange(s, ee, insert);
  editor.selectionStart = editor.selectionEnd = s + insert.length;
  if (!execUsed) editor.dispatchEvent(new Event('input'));
  return true;
}

/**
 * Scroll sync — editor ↔ preview.
 *
 * Two coordinate systems meet at "source line number":
 *   · Editor: a hidden mirror <div> (same font/padding/wrap as the
 *     textarea) gives real wrapped-line Y offsets in `lineTops[]`.
 *   · Preview: `anchorMap` pairs each top-level child's offsetTop with
 *     the source line its block starts on.
 * On scroll, find the visible source line on one side and interpolate
 * the corresponding scrollTop on the other.
 */

let scrollSyncEnabled = true;
let scrollOwner = null;       // 'editor' | 'preview' | null — programmatic write lockout
let scrollReleaseTimer = 0;
// Programmatic-scroll echo lockout (ms). Matches VS Code's markdown preview.
const SCROLL_LOCKOUT_MS = 50;
function takeScroll(owner) {
  scrollOwner = owner;
  clearTimeout(scrollReleaseTimer);
  scrollReleaseTimer = setTimeout(() => { scrollOwner = null; }, SCROLL_LOCKOUT_MS);
}

let sourceBlockLines = [];
let anchorMap = [];

// 0-indexed start line of every top-level block in the source. Adjacent
// paragraphs separated by a blank line → separate blocks. Fenced code
// and $$…$$ block math are atomic — matches marked's 1:1 emission
// (extractMath collapses each block-math region to one paragraph).
function computeSourceBlockLines(src) {
  const lines = src.split('\n');
  const starts = [];
  let i = 0;

  const isBlank = (s) => s === undefined || s.trim() === '';
  const listMarker = /^(\s*)([-*+]|(\d+)[.)])(\s+)/;
  const blockquoteStart = /^\s{0,3}>/;
  const htmlBlockOpen = /^\s{0,3}<([a-zA-Z][a-zA-Z0-9-]*)(\s|>|\/>)/;
  const htmlBlockClose = (tag) => new RegExp(`</${tag}\\s*>`, 'i');

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fm = line.match(/^\s{0,3}([`~]{3,})/);
    if (fm) {
      starts.push(i);
      const fenceChar = fm[1][0];
      const fenceLen = fm[1].length;
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^\s{0,3}([`~]{3,})\s*$/);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) { i++; break; }
        i++;
      }
      continue;
    }

    if (/^\s*\$\$/.test(line)) {
      starts.push(i);
      const rest = line.trim().slice(2);
      if (rest.includes('$$')) { i++; continue; }
      i++;
      while (i < lines.length) {
        if (lines[i].includes('$$')) { i++; break; }
        i++;
      }
      continue;
    }

    if (/^\[\^[^\]]+\]:/.test(line)) {
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (isBlank(next)) {
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && /^(?: {2,}|\t)/.test(lines[j])) { i = j; continue; }
          break;
        }
        if (/^(?: {2,}|\t)/.test(next)) { i++; continue; }
        break;
      }
      continue;
    }

    const listHead = line.match(listMarker);
    if (listHead) {
      starts.push(i);
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (isBlank(next)) {
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j >= lines.length) break;
          const follow = lines[j];
          if (listMarker.test(follow) || /^(?: {2,}|\t)/.test(follow)) {
            i = j;
            continue;
          }
          break;
        }
        if (listMarker.test(next) || /^(?: {2,}|\t)/.test(next) || !isBlank(next)) { i++; continue; }
        break;
      }
      continue;
    }

    if (blockquoteStart.test(line)) {
      starts.push(i);
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (isBlank(next)) {
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && blockquoteStart.test(lines[j])) { i = j; continue; }
          break;
        }
        i++;
      }
      continue;
    }

    const htmlOpen = line.match(htmlBlockOpen);
    if (htmlOpen) {
      starts.push(i);
      const tag = htmlOpen[1];
      const closeRe = htmlBlockClose(tag);
      if (closeRe.test(line)) { i++; continue; }
      i++;
      while (i < lines.length) {
        if (closeRe.test(lines[i])) { i++; break; }
        if (isBlank(lines[i])) {
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j >= lines.length) break;
          if (!lines[j].trim().startsWith('<')) break;
          i = j;
          continue;
        }
        i++;
      }
      continue;
    }

    starts.push(i);
    i++;
    while (i < lines.length && !isBlank(lines[i])) i++;
  }
  return starts;
}

// lineTops[i] = pixel Y of source line i. Measured against the mirror, which
// shares the textarea's top-left and padding via .editor__surface.
let lineTops = [0];
let mirrorTotalHeight = 0;
let _editorPadTop = 16;
// Last mirror snapshot; paired with editorMirror.children for incremental diff.
let _mirrorLines = null;
let _mirrorWidth = -1;

function syncEditorMirror() {
  if (!editorMirror) return;
  // When the editor pane is collapsed (preview-only view) its clientWidth is
  // 0, which makes every mirror line wrap at column 0 and lineTops[] fills
  // with zeros — meaning the gutter stacks every number at the top. Bail
  // here so the current (valid) measurements stay intact; the view-switch
  // code will call us again once the editor becomes visible.
  const w = editor.clientWidth;
  if (w <= 0) return;

  const lines = editor.value.split('\n');

  // Incremental path requires unchanged width + valid snapshot + matching child count.
  const widthUnchanged = w === _mirrorWidth;
  const childCountMatches =
    _mirrorLines !== null &&
    editorMirror.children.length === _mirrorLines.length;

  if (widthUnchanged && childCountMatches) {
    syncEditorMirrorIncremental(lines);
  } else {
    syncEditorMirrorFull(lines, w);
  }
}

// Full rebuild — used on width change, file switch, or first paint.
function syncEditorMirrorFull(lines, w) {
  editorMirror.style.width = `${w}px`;
  _editorPadTop = parseFloat(getComputedStyle(editor).paddingTop) || 16;

  // One <div> per source line. Empty lines get a ZWSP so their line-box
  // has real height.
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const div = document.createElement('div');
    div.textContent = lines[i] === '' ? '​' : lines[i];
    frag.appendChild(div);
  }
  editorMirror.replaceChildren(frag);

  const kids = editorMirror.children;
  const tops = new Array(kids.length);
  for (let i = 0; i < kids.length; i++) tops[i] = kids[i].offsetTop;
  lineTops = tops;
  mirrorTotalHeight = editorMirror.offsetHeight;
  _mirrorLines = lines.slice();
  _mirrorWidth = w;
  // Use transform helper (not syncEditorMirrorScroll) — this is a rebuild, not a scroll.
  writeEditorMirrorTransform();
  if (isFindBarOpen()) {
    const q = document.getElementById('find-input')?.value || '';
    const re = q ? buildFindRegex(q) : null;
    if (re) _findState.editorMarks = highlightInEditorMirror(re);
    const active = _findState.editorMarks?.[_findState.index];
    if (active) active.classList.add('editor-hl--active');
  }
}

// Incremental rebuild — only touches divs whose source line actually changed.
// Preserves .editor-hl spans on unchanged lines so find-bar highlights survive typing.
function syncEditorMirrorIncremental(lines) {
  const oldLines = _mirrorLines;
  const n = Math.min(oldLines.length, lines.length);

  let p = 0;
  while (p < n && oldLines[p] === lines[p]) p++;

  let oq = oldLines.length;
  let nq = lines.length;
  while (oq > p && nq > p && oldLines[oq - 1] === lines[nq - 1]) {
    oq--; nq--;
  }

  if (p === oq && p === nq) return;

  const kids = editorMirror.children;

  // Overwrite text content on the overlap [p, min(oq, nq)).
  const overlapEnd = Math.min(oq, nq);
  for (let i = p; i < overlapEnd; i++) {
    const text = lines[i];
    kids[i].textContent = text === '' ? '​' : text;
  }

  // Remove surplus trailing divs when old range is longer than new.
  for (let i = oq - 1; i >= nq; i--) {
    kids[i].remove();
  }

  // Append/insert new divs when the new range is longer.
  if (nq > oq) {
    const frag = document.createDocumentFragment();
    for (let i = oq; i < nq; i++) {
      const div = document.createElement('div');
      div.textContent = lines[i] === '' ? '​' : lines[i];
      frag.appendChild(div);
    }
    const anchor = editorMirror.children[oq] || null;
    if (anchor) editorMirror.insertBefore(frag, anchor);
    else editorMirror.appendChild(frag);
  }

  _mirrorLines = lines.slice();

  // Skip the O(N) offsetTop re-read when we can prove lineTops haven't moved:
  // single-line edit, no add/remove, neither old nor new text can wrap (length
  // within ASCII no-wrap budget). Any non-ASCII char falls through to re-measure.
  const childCount = editorMirror.children.length;
  const singleLineEdit = oq === nq && p + 1 === overlapEnd;
  let skipMeasure = false;
  if (singleLineEdit) {
    const threshold = noWrapCharBudget();
    if (threshold > 0) {
      const oldText = oldLines[p];
      const newText = lines[p];
      if (oldText.length <= threshold && newText.length <= threshold &&
          isPlainAscii(oldText) && isPlainAscii(newText)) {
        skipMeasure = true;
      }
    }
  }

  if (!skipMeasure) {
    const tops = new Array(childCount);
    for (let i = 0; i < childCount; i++) tops[i] = editorMirror.children[i].offsetTop;
    lineTops = tops;
    mirrorTotalHeight = editorMirror.offsetHeight;
  }

  writeEditorMirrorTransform();

  // Find-bar repaint: textContent writes above nuke any <span.editor-hl>
  // on changed lines; re-scan while the bar is open (cheap, rare state).
  if (isFindBarOpen()) {
    const q = document.getElementById('find-input')?.value || '';
    const re = q ? buildFindRegex(q) : null;
    if (re) _findState.editorMarks = highlightInEditorMirror(re);
    const active = _findState.editorMarks?.[_findState.index];
    if (active) active.classList.add('editor-hl--active');
  }
}

// Printable ASCII only (32..126). Gates the no-wrap measurement skip —
// non-ASCII chars (CJK/emoji/tabs) can render wider than the 'M' probe predicts.
function isPlainAscii(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}

// Max chars guaranteed to fit on one visual row at current mirror width, or 0.
// Cached per _mirrorWidth — probe only re-runs on actual width change.
let _mirrorNoWrapBudget = 0;
let _mirrorNoWrapBudgetWidth = -1;
function noWrapCharBudget() {
  if (!editorMirror) return 0;
  if (_mirrorWidth === _mirrorNoWrapBudgetWidth) {
    return _mirrorNoWrapBudget;
  }
  _mirrorNoWrapBudgetWidth = _mirrorWidth;
  _mirrorNoWrapBudget = 0;

  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  probe.textContent = 'MMMMMMMMMM';
  editorMirror.appendChild(probe);
  const probeWidth = probe.offsetWidth;
  probe.remove();
  if (probeWidth <= 0) return 0;
  const charPx = probeWidth / 10;
  const cs = getComputedStyle(editorMirror);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const contentWidth = editorMirror.clientWidth - padX;
  if (contentWidth <= 0) return 0;
  // 2-char safety margin for subpixel rounding.
  _mirrorNoWrapBudget = Math.max(0, Math.floor(contentWidth / charPx) - 2);
  return _mirrorNoWrapBudget;
}

function editorTopOfLine(line) {
  if (!lineTops.length) return 0;
  if (line <= 0) return lineTops[0] ?? 0;
  const i = Math.floor(line);
  if (i >= lineTops.length - 1) return lineTops[lineTops.length - 1] ?? 0;
  return lineTops[i] + (line - i) * (lineTops[i + 1] - lineTops[i]);
}

function editorTopVisibleLine() {
  if (!lineTops.length) return 0;
  const y = Math.max(0, editor.scrollTop);
  let lo = 0, hi = lineTops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineTops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  const a = lineTops[lo];
  const next = lineTops[lo + 1] ?? (a + 20);
  return lo + (y - a) / (next - a || 1);
}

function rebuildAnchorMap() {
  const kids = Array.from(preview.children).filter(el => {
    // Footnote section has no corresponding source block at its position.
    if (el.classList?.contains('footnotes')) return false;
    if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;
    return true;
  });
  const n = Math.min(kids.length, sourceBlockLines.length);
  const map = [];
  for (let i = 0; i < n; i++) {
    // Clamp to previous top — mid-inflation offsets can briefly regress.
    const prev = map[map.length - 1];
    const top = kids[i].offsetTop;
    map.push({ line: sourceBlockLines[i], top: prev ? Math.max(prev.top, top) : top });
  }
  // Bottom sentinel: bottoming out one pane bottoms out the other.
  const totalLines = editor.value.split('\n').length;
  const last = map[map.length - 1];
  const endTop = Math.max(last?.top ?? 0, previewWrap.scrollHeight);
  map.push({ line: Math.max(totalLines, last?.line ?? 0) + 1, top: endTop });
  anchorMap = map;
  // Snapshot heading Ys while layout is fresh — the TOC's hot path reads these.
  rebuildTocHeadingTops();
}

// Rebuild the anchor map after layout settles. Late-inflating children
// (Mermaid, KaTeX, images) re-trigger this via ResizeObserver.
function scheduleAnchorRebuild() {
  clearTimeout(_anchorRebuildTimer);
  _anchorRebuildTimer = setTimeout(() => {
    requestAnimationFrame(rebuildAnchorMap);
  }, 16);
}

let _previewResizeObserver = null;
let _editorResizeObserver = null;
function ensurePreviewObserver() {
  if (_previewResizeObserver || !('ResizeObserver' in window)) return;
  _previewResizeObserver = new ResizeObserver(() => scheduleAnchorRebuild());
  _previewResizeObserver.observe(preview);
  // Observe each child too, so per-block height changes (Mermaid, images)
  // trigger a rebuild. MutationObserver keeps the list in sync.
  const mo = new MutationObserver(() => {
    for (const el of preview.children) {
      try { _previewResizeObserver.observe(el); } catch {}
    }
  });
  mo.observe(preview, { childList: true });
  for (const el of preview.children) {
    try { _previewResizeObserver.observe(el); } catch {}
  }
}

// Separate from ensurePreviewObserver so the editor gets a resize hook
// even when the preview is empty — the exact scenario where the
// "line numbers don't appear on upload" bug used to bite (editor pane
// goes 0-width → >0 width without a keystroke).
function ensureEditorObserver() {
  if (_editorResizeObserver || !('ResizeObserver' in window)) return;
  _editorResizeObserver = new ResizeObserver(() => {
    // Width change (view switch, sidebar resize, first reveal) → re-measure.
    syncEditorMirror();
    updateGutter();
    scheduleAnchorRebuild();
  });
  _editorResizeObserver.observe(editor);
}

// Binary-search the anchor segment that brackets `key` on the given axis.
// Anchors are monotonic in both `line` and `top`, so this is safe.
function anchorSegment(key, axis) {
  let lo = 0, hi = anchorMap.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (anchorMap[mid][axis] <= key) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function previewScrollForLine(line) {
  const max = Math.max(0, previewWrap.scrollHeight - previewWrap.clientHeight);
  if (anchorMap.length < 2) {
    const lines = editor.value.split('\n').length || 1;
    return Math.max(0, Math.min(max, (line / lines) * max));
  }
  if (line <= anchorMap[0].line) {
    const first = anchorMap[0];
    const t = first.line > 0 ? line / first.line : 0;
    return Math.max(0, Math.min(max, t * first.top));
  }
  const end = anchorMap[anchorMap.length - 1];
  if (line >= end.line) return Math.max(0, Math.min(max, end.top));
  const i = anchorSegment(line, 'line');
  const a = anchorMap[i], b = anchorMap[i + 1];
  const t = (line - a.line) / (b.line - a.line || 1);
  return Math.max(0, Math.min(max, a.top + t * (b.top - a.top)));
}

function lineForPreviewScroll(scrollTop) {
  if (anchorMap.length < 2) {
    const lines = editor.value.split('\n').length || 1;
    const max = previewWrap.scrollHeight - previewWrap.clientHeight;
    return max > 0 ? (scrollTop / max) * lines : 0;
  }
  if (scrollTop <= anchorMap[0].top) {
    const first = anchorMap[0];
    const t = first.top > 0 ? scrollTop / first.top : 0;
    return t * first.line;
  }
  const end = anchorMap[anchorMap.length - 1];
  if (scrollTop >= end.top) return end.line;
  const i = anchorSegment(scrollTop, 'top');
  const a = anchorMap[i], b = anchorMap[i + 1];
  const t = (scrollTop - a.top) / (b.top - a.top || 1);
  return a.line + t * (b.line - a.line);
}

// will-change:transform promotion, active only while scrolling (~200ms idle release).
let _scrollIdleTimer = 0;
let _scrollPromoted = false;
function markScrollingActive() {
  if (!_scrollPromoted) {
    if (editorMirror) editorMirror.style.willChange = 'transform';
    const inner = gutter && gutter.firstElementChild;
    if (inner) inner.style.willChange = 'transform';
    _scrollPromoted = true;
  }
  if (_scrollIdleTimer) clearTimeout(_scrollIdleTimer);
  _scrollIdleTimer = setTimeout(() => {
    _scrollIdleTimer = 0;
    _scrollPromoted = false;
    if (editorMirror) editorMirror.style.willChange = 'auto';
    const innerLater = gutter && gutter.firstElementChild;
    if (innerLater) innerLater.style.willChange = 'auto';
  }, 200);
}

function syncGutterToEditor() {
  markScrollingActive();
  const inner = gutter.firstElementChild;
  if (inner) inner.style.transform = `translate3d(0, ${-editor.scrollTop}px, 0)`;
}

// Writes the mirror transform without touching will-change. Callers that
// need compositor promotion must call markScrollingActive() themselves.
function writeEditorMirrorTransform() {
  if (!editorMirror) return;
  editorMirror.style.transform = `translate3d(0, ${-editor.scrollTop}px, 0)`;
}

// Keep the overlay mirror in lock-step with the textarea. Mirror sits at
// top:0; we simulate scrollTop via a negative translateY.
function syncEditorMirrorScroll() {
  if (!editorMirror) return;
  markScrollingActive();
  writeEditorMirrorTransform();
}

// rAF-batched so native momentum scrolling on one pane doesn't starve the
// main thread with per-event layout work on the other.
let _editorSyncQueued = false;
let _previewSyncQueued = false;

function scheduleEditorToPreview() {
  if (!scrollSyncEnabled || _editorSyncQueued || _fileSwitching || _tocScrollAbortController) return;
  _editorSyncQueued = true;
  requestAnimationFrame(() => {
    _editorSyncQueued = false;
    if (!scrollSyncEnabled || scrollOwner === 'preview' || _fileSwitching || _tocScrollAbortController) return;
    const target = Math.round(previewScrollForLine(editorTopVisibleLine()));
    // Skip sub-pixel writes — each assignment fires a native scroll event
    // that re-enters the pipeline and can stutter momentum scrolling.
    if (Math.abs(target - previewWrap.scrollTop) < 1) return;
    takeScroll('editor');
    previewWrap.scrollTop = target;
  });
}

function schedulePreviewToEditor() {
  if (!scrollSyncEnabled || _previewSyncQueued || _fileSwitching || _tocScrollAbortController) return;
  _previewSyncQueued = true;
  requestAnimationFrame(() => {
    _previewSyncQueued = false;
    if (!scrollSyncEnabled || scrollOwner === 'editor' || _fileSwitching || _tocScrollAbortController) return;
    const line = lineForPreviewScroll(previewWrap.scrollTop);
    const target = Math.round(Math.max(0, editorTopOfLine(line) - _editorPadTop));
    if (Math.abs(target - editor.scrollTop) < 1) return;
    takeScroll('preview');
    editor.scrollTop = target;
    syncGutterToEditor();
  });
}

editor.addEventListener('scroll', () => {
  syncGutterToEditor();
  syncEditorMirrorScroll();
  scheduleEditorToPreview();
  schedulePersistScroll();
}, { passive: true });

previewWrap.addEventListener('scroll', () => {
  // Drift check via cached expectedTop scalar — no DOM queries per frame.
  if (_tocScrollLock && !_tocScrollAbortController) {
    const expected = _tocScrollLock.expectedTop;
    if (typeof expected !== 'number' ||
        Math.abs(previewWrap.scrollTop - expected) > 20) {
      _tocScrollLock = null;
    }
  }
  schedulePreviewToEditor();
  schedulePersistScroll();
  scheduleTocActiveUpdate();
}, { passive: true });

function writeScrollState() {
  // Scroll positions are stamped onto whichever file is currently loaded in
  // the editor. We capture `_loadedFileId` synchronously so a pending scroll
  // save after a tab switch doesn't overwrite File B's scroll with File A's.
  if (!_loadedFileId) return;
  const f = Store.files.get(_loadedFileId);
  if (!f) return;
  f.scrollEditor  = editor.scrollTop;
  f.scrollPreview = previewWrap.scrollTop;
  scheduleSaveForFile(_loadedFileId);
}

// Debounce fires after scroll events settle. We persist unconditionally: by
// then, any programmatic-scroll lockout (~50ms) has long since cleared.
const schedulePersistScroll = debounce(writeScrollState, 250);

// Synchronous flush on unload. IndexedDB transactions may be aborted by
// modern browsers mid-unload; best-effort. returnValue prompts the user
// only when dirty files remain (save didn't complete in the 300ms window).
window.addEventListener('beforeunload', (e) => {
  if (_loadedFileId) {
    try {
      saveFileContent(_loadedFileId, editor.value, {
        cursor: editor.selectionStart,
        scrollEditor:  editor.scrollTop,
        scrollPreview: previewWrap.scrollTop,
      });
    } catch {}
  }
  // Warn only if there are still dirty files (pending saves that didn't
  // make it into the tx queue). Avoids "are you sure?" prompts for
  // every edit since normal saves complete in 300ms.
  if (Store.dirty && Store.dirty.size > 0) {
    const msg = 'You have unsaved changes.';
    e.preventDefault();
    e.returnValue = msg;
    return msg;
  }
});

// `visibilitychange` (`document.hidden === true`) is fired BEFORE `beforeunload`
// on tab close and reliably allows async writes to complete. We flush pending
// saves here so the `beforeunload` warning only fires in real emergencies.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (_loadedFileId) {
    // If there's a pending timer for this file, trigger it now.
    const t = _saveTimers.get(_loadedFileId);
    if (t) {
      clearTimeout(t);
      _saveTimers.delete(_loadedFileId);
      saveFileContent(_loadedFileId, editor.value, {
        cursor: editor.selectionStart,
        scrollEditor:  editor.scrollTop,
        scrollPreview: previewWrap.scrollTop,
      }).catch(() => {});
    }
  }
});

// Restore saved editor + preview scroll for the active file.
// `_fileSwitching` suppresses both sync directions during the writes —
// otherwise editor→preview sync would overwrite the saved preview
// scroll with a computed one on the next frame.
function restoreActiveFileScroll() {
  const f = Store.activeFile();
  if (!f) return;
  const prevSwitching = _fileSwitching;
  _fileSwitching = true;
  if (typeof f.scrollEditor  === 'number') editor.scrollTop      = f.scrollEditor;
  if (typeof f.scrollPreview === 'number') previewWrap.scrollTop = f.scrollPreview;
  syncGutterToEditor();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _fileSwitching = prevSwitching;
  }));
}

function updateGutter() {
  syncEditorMirror();
  // Reuse mirror's line split; fall back to a fresh split if mirror early-returned.
  const total = (_mirrorLines && _mirrorLines.length)
    ? _mirrorLines.length
    : editor.value.split('\n').length;
  const tops = lineTops;

  let inner = gutter.firstElementChild;
  if (!inner || inner.className !== 'editor__gutter-inner') {
    gutter.replaceChildren();
    inner = document.createElement('div');
    inner.className = 'editor__gutter-inner';
    gutter.appendChild(inner);
  }
  inner.style.height = `${mirrorTotalHeight}px`;

  const spans = inner.children;
  const existing = spans.length;
  for (let i = 0; i < total; i++) {
    let span = spans[i];
    if (!span) {
      span = document.createElement('span');
      span.className = 'editor__gutter-num';
      span.textContent = String(i + 1);
      inner.appendChild(span);
    } else if (span.textContent !== String(i + 1)) {
      span.textContent = String(i + 1);
    }
    const topPx = `${tops[i] ?? 0}px`;
    if (span.style.top !== topPx) span.style.top = topPx;
  }
  for (let i = existing - 1; i >= total; i--) {
    inner.removeChild(spans[i]);
  }
  inner.style.transform = `translateY(${-editor.scrollTop}px)`;
}

// Module-scope regex; reset via lastIndex per call.
const _wordCountRe = /\b\w+\b/g;

function updateStats(src) {
  const chars = src.length;
  // Count matches without allocating an array (src.match(re) materialises each match string).
  _wordCountRe.lastIndex = 0;
  let words = 0;
  while (_wordCountRe.exec(src) !== null) words++;
  const lines = src ? src.split('\n').length : 0;
  statChars.textContent = chars.toLocaleString();
  statWords.textContent = words.toLocaleString();
  statLines.textContent = lines.toLocaleString();
  statRead.textContent = `${Math.max(1, Math.round(words / 220))} min read`;
}

function setStatus(kind, text) {
  statusDot.dataset.status = kind;
  statusText.textContent = text;
}

// ── File-level persistence ───────────────────────────────────────────
// Per-keystroke debounced save (300ms). File ID is captured at schedule
// time — switching tabs within the window must save to the original
// file, not the new one. Per-file timer map keeps pending saves
// independent; switchToFile flushes the outgoing file's pending save.

let _loadedFileId = null;
let _fileSwitching = false;

const SAVE_DEBOUNCE_MS = 300;

// Timer-per-file. Closures snapshot fileId and read editor state at fire time,
// guarded by _loadedFileId — stale timers after a tab switch become no-ops.
const _saveTimers = new Map();

function scheduleSaveForFile(fileId) {
  if (!fileId) return;
  if (_saveTimers.has(fileId)) clearTimeout(_saveTimers.get(fileId));
  const timer = setTimeout(async () => {
    _saveTimers.delete(fileId);
    // Only save if this file is still the one loaded in the editor.
    // Otherwise `switchToFile` has already persisted its content.
    if (fileId !== _loadedFileId) return;
    try {
      await saveFileContent(fileId, editor.value, {
        cursor: editor.selectionStart,
        scrollEditor:  editor.scrollTop,
        scrollPreview: previewWrap.scrollTop,
      });
      updateFileIndicator('saved');
    } catch (err) {
      console.warn('Save failed:', err);
      updateFileIndicator('error');
      const msg = err?.code === 'STORAGE_FULL' || /storage is full/i.test(err?.message || '')
        ? err.message
        : err?.name === 'QuotaExceededError'
          ? 'Browser storage is full. Delete some files to continue.'
          : 'Couldn\u2019t save \u2014 storage unavailable';
      showToast(msg, 'error');
    }
  }, SAVE_DEBOUNCE_MS);
  _saveTimers.set(fileId, timer);
}

function cancelSaveForFile(fileId) {
  const t = _saveTimers.get(fileId);
  if (t) { clearTimeout(t); _saveTimers.delete(fileId); }
}

// Called from `render()` whenever editor value changed. Mirrors the
// value into the active file, marks it dirty, and schedules the
// debounced save SCOPED TO THAT FILE — a pending save can never race
// a tab switch.
function persist() {
  if (_fileSwitching) return;
  const f = Store.activeFile();
  if (!f) return;
  if (_loadedFileId !== f.id) return;
  if (editor.value === f.content) return;
  f.content = editor.value;
  markDirty(f.id);
  scheduleSaveForFile(f.id);
}

function updateFileIndicator(state = 'saved') {
  const f = Store.activeFile();
  if (!f) {
    fileIndicator.textContent = 'No file open';
    return;
  }
  const label = state === 'error'   ? 'autosave unavailable'
              : Store.dirty.has(f.id) ? 'editing\u2026'
              : 'autosaved';
  // Split into name + state spans so the mobile layout can restyle or hide
  // the state chip without losing the filename. On desktop both render inline
  // with a " · " separator via the ::before pseudo on the state span.
  fileIndicator.innerHTML = '';
  const nameEl = document.createElement('span');
  nameEl.className = 'topbar__subtitle-name';
  nameEl.textContent = f.name;
  const stateEl = document.createElement('span');
  stateEl.className = 'topbar__subtitle-state';
  stateEl.dataset.state = Store.dirty.has(f.id) ? 'dirty' : (state === 'error' ? 'error' : 'saved');
  stateEl.textContent = label;
  fileIndicator.append(nameEl, stateEl);
}

// ── Projects bootstrap ───────────────────────────────────────────────

async function bootstrapProjects() {
  await loadAll({ fallbackContent: EXAMPLES.welcome.content });

  Store.on((kind, payload) => {
    // Keep the status-bar indicator in sync with dirty/saved state.
    if (kind === 'file:saved' || kind === 'file:dirty') updateFileIndicator();
    if (kind === 'file:renamed' && payload?.file?.id === Store.activeId) updateFileIndicator();

    // Surface collision auto-uniquify so the user understands why the name
    // they typed didn't stick.
    if (kind === 'file:rename-collision') {
      showToast(`"${payload.requested}" already exists — renamed to "${payload.finalName}"`, 'info');
    }

    // Centralized handler for the currently-loaded file being deleted —
    // covers direct delete, cascade delete via deleteProject, and any
    // future paths that destroy the file without going through the
    // sidebar's confirm flow. Without this, the editor shows ghost
    // content and the next keystroke would call markDirty on a dead id.
    if (kind === 'file:deleted' && payload?.id === _loadedFileId) {
      cancelSaveForFile(_loadedFileId);
      _loadedFileId = null;
      if (Store.activeId && Store.files.has(Store.activeId)) {
        switchToFile(Store.activeId);
      } else {
        editor.value = '';
        invalidateRenderCache();
        updateFileIndicator();
        safeUpdateGutter();
        scheduleRender();
      }
    }
  });

  // Load whatever file was active last session into the editor.
  const active = Store.activeFile();
  if (active) {
    _loadedFileId = active.id;
    editor.value = active.content || '';
  } else {
    editor.value = '';
  }
  invalidateRenderCache();
  updateFileIndicator();
  // Double-rAF ensures the editor has real layout before we measure line Ys.
  requestAnimationFrame(() => requestAnimationFrame(updateGutter));
}

// Swap the editor's contents to another file. Flushes the outgoing file's
// pending save first (so no keystroke is lost), cancels any stale pending
// save on the incoming file, then paints the new file.
async function switchToFile(fileId) {
  const target = Store.files.get(fileId);
  if (!target) return;

  // Raise the switching flag before the first await and release it in
  // `finally` — otherwise a DB/activateFile rejection would leave it stuck
  // and permanently disable scroll sync.
  _fileSwitching = true;
  try {
    // Flush the outgoing file's pending save synchronously against its
    // current editor contents. If we didn't do this, a pending 300ms timer
    // could race against our swap and write File B's contents into File A.
    if (_loadedFileId && _loadedFileId !== fileId) {
      cancelSaveForFile(_loadedFileId);
      const outgoing = Store.files.get(_loadedFileId);
      if (outgoing) {
        try {
          await saveFileContent(_loadedFileId, editor.value, {
            cursor: editor.selectionStart,
            scrollEditor:  editor.scrollTop,
            scrollPreview: previewWrap.scrollTop,
          });
        } catch {}
      }
    }
    // Cancel any stale pending save for the incoming file.
    cancelSaveForFile(fileId);

    _loadedFileId = fileId;
    await activateFile(fileId);
    // activateFile already appends to openIds and emits tab:activated; no
    // need to call storeOpenFile again (that would double-emit and double-
    // write the session to IndexedDB).

    editor.value = target.content || '';
    invalidateRenderCache();
    updateFileIndicator();

    // Use safeUpdateGutter so line numbers paint reliably even if the editor
    // just became visible (common when clicking a file while in preview mode).
    safeUpdateGutter();

    // Restore per-file scroll/cursor. Done inside a double-rAF so the
    // editor's layout has settled before we write scroll positions.
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (typeof target.cursor === 'number') {
          try { editor.selectionStart = editor.selectionEnd = target.cursor; } catch {}
        }
        if (typeof target.scrollEditor  === 'number') editor.scrollTop      = target.scrollEditor;
        if (typeof target.scrollPreview === 'number') previewWrap.scrollTop = target.scrollPreview;
        syncGutterToEditor();
        resolve();
      }));
    });

    await render();
  } finally {
    // Always release the switch flag. Wrapped in a rAF so any scroll events
    // fired by the just-assigned scroll positions settle (and are suppressed
    // by the flag being still set) before the flag clears.
    requestAnimationFrame(() => { _fileSwitching = false; });
  }
}

// Double-rAF so textarea clientWidth is finalized (post-file-switch the
// editor pane may have just become visible). Fixes "line numbers don't
// appear until I edit" after loading a file.
function safeUpdateGutter() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    updateGutter();
    // One more pass in case Mermaid/images inflated after the first frame.
    requestAnimationFrame(updateGutter);
  }));
}

// ── Palette commands ─────────────────────────────────────────────────
// Flat list of { title, subtitle?, shortcut?, icon, run } entries,
// fuzzy-matched against title + subtitle. Active-file commands omit
// themselves when no file is loaded.
function buildCommandList() {
  const active = Store.activeFile();
  const commands = [
    // ---- File / project lifecycle ----
    { title: 'New file',              subtitle: 'In active project',          shortcut: '⌘N',       icon: iconSvg('file-plus'),  run: () => newFileInActive() },
    { title: 'New project',           subtitle: 'Create a new project',                              icon: iconSvg('folder-plus'), run: () => newProject() },
  ];
  if (active) {
    commands.push(
      { title: 'Rename active file',    subtitle: active.name,                                        icon: iconSvg('edit'),       run: () => renameActiveFileFlow() },
      { title: 'Duplicate active file', subtitle: active.name,                                        icon: iconSvg('copy'),       run: () => duplicateActiveFile() },
      { title: 'Delete active file',    subtitle: active.name,                                        icon: iconSvg('trash'),      run: () => deleteActiveFileFlow() },
      { title: 'Close active tab',      subtitle: active.name,                  shortcut: '⌘W',       icon: iconSvg('close'),      run: () => closeActiveTab() },
      { title: 'Close other tabs',      subtitle: `Keep ${active.name} open`,                         icon: iconSvg('close'),      run: () => closeOtherTabs() },
      { title: 'Close tabs to the right', subtitle: `After ${active.name}`,                           icon: iconSvg('close'),      run: () => closeTabsToRight() },
    );
  }
  commands.push(
    // ---- View / appearance ----
    { title: 'Toggle theme',          subtitle: 'Switch light / dark',        shortcut: '⌘⇧K',      icon: iconSvg('sun-moon'),   run: () => btnTheme.click() },
    { title: 'Toggle sidebar',        subtitle: 'Show or hide sidebar',       shortcut: '⌘⇧B',      icon: iconSvg('sidebar'),    run: () => toggleSidebar() },
    { title: 'Toggle focus mode',     subtitle: 'Distraction-free writing',   shortcut: '⌘.',       icon: iconSvg('focus'),      run: () => toggleFocus() },
    { title: 'Toggle outline',        subtitle: 'Document table of contents', shortcut: '⌘L',       icon: iconSvg('outline'),    run: () => { const on = toc?.dataset.collapsed !== 'true'; applyTocToggle(!on); } },
    { title: 'Toggle reading mode',   subtitle: 'Serif typography',                                  icon: iconSvg('book'),       run: () => { toggleProse.checked = !toggleProse.checked; toggleProse.dispatchEvent(new Event('change')); } },
    { title: 'View: Editor',          subtitle: 'Editor only',                shortcut: '⌘1',       icon: iconSvg('edit'),       run: () => setView('editor') },
    { title: 'View: Split',           subtitle: 'Editor + preview',           shortcut: '⌘2',       icon: iconSvg('split'),      run: () => setView('split') },
    { title: 'View: Preview',         subtitle: 'Rendered only',              shortcut: '⌘3',       icon: iconSvg('eye'),        run: () => setView('preview') },
    // ---- I/O ----
    { title: 'Upload file…',          subtitle: 'Import a .md file',          shortcut: '⌘O',       icon: iconSvg('upload'),     run: () => fileInput.click() },
    { title: 'Import folder…',        subtitle: 'Import a directory of .md files', icon: iconSvg('folder-plus'), run: () => folderInput?.click() },
    { title: 'Find in file',          subtitle: 'Search the current document', shortcut: '⌘F',       icon: iconSvg('keyboard'),   run: () => openFindBar({ replace: false }) },
    { title: 'Find and replace',      subtitle: 'Replace in the current document', shortcut: '⌘⇧F',  icon: iconSvg('edit'),       run: () => openFindBar({ replace: true }) },
    { title: 'Download markdown',     subtitle: 'Active file as .md',         shortcut: '⌘S',       icon: iconSvg('download'),   run: () => exportMd() },
    { title: 'Download HTML',         subtitle: 'Rendered, self-contained',                          icon: iconSvg('download'),   run: () => exportHtml() },
    { title: 'Download PDF',          subtitle: 'Rendered as PDF',                                   icon: iconSvg('download'),   run: () => exportPdf() },
    { title: 'Copy markdown source',                                                                                             icon: iconSvg('copy'),       run: () => copy(editor.value, 'Markdown copied') },
    { title: 'Copy rendered HTML',                                                                                               icon: iconSvg('copy'),       run: () => copy(preview.innerHTML, 'HTML copied') },
    { title: 'Show keyboard shortcuts', subtitle: 'All shortcuts',             shortcut: '?',        icon: iconSvg('keyboard'),   run: () => toggleShortcuts() },
  );
  return commands;
}

// ── File-lifecycle helpers for palette commands ──────────────────────

async function renameActiveFileFlow() {
  const f = Store.activeFile();
  if (!f) { showToast('No file open', 'error'); return; }
  const current = f.name;
  // Native `prompt` is ugly but zero-dependency and works immediately.
  // A dedicated modal can be wired later; the palette command is what
  // matters for discoverability.
  const next = prompt('Rename file', current);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return;
  const finalName = await renameFile(f.id, trimmed);
  if (finalName && finalName !== trimmed) {
    // `file:rename-collision` already fired its toast; nothing else to do.
  }
}

async function duplicateActiveFile() {
  const f = Store.activeFile();
  if (!f) { showToast('No file open', 'error'); return; }
  const copy = await duplicateFile(f.id);
  if (copy) {
    await switchToFile(copy.id);
    showToast(`Duplicated to "${copy.name}"`, 'success');
  }
}

async function deleteActiveFileFlow() {
  const f = Store.activeFile();
  if (!f) { showToast('No file open', 'error'); return; }
  const snap = await deleteFile(f.id);
  if (snap) showUndoableDeleteToast({ snapshot: snap, message: `Deleted "${f.name}"` });
}

// Clears the editor when the last tab closes. Called from every tab-close
// path (tab strip, palette, Cmd+W) to avoid stale content in the editor.
function resetEditorWhenNoTabs() {
  if (Store.activeId) return;
  _loadedFileId = null;
  editor.value = '';
  invalidateRenderCache();
  updateFileIndicator();
  safeUpdateGutter();
  scheduleRender();
}

async function closeActiveTab() {
  if (!Store.activeId) return;
  if (Store.dirty.has(Store.activeId)) {
    const f = Store.activeFile();
    if (!confirm(`"${f?.name}" has unsaved changes. Close anyway?`)) return;
  }
  const closing = Store.activeId;
  await storeCloseFile(closing);
  if (Store.activeId) await switchToFile(Store.activeId);
  else resetEditorWhenNoTabs();
}

async function closeOtherTabs() {
  const keep = Store.activeId;
  if (!keep) return;
  const targets = Store.openIds.filter(id => id !== keep);
  const dirty = targets.filter(id => Store.dirty.has(id));
  if (dirty.length && !confirm(`Close ${targets.length} tab${targets.length === 1 ? '' : 's'}? ${dirty.length} ha${dirty.length === 1 ? 's' : 've'} unsaved changes.`)) return;
  for (const id of targets) await storeCloseFile(id);
  showToast(`Closed ${targets.length} tab${targets.length === 1 ? '' : 's'}`, 'info');
}

async function closeTabsToRight() {
  const keep = Store.activeId;
  if (!keep) return;
  const idx = Store.openIds.indexOf(keep);
  if (idx === -1) return;
  const targets = Store.openIds.slice(idx + 1);
  if (targets.length === 0) { showToast('No tabs to the right', 'info'); return; }
  const dirty = targets.filter(id => Store.dirty.has(id));
  if (dirty.length && !confirm(`Close ${targets.length} tab${targets.length === 1 ? '' : 's'}? ${dirty.length} ha${dirty.length === 1 ? 's' : 've'} unsaved changes.`)) return;
  for (const id of targets) await storeCloseFile(id);
  showToast(`Closed ${targets.length} tab${targets.length === 1 ? '' : 's'}`, 'info');
}
function iconSvg(kind) {
  const icons = {
    'file-plus':   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
    'folder-plus': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
    'sun-moon':    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    'sidebar':     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>',
    'focus':       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    'outline':     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>',
    'book':        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    'edit':        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
    'split':       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
    'eye':         '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    'upload':      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    'download':    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    'copy':        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    'keyboard':    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 10h0M11 10h0M15 10h0M7 14h10"/></svg>',
    'trash':       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    'close':       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };
  return icons[kind] || '';
}

async function newFileInActive() {
  const active = Store.focusedProject() || (await createProject({ name: 'My documents' }));
  const name = uniqueFileName(active.id, 'Untitled.md');
  const f = await createFile({ projectId: active.id, name, content: '' });
  switchToFile(f.id);
}
async function newProject() {
  const p = await createProject({ name: `Project ${Store.projects.size + 1}` });
  const name = uniqueFileName(p.id, 'Untitled.md');
  const f = await createFile({ projectId: p.id, name, content: '' });
  switchToFile(f.id);
  showToast(`Created project "${p.name}"`, 'success');
}

function restoreTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(theme, true);
}

function applyTheme(theme, silent = false) {
  document.documentElement.setAttribute('data-theme', theme);
  hljsTheme.href = theme === 'dark'
    ? 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-dark.min.css'
    : 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-light.min.css';
  localStorage.setItem(THEME_KEY, theme);
  // Mermaid SVGs bake theme colors. Clear the cache + invalidate live-DOM
  // theme stamps so any concurrent render can't harvest stale-theme SVGs.
  _mermaidCache.clear();
  if (preview) {
    preview.querySelectorAll('.mermaid[data-theme]').forEach(el => el.removeAttribute('data-theme'));
  }
  setupMermaid();
  if (!silent) {
    rethemeMermaid();
    showToast(`${theme === 'dark' ? 'Dark' : 'Light'} theme`, 'info');
  }
}

// Re-render Mermaid diagrams after a theme change. Claims a fresh render
// generation so a concurrent typing-triggered render doesn't race with
// the theme repaint.
async function rethemeMermaid() {
  const gen = ++_renderGen;
  await runMermaid(gen);
  if (gen !== _renderGen) return;
  scheduleAnchorRebuild();
}

btnTheme.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

async function enterFocus() {
  document.body.classList.add('is-focus');
  bindFocusDockListeners();
  // Fullscreen on <body> (not <html>) — browsers paint default white over the
  // fullscreen root, which hides our UI. Falls back gracefully.
  try {
    if (document.body.requestFullscreen && !document.fullscreenElement) {
      await document.body.requestFullscreen();
    }
  } catch {}
  // Mid-await the user may have already escaped (rapid toggle, permission
  // denial followed by Esc, etc.). Skip the aria-pressed side-effect if
  // focus mode was torn down while we were awaiting the fullscreen promise.
  if (!document.body.classList.contains('is-focus')) return;
  showToast('Focus mode · press Esc to exit', 'info');
  btnFocus.setAttribute('aria-pressed', 'true');
  syncDockState();
}
async function exitFocus() {
  document.body.classList.remove('is-focus');
  unbindFocusDockListeners();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {}
  btnFocus.setAttribute('aria-pressed', 'false');
}
function toggleFocus() {
  if (document.body.classList.contains('is-focus')) exitFocus();
  else enterFocus();
}
btnFocus.addEventListener('click', toggleFocus);
dockExit?.addEventListener('click', exitFocus);
dockTheme?.addEventListener('click', () => btnTheme.click());
dockReading?.addEventListener('click', () => {
  toggleProse.checked = !toggleProse.checked;
  toggleProse.dispatchEvent(new Event('change'));
  syncDockState();
});
dockOutline?.addEventListener('click', () => {
  const on = toc?.dataset.collapsed !== 'true';
  applyTocToggle(!on);
  syncDockState();
});
// Dock auto-hide: fades to ~30% opacity while idle, snaps back on
// mouse movement near the bottom-right. The mousemove listener is only
// bound while focus mode is active — a global binding would fire a
// no-op handler for every cursor move for the lifetime of the page.
let _focusDockIdleTimer = 0;
let _focusDockMoveBound = false;
function onFocusDockMove(e) {
  if (!document.body.classList.contains('is-focus')) return;
  // Only wake when the cursor is near the bottom-right quadrant.
  const nearDock = e.clientY > window.innerHeight - 160 && e.clientX > window.innerWidth - 360;
  if (nearDock) wakeFocusDock();
}
function wakeFocusDock() {
  if (!focusDock) return;
  focusDock.classList.add('is-awake');
  clearTimeout(_focusDockIdleTimer);
  _focusDockIdleTimer = setTimeout(() => focusDock.classList.remove('is-awake'), 2000);
}
function bindFocusDockListeners() {
  if (_focusDockMoveBound || !focusDock) return;
  _focusDockMoveBound = true;
  window.addEventListener('mousemove', onFocusDockMove);
  focusDock.addEventListener('mouseenter', wakeFocusDock);
  focusDock.addEventListener('focusin', wakeFocusDock);
}
function unbindFocusDockListeners() {
  if (!_focusDockMoveBound) return;
  _focusDockMoveBound = false;
  window.removeEventListener('mousemove', onFocusDockMove);
  focusDock?.removeEventListener('mouseenter', wakeFocusDock);
  focusDock?.removeEventListener('focusin', wakeFocusDock);
  clearTimeout(_focusDockIdleTimer);
  focusDock?.classList.remove('is-awake');
}

function syncDockState() {
  if (!focusDock) return;
  dockReading?.setAttribute('aria-pressed', String(!!toggleProse.checked));
  dockOutline?.setAttribute('aria-pressed', String(toc?.dataset.collapsed !== 'true'));
}
// Sync state on every fullscreen transition. `body.is-fs` reflects ANY
// fullscreen (F11 or our own) so chrome-hiding CSS still applies. Dock
// listeners are cleaned up here to avoid a global mousemove leak when
// the browser (not our exit path) drops fullscreen. Pre-Safari-16.4
// fires webkitfullscreenchange instead of the standard event.
function onFullscreenChange() {
  const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  document.body.classList.toggle('is-fs', fs);
  if (!fs && document.body.classList.contains('is-focus')) {
    document.body.classList.remove('is-focus');
    unbindFocusDockListeners();
    btnFocus.setAttribute('aria-pressed', 'false');
  }
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

function restoreView() {
  setView(localStorage.getItem(VIEW_KEY) || 'split', true);
}
function setView(view, silent = false) {
  // Layout is driven by `.panes[data-view=...]` — the workspace itself is
  // just the flex column that stacks the tab strip on top of the panes row.
  const panes = document.getElementById('panes');
  if (panes) panes.dataset.view = view;
  document.querySelectorAll('.segmented__item[data-view]').forEach(btn => {
    const on = btn.dataset.view === view;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  localStorage.setItem(VIEW_KEY, view);
  if (!silent) showToast(`View: ${view}`, 'info');
  // When the editor pane becomes visible again, its clientWidth changes —
  // re-measure the mirror so line numbers align. This is the key fix for
  // "line numbers disappear after switching to preview, reappear after edit".
  if (view === 'editor' || view === 'split') safeUpdateGutter();
  // Pane switch changes which surface owns the find highlights — re-run.
  if (isFindBarOpen()) {
    const q = document.getElementById('find-input')?.value || '';
    if (q) runFind(q);
    else clearFindHighlight();
  }
}
document.querySelectorAll('.segmented__item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

function restoreSplit() {
  const pct = Number(localStorage.getItem(SPLIT_KEY));
  if (pct && pct > 15 && pct < 85) applySplit(pct);
}
// Custom property instead of a full grid-template-columns — lets the
// [data-view=editor|preview] rules collapse the layout. `--split` lives
// on `.panes` (not `.workspace`) since the workspace also contains the
// tabs strip above the panes row.
function panesEl() { return document.getElementById('panes') || workspace; }
function applySplit(pct, { deferRebuild = false } = {}) {
  panesEl().style.setProperty('--split', `${pct}%`);
  localStorage.setItem(SPLIT_KEY, String(pct));
  if (deferRebuild) return;
  requestAnimationFrame(() => {
    syncEditorMirror();
    scheduleAnchorRebuild();
  });
}
function currentSplitPct() {
  const v = getComputedStyle(panesEl()).getPropertyValue('--split').trim();
  const m = v.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 50;
}
{
  let dragging = false;
  // Cached at mousedown to avoid forced layout per mousemove (500-1000 Hz on high-DPI pointers).
  let _dragPanesRect = null;
  let _dragTocOffset = 0;
  let _dragLastX = 0;
  let _dragRafPending = false;
  // Column 1 renders as `split% − tocOffset`, so add it back when mapping mouseX → split%.
  const tocOffsetPx = () => {
    const n = parseFloat(getComputedStyle(panesEl()).getPropertyValue('--toc-offset'));
    return Number.isFinite(n) ? n : 0;
  };
  function flushDragSplit() {
    _dragRafPending = false;
    if (!dragging || !_dragPanesRect) return;
    const pct = ((_dragLastX - _dragPanesRect.left + _dragTocOffset) / _dragPanesRect.width) * 100;
    // Mirror rebuild is O(N); defer per-pixel, flush once on mouseup.
    if (pct > 15 && pct < 85) applySplit(pct, { deferRebuild: true });
  }
  resizer.addEventListener('mousedown', () => {
    dragging = true;
    _dragPanesRect = panesEl().getBoundingClientRect();
    _dragTocOffset = tocOffsetPx();
    document.body.style.cursor = 'col-resize';
  });
  resizer.addEventListener('keydown', (e) => {
    const cur = currentSplitPct();
    if (e.key === 'ArrowLeft')  { e.preventDefault(); applySplit(Math.max(15, cur - 2)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); applySplit(Math.min(85, cur + 2)); }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    _dragLastX = e.clientX;
    if (_dragRafPending) return;
    _dragRafPending = true;
    requestAnimationFrame(flushDragSplit);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    _dragPanesRect = null;
    _dragRafPending = false;
    document.body.style.cursor = '';
    requestAnimationFrame(() => {
      syncEditorMirror();
      scheduleAnchorRebuild();
    });
  });
}

function restoreProse() {
  const on = localStorage.getItem(PROSE_KEY) === '1';
  toggleProse.checked = on;
  preview.classList.toggle('is-reading', on);
}
toggleProse.addEventListener('change', () => {
  preview.classList.toggle('is-reading', toggleProse.checked);
  localStorage.setItem(PROSE_KEY, toggleProse.checked ? '1' : '0');
});

function applySyncToggle(on, { silent = false } = {}) {
  scrollSyncEnabled = !!on;
  btnSync.setAttribute('aria-pressed', String(scrollSyncEnabled));
  btnSync.title = scrollSyncEnabled
    ? 'Scroll sync is on — editor ↔ preview stay aligned. Click to disable.'
    : 'Scroll sync is off — panes scroll independently. Click to enable.';
  const label = btnSync.querySelector('.pane__toggle-label');
  if (label) label.textContent = scrollSyncEnabled ? 'Sync' : 'Sync off';
  try { localStorage.setItem(SYNC_KEY, scrollSyncEnabled ? '1' : '0'); } catch {}
  _editorSyncQueued = _previewSyncQueued = false;
  scrollOwner = null;
  if (!silent) showToast(scrollSyncEnabled ? 'Scroll sync on' : 'Scroll sync off', 'info');
}

function restoreSyncPref() {
  const raw = localStorage.getItem(SYNC_KEY);
  applySyncToggle(raw === null ? true : raw === '1', { silent: true });
}

btnSync.addEventListener('click', () => applySyncToggle(!scrollSyncEnabled));

btnUpload.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  fileInput.value = '';
  try {
    for (const f of files) await loadFile(f);
  } finally {
    // Safety net: clear in case loadFile threw before consuming.
    _pendingUploadProjectId = null;
  }
});

folderInput?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  folderInput.value = '';
  await importFolderFiles(files);
});

async function importFolderFiles(files) {
  const md = files.filter(f => /\.(md|markdown|txt)$/i.test(f.name));
  if (md.length === 0) {
    showToast('No markdown files in the selected folder', 'error');
    return;
  }
  const grouped = new Map();
  for (const f of md) {
    const path = f.webkitRelativePath || f.name;
    const rootName = path.split('/')[0] || 'Imported';
    if (!grouped.has(rootName)) grouped.set(rootName, []);
    grouped.get(rootName).push(f);
  }
  let imported = 0;
  for (const [rootName, group] of grouped) {
    let project = Store.projectList().find(p => p.name === rootName) ||
                  (await createProject({ name: rootName }));
    for (const f of group) {
      try {
        const text = await f.text();
        const path = f.webkitRelativePath || f.name;
        const rel = path.split('/').slice(1).join('/') || f.name;
        const baseName = rel.replace(/\//g, ' - ');
        const name = uniqueFileName(project.id, baseName);
        await createFile({ projectId: project.id, name, content: text });
        imported++;
      } catch (err) {
        console.warn('Skipping unreadable file', f.name, err);
      }
    }
  }
  showToast(`Imported ${imported} file${imported === 1 ? '' : 's'} into ${grouped.size} project${grouped.size === 1 ? '' : 's'}`, 'success');
}

let dragCounter = 0;
// Drop-overlay state machine with safety nets for the common cases where
// the browser doesn't fire a final `dragleave`: Esc mid-drag, drag out of
// window, OS-level cancel.
function resetDropOverlay() {
  dragCounter = 0;
  dropOverlay.classList.remove('is-active');
}
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('is-active');
});
window.addEventListener('dragleave', (e) => {
  // Coords at or past the viewport edge = cursor left the window.
  const outsideViewport =
    e.clientX <= 0 || e.clientY <= 0 ||
    e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
  if (outsideViewport) { resetDropOverlay(); return; }
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.classList.remove('is-active');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  resetDropOverlay();
  const files = Array.from(e.dataTransfer?.files || []);
  for (const f of files) await loadFile(f);
});
window.addEventListener('dragend', resetDropOverlay);
window.addEventListener('blur',    resetDropOverlay);

async function loadFile(file) {
  const ok = /\.(md|markdown|txt)$/i.test(file.name) || /text/.test(file.type);
  if (!ok) {
    showToast(`Unsupported file: ${file.name}`, 'error');
    return;
  }
  try {
    const text = await file.text();

    // Resolve target project: pending scope > focused project > seed.
    // Clear the pending scope on first use so later drops don't inherit it.
    let project = null;
    if (_pendingUploadProjectId && Store.projects.has(_pendingUploadProjectId)) {
      project = Store.projects.get(_pendingUploadProjectId);
    }
    _pendingUploadProjectId = null;

    project = project ||
      Store.focusedProject() ||
      (await createProject({ name: 'My documents' }));

    const name = uniqueFileName(project.id, file.name);
    const f = await createFile({ projectId: project.id, name, content: text });
    await switchToFile(f.id);

    showToast(`Imported ${file.name} → ${project.name}`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Failed to read ${file.name}`, 'error');
  }
}

function buildExamplesMenu() {
  examplesMenu.innerHTML = '';
  Object.entries(EXAMPLES).forEach(([key, ex]) => {
    const btn = document.createElement('button');
    btn.className = 'dropdown__item';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `
      <span style="font-size:18px;">${escapeHtml(ex.icon)}</span>
      <div>
        <strong>${escapeHtml(ex.label)}</strong>
        <small>${escapeHtml(ex.description)}</small>
      </div>
    `;
    btn.addEventListener('click', async () => {
      // Examples open inside the focused project so users can compare side-by-side via tabs.
      const project =
        Store.focusedProject() ||
        (await createProject({ name: 'Examples' }));
      const name = uniqueFileName(project.id, `${key}.md`);
      const f = await createFile({ projectId: project.id, name, content: ex.content });
      await switchToFile(f.id);
      closeAllDropdowns();
      showToast(`Loaded: ${ex.label}`, 'success');
    });
    examplesMenu.appendChild(btn);
  });
}

function bindUI() {
  document.querySelectorAll('[data-dropdown]').forEach(dd => {
    const trigger = dd.querySelector('.dropdown__trigger');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dd.dataset.open === 'true';
      closeAllDropdowns();
      if (!open) {
        dd.dataset.open = 'true';
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  });
  document.addEventListener('click', closeAllDropdowns);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllDropdowns();
  });

  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAction(btn.dataset.action));
  });

  document.getElementById('btn-shortcuts')?.addEventListener('click', toggleShortcuts);
  document.getElementById('btn-about')?.addEventListener('click', toggleAbout);
  document.getElementById('btn-palette')?.addEventListener('click', () => openPalette());

  // Sidebar search focus shortcut — `/` from any non-typing context focuses
  // the sidebar search input (classic file-manager muscle memory).
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !(e.metaKey || e.ctrlKey) && !isTypingTarget(e.target)) {
      e.preventDefault();
      document.getElementById('sidebar-search')?.focus();
    }
  });

  // On *.github.io hosts, derive the repo URL from the hostname + path so forks
  // of this project link to their own source instead of the upstream.
  const host = location.hostname;
  const repoLink = document.getElementById('repo-link');
  if (host.endsWith('github.io')) {
    const [user] = host.split('.');
    const path = location.pathname.split('/').filter(Boolean)[0] || 'markdownlab';
    repoLink.href = `https://github.com/${user}/${path}`;
  }
}
function closeAllDropdowns() {
  document.querySelectorAll('[data-dropdown][data-open="true"]').forEach(dd => {
    dd.dataset.open = 'false';
    dd.querySelector('.dropdown__trigger')?.setAttribute('aria-expanded', 'false');
  });
}

async function handleAction(action) {
  closeAllDropdowns();
  switch (action) {
    case 'export-html': return exportHtml();
    case 'export-md':   return exportMd();
    case 'export-pdf':  return exportPdf();
    case 'copy-html':   return copy(preview.innerHTML, 'HTML copied');
    case 'copy-md':     return copy(editor.value, 'Markdown copied');
    case 'clear':       return clearDoc();
    case 'import-folder': return folderInput?.click();
  }
}

async function copyToClipboard(text) {
  const str = text == null ? '' : String(text);

  // Modern API. Fails with NotAllowedError when focus was lost between
  // the user gesture and this await, or in insecure contexts.
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch (err) {
      console.warn('navigator.clipboard.writeText failed, falling back:', err);
    }
  }

  // Fallback: hidden textarea + execCommand. Works in a user gesture even
  // when the document lost focus or the clipboard API is unavailable.
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    const prevActive = document.activeElement;
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (prevActive && typeof prevActive.focus === 'function') {
      try { prevActive.focus({ preventScroll: true }); } catch {}
    }
    return ok;
  } catch (err) {
    console.warn('execCommand copy fallback failed:', err);
    return false;
  }
}

async function copy(text, msg) {
  const ok = await copyToClipboard(text);
  if (ok) showToast(msg, 'success');
  else showToast('Copy failed — try selecting the text manually', 'error');
}

function exportMd() {
  const f = Store.activeFile();
  let name = stripKnownExt(f?.name || 'document');
  if (!/\.(md|markdown|txt)$/i.test(name)) name += '.md';
  download(editor.value, name, 'text/markdown');
  showToast('Markdown downloaded', 'success');
}

function baseFilename() {
  const f = Store.activeFile();
  const raw = f?.name || 'document';
  const stripped = stripKnownExt(raw).replace(/^\.+/, '');
  return stripped || 'document';
}

// Iteratively strip any trailing text-ish / output-format extension so
// chained names like "report.pdf.md" collapse to "report" instead of
// only dropping the final ".md". Leading dots (e.g. ".htaccess") are
// stripped by the caller so dotfiles don't produce ".htaccess.html".
function stripKnownExt(name) {
  const re = /\.(md|markdown|txt|html?|pdf)$/i;
  let out = name;
  while (re.test(out)) out = out.replace(re, '');
  return out;
}

const _externalCssCache = new Map();

async function fetchExternalCss(url) {
  if (_externalCssCache.has(url)) return _externalCssCache.get(url);
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    _externalCssCache.set(url, text);
    return text;
  } catch (err) {
    console.warn('Inline CSS fetch failed, falling back to <link>:', url, err);
    _externalCssCache.set(url, null);
    return null;
  }
}

async function inlineStylesheetOrLink(url) {
  const css = await fetchExternalCss(url);
  if (css) return `<style data-mdlab-inlined="${escapeHtml(url)}">${css}</style>`;
  return `<link rel="stylesheet" href="${escapeHtml(url)}">`;
}

// Render every `.mermaid` node that still holds raw source (offscreen / lazy)
// so a downstream export captures inline SVG instead of literal diagram text.
// A diagram counts as "rendered" when data-processed="true" AND contains an
// <svg>, under the current theme. No-op when everything is already ready.
async function ensureAllMermaidRendered() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const all = Array.from(preview.querySelectorAll('.mermaid'));
  const pending = all.filter((el) => {
    const ready = el.getAttribute('data-processed') === 'true'
      && el.getAttribute('data-theme') === theme
      && el.querySelector('svg');
    return !ready;
  });
  if (!pending.length) return;

  const sandbox = ensureMermaidSandbox();
  for (const el of pending) {
    const raw = el.getAttribute('data-mermaid-src');
    const code = raw ? safeDecode(raw) : el.textContent;
    if (!code || !code.trim()) continue;
    if (!el.id) el.id = `mermaid-${++mermaidCounter}`;
    // Detach from any lazy observer so it won't fight us later.
    if (_mermaidLazyObserver) {
      try { _mermaidLazyObserver.unobserve(el); } catch {}
      _mermaidLazyQueue.delete(el);
    }
    await renderOneMermaid({ el, code }, theme, sandbox);
  }
  sandbox.innerHTML = '';
}

async function exportHtml() {
  const title = baseFilename();
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';

  // Force-render any offscreen/unprocessed Mermaid diagrams so the downloaded
  // HTML contains inline SVG (not raw `flowchart LR…` source). The lazy
  // IntersectionObserver path only renders diagrams the user has scrolled
  // near; without this, exports made before scrolling miss those diagrams.
  try {
    await ensureAllMermaidRendered();
  } catch (err) {
    console.warn('Mermaid pre-render for HTML export failed (continuing):', err);
  }

  const temp = document.createElement('div');
  temp.innerHTML = preview.innerHTML;
  temp.querySelectorAll('.code-copy, .code-lang, .diagram-expand').forEach(el => el.remove());
  temp.querySelectorAll('.table-wrap').forEach(w => {
    const t = w.querySelector('table');
    if (t) w.replaceWith(t);
  });

  const bodyHtml = temp.innerHTML;

  const katexUrl = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
  const hljsUrl = `https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/${theme === 'dark' ? 'github-dark' : 'github'}.min.css`;

  const [katexTag, hljsTag] = await Promise.all([
    inlineStylesheetOrLink(katexUrl),
    inlineStylesheetOrLink(hljsUrl),
  ]);

  const html = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${katexTag}
${hljsTag}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {
  --bg: ${theme === 'dark' ? '#0b0d12' : '#ffffff'};
  --text: ${theme === 'dark' ? '#e5e7eb' : '#0f172a'};
  --muted: ${theme === 'dark' ? '#9aa3b2' : '#475569'};
  --accent: ${theme === 'dark' ? '#10b981' : '#0d9488'};
  --border: ${theme === 'dark' ? '#242a38' : '#e5e7ec'};
  --code-bg: ${theme === 'dark' ? '#0d1017' : '#f6f8fa'};
}
body { max-width: 820px; margin: 40px auto; padding: 0 24px; background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 16px; line-height: 1.7; }
h1,h2,h3,h4 { line-height: 1.3; margin: 32px 0 12px; }
h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
a { color: var(--accent); }
code { font-family: 'JetBrains Mono', monospace; font-size: 0.9em; }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; overflow-x: auto; }
pre code { background: transparent; }
:not(pre) > code { padding: 2px 6px; border-radius: 4px; background: var(--code-bg); border: 1px solid var(--border); }
blockquote { border-left: 3px solid var(--accent); padding: 4px 14px; color: var(--muted); background: ${theme === 'dark' ? 'rgba(16,185,129,0.1)' : 'rgba(13,148,136,0.06)'}; border-radius: 0 8px 8px 0; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
thead { background: ${theme === 'dark' ? '#161a23' : '#f1f3f8'}; }
/* YAML frontmatter: two-column key/value table + pill chips for list values.
   Mirrors the live preview's look so exports don't lose the metadata styling. */
table.markdown-frontmatter { border-collapse: separate; border-spacing: 0; margin: 0 0 24px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: ${theme === 'dark' ? '#12161f' : '#fafbfc'}; table-layout: auto; font-size: 14px; }
table.markdown-frontmatter > tbody > tr > th { width: 28%; min-width: 130px; padding: 10px 16px; text-align: right; font-weight: 600; font-size: 12.5px; letter-spacing: 0.02em; color: var(--muted); background: ${theme === 'dark' ? '#1a1f2b' : '#f1f3f8'}; border: 0; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); vertical-align: middle; overflow-wrap: break-word; }
table.markdown-frontmatter > tbody > tr > td { padding: 10px 16px; font-size: 14px; color: var(--text); border: 0; border-bottom: 1px solid var(--border); vertical-align: middle; overflow-wrap: anywhere; }
table.markdown-frontmatter > tbody > tr:last-child > th, table.markdown-frontmatter > tbody > tr:last-child > td { border-bottom: 0; }
table.markdown-frontmatter--nested { margin: 0; border: 1px solid var(--border); border-radius: 6px; background: ${theme === 'dark' ? '#0f1219' : '#ffffff'}; font-size: 13px; }
table.markdown-frontmatter--nested > tbody > tr > th { background: ${theme === 'dark' ? '#151a24' : '#f6f8fa'}; font-size: 12px; }
.frontmatter-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.frontmatter-chip { display: inline-block; padding: 2px 10px; font-size: 12.5px; line-height: 1.55; color: var(--accent); background: ${theme === 'dark' ? 'rgba(16,185,129,0.12)' : 'rgba(13,148,136,0.10)'}; border: 1px solid ${theme === 'dark' ? 'rgba(16,185,129,0.32)' : 'rgba(13,148,136,0.30)'}; border-radius: 999px; white-space: nowrap; }
pre.markdown-frontmatter-raw { border-left: 3px solid #f59e0b; padding: 10px 14px; }
img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); }
.mermaid { text-align: center; background: ${theme === 'dark' ? '#0f1219' : '#fff'}; padding: 20px; border: 1px solid var(--border); border-radius: 8px; margin: 16px 0; }
.markdown-alert { border-left: 4px solid var(--accent); padding: 10px 14px; border-radius: 0 8px 8px 0; margin: 16px 0; }
.markdown-alert-note { border-left-color: #3b82f6; background: rgba(59,130,246,0.08); }
.markdown-alert-tip { border-left-color: #10b981; background: rgba(16,185,129,0.08); }
.markdown-alert-warning { border-left-color: #f59e0b; background: rgba(245,158,11,0.08); }
.markdown-alert-caution { border-left-color: #ef4444; background: rgba(239,68,68,0.08); }
.markdown-alert-important { border-left-color: #8b5cf6; background: rgba(139,92,246,0.08); }
.markdown-alert-title { font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; font-size: 12px; margin-bottom: 4px; }
hr { border: 0; height: 1px; background: var(--border); margin: 32px 0; }
ul.contains-task-list { list-style: none; padding-left: 18px; }
ul.contains-task-list li.task-list-item { position: relative; padding-left: 4px; }
ul.contains-task-list li.task-list-item input[type='checkbox'] { margin-right: 6px; accent-color: var(--accent); }
</style>
</head>
<body>
<article>${bodyHtml}</article>
</body>
</html>`;
  download(html, `${title}.html`, 'text/html');
  showToast('HTML downloaded', 'success');
}

function download(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// PDF export uses a hidden iframe to isolate print CSS, re-render Mermaid
// against the print layout, and avoid printing the parent app chrome.
// The browser's native print() produces a true vector PDF with selectable text.

// A4 (210 mm) − 2 × 14 mm margins = 182 mm ≈ 688 px at 96 dpi.
// If you change @page margin in the print CSS, update this to match.
const PDF_BODY_W_PX = 688;
const PDF_PREP_TIMEOUT_MS = 45000;
const PDF_MSG_ERROR = 'mdlab-pdf-error';
const PDF_MSG_READY = 'mdlab-print-ready';

async function exportPdf() {
  setStatus('busy', 'Building PDF…');
  showToast('Preparing print preview…', 'info');

  const title = baseFilename();
  const html = buildPrintPdfHtml(preview.innerHTML, title);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
  iframe.style.cssText =
    'position:fixed;left:-10000px;top:0;width:794px;height:1123px;' +
    'border:0;visibility:hidden;pointer-events:none;';
  iframe.srcdoc = html;
  document.body.appendChild(iframe);

  // Wait for the iframe to signal it's ready (Mermaid rendered, fonts loaded).
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('PDF prep timed out'));
      }, PDF_PREP_TIMEOUT_MS);
      const onMsg = (e) => {
        if (e.source !== iframe.contentWindow || !e.data) return;
        if (e.data.type === PDF_MSG_READY) {
          clearTimeout(timeout);
          window.removeEventListener('message', onMsg);
          resolve();
        } else if (e.data.type === PDF_MSG_ERROR) {
          clearTimeout(timeout);
          window.removeEventListener('message', onMsg);
          reject(new Error(e.data.error || 'unknown'));
        }
      };
      window.addEventListener('message', onMsg);
    });

    // Native print on the iframe yields a true vector PDF with selectable text.
    const cw = iframe.contentWindow;
    const cleanup = () => { try { iframe.remove(); } catch {} };
    cw.addEventListener('afterprint', cleanup, { once: true });
    // Safety net: if afterprint never fires (e.g. older browsers), remove
    // after 60 s — long enough for the user to finish saving.
    setTimeout(cleanup, 60000);
    cw.print();
    setStatus('ready', 'Rendered');
    showToast('Print dialog opened — choose "Save as PDF"', 'info');
  } catch (err) {
    console.error('PDF export failed:', err);
    setStatus('error', 'PDF export failed');
    statRender.textContent = '\u2014';
    showToast(`PDF export failed — ${err.message || 'see console'}`, 'error');
    try { iframe.remove(); } catch {}
  }
}

function buildPrintPdfHtml(bodyInnerHtml, title) {
  const temp = document.createElement('div');
  temp.innerHTML = bodyInnerHtml;
  resetMermaidNodes(temp.querySelectorAll('.mermaid'));
  temp.querySelectorAll('.code-copy, .code-lang, .diagram-expand').forEach(el => el.remove());
  temp.querySelectorAll('.table-wrap').forEach(w => {
    const t = w.querySelector('table');
    if (t) w.replaceWith(t);
  });

  const lightVars = JSON.stringify(mermaidThemeVars('light'));
  const msgs = JSON.stringify({ ready: PDF_MSG_READY, error: PDF_MSG_ERROR });

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-light.min.css" crossorigin="anonymous">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" crossorigin="anonymous">
<style>
${pdfInlineCss()}
@media print {
  @page { size: A4; margin: 14mm; }
  html, body { margin: 0; padding: 0; }
  article.pdf-body { width: 100%; max-width: 100%; }
  .mermaid svg { max-width: 100%; height: auto; page-break-inside: avoid; break-inside: avoid; }
  pre, table, blockquote, .markdown-alert { page-break-inside: avoid; break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; break-after: avoid; }
}
</style>
</head>
<body>
<article class="pdf-body" id="pdf-body">${temp.innerHTML}</article>
<script type="module">
const MSG = ${msgs};
(async () => {
  const report = (err) => parent.postMessage({ type: MSG.error, error: String(err?.message || err) }, '*');
  try {
    const mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')).default;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: 'Inter, system-ui, sans-serif',
      themeVariables: ${lightVars},
      flowchart:  { curve: 'basis' },
      sequence:   { showSequenceNumbers: false, actorMargin: 50, useMaxWidth: false },
      gantt:      { fontSize: 12, barHeight: 26, barGap: 6, topPadding: 56, leftPadding: 90 },
    });
    const nodes = Array.from(document.querySelectorAll('.mermaid'));
    if (nodes.length) {
      await mermaid.run({ nodes, suppressErrors: false }).catch(e => {
        console.warn('Mermaid render error (some diagrams may be blank):', e);
      });
    }

    // Ensure SVGs have explicit dimensions for print.
    document.querySelectorAll('.mermaid svg').forEach(svg => {
      const bb = svg.getBoundingClientRect();
      if (bb.width)  svg.setAttribute('width',  String(Math.round(bb.width)));
      if (bb.height) svg.setAttribute('height', String(Math.round(bb.height)));
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
    });

    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    // Wait for all images (external <img> tags) to finish loading.
    await Promise.all(Array.from(document.images).map(img =>
      img.complete ? null :
        new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); })
    ));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    parent.postMessage({ type: MSG.ready }, '*');
  } catch (err) {
    report(err);
  }
})();
<\/script>
</body>
</html>`;
}

function pdfInlineCss() {
  return `
html, body { margin: 0; padding: 0; background: #ffffff; color: #0f172a; }
body { font-family: 'Inter', system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
article.pdf-body { padding: 0; width: ${PDF_BODY_W_PX}px; margin: 0 auto; box-sizing: border-box; }
article.pdf-body > *:first-child { margin-top: 0; }
article.pdf-body > *:last-child { margin-bottom: 0; }
h1,h2,h3,h4,h5,h6 { color: #0f172a; font-weight: 700; margin: 22px 0 10px; line-height: 1.3; }
h1 { font-size: 28px; padding-bottom: 6px; border-bottom: 1px solid #e5e7ec; }
h2 { font-size: 22px; padding-bottom: 4px; border-bottom: 1px solid #e5e7ec; }
h3 { font-size: 18px; } h4 { font-size: 15px; } h5 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #475569; } h6 { font-size: 12px; color: #475569; }
p { margin: 0 0 12px; }
a { color: #0d9488; text-decoration: none; border-bottom: 1px dotted currentColor; }
strong { color: #0f172a; font-weight: 700; }
em { font-style: italic; }
del { color: #64748b; }
hr { border: 0; height: 1px; background: #e5e7ec; margin: 24px 0; }
ul, ol { margin: 0 0 14px; padding-left: 26px; }
li { margin-bottom: 4px; }
li > p { margin-bottom: 6px; }
pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; line-height: 1.55; overflow: hidden; white-space: pre-wrap; word-break: break-word; margin: 0 0 14px; }
code:not(pre > code) { background: #eef1f6; border: 1px solid #d0d7de; border-radius: 4px; padding: 1px 5px; font-family: 'JetBrains Mono', monospace; font-size: 0.87em; color: #be185d; }
pre code { background: transparent; border: 0; padding: 0; color: inherit; font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; border: 1px solid #d6dae3; border-radius: 6px; overflow: hidden; table-layout: auto; }
th, td { padding: 8px 12px; border-bottom: 1px solid #e5e7ec; text-align: left; font-size: 13px; vertical-align: top; word-break: break-word; }
thead { background: #f1f3f8; }
tr:last-child td { border-bottom: 0; }
/* YAML frontmatter table (mirrors screen styles; simplified for print) */
table.markdown-frontmatter { margin: 0 0 18px; border: 1px solid #d6dae3; border-radius: 8px; background: #fafbfc; table-layout: auto; page-break-inside: avoid; break-inside: avoid; }
table.markdown-frontmatter > tbody > tr > th { width: 28%; min-width: 120px; padding: 8px 14px; text-align: right; font-weight: 600; font-size: 12px; color: #475569; background: #f1f3f8; border-right: 1px solid #e5e7ec; border-bottom: 1px solid #e5e7ec; vertical-align: middle; overflow-wrap: break-word; }
table.markdown-frontmatter > tbody > tr > td { padding: 8px 14px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e5e7ec; vertical-align: middle; overflow-wrap: anywhere; }
table.markdown-frontmatter > tbody > tr:last-child > th, table.markdown-frontmatter > tbody > tr:last-child > td { border-bottom: 0; }
table.markdown-frontmatter--nested { margin: 0; border: 1px solid #e5e7ec; border-radius: 4px; background: #ffffff; font-size: 12px; }
table.markdown-frontmatter--nested > tbody > tr > th { background: #f6f8fa; font-size: 11.5px; }
.frontmatter-chips { display: block; line-height: 1.9; }
.frontmatter-chip { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 9px; font-size: 12px; line-height: 1.55; color: #0d9488; background: rgba(13,148,136,0.10); border: 1px solid rgba(13,148,136,0.30); border-radius: 999px; white-space: nowrap; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
pre.markdown-frontmatter-raw { background: #f6f8fa; border: 1px solid #d0d7de; border-left: 3px solid #f59e0b; border-radius: 6px; padding: 10px 12px; font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 0 0 14px; }
blockquote { margin: 0 0 14px; padding: 6px 14px; border-left: 3px solid #0d9488; background: rgba(13,148,136,0.06); border-radius: 0 6px 6px 0; color: #334155; }
blockquote > :first-child { margin-top: 8px; }
blockquote > :last-child { margin-bottom: 8px; }
.markdown-alert { border-left: 4px solid #0d9488; padding: 10px 14px; margin: 12px 0; border-radius: 0 6px 6px 0; background: rgba(13,148,136,0.06); }
.markdown-alert-note     { border-left-color: #3b82f6; background: rgba(59,130,246,0.08); }
.markdown-alert-tip      { border-left-color: #10b981; background: rgba(16,185,129,0.08); }
.markdown-alert-warning  { border-left-color: #f59e0b; background: rgba(245,158,11,0.08); }
.markdown-alert-caution  { border-left-color: #ef4444; background: rgba(239,68,68,0.08); }
.markdown-alert-important{ border-left-color: #8b5cf6; background: rgba(139,92,246,0.08); }
.markdown-alert-title { font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; margin-bottom: 4px; color: #0f172a; display: flex; align-items: center; gap: 6px; }
.mermaid { text-align: center; background: #ffffff; padding: 14px; border: 1px solid #d6dae3; border-radius: 6px; margin: 12px 0; }
.mermaid svg { max-width: 100%; height: auto; display: inline-block; }
.mermaid img { max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 0; } /* fallback if Mermaid emits <img> */
img { max-width: 100%; height: auto; border-radius: 6px; }
kbd { display: inline-block; padding: 1px 5px; font-family: 'JetBrains Mono', monospace; font-size: 0.82em; background: #eef1f6; border: 1px solid #cfd4df; border-bottom-width: 2px; border-radius: 4px; color: #0f172a; }
input[type='checkbox'] { accent-color: #0d9488; }
.hljs { background: transparent !important; padding: 0 !important; }
.katex-display { margin: 14px 0; overflow: hidden; }
.footnotes { margin-top: 28px; padding-top: 14px; border-top: 1px solid #e5e7ec; font-size: 13px; color: #475569; }
`;
}

function clearDoc() {
  if (!editor.value || confirm('Clear the current document?')) {
    editor.value = '';
    invalidateRenderCache();
    const f = Store.activeFile();
    if (f) {
      markDirty(f.id);
      scheduleSaveForFile(f.id);
    }
    safeUpdateGutter();
    scheduleRender();
    showToast('Cleared', 'info');
  }
}

let _findBarBuilt = false;
// Cap total matches to guard against catastrophic regex (e.g. `.*`) on a
// multi-MB doc. Shared by source, preview, and mirror scans.
const FIND_CAP = 5000;
let _findState = {
  // Source-side match list (authoritative). `index` points into this.
  // Each entry: { start, end, previewMark, hiddenIn } where previewMark
  // is the <mark> wrapper in the preview — or null when the match sits
  // inside a hidden region (mermaid fence, raw HTML, comment, math).
  matches: [],
  previewMarks: [], // flat list of <mark> wrappers, for bulk clear
  editorMarks: [],  // <span.editor-hl> overlays in the mirror, parallel to matches
  index: -1,
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  replaceMode: false,
};

// Find-as-you-type debounce; module-scoped so closeFindBar can cancel pending scans.
let _findDebounceTimer = 0;

function isFindBarOpen() {
  return !!document.getElementById('find-bar')?.classList.contains('is-open');
}

// Preview is visible in every view except editor-only.
function isPreviewVisibleForFind() {
  const v = document.getElementById('panes')?.dataset?.view;
  return v !== 'editor';
}
function isEditorVisibleForFind() {
  const v = document.getElementById('panes')?.dataset?.view;
  return v !== 'preview';
}

function ensureFindBar() {
  if (_findBarBuilt) return;
  _findBarBuilt = true;
  const bar = document.createElement('div');
  bar.className = 'find-bar';
  bar.id = 'find-bar';
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', 'Find and replace');
  bar.innerHTML = `
    <button type="button" class="find-bar__expand" data-find-action="toggle-replace" aria-label="Toggle replace" aria-expanded="false" title="Toggle replace (Ctrl/Cmd+H)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
    </button>
    <div class="find-bar__rows">
      <div class="find-bar__row">
        <div class="find-bar__field">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="find-bar__input" id="find-input" placeholder="Find" aria-label="Find" spellcheck="false" autocomplete="off" />
          <span class="find-bar__count" id="find-count" aria-live="polite" aria-atomic="true">0 / 0</span>
        </div>
        <div class="find-bar__toggles" role="group" aria-label="Search options">
          <button type="button" class="find-bar__toggle" data-find-toggle="case" aria-pressed="false" title="Match case (Alt+C)">Aa</button>
          <button type="button" class="find-bar__toggle" data-find-toggle="word" aria-pressed="false" title="Whole word (Alt+W)">W</button>
          <button type="button" class="find-bar__toggle" data-find-toggle="regex" aria-pressed="false" title="Regular expression (Alt+R)">.*</button>
        </div>
        <div class="find-bar__controls">
          <button type="button" class="find-bar__btn" data-find-action="prev" aria-label="Previous match" title="Previous (Shift+Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button type="button" class="find-bar__btn" data-find-action="next" aria-label="Next match" title="Next (Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button type="button" class="find-bar__btn find-bar__close" data-find-action="close" aria-label="Close find bar" title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
      <div class="find-bar__row find-bar__row--replace">
        <div class="find-bar__field">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="21 7 13 15 9 11"/></svg>
          <input type="text" class="find-bar__input" id="find-replace-input" placeholder="Replace" aria-label="Replace" spellcheck="false" autocomplete="off" />
        </div>
        <div class="find-bar__controls">
          <button type="button" class="find-bar__btn find-bar__btn--text" data-find-action="replace" title="Replace (Enter)">Replace</button>
          <button type="button" class="find-bar__btn find-bar__btn--text" data-find-action="replace-all" title="Replace all (Ctrl/Cmd+Enter)">Replace all</button>
        </div>
      </div>
      <div class="find-bar__hint" id="find-hidden-hint" role="status" aria-live="polite">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="find-bar__hint-text"></span>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  // Replace row animates open/closed via max-height + opacity. `inert`
  // keeps collapsed inputs off the tab order; syncReplaceToggleAria flips
  // it alongside the is-replace class.
  const replaceRow = bar.querySelector('.find-bar__row--replace');
  if (replaceRow) replaceRow.inert = true;

  const input = bar.querySelector('#find-input');
  const replaceInput = bar.querySelector('#find-replace-input');

  // 80ms debounce: under typing-feedback threshold, collapses key bursts into one scan.
  const scheduleRunFind = (val) => {
    clearTimeout(_findDebounceTimer);
    _findDebounceTimer = setTimeout(() => runFind(val), 80);
  };
  input.addEventListener('input', () => scheduleRunFind(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Flush pending scan before navigating so matches reflect the current query.
      if (_findDebounceTimer) {
        clearTimeout(_findDebounceTimer);
        _findDebounceTimer = 0;
        runFind(input.value);
      }
      if (e.shiftKey) gotoMatch(-1);
      else gotoMatch(1);
    }
    if (e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); toggleFindOption('case'); }
    if (e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); toggleFindOption('word'); }
    if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); toggleFindOption('regex'); }
  });

  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) replaceAll();
      else replaceCurrent();
    }
  });

  bar.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-find-toggle]');
    if (toggle) { toggleFindOption(toggle.dataset.findToggle); return; }
    const action = e.target.closest('[data-find-action]');
    if (!action) return;
    switch (action.dataset.findAction) {
      case 'prev': gotoMatch(-1); break;
      case 'next': gotoMatch(1); break;
      case 'toggle-replace': toggleReplaceMode(); break;
      case 'replace': replaceCurrent(); break;
      case 'replace-all': replaceAll(); break;
      case 'close': closeFindBar(); break;
    }
  });
}

function openFindBar({ replace = false } = {}) {
  ensureFindBar();
  const bar = document.getElementById('find-bar');
  const input = document.getElementById('find-input');
  _findState.replaceMode = !!replace;
  bar.classList.toggle('is-replace', _findState.replaceMode);
  syncReplaceToggleAria();
  bar.classList.add('is-open');
  const selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (selection && !selection.includes('\n')) {
    input.value = selection;
  }
  input.focus();
  input.select();
  runFind(input.value);
}

function closeFindBar() {
  const bar = document.getElementById('find-bar');
  if (!bar) return;
  bar.classList.remove('is-open');
  // Cancel in-flight debounced scan so it doesn't repaint marks post-close.
  if (_findDebounceTimer) {
    clearTimeout(_findDebounceTimer);
    _findDebounceTimer = 0;
  }
  _findState.matches = [];
  _findState.previewMarks = [];
  _findState.editorMarks = [];
  _findState.index = -1;
  clearFindHighlight();
  updateFindHint(null);
  updateFindCount();
  editor.focus();
}

function toggleReplaceMode() {
  _findState.replaceMode = !_findState.replaceMode;
  const bar = document.getElementById('find-bar');
  bar?.classList.toggle('is-replace', _findState.replaceMode);
  syncReplaceToggleAria();
  if (_findState.replaceMode) {
    document.getElementById('find-replace-input')?.focus();
  } else {
    // Pull focus back so repeated toggles don't strand it on a hidden button.
    document.getElementById('find-input')?.focus();
  }
}

// Keep aria-expanded + inert aligned with the is-replace class.
function syncReplaceToggleAria() {
  const btn = document.querySelector('.find-bar__expand');
  btn?.setAttribute('aria-expanded', String(_findState.replaceMode));
  const replaceRow = document.querySelector('.find-bar__row--replace');
  if (replaceRow) replaceRow.inert = !_findState.replaceMode;
}

function toggleFindOption(name) {
  if (name === 'case') _findState.caseSensitive = !_findState.caseSensitive;
  if (name === 'word') _findState.wholeWord = !_findState.wholeWord;
  if (name === 'regex') _findState.regex = !_findState.regex;
  const bar = document.getElementById('find-bar');
  bar?.querySelectorAll('[data-find-toggle]').forEach(btn => {
    const kind = btn.dataset.findToggle;
    const on = (kind === 'case' && _findState.caseSensitive) ||
               (kind === 'word' && _findState.wholeWord) ||
               (kind === 'regex' && _findState.regex);
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-active', on);
  });
  runFind(document.getElementById('find-input')?.value ?? '');
}

function buildFindRegex(query) {
  if (!query) return null;
  try {
    if (_findState.regex) {
      return new RegExp(query, _findState.caseSensitive ? 'g' : 'gi');
    }
    let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (_findState.wholeWord) escaped = `\\b${escaped}\\b`;
    return new RegExp(escaped, _findState.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function runFind(query) {
  // Clean slate — avoid double-wrapping and stale --active classes.
  clearFindHighlight();
  _findState.matches = [];
  _findState.previewMarks = [];
  _findState.editorMarks = [];

  const re = buildFindRegex(query);
  if (!re) {
    _findState.index = -1;
    updateFindCount(!!query);
    return;
  }

  // Source scan is authoritative. Fresh regex instance — g-flag carries
  // lastIndex across calls.
  const src = editor.value;
  const srcRe = new RegExp(re.source, re.flags);
  let m;
  while ((m = srcRe.exec(src)) !== null) {
    if (m[0].length === 0) { srcRe.lastIndex++; continue; }
    _findState.matches.push({
      start: m.index,
      end: m.index + m[0].length,
      previewMark: null,
      hiddenIn: null,
    });
    if (_findState.matches.length >= FIND_CAP) break;
  }

  const previewVisible = isPreviewVisibleForFind();
  if (previewVisible) {
    _findState.previewMarks = highlightInPreview(new RegExp(re.source, re.flags));
    // Source-match order and preview-mark order both follow document order.
    // Walk in lockstep, tagging source matches that fall inside hidden
    // regions (mermaid / raw HTML / comment / math) instead of a <mark>.
    const hidden = computePreviewHiddenRanges(src);
    let pi = 0;
    for (const match of _findState.matches) {
      const containing = hidden.length ? findContainingRange(match.start, hidden) : null;
      if (containing) {
        match.hiddenIn = containing;
        continue;
      }
      if (pi >= _findState.previewMarks.length) break;
      match.previewMark = _findState.previewMarks[pi++];
    }
  }

  const editorVisible = isEditorVisibleForFind();
  if (editorVisible) {
    _findState.editorMarks = highlightInEditorMirror(new RegExp(re.source, re.flags));
  }

  if (_findState.matches.length === 0) {
    _findState.index = -1;
    updateFindCount();
    return;
  }

  // Initial active match: first at/after caret when editor is visible;
  // first preview-visible match below viewport top in preview-only view.
  if (editorVisible) {
    const caret = editor.selectionStart;
    let idx = _findState.matches.findIndex(mm => mm.start >= caret);
    if (idx === -1) idx = 0;
    _findState.index = idx;
  } else if (previewWrap) {
    const threshold = previewWrap.getBoundingClientRect().top + 4;
    let idx = _findState.matches.findIndex(mm =>
      mm.previewMark && mm.previewMark.getBoundingClientRect().top >= threshold
    );
    if (idx === -1) idx = _findState.matches.findIndex(mm => !!mm.previewMark);
    if (idx === -1) idx = 0;
    _findState.index = idx;
  } else {
    _findState.index = 0;
  }

  updateFindCount();
  scrollToCurrentMatch();
}

// Source ranges that produce no rendered preview text. Typed so the UI
// can explain WHY a match isn't visible and — for mermaid/katex — locate
// the corresponding element in the preview DOM.
function computePreviewHiddenRanges(src) {
  const ranges = [];
  let m;

  // Fenced mermaid blocks. mermaidIdx maps to the Nth `.mermaid` in preview.
  const mermaidRe = /^([`~]{3,})[ \t]*mermaid\b[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;
  let mermaidIdx = 0;
  while ((m = mermaidRe.exec(src)) !== null) {
    ranges.push({
      start: m.index,
      end: m.index + m[0].length,
      type: 'mermaid',
      mermaidIdx: mermaidIdx++,
    });
  }

  // Raw HTML blocks with no rendered text.
  const rawRe = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  while ((m = rawRe.exec(src)) !== null) {
    ranges.push({
      start: m.index,
      end: m.index + m[0].length,
      type: 'rawhtml',
      tag: m[1].toLowerCase(),
    });
  }

  // HTML comments — sanitized out of preview.
  const cmtRe = /<!--[\s\S]*?-->/g;
  while ((m = cmtRe.exec(src)) !== null) {
    ranges.push({
      start: m.index,
      end: m.index + m[0].length,
      type: 'comment',
    });
  }

  // Math regions from the last render. Matches inside $…$ / $$…$$ can't
  // be wrapped in preview (the walker rejects .katex), so treat them as
  // hidden: scroll to the Nth .katex span and show the "inside math" hint.
  if (_lastMathSrc === src) {
    let katexIdx = 0;
    for (const r of _lastMathRanges) {
      ranges.push({
        start: r.start,
        end: r.end,
        type: 'katex',
        katexIdx: katexIdx++,
        display: r.display,
      });
    }
  }

  return ranges;
}

// Linear scan — FIND_CAP bounds the hit count and real docs have < 20 ranges.
function findContainingRange(offset, ranges) {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return r;
  }
  return null;
}

function gotoMatch(dir) {
  const total = _findState.matches.length;
  if (total === 0) return;
  _findState.index = (_findState.index + dir + total) % total;
  updateFindCount();
  scrollToCurrentMatch();
}

function scrollToCurrentMatch() {
  const active = _findState.matches[_findState.index];
  if (!active) { updateFindHint(null); return; }
  const previewVisible = isPreviewVisibleForFind();
  const editorVisible = isEditorVisibleForFind();

  // Editor mirror: clear all --active, activate the current one. The
  // scan may have been capped, so editorMarks[index] can be undefined.
  if (editorVisible && _findState.editorMarks.length > 0) {
    for (const sp of _findState.editorMarks) sp.classList.remove('editor-hl--active');
    _findState.editorMarks[_findState.index]?.classList.add('editor-hl--active');
  }

  // Preview: clear --active, then one of three paths:
  //   1. Match has a <mark>        -> scroll + activate it.
  //   2. Match is in mermaid/katex -> scroll to the corresponding diagram.
  //   3. Match is in script/comment -> interpolate between neighbours.
  // The hint row only appears in preview-only view; split/editor already
  // show the match in the mirror, so the hint would be noise.
  if (previewVisible) {
    for (const mk of _findState.previewMarks) mk.classList.remove('find-match--active');
    if (active.previewMark) {
      scrollPreviewToElement(active.previewMark, true);
      updateFindHint(null);
    } else if (active.hiddenIn) {
      const target = resolveHiddenPreviewTarget(active);
      if (target instanceof Element) scrollPreviewToElement(target, false);
      else if (typeof target === 'number' && previewWrap) {
        try { takeScroll('preview'); } catch {}
        const max = Math.max(0, previewWrap.scrollHeight - previewWrap.clientHeight);
        previewWrap.scrollTop = Math.max(0, Math.min(max, target));
      }
      updateFindHint(editorVisible ? null : active.hiddenIn);
    } else {
      updateFindHint(null);
    }
  } else {
    updateFindHint(null);
  }

  // Always mirror the active match in the textarea selection so the caret
  // lands correctly when the find bar closes. Don't focus() — that would
  // steal from the find input.
  try {
    editor.selectionStart = active.start;
    editor.selectionEnd = active.end;
  } catch {}

  if (editorVisible) {
    const line = editor.value.slice(0, active.start).split('\n').length - 1;
    const targetTop = Math.max(0, (lineTops[line] ?? 0) - 120);
    try { takeScroll('editor'); } catch {}
    editor.scrollTop = targetTop;
    syncGutterToEditor();
    syncEditorMirrorScroll();
  }
}

// Centre `el` inside previewWrap via manual scrollTop math (scrollIntoView
// also scrolls body on some browsers). `activate` toggles .find-match--active
// for <mark> targets and is skipped for mermaid/katex containers.
function scrollPreviewToElement(el, activate) {
  if (!previewWrap || !el) return;
  if (activate && el.classList.contains('find-match')) {
    el.classList.add('find-match--active');
  }
  const wrapRect = previewWrap.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const offset = elRect.top - wrapRect.top;
  const centerAdjust = wrapRect.height / 2 - elRect.height / 2;
  const target = previewWrap.scrollTop + offset - centerAdjust;
  const max = Math.max(0, previewWrap.scrollHeight - previewWrap.clientHeight);
  try { takeScroll('preview'); } catch {}
  previewWrap.scrollTop = Math.max(0, Math.min(max, target));
}

// Resolve the preview scroll target for a hidden match:
//   - Mermaid/KaTeX: the Nth element of that type (Element).
//   - Script/comment: interpolated between visible neighbours (number).
//   - None available: null.
function resolveHiddenPreviewTarget(match) {
  if (!previewWrap) return null;

  if (match.hiddenIn?.type === 'mermaid') {
    const nodes = preview?.querySelectorAll('.mermaid');
    if (nodes && nodes[match.hiddenIn.mermaidIdx]) return nodes[match.hiddenIn.mermaidIdx];
    // Not rendered yet — fall through to neighbour interpolation.
  }

  if (match.hiddenIn?.type === 'katex') {
    // .katex = success, .katex-error = parse failure. Both appear in
    // document order, one per source math region.
    const nodes = preview?.querySelectorAll('.katex, .katex-error');
    if (nodes && nodes[match.hiddenIn.katexIdx]) return nodes[match.hiddenIn.katexIdx];
  }

  // Nearest visible neighbours by source offset.
  const matches = _findState.matches;
  const i = _findState.index;
  let before = null;
  for (let j = i - 1; j >= 0; j--) {
    if (matches[j].previewMark) { before = matches[j]; break; }
  }
  let after = null;
  for (let j = i + 1; j < matches.length; j++) {
    if (matches[j].previewMark) { after = matches[j]; break; }
  }

  const wrapRect = previewWrap.getBoundingClientRect();
  const scrollTopOf = (el) => {
    const r = el.getBoundingClientRect();
    return previewWrap.scrollTop + (r.top - wrapRect.top) - (wrapRect.height / 2);
  };

  if (before && after) {
    const y1 = scrollTopOf(before.previewMark);
    const y2 = scrollTopOf(after.previewMark);
    const span = (after.start - before.start) || 1;
    const frac = (match.start - before.start) / span;
    return y1 + frac * (y2 - y1);
  }
  if (before) return scrollTopOf(before.previewMark);
  if (after) return scrollTopOf(after.previewMark);
  return null;
}

// Show/hide the "hidden in preview" hint row. Only relevant in preview-only
// view — when editor/mirror is visible, the mirror already shows the match.
function updateFindHint(hiddenIn) {
  const hint = document.getElementById('find-hidden-hint');
  if (!hint) return;
  if (!hiddenIn) {
    hint.classList.remove('is-visible');
    return;
  }
  const label = hint.querySelector('.find-bar__hint-text');
  if (label) {
    const where = hiddenIn.type === 'mermaid'
      ? 'a Mermaid diagram'
      : hiddenIn.type === 'katex'
        ? 'a math expression'
        : hiddenIn.type === 'rawhtml'
          ? `a <${hiddenIn.tag}> block`
          : 'an HTML comment';
    label.textContent = `Match is inside ${where}. Switch to editor or split view to see it.`;
  }
  hint.classList.add('is-visible');
}

// Shared core for both highlighters. Scans `text` for `re`, builds a
// fragment interleaving plain text with wrapper elements, and appends
// each wrapper to `collector`. Returns { frag, capReached } — `frag` is
// null when `text` had no matches.
function buildHighlightFragment(text, re, makeWrapper, collector) {
  const localRe = new RegExp(re.source, re.flags);
  const ranges = [];
  let m;
  while ((m = localRe.exec(text)) !== null) {
    if (m[0].length === 0) { localRe.lastIndex++; continue; }
    ranges.push({ start: m.index, end: m.index + m[0].length });
    if (collector.length + ranges.length >= FIND_CAP) break;
  }
  if (ranges.length === 0) return { frag: null, capReached: false };

  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) {
      frag.appendChild(document.createTextNode(text.slice(cursor, r.start)));
    }
    const el = makeWrapper(text.slice(r.start, r.end));
    frag.appendChild(el);
    collector.push(el);
    cursor = r.end;
  }
  if (cursor < text.length) {
    frag.appendChild(document.createTextNode(text.slice(cursor)));
  }
  return { frag, capReached: collector.length >= FIND_CAP };
}

// Wrap regex hits in preview with <mark class="find-match">. Skips script/style/
// noscript, SVG (breaks Mermaid), KaTeX (htmlAndMathml output doubles up), and
// existing find-match wrappers.
function highlightInPreview(re) {
  if (!preview) return [];
  const marks = [];
  const textNodes = [];
  const walker = document.createTreeWalker(
    preview,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const val = node.nodeValue;
        if (!val || !val.length) return NodeFilter.FILTER_REJECT;
        if (!/\S/.test(val)) return NodeFilter.FILTER_REJECT;
        let p = node.parentNode;
        while (p && p !== preview) {
          if (p.nodeType === 1) {
            const tag = p.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
            if (p.namespaceURI === 'http://www.w3.org/2000/svg') return NodeFilter.FILTER_REJECT;
            if (p.classList) {
              if (p.classList.contains('find-match')) return NodeFilter.FILTER_REJECT;
              if (p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
              if (p.classList.contains('katex-error')) return NodeFilter.FILTER_REJECT;
            }
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  // Collect up-front — mutating during the walk invalidates the cursor.
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const makeMark = (matched) => {
    const mark = document.createElement('mark');
    mark.className = 'find-match';
    mark.textContent = matched;
    return mark;
  };

  for (const node of textNodes) {
    const { frag, capReached } = buildHighlightFragment(node.nodeValue, re, makeMark, marks);
    if (frag) node.parentNode?.replaceChild(frag, node);
    if (capReached) break;
  }
  return marks;
}

// Paint find-match overlays into the editor mirror. Mirror holds one
// <div> per source line. Returned spans are in document order so that
// editorMarks[i] aligns with _findState.matches[i].
function highlightInEditorMirror(re) {
  if (!editorMirror) return [];
  clearEditorMirrorHighlights();

  const lines = editor.value.split('\n');
  const lineDivs = editorMirror.children;
  // The mirror must already be rebuilt against the current source.
  if (lineDivs.length !== lines.length) return [];

  const spans = [];
  const makeSpan = (matched) => {
    const span = document.createElement('span');
    span.className = 'editor-hl';
    span.textContent = matched;
    return span;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!text) continue;
    const { frag, capReached } = buildHighlightFragment(text, re, makeSpan, spans);
    if (frag) lineDivs[i].replaceChildren(frag);
    if (capReached) break;
  }
  return spans;
}

function clearFindHighlight() {
  clearPreviewHighlights();
  clearEditorMirrorHighlights();
}

// Unwrap all `selector` elements under `root`, moving their children up
// and re-joining split text nodes.
function unwrapMatches(root, selector) {
  const nodes = root.querySelectorAll(selector);
  if (nodes.length === 0) return;
  const parents = new Set();
  nodes.forEach(node => {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
    parents.add(parent);
  });
  parents.forEach(p => { try { p.normalize(); } catch {} });
}

function clearPreviewHighlights() {
  if (!preview) return;
  unwrapMatches(preview, 'mark.find-match');
  _findState.previewMarks = [];
}

function clearEditorMirrorHighlights() {
  if (!editorMirror) return;
  unwrapMatches(editorMirror, '.editor-hl');
  _findState.editorMarks = [];
}

function updateFindCount(invalid = false) {
  const label = document.getElementById('find-count');
  const input = document.getElementById('find-input');
  if (!label || !input) return;
  const q = input.value;
  if (!q) {
    label.textContent = '0 / 0';
    input.classList.remove('is-invalid', 'is-no-match');
    updateFindHint(null);
    return;
  }
  if (invalid) {
    label.textContent = '\u2014';
    input.classList.add('is-invalid');
    input.classList.remove('is-no-match');
    updateFindHint(null);
    return;
  }
  // Source count is the true count; the hint row (not the count) flags
  // matches inside hidden regions.
  const n = _findState.matches.length;
  label.textContent = n === 0 ? '0 / 0' : `${_findState.index + 1} / ${n}`;
  input.classList.remove('is-invalid');
  input.classList.toggle('is-no-match', n === 0);
  if (n === 0) updateFindHint(null);
}

// Clear highlights + match state. Called after a replace or any edit —
// runFind() would paint stale DOM before render() settles; render's hook
// re-runs find once the preview is fresh.
function resetFindAfterEdit() {
  clearFindHighlight();
  _findState.matches = [];
  _findState.previewMarks = [];
  _findState.editorMarks = [];
  _findState.index = -1;
  updateFindCount();
}

function replaceCurrent() {
  if (_findState.matches.length === 0) return;
  const m = _findState.matches[_findState.index];
  if (!m) return;
  const replacement = document.getElementById('find-replace-input')?.value ?? '';

  // Noop replacement (target text already equals replacement): advance
  // instead so repeated clicks don't feel dead.
  if (editor.value.slice(m.start, m.end) === replacement) { gotoMatch(1); return; }

  // Prefer execCommand('insertText') so the edit lands on the native
  // undo stack. It's deprecated but still the only pre-InputEvent API
  // that reliably preserves undo on textareas. Falls back to a direct
  // value assignment if blocked (which breaks undo).
  const prevFocus = document.activeElement;
  let ok = false;
  try {
    editor.focus();
    editor.setSelectionRange(m.start, m.end);
    ok = document.execCommand('insertText', false, replacement);
  } catch { ok = false; }

  if (!ok) {
    const oldValue = editor.value;
    editor.value = oldValue.slice(0, m.start) + replacement + oldValue.slice(m.end);
    const cursor = m.start + replacement.length;
    try { editor.selectionStart = editor.selectionEnd = cursor; } catch {}
    editor.dispatchEvent(new Event('input'));
  }

  // Restore focus so the user can keep hammering Enter in the replace input.
  if (prevFocus && prevFocus !== editor) { try { prevFocus.focus(); } catch {} }
  resetFindAfterEdit();
}

function replaceAll() {
  if (_findState.matches.length === 0) return;
  const q = document.getElementById('find-input')?.value || '';
  const rawReplacement = document.getElementById('find-replace-input')?.value ?? '';
  const re = buildFindRegex(q);
  if (!re) return;
  // Literal mode: escape `$` so `$&`, `$1`, `$$` aren't read as tokens.
  const replacement = _findState.regex ? rawReplacement : rawReplacement.replace(/\$/g, '$$$$');
  const count = _findState.matches.length;
  const oldValue = editor.value;
  const newValue = oldValue.replace(re, replacement);
  const toastMsg = `Replaced ${count} occurrence${count === 1 ? '' : 's'}`;
  if (newValue === oldValue) {
    // Self-replacement — doc unchanged, keep state intact.
    showToast(toastMsg, 'success');
    return;
  }

  // Select-all + insertText so the whole replace is a single undo entry.
  // Direct value assignment would break undo.
  const prevFocus = document.activeElement;
  let ok = false;
  try {
    editor.focus();
    editor.setSelectionRange(0, oldValue.length);
    ok = document.execCommand('insertText', false, newValue);
  } catch { ok = false; }

  if (!ok) {
    editor.value = newValue;
    editor.dispatchEvent(new Event('input'));
  }

  if (prevFocus && prevFocus !== editor) { try { prevFocus.focus(); } catch {} }
  resetFindAfterEdit();
  showToast(toastMsg, 'success');
}

function registerKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const sc = document.getElementById('shortcuts-overlay');
      if (sc?.classList.contains('is-open')) { e.preventDefault(); hideShortcuts(); return; }
      const am = document.getElementById('about-modal');
      if (am?.classList.contains('is-open')) { e.preventDefault(); hideAbout(); return; }
      if (document.getElementById('palette')?.classList.contains('is-open')) {
        e.preventDefault(); closePalette(); return;
      }
      const findBar = document.getElementById('find-bar');
      if (findBar?.classList.contains('is-open')) {
        e.preventDefault(); closeFindBar(); return;
      }
      // Lightbox handles its own Escape; don't also exit focus mode.
      if (lightbox.root?.classList.contains('is-open')) return;
      if (document.body.classList.contains('is-focus')) { e.preventDefault(); exitFocus(); return; }
    }

    if (e.key === '?' && !isTypingTarget(e.target)) {
      e.preventDefault(); toggleShortcuts(); return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && !e.altKey) {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }

    // F3 / Cmd+G / Ctrl+G — next match (Shift = previous). Only active
    // while the find bar is open; pass through otherwise.
    if (e.key === 'F3' || ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G') && !e.altKey)) {
      if (isFindBarOpen()) {
        e.preventDefault();
        gotoMatch(e.shiftKey ? -1 : 1);
        document.getElementById('find-input')?.focus();
        return;
      }
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    const inEditor = e.target === editor;

    if ((e.key === 'f' || e.key === 'F') && !e.altKey) {
      if (e.shiftKey) {
        e.preventDefault(); openFindBar({ replace: true }); return;
      }
      e.preventDefault(); openFindBar({ replace: false }); return;
    }
    if ((e.key === 'h' || e.key === 'H') && !e.altKey && !e.shiftKey) {
      e.preventDefault(); openFindBar({ replace: true }); return;
    }

    if ((e.key === 'k' || e.key === 'K')) {
      if (e.shiftKey) { e.preventDefault(); btnTheme.click(); return; }
      if (inEditor) return;
      e.preventDefault(); btnTheme.click(); return;
    }
    if ((e.key === 'b' || e.key === 'B')) {
      if (e.shiftKey) { e.preventDefault(); toggleSidebar(); return; }
      if (inEditor) return;
      e.preventDefault(); toggleSidebar(); return;
    }
    if ((e.key === 'i' || e.key === 'I') && inEditor) return;

    if (e.key === '.') { e.preventDefault(); toggleFocus(); return; }
    if (e.key === '1') { e.preventDefault(); setView('editor'); return; }
    if (e.key === '2') { e.preventDefault(); setView('split'); return; }
    if (e.key === '3') { e.preventDefault(); setView('preview'); return; }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); exportMd(); return; }
    if (e.key === 'o' || e.key === 'O') { e.preventDefault(); fileInput.click(); return; }
    if (e.key === '/') { e.preventDefault(); toggleShortcuts(); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); openPalette(); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newFileInActive(); return; }
    if (e.key === 'w' || e.key === 'W') {
      if (Store.activeId) {
        e.preventDefault();
        if (Store.dirty.has(Store.activeId)) {
          const f = Store.activeFile();
          if (!confirm(`"${f?.name}" has unsaved changes. Close anyway?`)) return;
        }
        storeCloseFile(Store.activeId).then(() => {
          if (Store.activeId) switchToFile(Store.activeId);
          else resetEditorWhenNoTabs();
        });
      }
      return;
    }
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      const isOn = toc?.dataset.collapsed !== 'true';
      applyTocToggle(!isOn);
      return;
    }
  });
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function showToast(message, variant = 'info') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.variant = variant;
  toast.classList.add('is-show');
  toastTimer = setTimeout(() => toast.classList.remove('is-show'), 2200);
}

let _undoToastTimer = 0;
let _undoSnapshot = null;

function showUndoableDeleteToast({ snapshot, message }) {
  if (!snapshot) return;
  _undoSnapshot = snapshot;
  clearTimeout(toastTimer);
  clearTimeout(_undoToastTimer);
  toast.dataset.variant = 'info';
  toast.classList.add('is-show', 'has-action');
  toast.textContent = '';
  const label = document.createElement('span');
  label.className = 'toast__label';
  label.textContent = message;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'toast__action';
  undo.textContent = 'Undo';
  undo.addEventListener('click', async () => {
    const snap = _undoSnapshot;
    _undoSnapshot = null;
    clearTimeout(_undoToastTimer);
    toast.classList.remove('is-show', 'has-action');
    if (!snap) return;
    try {
      if (snap.kind === 'file') {
        const restored = await restoreFile(snap);
        if (restored) {
          if (snap.wasOpen) await switchToFile(restored.id);
          showToast(`Restored "${restored.name}"`, 'success');
        }
      } else if (snap.kind === 'project') {
        await restoreProject(snap);
        if (snap.activeId && Store.files.has(snap.activeId)) {
          await switchToFile(snap.activeId);
        }
        showToast(`Restored project "${snap.project.name}"`, 'success');
      }
    } catch (err) {
      console.error('Undo failed', err);
      showToast('Could not restore — see console', 'error');
    }
  });
  toast.appendChild(label);
  toast.appendChild(undo);
  _undoToastTimer = setTimeout(() => {
    toast.classList.remove('is-show', 'has-action');
    _undoSnapshot = null;
  }, 7000);
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <div class="empty-state__art" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="72" height="72">
          <defs>
            <linearGradient id="empty-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="var(--accent-a)"/>
              <stop offset="1" stop-color="var(--accent-b)"/>
            </linearGradient>
          </defs>
          <rect x="8" y="8" width="48" height="48" rx="12" fill="url(#empty-g)" opacity="0.18"/>
          <path d="M14 44V20h5l7 10 7-10h5v24h-5V30l-7 10-7-10v14H14z" fill="currentColor" opacity="0.9"/>
          <path d="M42 26h4v8h3l-5 6-5-6h3v-8z" fill="currentColor" opacity="0.9"/>
        </svg>
      </div>
      <h2 class="empty-state__title">A fresh canvas</h2>
      <p class="empty-state__subtitle">Start typing markdown on the left — the preview updates live.</p>
      <div class="empty-state__actions">
        <button class="btn btn--primary" data-empty-action="welcome">Load welcome tour</button>
        <button class="btn" data-empty-action="upload">Upload .md file</button>
      </div>
      <ul class="empty-state__hints">
        <li><kbd>⌘</kbd><kbd>1</kbd> Editor</li>
        <li><kbd>⌘</kbd><kbd>2</kbd> Split</li>
        <li><kbd>⌘</kbd><kbd>3</kbd> Preview</li>
        <li><kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd> Theme</li>
        <li><kbd>⌘</kbd><kbd>.</kbd> Focus</li>
        <li><kbd>?</kbd> All shortcuts</li>
      </ul>
    </div>
  `;
}


if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:') {
  window.__mdlab = { render, editor, mermaid };
}
