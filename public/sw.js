// Kernos OS service worker — deliberately narrow scope.
//
// This app depends on cross-origin isolation (COOP: same-origin + COEP:
// require-corp, set in vercel.json) for BNLM's SharedArrayBuffer-based
// parallel training workers. A service worker that hands back a hand-built
// Response, or one fetched in 'no-cors' mode, silently drops those headers
// and breaks isolation for anyone served from the cache. So this worker
// never constructs a Response itself — every respondWith() below resolves
// to either a real fetch() result (headers intact, exactly as Vercel sent
// them) or a previously cached copy of exactly that.
//
// Scope: same-origin static assets and page navigations only. /api/*,
// Supabase, Groq, and PostHog are never touched — those requests fall
// through to the network untouched (no fetch listener match).

const CACHE_VERSION = 'kernos-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isHashedAsset(url) {
  // Vite content-hashes everything under /assets — a cache hit is always
  // correct, since a content change means a new filename, not stale bytes.
  return url.pathname.startsWith('/assets/');
}

function isStableStaticAsset(url) {
  // Fixed filenames (manifest, icons) that can change contents across a
  // deploy without changing name — safe to serve from cache instantly, but
  // worth refreshing in the background rather than caching forever.
  return /\.(svg|png|ico|woff2?|webmanifest)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Network-first: always prefer the live page (current headers, current
    // build) and only fall back to a cached shell if the network is
    // genuinely unreachable.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_VERSION);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          return (await cache.match(request)) || (await cache.match('/')) || Response.error();
        }
      })()
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      })()
    );
    return;
  }

  if (isStableStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((fresh) => {
            if (fresh.ok) cache.put(request, fresh.clone());
            return fresh;
          })
          .catch(() => undefined);
        return cached || (await network) || Response.error();
      })()
    );
  }
});
