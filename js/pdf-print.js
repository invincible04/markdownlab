// Print runtime. Loaded into the iframe (desktop) or popup (mobile).
// Config travels via a JSON <script> block to keep CSP `script-src 'self'`.

import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

const POPUP_AUTOCLOSE_MS = 60_000;
const POPUP_AUTOPRINT_DELAY_MS = 600;

const cfg = JSON.parse(document.getElementById('mdlab-pdf-config')?.textContent || '{}');
const MSG = cfg.msg || { ready: 'mdlab-print-ready', error: 'mdlab-pdf-error' };

const report = (err) => {
  const msg = String(err?.message || err);
  console.error('[pdf-print]', msg);
  if (cfg.selfPrint) return;
  try { parent.postMessage({ type: MSG.error, error: msg }, '*'); } catch {}
};

const closeWindowOnce = (() => {
  let closed = false;
  return () => { if (closed) return; closed = true; try { window.close(); } catch {} };
})();

const waitForWindowLoad = () =>
  document.readyState === 'complete'
    ? Promise.resolve()
    : new Promise((r) => window.addEventListener('load', r, { once: true }));

(async () => {
  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: 'Inter, system-ui, sans-serif',
      themeVariables: cfg.themeVars || {},
      flowchart: { curve: 'basis' },
      sequence: { showSequenceNumbers: false, actorMargin: 50, useMaxWidth: false },
      gantt: { fontSize: 12, barHeight: 26, barGap: 6, topPadding: 56, leftPadding: 90 },
    });

    const nodes = Array.from(document.querySelectorAll('.mermaid'));
    if (nodes.length) {
      await mermaid.run({ nodes, suppressErrors: false }).catch((e) => {
        console.warn('Mermaid render error (some diagrams may be blank):', e);
      });
    }

    document.querySelectorAll('.mermaid svg').forEach((svg) => {
      const bb = svg.getBoundingClientRect();
      if (bb.width)  svg.setAttribute('width',  String(Math.round(bb.width)));
      if (bb.height) svg.setAttribute('height', String(Math.round(bb.height)));
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
    });

    if (document.fonts?.ready) await document.fonts.ready;

    await Promise.all(Array.from(document.images).map((img) =>
      img.complete ? null : new Promise((res) => {
        img.addEventListener('load',  res, { once: true });
        img.addEventListener('error', res, { once: true });
      })
    ));

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    if (cfg.selfPrint) initSelfPrint();
    else parent.postMessage({ type: MSG.ready }, '*');
  } catch (err) {
    report(err);
    if (cfg.selfPrint) setHint('Preview ready. Use the print button below to save.');
  }
})();

// Mobile popup path. Auto-print is gated on window.load — Android Chrome
// errors with "There was a problem printing the page" if print() runs before
// the document finishes loading. The button is the fallback user gesture.
async function initSelfPrint() {
  document.getElementById('mdlab-print-btn')?.addEventListener('click', () => triggerPrint());
  document.getElementById('mdlab-close-btn')?.addEventListener('click', closeWindowOnce);
  window.addEventListener('afterprint', () => setHint('Saved. You can close this tab.'));
  setTimeout(closeWindowOnce, POPUP_AUTOCLOSE_MS);

  await waitForWindowLoad();
  setHint('Ready. Tap "Save as PDF" to continue.');
  setTimeout(() => triggerPrint({ silent: true }), POPUP_AUTOPRINT_DELAY_MS);
}

function triggerPrint({ silent = false } = {}) {
  try {
    setHint('Opening print dialog…');
    window.print();
  } catch (err) {
    if (!silent) report(err);
    setHint('Could not open the print dialog. Tap "Save as PDF" to retry.');
  }
}

function setHint(text) {
  const el = document.getElementById('mdlab-print-hint');
  if (el) el.textContent = text;
}
