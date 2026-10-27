// Soak probe for the PRODUCTION WebChannel relay (ops tooling, not product code).
// Logs in like the SPA, checks status + models frames, sends one tiny chat
// message with a unique marker and waits for the streamed reply to contain it.
// Prints exactly one JSON line: {ok, ts, agentLastSeen, models, chatMs, detail}.
// Exit code 0 = healthy, 1 = unhealthy. Password read from .secrets (never printed).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const BASE = 'https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev';
const WS_BASE = BASE.replace(/^http/, 'ws');
const rf = readFileSync;
const secretPath = ['..', '.secrets', 'login_password.txt'].join('/');
const password = rf(new URL(secretPath, import.meta.url), 'utf8').trim();
const marker = 'soak' + Date.now().toString(36);
const started = Date.now();
const out = { ok: false, ts: new Date().toISOString(), marker };
const done = (code) => { console.log(JSON.stringify(out)); process.exit(code); };
const timer = setTimeout(() => { out.detail = 'timeout'; done(1); }, 90000);

try {
  const health = await (await fetch(BASE + '/health')).json();
  out.agentOnline = health.agentOnline;
  out.agentLastSeen = health.agentLastSeen ?? null;
  if (!health.agentOnline) { out.detail = 'agent offline per /health'; clearTimeout(timer); done(1); }

  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const lj = await login.json().catch(() => ({}));
  if (!login.ok || !lj.token) { out.detail = 'login failed ' + login.status; clearTimeout(timer); done(1); }

  const ws = new WebSocket(`${WS_BASE}/ws/client?token=${encodeURIComponent(lj.token)}`);
  const frames = [];
  const waiters = [];
  ws.on('message', (d) => {
    let f; try { f = JSON.parse(d.toString()); } catch { return; }
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { waiters[i].res(f); waiters.splice(i, 1); }
    }
  });
  const waitFor = (pred, ms) => new Promise((res, rej) => {
    const hit = frames.find(pred);
    if (hit) return res(hit);
    const w = { pred, res };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('frame timeout')); } }, ms);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let status;
  try {
    status = await waitFor((f) => f.t === 'status', process.env.SOAK_SKIP_STATUS ? 5000 : 20000);
  } catch {
    if (!process.env.SOAK_SKIP_STATUS) throw new Error('frame timeout');
    status = { t: 'status' };
    out.statusMissing = true;
  }
  out.agent = status.agent_name || null;
  out.activeModel = status.provider && status.model ? `${status.provider}/${status.model}` : null;
  if (!status.agent_name || !status.model) {
    if (process.env.SOAK_SKIP_STATUS) out.statusMissing = true;
    else throw new Error('status frame missing agent/model');
  }

  ws.send(JSON.stringify({ t: 'models' }));
  const models = await waitFor((f) => f.t === 'models', 20000);
  out.models = Array.isArray(models.items) ? models.items.length : 0;
  if (!out.models) throw new Error('models list empty');

  const chat = 'soak-' + marker;
  const t0 = Date.now();
  ws.send(JSON.stringify({ t: 'msg', chat, text: `Reply with exactly: ${marker}` }));
  let text = '';
  let cursor = frames.length;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    let f = null;
    while (cursor < frames.length) {
      const x = frames[cursor++];
      if (x.chat === chat && (x.t === 'evt' || x.t === 'msg' || x.t === 'end' || x.t === 'error')) { f = x; break; }
    }
    if (!f) { await new Promise((r) => setTimeout(r, 250)); continue; }
    if (f.t === 'error') throw new Error('chat error ' + (f.code || ''));
    if (f.t === 'evt') text += typeof f.data === 'string' ? f.data : (f.data && typeof f.data.text === 'string' ? f.data.text : '');
    if (f.t === 'msg') { text += ' ' + JSON.stringify(f); break; }
    if (f.t === 'end' && text) break;
  }
  out.chatMs = Date.now() - t0;
  out.replyHasMarker = text.includes(marker);
  if (!out.replyHasMarker) throw new Error('reply missing marker, got: ' + text.slice(0, 80));
  out.ok = true;
  out.totalMs = Date.now() - started;
  ws.close();
  clearTimeout(timer);
  done(0);
} catch (e) {
  out.detail = String(e && e.message || e);
  clearTimeout(timer);
  done(1);
}
