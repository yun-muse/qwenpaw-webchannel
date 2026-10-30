import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * `public/sw.js` runs in a service worker, not in the SPA bundle, so it is
 * tested by executing the real file in a VM with Cache Storage / fetch /
 * lifecycle fakes. The build stamp is applied by the Vite plugin, so the test
 * substitutes a known id for the placeholder exactly like the build does.
 */
const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const BUILD = 'm29-test-build';
const CACHE = `webchannel-static-${BUILD}`;
const ORIGIN = 'https://app.test';

if (!SOURCE.includes('__WE_CHANNEL_BUILD__')) {
  throw new Error('sw.js lost its __WE_CHANNEL_BUILD__ placeholder');
}
const COMPILED = SOURCE.replaceAll('__WE_CHANNEL_BUILD__', BUILD);

interface FakeResponse {
  ok: boolean;
  status: number;
  marker: string;
  clone(): FakeResponse;
}

function response(marker: string, ok = true, status = 200): FakeResponse {
  return {
    ok,
    status,
    marker,
    clone: () => response(`${marker}:clone`, ok, status),
  };
}

function urlOf(request: { url: string } | string): string {
  const raw = typeof request === 'string' ? request : request.url;
  return new URL(raw, `${ORIGIN}/`).pathname;
}

function makeRequest(path: string, extra: Record<string, unknown> = {}) {
  return {
    url: new URL(path, ORIGIN).toString(),
    method: 'GET',
    mode: 'no-cors',
    ...extra,
  };
}

function createWorker(options: { fetchImpl?: (request: unknown) => Promise<FakeResponse> } = {}) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const stores = new Map<string, Map<string, FakeResponse>>();
  const events: string[] = [];
  const fetched: string[] = [];
  const timers: Array<{ id: number; fn: () => void; ms: number; cancelled: boolean }> = [];

  const cacheApi = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      const target = store;
      return {
        async match(request: { url: string } | string) {
          return target.get(urlOf(request));
        },
        async put(request: { url: string } | string, value: FakeResponse) {
          target.set(urlOf(request), value);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      events.push(`delete:${name}`);
      return stores.delete(name);
    },
  };

  const client = {
    claim: async () => {
      events.push('claim');
    },
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    skipWaiting: () => {
      events.push('skipWaiting');
    },
    clients: client,
  };

  const fetchImpl =
    options.fetchImpl ??
    (async (request: unknown) =>
      response(`network:${urlOf(request as { url: string })}`));

  const context = {
    self,
    caches: cacheApi,
    fetch: (request: unknown) => {
      fetched.push(urlOf(request as { url: string }));
      return fetchImpl(request);
    },
    URL,
    Promise,
    console,
    setTimeout: (fn: () => void, ms: number) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms, cancelled: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cancelled = true;
    },
  };
  vm.createContext(context);
  vm.runInContext(COMPILED, context);

  const fire = (type: string, event: unknown): Promise<unknown> | undefined => {
    let responded: Promise<unknown> | undefined;
    const wrapped = {
      ...(event as Record<string, unknown>),
      respondWith(promise: Promise<unknown>) {
        responded = promise;
      },
      waitUntil(promise: Promise<unknown>) {
        responded = promise;
      },
    };
    for (const fn of listeners.get(type) ?? []) fn(wrapped);
    return responded;
  };

  return {
    cached(name: string) {
      return stores.get(name);
    },
    seed(name: string, path: string, value: FakeResponse) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      store.set(path, value);
    },
    fire,
    fetched,
    events,
    timers,
    runTimer(ms: number) {
      const timer = timers.find((item) => !item.cancelled && item.ms === ms);
      if (!timer) return false;
      timer.cancelled = true;
      timer.fn();
      return true;
    },
  };
}

describe('sw.js lifecycle', () => {
  it('installs with skipWaiting and claims clients', async () => {
    const worker = createWorker();
    await worker.fire('install', {});
    expect(worker.events).toContain('skipWaiting');

    const activated = worker.fire('activate', {});
    await activated;
    expect(worker.events.filter((event) => event.startsWith('delete:'))).toEqual([]);
    expect(worker.events).toContain('claim');
  });

  it('purges older build namespaces before claiming clients', async () => {
    const worker = createWorker();
    worker.seed(CACHE, '/assets/keep.js', response('keep'));
    worker.seed('webchannel-static-old', '/assets/old.js', response('old'));
    await worker.fire('activate', {});
    expect(worker.cached('webchannel-static-old')).toBeUndefined();
    expect(worker.cached(CACHE)?.has('/assets/keep.js')).toBe(true);
    expect(worker.events).toEqual([`delete:webchannel-static-old`, 'claim']);
  });
});

describe('sw.js navigation', () => {
  it('serves the network and caches the shell under /index.html', async () => {
    const worker = createWorker();
    const answer = worker.fire('fetch', { request: makeRequest('/?from=pwa', { mode: 'navigate' }) });
    const result = await answer;
    expect((result as FakeResponse).marker).toBe('network:/');
    expect(worker.cached(CACHE)?.get('/index.html')?.marker).toContain('network:/');
  });

  it('falls back to the cached shell only when the network throws', async () => {
    const worker = createWorker({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    worker.seed(CACHE, '/index.html', response('cached-shell'));
    const result = await worker.fire('fetch', {
      request: makeRequest('/', { mode: 'navigate' }),
    });
    expect((result as FakeResponse).marker).toBe('cached-shell');
  });

  it('rejects instead of hanging white when offline with no shell', async () => {
    const worker = createWorker({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    await expect(
      worker.fire('fetch', { request: makeRequest('/', { mode: 'navigate' }) }) as Promise<unknown>,
    ).rejects.toThrow('offline');
  });

  it('does not cache or replace a 404 shell response', async () => {
    const worker = createWorker({
      fetchImpl: async () => response('not-found', false, 404),
    });
    worker.seed(CACHE, '/index.html', response('cached-shell'));
    const result = await worker.fire('fetch', {
      request: makeRequest('/', { mode: 'navigate' }),
    });
    expect((result as FakeResponse).marker).toBe('not-found');
    expect(worker.cached(CACHE)?.get('/index.html')?.marker).toBe('cached-shell');
  });

  it('times out a hung navigation and uses the shell', async () => {
    const worker = createWorker({
      fetchImpl: () => new Promise<FakeResponse>(() => {}),
    });
    worker.seed(CACHE, '/index.html', response('cached-shell'));
    const answer = worker.fire('fetch', { request: makeRequest('/', { mode: 'navigate' }) });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(worker.runTimer(5000)).toBe(true);
    const result = await answer;
    expect((result as FakeResponse).marker).toBe('cached-shell');
  });
});

describe('sw.js passthrough', () => {
  // M33 removed the SPA-hosted /webchannel.zip (plugin-dist is the only
  // distribution channel), so its dedicated bypass was dropped too.
  it.each(['/version.json', '/sw.js'])('never intercepts %s', (path) => {
    const worker = createWorker();
    expect(worker.fire('fetch', { request: makeRequest(path) })).toBeUndefined();
  });

  it('never intercepts cross-origin or non-GET requests', () => {
    const worker = createWorker();
    expect(
      worker.fire('fetch', { request: makeRequest('https://relay.example/ws') }),
    ).toBeUndefined();
    expect(
      worker.fire('fetch', { request: makeRequest('/api/login', { method: 'POST' }) }),
    ).toBeUndefined();
  });
});

describe('sw.js assets', () => {
  it('serves hashed assets cache-first', async () => {
    const worker = createWorker();
    const first = await worker.fire('fetch', { request: makeRequest('/assets/index-abc.js') });
    expect((first as FakeResponse).marker).toContain('network:/assets/index-abc.js');
    expect(worker.fetched).toEqual(['/assets/index-abc.js']);

    const second = await worker.fire('fetch', { request: makeRequest('/assets/index-abc.js') });
    expect((second as FakeResponse).marker).toContain(':clone');
    expect(worker.fetched).toEqual(['/assets/index-abc.js']);
  });

  it('does not cache a failed asset response', async () => {
    const worker = createWorker({
      fetchImpl: async () => response('missing', false, 404),
    });
    await worker.fire('fetch', { request: makeRequest('/assets/gone.js') });
    expect(worker.cached(CACHE)?.has('/assets/gone.js')).toBe(false);
  });
});
