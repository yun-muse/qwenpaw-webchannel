/*
 * QwenPaw WebChannel service worker (hand-written, no build step).
 *
 * HARD CONSTRAINTS — do not remove:
 * 1. Same-origin only. The only cross-origin traffic the app makes is the
 *    relay WebSocket (workers.dev) and the login POST to the relay HTTP
 *    endpoint. Any request whose URL origin differs from this worker's origin
 *    returns immediately below, without respondWith, so the browser handles it
 *    normally. Never intercept, cache or rewrite cross-origin requests.
 * 2. Never cache /version.json (it is the update probe) and never cache
 *    /webchannel.zip (plugin distribution archive, filename is not hashed).
 * 3. Non-GET requests always pass through untouched (login POST, etc.).
 *
 * The cache name is a version tag: bumping it drops every older bucket on
 * activate. Hashed files live under /assets/ and are safe to cache forever.
 */

const CACHE_NAME = 'webchannel-static-v1';

self.addEventListener('install', () => {
  // No precache: index.html is network-first so a redeploy is never masked.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    // Clone before handing the response back: its body is consumed downstream.
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function navigationFallback(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await caches.match('/index.html');
    if (cached) return cached;
    // No offline shell: reject so the browser reports a network error.
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Cross-origin (relay WS/HTTP): never touch it.
  if (url.origin !== self.location.origin) return;

  // Non-GET (e.g. the login POST): pass through.
  if (request.method !== 'GET') return;

  // Update probe, plugin archive and the worker itself always go to network.
  if (
    url.pathname === '/version.json' ||
    url.pathname === '/webchannel.zip' ||
    url.pathname === '/sw.js'
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationFallback(request));
    return;
  }

  // Content-hashed build output: immutable, cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else same-origin (manifest, icons): network-first.
  event.respondWith(networkFirst(request));
});
