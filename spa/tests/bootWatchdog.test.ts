import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The watchdog must be inline in index.html (it has to run without the
 * bundle), so the test runs the *actual* inline script in a VM instead of
 * re-implementing it in TypeScript.
 */
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MATCH = HTML.match(/<script id="boot-watchdog">([\s\S]*?)<\/script>/);
if (!MATCH) throw new Error('index.html is missing the boot-watchdog script');
const SOURCE = MATCH[1];

const NOW = 1_800_000_000_000;
const COOLDOWN = 10 * 60 * 1000;

function element(tagName: string) {
  return {
    tagName,
    hidden: false,
    textContent: '',
    parentNode: null as { removeChild: (child: unknown) => void } | null,
    attrs: {} as Record<string, string>,
    onclick: null as null | (() => void),
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
    },
    getAttribute(key: string) {
      return this.attrs[key] ?? null;
    },
  };
}

function boot(
  options: {
    marker?: number;
    sessionMarker?: number;
    caches?: 'ok' | 'hang' | 'missing';
    deadline?: number;
    storageThrows?: boolean;
  } = {},
) {
  const splash = element('DIV');
  const hint = element('P');
  const retry = element('BUTTON');
  retry.hidden = true;

  const body = {
    removeChild(child: unknown) {
      if (child === splash) splash.parentNode = null;
    },
  };
  splash.parentNode = body;

  const events = new Map<string, Array<(event: unknown) => void>>();
  const timers: Array<{ id: number; fn: () => void; ms: number; cancelled: boolean }> = [];
  const store = new Map<string, string>();
  const session = new Map<string, string>();
  if (options.marker != null) store.set('webchannel.selfHealAt', String(options.marker));
  if (options.sessionMarker != null) session.set('webchannel.selfHealAt', String(options.sessionMarker));

  const deleted: string[] = [];
  let reloads = 0;

  const window: Record<string, unknown> = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = events.get(type) ?? [];
      list.push(fn);
      events.set(type, list);
    },
    caches:
      options.caches === 'missing'
        ? undefined
        : {
            keys: () =>
              options.caches === 'hang'
                ? new Promise<string[]>(() => {})
                : Promise.resolve(['webchannel-static-old', 'other-cache']),
            delete: (name: string) => {
              deleted.push(name);
              return Promise.resolve(true);
            },
          },
  };

  const context = {
    window,
    document: {
      getElementById(id: string) {
        if (id === 'boot-splash') return splash;
        if (id === 'boot-hint') return hint;
        if (id === 'boot-retry') return retry;
        return null;
      },
    },
    localStorage: {
      getItem: (key: string) => {
        if (options.storageThrows) throw new Error('storage blocked');
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.storageThrows) throw new Error('storage blocked');
        store.set(key, value);
      },
    },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
    },
    caches: window.caches,
    location: {
      reload: () => {
        reloads += 1;
      },
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms, cancelled: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cancelled = true;
    },
    Date: { now: () => NOW },
    Number,
    String,
    RegExp,
    isFinite,
    Promise,
    console,
  };
  window.__webchannelBootDeadlineMs = undefined;
  if (options.deadline != null) window.__webchannelBootDeadlineMs = options.deadline;
  // `window` is the global object in a real page.
  Object.assign(context, window);
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  const fire = (type: string, event: unknown) => {
    for (const fn of events.get(type) ?? []) fn(event);
  };
  const runTimer = (ms: number) => {
    const timer = timers.find((item) => !item.cancelled && item.ms === ms);
    if (timer) {
      timer.cancelled = true;
      timer.fn();
    }
    return Boolean(timer);
  };
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

  return {
    window: window as unknown as {
      __webchannelBootReady?: () => void;
      __webchannelBoot?: { deadline: number; fail: () => void; dismiss: () => void };
    },
    splash,
    hint,
    retry,
    store,
    session,
    timers,
    deleted,
    reloads: () => reloads,
    fire,
    runTimer,
    flush,
  };
}

describe('index.html boot surface', () => {
  it('renders the splash inline, before the React root', () => {
    expect(HTML).toContain('id="boot-splash"');
    expect(HTML).toContain('QwenPaw WebChannel');
    expect(HTML.indexOf('id="boot-splash"')).toBeLessThan(HTML.indexOf('id="root"'));
    // No external asset: the splash and its styles ship with index.html.
    expect(MATCH![0]).not.toContain('src=');
    expect(HTML).toContain('@keyframes boot-slide');
  });

  it('defines the boot hook before the module bundle', () => {
    expect(HTML.indexOf('id="boot-watchdog"')).toBeLessThan(HTML.indexOf('type="module"'));
    expect(SOURCE).toContain('__webchannelBootReady');
  });
});

describe('boot watchdog', () => {
  it('arms the 12s deadline and dismisses on the first React commit', () => {
    const harness = boot();
    expect(harness.timers.map((t) => t.ms)).toEqual([12000]);
    expect(harness.window.__webchannelBoot?.deadline).toBe(12000);

    harness.window.__webchannelBootReady!();
    expect(harness.splash.parentNode).toBeNull();

    // The cancelled timer must not fire after mount.
    harness.runTimer(12000);
    expect(harness.reloads()).toBe(0);
    expect(harness.deleted).toEqual([]);
  });

  it('self-heals once on the deadline: stamp, clear caches, reload', async () => {
    const harness = boot();
    harness.runTimer(12000);
    await harness.flush();

    expect(harness.store.get('webchannel.selfHealAt')).toBe(String(NOW));
    expect(harness.deleted).toEqual(['webchannel-static-old', 'other-cache']);
    expect(harness.reloads()).toBe(1);
    expect(harness.splash.attrs['data-state']).toBe('healing');
    expect(harness.hint.textContent).toBe('正在修复启动…');
  });

  it('does not loop inside the 10-minute window; shows a retry card', async () => {
    const harness = boot({ marker: NOW - 60_000 });
    harness.runTimer(12000);
    await harness.flush();

    expect(harness.reloads()).toBe(0);
    expect(harness.deleted).toEqual([]);
    expect(harness.splash.attrs['data-state']).toBe('stuck');
    expect(harness.retry.hidden).toBe(false);
    expect(harness.hint.textContent).toContain('启动没有完成');

    harness.retry.onclick!();
    expect(harness.reloads()).toBe(1);
  });

  it('heals again once the marker is older than the window', async () => {
    const harness = boot({ marker: NOW - COOLDOWN - 1 });
    harness.runTimer(12000);
    await harness.flush();
    expect(harness.reloads()).toBe(1);
  });

  it('heals immediately on a script load error', async () => {
    const harness = boot();
    harness.fire('error', { target: { tagName: 'SCRIPT' } });
    await harness.flush();

    expect(harness.reloads()).toBe(1);
    expect(harness.deleted.length).toBe(2);
    // The deadline was cancelled, not merely ignored.
    expect(harness.runTimer(12000)).toBe(false);
  });

  it('treats a failed stylesheet as fatal but ignores a failed icon', async () => {
    const icon = boot();
    icon.fire('error', {
      target: { tagName: 'LINK', getAttribute: () => 'icon' },
    });
    await icon.flush();
    expect(icon.reloads()).toBe(0);

    const stylesheet = boot();
    stylesheet.fire('error', {
      target: { tagName: 'LINK', getAttribute: () => 'stylesheet' },
    });
    await stylesheet.flush();
    expect(stylesheet.reloads()).toBe(1);
  });

  it('routes dynamic chunk failures into the same heal path', async () => {
    const harness = boot();
    harness.fire('unhandledrejection', {
      reason: { message: 'Failed to fetch dynamically imported module: /assets/x.js' },
    });
    await harness.flush();
    expect(harness.reloads()).toBe(1);

    const unrelated = boot();
    unrelated.fire('unhandledrejection', { reason: new Error('boom') });
    await unrelated.flush();
    expect(unrelated.reloads()).toBe(0);
  });

  it('never heals after the app mounted', async () => {
    const harness = boot();
    harness.window.__webchannelBootReady!();
    harness.fire('error', { target: { tagName: 'SCRIPT' } });
    await harness.flush();
    expect(harness.reloads()).toBe(0);
  });

  it('reloads even when Cache Storage is missing or hangs', async () => {
    const missing = boot({ caches: 'missing' });
    missing.runTimer(12000);
    await missing.flush();
    expect(missing.reloads()).toBe(1);

    const hanging = boot({ caches: 'hang' });
    hanging.runTimer(12000);
    await hanging.flush();
    expect(hanging.reloads()).toBe(0);
    // The 1.5s cap wins the race and still reloads.
    hanging.runTimer(1500);
    await hanging.flush();
    expect(hanging.reloads()).toBe(1);
  });

  it('falls back to sessionStorage when localStorage is blocked', async () => {
    const first = boot({ storageThrows: true });
    first.runTimer(12000);
    await first.flush();
    expect(first.reloads()).toBe(1);
    expect(first.session.get('webchannel.selfHealAt')).toBe(String(NOW));

    // The same tab reloads: sessionStorage still holds the marker, so the
    // second failure shows the retry card instead of looping.
    const second = boot({ storageThrows: true, sessionMarker: NOW - 1_000 });
    second.runTimer(12000);
    await second.flush();
    expect(second.reloads()).toBe(0);
    expect(second.splash.attrs['data-state']).toBe('stuck');
  });

  it('accepts a deadline override for the e2e harness', () => {
    const harness = boot({ deadline: 800 });
    expect(harness.timers.map((t) => t.ms)).toEqual([800]);
    expect(harness.window.__webchannelBoot?.deadline).toBe(800);
  });
});
