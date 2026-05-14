/**
 * Math extraction + KaTeX rendering.
 *
 *   editor source → extractMath → processed + placeholders
 *                 → marked → reinjectMath → final HTML
 *
 * Scanning at source level keeps $…$ and $$…$$ literal inside fenced
 * and inline code. Matches become sentinel tokens that survive marked's
 * HTML escaping; reinjectMath swaps them back for KaTeX output afterward.
 */

import { escapeHtml } from './utils.js';

export const MATH_PLACEHOLDER = (i) => `@@MATH_PLACEHOLDER_${i}@@`;
const MATH_PLACEHOLDER_RE = /@@MATH_PLACEHOLDER_(\d+)@@/g;

/**
 * Extract math regions from markdown source.
 *
 * @param {string} src
 * @returns {{
 *   processed: string,
 *   renders: string[],
 *   mathRanges: Array<{start:number,end:number,display:boolean}>
 * }} `mathRanges` is in input-source offsets and is used by the find
 *   bar to skip spans hidden behind KaTeX HTML.
 */
export function extractMath(src) {
  if (src.indexOf('$') === -1) {
    return { processed: src, renders: [], mathRanges: [] };
  }
  const renders = [];
  const ranges = [];
  const out = [];
  let i = 0;

  while (i < src.length) {
    // Fenced code blocks — CommonMark allows up to 3 spaces of indent.
    const fenceMatch = src.slice(i).match(/^( {0,3})([`~]{3,})([^\n]*)\n/);
    if (fenceMatch && (i === 0 || src[i-1] === '\n')) {
      const fence = fenceMatch[2];
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

    // Inline code spans.
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
      let j = i + 2;
      let close = -1;
      let aborted = false;
      while (j < src.length - 1) {
        if (src[j] === '`') { aborted = true; break; }
        if (src[j] === '$' && src[j + 1] === '$') { close = j; break; }
        j++;
      }
      if (!aborted && close !== -1) {
        const tex = src.slice(i + 2, close);
        const idx = renders.length;
        renders.push(renderKatex(tex, true));
        out.push(`\n\n${MATH_PLACEHOLDER(idx)}\n\n`);
        ranges.push({ start: i, end: close + 2, display: true });
        i = close + 2;
        continue;
      }
    }

    // Inline math $…$
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
          if (ch === '`') break;
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
            ranges.push({ start: i, end: found + 1, display: false });
            i = found + 1;
            continue;
          }
        }
      }
    }

    out.push(src[i]);
    i++;
  }

  return { processed: out.join(''), renders, mathRanges: ranges };
}

/**
 * Render one TeX fragment with KaTeX. `throwOnError: false` keeps the
 * preview alive mid-edit; broken math surfaces as a `.katex-error` span.
 */
export function renderKatex(tex, displayMode) {
  const katex = window.katex;
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

/** Swap each `@@MATH_PLACEHOLDER_N@@` sentinel back to its KaTeX HTML. */
export function reinjectMath(html, renders) {
  return html.replace(MATH_PLACEHOLDER_RE, (_, idx) => renders[Number(idx)] ?? '');
}
