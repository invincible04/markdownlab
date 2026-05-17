/**
 * MarkdownLab service worker.
 *
 * Routing:
 *   HTML navigation   → network-first, cached /index.html as offline fallback
 *   Same-origin asset → cache-first, ignoreSearch so `?v=N` busts still hit
 *   Pinned CDN asset  → cache-first (URLs path-version-pinned)
 *   Everything else   → pass-through
 *
 * Bump CACHE_VERSION on any change to SHELL, CDN_PRECACHE, or routing —
 * activate() purges every cache whose name doesn't match.
 */

const CACHE_VERSION = 'markdownlab-v10';

const SHELL = [
  '/',
  '/index.html',
  '/404.html',
  '/css/tokens.css',
  '/css/styles.css',
  '/css/mobile.css',
  '/js/app.js',
  '/js/db.js',
  '/js/palette.js',
  '/js/projects.js',
  '/js/sidebar.js',
  '/js/tabs.js',
  '/js/utils.js',
  '/js/examples.js',
  '/js/frontmatter.js',
  '/js/math.js',
  '/js/overlays.js',
  '/js/pdf-print.js',
  '/js/github.js',
  '/js/404.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/og-image.png',
];

// Keep in sync with <script>/<link> tags in index.html and the mermaid
// dynamic import in app.js.
const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/npm/marked-gfm-heading-id@3.1.3/lib/index.umd.js',
  'https://cdn.jsdelivr.net/npm/marked-footnote@1.2.4/dist/index.umd.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.7/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
  'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-dark.min.css',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-light.min.css',
];

// Runtime prefix match — mermaid lazy-loads per-diagram chunks that can't
// be enumerated at install time.
const CDN_PREFIXES = [
  'https://cdn.jsdelivr.net/npm/marked@',
  'https://cdn.jsdelivr.net/npm/marked-gfm-heading-id@',
  'https://cdn.jsdelivr.net/npm/marked-footnote@',
  'https://cdn.jsdelivr.net/npm/dompurify@',
  'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@',
  'https://cdn.jsdelivr.net/npm/katex@',
  'https://cdn.jsdelivr.net/npm/highlight.js@',
  'https://cdn.jsdelivr.net/npm/mermaid@',
];

const OFFLINE_FALLBACK =
  '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
  '<body style="font-family:system-ui;padding:2rem">' +
  '<h1>Offline</h1><p>MarkdownLab hasn\'t been loaded online yet. ' +
  'Connect once to cache the app, then it\'ll work offline.</p>';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // SHELL uses CORS so cache.match can read content types; CDN uses
    // no-cors so opaque responses from non-CORS hosts still cache.
    await cache.addAll(SHELL);
    await Promise.allSettled(
      CDN_PRECACHE.map((url) =>
        cache.add(new Request(url, { mode: 'no-cors' })).catch(() => null)
      )
    );
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }

  const isSameOrigin = new URL(req.url).origin === self.location.origin;
  const isPinnedCdn = CDN_PREFIXES.some((p) => req.url.startsWith(p));
  if (isSameOrigin || isPinnedCdn) {
    event.respondWith(cacheFirst(req));
  }
});

// Network-first so deploys are visible when online; cached shell is the
// offline fallback.
async function networkFirstShell(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put('/index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = (await cache.match('/index.html')) || (await cache.match('/'));
    if (cached) return cached;
    return new Response(OFFLINE_FALLBACK, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

// Cache-first with background revalidation. Same-origin matches ignore
// search so `?v=N` busts hit the versionless entry; CDN URLs are
// path-pinned so exact match is correct.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const isSameOrigin = new URL(req.url).origin === self.location.origin;
  const cached = await cache.match(req, { ignoreSearch: isSameOrigin });

  if (cached) {
    fetch(req)
      .then((fresh) => { if (fresh?.ok) cache.put(req, fresh).catch(() => {}); })
      .catch(() => {});
    return cached;
  }

  const fresh = await fetch(req);
  if (fresh?.ok) cache.put(req, fresh.clone()).catch(() => {});
  return fresh;
}
