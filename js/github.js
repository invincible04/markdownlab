// GitHub URL parsing and unauthenticated fetch helpers for public repos.
// Pure module — no DOM or app state.

const RAW_HOST = 'raw.githubusercontent.com';
const WEB_HOST = 'github.com';
const API_BASE = 'https://api.github.com';

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MD_RE = /\.(md|markdown|txt)$/i;

const _repoInfoCache = new Map();

// ── URL parsing ──────────────────────────────────────────────────────

/**
 * @param {string} input
 * @returns {{kind:'blob'|'raw'|'tree'|'repo', owner:string, repo:string, ref:string|null, path:string} | null}
 */
export function parseGitHubUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);

  if (host === RAW_HOST) {
    if (segments.length < 4) return null;
    const [owner, repo, ref, ...rest] = segments;
    return { kind: 'raw', owner, repo, ref, path: rest.join('/') };
  }

  if (host === WEB_HOST || host === 'www.github.com') {
    if (segments.length < 2) return null;
    const [owner, repo, marker, ...rest] = segments;
    const cleanRepo = repo.replace(/\.git$/i, '');
    if (!marker) {
      return { kind: 'repo', owner, repo: cleanRepo, ref: null, path: '' };
    }
    if (marker === 'blob' || marker === 'tree') {
      if (rest.length < 1) return null;
      const [ref, ...pathParts] = rest;
      return { kind: marker, owner, repo: cleanRepo, ref, path: pathParts.join('/') };
    }
    return null;
  }

  return null;
}

function decodeSegment(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── URL builders ─────────────────────────────────────────────────────

const encodePath = (p) =>
  (p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');

export function toRawUrl({ owner, repo, ref, path }) {
  return `https://${RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

export function toBlobUrl({ owner, repo, ref, path }) {
  return `https://${WEB_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

export function toTreeUrl({ owner, repo, ref, path }) {
  const enc = encodePath(path);
  const tail = enc ? `/${enc}` : '';
  return `https://${WEB_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(ref)}${tail}`;
}

// ── Path resolution ──────────────────────────────────────────────────

/**
 * Resolve a relative href against a file's path inside a repo.
 * Leading-slash hrefs are treated as repo-root (GitHub convention).
 */
export function resolvePathRelative(basePath, href) {
  if (!href) return basePath || '';
  let h = href;
  try { h = decodeURI(href); } catch {}

  if (h.startsWith('/')) return h.replace(/^\/+/, '');

  const baseParts = (basePath || '').split('/').slice(0, -1);
  for (const part of h.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

// ── Fetchers ─────────────────────────────────────────────────────────

function ghError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function mapStatusError(status) {
  if (status === 404) return ghError('Not found', 'not_found');
  if (status === 403) return ghError('GitHub rate limit reached. Try again in a few minutes.', 'rate_limited');
  return ghError(`GitHub responded ${status}`, 'http_error');
}

function fetchWithTimeout(url, init = {}) {
  // AbortSignal.timeout is widely supported (Safari 16+, Chrome 103+, FF 100+);
  // a stuck fetch would otherwise leave the modal spinning forever.
  const signal = AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined;
  return fetch(url, { credentials: 'omit', redirect: 'follow', signal, ...init });
}

async function fetchTextStrict(url) {
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw ghError('Request to GitHub timed out.', 'timeout');
    }
    throw ghError('Network error reaching GitHub.', 'network');
  }
  if (!res.ok) throw mapStatusError(res.status);

  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) {
    throw ghError(`File is too large (${(len / 1024 / 1024).toFixed(1)} MB, max 5 MB)`, 'too_large');
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) {
    throw ghError('File is too large (max 5 MB)', 'too_large');
  }
  return text;
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw ghError('Request to GitHub timed out.', 'timeout');
    }
    throw ghError('Network error reaching GitHub.', 'network');
  }
  if (!res.ok) throw mapStatusError(res.status);
  return res.json();
}

export async function resolveRepoDefaults({ owner, repo }) {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  if (_repoInfoCache.has(key)) return _repoInfoCache.get(key);
  const info = await fetchJson(`${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  const out = { defaultBranch: info.default_branch || 'main' };
  _repoInfoCache.set(key, out);
  return out;
}

export async function resolveReadme({ owner, repo, ref, path = '' }) {
  const dir = path ? `/${encodePath(path)}` : '';
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme${dir}${qs}`;
  const data = await fetchJson(url);
  return { path: data.path, ref: ref || data.sha || null, downloadUrl: data.download_url };
}

/**
 * Parse a GitHub URL and return { text, source, suggestedName }.
 * Throws Error with `.code` on failure.
 */
export async function fetchMarkdownFromGitHub(input) {
  const parsed = parseGitHubUrl(input);
  if (!parsed) throw ghError("That doesn't look like a GitHub URL.", 'bad_url');

  let { kind, owner, repo, ref, path } = parsed;

  if (kind === 'repo' || kind === 'tree') {
    if (!ref) {
      const { defaultBranch } = await resolveRepoDefaults({ owner, repo });
      ref = defaultBranch;
    }
    let readme;
    try {
      readme = await resolveReadme({ owner, repo, ref, path });
    } catch (err) {
      if (err.code === 'not_found') {
        throw ghError(
          path ? `No README found at ${path}.` : `No README found in ${owner}/${repo}.`,
          'no_readme',
        );
      }
      throw err;
    }
    path = readme.path;
  }

  if (!MD_RE.test(path)) {
    throw ghError('That URL does not point to a markdown file (.md, .markdown, .txt).', 'not_markdown');
  }

  const text = await fetchTextStrict(toRawUrl({ owner, repo, ref, path }));
  return {
    text,
    source: { kind: 'github', owner, repo, ref, path },
    suggestedName: path.split('/').pop() || 'README.md',
  };
}

export async function fetchChildMarkdown(parentSource, childPath) {
  if (!MD_RE.test(childPath)) {
    throw ghError('Linked file is not a markdown file.', 'not_markdown');
  }
  const { owner, repo, ref } = parentSource;
  const text = await fetchTextStrict(toRawUrl({ owner, repo, ref, path: childPath }));
  return {
    text,
    source: { kind: 'github', owner, repo, ref, path: childPath },
    suggestedName: childPath.split('/').pop() || 'linked.md',
  };
}
