// M0 end-to-end proof (test harness, not product code):
// relay-node + mock_agent + browser-style client. PASS if a single reply
// arrives as >10 distinct evt frames, in strictly increasing seq order,
// terminated by an end frame for the same chat.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18788;
const CHAT = 'e2e';
const TIMEOUT_MS = 20000;

const children = [];
function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${name}!] ${d}`));
  children.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup(code) {
  for (const p of children) { try { p.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 300);
}

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what}`);
}

let agentOnline = false;
const evts = [];
let ended = false;
let finalMsg = null;

const timer = setTimeout(() => {
  console.log(`FAIL: timeout after ${TIMEOUT_MS}ms (evt frames so far: ${evts.length}, ended=${ended})`);
  cleanup(1);
}, TIMEOUT_MS);

try {
  start('relay', 'node', ['relay-node/server.js'], { PORT: String(PORT) });
  await sleep(600);
  start('mock', 'node', ['mock/mock_agent.mjs'], {
    RELAY_URL: `ws://127.0.0.1:${PORT}/ws/agent`,
    AGENT_TOKEN: 'dev-agent-token',
  });
  await sleep(800);

  const client = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client`);
  client.on('message', (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return; }
    if (f.t === 'ready') agentOnline = !!f.agentOnline;
    if (f.t === 'evt' && f.chat === CHAT) evts.push(f);
    if (f.t === 'msg' && f.chat === CHAT && Array.isArray(f.parts)) finalMsg = f;
    if (f.t === 'end' && f.chat === CHAT) {
      ended = true;
      clearTimeout(timer);
      const seqs = evts.map((e) => e.seq);
      const inOrder = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
      const distinct = new Set(seqs).size === seqs.length;
      console.log(`RESULT: evt_frames=${evts.length} seq_first=${seqs[0]} seq_last=${seqs[seqs.length - 1]} in_order=${inOrder} distinct_seq=${distinct} ended=${ended} final_msg=${!!finalMsg} agent_online_at_ready=${agentOnline}`);
      if (evts.length > 10 && inOrder && distinct && ended) {
        console.log('E2E PASS');
        cleanup(0);
      } else {
        console.log('E2E FAIL');
        cleanup(1);
      }
    }
  });
  await waitFor(() => client.readyState === WebSocket.OPEN, 'client open');
  await waitFor(() => agentOnline, 'agent online (relay ready frame)', 5000).catch(() => {
    console.log('note: ready frame said agent offline; sending anyway (mock may have connected after)');
  });
  client.send(JSON.stringify({ t: 'msg', chat: CHAT, text: 'hello e2e' }));
  console.log('[e2e] sent one msg, awaiting streamed reply...');
} catch (err) {
  clearTimeout(timer);
  console.log('E2E FAIL:', err.message);
  cleanup(1);
}
