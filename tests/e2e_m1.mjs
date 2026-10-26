// M1 end-to-end harness (test harness, not product code):
// Uses the EXTERNALLY running relay-node on :8787 (the one the real
// QwenPaw WebChannel plugin dials). Connects as a browser client,
// expects ready{agentOnline:true} (Tier 1 evidence), then sends one
// {t:"msg", chat:"m1"} and collects start/evt/end frames (Tier 2):
// PASS requires a start frame, >1 evt frames with strictly increasing
// seq, concatenated evt data.text forming a non-empty coherent reply,
// and an end frame. All frames are logged to tests/e2e_m1.frames.log.
import { createRequire } from 'node:module';
import { writeFileSync, appendFileSync } from 'node:fs';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const PORT = 8787;
const CHAT = 'm1';
const TIMEOUT_MS = Number(process.env.E2E_M1_TIMEOUT_MS || 120000);
const LOG = new URL('./e2e_m1.frames.log', import.meta.url);
writeFileSync(LOG, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let agentOnline = null;
let started = false;
let ended = false;
const evts = [];
let finalMsg = null;

const client = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client`);
const deadline = setTimeout(() => {
  console.log(`RESULT: timeout after ${TIMEOUT_MS}ms agentOnline=${agentOnline} started=${started} evt_frames=${evts.length} ended=${ended}`);
  console.log('E2E_M1 FAIL (timeout)');
  process.exit(1);
}, TIMEOUT_MS);

client.on('message', (raw) => {
  const line = raw.toString();
  appendFileSync(LOG, line + '\n');
  let f;
  try { f = JSON.parse(line); } catch { return; }
  if (f.t === 'ready') {
    agentOnline = !!f.agentOnline;
    console.log(`[e2e_m1] ready: agentOnline=${agentOnline}`);
    if (agentOnline) {
      client.send(JSON.stringify({ t: 'msg', chat: CHAT, text: 'Say hello in one short sentence' }));
      console.log('[e2e_m1] sent msg, awaiting streamed reply...');
    }
  }
  if (f.chat !== CHAT) return;
  if (f.t === 'start') started = true;
  if (f.t === 'evt') evts.push(f);
  if (f.t === 'msg' && Array.isArray(f.parts)) finalMsg = f;
  if (f.t === 'end') {
    ended = true;
    clearTimeout(deadline);
    const seqs = evts.map((e) => e.seq);
    const inOrder = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
    const text = evts.map((e) => (e.data && e.data.text) || '').join('');
    console.log(`RESULT: agentOnline=${agentOnline} started=${started} evt_frames=${evts.length} seq_first=${seqs[0]} seq_last=${seqs[seqs.length - 1]} in_order=${inOrder} ended=${ended} final_msg=${!!finalMsg}`);
    console.log(`REPLY_TEXT: ${JSON.stringify(text.slice(0, 300))}`);
    if (agentOnline && started && evts.length > 1 && inOrder && ended && text.trim().length > 0) {
      console.log('E2E_M1 PASS (Tier 2)');
      process.exit(0);
    }
    console.log('E2E_M1 FAIL');
    process.exit(1);
  }
});
client.on('error', (e) => {
  console.log('E2E_M1 FAIL: ws error', e.message);
  process.exit(1);
});
