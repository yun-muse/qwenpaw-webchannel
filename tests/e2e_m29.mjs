#!/usr/bin/env node
/**
 * M29 — PWA cold-start / service-worker suite.
 *
 * Builds the SPA, then serves `spa/dist` (and mutated "v2 deployments") from a
 * local static server that can delay or fail individual asset requests. Each
 * scenario uses its own Chromium profile so service workers, Cache Storage
 * and localStorage survive a real context shutdown — the closest local
 * equivalent of killing a PWA and reopening it.
 *
 * Scenarios:
 *   1. normal cold start: splash paints before the bundle, app mount removes it
 *   2. offline cold restart: network-first navigation falls back to the cached
 *      shell and the app still mounts
 *   3. version update: new deploy + /version.json mismatch → new sw.js takes
 *      control → reload lands on the new build, old cache namespace is purged
 *   4. bad shell: the next cold start gets a shell whose JS 404s → watchdog
 *      clears Cache Storage, reloads once, app mounts
 *   5. anti-loop: a permanently broken shell → one heal, then a visible retry
 *      card instead of an endless reload loop
 *   6. the legacy sequence on the fixed build: update reload + one failed
 *      bundle request → splash + one self-heal → app
 *
 * Optional legacy evidence (M29 report):
 *   M29_LEGACY_DIR=/tmp/m29-v1-dist node e2e_m29.mjs
 * runs the same purge→reload→asset-failure sequence against the pre-M29 build
 * and asserts the white page. It is evidence, not a regression check.
 *
 * Env:
 *   M29_SKIP_BUILD=1   reuse spa/dist
 *   M29_ONLY=...       1|2|3|4|5|6|legacy (comma separated)
 *   M29_HEADED=1
 *   OUT_DIR            screenshots; default ./m29-shots
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPA_DIR = join(ROOT, 'spa');
const OUT_DIR = resolve(HERE, process.env.OUT_DIR || './m29-shots');
const PORT = Number(process.env.M29_PORT || 4190);
const BASE = `http://127.0.0.1:${PORT}/`;
const HEADED = process.env.M29_HEADED === '1';
const ONLY = (process.env.M29_ONLY || '').split(',').filter(Boolean);

const log = (...args) => console.log('[m29-e2e]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const shot = (name) => join(OUT_DIR, `m29-${name}.png`);
mkdirSync(OUT_DIR, { recursive: true });

function run(cmd, args, cwd) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('exit', (code) =>
      code === 0 ? resolveP(out) : rejectP(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`)),
    );
    child.on('error', rejectP);
  });
}

// ---------------------------------------------------------------------------
// Static server with controllable failures
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
};

const state = {
  root: join(SPA_DIR, 'dist'),
  /** 503 the next N JS asset requests (transient radio / half-purged cache). */
  failJs: 0,
  failJsDelayMs: 0,
  /** Delay every asset response (so the splash is observable). */
  delayAssetsMs: 0,
  /** Serve the broken shell for the next N navigations. */
  brokenNavs: 0,
  brokenHtml: '',
  navs: 0,
  jsRequests: [],
};

const server = createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const path = decodeURIComponent(url.pathname);

  const send = (status, body, headers = {}) => {
    res.writeHead(status, {
      'Cache-Control': 'no-cache',
      ...headers,
    });
    res.end(body);
  };
  const sendFile = (file, headers = {}) => {
    try {
      const body = readFileSync(file);
      send(200, body, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', ...headers });
    } catch {
      send(404, 'not found');
    }
  };

  if (path === '/version.json' || path === '/sw.js') {
    return sendFile(join(state.root, path.slice(1)), {
      'Cache-Control': 'no-store',
    });
  }

  if (path.startsWith('/assets/')) {
    if (path.endsWith('.js')) state.jsRequests.push(path);
    const later = () => {
      if (path.endsWith('.js') && state.failJs > 0) {
        state.failJs -= 1;
        return setTimeout(() => send(503, 'asset temporarily unavailable'), state.failJsDelayMs);
      }
      return sendFile(join(state.root, path), {
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    };
    if (state.delayAssetsMs) return setTimeout(later, state.delayAssetsMs);
    return later();
  }

  if (path === '/' || path === '/index.html') {
    state.navs += 1;
    if (state.brokenNavs > 0) {
      state.brokenNavs -= 1;
      return send(200, state.brokenHtml, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return sendFile(join(state.root, 'index.html'), {
      'Content-Type': 'text/html; charset=utf-8',
    });
  }

  return sendFile(join(state.root, path));
});

// ---------------------------------------------------------------------------
// Deploy fixtures
// ---------------------------------------------------------------------------

function makeDeploy(source, dest, tag, options = {}) {
  const stampBundle = options.stampBundle !== false;
  rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });
  const oldBuild = JSON.parse(readFileSync(join(source, 'version.json'), 'utf8')).build;
  const assets = readdirSync(join(dest, 'assets'));
  const js = assets.find((name) => name.endsWith('.js'));
  const css = assets.find((name) => name.endsWith('.css'));
  if (!js || !css) throw new Error(`cannot find hashed assets in ${dest}`);

  const newJs = `index-${tag}.js`;
  const newCss = `index-${tag}.css`;
  renameSync(join(dest, 'assets', js), join(dest, 'assets', newJs));
  renameSync(join(dest, 'assets', css), join(dest, 'assets', newCss));

  const html = readFileSync(join(dest, 'index.html'), 'utf8')
    .replaceAll(js, newJs)
    .replaceAll(css, newCss);
  writeFileSync(join(dest, 'index.html'), html, 'utf8');

  const buildId = `m29-${tag}-${Date.now()}`;
  const versionFile = join(dest, 'version.json');
  const version = JSON.parse(readFileSync(versionFile, 'utf8'));
  version.build = buildId;
  version.time = new Date().toISOString();
  writeFileSync(versionFile, `${JSON.stringify(version, null, 2)}\n`, 'utf8');

  // A real rebuild inlines the new __BUILD_ID__ into the bundle. Renaming the
  // file alone would leave the page convinced it is still the old build.
  if (stampBundle) {
    const jsFile = join(dest, 'assets', newJs);
    const jsSource = readFileSync(jsFile, 'utf8');
    if (!jsSource.includes(oldBuild)) {
      throw new Error(`bundle does not contain the source build id ${oldBuild}`);
    }
    writeFileSync(jsFile, jsSource.replaceAll(oldBuild, buildId), 'utf8');
  }

  // M29 builds stamp their worker; the legacy build has no placeholder.
  const swFile = join(dest, 'sw.js');
  let sw = readFileSync(swFile, 'utf8');
  if (sw.includes("const BUILD = '")) {
    sw = sw.replace(/const BUILD = '[^']+';/, `const BUILD = '${buildId}';`);
    writeFileSync(swFile, sw, 'utf8');
  }

  return { dir: dest, buildId, js: newJs, cacheName: `webchannel-static-${buildId}` };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

async function launch(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: !HEADED,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    userAgent: devices['iPhone 13'].userAgent,
  });
  await context.addInitScript(() => {
    try {
      document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('boot-splash')) {
          sessionStorage.setItem('m29.sawSplash', '1');
        }
      });
    } catch {
      /* sessionStorage can be unavailable; only evidence is lost */
    }
  });
  return context;
}

async function waitForApp(page, timeout = 20000) {
  await page.waitForSelector('.app', { timeout });
}

async function waitForController(page) {
  await page.waitForFunction(
    async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration) && Boolean(navigator.serviceWorker.controller);
    },
    null,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    async () => {
      // The shell must be cached for the offline cold restart to be meaningful.
      return Boolean(await caches.match('/index.html'));
    },
    null,
    { timeout: 10000 },
  );
}

function pageErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function snapshot(page) {
  return page.evaluate(() => ({
    rootText: (document.getElementById('root')?.innerText || '').trim(),
    hasApp: Boolean(document.querySelector('.app')),
    splash: Boolean(document.getElementById('boot-splash')),
    splashState: document.getElementById('boot-splash')?.getAttribute('data-state') || '',
    retry: (() => {
      const button = document.getElementById('boot-retry');
      return button ? !button.hidden : false;
    })(),
    healAt: Number(localStorage.getItem('webchannel.selfHealAt') || 0),
  }));
}

async function cacheKeys(page) {
  return page.evaluate(async () => (await caches.keys()).sort());
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioNormal(browserProfiles) {
  log('scenario 1: normal cold start (splash → app)');
  resetDeploy();
  state.delayAssetsMs = 700;
  const context = await launch(browserProfiles.normal);
  try {
    const page = await context.newPage();
    const errors = pageErrors(page);
    await page.goto(BASE, { waitUntil: 'commit' });
    await page.waitForSelector('#boot-splash', { state: 'visible', timeout: 10000 });
    const text = await page.locator('#boot-splash').innerText();
    check('1: splash is visible while the bundle loads', /QwenPaw/.test(text) && /正在启动/.test(text), text.replace(/\s+/g, ' '));
    await page.screenshot({ path: shot('1-splash') });

    await waitForApp(page);
    await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 10000 });
    check('1: app mounted and removed the splash', true);
    check('1: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.screenshot({ path: shot('1-app') });
  } finally {
    state.delayAssetsMs = 0;
    await context.close();
  }
}

async function scenarioOffline(browserProfiles) {
  log('scenario 2: offline cold restart uses the cached shell');
  resetDeploy();
  let context = await launch(browserProfiles.offline);
  try {
    let page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await waitForController(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    const keys = await cacheKeys(page);
    check('2: one build-scoped cache exists', keys.length === 1 && keys[0].startsWith('webchannel-static-'), keys.join(', '));
  } finally {
    await context.close();
  }

  // The process is gone: same profile, no network.
  context = await launch(browserProfiles.offline);
  try {
    await context.setOffline(true);
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForApp(page);
    const seen = await page.evaluate(() => sessionStorage.getItem('m29.sawSplash'));
    check('2: offline cold start rendered the cached shell', true);
    check('2: the cached shell painted the splash first', seen === '1');
    await page.waitForSelector('#boot-splash', { state: 'detached' });
    await page.screenshot({ path: shot('2-offline') });
  } finally {
    await context.setOffline(false);
    await context.close();
  }
}

async function scenarioUpdate(browserProfiles, fixture) {
  log('scenario 3: version mismatch → SW takeover → fresh build');
  resetDeploy();
  const context = await launch(browserProfiles.update);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await waitForController(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    const before = await cacheKeys(page);
    check('3: v1 cache namespace is active', before.length === 1 && !before[0].includes(fixture.buildId), before.join(', '));

    state.root = fixture.dir;
    const navigation = page.waitForNavigation({ timeout: 25000 });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await navigation;
    await waitForApp(page);

    const after = await cacheKeys(page);
    check(
      '3: the new worker purged the old namespace',
      after.length === 1 && after[0] === fixture.cacheName,
      after.join(', '),
    );
    const usedNew = await page.evaluate(
      (name) => performance.getEntriesByType('resource').some((entry) => entry.name.includes(name)),
      fixture.js,
    );
    check('3: the reloaded page runs the v2 bundle', usedNew, fixture.js);
    check(
      '3: no manual-update banner after a successful automatic update',
      (await page.locator('#webchannel-update-banner').count()) === 0,
    );
    await page.screenshot({ path: shot('3-updated') });
  } finally {
    await context.close();
  }
}

/**
 * The exact legacy sequence, on the fixed build: v1 → deploy v2 → the update
 * reload's first bundle request fails once → splash + one self-heal → app.
 * This is the before/after counterpart of `scenarioLegacy`.
 */
async function scenarioUpdateWithFailure(browserProfiles, fixture) {
  log('scenario 6: update reload with one failed bundle request self-heals');
  resetDeploy();
  const context = await launch(browserProfiles.updateFail);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await waitForController(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    state.root = fixture.dir;
    state.failJs = 1;
    const jsBefore = state.jsRequests.filter((path) => path.endsWith(fixture.js)).length;
    const navigation = page.waitForNavigation({ timeout: 25000 });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await navigation;

    await waitForApp(page, 30000);
    const seen = await page.evaluate(() => sessionStorage.getItem('m29.sawSplash'));
    const info = await snapshot(page);
    const usedNew = await page.evaluate(
      (name) => performance.getEntriesByType('resource').some((entry) => entry.name.includes(name)),
      fixture.js,
    );
    const jsHits = state.jsRequests.filter((path) => path.endsWith(fixture.js)).length - jsBefore;

    check('6: the failed update reload painted the splash', seen === '1');
    check('6: one self-heal recovered the app', info.hasApp && usedNew);
    check('6: the self-heal marker was stamped', info.healAt > 0);
    check('6: the v2 bundle was requested twice (503 then 200)', jsHits >= 2, String(jsHits));
    check(
      '6: no manual-update banner after recovery',
      (await page.locator('#webchannel-update-banner').count()) === 0,
    );
    check('6: a stable v2 cache namespace remains', (await cacheKeys(page)).some((key) => key === fixture.cacheName));
    await page.screenshot({ path: shot('6-update-healed') });
  } finally {
    state.failJs = 0;
    await context.close();
  }
}

async function scenarioBadShell(browserProfiles) {
  log('scenario 4: a broken shell self-heals once');
  resetDeploy();
  let context = await launch(browserProfiles.bad);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await waitForController(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
  } finally {
    await context.close();
  }

  const goodNavs = state.navs;
  state.brokenNavs = 1;
  context = await launch(browserProfiles.bad);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForApp(page, 30000);
    const seen = await page.evaluate(() => sessionStorage.getItem('m29.sawSplash'));
    const info = await snapshot(page);
    check('4: broken shell painted the splash (not white)', seen === '1');
    check('4: self-heal reloaded and the app mounted', info.hasApp);
    check('4: the self-heal marker carries a timestamp', info.healAt > 0, String(info.healAt));
    check('4: the reload happened once', state.navs - goodNavs >= 2, `navs +${state.navs - goodNavs}`);
    await page.screenshot({ path: shot('4-healed') });
  } finally {
    await context.close();
  }
}

async function scenarioAntiLoop(browserProfiles) {
  log('scenario 5: a permanently broken shell stops after one heal');
  resetDeploy();
  let context = await launch(browserProfiles.loop);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await waitForController(page);
  } finally {
    await context.close();
  }

  const beforeNavs = state.navs;
  state.brokenNavs = 99;
  context = await launch(browserProfiles.loop);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#boot-splash[data-state="stuck"]', { timeout: 25000 });
    const stuck = await snapshot(page);
    check('5: the stuck card is visible instead of white', stuck.splash && stuck.splashState === 'stuck');
    check('5: a manual retry button is offered', stuck.retry);
    const navsAfterStuck = state.navs;
    await sleep(2500);
    check(
      '5: no further reload loop while the cooldown holds',
      state.navs === navsAfterStuck,
      `navs ${state.navs - beforeNavs} since the broken deploy`,
    );
    await page.screenshot({ path: shot('5-stuck') });
  } finally {
    state.brokenNavs = 0;
    await context.close();
  }
}

/**
 * Legacy evidence: run the *pre-M29* build through
 *   v1 online → deploy v2 → mismatch → purge all caches → reload →
 *   the v2 bundle request fails once.
 * The old code has no splash and no error path, so the result is a white page.
 */
async function scenarioLegacy(legacyDir, browserProfiles) {
  log(`legacy repro against ${legacyDir}`);
  const legacyV2 = join(tmpdir(), `m29-legacy-v2-${Date.now()}`);
  const v2 = makeDeploy(legacyDir, legacyV2, 'LegacyV2', { stampBundle: false });
  state.root = legacyDir;
  state.brokenNavs = 0;
  state.failJs = 0;

  const context = await launch(browserProfiles.legacy);
  try {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, 30000);
    await waitForController(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    // Deploy v2 and break the first bundle request, exactly like a phone whose
    // radio is not ready yet after the purge.
    state.root = v2.dir;
    state.failJs = 1;
    const navigation = page.waitForNavigation({ timeout: 25000 }).catch(() => null);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await navigation;
    await sleep(2500);

    const info = await snapshot(page);
    const blank = !info.hasApp && info.rootText === '' && !info.splash;
    check('legacy: pre-M29 build ends on a white page', blank, JSON.stringify(info));
    await page.screenshot({ path: shot('legacy-blank') });

    // A second manual reload recovers, which is why killing the PWA "fixed" it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page, 30000);
    check('legacy: a manual reload recovers (kill-and-reopen equivalent)', true);
  } finally {
    state.failJs = 0;
    await context.close();
    rmSync(legacyV2, { recursive: true, force: true });
  }
}

function resetDeploy() {
  state.root = join(SPA_DIR, 'dist');
  state.failJs = 0;
  state.brokenNavs = 0;
  state.delayAssetsMs = 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();

  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(400) });
    throw new Error(`port ${PORT} is already in use — stop it before running the M29 suite`);
  } catch (err) {
    if (err && /already in use/.test(String(err.message))) throw err;
  }

  if (process.env.M29_SKIP_BUILD !== '1') {
    log('building the SPA (npm run build)…');
    await run('npm', ['run', 'build'], SPA_DIR);
  }

  const version = JSON.parse(readFileSync(join(SPA_DIR, 'dist', 'version.json'), 'utf8'));
  check('build: sw.js carries the injected build id', readFileSync(join(SPA_DIR, 'dist', 'sw.js'), 'utf8').includes(`'${version.build}'`), version.build);
  check(
    'build: sw.js has no leftover placeholder',
    !readFileSync(join(SPA_DIR, 'dist', 'sw.js'), 'utf8').includes('__WE_CHANNEL_BUILD__'),
  );
  check(
    'build: index.html ships the inline watchdog',
    readFileSync(join(SPA_DIR, 'dist', 'index.html'), 'utf8').includes('id="boot-watchdog"'),
  );

  const v2 = makeDeploy(join(SPA_DIR, 'dist'), join(tmpdir(), `m29-v2-${Date.now()}`), 'M29V2', {
    stampBundle: true,
  });
  const brokenHtml = readFileSync(join(SPA_DIR, 'dist', 'index.html'), 'utf8').replace(
    /src="\/assets\/[^"]+\.js"/,
    'src="/assets/index-M29BROKEN.js"',
  );
  state.brokenHtml = brokenHtml;

  await new Promise((resolveP) => server.listen(PORT, '127.0.0.1', resolveP));
  log(`serving on ${BASE}`);

  const profiles = {
    normal: mkdtempSync(join(tmpdir(), 'm29-normal-')),
    offline: mkdtempSync(join(tmpdir(), 'm29-offline-')),
    update: mkdtempSync(join(tmpdir(), 'm29-update-')),
    updateFail: mkdtempSync(join(tmpdir(), 'm29-update-fail-')),
    bad: mkdtempSync(join(tmpdir(), 'm29-bad-')),
    loop: mkdtempSync(join(tmpdir(), 'm29-loop-')),
    legacy: mkdtempSync(join(tmpdir(), 'm29-legacy-')),
  };
  const wanted = (name) => ONLY.length === 0 || ONLY.includes(name);

  try {
    if (wanted('1')) await scenarioNormal(profiles);
    if (wanted('2')) await scenarioOffline(profiles);
    if (wanted('3')) await scenarioUpdate(profiles, v2);
    if (wanted('4')) await scenarioBadShell(profiles);
    if (wanted('6')) await scenarioUpdateWithFailure(profiles, v2);
    if (wanted('5')) await scenarioAntiLoop(profiles);
    if (process.env.M29_LEGACY_DIR && wanted('legacy')) {
      await scenarioLegacy(resolve(process.env.M29_LEGACY_DIR), profiles);
    }
  } finally {
    for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true });
    rmSync(v2.dir, { recursive: true, force: true });
    server.close();
  }

  const failed = checks.filter((item) => !item.ok);
  log(`build ${version.build} — checks ${checks.length}, failed ${failed.length}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failed.length) {
    for (const item of failed) log(`FAILED ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    console.log('M29 E2E FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('M29 E2E PASS');
}

main().catch((err) => {
  log(`fatal: ${err && err.stack ? err.stack : err}`);
  console.log('M29 E2E FAIL');
  process.exitCode = 1;
});
