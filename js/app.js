/* MarkdownLab — render pipeline:
   editor → extractMath → marked → reinjectMath → DOMPurify → Mermaid → postProcess */

import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';
import { EXAMPLES } from './examples.js';

// ---------- DOM refs ----------
const editor         = document.getElementById('editor');
const editorMirror   = document.getElementById('editor-mirror');
const preview        = document.getElementById('preview');
const previewWrap    = document.getElementById('preview-wrap');
const gutter         = document.getElementById('editor-gutter');
const workspace      = document.querySelector('.workspace');
const dropOverlay    = document.getElementById('drop-overlay');
const fileInput      = document.getElementById('file-input');
const btnUpload      = document.getElementById('btn-upload');
const btnTheme       = document.getElementById('btn-theme');
const btnFocus       = document.getElementById('btn-focus');
const btnFocusExit   = document.getElementById('btn-focus-exit');
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

const STORAGE_KEY    = 'mdlab.doc.v1';
const THEME_KEY      = 'mdlab.theme.v1';
const VIEW_KEY       = 'mdlab.view.v1';
const SPLIT_KEY      = 'mdlab.split.v1';
const PROSE_KEY      = 'mdlab.prose.v1';
const SYNC_KEY       = 'mdlab.sync.v1';
const SCROLL_KEY     = 'mdlab.scroll.v1';
const TOC_KEY        = 'mdlab.toc.v1';

(function migrateOldKeys() {
  const pairs = [
    ['md-studio.doc.v1',   STORAGE_KEY],
    ['md-studio.theme.v1', THEME_KEY],
    ['md-studio.view.v1',  VIEW_KEY],
    ['md-studio.split.v1', SPLIT_KEY],
    ['md-studio.prose.v1', PROSE_KEY],
  ];
  try {
    for (const [from, to] of pairs) {
      const v = localStorage.getItem(from);
      if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
      if (v !== null) localStorage.removeItem(from);
    }
  } catch {}
})();

let currentDoc = { source: '', filename: 'Untitled.md' };
let toastTimer;
let mermaidCounter = 0;
let _anchorRebuildTimer;
let _lastPreviewHtml = null;

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Microtask defer lets all module-level bindings initialize before any code
// path (init → render → persist) touches them — avoids TDZ errors.
Promise.resolve().then(() => init()).catch(err => {
  console.error('Init failed:', err);
  setStatus('error', 'Failed to initialize');
  preview.innerHTML = '<pre style="color:var(--danger);padding:16px;font-size:12px;white-space:pre-wrap;">' +
    String(err?.stack || err?.message || err).replace(/</g,'&lt;') + '</pre>';
});

async function init() {
  await waitForLibs();
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
  loadInitialDoc();
  await render();

  // If a library became usable on a later tick and our first render produced
  // nothing, render once more.
  if (editor.value.trim().length > 0 && preview.innerText.trim().length < 10) {
    console.warn('Preview empty after init — forcing re-render');
    await render();
  }

  // Two-frame defer so Mermaid/KaTeX have settled before we restore scrollTop.
  requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
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

function setupMarked() {
  marked.setOptions({ gfm: true, breaks: false, pedantic: false });

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
        let highlighted = '';
        try {
          if (lang && hljs.getLanguage(lang)) {
            highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          } else {
            highlighted = hljs.highlightAuto(code).value;
          }
        } catch {
          highlighted = escapeHtml(code);
        }
        const cls = lang ? ` class="hljs language-${lang}"` : ' class="hljs"';
        return `<pre><code${cls}>${highlighted}</code></pre>`;
      },
      // GFM alerts aren't native in marked 12 — detect and restyle blockquote.
      blockquote(quote) {
        const match = quote.match(/^<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*?)<\/p>\s*/is);
        if (match) {
          const kind = match[1].toLowerCase();
          const rest = quote.slice(match[0].length);
          const trailing = match[2].trim();
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
  if (theme === 'dark') {
    return {
      background: '#0f1a1d',
      primaryColor: '#059669',
      primaryTextColor: '#ffffff',
      primaryBorderColor: '#6ee7b7',
      secondaryColor: '#334155',
      secondaryTextColor: '#ffffff',
      secondaryBorderColor: '#94a3b8',
      tertiaryColor: '#0f2027',
      tertiaryTextColor: '#ffffff',
      tertiaryBorderColor: '#cbd5e1',

      mainBkg: '#059669',
      secondBkg: '#334155',
      nodeBorder: '#6ee7b7',
      nodeTextColor: '#ffffff',
      textColor: '#f8fafc',
      titleColor: '#ffffff',
      labelTextColor: '#ffffff',

      lineColor: '#cbd5e1',
      edgeLabelBackground: '#0f2027',

      clusterBkg: '#0f2027',
      clusterBorder: '#475569',

      actorBkg: '#059669',
      actorBorder: '#6ee7b7',
      actorTextColor: '#ffffff',
      actorLineColor: '#cbd5e1',
      signalColor: '#e2e8f0',
      signalTextColor: '#f8fafc',
      labelBoxBkgColor: '#334155',
      labelBoxBorderColor: '#94a3b8',
      loopTextColor: '#f8fafc',
      noteBkgColor: '#fde68a',
      noteTextColor: '#1e1b4b',
      noteBorderColor: '#f59e0b',
      activationBkgColor: '#10b981',
      activationBorderColor: '#6ee7b7',

      classText: '#ffffff',
      stateBkg: '#059669',
      altBackground: '#0f2027',

      git0: '#34d399', git1: '#22d3ee', git2: '#a78bfa', git3: '#fbbf24',
      git4: '#60a5fa', git5: '#f472b6', git6: '#f87171', git7: '#2dd4bf',
      gitBranchLabel0: '#0f172a', gitBranchLabel1: '#0f172a',
      gitBranchLabel2: '#ffffff', gitBranchLabel3: '#0f172a',
      gitBranchLabel4: '#ffffff', gitBranchLabel5: '#ffffff',
      gitBranchLabel6: '#ffffff', gitBranchLabel7: '#0f172a',
      gitInv0: '#0f172a', gitInv1: '#0f172a', gitInv2: '#ffffff',
      gitInv3: '#0f172a', gitInv4: '#ffffff', gitInv5: '#ffffff',
      gitInv6: '#ffffff', gitInv7: '#0f172a',
      commitLabelColor: '#f8fafc',
      commitLabelBackground: '#0f2027',
      commitLabelFontSize: '12px',
      tagLabelColor: '#ffffff',
      tagLabelBackground: '#059669',
      tagLabelBorder: '#6ee7b7',

      cScale0: '#059669', cScale1: '#0891b2', cScale2: '#0369a1',
      cScale3: '#0284c7', cScale4: '#d97706', cScale5: '#7c3aed',
      cScale6: '#dc2626', cScale7: '#16a34a',
      cScaleLabel0: '#ffffff', cScaleLabel1: '#ffffff',
      cScaleLabel2: '#ffffff', cScaleLabel3: '#ffffff',
      cScaleLabel4: '#ffffff', cScaleLabel5: '#ffffff',
      cScaleLabel6: '#ffffff', cScaleLabel7: '#ffffff',

      pie1: '#34d399', pie2: '#22d3ee', pie3: '#60a5fa', pie4: '#fbbf24',
      pie5: '#f472b6', pie6: '#f87171', pie7: '#a78bfa', pie8: '#2dd4bf',
      pie9: '#fb923c', pie10: '#4ade80', pie11: '#fcd34d', pie12: '#c084fc',
      pieTitleTextColor: '#ffffff',
      pieSectionTextColor: '#0f172a',
      pieLegendTextColor: '#f8fafc',
      pieStrokeColor: '#0f2027',

      gridColor: '#334155',
      taskBkgColor: '#10b981',
      taskBorderColor: '#6ee7b7',
      taskTextColor: '#ffffff',
      taskTextDarkColor: '#ffffff',
      taskTextLightColor: '#ffffff',
      taskTextOutsideColor: '#f1f5f9',
      taskTextClickableColor: '#ffffff',
      activeTaskBkgColor: '#22d3ee',
      activeTaskBorderColor: '#67e8f9',
      doneTaskBkgColor: '#64748b',
      doneTaskBorderColor: '#cbd5e1',
      critBkgColor: '#ef4444',
      critBorderColor: '#fecaca',
      sectionBkgColor: '#0f2027',
      sectionBkgColor2: '#162a30',
      altSectionBkgColor: '#0f2027',
      todayLineColor: '#f87171',
      titleColor2: '#cbd5e1',
      tickColor: '#cbd5e1',
      ganttFontSize: '12px',
    };
  }
  return {
    background: '#ffffff',
    primaryColor: '#d1fae5',
    primaryTextColor: '#064e3b',
    primaryBorderColor: '#0d9488',
    lineColor: '#475569',
    secondaryColor: '#f1f5f9',
    tertiaryColor: '#ffffff',
    mainBkg: '#d1fae5',
    secondBkg: '#f1f5f9',
    textColor: '#0f172a',
    nodeBorder: '#0d9488',
    clusterBkg: '#f8fafc',
    clusterBorder: '#e2e8f0',
    edgeLabelBackground: '#ffffff',
    actorBkg: '#d1fae5',
    actorBorder: '#0d9488',
    actorTextColor: '#064e3b',
    actorLineColor: '#475569',
    noteBkgColor: '#fef3c7',
    noteTextColor: '#0f172a',
    noteBorderColor: '#f59e0b',
  };
}

// Extract $…$ and $$…$$ math (outside fenced/inline code), render with KaTeX,
// leave placeholders that are re-injected after marked runs.
const MATH_PLACEHOLDER = (i) => `@@MATH_PLACEHOLDER_${i}@@`;

function extractMath(src) {
  const renders = [];
  const out = [];
  let i = 0;

  while (i < src.length) {
    // Skip over fenced code blocks so $…$ inside stays literal
    const fenceMatch = src.slice(i).match(/^([`~]{3,})([^\n]*)\n/);
    if (fenceMatch && (i === 0 || src[i-1] === '\n')) {
      const fence = fenceMatch[1];
      const close = src.indexOf('\n' + fence, i + fenceMatch[0].length);
      let end;
      if (close === -1) {
        end = src.length;
      } else {
        const afterFence = src.indexOf('\n', close + 1);
        end = afterFence === -1 ? src.length : afterFence + 1;
      }
      out.push(src.slice(i, end));
      i = end;
      continue;
    }

    // Skip over inline code spans
    if (src[i] === '`') {
      let ticks = 0;
      while (src[i + ticks] === '`') ticks++;
      const opener = '`'.repeat(ticks);
      const closeIdx = src.indexOf(opener, i + ticks);
      if (closeIdx !== -1) {
        const end = closeIdx + ticks;
        out.push(src.slice(i, end));
        i = end;
        continue;
      }
    }

    // Block math $$…$$
    if (src[i] === '$' && src[i + 1] === '$') {
      const close = src.indexOf('$$', i + 2);
      if (close !== -1) {
        const tex = src.slice(i + 2, close);
        const idx = renders.length;
        renders.push(renderKatex(tex, true));
        out.push(`\n\n${MATH_PLACEHOLDER(idx)}\n\n`);
        i = close + 2;
        continue;
      }
    }

    // Inline math $…$ — pandoc-style rules: opener not preceded by \w, not
    // followed by whitespace/digit; closer not preceded by space, not followed
    // by a digit (so "$5 and $10" stays literal), not escaped; body can't span
    // a blank line.
    if (src[i] === '$') {
      const prev = src[i - 1];
      const next = src[i + 1];
      const openingOk =
        next && next !== ' ' && next !== '\t' && next !== '\n' && next !== '$' && !/\d/.test(next) &&
        !(prev && /\w/.test(prev));
      if (openingOk) {
        let j = i + 1;
        let found = -1;
        while (j < src.length) {
          const ch = src[j];
          if (ch === '\n' && src[j + 1] === '\n') break;
          if (ch === '$' && src[j - 1] !== '\\' && src[j - 1] !== ' ' && src[j - 1] !== '\t' && src[j + 1] !== '$') {
            const after = src[j + 1];
            if (!after || !/\d/.test(after)) { found = j; break; }
          }
          j++;
        }
        if (found !== -1) {
          const tex = src.slice(i + 1, found);
          if (tex.trim().length > 0) {
            const idx = renders.length;
            renders.push(renderKatex(tex, false));
            out.push(MATH_PLACEHOLDER(idx));
            i = found + 1;
            continue;
          }
        }
      }
    }

    out.push(src[i]);
    i++;
  }

  return { processed: out.join(''), renders };
}

function renderKatex(tex, displayMode) {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
      strict: 'ignore',
      trust: false,
    });
  } catch (err) {
    const msg = escapeHtml(String(err?.message || err));
    return `<span class="katex-error" title="${msg}">${escapeHtml(tex)}</span>`;
  }
}

function reinjectMath(html, renders) {
  return html.replace(/@@MATH_PLACEHOLDER_(\d+)@@/g, (_, idx) => renders[Number(idx)] ?? '');
}

async function render() {
  const src = editor.value;
  currentDoc.source = src;
  updateStats(src);
  persist();
  sourceBlockLines = computeSourceBlockLines(src);

  if (!src.trim()) {
    preview.innerHTML = emptyStateHtml();
    _lastPreviewHtml = null;
    setStatus('ready', 'Ready');
    statRender.textContent = '—';
    preview.querySelector('[data-empty-action="upload"]')?.addEventListener('click', () => fileInput.click());
    preview.querySelector('[data-empty-action="welcome"]')?.addEventListener('click', () => {
      editor.value = EXAMPLES.welcome.content;
      currentDoc.filename = 'welcome.md';
      updateGutter();
      scheduleRender();
    });
    buildToc();
    return;
  }

  const t0 = performance.now();
  setStatus('busy', 'Rendering…');

  try {
    const { processed, renders } = extractMath(src);
    let html = marked.parse(processed);
    html = reinjectMath(html, renders);

    const clean = DOMPurify.sanitize(html, {
      ADD_TAGS: ['foreignObject', 'annotation-xml', 'semantics', 'annotation', 'math', 'mi', 'mo', 'mn', 'mrow', 'msup', 'msub', 'msubsup', 'mfrac', 'mspace', 'mtext', 'menclose', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle'],
      ADD_ATTR: ['target', 'mathvariant', 'displaystyle', 'mathcolor'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });

    // Skip DOM work when the sanitized output matches the last render — a
    // keystroke that doesn't change the produced markup (trailing whitespace,
    // typo-and-undo, etc.) would otherwise destroy and rebuild every Mermaid
    // diagram and trigger a full reflow/repaint.
    const changed = clean !== _lastPreviewHtml;
    if (changed) {
      preview.innerHTML = clean;
      _lastPreviewHtml = clean;
      await runMermaid();
      postProcess();
      buildToc();
    }

    // Rebuild now (best-effort) plus once more after Mermaid/KaTeX inflation
    // settles. ResizeObserver catches any later changes.
    syncEditorMirror();
    rebuildAnchorMap();
    scheduleAnchorRebuild();
    ensurePreviewObserver();

    statRender.textContent = `${(performance.now() - t0).toFixed(0)} ms`;
    setStatus('ready', 'Rendered');
  } catch (err) {
    console.error('Render error:', err);
    setStatus('error', 'Render failed');
    preview.innerHTML = `<div style="color:var(--danger);padding:24px;border:1px solid var(--danger);border-radius:8px;"><strong>Render failed</strong><br><code style="font-size:12px;">${escapeHtml(String(err?.message || err))}</code></div>`;
    _lastPreviewHtml = null;
  }
}

// Restore source text and clear processed/error flags so mermaid.run can
// regenerate against fresh innerHTML. Setting textContent clears any prior
// SVG children.
function resetMermaidNodes(nodes) {
  nodes.forEach((el) => {
    el.removeAttribute('data-processed');
    el.classList.remove('is-error');
    const raw = el.getAttribute('data-mermaid-src');
    if (raw) el.textContent = decodeURIComponent(raw);
    if (!el.id) el.id = `mermaid-${++mermaidCounter}`;
  });
}

async function runMermaid() {
  const nodes = preview.querySelectorAll('.mermaid');
  if (!nodes.length) return;

  resetMermaidNodes(nodes);

  try {
    await mermaid.run({ nodes: Array.from(nodes), suppressErrors: true });
  } catch (err) {
    console.warn('Mermaid run error:', err);
  }

  nodes.forEach((el) => {
    if (el.querySelector('svg')) return;
    const src = el.getAttribute('data-mermaid-src');
    el.classList.add('is-error');
    el.innerHTML = `<strong>Diagram error</strong><pre>${escapeHtml(src ? decodeURIComponent(src) : el.textContent)}</pre>`;
  });

  nodes.forEach(attachDiagramControls);
}

function attachDiagramControls(el) {
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
  });

  // Wrap each top-level table in a scroll container so wide tables scroll
  // horizontally without breaking the natural 100% width of narrow tables.
  preview.querySelectorAll('table').forEach((t) => {
    if (t.parentElement?.classList.contains('table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
}

// ---------- Table of contents ----------

const TOC_ACTIVE_THRESHOLD_PX = 88;
// Clears pane__header (40px) plus breathing room.
const TOC_SCROLL_OFFSET_PX = 24;
// Covers late layout shifts (Mermaid/images settling) after a scroll.
const TOC_LOCK_GRACE_MS = 220;

let _tocHeadingsCache = [];
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

  // Preserve previous active id across re-renders to avoid flicker while typing.
  const prevActiveId = _tocActiveId;
  _tocHeadingsCache = headings;

  if (!headings.length) {
    tocNav.replaceChildren();
    toc.dataset.empty = 'true';
    _tocActiveId = null;
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

  tocNav.replaceChildren(list);

  if (prevActiveId && headings.some(h => h.id === prevActiveId)) {
    const stillActive = tocNav.querySelector(`.toc__link[data-id="${cssEscape(prevActiveId)}"]`);
    if (stillActive) stillActive.classList.add('is-active');
  } else {
    _tocActiveId = null;
  }

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

function updateActiveTocItem() {
  if (!toc || toc.dataset.empty === 'true') return;
  const headings = _tocHeadingsCache;
  if (!headings.length) return;

  // While a TOC-click scroll is in flight, pin to the clicked heading so
  // the highlight doesn't flicker through every heading we pass.
  if (_tocScrollLock) {
    const stillExists = headings.some(h => h.id === _tocScrollLock.id);
    if (stillExists && _tocActiveId !== _tocScrollLock.id) {
      _tocActiveId = _tocScrollLock.id;
      tocNav.querySelectorAll('.toc__link').forEach(link => {
        link.classList.toggle('is-active', link.dataset.id === _tocScrollLock.id);
      });
    }
    return;
  }

  const wrapTop = previewWrap.getBoundingClientRect().top;

  let activeId = headings[0].id;
  let scrolledPastAny = false;
  for (const h of headings) {
    const r = h.getBoundingClientRect();
    if (r.top - wrapTop - TOC_ACTIVE_THRESHOLD_PX <= 0) {
      activeId = h.id;
      scrolledPastAny = true;
    } else {
      break;
    }
  }

  // Force last heading at bottom so trailing small headings still highlight.
  const atBottom = previewWrap.scrollTop + previewWrap.clientHeight >= previewWrap.scrollHeight - 4;
  if (atBottom) activeId = headings[headings.length - 1].id;

  if (!scrolledPastAny && previewWrap.scrollTop < 4) {
    activeId = null;
  }

  if (activeId === _tocActiveId) return;
  _tocActiveId = activeId;

  let activeLink = null;
  tocNav.querySelectorAll('.toc__link').forEach(link => {
    const on = activeId !== null && link.dataset.id === activeId;
    link.classList.toggle('is-active', on);
    if (on) activeLink = link;
  });

  if (activeLink) keepTocLinkVisible(activeLink);
}

function keepTocLinkVisible(link) {
  const navRect = tocNav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const margin = 24;
  if (linkRect.top < navRect.top + margin) {
    tocNav.scrollBy({ top: linkRect.top - navRect.top - margin, behavior: 'smooth' });
  } else if (linkRect.bottom > navRect.bottom - margin) {
    tocNav.scrollBy({ top: linkRect.bottom - navRect.bottom + margin, behavior: 'smooth' });
  }
}

// rAF-driven so we get a completion signal (native smooth scroll doesn't),
// letting us re-measure once the scroll settles.
function smoothScrollTo(el, top, { duration = 360, signal } = {}) {
  cancelAnimationFrame(_tocScrollAnimId);
  _tocScrollAnimId = 0;
  return new Promise((resolve) => {
    const start = el.scrollTop;
    const distance = Math.round(top) - start;
    if (Math.abs(distance) < 1) { el.scrollTop = Math.round(top); resolve(); return; }
    if (signal?.aborted) { resolve(); return; }

    const startTime = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    const onAbort = () => { cancelAnimationFrame(_tocScrollAnimId); _tocScrollAnimId = 0; resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const tick = (now) => {
      if (signal?.aborted) { resolve(); return; }
      const t = Math.min(1, (now - startTime) / duration);
      el.scrollTop = start + distance * ease(t);
      if (t < 1) {
        _tocScrollAnimId = requestAnimationFrame(tick);
      } else {
        el.scrollTop = Math.round(top);
        _tocScrollAnimId = 0;
        resolve();
      }
    };
    _tocScrollAnimId = requestAnimationFrame(tick);
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

  if (_tocHeadingsCache.some(h => h.id === id)) {
    _tocScrollLock = { id };
    tocNav?.querySelectorAll('.toc__link.is-active').forEach(l => l.classList.remove('is-active'));
    const link = pinTocLink || tocNav?.querySelector(`.toc__link[data-id="${cssEscape(id)}"]`);
    if (link) {
      link.classList.add('is-active');
      _tocActiveId = id;
      keepTocLinkVisible(link);
    }
  }

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const target = targetScrollTopForHeading(heading);
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
    _tocScrollLock = null;
    _tocScrollAbortController = null;
    scheduleTocActiveUpdate();
  }, TOC_LOCK_GRACE_MS);
}

tocNav?.addEventListener('click', (e) => {
  const link = e.target.closest('.toc__link');
  if (!link) return;
  e.preventDefault();
  const id = link.dataset.id;
  if (!id) return;
  const heading = preview.querySelector(`#${cssEscape(id)}`);
  scrollPreviewToHeading(heading, { pinTocLink: link });
});

// Abort programmatic scroll on user input. `keydown` is intentionally omitted
// so editor keystrokes don't kill an in-flight TOC jump.
['wheel', 'touchstart', 'pointerdown'].forEach((ev) => {
  previewWrap?.addEventListener(ev, () => {
    if (_tocScrollAbortController) {
      _tocScrollAbortController.abort();
      _tocScrollAbortController = null;
      _tocScrollLock = null;
    }
  }, { passive: true });
});

// Fallback for browsers without CSS.escape.
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/([^\w-])/g, '\\$1');
}

function applyTocToggle(visible, { silent = false } = {}) {
  if (!toc) return;
  const on = !!visible;
  toc.dataset.collapsed = on ? 'false' : 'true';
  if (btnToc) {
    btnToc.setAttribute('aria-pressed', String(on));
    btnToc.title = on
      ? 'Outline is on — click to hide (Ctrl/Cmd + L)'
      : 'Outline is off — click to show (Ctrl/Cmd + L)';
    const label = btnToc.querySelector('.pane__toggle-label');
    if (label) label.textContent = on ? 'Outline' : 'Outline off';
  }
  try { localStorage.setItem(TOC_KEY, on ? '1' : '0'); } catch {}
  if (on) scheduleTocActiveUpdate();
  if (!silent) showToast(on ? 'Outline on' : 'Outline off', 'info');
}

function restoreTocPref() {
  if (!toc) return;
  const raw = localStorage.getItem(TOC_KEY);
  applyTocToggle(raw === null ? true : raw === '1', { silent: true });
}

btnToc?.addEventListener('click', () => {
  const isOn = toc.dataset.collapsed !== 'true';
  applyTocToggle(!isOn);
});
btnTocClose?.addEventListener('click', () => applyTocToggle(false));

// Pan + zoom viewer for Mermaid SVGs
const lightbox = {
  root:   document.getElementById('lightbox'),
  stage:  document.getElementById('lightbox-stage'),
  canvas: document.getElementById('lightbox-canvas'),
  zoomLbl:document.getElementById('lightbox-zoom'),
  scale: 1,
  tx: 0, ty: 0,
  minScale: 0.1,
  maxScale: 8,
  sourceTitle: '',
};

function applyLightboxTransform() {
  lightbox.canvas.style.transform =
    `translate(-50%, -50%) translate(${lightbox.tx}px, ${lightbox.ty}px) scale(${lightbox.scale})`;
  lightbox.zoomLbl.textContent = Math.round(lightbox.scale * 100) + '%';
}

// Smooth easing for discrete actions (buttons, keyboard); off for wheel so
// rapid ticks snap instantly and don't lag behind the cursor.
function setLightboxSmooth(on) {
  lightbox.canvas.style.transition = on
    ? 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)'
    : 'transform 0s';
}

function fitLightbox() {
  const svg = lightbox.canvas.querySelector('svg');
  if (!svg) return;
  const vb = svg.viewBox?.baseVal;
  const svgW = vb?.width  || svg.getBoundingClientRect().width  || 800;
  const svgH = vb?.height || svg.getBoundingClientRect().height || 600;
  const stageR = lightbox.stage.getBoundingClientRect();
  const pad = 48;
  const fit = Math.min((stageR.width - pad) / svgW, (stageR.height - pad) / svgH, 4);
  lightbox.scale = fit > 0 ? fit : 1;
  lightbox.tx = 0;
  lightbox.ty = 0;
  applyLightboxTransform();
}

function openLightbox(mermaidEl) {
  const svg = mermaidEl.querySelector('svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style');
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  const vb = svg.viewBox?.baseVal;
  if (vb) {
    clone.setAttribute('width', vb.width);
    clone.setAttribute('height', vb.height);
  }
  lightbox.canvas.innerHTML = '';
  lightbox.canvas.appendChild(clone);
  lightbox.sourceTitle = mermaidEl.id || 'diagram';
  lightbox.root.classList.add('is-open');
  lightbox.root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  // Start slightly zoomed out, then ease to fit so the open has motion.
  lightbox.scale = 0.92; lightbox.tx = 0; lightbox.ty = 0;
  setLightboxSmooth(false);
  applyLightboxTransform();
  requestAnimationFrame(() => {
    setLightboxSmooth(true);
    fitLightbox();
    showLightboxHint();
  });
}

function closeLightbox() {
  lightbox.root.classList.remove('is-open');
  lightbox.root.setAttribute('aria-hidden', 'true');
  lightbox.canvas.innerHTML = '';
  document.body.style.overflow = '';
}

let lightboxHintTimer;
function showLightboxHint() {
  const hint = document.querySelector('.lightbox__hint');
  if (!hint) return;
  hint.classList.add('is-show');
  clearTimeout(lightboxHintTimer);
  lightboxHintTimer = setTimeout(() => hint.classList.remove('is-show'), 3200);
}

function zoomBy(factor, cx, cy) {
  const newScale = Math.max(lightbox.minScale, Math.min(lightbox.maxScale, lightbox.scale * factor));
  if (newScale === lightbox.scale) return;
  // Keep the point under cursor fixed when focal coords are provided.
  if (cx !== undefined && cy !== undefined) {
    const r = lightbox.stage.getBoundingClientRect();
    const ax = cx - r.left - r.width / 2;
    const ay = cy - r.top  - r.height / 2;
    const k = newScale / lightbox.scale;
    lightbox.tx = ax - (ax - lightbox.tx) * k;
    lightbox.ty = ay - (ay - lightbox.ty) * k;
  }
  lightbox.scale = newScale;
  applyLightboxTransform();
}

document.querySelectorAll('[data-zoom]').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.zoom;
    setLightboxSmooth(true);
    if (k === 'in')        zoomBy(1.2);
    else if (k === 'out')  zoomBy(1 / 1.2);
    else if (k === 'reset') fitLightbox();
  });
});
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-download').addEventListener('click', async () => {
  const svg = lightbox.canvas.querySelector('svg');
  if (!svg) return;
  const name = (lightbox.sourceTitle || 'diagram').replace(/\.(svg|png)$/i, '');
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

// Rasterize an inline SVG to a 2x PNG. Key edge cases we handle:
//  · <foreignObject> labels don't rasterize via <img> in any browser — we
//    replace them with native <text> before export.
//  · Mermaid's class-based <style> rules don't survive the <img> load — we
//    inline computed paint styles onto every element.
//  · btoa can't handle multi-byte chars; fall back via encodeURIComponent.
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
    textEl.setAttribute('font-family', "Inter, system-ui, -apple-system, sans-serif");
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
      const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(xml))) : null;
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

lightbox.stage.addEventListener('dblclick', () => {
  setLightboxSmooth(true);
  fitLightbox();
});

// Wheel zoom — normalizes across mouse wheels (large discrete ticks) and
// trackpad pinch (small continuous deltas). Exponential mapping keeps in/out
// symmetric; per-event step clamped to ±15% so a buffered burst can't warp.
{
  lightbox.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1)       dy *= 16;
    else if (e.deltaMode === 2)  dy *= 400;
    const isPinch = e.ctrlKey;
    const sensitivity = isPinch ? 0.01 : 0.0007;
    const step = Math.max(-0.15, Math.min(0.15, -dy * sensitivity));
    setLightboxSmooth(false);
    zoomBy(Math.exp(step), e.clientX, e.clientY);
  }, { passive: false });
}

{
  let panning = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
  lightbox.stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    panning = true;
    startX = e.clientX; startY = e.clientY;
    startTx = lightbox.tx; startTy = lightbox.ty;
    setLightboxSmooth(false);
    lightbox.stage.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    lightbox.tx = startTx + (e.clientX - startX);
    lightbox.ty = startTy + (e.clientY - startY);
    applyLightboxTransform();
  });
  window.addEventListener('mouseup', () => {
    if (panning) { panning = false; lightbox.stage.style.cursor = ''; }
  });
}

document.addEventListener('keydown', (e) => {
  if (!lightbox.root.classList.contains('is-open')) return;
  if (e.key === 'Escape')  { e.preventDefault(); closeLightbox(); return; }
  setLightboxSmooth(true);
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.2); }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1/1.2); }
  if (e.key === '0')       { e.preventDefault(); fitLightbox(); }
  const step = 60;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); lightbox.tx += step; applyLightboxTransform(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); lightbox.tx -= step; applyLightboxTransform(); }
  if (e.key === 'ArrowUp')    { e.preventDefault(); lightbox.ty += step; applyLightboxTransform(); }
  if (e.key === 'ArrowDown')  { e.preventDefault(); lightbox.ty -= step; applyLightboxTransform(); }
});

window.addEventListener('resize', () => {
  if (lightbox.root.classList.contains('is-open')) fitLightbox();
  syncEditorMirror();
  scheduleAnchorRebuild();
  scheduleTocActiveUpdate();
});

const scheduleRender = debounce(render, 120);

editor.addEventListener('input', () => {
  // updateGutter() re-measures the mirror, so lineTops are current for the
  // next scroll event even before the debounced render fires.
  updateGutter();
  scheduleRender();
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: ee } = editor;
    const insert = '  ';
    editor.value = editor.value.slice(0, s) + insert + editor.value.slice(ee);
    editor.selectionStart = editor.selectionEnd = s + insert.length;
    editor.dispatchEvent(new Event('input'));
  }
});

// Scroll sync — editor ↔ preview.
//
// Two coordinate systems meet in the middle at "source line number":
//   · Editor side: a hidden mirror <div> (same font/padding/wrap as textarea)
//     gives us the real wrapped-line Y offsets in `lineTops[]`.
//   · Preview side: `anchorMap` pairs each top-level preview child's
//     offsetTop with the source line its block starts on.
// On scroll, we find the visible source line on one side and interpolate the
// corresponding scrollTop on the other.

let scrollSyncEnabled = true;
let scrollOwner = null;       // 'editor' | 'preview' | null — programmatic write lockout
let scrollReleaseId = 0;
function takeScroll(owner) {
  scrollOwner = owner;
  clearTimeout(scrollReleaseId);
  // Release quickly so a direction change isn't starved, but long enough to
  // swallow the 1-2 scroll events our programmatic scrollTop write produces.
  scrollReleaseId = setTimeout(() => { scrollOwner = null; }, 50);
}

let sourceBlockLines = [];
let anchorMap = [];

// 0-indexed start line of every top-level block in the source. Adjacent
// paragraphs separated by a blank line → separate blocks. Fenced code and
// $$…$$ block math are atomic so the result matches marked's 1:1 emission
// (extractMath collapses each block-math region to a single paragraph).
function computeSourceBlockLines(src) {
  const lines = src.split('\n');
  const starts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fm = line.match(/^\s{0,3}([`~]{3,})/);
    if (fm) {
      starts.push(i);
      const fenceMarker = fm[1][0].repeat(fm[1].length);
      i++;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(fenceMarker)) { i++; break; }
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

    starts.push(i);
    i++;
    while (i < lines.length && lines[i].trim() !== '') i++;
  }
  return starts;
}

// lineTops[i] = pixel Y of source line i. Measured against the mirror, which
// shares the textarea's top-left and padding via .editor__surface.
let lineTops = [0];
let mirrorTotalHeight = 0;
let _editorPadTop = 16;

function syncEditorMirror() {
  if (!editorMirror) return;
  // clientWidth (content + padding, minus scrollbar) — mirror uses same
  // border-box + padding so copying it matches wrap points exactly.
  editorMirror.style.width = `${editor.clientWidth}px`;
  _editorPadTop = parseFloat(getComputedStyle(editor).paddingTop) || 16;

  // One <div> per source line. Empty lines get a ZWSP so their line-box
  // has real height.
  const lines = editor.value.split('\n');
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
  // Sentinel so scrolling to the bottom of one pane bottoms out the other.
  const totalLines = editor.value.split('\n').length;
  const last = map[map.length - 1];
  const endTop = Math.max(last?.top ?? 0, preview.scrollHeight);
  map.push({ line: Math.max(totalLines, last?.line ?? 0) + 1, top: endTop });
  anchorMap = map;
}

// Double rAF inside a debounce so Mermaid/KaTeX/image heights are final before
// we freeze offsetTop.
function scheduleAnchorRebuild() {
  clearTimeout(_anchorRebuildTimer);
  _anchorRebuildTimer = setTimeout(() => {
    requestAnimationFrame(() => requestAnimationFrame(rebuildAnchorMap));
  }, 60);
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
  _editorResizeObserver = new ResizeObserver(() => {
    syncEditorMirror();
    scheduleAnchorRebuild();
  });
  _editorResizeObserver.observe(editor);
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
  for (let i = 0; i < anchorMap.length - 1; i++) {
    const a = anchorMap[i], b = anchorMap[i + 1];
    if (a.line <= line && b.line >= line) {
      const t = (line - a.line) / (b.line - a.line || 1);
      return Math.max(0, Math.min(max, a.top + t * (b.top - a.top)));
    }
  }
  return 0;
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
  for (let i = 0; i < anchorMap.length - 1; i++) {
    const a = anchorMap[i], b = anchorMap[i + 1];
    if (a.top <= scrollTop && b.top >= scrollTop) {
      const t = (scrollTop - a.top) / (b.top - a.top || 1);
      return a.line + t * (b.line - a.line);
    }
  }
  return 0;
}

function syncGutterToEditor() {
  const inner = gutter.firstElementChild;
  if (inner) inner.style.transform = `translate3d(0, ${-editor.scrollTop}px, 0)`;
}

// rAF-batched so native momentum scrolling on one pane doesn't starve the
// main thread with per-event layout work on the other.
let _editorSyncQueued = false;
let _previewSyncQueued = false;

function scheduleEditorToPreview() {
  if (!scrollSyncEnabled || _editorSyncQueued) return;
  _editorSyncQueued = true;
  requestAnimationFrame(() => {
    _editorSyncQueued = false;
    if (!scrollSyncEnabled || scrollOwner === 'preview') return;
    takeScroll('editor');
    previewWrap.scrollTop = previewScrollForLine(editorTopVisibleLine());
  });
}

function schedulePreviewToEditor() {
  if (!scrollSyncEnabled || _previewSyncQueued) return;
  _previewSyncQueued = true;
  requestAnimationFrame(() => {
    _previewSyncQueued = false;
    if (!scrollSyncEnabled || scrollOwner === 'editor') return;
    takeScroll('preview');
    const line = lineForPreviewScroll(previewWrap.scrollTop);
    editor.scrollTop = Math.max(0, editorTopOfLine(line) - _editorPadTop);
    syncGutterToEditor();
  });
}

editor.addEventListener('scroll', () => {
  syncGutterToEditor();
  scheduleEditorToPreview();
  schedulePersistScroll();
}, { passive: true });

previewWrap.addEventListener('scroll', () => {
  schedulePreviewToEditor();
  schedulePersistScroll();
  scheduleTocActiveUpdate();
}, { passive: true });

function writeScrollState() {
  try {
    localStorage.setItem(SCROLL_KEY, JSON.stringify({
      editor: editor.scrollTop,
      preview: previewWrap.scrollTop,
    }));
  } catch {}
}

// Debounce fires after scroll events settle. We persist unconditionally: by
// then, any programmatic-scroll lockout (~50ms) has long since cleared.
const schedulePersistScroll = debounce(writeScrollState, 250);

// Flush synchronously on unload so a scroll-then-close beats the debounce.
window.addEventListener('beforeunload', writeScrollState);

function restoreScroll() {
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    if (!raw) return;
    const { editor: e, preview: p } = JSON.parse(raw) || {};
    // Hold ownership so the sync handler doesn't re-align during restore.
    takeScroll('editor');
    if (typeof e === 'number') editor.scrollTop = e;
    if (typeof p === 'number') previewWrap.scrollTop = p;
    syncGutterToEditor();
  } catch {}
}

// Each line number is absolutely placed at the matching mirror Y so soft-
// wrapped lines stay aligned with their source row.
function updateGutter() {
  syncEditorMirror();
  const total = editor.value.split('\n').length;
  const tops = lineTops;
  let html = `<div class="editor__gutter-inner" style="height:${mirrorTotalHeight}px;">`;
  for (let i = 0; i < total; i++) {
    html += `<span class="editor__gutter-num" style="top:${tops[i] ?? 0}px;">${i + 1}</span>`;
  }
  html += `</div>`;
  gutter.innerHTML = html;
  gutter.dataset.count = String(total);
  const inner = gutter.firstElementChild;
  if (inner) inner.style.transform = `translateY(${-editor.scrollTop}px)`;
}

function updateStats(src) {
  const chars = src.length;
  const words = (src.match(/\b\w+\b/g) || []).length;
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

const persist = debounce(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      source: currentDoc.source,
      filename: currentDoc.filename,
      savedAt: Date.now(),
    }));
    fileIndicator.textContent = `${currentDoc.filename} · autosaved`;
  } catch {
    fileIndicator.textContent = `${currentDoc.filename} · autosave unavailable`;
  }
}, 300);

function loadInitialDoc() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d.source === 'string' && d.source.trim().length > 0) {
        editor.value = d.source;
        currentDoc.source = d.source;
        currentDoc.filename = d.filename || 'Untitled.md';
        fileIndicator.textContent = `${currentDoc.filename} · autosaved`;
        updateGutter();
        return;
      }
    }
  } catch {}
  editor.value = EXAMPLES.welcome.content;
  currentDoc.source = EXAMPLES.welcome.content;
  currentDoc.filename = 'welcome.md';
  fileIndicator.textContent = `${currentDoc.filename} · autosaved`;
  updateGutter();
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
  // Only Mermaid needs re-running — everything else theming is CSS-variable
  // driven.
  setupMermaid();
  if (!silent) {
    rethemeMermaid();
    showToast(`${theme === 'dark' ? 'Dark' : 'Light'} theme`, 'info');
  }
}

async function rethemeMermaid() {
  await runMermaid();
  scheduleAnchorRebuild();
}

btnTheme.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

async function enterFocus() {
  document.body.classList.add('is-focus');
  // Fullscreen on <body> (not <html>) — browsers paint default white over the
  // fullscreen root, which hides our UI. Falls back gracefully.
  try {
    if (document.body.requestFullscreen && !document.fullscreenElement) {
      await document.body.requestFullscreen();
    }
  } catch {}
  showToast('Focus mode · press Esc to exit', 'info');
  btnFocus.setAttribute('aria-pressed', 'true');
}
async function exitFocus() {
  document.body.classList.remove('is-focus');
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
btnFocusExit.addEventListener('click', exitFocus);
// Sync in-page state when the user exits system fullscreen via Esc/F11.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('is-focus')) {
    document.body.classList.remove('is-focus');
    btnFocus.setAttribute('aria-pressed', 'false');
  }
});

function restoreView() {
  setView(localStorage.getItem(VIEW_KEY) || 'split', true);
}
function setView(view, silent = false) {
  workspace.dataset.view = view;
  document.querySelectorAll('.segmented__item[data-view]').forEach(btn => {
    const on = btn.dataset.view === view;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  localStorage.setItem(VIEW_KEY, view);
  if (!silent) showToast(`View: ${view}`, 'info');
}
document.querySelectorAll('.segmented__item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

function restoreSplit() {
  const pct = Number(localStorage.getItem(SPLIT_KEY));
  if (pct && pct > 15 && pct < 85) applySplit(pct);
}
// Custom property instead of full grid-template-columns — lets the
// [data-view=editor|preview] rules still collapse the layout.
function applySplit(pct, { deferRebuild = false } = {}) {
  workspace.style.setProperty('--split', `${pct}%`);
  localStorage.setItem(SPLIT_KEY, String(pct));
  if (deferRebuild) return;
  requestAnimationFrame(() => {
    syncEditorMirror();
    scheduleAnchorRebuild();
  });
}
function currentSplitPct() {
  const v = getComputedStyle(workspace).getPropertyValue('--split').trim();
  const m = v.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 50;
}
{
  let dragging = false;
  resizer.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  resizer.addEventListener('keydown', (e) => {
    const cur = currentSplitPct();
    if (e.key === 'ArrowLeft')  { e.preventDefault(); applySplit(Math.max(15, cur - 2)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); applySplit(Math.min(85, cur + 2)); }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = workspace.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    // Mirror rebuild is O(N) with a forced layout; skip per-pixel during drag
    // and flush once on mouseup below.
    if (pct > 15 && pct < 85) applySplit(pct, { deferRebuild: true });
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
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

btnUpload.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) await loadFile(f);
  fileInput.value = '';
});

let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('is-active');
});
window.addEventListener('dragleave', () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.classList.remove('is-active');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('is-active');
  const f = e.dataTransfer?.files?.[0];
  if (f) await loadFile(f);
});

async function loadFile(file) {
  const ok = /\.(md|markdown|txt)$/i.test(file.name) || /text/.test(file.type);
  if (!ok) {
    showToast(`Unsupported file: ${file.name}`, 'error');
    return;
  }
  try {
    const text = await file.text();
    editor.value = text;
    currentDoc.filename = file.name;
    updateGutter();
    scheduleRender();
    showToast(`Loaded ${file.name}`, 'success');
  } catch {
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
      <span style="font-size:18px;">${ex.icon}</span>
      <div>
        <strong>${escapeHtml(ex.label)}</strong>
        <small>${escapeHtml(ex.description)}</small>
      </div>
    `;
    btn.addEventListener('click', () => {
      editor.value = ex.content;
      currentDoc.filename = `${key}.md`;
      updateGutter();
      scheduleRender();
      closeAllDropdowns();
      showToast(`Loaded: ${ex.label}`, 'success');
    });
    examplesMenu.appendChild(btn);
  });
}

function bindUI() {
  document.querySelectorAll('.dropdown').forEach(dd => {
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
  document.querySelectorAll('.dropdown[data-open="true"]').forEach(dd => {
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
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copy(text, msg) {
  const ok = await copyToClipboard(text);
  if (ok) showToast(msg, 'success');
  else showToast('Copy failed — try selecting the text manually', 'error');
}

function exportMd() {
  download(editor.value, currentDoc.filename || 'document.md', 'text/markdown');
  showToast('Markdown downloaded', 'success');
}

function baseFilename() {
  return (currentDoc.filename || 'document').replace(/\.md$|\.markdown$|\.txt$/i, '');
}

async function exportHtml() {
  const title = baseFilename();
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const temp = document.createElement('div');
  temp.innerHTML = preview.innerHTML;
  temp.querySelectorAll('.code-copy, .code-lang, .diagram-expand').forEach(el => el.remove());
  const bodyHtml = temp.innerHTML;
  const html = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/${theme === 'dark' ? 'github-dark' : 'github'}.min.css">
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

// Rasterization runs inside the iframe because html2canvas reads computed
// styles from ownerDocument.defaultView — driving it from the parent makes
// it capture the live app instead of the iframe contents.
const PDF_PAGE_W_MM = 210;
const PDF_PAGE_H_MM = 297;
const PDF_MARGIN_MM = 14;
const PDF_CONTENT_W_PX = 794;
const PDF_MARGIN_PX = 53;
const PDF_BODY_W_PX = PDF_CONTENT_W_PX - PDF_MARGIN_PX * 2;
const PDF_IFRAME_H_PX = 1123;
const PDF_BUILD_TIMEOUT_MS = 60000;
const PDF_MAX_CANVAS_SIDE = 14000;
const PDF_MSG_BLOB = 'mdlab-pdf-blob';
const PDF_MSG_ERROR = 'mdlab-pdf-error';

async function exportPdf() {
  setStatus('busy', 'Building PDF…');
  showToast('Building PDF…', 'info');

  const title = baseFilename();
  const html = buildPdfSourceHtml(preview.innerHTML, title);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${PDF_CONTENT_W_PX}px;height:${PDF_IFRAME_H_PX}px;` +
    `border:0;visibility:hidden;pointer-events:none;background:#ffffff;`;
  iframe.srcdoc = html;
  document.body.appendChild(iframe);

  try {
    const blob = await waitForPdfBlob(iframe);
    download(blob, `${title}.pdf`, 'application/pdf');
    setStatus('ready', 'Rendered');
    showToast('PDF downloaded', 'success');
  } catch (err) {
    console.error('PDF export failed:', err);
    setStatus('error', 'PDF export failed');
    showToast(`PDF export failed — ${err.message || 'see console'}`, 'error');
  } finally {
    iframe.remove();
  }
}

function waitForPdfBlob(iframe) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`PDF build timed out after ${PDF_BUILD_TIMEOUT_MS / 1000}s`));
    }, PDF_BUILD_TIMEOUT_MS);
    const onMessage = (e) => {
      if (e.source !== iframe.contentWindow || !e.data) return;
      if (e.data.type === PDF_MSG_BLOB && e.data.blob instanceof Blob) {
        cleanup();
        resolve(e.data.blob);
      } else if (e.data.type === PDF_MSG_ERROR) {
        cleanup();
        reject(new Error(e.data.error || 'unknown error'));
      }
    };
    window.addEventListener('message', onMessage);
  });
}

function buildPdfSourceHtml(bodyInnerHtml, title) {
  const temp = document.createElement('div');
  temp.innerHTML = bodyInnerHtml;
  resetMermaidNodes(temp.querySelectorAll('.mermaid'));
  temp.querySelectorAll('.code-copy, .code-lang, .diagram-expand').forEach(el => el.remove());
  temp.querySelectorAll('.table-wrap').forEach(w => {
    const t = w.querySelector('table');
    if (t) w.replaceWith(t);
  });

  const lightVars = JSON.stringify(mermaidThemeVars('light'));
  const config = JSON.stringify({
    pageWidthMm: PDF_PAGE_W_MM,
    pageHeightMm: PDF_PAGE_H_MM,
    marginMm: PDF_MARGIN_MM,
    contentWidthPx: PDF_CONTENT_W_PX,
    maxCanvasSide: PDF_MAX_CANVAS_SIDE,
    msgBlob: PDF_MSG_BLOB,
    msgError: PDF_MSG_ERROR,
  });

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-light.min.css" crossorigin="anonymous">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js" crossorigin="anonymous"><\/script>
<script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js" crossorigin="anonymous"><\/script>
<style>
${pdfInlineCss()}
</style>
</head>
<body>
<article class="pdf-body" id="pdf-body">${temp.innerHTML}</article>
<script type="module">
const CFG = ${config};
const report = (err) => parent.postMessage({ type: CFG.msgError, error: String(err?.message || err) }, '*');

(async () => {
  try {
    // htmlLabels:false forces pure SVG <text> — html2canvas does not
    // reliably rasterize <foreignObject>.
    const mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs')).default;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: 'Inter, system-ui, sans-serif',
      themeVariables: ${lightVars},
      flowchart: { curve: 'basis', htmlLabels: false },
      sequence: { showSequenceNumbers: false, actorMargin: 50, useMaxWidth: false },
      gantt: { fontSize: 12, barHeight: 26, barGap: 6, topPadding: 56, leftPadding: 90 },
    });
    const nodes = Array.from(document.querySelectorAll('.mermaid'));
    if (nodes.length) {
      await mermaid.run({ nodes, suppressErrors: true });
    }

    // html2canvas sizes <svg> from width/height attrs, not computed style.
    document.querySelectorAll('.mermaid svg').forEach(svg => {
      const bb = svg.getBoundingClientRect();
      if (bb.width)  svg.setAttribute('width',  String(Math.round(bb.width)));
      if (bb.height) svg.setAttribute('height', String(Math.round(bb.height)));
      svg.style.maxWidth = '100%';
    });

    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(img =>
      img.complete ? Promise.resolve() :
        new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); })
    ));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Scale down long docs to stay below the browser's ~16384px canvas limit.
    const article = document.getElementById('pdf-body');
    const articleHeight = Math.max(article.scrollHeight, article.offsetHeight);
    let scale = 2;
    if (articleHeight * scale > CFG.maxCanvasSide) {
      scale = Math.max(1, CFG.maxCanvasSide / articleHeight);
    }

    const canvas = await window.html2canvas(article, {
      scale,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: CFG.contentWidthPx,
      windowHeight: articleHeight,
      scrollX: 0,
      scrollY: 0,
      imageTimeout: 15000,
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });

    const pageWmm = CFG.pageWidthMm;
    const pageHmm = CFG.pageHeightMm;
    const marginMm = CFG.marginMm;
    const contentWmm = pageWmm - marginMm * 2;
    const contentHmm = pageHmm - marginMm * 2;

    const pxPerMm = canvas.width / contentWmm;
    const contentPxH = Math.floor(contentHmm * pxPerMm);

    const totalPx = canvas.height;
    const tileCanvas = document.createElement('canvas');
    const tileCtx = tileCanvas.getContext('2d');
    tileCanvas.width = canvas.width;
    tileCtx.fillStyle = '#ffffff';

    for (let consumed = 0, pageIdx = 0; consumed < totalPx; pageIdx++) {
      const sliceH = Math.min(contentPxH, totalPx - consumed);
      // Resizing height resets the bitmap to transparent; refill so JPEG
      // encoding doesn't turn unwritten pixels black.
      tileCanvas.height = sliceH;
      tileCtx.fillRect(0, 0, canvas.width, sliceH);
      tileCtx.drawImage(canvas, 0, consumed, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      const imgData = tileCanvas.toDataURL('image/jpeg', 0.95);
      if (pageIdx > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', marginMm, marginMm, contentWmm, sliceH / pxPerMm, undefined, 'FAST');
      consumed += sliceH;
    }

    const blob = pdf.output('blob');
    parent.postMessage({ type: CFG.msgBlob, blob }, '*');
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
    currentDoc.filename = 'Untitled.md';
    updateGutter();
    scheduleRender();
    showToast('Cleared', 'info');
  }
}

function registerKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const sc = document.getElementById('shortcuts-overlay');
      if (sc?.classList.contains('is-open')) { e.preventDefault(); hideShortcuts(); return; }
      if (document.body.classList.contains('is-focus')) { e.preventDefault(); exitFocus(); return; }
    }

    if (e.key === '?' && !isTypingTarget(e.target)) {
      e.preventDefault(); toggleShortcuts(); return;
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); btnTheme.click(); return; }
    if (e.key === '.') { e.preventDefault(); toggleFocus(); return; }
    if (e.key === '1') { e.preventDefault(); setView('editor'); return; }
    if (e.key === '2') { e.preventDefault(); setView('split'); return; }
    if (e.key === '3') { e.preventDefault(); setView('preview'); return; }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); exportMd(); return; }
    if (e.key === 'o' || e.key === 'O') { e.preventDefault(); fileInput.click(); return; }
    if (e.key === '/') { e.preventDefault(); toggleShortcuts(); return; }
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
        <li><kbd>⌘</kbd><kbd>K</kbd> Theme</li>
        <li><kbd>⌘</kbd><kbd>.</kbd> Focus</li>
        <li><kbd>?</kbd> All shortcuts</li>
      </ul>
    </div>
  `;
}

const SHORTCUTS = [
  { group: 'View', items: [
    ['⌘ / Ctrl + 1', 'Editor only'],
    ['⌘ / Ctrl + 2', 'Split view'],
    ['⌘ / Ctrl + 3', 'Preview only'],
    ['⌘ / Ctrl + .', 'Toggle focus mode'],
    ['Esc',          'Exit focus / close dialog'],
  ]},
  { group: 'Document', items: [
    ['⌘ / Ctrl + K', 'Toggle theme'],
    ['⌘ / Ctrl + L', 'Toggle outline'],
    ['⌘ / Ctrl + O', 'Open .md file'],
    ['⌘ / Ctrl + S', 'Download markdown'],
    ['⌘ / Ctrl + /', 'Show shortcuts'],
    ['Tab',          'Insert two spaces'],
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

function buildShortcutsOverlay() {
  if (document.getElementById('shortcuts-overlay')) return;
  const root = document.createElement('div');
  root.className = 'shortcuts';
  root.id = 'shortcuts-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Keyboard shortcuts');
  root.setAttribute('aria-hidden', 'true');

  const body = SHORTCUTS.map(g => `
    <section class="shortcuts__group">
      <h3>${g.group}</h3>
      <dl>${g.items.map(([k, v]) =>
        `<div><dt>${k.split(' + ').map(p => p === '⌘ / Ctrl' ? '<kbd>⌘</kbd>/<kbd>Ctrl</kbd>' : `<kbd>${p}</kbd>`).join(' + ')}</dt><dd>${v}</dd></div>`
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
function showShortcuts() {
  buildShortcutsOverlay();
  const root = document.getElementById('shortcuts-overlay');
  root.classList.add('is-open');
  root.setAttribute('aria-hidden', 'false');
}
function hideShortcuts() {
  const root = document.getElementById('shortcuts-overlay');
  if (!root) return;
  root.classList.remove('is-open');
  root.setAttribute('aria-hidden', 'true');
}
function toggleShortcuts() {
  const root = document.getElementById('shortcuts-overlay');
  if (root?.classList.contains('is-open')) hideShortcuts();
  else showShortcuts();
}

window.__mdlab = { render, editor, mermaid };
