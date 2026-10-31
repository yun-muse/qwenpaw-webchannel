// M2 end-to-end harness (coordinator test code, not product code).
// Runs against the externally running local stack: relay-node :8787 +
// local QwenPaw :8088 with the M2 plugin installed. Assertions per
// tasks/m2-brief.md Part C:
//  0. A5 negative: approve with a bogus req_id -> error frame E_AUTH.
//  1. A1: streamed reply ends with end frame FOLLOWED BY a trailing msg
//     frame whose text == concatenation of evt deltas.
//  2. A3: a FRESH client sending {t:"hist"} gets messages containing the
//     user text and the assistant reply.
//  3. A4: msg with a small base64 file -> no error frame, reply completes.
//  4. Resume: disconnect mid-stream, reconnect + {t:"resume", last_seq},
//     missed frames arrive and full text assembles == trailing msg text.
//  5. Stretch: try to trigger a real approval via a shell-tool prompt.
// All frames logged to tests/out/e2e_m2.frames.log (EVIDENCE=1 writes the
// tracked tests/e2e_m2.frames.log). Each assertion prints a
// line; final line is E2E_M2 PASS/FAIL for the mandatory assertions 0-3
// (resume + approval report their own verdicts).
import { createRequire } from 'node:module';
import { writeFileSync, appendFileSync } from 'node:fs';

import { artifactFile } from './artifacts.mjs';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const PORT = 8787;
const LOG = artifactFile('e2e_m2.frames.log', process.env.LOG_FILE);
writeFileSync(LOG, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
function verdict(name, ok, detail) {
  results[name] = ok;
  console.log(`ASSERT ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail || ''}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client`);
    const frames = [];
    const waiters = [];
    ws._idx = 0; // consumption cursor: frames before it are never re-matched
    ws.on('message', (raw) => {
      const line = raw.toString();
      appendFileSync(LOG, line + '\n');
      let f; try { f = JSON.parse(line); } catch { return; }
      frames.push(f);
      const idx = frames.length - 1;
      for (let i = 0; i < waiters.length; i++) {
        if (idx >= ws._idx && waiters[i].pred(f)) { const w = waiters.splice(i, 1)[0]; w.res(f, idx); break; }
      }
    });
    ws.on('error', reject);
    ws.waitFor = (pred, timeoutMs, label) => new Promise((res, rej) => {
      for (let i = ws._idx; i < frames.length; i++) {
        if (pred(frames[i])) { ws._idx = i + 1; return res(frames[i]); }
      }
      const w = { pred, res: (f, i) => { clearTimeout(t); ws._idx = i + 1; res(f); } };
      const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout waiting ' + label)); }, timeoutMs);
      waiters.push(w);
    });
    ws.frames = frames;
    ws.on('open', () => resolve(ws));
  });
}

// Collect one full streamed reply for `chat`: start..end + trailing msg.
async function collectReply(ws, chat, timeoutMs = 150000) {
  const evts = [];
  let endSeq = null; let trailing = null; let errFrame = null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = await ws.waitFor((x) => x.chat === chat && ['evt', 'end', 'msg', 'error'].includes(x.t), timeoutMs, 'reply frame').catch(() => null);
    if (!f) break;
    if (f.t === 'evt') evts.push(f);
    else if (f.t === 'error') { errFrame = f; break; }
    else if (f.t === 'end' && (!f.stream_type || f.stream_type === 'message')) {
      endSeq = f.seq;
      // trailing msg should follow promptly
      const m = await ws.waitFor((x) => x.chat === chat && x.t === 'msg', 15000, 'trailing msg').catch(() => null);
      if (m) trailing = m;
      break;
    } else if (f.t === 'msg' && endSeq === null) {
      trailing = f; // non-streamed reply delivered as msg only
      break;
    }
  }
  // Answer text = deltas of the "message" stream segment only; reasoning
  // deltas (data.stream_type === 'reasoning') are the model's thinking.
  const msgEvts = evts.filter((e) => !e.data || !e.data.stream_type || e.data.stream_type === 'message');
  const text = msgEvts.map((e) => (e.data && e.data.text) || '').join('');
  return { evts, msgEvts, endSeq, trailing, text, errFrame };
}

const main = await connect();
const ready = await main.waitFor((f) => f.t === 'ready', 10000, 'ready');
console.log('ready agentOnline =', ready.agentOnline);
if (!ready.agentOnline) { console.log('E2E_M2 FAIL: agent offline'); process.exit(1); }

// --- 0. A5 negative -------------------------------------------------------
main.send(JSON.stringify({ t: 'approve', chat: 'm2main', req_id: 'bogus-req-12345' }));
const authErr = await main.waitFor((f) => f.t === 'error' && f.req_id === 'bogus-req-12345', 30000, 'E_AUTH error').catch(() => null);
verdict('A5-bogus-approve-rejected', !!authErr && authErr.code === 'E_AUTH', authErr ? `code=${authErr.code}` : 'no error frame');

// --- 1. A1 trailing msg ---------------------------------------------------
main.send(JSON.stringify({ t: 'msg', chat: 'm2main', text: 'Please write a short paragraph about the ocean, at least three sentences long.' }));
const r1 = await collectReply(main, 'm2main');
const trailingText = r1.trailing && Array.isArray(r1.trailing.parts) ? (r1.trailing.parts.find((p) => p.type === 'text') || {}).text : null;
verdict('A1-trailing-msg', !!r1.trailing && trailingText === r1.text && r1.evts.length >= 1,
  `evt_frames=${r1.evts.length} concat_len=${r1.text.length} trailing_len=${trailingText ? trailingText.length : -1} equal=${trailingText === r1.text}`);

// --- 2. A3 hist via fresh client ------------------------------------------
const fresh = await connect();
await fresh.waitFor((f) => f.t === 'ready', 10000, 'ready2');
fresh.send(JSON.stringify({ t: 'hist', chat: 'm2main' }));
let histMsgs = [];
{
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const f = await fresh.waitFor((x) => x.t === 'hist' && x.chat === 'm2main', 30000, 'hist frame').catch(() => null);
    if (!f) break;
    histMsgs = histMsgs.concat(f.messages || []);
    if (!f.more) break;
  }
}
const histText = histMsgs.map((m) => m.text || '').join('\n');
verdict('A3-hist-roundtrip', histMsgs.length >= 2 && histText.includes('ocean') && r1.text.length > 0 && histText.includes(r1.text.slice(0, 24)),
  `hist_messages=${histMsgs.length} roles=${histMsgs.map((m) => m.role).join(',')}`);
fresh.close();

// --- 3. A4 small file attach ----------------------------------------------
const b64 = Buffer.from('hello attachment from e2e_m2', 'utf8').toString('base64');
main.send(JSON.stringify({ t: 'msg', chat: 'm2file', text: 'I attached a small note. Reply with one short sentence confirming you got it.', files: [{ name: 'note.txt', mime: 'text/plain', data: b64 }] }));
const r3 = await collectReply(main, 'm2file');
verdict('A4-file-attach', !r3.errFrame && (r3.endSeq !== null || !!r3.trailing) && (r3.text.length > 0 || !!r3.trailing),
  `error=${r3.errFrame ? r3.errFrame.code : 'none'} evt_frames=${r3.evts.length} reply_len=${r3.text.length}`);

// --- 4. Resume mid-stream (real agent) -------------------------------------
let resumeOk = false; let resumeDetail = '';
{
  const chat = 'm2resume';
  const c1 = await connect();
  await c1.waitFor((f) => f.t === 'ready', 10000, 'ready3');
  c1.send(JSON.stringify({ t: 'msg', chat, text: 'Write a detailed numbered list of 10 tips for better sleep, each tip one full sentence. Take your time.' }));
  const pre = [];
  let lastSeq = 0; let endedPre = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const f = await c1.waitFor((x) => x.chat === chat && ['evt', 'end'].includes(x.t), 30000, 'pre-disconnect frame').catch(() => null);
    if (!f) break;
    pre.push(f); lastSeq = f.seq;
    if (f.t === 'end') { endedPre = true; break; }
    if (pre.filter((x) => x.t === 'evt').length >= 2) break;
  }
  if (endedPre || pre.length === 0) {
    resumeDetail = `could not stage mid-stream disconnect (endedPre=${endedPre}, pre_frames=${pre.length})`;
  } else {
    c1.terminate();
    await sleep(1200);
    const c2 = await connect();
    await c2.waitFor((f) => f.t === 'ready', 10000, 'ready4');
    c2.send(JSON.stringify({ t: 'resume', chat, last_seq: lastSeq }));
    const post = [];
    let trailing2 = null; let endSeen = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 120000 && !trailing2) {
      const f = await c2.waitFor((x) => x.chat === chat && ['evt', 'end', 'msg', 'resync'].includes(x.t), 60000, 'post-resume frame').catch(() => null);
      if (!f) break;
      if (f.t === 'resync') { resumeDetail = 'got resync instead of replay'; break; }
      post.push(f);
      if (f.t === 'end') endSeen = true;
      if (f.t === 'msg') trailing2 = f;
    }
    const redelivered = post.filter((f) => f.seq > lastSeq);
    const isMsgEvt = (f) => f.t === 'evt' && (!f.data || !f.data.stream_type || f.data.stream_type === 'message');
    const allEvts = pre.filter(isMsgEvt).concat(post.filter(isMsgEvt));
    const bySeq = new Map(); for (const e of allEvts) bySeq.set(e.seq, e);
    const assembled = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => (e.data && e.data.text) || '').join('');
    const tText = trailing2 && Array.isArray(trailing2.parts) ? (trailing2.parts.find((p) => p.type === 'text') || {}).text : null;
    resumeOk = redelivered.length > 0 && endSeen && !!trailing2 && assembled === tText;
    resumeDetail = `pre_frames=${pre.length} last_seq=${lastSeq} redelivered=${redelivered.length} end=${endSeen} assembled_len=${assembled.length} trailing_len=${tText ? tText.length : -1} equal=${assembled === tText}`;
    c2.close();
  }
  if (c1.readyState === 1) c1.close();
}
verdict('RESUME-mid-stream', resumeOk, resumeDetail);

// --- 5. Stretch: real approval trigger --------------------------------------
let approvalDetail = 'no approval frame observed';
{
  const chat = 'm2appr';
  main.send(JSON.stringify({ t: 'msg', chat, text: 'Use your shell tool to run exactly this command: echo m2-approval-probe — then tell me what it printed.' }));
  const ap = await main.waitFor((f) => f.t === 'approval' && f.chat === chat, 120000, 'approval frame').catch(() => null);
  if (ap) {
    approvalDetail = `approval arrived req_id=${ap.req_id} tool=${ap.tool} severity=${ap.severity}; sending approve`;
    main.send(JSON.stringify({ t: 'approve', chat, req_id: ap.req_id }));
    const r5 = await collectReply(main, chat, 120000);
    approvalDetail += `; after approve: evt_frames=${r5.evts.length} end=${r5.endSeq !== null} reply_len=${r5.text.length} err=${r5.errFrame ? r5.errFrame.code : 'none'}`;
    results['APPROVAL-e2e'] = r5.endSeq !== null || !!r5.trailing;
  }
}
console.log('STRETCH APPROVAL:', approvalDetail, results['APPROVAL-e2e'] === undefined ? '(not triggered)' : results['APPROVAL-e2e'] ? 'PASS' : 'FAIL');

const mandatory = ['A5-bogus-approve-rejected', 'A1-trailing-msg', 'A3-hist-roundtrip', 'A4-file-attach'];
const allPass = mandatory.every((k) => results[k]);
console.log(allPass ? 'E2E_M2 PASS (mandatory assertions)' : 'E2E_M2 FAIL (mandatory assertions)');
process.exit(allPass ? 0 : 1);
