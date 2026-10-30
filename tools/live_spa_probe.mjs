#!/usr/bin/env node
// M38 — what a *fresh browser* actually gets from the hosted SPA.
//
// Why this exists: `tools/verify_release.py` can prove the deployed bytes are a
// build of HEAD, but not whether that build is wired to the production relay.
// A bundle built without VITE_RELAY_WS/VITE_RELAY_HTTP is still "HEAD", yet the
// first visit lands on the local demo endpoint (127.0.0.1:8787). This probe
// observes the real page: which WebSockets it opens, whether a login form is
// shown, and what the sidebar endpoint switch says.
//
// Read-only by default. `--login` additionally flips the endpoint switch and
// submits the password from `.secrets/login_password.txt` (never printed), so
// the post-login state can be observed. No message is ever sent.
//
// Usage:
//   node tools/live_spa_probe.mjs                 # first-visit state only
//   node tools/live_spa_probe.mjs --login         # + switch to cloud and log in
//   node tools/live_spa_probe.mjs --url https://… # other deployment
//
// Needs Playwright (`cd tests && npm install`) and, in a sandbox, an egress
// proxy (HTTPS_PROXY); Chromium reaches it through the loopback CONNECT bridge
// copied from tests/mobile_e2e.mjs.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(new URL('../tests/package.json', import.meta.url));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const wantLogin = argv.includes('--login');
const urlArg = argv.indexOf('--url');
const URL_TARGET = urlArg >= 0 ? argv[urlArg + 1] : 'https://qwenpaw-webchannel-spa.pages.dev/';
const PASSWORD_FILE = resolve(new URL('..', import.meta.url).pathname, '.secrets/login_password.txt');

/** Loopback CONNECT bridge: Chromium cannot reach the egress gateway directly. */
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
    const path = /^https?:\/\//.test(req.url || '') ? req.url : `http://${req.headers.host}${req.url}`;
    const up = netConnect(upPort, upHost, () => {
      up.write(
        `${req.method} ${path} HTTP/1.1\r\n` +
          Object.entries({ ...req.headers, host: req.headers.host || '' })
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          (auth ? `\r\nProxy-Authorization: ${auth}` : '') +
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

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return { server, proxy: `http://127.0.0.1:${server.address().port}` };
}

const upstream = process.env.PROXY_SERVER || process.env.HTTPS_PROXY || process.env.https_proxy || '';
const bridge = upstream ? await startProxyBridge(upstream) : null;
const launch = bridge ? { headless: true, args: [`--proxy-server=${bridge.proxy}`] } : { headless: true };

const browser = await chromium.launch(launch);
const context = await browser.newContext({
  locale: 'zh-CN',
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const sockets = [];
page.on('websocket', (ws) => sockets.push(ws.url().replace(/token=[^&]+/, 'token=<redacted>')));

const snapshot = () =>
  page.evaluate(() => ({
    loginForm: Boolean(document.querySelector('input[type="password"]')),
    endpointSwitch: (document.querySelector('.endpoint-switch') || {}).textContent || '',
    body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
  }));

await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(6000);
const firstVisit = await snapshot();

let afterLogin = null;
if (wantLogin) {
  const password = readFileSync(PASSWORD_FILE, 'utf8').trim();
  const switchButton = page.locator('.endpoint-switch').first();
  if (await switchButton.count()) await switchButton.click();
  await page.waitForSelector('input[type="password"]', { timeout: 10_000 });
  await page.locator('input[type="password"]').fill(password);
  await page.locator('.login-submit').click();
  await page.waitForTimeout(8000);
  afterLogin = await snapshot();
}

console.log(
  JSON.stringify(
    {
      target: URL_TARGET,
      firstVisit,
      afterLogin,
      sockets,
      verdict: firstVisit.loginForm ? 'wired' : 'not-wired',
    },
    null,
    2,
  ),
);

await browser.close();
bridge?.server.close();
