/**
 * Build identity and the self-update watcher for the PWA shell.
 *
 * `__BUILD_ID__` / `__BUILD_GIT__` / `__BUILD_TIME__` come from the `define`
 * block in vite.config.ts. Everything here is independent of React: the
 * watcher and its fallback banner must work even when the login gate is shown.
 */

const DEV_BUILD = 'dev';
const RELOADED_KEY = 'webchannel.reloadedFor';
const LAST_RELOAD_KEY = 'webchannel.lastReloadAt';
const RELOAD_COOLDOWN_MS = 60_000;
const BANNER_ID = 'webchannel-update-banner';

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

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
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

/**
 * Refresh the service worker, drop every cached response, remember which
 * build we are reloading for, then reload.
 */
async function activateUpdate(targetBuild: string): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {
    /* the worker may be unsupported or not installed yet */
  }

  try {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch {
    /* Cache Storage can be unavailable (e.g. private mode) */
  }

  try {
    sessionStorage.setItem(RELOADED_KEY, targetBuild);
    sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage may be unavailable; still reload below */
  }

  location.reload();
}

/**
 * Polls `/version.json` and reloads once a newer build is served. No-op in
 * development and when the build id was not injected.
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
      const response = await fetch('/version.json', { cache: 'no-store' });
      if (!response.ok) return;

      const remoteBuild = readRemoteBuild((await response.json()) as unknown);
      if (!remoteBuild || remoteBuild === BUILD_ID) return;

      const reloadedFor = readSession(RELOADED_KEY);
      const lastReloadAt = Number(readSession(LAST_RELOAD_KEY) ?? '0');
      const recentlyReloaded =
        Number.isFinite(lastReloadAt) && Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS;

      if (remoteBuild === reloadedFor || recentlyReloaded) {
        showManualUpdateBanner();
        return;
      }

      await activateUpdate(remoteBuild);
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
