/**
 * Build identity and the self-update watcher for the PWA shell.
 *
 * `__BUILD_ID__` / `__BUILD_GIT__` / `__BUILD_TIME__` come from the `define`
 * block in vite.config.ts. Everything here is independent of React: the
 * watcher and its fallback banner must work even when the login gate is shown.
 *
 * M29: this module never deletes caches. The service worker's `activate` owns
 * the purge (its cache name carries the build id), and we reload only after
 * the new worker has taken control. A reload can therefore never land on a
 * half-purged shell, and a failed update leaves the old cache intact.
 */

import { decideUpdate } from './lib/versionGuard';

const DEV_BUILD = 'dev';
const RELOADED_KEY = 'webchannel.reloadedFor';
const LAST_RELOAD_KEY = 'webchannel.lastReloadAt';
const BANNER_ID = 'webchannel-update-banner';

/** `/version.json` must answer quickly; a sleeping radio must not pin it. */
const VERSION_TIMEOUT_MS = 6_000;
/** How long `registration.update()` may take before we reload anyway. */
const UPDATE_TIMEOUT_MS = 4_000;
/** How long to wait for the new worker to claim this page. */
const TAKEOVER_TIMEOUT_MS = 4_000;

/** `typeof` keeps this safe when the constants were not injected at all. */
const injected =
  typeof __BUILD_ID__ === 'string' &&
  typeof __BUILD_GIT__ === 'string' &&
  typeof __BUILD_TIME__ === 'string';

export const BUILD_ID = import.meta.env.PROD && injected ? __BUILD_ID__ : DEV_BUILD;
export const BUILD_GIT = import.meta.env.PROD && injected ? __BUILD_GIT__ : DEV_BUILD;
export const BUILD_TIME = import.meta.env.PROD && injected ? __BUILD_TIME__ : DEV_BUILD;

/** "版本 2026-10-28 · 7d3c791"; a missing git hash leaves only the date. */
export function formatBuildLabel(): string {
  if (BUILD_ID === DEV_BUILD) return '版本 dev';
  const date = BUILD_TIME.slice(0, 10);
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const git = BUILD_GIT && BUILD_GIT !== 'unknown' ? BUILD_GIT : '';
  const parts = [hasDate ? date : '', git].filter(Boolean);
  return parts.length ? `版本 ${parts.join(' · ')}` : '版本 dev';
}

function readRemoteBuild(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const build = (payload as { build?: unknown }).build;
  return typeof build === 'string' ? build.trim() : '';
}

/**
 * Update markers must survive a process kill: a PWA reopens as a brand-new
 * tab with an empty sessionStorage, which disabled M10's anti-loop gates on
 * exactly the cold start that goes wrong.
 */
function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable; the caller still reloads */
  }
}

/**
 * Plain-DOM banner used when an automatic reload already happened for this
 * build but the page is still old: refreshing once more is the user's call.
 */
function showManualUpdateBanner(): void {
  if (document.getElementById(BANNER_ID)) return;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:2147483647',
    'display:flex',
    'flex-wrap:wrap',
    'align-items:center',
    'justify-content:center',
    'gap:8px 14px',
    'padding:10px 16px',
    'background:#c96442',
    'color:#fff',
    'font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
    'box-shadow:0 2px 10px rgba(28,25,23,.28)',
    'text-align:center',
  ].join(';');

  const message = document.createElement('span');
  message.textContent = '新版本已发布，但自动更新未生效。';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '刷新页面';
  button.style.cssText = [
    'padding:4px 12px',
    'border:1px solid rgba(255,255,255,.65)',
    'border-radius:999px',
    'background:#fff',
    'color:#a63f1f',
    'font:inherit',
    'font-weight:600',
    'cursor:pointer',
  ].join(';');
  button.addEventListener('click', () => {
    location.reload();
  });

  banner.append(message, button);
  (document.body || document.documentElement).appendChild(banner);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Resolves true when a new worker has claimed this page, false on timeout. */
function waitForController(timeoutMs: number): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  const container = navigator.serviceWorker;
  if (!container.controller) return Promise.resolve(false);

  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      container.removeEventListener('controllerchange', onChange);
      resolve(value);
    };
    const onChange = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    container.addEventListener('controllerchange', onChange);
  });
}

/**
 * Refresh the service worker, wait for it to take over, remember which build
 * we are reloading for, then reload. The purge happens inside the worker's
 * `activate` — never here.
 */
async function activateUpdate(targetBuild: string): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      // Attach before update(): activation can be quick enough to race us.
      const takeover = waitForController(TAKEOVER_TIMEOUT_MS);
      await withTimeout(registration.update(), UPDATE_TIMEOUT_MS);
      await takeover;
    }
  } catch {
    /* the worker may be unsupported or the update may be offline */
  }

  writeLocal(RELOADED_KEY, targetBuild);
  writeLocal(LAST_RELOAD_KEY, String(Date.now()));
  location.reload();
}

/** One no-store probe; aborts instead of hanging on a waking radio. */
async function fetchRemoteBuild(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);
  try {
    const response = await fetch('/version.json', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return '';
    return readRemoteBuild((await response.json()) as unknown);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls `/version.json` and reloads once a newer build is served. No-op in
 * development and when the build id was not injected. Every network failure
 * is swallowed: this watcher can never delay or block first render.
 */
export function startVersionWatch(): void {
  if (!import.meta.env.PROD || BUILD_ID === DEV_BUILD) return;
  if (typeof window === 'undefined') return;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* the version poll still works without a service worker */
    });
  }

  let inFlight = false;

  const check = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const remoteBuild = await fetchRemoteBuild();
      const decision = decideUpdate({
        remoteBuild,
        localBuild: BUILD_ID,
        reloadedFor: readLocal(RELOADED_KEY),
        lastReloadAt: Number(readLocal(LAST_RELOAD_KEY) ?? '0'),
        now: Date.now(),
      });

      if (decision === 'banner') showManualUpdateBanner();
      else if (decision === 'update') await activateUpdate(remoteBuild);
    } catch {
      /* offline, 404 or invalid JSON: stay quiet and retry on the next trigger */
    } finally {
      inFlight = false;
    }
  };

  void check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
}
