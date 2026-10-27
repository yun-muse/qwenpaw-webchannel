// M3-prep end-to-end harness for relay-cf (coordinator test code).
// Runs against `wrangler dev --local` for relay-cf (default :8788).
// Credentials are read from relay-cf/.dev.vars (dev-only values).
// Assertions (tasks/m3-prep-brief.md Part 1):
//  1. POST /api/login: wrong password -> 401; correct -> 200 {token, expires}.
//  2. /ws/client without token -> upgrade rejected; with bad agent token too.
//  3. Agent connects (Bearer) + hello -> peer; client connects (token) -> ready
//     agentOnline:true; client msg -> agent receives it verbatim.
//  4. Agent streams start + 20 evt + end -> client receives all 20 evt in order.
//  5. Oversize frame (>256KB) -> sender gets E_TOOBIG, agent receives nothing.
//  6. Offline buffer: agent down, client sends 3 frames, agent reconnects ->
//     receives all 3 in order (after the peer frame).
//  7. Rate limit: a 40-frame burst -> some frames dropped, >=1 E_BUSY.
//  8. GET /poll -> 501 (documented deferral), GET /health -> 200.
//  9. GENERATION: a stale hello (older `started`) is closed with 4000 and does
//     not disturb the current agent (still reachable, /health agentOnline:true).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.CF_RELAY_BASE || 'http://127.0.0.1:8788';
const WS_BASE = BASE.replace(/^http/, 'ws');
const LOG = new URL('./e2e_cf.frames.log', import.meta.url);
writeFileSync(LOG, '');

const devVars = {};
for (const line of readFileSync(new URL('../relay-cf/.dev.vars', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) devVars[m[1]] = m[2].trim();
}
const AGENT_TOKEN = devVars.AGENT_TOKEN || 'dev-agent-token';
const LOGIN_PASSWORD = devVars.LOGIN_PASSWORD || 'dev-login-password';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
function verdict(name, ok, detail) {
  results[name] = ok;
  console.log(`ASSERT ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail || ''}`);
}
function logFrame(dir, frame) {
  writeFileSync(LOG, `${dir} ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`, { flag: 'a' });
}

/** Minimal scripted socket: collects frames, supports waitFor(pred). */
function connect(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const sock = {
      ws,
      frames: [],
      waiters: [],
      closeInfo: null,
      closeWaiters: [],
      send(obj) {
        const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
        logFrame('->', text);
        ws.send(text);
      },
      waitFor(pred, timeoutMs = 5000, fromIndex = 0) {
        return new Promise((res, rej) => {
          const check = () => {
            for (let i = fromIndex; i < sock.frames.length; i++) {
              if (pred(sock.frames[i])) return res(sock.frames[i]);
            }
            return null;
          };
          const found = check();
          if (found) return res(found);
          const w = { pred, res, fromIndex };
          sock.waiters.push(w);
          setTimeout(() => {
            sock.waiters = sock.waiters.filter((x) => x !== w);
            rej(new Error('waitFor timeout'));
          }, timeoutMs);
        });
      },
      close() {
        try { ws.close(); } catch { /* ignore */ }
      },
      /** Resolves with { code, reason } once the relay (or peer) closes us. */
      waitForClose(timeoutMs = 5000) {
        return new Promise((res, rej) => {
          if (sock.closeInfo) return res(sock.closeInfo);
          const w = { res };
          sock.closeWaiters.push(w);
          setTimeout(() => {
            sock.closeWaiters = sock.closeWaiters.filter((x) => x !== w);
            rej(new Error('close timeout'));
          }, timeoutMs);
        });
      },
    };
    ws.on('message', (raw) => {
      const text = raw.toString();
      logFrame('<-', text);
      let frame;
      try { frame = JSON.parse(text); } catch { frame = { t: '__unparsed', raw: text }; }
      sock.frames.push(frame);
      sock.waiters = sock.waiters.filter((w) => {
        for (let i = w.fromIndex; i < sock.frames.length; i++) {
          if (w.pred(sock.frames[i])) { w.res(sock.frames[i]); return false; }
        }
        return true;
      });
    });
    ws.on('close', (code, reason) => {
      sock.closeInfo = { code, reason: reason ? reason.toString() : '' };
      const waiters = sock.closeWaiters;
      sock.closeWaiters = [];
      for (const w of waiters) w.res(sock.closeInfo);
    });
    ws.on('open', () => resolve(sock));
    ws.on('error', (err) => reject(err));
  });
}

function connectExpectFail(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve({ ok: false, why: 'unexpectedly opened' }); });
    ws.on('unexpected-response', (_req, res) => resolve({ ok: true, status: res.statusCode }));
    ws.on('error', (err) => resolve({ ok: true, why: String(err.message || err) }));
  });
}

const agentUrl = `${WS_BASE}/ws/agent`;
const agentHeaders = { Authorization: `Bearer ${AGENT_TOKEN}` };
let failures = 0;
const must = (name) => { if (!results[name]) failures += 1; };

async function main() {
  // -- 1. login -------------------------------------------------------------
  const badLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-on-purpose' }),
  });
  const goodLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: LOGIN_PASSWORD }),
  });
  const loginBody = await goodLogin.json().catch(() => ({}));
  const token = loginBody.token;
  verdict('LOGIN', badLogin.status === 401 && goodLogin.status === 200 &&
    typeof token === 'string' && token.split('.').length === 3 && loginBody.expires > Date.now() / 1000,
    `bad=${badLogin.status} good=${goodLogin.status} expires=${loginBody.expires}`);
  must('LOGIN');

  // -- 2. unauthenticated upgrades rejected ---------------------------------
  const noTok = await connectExpectFail(`${WS_BASE}/ws/client`);
  const badAgent = await connectExpectFail(agentUrl, { Authorization: 'Bearer nope' });
  verdict('AUTH-REJECT', noTok.ok && badAgent.ok,
    `clientNoToken=${JSON.stringify(noTok)} agentBadToken=${JSON.stringify(badAgent)}`);
  must('AUTH-REJECT');

  // Warm-up: connect an agent once to flush any stale offline buffer left in
  // local DO storage by earlier runs, then disconnect. It wins the slot with
  // generation 1, so the flush (peer) happens at the hello.
  const warm = await connect(agentUrl, agentHeaders);
  warm.send({ t: 'hello', instance: 'e2e-cf', agent: 'default', started: 1, session: 'warm' });
  await warm.waitFor((f) => f.t === 'ready').catch(() => {});
  await sleep(400);
  warm.close();
  await sleep(500); // let the DO clear the slot (generation 1) before section 3

  // -- 3. pairing + client -> agent -----------------------------------------
  // This hello stays LEGACY (no `started`/`session`) on purpose: it pins the
  // legacy path, where a hello without `started` counts as generation 0.
  const agent = await connect(agentUrl, agentHeaders);
  agent.send({ t: 'hello', instance: 'e2e-cf', agent: 'default' });
  await agent.waitFor((f) => f.t === 'ready');

  const client = await connect(`${WS_BASE}/ws/client?token=${encodeURIComponent(token)}`);
  const ready = await client.waitFor((f) => f.t === 'ready');
  await agent.waitFor((f) => f.t === 'peer' && f.clients === 1);
  client.send({ t: 'msg', chat: 'c1', text: 'hello relay-cf' });
  const gotMsg = await agent.waitFor((f) => f.t === 'msg' && f.chat === 'c1');
  verdict('PAIRING', ready.agentOnline === true && gotMsg.text === 'hello relay-cf',
    `ready.agentOnline=${ready.agentOnline} msgText=${JSON.stringify(gotMsg.text)}`);
  must('PAIRING');

  // -- 4. ordered streaming: start + 20 evt + end ---------------------------
  await sleep(1200); // let the rate bucket refill
  const evtSeqs = [];
  const streamDone = client.waitFor((f) => f.t === 'end' && f.chat === 'c1', 8000);
  client.ws.on('message', (raw) => {
    try {
      const f = JSON.parse(raw.toString());
      if (f.t === 'evt' && f.chat === 'c1') evtSeqs.push(f.seq);
    } catch { /* ignore */ }
  });
  agent.send({ t: 'start', chat: 'c1', seq: 1 });
  for (let i = 0; i < 20; i++) {
    agent.send({ t: 'evt', chat: 'c1', seq: 2 + i, data: { text: `chunk-${i} ` } });
    await sleep(25);
  }
  agent.send({ t: 'end', chat: 'c1', seq: 22 });
  await streamDone;
  const inOrder = evtSeqs.length === 20 && evtSeqs.every((s, i) => s === 2 + i);
  verdict('STREAM-ORDER', inOrder, `evtCount=${evtSeqs.length} seqs=${evtSeqs.join(',')}`);
  must('STREAM-ORDER');

  // -- 5. oversize frame ------------------------------------------------------
  const agentFrameCount = agent.frames.length;
  const big = { t: 'msg', chat: 'c1', text: 'x'.repeat(300 * 1024) };
  client.send(big);
  const tooBig = await client.waitFor((f) => f.t === 'error' && f.code === 'E_TOOBIG');
  await sleep(300);
  const agentGotBig = agent.frames.slice(agentFrameCount).some((f) => f.t === 'msg' && typeof f.text === 'string' && f.text.length > 1000);
  verdict('E_TOOBIG', tooBig.code === 'E_TOOBIG' && !agentGotBig, `agentForwarded=${agentGotBig}`);
  must('E_TOOBIG');

  // -- 6. offline buffer flush -------------------------------------------------
  agent.close();
  await sleep(500);
  for (let i = 0; i < 3; i++) client.send({ t: 'msg', chat: 'c2', text: `buffered-${i}` });
  await sleep(400); // let the DO persist the outbox
  const agent2 = await connect(agentUrl, agentHeaders);
  // Gated hello: generation 2 beats the legacy generation-0 agent, which is
  // evicted at the hello; the outbox flush happens as part of winning the slot.
  agent2.send({ t: 'hello', instance: 'e2e-cf', agent: 'default', started: 2, session: 'e2e-cf-2' });
  await agent2.waitFor((f) => f.t === 'ready');
  const flushed = [];
  const flushDone = new Promise((resolve) => {
    const iv = setInterval(() => {
      for (const f of agent2.frames) {
        if (f.t === 'msg' && f.chat === 'c2' && !flushed.includes(f.text)) flushed.push(f.text);
      }
      if (flushed.length >= 3) { clearInterval(iv); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(iv); resolve(); }, 5000);
  });
  await flushDone;
  const flushedInOrder = JSON.stringify(flushed) === JSON.stringify(['buffered-0', 'buffered-1', 'buffered-2']);
  verdict('OFFLINE-BUFFER', flushedInOrder, `flushed=${JSON.stringify(flushed)}`);
  must('OFFLINE-BUFFER');

  // -- 7. rate limit ------------------------------------------------------------
  await sleep(1200); // refill bucket
  const agent2Before = agent2.frames.filter((f) => f.t === 'msg' && f.chat === 'c3').length;
  let busySeen = 0;
  const busyCounter = (raw) => {
    try { const f = JSON.parse(raw.toString()); if (f.t === 'error' && f.code === 'E_BUSY') busySeen += 1; } catch { /* ignore */ }
  };
  client.ws.on('message', busyCounter);
  for (let i = 0; i < 40; i++) client.send({ t: 'msg', chat: 'c3', text: `burst-${i}` });
  await sleep(800);
  const delivered = agent2.frames.filter((f) => f.t === 'msg' && f.chat === 'c3').length - agent2Before;
  verdict('RATE-LIMIT', delivered < 40 && busySeen >= 1, `delivered=${delivered}/40 busyFrames=${busySeen}`);
  must('RATE-LIMIT');

  // -- 8. /poll deferral + /health ----------------------------------------------
  const poll = await fetch(`${BASE}/poll?cursor=0`);
  const health = await (await fetch(`${BASE}/health`)).json();
  verdict('POLL-AND-HEALTH', poll.status === 501 && health.ok === true && health.agentOnline === true &&
    typeof health.agentLastSeen === 'number' && health.agentLastSeen > 0,
    `poll=${poll.status} health=${JSON.stringify(health)}`);

  // -- 8b. agent last-seen ------------------------------------------------------
  // /health.agentLastSeen is stamped by the agent's own business frames (hello
  // counts; the app-level ping is auto-answered and never reaches the handler),
  // so a later value must not go backwards.
  const seenFirst = health.agentLastSeen;
  agent2.send({ t: 'msg', chat: 'c10', text: 'last-seen-probe' });
  await sleep(60);
  const healthLater = await (await fetch(`${BASE}/health`)).json();
  verdict('AGENT-LAST-SEEN',
    typeof healthLater.agentLastSeen === 'number' && healthLater.agentLastSeen >= seenFirst,
    `first=${seenFirst} later=${healthLater.agentLastSeen}`);

  // -- 9. generation gating -----------------------------------------------------
  // A stale agent (older `started`) is closed with 4000 and must not disturb
  // the current agent (agent2) or /health.
  await sleep(1200); // let the rate bucket refill
  const stale = await connect(agentUrl, agentHeaders);
  stale.send({ t: 'hello', instance: 'e2e-cf', agent: 'default', started: 1, session: 'stale' });
  const staleClose = await stale.waitForClose().catch(() => ({ code: 0, reason: 'no close' }));
  const healthAfterStale = await (await fetch(`${BASE}/health`)).json();

  await sleep(1200); // refill: the stale hello spent a token
  const agent2Seen = agent2.frames.length;
  client.send({ t: 'msg', chat: 'c9', text: 'gen-probe' });
  const probe = await agent2
    .waitFor((f) => f.t === 'msg' && f.chat === 'c9', 5000, agent2Seen)
    .catch(() => null);
  verdict('GENERATION',
    staleClose.code === 4000 && healthAfterStale.agentOnline === true &&
      probe !== null && probe.text === 'gen-probe',
    `staleClose=${staleClose.code} agentOnline=${healthAfterStale.agentOnline} probe=${probe ? JSON.stringify(probe.text) : 'missing'}`);
  must('GENERATION');

  client.close();
  agent2.close();

  const mandatory = ['LOGIN', 'AUTH-REJECT', 'PAIRING', 'STREAM-ORDER', 'E_TOOBIG', 'OFFLINE-BUFFER', 'RATE-LIMIT', 'GENERATION'];
  const failed = mandatory.filter((n) => !results[n]);
  console.log(failed.length === 0 ? 'E2E_CF PASS' : `E2E_CF FAIL (${failed.join(', ')})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E_CF ERROR', err);
  process.exit(1);
});
