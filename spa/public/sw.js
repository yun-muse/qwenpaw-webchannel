/*
 * QwenPaw WebChannel service worker (hand-written, no build step).
 *
 * HARD CONSTRAINTS — do not remove:
 * 1. Same-origin only. The only cross-origin traffic the app makes is the
 *    relay WebSocket (workers.dev) and the login POST to the relay HTTP
 *    endpoint. Any request whose URL origin differs from this worker's origin
 *    returns immediately below, without respondWith, so the browser handles it
 *    normally. Never intercept, cache or rewrite cross-origin requests.
 * 2. Never cache /version.json (it is the update probe). This origin serves no
 *    other unhashed download: the plugin ZIP ships from the plugin-dist Pages
 *    project, not from here (M33 removed the tracked copy under public/).
 * 3. Non-GET requests always pass through untouched (login POST, etc.).
 *
 * M29 — cold-start blank page:
 * - CACHE_NAME carries the build id, injected at build time by
 *   `serviceWorkerBuildPlugin` in vite.config.ts. A redeploy therefore changes
 *   sw.js bytes, installs a new worker, and the new worker's `activate` — not
 *   the page — owns the purge. The page reloads only after `controllerchange`,
 *   so it can never land on a half-purged shell.
 * - Navigation is network-first with a timeout. The shell is cached only from
 *   a successful navigation (and under a stable `/index.html` key), and the
 *   cached shell is used only when the network genuinely fails. A 404/5xx is
 *   returned as-is and never cached as the app shell.
 * - Hashed /assets/ stay cache-first: they are immutable and only ever
 *   referenced by a shell from the same cache generation.
 */

const BUILD = '__WE_CHANNEL_BUILD__';
const CACHE_NAME = `webchannel-static-${BUILD}`;
const SHELL_KEY = '/index.html';

/** A sleeping phone radio must not hold the navigation white for minutes. */
const NAV_TIMEOUT_MS = 5000;

self.addEventListener('install', () => {
  // No precache: index.html is network-first so a redeploy is never masked.
  // A new build changes this file (see BUILD), which is what installs us.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge *before* claiming: once controllerchange reaches a page, every
      // stale bucket is already gone. No page ever triggers this purge.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('navigation timeout')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

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

/**
 * Network-first navigation. The shell is stored under one stable key so the
 * offline fallback does not depend on which URL the PWA was launched from.
 * Fallback happens only when fetch throws (offline / DNS / radio asleep) or
 * exceeds NAV_TIMEOUT_MS; an HTTP error response is surfaced, never cached.
 */
async function navigation(request) {
  const cache = await caches.open(CACHE_NAME);
  // no-cache forces revalidation of the shell even if a host forgot the
  // `_headers` rule; a stale index.html must never mask a deploy.
  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response && response.ok) {
      cache.put(SHELL_KEY, response.clone()).catch(() => {});
    }
    return response;
  });

  try {
    return await withTimeout(network, NAV_TIMEOUT_MS);
  } catch (error) {
    const cached = await cache.match(SHELL_KEY);
    if (cached) return cached;
    // First install with no shell yet: report the network error instead of
    // leaving the navigation pending forever.
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

  // Update probe and the worker itself always go to network.
  if (url.pathname === '/version.json' || url.pathname === '/sw.js') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
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
