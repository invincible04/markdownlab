// Print runtime. Loaded inside the iframe (desktop) or popup (mobile);
// config arrives via a JSON <script> block to satisfy `script-src 'self'`.

import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

const MOBILE_PRINT_DELAY_MS = 300;
const POPUP_AUTOCLOSE_MS = 60_000;

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

    if (cfg.selfPrint) {
      // Mobile path. iOS Safari forwards iframe.print() to the top-level window
      // (that's why the desktop iframe path renders a 1-page PDF here), so we
      // print from a popup instead. The setTimeout matters: WebKit snapshots
      // document height once at print(), so fonts/Mermaid/KaTeX must have
      // painted first or pages 2..N get clipped. The auto-close handles iOS
      // dismissing the share sheet without firing afterprint.
      window.addEventListener('afterprint', closeWindowOnce, { once: true });
      setTimeout(closeWindowOnce, POPUP_AUTOCLOSE_MS);
      setTimeout(() => {
        try { window.print(); } catch (err) { report(err); }
      }, MOBILE_PRINT_DELAY_MS);
    } else {
      parent.postMessage({ type: MSG.ready }, '*');
    }
  } catch (err) {
    report(err);
  }
})();
