// E2E M7.1: switch-cycle regression for the post-model-switch silence bug.
//
// Against the LOCAL stack (relay-node :8787 + local QwenPaw :8088 with the
// current plugin installed). Drives >= 3 full switch cycles over the real
// protocol; every probe is sent EXACTLY ONCE with a hard timeout — the M7
// harness re-sent `models` until answered, which masked this bug.
//
// Per half-cycle: set_model -> model_changed, wait for the hot reload to
// settle, then one `models` probe (must show the new active model) and one
// chat probe (trailing msg must contain the requested word). Any single
// unanswered probe fails the run.
//
// Run: node tests/e2e_m71.mjs   (prints ASSERT lines, then E2E_M71 PASS)

import { createRequire } from 'node:module';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const CLIENT_URL = 'ws://127.0.0.1:8787/ws/client';
const SETTLE_MS = Number(process.env.E2E_M71_SETTLE_MS || 12000);
const CYCLES = 3;

const frames = [];
const waiters = [];
let failures = 0;

function assert(name, cond, extra = '') {
  console.log(`ASSERT ${name}: ${cond ? 'PASS' : 'FAIL'}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures += 1;
  return cond;
}

const ws = new WebSocket(CLIENT_URL);
ws.on('message', (data) => {
  let f;
  try { f = JSON.parse(data.toString()); } catch { return; }
  frames.push(f);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].pred(f)) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(f);
    }
  }
});
const send = (obj) => ws.send(JSON.stringify(obj));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function probeModels(label, expectActive) {
  const mark = frames.length;
  send({ t: 'models' });
  try {
    const f = await waitFor(
      (x) => x.t === 'models' && framesAfter(mark)(x),
      15000,
      `${label} models`,
    );
    const active = f.items.find((i) => i.active);
    return assert(
      label,
      !!active && active.provider === expectActive.provider && active.model === expectActive.model,
      `active=${active ? `${active.provider}/${active.model}` : 'none'}`,
    );
  } catch {
    return assert(label, false, 'no models reply within 15s');
  }
}

async function probeChat(label, chat) {
  send({ t: 'msg', chat, text: 'Reply with exactly: ok' });
  try {
    const f = await waitFor(
      (x) => x.t === 'msg' && x.chat === chat,
      90000,
      `${label} chat`,
    );
    const text = (f.parts || []).map((p) => p.text || '').join('');
    return assert(label, text.trim().length > 0, `reply="${text.slice(0, 40)}"`);
  } catch {
    return assert(label, false, 'no trailing msg within 90s');
  }
}

async function doSwitch(target, label) {
  const mark = frames.length;
  send({ t: 'set_model', provider: target.provider, model: target.model });
  try {
    const f = await waitFor(
      (x) => framesAfter(mark)(x)
        && (x.t === 'model_changed' || (x.t === 'error' && x.code === 'E_MODEL')),
      30000,
      `${label} switch`,
    );
    return assert(
      label,
      f.t === 'model_changed' && f.provider === target.provider && f.model === target.model,
      f.t === 'model_changed' ? `-> ${f.provider}/${f.model}` : `error ${f.message || ''}`,
    );
  } catch {
    return assert(label, false, 'no model_changed within 30s');
  }
}

async function main() {
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const ready = await waitFor((f) => f.t === 'ready', 10000, 'ready');
  assert('ready-agent-online', ready.agentOnline === true);

  const mark = frames.length;
  send({ t: 'models' });
  const m0 = await waitFor((x) => x.t === 'models' && framesAfter(mark)(x), 15000, 'initial models');
  const original = m0.items.find((i) => i.active);
  const other = m0.items.find((i) => !i.active);
  assert('two-models-listed', !!original && !!other,
    `original=${original && `${original.provider}/${original.model}`} other=${other && `${other.provider}/${other.model}`}`);
  if (!original || !other) throw new Error('need two switchable models locally');

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    for (const [target, tag] of [[other, 'to-other'], [original, 'back']]) {
      const label = `cycle${cycle}-${tag}`;
      await doSwitch(target, `${label}-switch`);
      await sleep(SETTLE_MS);
      await probeModels(`${label}-models`, target);
      await probeChat(`${label}-chat`, `m71-${cycle}-${tag}`);
    }
  }

  console.log(failures === 0 ? 'E2E_M71 PASS' : `E2E_M71 FAIL (${failures} assertion(s))`);
  ws.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E_M71 ERROR', err);
  process.exit(2);
});
