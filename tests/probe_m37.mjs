/**
 * M37 probe — what does the CURRENT SPA do when the user sends while
 *   1. the relay socket is down (reconnecting),
 *   2. the socket is up but the agent is offline (plugin restart window),
 *   3. the frame leaves the browser but the connection dies before any receipt.
 *
 * Evidence only: this script does not assert product behaviour, it records it
 * and prints a table. It reuses the same pieces as tests/e2e_m19.mjs:
 * relay-node on :8787, a minimal mock agent, `vite preview`. The record goes
 * to tests/out/ by default; EVIDENCE=1 (or M37_OUT) writes the tracked
 * tests/m37-probe.json + tests/m37-probe-final.png.
 *
 *   node tests/probe_m37.mjs            # uses the existing spa/dist build
 *   M37_SKIP_BUILD=0 node tests/probe_m37.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium, devices } from 'playwright';

import { artifactFile } from './artifacts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
/**
 * `M37_SPA_DIR` points at another build (e.g. a `git worktree` of the
 * pre-M37 commit) so the same probe can record the "before" table.
 */
const SPA_DIR = process.env.M37_SPA_DIR ? resolve(process.env.M37_SPA_DIR) : join(ROOT, 'spa');
const RELAY_DIR = join(ROOT, 'relay-node');
const PREVIEW_PORT = 4173;
const RELAY_PORT = 8787;
const BASE = `http://127.0.0.1:${PREVIEW_PORT}/`;
const require = createRequire(join(ROOT, 'mock', 'package.json'));
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[m37-probe]', ...a);

let relay = null;
let preview = null;
let agent = null;
let agentTimer = null;
let agentPaused = false;
const received = [];

function startRelay() {
  relay = spawn('node', ['server.js'], { cwd: RELAY_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', () => {});
  relay.stderr.on('data', (d) => log('relay stderr:', String(d).trim()));
  return waitHttp(`http://127.0.0.1:${RELAY_PORT}/health`, 'relay');
}

function stopRelay() {
  return new Promise((resolveP) => {
    if (!relay) return resolveP();
    const child = relay;
    relay = null;
    child.once('exit', () => resolveP());
    child.kill('SIGKILL');
  });
}

async function waitHttp(url, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} did not come up`);
    await sleep(120);
  }
}

/** Minimal agent: answers hello, records `msg`, answers `hist` with its store. */
function connectAgent(history) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/agent`, {
      headers: { Authorization: 'Bearer dev-agent-token' },
    });
    const timer = setTimeout(() => rejectP(new Error('mock agent connect timeout')), 8000);
    let connected = false;
    ws.on('open', () => {
      clearTimeout(timer);
      connected = true;
      ws.send(JSON.stringify({ t: 'hello', started: Date.now(), session: 'm37-probe' }));
      agent = ws;
      // The real plugin pushes `status` right after `ready` (channel.py:645).
      ws.send(JSON.stringify({ t: 'status', agent_name: 'probe-agent' }));
      resolveP();
    });
    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.t === 'msg') {
        received.push({ chat: frame.chat, text: frame.text, at: Date.now() });
        log(`mock <- msg ${JSON.stringify(frame.text)} @${Date.now()}`);
        ws.send(
          JSON.stringify({
            t: 'msg',
            chat: frame.chat,
            seq: 1000 + received.length,
            parts: [{ type: 'text', text: `ack: ${frame.text}` }],
          }),
        );
        if (history) history[frame.chat] = [...(history[frame.chat] || []), { role: 'user', text: frame.text }];
      }
      if (frame.t === 'hist') {
        log(`mock <- hist ${frame.chat} (${((history && history[frame.chat]) || []).length} messages)`);
        ws.send(JSON.stringify({ t: 'hist', chat: frame.chat, messages: (history && history[frame.chat]) || [] }));
      }
      if (frame.t === 'get_effort') {
        ws.send(
          JSON.stringify({
            t: 'effort',
            chat: frame.chat,
            level: 'default',
            effective: 'inherit',
            supported: ['low', 'medium', 'high', 'max'],
            kind: 'budget',
          }),
        );
      }
      if (frame.t === 'models') {
        ws.send(JSON.stringify({ t: 'models', items: [{ provider: 'mock', model: 'mock-1', active: true }] }));
      }
      if (frame.t === 'chats') {
        ws.send(JSON.stringify({ t: 'chats', items: [{ chat: 'chat-alpha', title: 'Alpha' }] }));
      }
      if (frame.t === 'get_usage') {
        ws.send(JSON.stringify({ t: 'usage', chat: frame.chat }));
      }
      if (frame.t === 'skills') {
        ws.send(JSON.stringify({ t: 'skills', items: [] }));
      }
    });
    ws.on('close', () => {
      if (agent === ws) agent = null;
      if (agentPaused) return;
      if (agentTimer) return;
      // Reconnect like the real plugin's supervised RelayClient.
      agentTimer = setInterval(() => {
        if (agent || agentPaused) return;
        connectAgent(history).catch(() => {});
      }, 400);
    });
    ws.on('error', () => {});
  });
}

function disconnectAgent() {
  if (agentTimer) {
    clearInterval(agentTimer);
    agentTimer = null;
  }
  if (agent) agent.close();
  agent = null;
}

function cleanup() {
  if (agentTimer) clearInterval(agentTimer);
  if (agent) agent.close();
  if (relay) relay.kill('SIGKILL');
  if (preview) preview.kill('SIGKILL');
}

async function statusOf(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.conn, .status, header');
    const labels = [...document.querySelectorAll('.status-label')].map((n) => n.textContent);
    return {
      labels,
      sendDisabled: Boolean(document.querySelector('button.send')?.disabled),
      composerError: (document.querySelector('.composer-error') || {}).textContent || '',
      input: (document.querySelector('textarea') || {}).value || '',
      rows: [...document.querySelectorAll('.messages .row')].map((row) => ({
        cls: row.className,
        text: (row.querySelector('.bubble') || row).textContent.trim().slice(0, 80),
      })),
      header: el ? el.textContent.slice(0, 120) : '',
    };
  });
}

async function main() {
  if (!existsSync(join(SPA_DIR, 'dist', 'index.html'))) throw new Error('spa/dist missing');
  for (const [port, label] of [[RELAY_PORT, 'relay'], [PREVIEW_PORT, 'preview']]) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
      throw new Error(`port ${port} (${label}) is already in use — stop it first`);
    } catch (err) {
      if (err && /already in use/.test(String(err.message))) throw err;
    }
  }
  const evidence = {};

  await startRelay();
  const history = { 'chat-alpha': [{ role: 'user', text: '种子消息' }, { role: 'assistant', text: '种子回答' }] };
  await connectAgent(history);
  preview = spawn('node', [join(SPA_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: SPA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  preview.stdout.on('data', () => {});
  preview.stderr.on('data', (d) => log('preview:', String(d).trim()));
  await waitHttp(BASE, 'preview');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...devices['Desktop Chrome'], locale: 'zh-CN' });
  await context.addInitScript(() => {
    if (sessionStorage.getItem('m37.seeded')) return;
    sessionStorage.setItem('m37.seeded', '1');
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
  });

  // ---- case 3 needs a controllable path to the relay ---------------------
  let dropNextMsg = false;
  const dropped = [];
  await context.routeWebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/client`, async (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      let frame = null;
      try {
        frame = JSON.parse(typeof message === 'string' ? message : message.toString());
      } catch {
        frame = null;
      }
      if (dropNextMsg && frame && frame.t === 'msg') {
        dropNextMsg = false;
        dropped.push(frame);
        ws.close(); // the frame never reaches the relay
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      try {
        ws.send(message);
      } catch {
        /* closed */
      }
    });
    ws.onClose(() => server.close());
    server.onClose(() => ws.close());
  });

  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror:', String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.messages .row', { timeout: 15000 });
  await sleep(600);

  const sendText = async (text, how) => {
    await page.locator('textarea').fill(text);
    if (how === 'click') {
      await page.locator('button.send').click({ force: true }).catch(() => {});
    } else {
      await page.locator('textarea').press('Enter');
    }
    await sleep(500);
  };

  // ---- baseline -----------------------------------------------------------
  await sendText('P1 在线基线', 'click');
  evidence.p1 = { ...(await statusOf(page)), received: received.map((r) => r.text) };

  // ---- case 1: relay down (socket disconnected / reconnecting) -----------
  await stopRelay();
  await sleep(1200);
  const offlineLive = await statusOf(page);
  await sendText('P2 断线发送', 'click'); // button is disabled -> no-op
  const afterClick = await statusOf(page);
  await page.locator('textarea').press('Enter');
  await sleep(400);
  const afterEnter = await statusOf(page);
  evidence.p2 = { offlineLive, afterClick, afterEnter, received: received.map((r) => r.text) };

  await startRelay();
  await connectAgent(history);
  await sleep(2500);
  evidence.p2.afterReconnect = { ...(await statusOf(page)), received: received.map((r) => r.text) };

  // ---- case 2: socket live, agent offline --------------------------------
  agentPaused = true;
  disconnectAgent();
  await sleep(1200);
  const agentOfflineHeader = await statusOf(page);
  await sendText('P3 Agent 离线发送', 'click');
  const afterAgentOfflineSend = await statusOf(page);
  await sleep(2000);
  evidence.p3 = {
    headerBeforeSend: agentOfflineHeader.labels,
    afterSend: afterAgentOfflineSend,
    receivedWhileOffline: received.map((r) => r.text),
  };
  agentPaused = false;
  await connectAgent(history);
  await sleep(1200);
  evidence.p3.afterAgentBack = { received: received.map((r) => r.text), rows: (await statusOf(page)).rows };

  // ---- case 3: frame leaves, connection dies, no receipt -----------------
  await page.locator('textarea').fill('P4 途中断线');
  dropNextMsg = true;
  await page.locator('button.send').click({ force: true });
  await sleep(900);
  evidence.p4 = {
    dropped: dropped.map((f) => f.text),
    received: received.map((r) => r.text),
    ui: await statusOf(page),
  };
  // Reconnect and let the SPA settle, then reload: history is the truth.
  await sleep(2500);
  evidence.p4.afterReconnect = await statusOf(page);
  const beforeReload = await page.evaluate(() => localStorage.getItem('webchannel.drafts'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.messages .row', { timeout: 15000 });
  await sleep(700);
  evidence.p4.afterReload = { ...(await statusOf(page)), drafts: beforeReload };

  await page.screenshot({
    path: artifactFile('m37-probe-final.png', process.env.M37_OUT_PNG),
    fullPage: false,
  });
  await context.close();
  await browser.close();

  writeFileSync(
    artifactFile('m37-probe.json', process.env.M37_OUT),
    JSON.stringify(evidence, null, 2),
  );
  log(JSON.stringify(evidence, null, 2));
  cleanup();
}

main().catch((err) => {
  log('fatal:', err && err.stack ? err.stack : err);
  cleanup();
  process.exitCode = 1;
});
