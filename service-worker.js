/**
 * MarkdownLab service worker — offline cache.
 *
 * Routing:
 *   HTML navigation   → network-first, falls back to cached /index.html
 *   Same-origin asset → cache-first, ignoreSearch so `?v=N` cache-busts
 *                       still hit the versionless precached entry
 *   Pinned CDN asset  → cache-first (URLs version-pinned in the path)
 *   Everything else   → pass-through (don't bloat the cache)
 *
 * Bump CACHE_VERSION on any change to SHELL, CDN_PRECACHE, or routing.
 * activate() purges every cache whose name doesn't match.
 */

const CACHE_VERSION = 'markdownlab-v5';

// Pre-cached on install so the first offline visit works even if the
// user has never fetched a given asset before.
const SHELL = [
  '/',
  '/index.html',
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
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/og-image.png',
];

// Keep in sync with <script>/<link> tags in index.html and dynamic
// imports in app.js (mermaid).
const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/npm/marked-gfm-heading-id@3.1.3/lib/index.umd.js',
  'https://cdn.jsdelivr.net/npm/marked-footnote@1.2.4/dist/index.umd.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.7/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
  'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-dark.min.css',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-light.min.css',
];

// Runtime prefix match for version-pinned CDNs. Mermaid lazy-loads
// diagram-type chunks (e.g. mermaid@10.9.1/dist/chunks/flowchart-<hash>.mjs)
// that can't be enumerated up front.
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
    // SHELL: CORS responses so cache.match can inspect content types.
    // CDN: no-cors so opaque responses from non-CORS hosts still cache.
    await cache.addAll(SHELL);
    await Promise.allSettled(
      CDN_PRECACHE.map((url) =>
        cache.add(new Request(url, { mode: 'no-cors' })).catch(() => null)
      )
    );
    // First install auto-activates (no existing controller). Subsequent
    // updates wait for the app's SKIP_WAITING message.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
    );
    // Take control of pages that loaded before this SW activated.
    await self.clients.claim();
  })());
});

// Lets the app trigger activation of a waiting SW.
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
  // Other origins: pass through uncached.
});

// HTML: network-first so deploys are visible when online; cached shell
// is the offline fallback.
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
// search so `?v=N` busts still hit the versionless entry; CDN URLs are
// path-pinned so exact match is correct.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const isSameOrigin = new URL(req.url).origin === self.location.origin;
  const cached = await cache.match(req, { ignoreSearch: isSameOrigin });

  if (cached) {
    // Background revalidate — don't await, don't surface errors.
    fetch(req)
      .then((fresh) => { if (fresh?.ok) cache.put(req, fresh).catch(() => {}); })
      .catch(() => {});
    return cached;
  }

  const fresh = await fetch(req);
  if (fresh?.ok) cache.put(req, fresh.clone()).catch(() => {});
  return fresh;
}
