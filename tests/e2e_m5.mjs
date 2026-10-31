// M5 end-to-end harness (coordinator test code, not product code).
// Runs against the externally running local stack: relay-node :8787 +
// local QwenPaw :8088 with the M5 plugin installed. Assertions per
// tasks/m5-brief.md:
//  N1. file_chunk without file_begin        -> file_error E_STATE.
//  N2. file_begin with size > 10 MB          -> file_error E_TOOBIG.
//  N3. wrong sha256 in file_begin            -> file_error E_CHECKSUM at end.
//  M1. ~600 KB deterministic file, chunked (96 KB raw/chunk, paced 40 ms)
//      -> file_ready; msg with files:[{ref}] -> the agent's reply arrives.
//  M2. The artifact the plugin uploaded into the console media dir has
//      the same sha256 as the source file (assertion route: snapshot the
//      media dir before/after; the plugin stores chunked files through
//      the same POST /api/console/upload path as v1 inline files).
// All frames logged to tests/out/e2e_m5.frames.log (EVIDENCE=1 writes the
// tracked tests/e2e_m5.frames.log). Final line: E2E_M5 PASS/FAIL.
import { createRequire } from 'node:module';
import { writeFileSync, appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { artifactFile } from './artifacts.mjs';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const PORT = 8787;
const LOG = artifactFile('e2e_m5.frames.log', process.env.LOG_FILE);
const MEDIA_DIR = '/home/hatch/workspace/qwenpaw-local/home/workspaces/default/media';
const CHUNK = 96 * 1024;
const CHAT = 'm5xfer';
writeFileSync(LOG, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
function verdict(name, ok, detail) {
  results[name] = ok;
  console.log(`ASSERT ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail || ''}`);
}

// Deterministic ~600 KiB payload (mulberry32 PRNG, fixed seed).
function deterministicBytes(n) {
  let a = 0x5eed1234 >>> 0;
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    buf[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return buf;
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client`);
    const frames = [];
    const waiters = [];
    ws._idx = 0; // consumption cursor (same pattern as e2e_m2)
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

function sendChunks(ws, id, buf) {
  const n = Math.ceil(buf.length / CHUNK);
  return (async () => {
    for (let i = 0; i < n; i++) {
      const part = buf.subarray(i * CHUNK, (i + 1) * CHUNK);
      ws.send(JSON.stringify({ t: 'file_chunk', chat: CHAT, id, i, data: part.toString('base64') }));
      if (i < n - 1) await sleep(40); // pace like the SPA (CF relay: 30 fps/tenant)
    }
    return n;
  })();
}

async function expectFileError(ws, id, code, label) {
  const f = await ws.waitFor(
    (x) => x.t === 'file_error' && x.id === id, 30000, label,
  ).catch(() => null);
  return f && f.code === code ? f : null;
}

async function main() {
  const mediaBefore = new Set(readdirSync(MEDIA_DIR));
  const data = deterministicBytes(600 * 1024);
  const digest = sha256(data);
  const chunks = Math.ceil(data.length / CHUNK);
  console.log(`source: ${data.length} bytes, ${chunks} chunks, sha256=${digest}`);

  const ws = await connect();
  await ws.waitFor((x) => x.t === 'ready', 10000, 'ready');
  console.log(`ready agentOnline = ${ws.frames[0]?.agentOnline}`);

  // N1: chunk without begin -> E_STATE
  ws.send(JSON.stringify({ t: 'file_chunk', chat: CHAT, id: 'm5-bad-state', i: 0, data: Buffer.from('x').toString('base64') }));
  const n1 = await expectFileError(ws, 'm5-bad-state', 'E_STATE', 'N1 file_error');
  verdict('N1-chunk-without-begin', !!n1, n1 ? `code=${n1.code}` : 'no file_error');

  // N2: begin over 10 MB -> E_TOOBIG
  ws.send(JSON.stringify({ t: 'file_begin', chat: CHAT, id: 'm5-too-big', name: 'big.bin', mime: 'application/octet-stream', size: 10 * 1024 * 1024 + 1, chunks: 108, sha256: digest }));
  const n2 = await expectFileError(ws, 'm5-too-big', 'E_TOOBIG', 'N2 file_error');
  verdict('N2-begin-too-big', !!n2, n2 ? `code=${n2.code}` : 'no file_error');

  // N3: declared sha256 does not match content -> E_CHECKSUM at file_end
  const badId = 'm5-bad-sha';
  ws.send(JSON.stringify({ t: 'file_begin', chat: CHAT, id: badId, name: 'bad.bin', mime: 'application/octet-stream', size: data.length, chunks, sha256: sha256(Buffer.from('other content')) }));
  await sendChunks(ws, badId, data);
  ws.send(JSON.stringify({ t: 'file_end', chat: CHAT, id: badId }));
  const n3 = await expectFileError(ws, badId, 'E_CHECKSUM', 'N3 file_error');
  verdict('N3-sha-mismatch', !!n3, n3 ? `code=${n3.code}` : 'no file_error');

  // M1: the real transfer -> file_ready
  const id = 'm5-good';
  ws.send(JSON.stringify({ t: 'file_begin', chat: CHAT, id, name: 'm5.bin', mime: 'application/octet-stream', size: data.length, chunks, sha256: digest }));
  await sendChunks(ws, id, data);
  ws.send(JSON.stringify({ t: 'file_end', chat: CHAT, id }));
  const ready = await ws.waitFor((x) => x.t === 'file_ready' && x.id === id, 30000, 'file_ready').catch(() => null);
  verdict('M1-file-ready', !!ready, ready ? `id=${ready.id}` : 'no file_ready');

  // M1b: reference the staged file in a msg; the agent's reply must arrive.
  let replyText = null; let errFrame = null;
  if (ready) {
    ws.send(JSON.stringify({ t: 'msg', chat: CHAT, text: 'I attached a file named m5.bin. Reply with the single word RECEIVED.', files: [{ ref: id }] }));
    const t0 = Date.now();
    while (Date.now() - t0 < 150000 && replyText === null && !errFrame) {
      const f = await ws.waitFor(
        (x) => x.chat === CHAT && ['evt', 'end', 'msg', 'error'].includes(x.t), 150000, 'reply frame',
      ).catch(() => null);
      if (!f) break;
      if (f.t === 'error') { errFrame = f; break; }
      if (f.t === 'msg') {
        const parts = Array.isArray(f.parts) ? f.parts : [];
        replyText = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
      }
    }
  }
  verdict('M1b-agent-reply', replyText !== null && !errFrame,
    errFrame ? `error=${JSON.stringify(errFrame)}` : `reply_len=${replyText ? replyText.length : 0}`);

  // M2: the uploaded artifact in the console media dir matches the source hash.
  let artifactOk = false; let artifactInfo = 'no new artifact';
  if (ready) {
    for (let attempt = 0; attempt < 20 && !artifactOk; attempt++) {
      const fresh = readdirSync(MEDIA_DIR).filter((name) => !mediaBefore.has(name));
      for (const name of fresh) {
        const path = join(MEDIA_DIR, name);
        try {
          if (statSync(path).size !== data.length) continue;
          const h = sha256(readFileSync(path));
          artifactInfo = `${name} sha256_match=${h === digest}`;
          if (h === digest) { artifactOk = true; break; }
        } catch { /* partial write; retry */ }
      }
      if (!artifactOk) await sleep(1000);
    }
  }
  verdict('M2-artifact-sha256', artifactOk, artifactInfo);

  ws.close();
  const mandatory = ['N1-chunk-without-begin', 'N2-begin-too-big', 'N3-sha-mismatch', 'M1-file-ready', 'M1b-agent-reply', 'M2-artifact-sha256'];
  const pass = mandatory.every((k) => results[k]);
  console.log(`E2E_M5 ${pass ? 'PASS' : 'FAIL'} (mandatory assertions)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('E2E_M5 ERROR', e); process.exit(2); });
