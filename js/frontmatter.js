/**
 * YAML frontmatter parsing + rendering.
 *
 * Without this, CommonMark treats `---…---` as a setext H2, so we strip
 * the frontmatter block before handing the body to `marked` and render
 * it as a GitHub-style two-column metadata table.
 *
 * `parseSimpleYaml` supports the subset MarkdownLab needs: flat scalars,
 * quoted strings, block sequences (incl. zero-indent), flow sequences
 * and maps, block literal / folded scalars (`|` `>`), plain multi-line
 * continuations, and one level of nested block mappings. Anything
 * unsupported throws; the caller falls back to a raw `<pre><code>`
 * rendering so the user still sees their metadata.
 */

import { escapeHtml } from './utils.js';

const FRONTMATTER_KEY_RE = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/;

/**
 * Split `src` into its frontmatter HTML and remaining body.
 * @param {string} src
 * @returns {{ frontmatterHtml: string, body: string }}
 */
export function extractFrontmatter(src) {
  if (!src.startsWith('---')) return { frontmatterHtml: '', body: src };
  const firstNl = src.indexOf('\n');
  if (firstNl === -1) return { frontmatterHtml: '', body: src };
  if (src.slice(0, firstNl).trim() !== '---') return { frontmatterHtml: '', body: src };

  const rest = src.slice(firstNl + 1);
  const closeMatch = rest.match(/^(?:---|\.\.\.)\s*$/m);
  if (!closeMatch) return { frontmatterHtml: '', body: src };
  const yamlText = rest.slice(0, closeMatch.index).replace(/\s+$/, '');
  let bodyStart = closeMatch.index + closeMatch[0].length;
  if (rest[bodyStart] === '\n') bodyStart++;
  const body = rest.slice(bodyStart);

  let data;
  try {
    data = parseSimpleYaml(yamlText);
  } catch {
    return { frontmatterHtml: renderFrontmatterRaw(yamlText), body };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) {
    return { frontmatterHtml: renderFrontmatterRaw(yamlText), body };
  }
  return { frontmatterHtml: renderFrontmatterTable(data), body };
}

/**
 * Minimal YAML parser — see file header for supported subset.
 * Throws on unsupported syntax so the caller can fall back.
 * @param {string} text
 */
export function parseSimpleYaml(text) {
  const lines = text.split('\n');
  const root = {};
  const indentOf = (line) => line.match(/^ */)[0].length;

  const scalar = (raw) => {
    const s = raw.trim();
    if (s === '' || s === '~' || s.toLowerCase() === 'null') return null;
    if (/^(true|yes|on)$/i.test(s)) return true;
    if (/^(false|no|off)$/i.test(s)) return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d+\.\d+$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      return inner ? inner.split(',').map(scalar) : [];
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      const obj = {};
      if (!inner) return obj;
      for (const pair of inner.split(',')) {
        const idx = pair.indexOf(':');
        if (idx === -1) continue;
        obj[pair.slice(0, idx).trim()] = scalar(pair.slice(idx + 1));
      }
      return obj;
    }
    return s;
  };

  // YAML requires whitespace before `#` for an inline comment.
  const stripComment = (line) => {
    let inSingle = false, inDouble = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === '#' && !inSingle && !inDouble && (k === 0 || /\s/.test(line[k - 1]))) {
        return line.slice(0, k);
      }
    }
    return line;
  };

  const isBlank = (l) => !l.trim() || /^\s*#/.test(l);

  // Consume a block literal (|) or folded (>) scalar.
  const readBlockScalar = (startIdx, style, baseIndent) => {
    const collected = [];
    let k = startIdx;
    let scalarIndent = null;
    while (k < lines.length) {
      const l = lines[k];
      if (!l.trim()) { collected.push(''); k++; continue; }
      const ind = indentOf(l);
      if (ind <= baseIndent) break;
      if (scalarIndent === null) scalarIndent = ind;
      if (ind < scalarIndent) break;
      collected.push(l.slice(scalarIndent));
      k++;
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    while (collected.length && collected[0] === '') collected.shift();
    const value = style === '|'
      ? collected.join('\n')
      : collected.reduce((acc, line, idx) => {
          if (idx === 0) return line;
          if (line === '' || acc.endsWith('\n')) return acc + '\n' + line;
          return acc + ' ' + line;
        }, '');
    return { value, next: k };
  };

  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (isBlank(line)) { i++; continue; }
    line = stripComment(line);
    if (!line.trim()) { i++; continue; }

    if (indentOf(line) !== 0) throw new Error('Unexpected indentation at top level');
    const m = line.match(FRONTMATTER_KEY_RE);
    if (!m) throw new Error(`Unparseable line: ${line}`);
    const key = m[1];
    const inline = m[2];

    // `key: |` or `key: >` — chomping indicator is intentionally ignored.
    const blockStyle = /^([|>])[+-]?\s*$/.exec(inline);
    if (blockStyle) {
      const { value, next } = readBlockScalar(i + 1, blockStyle[1], 0);
      root[key] = value;
      i = next;
      continue;
    }

    if (inline !== '') {
      // Fold plain multi-line continuations at top level only.
      let folded = inline;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) break;
        if (indentOf(l) === 0) break;
        folded += ' ' + l.trim();
        j++;
      }
      root[key] = scalar(folded);
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j >= lines.length) {
      root[key] = null;
      i = j;
      continue;
    }

    // YAML permits a block sequence at the SAME indent as its parent key
    // (compact zero-indent form). Otherwise a zero-indent non-dash line
    // closes the current key as null.
    const nextIsZeroIndentSeq = indentOf(lines[j]) === 0 && /^-(\s|$)/.test(lines[j]);
    if (indentOf(lines[j]) === 0 && !nextIsZeroIndentSeq) {
      root[key] = null;
      i = j;
      continue;
    }

    const childIndent = indentOf(lines[j]);
    if (nextIsZeroIndentSeq || /^\s+-(\s|$)/.test(lines[j])) {
      const items = [];
      while (j < lines.length) {
        const l = lines[j];
        if (isBlank(l)) { j++; continue; }
        if (indentOf(l) < childIndent) break;
        const sm = l.match(/^\s*-(?:\s+(.*))?$/);
        if (!sm) break;
        items.push(scalar(sm[1] ?? ''));
        j++;
      }
      root[key] = items;
    } else {
      const sub = {};
      while (j < lines.length) {
        const l = lines[j];
        if (isBlank(l)) { j++; continue; }
        if (indentOf(l) < childIndent) break;
        const sm = stripComment(l).match(/^\s+([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
        if (!sm) throw new Error(`Unparseable nested line: ${l}`);
        sub[sm[1]] = scalar(sm[2]);
        j++;
      }
      root[key] = sub;
    }
    i = j;
  }

  return root;
}

export function renderFrontmatterTable(data) {
  const rows = Object.entries(data).map(([k, v]) =>
    `<tr><th scope="row">${softBreakKey(k)}</th><td>${renderFrontmatterValue(v)}</td></tr>`
  ).join('');
  return `<table class="markdown-frontmatter"><tbody>${rows}</tbody></table>`;
}

/** Fallback when parseSimpleYaml throws — render the raw YAML verbatim. */
export function renderFrontmatterRaw(yamlText) {
  return `<pre class="markdown-frontmatter-raw" aria-label="Unparsed frontmatter"><code>${escapeHtml(yamlText)}</code></pre>`;
}

export function renderFrontmatterValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    if (!value.length) return '';
    return `<span class="frontmatter-chips">${
      value.map((v) => `<span class="frontmatter-chip">${escapeHtml(formatFrontmatterScalar(v))}</span>`).join('')
    }</span>`;
  }
  if (typeof value === 'object') {
    const rows = Object.entries(value).map(([k, v]) =>
      `<tr><th scope="row">${softBreakKey(k)}</th><td>${renderFrontmatterValue(v)}</td></tr>`
    ).join('');
    return `<table class="markdown-frontmatter markdown-frontmatter--nested"><tbody>${rows}</tbody></table>`;
  }
  return escapeHtml(formatFrontmatterScalar(value));
}

// Insert U+200B after _/- so long identifier keys wrap at natural
// boundaries instead of mid-word.
export function softBreakKey(key) {
  return escapeHtml(String(key)).replace(/([_-])/g, '$1\u200B');
}

export function formatFrontmatterScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
