// Runs inside the hidden PDF iframe; config arrives via a JSON <script> block to satisfy `script-src 'self'`.

import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

const cfgEl = document.getElementById('mdlab-pdf-config');
const cfg = cfgEl ? JSON.parse(cfgEl.textContent) : {};
const MSG = cfg.msg || { ready: 'mdlab-print-ready', error: 'mdlab-pdf-error' };

const report = (err) => parent.postMessage(
  { type: MSG.error, error: String(err?.message || err) },
  '*',
);

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
      if (bb.width) svg.setAttribute('width', String(Math.round(bb.width)));
      if (bb.height) svg.setAttribute('height', String(Math.round(bb.height)));
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
    });

    if (document.fonts && document.fonts.ready) await document.fonts.ready;

    await Promise.all(Array.from(document.images).map((img) =>
      img.complete ? null : new Promise((res) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      })
    ));

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    parent.postMessage({ type: MSG.ready }, '*');
  } catch (err) {
    report(err);
  }
})();
