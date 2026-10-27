// E2E M7.2: full-stack kill-and-recover for the relay tunnel.
//
// Against the LOCAL stack: this script OWNS the relay (spawns
// `node relay-node/server.js` with PORT=8787, built-in dev agent token) and
// drives the real protocol against a local QwenPaw on :8088, which the
// coordinator starts (with the current plugin) BEFORE running this script.
//
// Flow:
//   baseline: models probe + chat probe
//   3 x : SIGKILL the relay -> 1000 ms -> respawn -> wait for our own client
//         to see `ready{agentOnline:true}` (<=60 s; the plugin's RelayClient
//         reconnects on its own, the app is never restarted) -> models probe
//         + chat probe.
//
// Every probe is sent EXACTLY ONCE with a hard 30 s timeout: a lost frame or
// a relay bounce that is not recovered fails the run. Our own client socket
// auto-reconnects every 500 ms (the kill bounces it too) and deliberately
// bounces its connection while the relay reports agentOnline:false, because
// relay-node never pushes an "agent is back" event to already-connected
// clients.
//
// Run: node tests/e2e_m72.mjs   (prints ASSERT lines, then E2E_M72 PASS)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY_SCRIPT = path.join(ROOT, 'relay-node', 'server.js');

const PORT = Number(process.env.E2E_M72_RELAY_PORT || 8787);
const CLIENT_URL = `ws://127.0.0.1:${PORT}/ws/client`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

const CYCLES = 3;
const RECONNECT_MS = 500;
const KILL_PAUSE_MS = 1000;
const READY_MS = Number(process.env.E2E_M72_READY_MS || 60000);
const PROBE_MS = Number(process.env.E2E_M72_PROBE_MS || 30000);
const HEALTH_MS = Number(process.env.E2E_M72_HEALTH_MS || 15000);

const frames = [];
const waiters = [];
let failures = 0;

function assert(name, cond, extra = '') {
  console.log(`ASSERT ${name}: ${cond ? 'PASS' : 'FAIL'}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures += 1;
  return cond;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Frame log / waiter machinery (same single-shot style as e2e_m71.mjs)
// ---------------------------------------------------------------------------

function waitFor(pred, timeoutMs, label) {
  const hit = frames.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    waiters.push(w);
  });
}

function framesAfter(index) {
  return (f) => frames.indexOf(f) >= index;
}

function onFrame(f, gen) {
  // A socket we already gave up on must not feed the log or bounce the live one.
  if (gen !== generation) return;
  frames.push(f);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].pred(f)) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(f);
    }
  }
  // A relay with no agent never tells connected clients that the agent came
  // back, so bounce until a ready arrives with agentOnline:true.
  if (f.t === 'ready') {
    if (f.agentOnline === true) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    } else {
      scheduleReconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// Reconnecting client socket
// ---------------------------------------------------------------------------

let sock = null;
let generation = 0;
let reconnectTimer = null;
let stopping = false;

function connect() {
  const gen = ++generation;
  const ws = new WebSocket(CLIENT_URL);
  sock = ws;

  ws.on('message', (data) => {
    let f;
    try { f = JSON.parse(data.toString()); } catch { return; }
    onFrame(f, gen);
  });
  ws.on('close', () => {
    if (!stopping && gen === generation) scheduleReconnect();
  });
  ws.on('error', () => {
    if (gen === generation) {
      try { ws.terminate(); } catch { /* already dead */ }
    }
  });
  return ws;
}

function scheduleReconnect(delay = RECONNECT_MS) {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const old = sock;
    sock = null;
    generation += 1; // the old socket's close handler must stay quiet
    if (old) {
      try { old.terminate(); } catch { /* already dead */ }
    }
    connect();
  }, delay);
}

function send(obj) {
  const ws = sock;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('client socket is not open');
  }
  ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Relay child process
// ---------------------------------------------------------------------------

let relay = null;

function spawnRelay() {
  const env = { ...process.env, PORT: String(PORT) };
  // server.js defaults AGENT_TOKEN to the same dev token the local stack
  // uses; only forward an explicit override.
  if (!process.env.AGENT_TOKEN) delete env.AGENT_TOKEN;

  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const note = (line) => {
    const text = line.toString().trim();
    if (!text) return;
    if (process.env.E2E_M72_VERBOSE) console.log(`relay: ${text}`);
  };
  child.stdout.on('data', note);
  child.stderr.on('data', (d) => note(`stderr: ${d}`));
  child.on('error', (err) => console.log(`NOTE relay spawn error: ${err.message}`));
  relay = child;
  return child;
}

function stopRelay() {
  const child = relay;
  relay = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

async function waitHealth(timeoutMs, label) {
  const t0 = Date.now();
  let last = 'no answer';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) return body;
        last = `body ${JSON.stringify(body)}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Error(`relay /health not up within ${timeoutMs / 1000}s for ${label} (${last})`);
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeModels(label) {
  const mark = frames.length;
  try {
    send({ t: 'models' });
  } catch (err) {
    return assert(label, false, `send failed: ${err.message}`);
  }
  try {
    const f = await waitFor(
      (x) => x.t === 'models' && framesAfter(mark)(x),
      PROBE_MS,
      `${label} models`,
    );
    const items = Array.isArray(f.items) ? f.items : [];
    const active = items.find((i) => i.active === true);
    return assert(
      label,
      items.length >= 1 && !!active,
      `items=${items.length} active=${active ? `${active.provider}/${active.model}` : 'none'}`,
    );
  } catch {
    return assert(label, false, `no models reply within ${PROBE_MS / 1000}s`);
  }
}

async function probeChat(label, word) {
  const mark = frames.length;
  const chat = `m72-${word}-${Date.now().toString(36)}`;
  try {
    send({ t: 'msg', chat, text: `Reply with exactly: ${word}` });
  } catch (err) {
    return assert(label, false, `send failed: ${err.message}`);
  }
  try {
    const f = await waitFor(
      (x) => x.t === 'msg' && x.chat === chat && framesAfter(mark)(x),
      PROBE_MS,
      `${label} chat`,
    );
    const text = Array.isArray(f.parts)
      ? f.parts.map((p) => (p && p.text) || '').join('')
      : (f.text || '');
    const got = text.toLowerCase().includes(word.toLowerCase());
    return assert(label, got, `reply="${text.slice(0, 60)}"`);
  } catch {
    return assert(label, false, `no trailing msg within ${PROBE_MS / 1000}s`);
  }
}

async function waitReadyOnline(mark, timeoutMs, label) {
  try {
    return await waitFor(
      (x) => x.t === 'ready' && x.agentOnline === true && framesAfter(mark)(x),
      timeoutMs,
      label,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

async function main() {
  connect();
  spawnRelay();
  await waitHealth(HEALTH_MS, 'initial start');

  // Baseline: the relay is up and the plugin has connected.
  const baselineReady = await waitReadyOnline(0, READY_MS, 'baseline ready');
  assert('baseline-ready-agent-online', !!baselineReady);
  if (baselineReady) {
    await probeModels('baseline-models');
    await probeChat('baseline-chat', 'm72base');
  } else {
    assert('baseline-models', false, 'skipped: agent never came online');
    assert('baseline-chat', false, 'skipped: agent never came online');
  }

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    stopRelay();
    await sleep(KILL_PAUSE_MS);

    // Only frames from after the kill may satisfy the readiness probe.
    const mark = frames.length;
    spawnRelay();
    await waitHealth(HEALTH_MS, `cycle${cycle} respawn`);

    const ready = await waitReadyOnline(mark, READY_MS, `cycle${cycle} ready`);
    assert(`cycle${cycle}-ready-agent-online`, !!ready);
    if (!ready) {
      assert(`cycle${cycle}-models`, false, 'skipped: plugin never came back online');
      assert(`cycle${cycle}-chat`, false, 'skipped: plugin never came back online');
      continue;
    }
    await probeModels(`cycle${cycle}-models`);
    await probeChat(`cycle${cycle}-chat`, `m72c${cycle}`);
  }
}

function shutdown() {
  stopping = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (sock) sock.close();
  } catch { /* ignore */ }
  stopRelay();
}

// Belt and braces: never leave the relay behind, even on a hard exit.
process.on('exit', stopRelay);
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });

main()
  .then(() => {
    const ok = failures === 0;
    console.log(ok ? 'E2E_M72 PASS' : `E2E_M72 FAIL (${failures} assertion(s))`);
    shutdown();
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error('E2E_M72 ERROR', err && err.stack ? err.stack : err);
    shutdown();
    process.exit(2);
  });
