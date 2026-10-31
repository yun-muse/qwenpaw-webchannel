#!/usr/bin/env node
/**
 * M14 mobile UI/UX + M15 usage-v2 E2E capture + diagnostics.
 *
 * Two viewports are exercised in one run:
 *   - 390x844, touch, iPhone Safari UA (the M14 checks + M15 mobile rules)
 *   - 1280x900 desktop (the M15 inline receipt / meter-totals rules)
 *
 * Re-run (from the repo root):
 *   cd tests && npm install && npx playwright install chromium
 *   LABEL=m15-before node mobile_e2e.mjs
 *   BASE_URL=http://127.0.0.1:4173/ LABEL=m15-after node mobile_e2e.mjs
 *
 * Point it at any other base URL:
 *   BASE_URL=https://qwenpaw-webchannel-spa.pages.dev/ LABEL=m15-live node mobile_e2e.mjs
 *
 * Environment variables (all optional):
 *   BASE_URL              target origin; default https://qwenpaw-webchannel-spa.pages.dev/
 *   LOGIN_PASSWORD_FILE   password file; default ../.secrets/login_password.txt
 *   OUT_DIR               screenshot output; default ./out/mobile-shots
 *   EVIDENCE=1            write the tracked ./mobile-shots/ evidence set
 *   LABEL                 file-name prefix; default "before"
 *   CHAT_ID               chat to open; default chat-mvqvtho0 (the M9 entropy chat)
 *   CHAT_TITLE_HINT       fallback title match; default M9验证
 *   ENDPOINT              "cloud" (default; uses the sidebar endpoint switch on a
 *                         hosted build) or "local" (local preview + relay-node)
 *   VIEWPORT_WIDTH/HEIGHT default 390x844 (overrides are for 360/430 spot checks)
 *   PROXY_SERVER          upstream HTTP proxy for Chromium; defaults to HTTPS_PROXY/http_proxy.
 *                         A loopback CONNECT bridge is started automatically, because Chromium
 *                         cannot reach the egress gateway directly in this sandbox.
 *   HEADED=1              run with a visible browser
 *
 * Screenshots (LABEL-prefixed): chat, topbar, more-menu, sidebar, model-picker,
 * composer, message-actions, meter-panel, desktop. `desktop` is the 1280x900
 * pass.
 *
 * M15 checks read `.bubble-usage` receipts (per-turn tokens under an assistant
 * bubble) and the `.context-meter` above the composer. The per-turn inputs are
 * summed and compared with the meter's session total: history only covers the
 * latest window, so the sum must be <= the cumulative total (compact k/M
 * rounding is allowed for). Before the M15 build these checks fail by design;
 * the baseline is captured with `LABEL=m15-before ... || true`. The final run
 * must pass every check: the process exits 1 on any FAIL.
 *
 * The password is read into memory only: it is never printed, written to disk,
 * or embedded in a screenshot name.
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactDir } from './artifacts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'https://qwenpaw-webchannel-spa.pages.dev/';
const PASSWORD_FILE = resolve(
  HERE,
  process.env.LOGIN_PASSWORD_FILE || '../.secrets/login_password.txt',
);
const OUT_DIR = artifactDir('mobile-shots', process.env.OUT_DIR);
const LABEL = process.env.LABEL || 'before';
const CHAT_ID = process.env.CHAT_ID || 'chat-mvqvtho0';
const CHAT_TITLE_HINT = process.env.CHAT_TITLE_HINT || 'M9验证';
const ENDPOINT = process.env.ENDPOINT === 'local' ? 'local' : 'cloud';
const UPSTREAM_PROXY =
  process.env.PROXY_SERVER || process.env.HTTPS_PROXY || process.env.https_proxy || '';
const HEADED = process.env.HEADED === '1';
/** The brief pins 390x844; the env overrides are for 360/430 spot checks. */
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || 390);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 844);

mkdirSync(OUT_DIR, { recursive: true });
const shot = (name) => join(OUT_DIR, `${LABEL}-${name}.png`);
const log = (...args) => console.log('[mobile-e2e]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** First `↑12.3k` / `↓456` value in *text*, or null (compact k/M units). */
function arrowValue(text, arrow) {
  const match = new RegExp(`${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)\\s*([kKmM])?`).exec(text || '');
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || '').toLowerCase();
  return unit === 'k' ? value * 1000 : unit === 'm' ? value * 1e6 : value;
}

/** Sum of one arrow's values over a receipt list (rounding slack is caller's). */
function arrowSum(receipts, arrow) {
  let total = 0;
  let found = 0;
  for (const receipt of receipts) {
    const value = arrowValue(receipt.text, arrow);
    if (value == null) continue;
    total += value;
    found += 1;
  }
  return { total, found };
}

/** Reads the secret once; the value never leaves this process. */
function readPassword() {
  const raw = readFileSync(PASSWORD_FILE, 'utf8').trim();
  if (!raw) throw new Error(`empty password file: ${PASSWORD_FILE}`);
  return raw;
}

/**
 * Loopback HTTP/CONNECT bridge in front of the egress proxy. Chromium in this
 * sandbox cannot open sockets to the gateway address, but it can reach
 * 127.0.0.1, and this Node process can reach the gateway.
 */
async function startProxyBridge(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const upHost = upstream.hostname.replace(/^\[|\]$/g, '');
  const upPort = Number(upstream.port || 3128);
  const auth = upstream.username
    ? `Basic ${Buffer.from(
        `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`,
      ).toString('base64')}`
    : '';

  const server = createServer((req, res) => {
    const headers = { ...req.headers, host: req.headers.host || '' };
    if (auth) headers['proxy-authorization'] = auth;
    // Forward plain-HTTP proxying (absolute-form URL) to the upstream proxy.
    const path = /^https?:\/\//.test(req.url || '') ? req.url : `http://${req.headers.host}${req.url}`;
    const up = netConnect(upPort, upHost, () => {
      up.write(
        `${req.method} ${path} HTTP/1.1\r\n` +
          Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      req.pipe(up);
    });
    up.on('data', (chunk) => res.socket?.write(chunk));
    up.on('end', () => res.socket?.end());
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('proxy error');
    });
  });

  server.on('connect', (req, client, head) => {
    const up = netConnect(upPort, upHost, () => {
      up.write(
        `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n` +
          (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
          '\r\n',
      );
    });
    let handshake = '';
    const onUpData = (chunk) => {
      handshake += chunk.toString('latin1');
      if (!handshake.includes('\r\n\r\n')) return;
      up.off('data', onUpData);
      if (!/^HTTP\/1\.[01] 200/.test(handshake)) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        up.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    };
    up.on('data', onUpData);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });

  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((res) => server.close(res)),
  };
}

/** Collect every visible button whose hit area is below 44x44 CSS px. */
const TAP_TARGET_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"], summary, a')) {
    // M15's meter is a deliberately slim 28 px row (the brief's mobile spec);
    // it is a secondary disclosure, not an action button.
    if (el.classList && el.classList.contains('context-meter')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    if (r.width < 44 || r.height < 44) {
      out.push({
        cls: el.className && typeof el.className === 'string' ? el.className : el.tagName,
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
      });
    }
  }
  return out;
})()`;

const MEASURE_SCRIPT = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10,
    };
  };
  const info = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      rect: rect(el),
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      overflow: cs.overflow, overflowX: cs.overflowX, overflowY: cs.overflowY,
      whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow,
      flex: cs.flex, minWidth: cs.minWidth, position: cs.position,
      transform: cs.transform, zIndex: cs.zIndex,
    };
  };
  const overlap = (a, b) => {
    if (!a || !b) return null;
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return x > 0 && y > 0 ? Math.round(x * y) : 0;
  };
  const topLeft = document.querySelector('.top-left');
  const topRight = document.querySelector('.top-right');
  const hamburger = document.querySelector('.hamburger');
  const hb = hamburger ? hamburger.getBoundingClientRect() : null;
  const hit = hb
    ? document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2)
    : null;
  const usage = document.querySelector('.usage-line');
  const usageRect = usage ? usage.getBoundingClientRect() : null;
  const usageVisiblePx = usageRect
    ? Math.max(0, Math.min(usageRect.right, innerWidth) - Math.max(usageRect.left, 0)) *
      Math.max(0, Math.min(usageRect.bottom, innerHeight) - Math.max(usageRect.top, 0))
    : 0;
  const textOf = (el) => (el ? (el.textContent || '').trim().replace(/\\s+/g, ' ') : '');
  const meter = document.querySelector('.context-meter');
  const meterTrack = meter ? meter.querySelector('.context-meter-track') : null;
  const meterFill = meter ? meter.querySelector('.context-meter-fill') : null;
  const meterLabel = meter ? meter.querySelector('.context-meter-label') : null;
  const meterDetail = meter ? meter.querySelector('.context-meter-detail') : null;
  const meterTotals = meter ? meter.querySelector('.context-meter-totals') : null;
  const meterBox = meter ? meter.getBoundingClientRect() : null;
  const bubbleUsages = [...document.querySelectorAll('.row.assistant .bubble-usage')].map((el) => {
    const foot = el.closest('.bubble-foot');
    const time = foot ? foot.querySelector('.bubble-time') : null;
    const footButton = foot ? foot.querySelector('.copy-btn, .msg-act-btn') : null;
    const box = el.getBoundingClientRect();
    const timeBox = time ? time.getBoundingClientRect() : null;
    const footBox = footButton ? footButton.getBoundingClientRect() : null;
    const cs = getComputedStyle(el);
    return {
      text: textOf(el),
      title: el.getAttribute('title') || '',
      rect: rect(el),
      time: time ? { text: textOf(time), ...rect(time) } : null,
      sameLineAsTime: timeBox
        ? Math.abs((box.top + box.bottom) / 2 - (timeBox.top + timeBox.bottom) / 2) <= 4
        : null,
      // History messages carry no clock, so the desktop row check falls back
      // to the action buttons that share the same footer line.
      sameLineAsFoot: footBox
        ? Math.abs((box.top + box.bottom) / 2 - (footBox.top + footBox.bottom) / 2) <= 6
        : null,
      visible:
        box.width > 0 && box.height > 0 &&
        cs.visibility !== 'hidden' && cs.display !== 'none' &&
        box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight,
    };
  });
  const toolbar = document.querySelector('.composer-toolbar');
  const controls = [...document.querySelectorAll('.composer-toolbar button, .composer-toolbar .effort-wrap, .composer-toolbar .model-wrap')];
  const controlRects = controls.map((el) => ({ cls: el.className, ...rect(el) }));
  const overlaps = [];
  for (let i = 0; i < controlRects.length; i++) {
    for (let j = i + 1; j < controlRects.length; j++) {
      const area = overlap(controlRects[i], controlRects[j]);
      if (area > 0) overlaps.push([controlRects[i].cls, controlRects[j].cls, area]);
    }
  }
  const pre = [...document.querySelectorAll('.md pre')].map((el) => ({
    rect: rect(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    parentWidth: el.parentElement ? el.parentElement.clientWidth : null,
    overflowX: getComputedStyle(el).overflowX,
  }));
  const tables = [...document.querySelectorAll('.md table')].map((el) => ({
    rect: rect(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    boxWidth: el.closest('.table-box') ? el.closest('.table-box').clientWidth : null,
  }));
  const userFoot = document.querySelector('.row.user .bubble-foot');
  const assistantActs = [...document.querySelectorAll('.row.assistant .bubble-foot .copy-btn, .row.assistant .bubble-foot .msg-act-btn')];
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    page: {
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      scrollX: scrollX,
    },
    top: info(document.querySelector('.top')),
    topLeft: info(topLeft),
    topRight: info(topRight),
    topTitles: info(document.querySelector('.top-titles')),
    topTitle: info(document.querySelector('.top-title')),
    usage: info(usage),
    usageVisiblePx,
    usageClipped: usage ? usage.scrollWidth > usage.clientWidth : null,
    usageAboveFold: usageRect ? usageRect.top >= 0 && usageRect.bottom <= innerHeight : null,
    usageLineCount: document.querySelectorAll('.usage-line').length,
    hasUsageClassCount: document.querySelectorAll('.top.has-usage').length,
    topTitlesChildCount: (() => {
      const titles = document.querySelector('.top-titles');
      return titles ? titles.children.length : null;
    })(),
    contextMeter: meter ? {
      ...info(meter),
      tag: meter.tagName,
      track: meterTrack ? {
        ...rect(meterTrack),
        height: Math.round(meterTrack.getBoundingClientRect().height * 10) / 10,
      } : null,
      fill: meterFill ? {
        ...rect(meterFill),
        color: getComputedStyle(meterFill).backgroundColor,
      } : null,
      label: textOf(meterLabel),
      detail: textOf(meterDetail),
      totals: textOf(meterTotals),
      detailDisplay: meterDetail ? getComputedStyle(meterDetail).display : null,
      totalsDisplay: meterTotals ? getComputedStyle(meterTotals).display : null,
      ariaLabel: meter.getAttribute('aria-label') || '',
      aboveComposer: (() => {
        const card = document.querySelector('.composer-card');
        if (!card || !meterBox) return null;
        return meterBox.bottom <= card.getBoundingClientRect().top + 0.5;
      })(),
    } : null,
    contextMeterPanel: Boolean(document.querySelector('.context-meter-panel')),
    bubbleUsages,
    topLeftVsRightOverlap: topLeft && topRight ? overlap(topLeft.getBoundingClientRect(), topRight.getBoundingClientRect()) : null,
    hamburger: info(hamburger),
    hamburgerHit: hit ? { cls: hit.className, tag: hit.tagName } : null,
    hamburgerTapTarget: hb ? { w: Math.round(hb.width), h: Math.round(hb.height) } : null,
    composerCard: info(document.querySelector('.composer-card')),
    toolbar: info(toolbar),
    toolbarControls: controlRects,
    toolbarOverlaps: overlaps,
    send: info(document.querySelector('.composer-toolbar .send, .composer-toolbar .stop')),
    effortOpts: [...document.querySelectorAll('.effort-opt')].map((el) => ({ text: el.textContent, ...rect(el) })),
    messageActions: {
      userFooter: userFoot ? info(userFoot) : null,
      assistantButtons: assistantActs.map((el) => ({ text: (el.textContent || '').trim(), ...rect(el) })),
    },
    codeBlocks: pre,
    tables,
    tapTargetsBelow44: ${TAP_TARGET_SCRIPT},
  };
})()`;

async function waitForApp(page) {
  await page.waitForSelector('.app', { timeout: 45000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.chat-item').length > 0,
    undefined,
    { timeout: 45000 },
  );
  await page.waitForFunction(
    () => {
      const dot = document.querySelector('.status .dot');
      return dot && dot.classList.contains('state-live');
    },
    undefined,
    { timeout: 45000 },
  ).catch(() => {});
}

async function ensureCloudEndpoint(page) {
  // The hosted build defaults to the local demo node; the cloud node lives
  // behind the sidebar's endpoint switch.
  const appExists = (await page.locator('.app').count()) > 0;
  if (!appExists) return false;
  const login = (await page.locator('.login-card').count()) > 0;
  if (login) return true;
  const switcher = page.locator('.endpoint-switch');
  if ((await switcher.count()) === 0) return false;
  if (!(await page.locator('.app.sidebar-open').count())) {
    // The hamburger is the only opener; click it through the DOM so the
    // harness can reach the switch even when the bar overlaps it (before fix).
    await page.locator('.hamburger').evaluate((el) => el.click());
    await sleep(350);
  }
  await switcher.click();
  await page.waitForSelector('.login-card', { timeout: 15000 });
  return true;
}

async function login(page, password) {
  await page.locator('.login-card input[type=password]').fill(password);
  await page.locator('.login-submit').click();
  await page.waitForSelector('.app', { timeout: 45000 });
}

async function openChat(page) {
  if (!(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').evaluate((el) => el.click());
    await sleep(400);
  }
  // The chats frame may arrive in batches; wait for the target id before
  // falling back to a title match.
  await page
    .waitForFunction(
      (id) => [...document.querySelectorAll('.chat-item .chat-id')].some((el) => el.textContent.trim() === id),
      CHAT_ID,
      { timeout: 30000 },
    )
    .catch(() => {});
  let item = page.locator('.chat-item').filter({ hasText: CHAT_ID }).first();
  if ((await item.count()) === 0) {
    item = page.locator('.chat-item').filter({ hasText: CHAT_TITLE_HINT }).first();
  }
  if ((await item.count()) === 0) {
    throw new Error(`chat not found: ${CHAT_ID} / ${CHAT_TITLE_HINT}`);
  }
  await item.locator('.chat-title').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.messages .row').length > 0,
    undefined,
    { timeout: 45000 },
  );
  // Wait for the usage UI: the M11 usage line before M15, the meter/receipt
  // after it. It is a control frame (not replayed), so tolerate absence and
  // let the checks prove it instead of failing the whole run here.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.usage-line, .context-meter, .bubble-usage');
        return el && el.textContent.trim().length > 0;
      },
      undefined,
      { timeout: 10000 },
    )
    .catch(() => {});
  await sleep(500);
}

async function main() {
  const password = readPassword();
  // The bridge is needed even for a loopback preview: the SPA still opens the
  // cloud WSS relay, and only this Node process can reach the egress gateway.
  const bridge = UPSTREAM_PROXY ? await startProxyBridge(UPSTREAM_PROXY) : null;
  const proxyOption = bridge
    ? { proxy: { server: bridge.url, bypass: 'localhost,127.0.0.1,::1' } }
    : {};

  const browser = await chromium.launch({ headless: !HEADED, ...proxyOption });
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    screen: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const authErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && /401|403|auth|token/i.test(text)) authErrors.push(text);
  });

  const result = {
    label: LABEL,
    baseUrl: BASE_URL,
    startedAt: new Date().toISOString(),
    steps: {},
    measures: {},
    screenshots: {},
    checks: {},
  };

  try {
    log(`opening ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);

    result.steps.cloudGate =
      ENDPOINT === 'local' ? 'local-endpoint' : await ensureCloudEndpoint(page);
    if (await page.locator('.login-card').count()) {
      log('logging in (password read from file, not printed)');
      await login(page, password);
      result.steps.login = 'ok';
    } else {
      result.steps.login = 'not-required';
    }
    await waitForApp(page);
    result.steps.connection = await page.locator('.status .dot').first().getAttribute('class');

    // Record the hamburger's real hit-test before opening anything: at 390 px
    // the top-right cluster overlaps it on the un-fixed build.
    const hitBefore = await page.evaluate(() => {
      const el = document.querySelector('.hamburger');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit ? { cls: hit.className, tag: hit.tagName } : null;
    });
    result.steps.hamburgerHitBefore = hitBefore;

    await openChat(page);
    result.steps.chat = await getTitleOf(page);

    // Chat view (messages scrolled to the start, sticky header visible).
    await page.evaluate(() => {
      const m = document.querySelector('.messages');
      if (!m) return;
      m.style.scrollBehavior = 'auto';
      m.scrollTop = 0;
    });
    await sleep(700);
    // A late history frame can trigger the app's own "stick to bottom" scroll;
    // pin the top once more right before the shot.
    await page.evaluate(() => {
      const m = document.querySelector('.messages');
      if (m) m.scrollTop = 0;
    });
    await sleep(250);
    result.measures.chat = await page.evaluate(MEASURE_SCRIPT);
    result.measures.chat.messagesScroll = await page.evaluate(() => {
      const m = document.querySelector('.messages');
      return m
        ? { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight }
        : null;
    });
    await page.screenshot({ path: shot('chat'), fullPage: false });
    result.screenshots.chat = shot('chat');

    // M15: the newest per-turn receipt lives at the end of the last assistant
    // bubble. Bring it (and the meter above the composer) on screen, measure
    // again and re-take the chat shot at that position.
    await page.evaluate(() => {
      const list = document.querySelector('.messages');
      if (!list) return;
      list.style.scrollBehavior = 'auto';
      list.scrollTop = list.scrollHeight;
    });
    await sleep(500);
    result.measures.usageView = await page.evaluate(MEASURE_SCRIPT);
    await page.screenshot({ path: shot('chat'), fullPage: false });

    // Header close-up.
    await page.locator('.top').screenshot({ path: shot('topbar') });
    result.screenshots.topbar = shot('topbar');

    // Narrow-screen overflow menu (secondary actions).
    if (await page.locator('.top-more-btn').isVisible().catch(() => false)) {
      await page.locator('.top-more-btn').click();
      await page.waitForSelector('.top-menu', { timeout: 3000 }).catch(() => {});
      await sleep(250);
      result.measures.moreMenu = await page.evaluate(() => {
        const menu = document.querySelector('.top-menu');
        if (!menu) return null;
        const r = menu.getBoundingClientRect();
        return {
          rect: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
          viewport: { w: innerWidth, h: innerHeight },
          offscreenRight: r.right > innerWidth,
          offscreenLeft: r.left < 0,
          items: [...menu.querySelectorAll('button')].map((el) => {
            const b = el.getBoundingClientRect();
            return { text: (el.textContent || '').trim(), w: Math.round(b.width), h: Math.round(b.height) };
          }),
        };
      });
      await page.screenshot({ path: shot('more-menu'), fullPage: false });
      result.screenshots.moreMenu = shot('more-menu');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    // Sidebar (open). The hamburger tap is verifies separately; use a DOM click
    // so the drawer can be photographed even when the header overlaps it.
    if (!(await page.locator('.app.sidebar-open').count())) {
      await page.locator('.hamburger').evaluate((el) => el.click());
      await sleep(450);
    }
    result.measures.sidebar = await page.evaluate(() => {
      const s = document.querySelector('.sidebar');
      const cs = getComputedStyle(s);
      return {
        transform: cs.transform,
        width: s.getBoundingClientRect().width,
        left: s.getBoundingClientRect().left,
        mask: Boolean(document.querySelector('.sidebar-mask')),
        bodyOverflowX: getComputedStyle(document.body).overflowX,
      };
    });
    result.measures.sidebar.tapTargetsBelow44 = await page.evaluate(TAP_TARGET_SCRIPT);
    await page.screenshot({ path: shot('sidebar'), fullPage: false });
    result.screenshots.sidebar = shot('sidebar');

    // Close the drawer and open the model picker.
    await page.locator('.hamburger').evaluate((el) => el.click());
    await sleep(400);
    let pickerOpened = false;
    try {
      await page.locator('.model-button').click({ timeout: 4000 });
      await page.waitForSelector('.model-picker', { timeout: 4000 });
      pickerOpened = true;
    } catch {
      // Fall back to a DOM click so the picker is still captured.
      await page.locator('.model-button').evaluate((el) => el.click());
      pickerOpened = (await page.waitForSelector('.model-picker', { timeout: 4000 }).catch(() => null)) !== null;
    }
    result.steps.modelPickerOpenedByTap = pickerOpened;
    await sleep(300);
    result.measures.modelPicker = await page.evaluate(() => {
      const p = document.querySelector('.model-picker');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
        viewport: { w: innerWidth, h: innerHeight },
        offscreenRight: r.right > innerWidth,
        offscreenLeft: r.left < 0,
        offscreenTop: r.top < 0,
        scrollHeight: p.scrollHeight,
        clientHeight: p.clientHeight,
      };
    });
    await page.screenshot({ path: shot('model-picker'), fullPage: false });
    result.screenshots.modelPicker = shot('model-picker');

    // Close the picker with Escape.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await page.locator('.model-button').evaluate((el) => el.blur()).catch(() => {});
    await page.mouse.move(2, 2);

    // Composer close-up (the whole bottom deck, including the M15 meter).
    await page.locator('.composer').screenshot({ path: shot('composer') });
    result.screenshots.composer = shot('composer');

    // Assistant message actions close-up (copy / regenerate).
    const lastAssistant = page.locator('.row.assistant').last();
    if ((await lastAssistant.count()) > 0) {
      await lastAssistant.scrollIntoViewIfNeeded();
      await sleep(250);
      await lastAssistant.locator('.bubble-foot').screenshot({ path: shot('message-actions') }).catch(() => {});
      result.screenshots.messageActions = shot('message-actions');
    }

    // A wide table or code block, if this conversation has one.
    const wide = page.locator('.md pre, .md .table-box').first();
    if ((await wide.count()) > 0) {
      await wide.scrollIntoViewIfNeeded();
      await sleep(250);
      await page.locator('.messages').screenshot({ path: shot('wide-content') }).catch(() => {});
      result.screenshots.wideContent = shot('wide-content');
    }

    // M15: the meter's tap panel is the only place with full numbers on a phone.
    let meterPanelOpened = false;
    if (await page.locator('.context-meter-interactive').count()) {
      await page.locator('.context-meter-interactive').click({ timeout: 3000 }).catch(() => {});
      meterPanelOpened = await page
        .locator('.context-meter-panel')
        .isVisible()
        .catch(() => false);
      if (meterPanelOpened) {
        result.measures.meterPanel = await page.evaluate(() => {
          const panel = document.querySelector('.context-meter-panel');
          return panel ? (panel.textContent || '').trim().replace(/\s+/g, ' ') : '';
        });
        await page.screenshot({ path: shot('meter-panel'), fullPage: false });
        result.screenshots.meterPanel = shot('meter-panel');
        await page.locator('.context-meter-interactive').click({ timeout: 3000 }).catch(() => {});
      }
    }
    result.checks.contextMeterPanelOpens = meterPanelOpened;

    // Real tap check on the hamburger: Playwright's actionability includes
    // hit-testing, so this fails when another element covers it.
    await page.evaluate(() => {
      const m = document.querySelector('.messages');
      if (!m) return;
      m.style.scrollBehavior = 'auto';
      m.scrollTop = 0;
    });
    let tapOk = false;
    let tapError = '';
    try {
      await page.locator('.hamburger').click({ timeout: 3000 });
      tapOk = true;
      await page.waitForTimeout(300);
    } catch (err) {
      tapError = String(err.message || err).split('\n')[0];
      result.steps.hamburgerTapBlockedBy =
        (await page.evaluate(() => {
          const el = document.querySelector('.hamburger');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit ? { cls: hit.className, tag: hit.tagName } : null;
        })) || null;
    }
    result.checks.hamburgerTappable = tapOk;
    result.steps.hamburgerTapError = tapError;

    // M14 layout checks + M15 usage-v2 checks (the before run is expected to
    // fail the M15 ones; it still writes all screenshots and diagnostics).
    const m = result.measures.chat;
    const u = result.measures.usageView || m;
    const receipts = u.bubbleUsages.filter(
      (item) => item.visible && /本轮/.test(item.text) && /[↑↓]/.test(item.text),
    );
    result.checks.bubbleUsageVisible = receipts.length > 0;
    result.checks.bubbleUsageText = receipts[0] ? receipts[0].text : '';
    result.checks.bubbleUsageTitle = receipts.some((item) => /本轮用量/.test(item.title));

    const meter = u.contextMeter;
    result.checks.contextMeterVisible = Boolean(
      meter &&
        meter.rect &&
        meter.rect.w > 0 &&
        meter.rect.h > 0 &&
        meter.track &&
        meter.track.height >= 3 &&
        /上下文 ≈\d+%/.test(meter.label),
    );
    result.checks.contextMeterAboveComposer = Boolean(meter && meter.aboveComposer);
    result.checks.usageLineRemoved = u.usageLineCount === 0 && u.hasUsageClassCount === 0;
    result.checks.topbarSingleLine = Boolean(
      u.top && u.top.rect && u.top.rect.h <= 60 && u.topTitlesChildCount === 1,
    );
    result.checks.meterMobileCompact = Boolean(
      meter &&
        meter.detailDisplay === 'none' &&
        meter.totalsDisplay === 'none' &&
        meter.track &&
        meter.track.height >= 4,
    );
    result.checks.noPageOverflow = m.page.horizontalOverflow === false;
    result.checks.noToolbarOverlap = m.toolbarOverlaps.length === 0;
    result.checks.toolbarFits = Boolean(m.toolbar && m.toolbar.scrollWidth <= m.toolbar.clientWidth);
    result.checks.allTapTargets44 = m.tapTargetsBelow44.length === 0;
    result.checks.sidebarMasked = Boolean(result.measures.sidebar && result.measures.sidebar.mask);
    result.checks.sidebarTapTargets44 =
      Boolean(result.measures.sidebar) && result.measures.sidebar.tapTargetsBelow44.length === 0;
    result.checks.moreMenuFits = Boolean(
      result.measures.moreMenu &&
        !result.measures.moreMenu.offscreenRight &&
        !result.measures.moreMenu.offscreenLeft,
    );
    result.checks.sidebarOffCanvas =
      Boolean(result.measures.sidebar && result.measures.sidebar.transform !== 'none');
    result.checks.userActionsReachable = Boolean(
      m.messageActions.userFooter &&
        Number(m.messageActions.userFooter.opacity) > 0.01,
    );
    result.checks.codeBlocksScroll =
      m.codeBlocks.length === 0 || m.codeBlocks.every((b) => b.overflowX === 'auto');

    // ---- M15: desktop pass (1280x900) ----------------------------------
    // A second context reuses the mobile login; the desktop rules are the
    // inline receipt, the meter's ↑↓ totals and the untouched single top bar.
    let desktopReceipts = [];
    try {
      const storageState = await context.storageState();
      const desktopContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        screen: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        ignoreHTTPSErrors: true,
        storageState,
      });
      try {
        const desktopPage = await desktopContext.newPage();
        desktopPage.on('pageerror', (err) => pageErrors.push(`desktop: ${err}`));
        await desktopPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await desktopPage.waitForTimeout(800);
        await waitForApp(desktopPage);
        await openChat(desktopPage);
        await desktopPage.evaluate(() => {
          const list = document.querySelector('.messages');
          if (!list) return;
          list.style.scrollBehavior = 'auto';
          list.scrollTop = list.scrollHeight;
        });
        await sleep(900);
        result.measures.desktop = await desktopPage.evaluate(MEASURE_SCRIPT);
        await desktopPage.screenshot({ path: shot('desktop'), fullPage: false });
        result.screenshots.desktop = shot('desktop');

        const d = result.measures.desktop;
        desktopReceipts = d.bubbleUsages.filter(
          (item) => item.visible && /本轮/.test(item.text),
        );
        const renderedReceipts = d.bubbleUsages.filter((item) => /本轮/.test(item.text));
        const desktopMeter = d.contextMeter;
        const meterTotals = desktopMeter ? desktopMeter.totals : '';
        const inputTotal = arrowValue(meterTotals, '↑');
        const outputTotal = arrowValue(meterTotals, '↓');
        const inputSum = arrowSum(renderedReceipts, '↑');
        result.steps.desktopTotals = {
          meterTotals, inputTotal, outputTotal, inputSum,
          rendered: renderedReceipts.length,
        };

        result.checks.desktopMeterTotals = Boolean(
          desktopMeter &&
            inputTotal != null &&
            outputTotal != null &&
            desktopMeter.totalsDisplay !== 'none',
        );
        result.checks.desktopMeterTrack = Boolean(
          desktopMeter &&
            desktopMeter.track &&
            desktopMeter.track.height >= 3 &&
            /上下文 ≈\d+%/.test(desktopMeter.label),
        );
        result.checks.desktopBubbleInline = desktopReceipts.some((item) =>
          item.time ? item.sameLineAsTime === true : item.sameLineAsFoot === true,
        );
        result.checks.desktopUsageLineRemoved =
          d.usageLineCount === 0 && d.hasUsageClassCount === 0;
        result.checks.desktopNoOverflow = d.page.horizontalOverflow === false;
        // Visible receipts are a window over the session, so their sum can be
        // smaller than the cumulative total but never materially larger; the
        // slack covers the compact k/M rounding of each displayed value.
        result.checks.receiptSumWithinTotals = Boolean(
          inputTotal != null &&
            inputSum.found > 0 &&
            inputSum.total > 0 &&
            inputSum.total <= inputTotal * 1.05 + 1000,
        );
      } finally {
        await desktopContext.close();
      }
    } catch (err) {
      result.steps.desktopError = String(err.message || err).split('\n')[0];
      result.checks.desktopMeterTotals = false;
      result.checks.desktopMeterTrack = false;
      result.checks.desktopBubbleInline = false;
      result.checks.desktopUsageLineRemoved = false;
      result.checks.desktopNoOverflow = false;
      result.checks.receiptSumWithinTotals = false;
    }

    result.checkList = Object.entries(result.checks)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k, v]) => `${v ? 'PASS' : 'FAIL'} ${k}`);
    result.pageErrors = pageErrors;
    result.authErrors = authErrors;
    result.failures = result.checkList.filter((line) => line.startsWith('FAIL')).length;

    writeFileSync(
      join(OUT_DIR, `${LABEL}-diagnostics.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );

    log('--- results ---');
    for (const line of result.checkList) log(line);
    log(`receipt: ${JSON.stringify(result.checks.bubbleUsageText)}`);
    log(`failures: ${result.failures}`);
    log(`screenshots → ${OUT_DIR}`);
    if (pageErrors.length) log(`page errors: ${pageErrors.join(' | ')}`);
    process.exitCode = result.failures > 0 ? 1 : 0;
  } finally {
    await context.close();
    await browser.close();
    if (bridge) await bridge.close();
  }
}

async function getTitleOf(page) {
  return (await page.locator('.top-title').innerText().catch(() => '')).trim();
}

main().catch((err) => {
  console.error('[mobile-e2e] FATAL', err);
  process.exit(1);
});
