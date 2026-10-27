// M6 end-to-end harness (coordinator test code, not product code).
// Runs against the externally started local stack: relay-node :8787 +
// local QwenPaw :8088 with the M6 plugin configured for Turso. Checks
// per tasks/m6-tools-task.md:
//  1. one chat with a unique marker goes through the real agent,
//  2. the reply streams back (trailing msg, else concatenated evt deltas),
//  3. tools/turso_history.py --chat <chat> eventually exits 0 and shows
//     BOTH the exact user text and the exact reply text,
//  4. tools/turso_history.py --list shows the chat id.
// First connect to Turso can take tens of seconds, so the archive poll is
// deliberately generous (5 s x 180 s). Frames go to
// tests/e2e_turso.frames.log. Final line: E2E_TURSO PASS/FAIL (+ reason).
import { createRequire } from 'node:module';
import { writeFileSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const PORT = 8787;
const LOG = new URL('./e2e_turso.frames.log', import.meta.url);
const TOOL = fileURLToPath(new URL('../tools/turso_history.py', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPLY_TIMEOUT_MS = 120000;
const ARCHIVE_POLL_MS = 5000;
const ARCHIVE_DEADLINE_MS = 180000;

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

// One streamed reply: answer deltas up to end/msg, plus the trailing msg.
async function collectReply(ws, chat, timeoutMs = REPLY_TIMEOUT_MS) {
  const deltas = [];
  let trailing = null;
  let errFrame = null;
  let endSeen = false;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = await ws.waitFor(
      (x) => x.chat === chat && ['evt', 'end', 'msg', 'error'].includes(x.t),
      timeoutMs, 'reply frame',
    ).catch(() => null);
    if (!f) break;
    if (f.t === 'evt') {
      if (!f.data || !f.data.stream_type || f.data.stream_type === 'message') {
        deltas.push((f.data && f.data.text) || '');
      }
    } else if (f.t === 'error') {
      errFrame = f; break;
    } else if (f.t === 'msg') {
      trailing = f; break;
    } else if (f.t === 'end') {
      if (f.stream_type && f.stream_type !== 'message') continue; // reasoning segment
      endSeen = true;
      const m = await ws.waitFor((x) => x.chat === chat && x.t === 'msg', 15000, 'trailing msg').catch(() => null);
      if (m) trailing = m;
      break;
    }
  }
  const trailingText = trailing && Array.isArray(trailing.parts)
    ? trailing.parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('')
    : null;
  const deltaText = deltas.join('');
  return {
    deltaFrames: deltas.length,
    endSeen,
    trailingText,
    // Trailing msg is authoritative (final full text); deltas are the fallback.
    replyText: trailingText !== null ? trailingText : deltaText,
    errFrame,
  };
}

function runTool(args) {
  return new Promise((resolve) => {
    execFile(
      'python3', [TOOL, ...args],
      { cwd: REPO_ROOT, timeout: 150000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

const firstLine = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';

async function main() {
  const stamp = Date.now();
  const chat = 'chat-turso-' + stamp.toString(36);
  const marker = 'TURSO-E2E-' + stamp.toString(36) + '-' + process.pid;
  const userText = 'Archive check ' + marker + ': please say hello.';
  console.log(`chat=${chat} marker=${marker}`);

  const ws = await connect();
  const ready = await ws.waitFor((f) => f.t === 'ready', 10000, 'ready');
  console.log(`ready agentOnline = ${ready.agentOnline}`);
  if (!ready.agentOnline) {
    console.log('E2E_TURSO FAIL: agent offline');
    process.exit(1);
  }

  // --- 1. real turn through the plugin ------------------------------------
  ws.send(JSON.stringify({ t: 'msg', chat, text: userText }));
  const reply = await collectReply(ws, chat, REPLY_TIMEOUT_MS);
  const replyOk = !reply.errFrame && reply.replyText.length > 0;
  verdict('reply-received', replyOk,
    reply.errFrame
      ? `error=${reply.errFrame.code}`
      : `evt=${reply.deltaFrames} end=${reply.endSeen} trailing=${reply.trailingText !== null} reply_len=${reply.replyText.length}`);

  // --- 2. poll the Turso archive for both rows ---------------------------
  const replyText = reply.replyText;
  let archiveOk = false;
  let archiveDetail = 'not polled (no reply text)';
  if (replyText.length > 0) {
    const p0 = Date.now();
    let attempt = 0;
    while (Date.now() - p0 < ARCHIVE_DEADLINE_MS) {
      attempt += 1;
      const res = await runTool(['--chat', chat]);
      const hasUser = res.stdout.includes(userText);
      const hasReply = res.stdout.includes(replyText);
      archiveDetail = `attempt=${attempt} exit=${res.code} user=${hasUser} reply=${hasReply} out_bytes=${res.stdout.length}`;
      if (res.code !== 0) archiveDetail += ` stderr=${firstLine(res.stderr)}`;
      if (res.code === 0 && hasUser && hasReply) { archiveOk = true; break; }
      if (Date.now() - p0 >= ARCHIVE_DEADLINE_MS) break;
      await sleep(ARCHIVE_POLL_MS);
    }
  }
  verdict('archive-chat-rows', archiveOk, archiveDetail);

  // --- 3. the chat shows up in --list ---------------------------------
  const list = await runTool(['--list']);
  const listOk = list.code === 0 && list.stdout.includes(chat);
  verdict('archive-list', listOk,
    `exit=${list.code} has_chat=${list.stdout.includes(chat)}` +
    (list.code === 0 ? '' : ` stderr=${firstLine(list.stderr)}`));

  ws.close();

  const mandatory = ['reply-received', 'archive-chat-rows', 'archive-list'];
  const failed = mandatory.filter((k) => !results[k]);
  if (failed.length === 0) {
    console.log('E2E_TURSO PASS');
  } else {
    console.log(`E2E_TURSO FAIL (${failed.join(', ')})`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E_TURSO ERROR', e);
  console.log('E2E_TURSO FAIL (harness error: ' + (e && e.message ? e.message : e) + ')');
  process.exit(2);
});
