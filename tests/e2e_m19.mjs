#!/usr/bin/env node
/**
 * M19 — SPA polish pack E2E (items 1–4, 6; item 5 is asserted alongside the
 * meter) plus the M22 SPA experience pack (dark theme, highlighting,
 * paste-to-attach, per-chat drafts, prompt library). Runs entirely local
 * against a production build:
 *
 *   1. `npm run build` in spa/ (fails the run if the build fails)
 *   2. relay-node on :8787 (the build's baked-in local relay URL)
 *   3. an in-process mock agent that speaks the frames the SPA needs
 *      (chats / hist / models / skills / usage / effort / msg streaming)
 *   4. `vite preview` on :4173 serving spa/dist
 *
 * Two passes share the same server: desktop 1280x900 and iPhone 13
 * (390x844, the M14 mobile spec). Screenshots land in ./m19-shots/.
 *
 * Re-run (from the repo root):
 *   cd tests && npm install && npx playwright install chromium
 *   node e2e_m19.mjs
 *
 * Environment variables (all optional):
 *   M19_PREVIEW_PORT   preview port; default 4173
 *   M19_RELAY_PORT     relay port; default 8787 (must match the build)
 *   M19_SKIP_BUILD=1   reuse the existing spa/dist
 *   M19_HEADED=1       visible browser
 *   OUT_DIR            screenshot directory; default ./m19-shots
 *
 * The process exits 1 on the first failing check summary; every check is
 * collected and printed so one run reports the whole pack.
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPA_DIR = join(ROOT, 'spa');
const RELAY_DIR = join(ROOT, 'relay-node');
const OUT_DIR = resolve(HERE, process.env.OUT_DIR || './m19-shots');
const PREVIEW_PORT = Number(process.env.M19_PREVIEW_PORT || 4173);
const RELAY_PORT = Number(process.env.M19_RELAY_PORT || 8787);
const BASE = `http://127.0.0.1:${PREVIEW_PORT}/`;
const HEADED = process.env.M19_HEADED === '1';

const require = createRequire(join(ROOT, 'mock', 'package.json'));
const WebSocket = require('ws');

mkdirSync(OUT_DIR, { recursive: true });
const log = (...args) => console.log('[m19-e2e]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const shot = (pass, name) => join(OUT_DIR, `m19-${pass}-${name}.png`);

// ---------------------------------------------------------------------------
// Mock agent data
// ---------------------------------------------------------------------------

const CODE = 'def add(a, b):\n    return a + b\n\nprint(add(1, 2))';
const FILLER = Array.from(
  { length: 30 },
  (_, i) => `第 ${i + 1} 段填充文本，用来把消息列表撑得比视口更高，方便验证滚动按钮。`,
).join('\n\n');

const HISTORY = [
  { role: 'user', text: '给我一段 Python 代码' },
  {
    role: 'assistant',
    text: `这是示例：\n\n\`\`\`python\n${CODE}\n\`\`\`\n\n${FILLER}`,
    turn: { id: 'turn-1', input: 1200, output: 340 },
  },
];

/** The streamed reply: long enough to scroll away from while it arrives. */
const STREAM_TEXT = [
  '这是流式回答。',
  '下面先给一段 JavaScript：',
  '```js',
  'const a = 1;',
  'const b = 2;',
  'console.log(a + b);',
  '```',
  '然后再补充一些说明文字，',
  '让流式输出持续得久一点，',
  '好让测试在输出过程中向上滚动。',
  '重复若干遍：',
  ...Array.from({ length: 22 }, (_, i) => `第 ${i + 1} 行补充说明，用来填满视口并延长输出时间。`),
].join('\n\n');

/**
 * One mock container agent. `state` is mutable per scenario so a test can
 * change what the "server" reports between page loads.
 */
const state = {
  chats: [],
  history: {},
  usage: {},
  streaming: new Map(),
};

function resetState() {
  state.chats = [
    { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
    { chat: 'chat-beta', title: 'Beta 会话', updated_at: '2026-10-27T09:00:00Z' },
  ];
  state.history = { 'chat-alpha': HISTORY, 'chat-beta': [] };
  state.usage = {
    'chat-alpha': {
      input_total: 12345,
      output_total: 678,
      context_tokens: 4321,
      context_limit: 32768,
    },
    'chat-beta': { input_total: 300, output_total: 42, context_tokens: 900, context_limit: 32768 },
  };
  for (const timer of state.streaming.values()) clearInterval(timer);
  state.streaming.clear();
}

let agent = null;
let seq = 0;
const agentSend = (frame) => {
  if (agent && agent.readyState === 1) agent.send(JSON.stringify(frame));
};

function streamReply(chat) {
  const previous = state.streaming.get(chat);
  if (previous) clearInterval(previous);
  // ~10 chars per frame: the SPA re-renders often enough to catch duplicates,
  // and the whole reply lasts ~4 s so a scroll-up happens mid-stream.
  const chunks = [];
  for (let at = 0; at < STREAM_TEXT.length; at += 10) {
    chunks.push(STREAM_TEXT.slice(at, at + 10));
  }
  agentSend({ t: 'start', chat, seq: seq++ });
  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) {
      agentSend({
        t: 'evt',
        chat,
        seq: seq++,
        data: { text: chunks[index], stream_type: 'message' },
      });
      index += 1;
      return;
    }
    clearInterval(timer);
    state.streaming.delete(chat);
    agentSend({ t: 'end', chat, seq: seq++ });
    agentSend({ t: 'msg', chat, seq: seq++, parts: [{ type: 'text', text: STREAM_TEXT }] });
  }, 45);
  state.streaming.set(chat, timer);
}

function handleAgentFrame(frame) {
  switch (frame.t) {
    case 'chats':
      agentSend({ t: 'chats', items: state.chats });
      break;
    case 'models':
      agentSend({
        t: 'models',
        items: [{ provider: 'mock', model: 'mock-1', active: true }],
      });
      break;
    case 'skills':
      agentSend({ t: 'skills', items: [] });
      break;
    case 'hist': {
      const chat = String(frame.chat || '');
      agentSend({ t: 'hist', chat, messages: state.history[chat] || [] });
      break;
    }
    case 'get_usage': {
      const chat = String(frame.chat || '');
      agentSend({ t: 'usage', chat, ...(state.usage[chat] || {}) });
      break;
    }
    case 'get_effort':
      agentSend({
        t: 'effort',
        chat: String(frame.chat || ''),
        level: 'default',
        effective: 'default',
      });
      break;
    case 'set_effort':
      agentSend({
        t: 'effort',
        chat: String(frame.chat || ''),
        level: frame.level || 'default',
        effective: frame.level || 'default',
      });
      break;
    case 'msg':
      streamReply(String(frame.chat || ''));
      break;
    case 'stop': {
      const chat = String(frame.chat || '');
      const timer = state.streaming.get(chat);
      if (timer) {
        clearInterval(timer);
        state.streaming.delete(chat);
        agentSend({ t: 'end', chat, seq: seq++ });
      }
      break;
    }
    case 'del_chat':
      agentSend({ t: 'chat_deleted', chat: String(frame.chat || '') });
      break;
    case 'rename_chat':
      agentSend({
        t: 'chat_renamed',
        chat: String(frame.chat || ''),
        title: String(frame.title || ''),
      });
      break;
    default:
      break;
  }
}

function connectAgent() {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/agent`, {
      headers: { Authorization: 'Bearer dev-agent-token' },
    });
    const timer = setTimeout(() => rejectP(new Error('mock agent connect timeout')), 8000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ t: 'hello', started: Date.now(), session: 'm19-mock' }));
      agent = ws;
      resolveP();
    });
    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.t === 'ready' || frame.t === 'peer' || frame.t === 'pong' || frame.t === 'hb_ack') {
        return;
      }
      handleAgentFrame(frame);
    });
    ws.on('error', (err) => rejectP(err));
  });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const children = [];
function run(cmd, args, cwd) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('exit', (code) =>
      code === 0 ? resolveP(out) : rejectP(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`)),
    );
    child.on('error', rejectP);
  });
}

function background(cmd, args, cwd, label) {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      log(`[${label}] exited ${code}\n${out.slice(0, 4000)}`);
    }
  });
  children.push(child);
  return child;
}

async function waitHttp(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  throw new Error(`${label} did not answer at ${url}`);
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function waitForHistory(page) {
  await page.waitForSelector('.md pre .pre-copy', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.row').length >= 2, null, {
    timeout: 20000,
  });
}

async function pinCount(page) {
  return page.evaluate(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('webchannel.pinnedChats') || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  });
}

async function activateSearch(page) {
  await page.keyboard.press('Control+K');
  await sleep(120);
  return page.evaluate(() => ({
    active: document.activeElement ? document.activeElement.className : '',
    tag: document.activeElement ? document.activeElement.tagName : '',
    drawer: Boolean(document.querySelector('.app.sidebar-open')),
  }));
}

// ---------------------------------------------------------------------------
// M22 helpers (theme / paste / drafts / prompt library)
// ---------------------------------------------------------------------------

/** Same audit as tests/mobile_e2e.mjs: every visible action needs 44x44. */
const TAP_TARGET_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"], summary, a')) {
    if (el.classList && el.classList.contains('context-meter')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    if (r.width < 44 || r.height < 44) {
      out.push({
        cls: el.className && typeof el.className === 'string' ? el.className : el.tagName,
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
      });
    }
  }
  return out;
})()`;

async function readTheme(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme || '',
    stored: localStorage.getItem('webchannel.theme'),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content || '',
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));
}

async function toggleThemeUi(page, mobile) {
  if (mobile) {
    await page.locator('.top-more-btn').click();
    await sleep(150);
    await page.locator('.top-menu button[aria-label^="切换到"]').click();
  } else {
    await page.locator('.top-secondary .icon-btn[aria-label="切换主题"]').click();
  }
  await sleep(300);
}

async function openChat(page, mobile, id) {
  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(320);
  }
  await page.locator('.chat-item', { hasText: id }).first().locator('.chat-title').click();
  await sleep(300);
}

/**
 * Dispatch a synthetic paste. A file lands as a real File in clipboardData
 * (the same path the picker/drop uses); text-only pastes carry no file.
 */
async function pastePayload(page, payload) {
  return page.evaluate((data) => {
    const textarea = document.querySelector('.composer textarea');
    if (!textarea) return { notPrevented: null };
    const dt = new DataTransfer();
    if (data.fileName) {
      const bytes = new Uint8Array(data.size || 0);
      if (data.head) bytes.set(data.head);
      dt.items.add(new File([bytes], data.fileName, { type: data.mime || 'application/octet-stream' }));
    } else {
      dt.setData('text/plain', data.text || '');
    }
    const event = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    return { notPrevented: textarea.dispatchEvent(event) };
  }, payload);
}

async function readJsonKey(page, key) {
  return page.evaluate((name) => {
    try {
      const value = JSON.parse(localStorage.getItem(name) || 'null');
      return value;
    } catch {
      return null;
    }
  }, key);
}

// ---------------------------------------------------------------------------
// M22 — SPA experience pack
// ---------------------------------------------------------------------------

async function runM22Checks(page, pass, mobile) {
  // A known two-chat world, beta pinned, and no M22 storage from earlier tests.
  resetState();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha', 'chat-beta']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.pinnedChats', '["chat-beta"]');
    localStorage.removeItem('webchannel.drafts');
    localStorage.removeItem('webchannel.promptLibrary');
    localStorage.removeItem('webchannel.theme');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(400);

  if (mobile) {
    const lightAudit = await page.evaluate(TAP_TARGET_SCRIPT);
    check(
      `${pass}: M22 light tap targets stay 44px`,
      lightAudit.length === 0,
      JSON.stringify(lightAudit.slice(0, 4)),
    );
  }

  // ---- M22.1: highlighting + language label -----------------------------
  const highlight = await page.evaluate(() => {
    const pre = document.querySelector('.md pre');
    return {
      pres: document.querySelectorAll('.md pre').length,
      labels: document.querySelectorAll('.md pre .pre-lang').length,
      copies: document.querySelectorAll('.md pre .pre-copy').length,
      label: pre ? ((pre.querySelector('.pre-lang') || {}).textContent || '').trim() : '',
      tokens: pre
        ? pre.querySelectorAll('code [class^="hljs-"], code [class*=" hljs-"]').length
        : 0,
    };
  });
  check(
    `${pass}: M22 fenced code is syntax-highlighted`,
    highlight.tokens > 0,
    JSON.stringify(highlight),
  );
  check(
    `${pass}: M22 language label matches the fence`,
    highlight.label === 'python' && highlight.labels === highlight.pres,
    JSON.stringify(highlight),
  );
  check(
    `${pass}: M22 one language label and copy button per block`,
    highlight.labels === highlight.pres && highlight.copies === highlight.pres,
    JSON.stringify(highlight),
  );

  // ---- M22.3: paste-to-attach -------------------------------------------
  await page.locator('.composer textarea').fill('');
  const filePaste = await pastePayload(page, {
    size: 4,
    head: [137, 80, 78, 71],
    fileName: 'pasted.png',
    mime: 'image/png',
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.composer .chip')].some((el) =>
        (el.textContent || '').includes('pasted.png'),
      ),
    null,
    { timeout: 5000 },
  );
  const pastedChip = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.composer .chip')].find((el) =>
      (el.textContent || '').includes('pasted.png'),
    );
    return {
      chip: Boolean(chip),
      cls: chip ? chip.className : '',
      note: chip && chip.nextElementSibling ? (chip.nextElementSibling.textContent || '').trim() : '',
      sendDisabled: document.querySelector('.send') ? document.querySelector('.send').disabled : null,
    };
  });
  check(
    `${pass}: M22 pasted file attaches through the composer`,
    filePaste.notPrevented === false && pastedChip.chip && /已就绪/.test(pastedChip.note),
    JSON.stringify({ filePaste, ...pastedChip }),
  );
  check(
    `${pass}: M22 pasted attachment is sendable`,
    pastedChip.sendDisabled === false,
    JSON.stringify(pastedChip),
  );

  const textPaste = await pastePayload(page, { text: '这是一段纯文本粘贴' });
  await sleep(200);
  const textPasteState = await page.evaluate(() => ({
    chips: document.querySelectorAll('.composer .chip').length,
    value: document.querySelector('.composer textarea').value,
  }));
  check(
    `${pass}: M22 text paste stays plain text`,
    textPaste.notPrevented === true && textPasteState.chips === 1 && textPasteState.value === '',
    JSON.stringify({ textPaste, ...textPasteState }),
  );

  await page.locator('.composer .chip-x').click();
  await sleep(150);

  const bigPaste = await pastePayload(page, {
    size: 10 * 1024 * 1024 + 1,
    fileName: 'huge.bin',
    mime: 'application/octet-stream',
  });
  await page.waitForFunction(
    () => /附件太大/.test((document.querySelector('.composer-error') || {}).textContent || ''),
    null,
    { timeout: 8000 },
  );
  const oversize = await page.evaluate(() => ({
    error: (document.querySelector('.composer-error') || {}).textContent || '',
    chips: document.querySelectorAll('.composer .chip').length,
  }));
  check(
    `${pass}: M22 oversized paste hits the 10MB rule`,
    bigPaste.notPrevented === false && /10MB/.test(oversize.error) && oversize.chips === 0,
    JSON.stringify({ bigPaste, ...oversize }),
  );

  await page.locator('input[type=file]').setInputFiles({
    name: 'picked.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.composer .chip')].some((el) =>
        (el.textContent || '').includes('picked.png'),
      ),
    null,
    { timeout: 5000 },
  );
  const pickedChip = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.composer .chip')].find((el) =>
      (el.textContent || '').includes('picked.png'),
    );
    return {
      cls: chip ? chip.className : '',
      note: chip && chip.nextElementSibling ? (chip.nextElementSibling.textContent || '').trim() : '',
      error: (document.querySelector('.composer-error') || {}).textContent || '',
    };
  });
  check(
    `${pass}: M22 picker and paste share the same chip UI`,
    pickedChip.cls === pastedChip.cls && /已就绪/.test(pickedChip.note) && pickedChip.error === '',
    JSON.stringify({ pastedChip, pickedChip }),
  );
  await page.locator('.composer .chip-x').click();
  await sleep(150);

  // ---- M22.4: per-chat drafts -------------------------------------------
  const alphaDraft = 'alpha 未发送草稿';
  const betaDraft = 'beta 未发送草稿';
  await page.locator('.composer textarea').fill(alphaDraft);
  const draftsAfterAlpha = await readJsonKey(page, 'webchannel.drafts');
  check(
    `${pass}: M22 composer text is stored per chat`,
    draftsAfterAlpha && draftsAfterAlpha['chat-alpha'] === alphaDraft,
    JSON.stringify(draftsAfterAlpha),
  );

  await openChat(page, mobile, 'chat-beta');
  const betaEmpty = await page.evaluate(() => ({
    value: document.querySelector('.composer textarea').value,
    drafts: (() => {
      try {
        return JSON.parse(localStorage.getItem('webchannel.drafts') || '{}');
      } catch {
        return {};
      }
    })(),
  }));
  check(
    `${pass}: M22 switching chats never leaks a draft`,
    betaEmpty.value === '' && !('chat-beta' in betaEmpty.drafts),
    JSON.stringify(betaEmpty),
  );

  await page.locator('.composer textarea').fill(betaDraft);
  const bothDrafts = await readJsonKey(page, 'webchannel.drafts');
  check(
    `${pass}: M22 each chat keeps its own draft`,
    bothDrafts &&
      bothDrafts['chat-alpha'] === alphaDraft &&
      bothDrafts['chat-beta'] === betaDraft,
    JSON.stringify(bothDrafts),
  );

  await openChat(page, mobile, 'chat-alpha');
  const backToAlpha = await page.evaluate(
    () => document.querySelector('.composer textarea').value,
  );
  check(`${pass}: M22 switching back restores the draft`, backToAlpha === alphaDraft, backToAlpha);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(350);
  const reloadedDraft = await page.evaluate(() => ({
    value: document.querySelector('.composer textarea').value,
    active: (document.querySelector('.chat-item.active .chat-id') || {}).textContent || '',
  }));
  check(
    `${pass}: M22 drafts survive a reload`,
    reloadedDraft.value === alphaDraft && reloadedDraft.active === 'chat-alpha',
    JSON.stringify(reloadedDraft),
  );

  await page.locator('.composer textarea').press('Enter');
  await page.waitForFunction(
    () => {
      const area = document.querySelector('.composer textarea');
      return (
        area &&
        area.value === '' &&
        [...document.querySelectorAll('.row.user .plain')].some((el) =>
          (el.textContent || '').includes('alpha 未发送草稿'),
        )
      );
    },
    null,
    { timeout: 8000 },
  );
  await page.waitForSelector('.stop', { timeout: 5000 }).catch(() => {});
  if (await page.locator('.stop').count()) {
    await page.locator('.stop').click();
    await sleep(400);
  }
  const afterSend = await readJsonKey(page, 'webchannel.drafts');
  const sentState = await page.evaluate(() => ({
    value: document.querySelector('.composer textarea').value,
  }));
  check(
    `${pass}: M22 a successful send clears only that chat's draft`,
    afterSend && !('chat-alpha' in afterSend) && afterSend['chat-beta'] === betaDraft,
    JSON.stringify(afterSend),
  );
  check(
    `${pass}: M22 the sent draft leaves the composer`,
    sentState.value === '',
    JSON.stringify(sentState),
  );

  await openChat(page, mobile, 'chat-beta');
  const betaRestored = await page.evaluate(
    () => document.querySelector('.composer textarea').value,
  );
  check(
    `${pass}: M22 the other chat's draft still restores`,
    betaRestored === betaDraft,
    betaRestored,
  );
  await openChat(page, mobile, 'chat-alpha');

  // ---- M22.5: prompt library --------------------------------------------
  const PROMPT = '请用费曼法解释量子隧穿，并给出一个生活类比';
  await page.locator('.composer textarea').fill(PROMPT);
  await page.locator('.prompt-lib-btn').click();
  await page.waitForSelector('.prompt-lib', { timeout: 4000 });
  const opened = await page.evaluate(() => ({
    name: (document.querySelector('.prompt-save input') || {}).value || '',
    saveDisabled: document.querySelector('.prompt-save-btn')
      ? document.querySelector('.prompt-save-btn').disabled
      : null,
  }));
  check(
    `${pass}: M22 the library prefills a name from the composer`,
    opened.name === PROMPT && opened.saveDisabled === false,
    JSON.stringify(opened),
  );

  await page.locator('.prompt-save input').fill('隧穿解释');
  await page.locator('.prompt-save-btn').click();
  await sleep(250);
  const saved = await page.evaluate(() => {
    const row = document.querySelector('.prompt-row');
    return {
      count: document.querySelectorAll('.prompt-row').length,
      name: row ? (row.querySelector('.prompt-name') || {}).textContent || '' : '',
      status: (document.querySelector('.prompt-lib-status') || {}).textContent || '',
      stored: localStorage.getItem('webchannel.promptLibrary'),
    };
  });
  check(
    `${pass}: M22 saving the composer text adds a named prompt`,
    saved.count === 1 && saved.name === '隧穿解释' && /已保存/.test(saved.status),
    JSON.stringify(saved),
  );
  const storedPrompts = await readJsonKey(page, 'webchannel.promptLibrary');
  check(
    `${pass}: M22 the prompt library persists entries`,
    Array.isArray(storedPrompts) &&
      storedPrompts.length === 1 &&
      storedPrompts[0].name === '隧穿解释' &&
      storedPrompts[0].text === PROMPT,
    JSON.stringify(storedPrompts),
  );

  await page.locator('.composer textarea').fill('');
  await page.locator('.prompt-main').click();
  await sleep(250);
  const inserted = await page.evaluate(() => document.querySelector('.composer textarea').value);
  check(
    `${pass}: M22 clicking a prompt inserts it into the composer`,
    inserted === PROMPT &&
      (await page.evaluate(() => document.querySelectorAll('.prompt-lib').length)) === 0,
    inserted,
  );

  await page.locator('.prompt-lib-btn').click();
  await page.waitForSelector('.prompt-lib', { timeout: 4000 });
  await page.locator('.prompt-act[aria-label="重命名提示词"]').click();
  await page.locator('.prompt-rename').fill('隧穿讲解');
  await page.locator('.prompt-rename').press('Enter');
  await sleep(250);
  const renamed = await page.evaluate(() => ({
    name: (document.querySelector('.prompt-name') || {}).textContent || '',
    stored: localStorage.getItem('webchannel.promptLibrary'),
  }));
  check(
    `${pass}: M22 renaming updates the row and storage`,
    renamed.name === '隧穿讲解' && /隧穿讲解/.test(renamed.stored || ''),
    JSON.stringify(renamed),
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(350);
  await page.locator('.prompt-lib-btn').click();
  await page.waitForSelector('.prompt-lib', { timeout: 4000 });
  const promptAfterReload = await page.evaluate(() => ({
    count: document.querySelectorAll('.prompt-row').length,
    name: (document.querySelector('.prompt-name') || {}).textContent || '',
  }));
  check(
    `${pass}: M22 prompts survive a reload`,
    promptAfterReload.count === 1 && promptAfterReload.name === '隧穿讲解',
    JSON.stringify(promptAfterReload),
  );

  await page.locator('.prompt-act[aria-label="删除提示词"]').click();
  await sleep(250);
  const deleted = await page.evaluate(() => ({
    rows: document.querySelectorAll('.prompt-row').length,
    empty: Boolean(document.querySelector('.prompt-lib-empty')),
    stored: localStorage.getItem('webchannel.promptLibrary'),
  }));
  check(
    `${pass}: M22 deleting removes the entry`,
    deleted.rows === 0 && deleted.empty && deleted.stored === '[]',
    JSON.stringify(deleted),
  );
  // Keep one entry: the dark-mode screenshot/audit below exercises a real row.
  await page.locator('.prompt-save input').fill('示例提示词');
  await page.locator('.prompt-save-btn').click();
  await sleep(250);
  await page.keyboard.press('Escape');
  await sleep(150);

  // ---- M22.1: theme default, toggle, persistence ------------------------
  await page.evaluate(() => localStorage.removeItem('webchannel.theme'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(300);
  const osDark = await readTheme(page);
  check(
    `${pass}: M22 dark follows prefers-color-scheme`,
    osDark.theme === 'dark' && osDark.meta === '#0a0b0e' && osDark.colorScheme === 'dark',
    JSON.stringify(osDark),
  );

  await page.evaluate(() => localStorage.removeItem('webchannel.theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(300);
  const osLight = await readTheme(page);
  check(
    `${pass}: M22 light follows prefers-color-scheme`,
    osLight.theme === 'light' && osLight.meta === '#faf8f4' && osLight.colorScheme === 'light',
    JSON.stringify(osLight),
  );

  await toggleThemeUi(page, mobile);
  const toggled = await readTheme(page);
  check(
    `${pass}: M22 the toggle switches and stores dark`,
    toggled.theme === 'dark' && toggled.stored === 'dark' && toggled.meta === '#0a0b0e',
    JSON.stringify(toggled),
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(300);
  const persistedTheme = await readTheme(page);
  check(
    `${pass}: M22 the theme choice survives a reload`,
    persistedTheme.theme === 'dark' &&
      persistedTheme.stored === 'dark' &&
      persistedTheme.meta === '#0a0b0e',
    JSON.stringify(persistedTheme),
  );

  // Dark screenshots: code block, meter/composer, 置顶 group, toast.
  await page.evaluate(() => {
    const pre = document.querySelector('.md pre');
    if (pre) pre.scrollIntoView({ block: 'center' });
  });
  await sleep(250);
  await page.screenshot({ path: shot(pass, 'm22-dark-code'), fullPage: false });

  // M22.2: the 44 px target is theme-independent — prove it in dark too.
  if (mobile) {
    const darkCopy = await page.evaluate(() => {
      const btn = document.querySelector('.md pre .pre-copy');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return {
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        theme: document.documentElement.dataset.theme || '',
      };
    });
    check(
      `${pass}: M22 dark copy button stays a 44px target`,
      Boolean(darkCopy && darkCopy.w >= 44 && darkCopy.h >= 44 && darkCopy.theme === 'dark'),
      JSON.stringify(darkCopy),
    );
  }

  await page.evaluate(() => {
    const list = document.querySelector('.messages');
    if (list) list.scrollTop = list.scrollHeight;
  });
  await sleep(250);
  await page.screenshot({ path: shot(pass, 'm22-dark-meter'), fullPage: false });

  if (mobile) {
    await page.locator('.hamburger').click();
    await sleep(350);
  }
  const pinnedInDark = await page.evaluate(() => ({
    label: (document.querySelector('.chat-group-label') || {}).textContent || '',
    first: (document.querySelector('.chat-item .chat-id') || {}).textContent || '',
  }));
  check(
    `${pass}: M22 the 置顶 group renders in dark`,
    pinnedInDark.label.trim() === '置顶' && pinnedInDark.first === 'chat-beta',
    JSON.stringify(pinnedInDark),
  );
  await page.screenshot({ path: shot(pass, 'm22-dark-pins'), fullPage: false });

  if (mobile) {
    await page.locator('.sidebar-close').click();
    await sleep(300);
    const closedAudit = await page.evaluate(TAP_TARGET_SCRIPT);
    check(
      `${pass}: M22 dark tap targets stay 44px (composer)`,
      closedAudit.length === 0,
      JSON.stringify(closedAudit.slice(0, 4)),
    );
  }

  await page.locator('.prompt-lib-btn').click();
  await page.waitForSelector('.prompt-lib', { timeout: 4000 });
  await sleep(250);
  await page.screenshot({ path: shot(pass, 'm22-dark-library'), fullPage: false });
  if (mobile) {
    const openAudit = await page.evaluate(TAP_TARGET_SCRIPT);
    check(
      `${pass}: M22 dark tap targets stay 44px (prompt library)`,
      openAudit.length === 0,
      JSON.stringify(openAudit.slice(0, 4)),
    );
  }
  await page.keyboard.press('Escape');
  await sleep(150);

  await page.evaluate(() => {
    localStorage.setItem(
      'webchannel.chats',
      JSON.stringify(['chat-gone', 'chat-alpha', 'chat-beta']),
    );
    localStorage.setItem('webchannel.activeChat', 'chat-gone');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.toast', { timeout: 8000 });
  await sleep(300);
  const toastDark = await page.evaluate(() => ({
    text: (document.querySelector('.toast') || {}).textContent || '',
    theme: document.documentElement.dataset.theme || '',
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content || '',
  }));
  check(
    `${pass}: M22 the toast renders in dark and the theme survives`,
    /已不在服务器列表中/.test(toastDark.text) &&
      toastDark.theme === 'dark' &&
      toastDark.meta === '#0a0b0e',
    JSON.stringify(toastDark),
  );
  await page.screenshot({ path: shot(pass, 'm22-dark-toast'), fullPage: false });
  await page.emulateMedia({ colorScheme: null });
}

// ---------------------------------------------------------------------------
// One pass (desktop or mobile)
// ---------------------------------------------------------------------------

async function runPass(browser, pass, viewport, mobile) {
  resetState();
  const contextOptions = mobile
    ? { ...devices['iPhone 13'] }
    : {
        viewport,
        screen: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      };
  const context = await browser.newContext({ ...contextOptions, locale: 'zh-CN' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: BASE.replace(/\/$/, ''),
  });
  await context.addInitScript(() => {
    if (localStorage.getItem('m19.seeded')) return;
    localStorage.setItem('m19.seeded', '1');
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha', 'chat-beta']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.chatNames', '{}');
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const openDrawer = async () => {
    if (!mobile) return;
    if (await page.locator('.app.sidebar-open').count()) return;
    await page.locator('.hamburger').click();
    await sleep(350);
  };

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForHistory(page);
    await sleep(400);

    // ---- 1. code-block copy button ---------------------------------------
    const copyInfo = await page.evaluate(() => {
      const pre = document.querySelector('.md pre');
      const btn = pre ? pre.querySelector('.pre-copy') : null;
      if (!pre || !btn) return null;
      const p = pre.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        label: (btn.textContent || '').trim(),
        pres: document.querySelectorAll('.md pre').length,
        copies: document.querySelectorAll('.md pre .pre-copy').length,
        langs: document.querySelectorAll('.md pre .pre-lang').length,
        rightAligned: b.right <= p.right + 0.5 && b.right > p.left + p.width / 2,
        topAligned: b.top >= p.top - 0.5 && b.top < p.top + p.height / 2,
        visible: b.width > 0 && b.height > 0,
      };
    });
    check(`${pass}: code block has a copy button`, Boolean(copyInfo && copyInfo.visible), JSON.stringify(copyInfo));
    check(`${pass}: copy button sits at the block's top-right`, Boolean(copyInfo && copyInfo.rightAligned && copyInfo.topAligned));
    check(`${pass}: one button per code block`, Boolean(copyInfo && copyInfo.pres === copyInfo.copies && copyInfo.langs === copyInfo.copies), copyInfo ? `${copyInfo.copies}/${copyInfo.pres}` : '');
    check(`${pass}: copy button is labelled 复制`, Boolean(copyInfo && copyInfo.label === '复制'), copyInfo ? copyInfo.label : '');

    await page.locator('.md pre .pre-copy').first().click();
    await sleep(150);
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('.md pre .pre-copy');
      return {
        label: btn ? (btn.textContent || '').trim() : '',
        copied: btn ? btn.classList.contains('copied') : false,
      };
    });
    check(`${pass}: click shows 已复制`, clicked.label === '已复制', clicked.label);
    await page.screenshot({ path: shot(pass, 'code-copied'), fullPage: false });
    let clip = '';
    let clipReadable = true;
    try {
      clip = await page.evaluate(() => navigator.clipboard.readText());
    } catch (err) {
      clipReadable = false;
      log(`${pass}: clipboard read unavailable — ${err.message}`);
    }
    if (clipReadable) {
      check(
        `${pass}: clipboard holds the raw code`,
        clip.replace(/\n+$/, '') === CODE.replace(/\n+$/, '') && !/复制/.test(clip),
        JSON.stringify(clip.slice(0, 60)),
      );
    } else {
      check(`${pass}: clipboard holds the raw code`, false, 'clipboard-read unavailable');
    }
    await sleep(1300);
    const reverted = await page.evaluate(
      () => (document.querySelector('.md pre .pre-copy') || {}).textContent || '',
    );
    check(`${pass}: feedback reverts to 复制`, reverted.trim() === '复制', reverted);
    await page.screenshot({ path: shot(pass, 'code-copy'), fullPage: false });

    // ---- streaming: no duplicate buttons + scroll-to-bottom --------------
    await page.locator('.composer textarea').fill('请给我一段代码');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.caret', { timeout: 5000 });

    let stable = true;
    let samples = 0;
    let sawTwoPres = false;
    let sawHighlight = false;
    let lastCounts = null;
    for (let i = 0; i < 12; i += 1) {
      await sleep(90);
      const counts = await page.evaluate(() => {
        const pres = [...document.querySelectorAll('.md pre')];
        const content = pres.filter((pre) => {
          const code = pre.querySelector('code');
          return Boolean(code && (code.textContent || '').trim());
        });
        return {
          pres: pres.length,
          copies: document.querySelectorAll('.md pre .pre-copy').length,
          labels: document.querySelectorAll('.md pre .pre-lang').length,
          withContent: content.length,
          highlighted: content.filter(
            (pre) =>
              pre.querySelector('code [class^="hljs-"], code [class*=" hljs-"]') != null,
          ).length,
        };
      });
      samples += 1;
      lastCounts = counts;
      if (counts.pres > 1) sawTwoPres = true;
      if (counts.highlighted > 0) sawHighlight = true;
      if (counts.pres !== counts.copies || counts.pres !== counts.labels) stable = false;
    }
    check(`${pass}: re-renders never duplicate or drop copy buttons`, stable, `${samples} samples, two blocks seen: ${sawTwoPres}`);
    check(
      `${pass}: streamed code is highlighted while it arrives`,
      sawHighlight && Boolean(lastCounts) && lastCounts.highlighted === lastCounts.withContent,
      `${samples} samples, last: ${JSON.stringify(lastCounts)}`,
    );

    // Scroll up mid-stream: the button appears and auto-scroll stays off.
    await page.evaluate(() => {
      const list = document.querySelector('.messages');
      list.style.scrollBehavior = 'auto';
      list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 700);
    });
    await sleep(350);
    const upState = await page.evaluate(() => {
      const list = document.querySelector('.messages');
      return {
        button: document.querySelectorAll('.scroll-bottom').length,
        top: list.scrollTop,
        atBottom: list.scrollHeight - list.scrollTop - list.clientHeight <= 80,
      };
    });
    check(`${pass}: scroll-to-bottom appears after scrolling up`, upState.button === 1 && !upState.atBottom, JSON.stringify(upState));
    await page.screenshot({ path: shot(pass, 'scroll-bottom'), fullPage: false });

    await sleep(700);
    const held = await page.evaluate(() => {
      const list = document.querySelector('.messages');
      return {
        button: document.querySelectorAll('.scroll-bottom').length,
        top: list.scrollTop,
        atBottom: list.scrollHeight - list.scrollTop - list.clientHeight <= 80,
        streaming: Boolean(document.querySelector('.caret')),
      };
    });
    check(
      `${pass}: streaming does not yank a scrolled-up list`,
      held.streaming && held.button === 1 && !held.atBottom && Math.abs(held.top - upState.top) < 40,
      JSON.stringify(held),
    );

    await page.locator('.scroll-bottom').click();
    await page.waitForFunction(
      () => {
        const list = document.querySelector('.messages');
        return list && list.scrollHeight - list.scrollTop - list.clientHeight <= 80;
      },
      null,
      { timeout: 8000 },
    );
    await sleep(300);
    const downState = await page.evaluate(() => document.querySelectorAll('.scroll-bottom').length);
    check(`${pass}: button hides again at the bottom`, downState === 0, String(downState));

    // Wait for the stream to finish before the next item.
    try {
      await page.waitForFunction(() => !document.querySelector('.caret'), null, { timeout: 20000 });
    } catch (err) {
      const debug = await page.evaluate(() => ({
        carets: document.querySelectorAll('.caret').length,
        rows: document.querySelectorAll('.row').length,
        streamingBubbles: document.querySelectorAll('.bubble.streaming').length,
        lastText: (document.querySelectorAll('.row.assistant .md')[
          document.querySelectorAll('.row.assistant .md').length - 1
        ] || {}).textContent?.length,
      }));
      log(`${pass}: stream-end diagnostic ${JSON.stringify(debug)}`);
      throw err;
    }
    const finalCounts = await page.evaluate(() => {
      const pres = [...document.querySelectorAll('.md pre')];
      return {
        pres: pres.length,
        copies: document.querySelectorAll('.md pre .pre-copy').length,
        labels: document.querySelectorAll('.md pre .pre-lang').length,
        highlighted: pres.filter(
          (pre) => pre.querySelector('code [class^="hljs-"], code [class*=" hljs-"]') != null,
        ).length,
      };
    });
    check(`${pass}: final render keeps one button per block`, finalCounts.pres === finalCounts.copies, JSON.stringify(finalCounts));
    check(
      `${pass}: final render keeps every block highlighted`,
      finalCounts.pres === finalCounts.highlighted && finalCounts.pres === finalCounts.labels,
      JSON.stringify(finalCounts),
    );

    // ---- 5. meter details -----------------------------------------------
    await page.locator('.context-meter-interactive').click();
    await sleep(200);
    const panel = await page.evaluate(() => {
      const el = document.querySelector('.context-meter-panel');
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    });
    check(`${pass}: meter panel shows session totals`, /本会话累计/.test(panel), panel.slice(0, 120));
    check(`${pass}: meter panel shows the turn count`, /轮次\s*1/.test(panel), panel.slice(0, 120));
    await page.screenshot({ path: shot(pass, 'meter-panel'), fullPage: false });
    await page.locator('.context-meter-interactive').click();
    await sleep(120);

    // ---- 4. pinning ------------------------------------------------------
    await openDrawer();
    const betaRow = page.locator('.chat-item', { hasText: 'Beta 会话' }).first();
    await betaRow.hover().catch(() => {});
    await betaRow.locator('.chat-pin').click();
    await sleep(250);
    const pinned = await page.evaluate(() => {
      const label = document.querySelector('.chat-group-label');
      const firstItem = document.querySelector('.chat-item');
      return {
        label: label ? (label.textContent || '').trim() : '',
        first: firstItem ? (firstItem.querySelector('.chat-id') || {}).textContent : '',
        stored: localStorage.getItem('webchannel.pinnedChats'),
      };
    });
    check(`${pass}: pin creates a 置顶 group`, pinned.label === '置顶', pinned.label);
    check(`${pass}: pinned chat sits in the group`, pinned.first === 'chat-beta', pinned.first);
    check(`${pass}: pin persists in localStorage`, pinned.stored === '["chat-beta"]', pinned.stored || 'null');
    await page.screenshot({ path: shot(pass, 'pins'), fullPage: false });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHistory(page);
    await sleep(300);
    await openDrawer();
    const afterReload = await page.evaluate(() => ({
      label: (document.querySelector('.chat-group-label') || {}).textContent || '',
      first: (document.querySelector('.chat-item .chat-id') || {}).textContent || '',
      pinMark: document.querySelectorAll('.chat-item.pinned .chat-pin-mark').length,
    }));
    check(
      `${pass}: pins survive a reload`,
      afterReload.label.trim() === '置顶' && afterReload.first === 'chat-beta' && afterReload.pinMark === 1,
      JSON.stringify(afterReload),
    );

    // Server no longer lists beta → the pin is pruned silently.
    state.chats = [
      { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
    ];
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHistory(page);
    await sleep(400);
    await openDrawer();
    const pruned = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('.chat-group-label')].map((el) => el.textContent.trim()),
      stored: localStorage.getItem('webchannel.pinnedChats'),
      betaStillListed: [...document.querySelectorAll('.chat-item .chat-id')].some(
        (el) => el.textContent === 'chat-beta',
      ),
    }));
    const pinsLeft = await pinCount(page);
    check(
      `${pass}: pin pruned when the server drops the chat`,
      pruned.labels.length === 0 && pinsLeft.length === 0,
      JSON.stringify(pruned),
    );
    check(`${pass}: pruned chat stays in the local list`, pruned.betaStillListed === true);

    // ---- 3. stale restored chat -----------------------------------------
    resetState();
    state.chats = [
      { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
      { chat: 'chat-beta', title: 'Beta 会话', updated_at: '2026-10-27T09:00:00Z' },
    ];
    await page.evaluate(() => {
      localStorage.setItem(
        'webchannel.chats',
        JSON.stringify(['chat-gone', 'chat-alpha', 'chat-beta']),
      );
      localStorage.setItem('webchannel.activeChat', 'chat-gone');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const stale = await page.evaluate(() => {
      const toast = document.querySelector('.toast');
      return {
        active: (document.querySelector('.chat-item.active .chat-id') || {}).textContent || '',
        stored: localStorage.getItem('webchannel.activeChat'),
        toast: toast ? (toast.textContent || '').trim() : '',
        info: Boolean(document.querySelector('.toast-info')),
        goneListed: [...document.querySelectorAll('.chat-item .chat-id')].some(
          (el) => el.textContent === 'chat-gone',
        ),
      };
    });
    check(`${pass}: stale restored chat falls back to the newest server chat`, stale.active === 'chat-alpha', stale.active);
    check(`${pass}: persisted active chat is rewritten`, stale.stored === 'chat-alpha', stale.stored || 'null');
    check(`${pass}: a subtle toast explains the fallback`, /已不在服务器列表中/.test(stale.toast) && stale.info, stale.toast);
    check(`${pass}: only the active id is rewritten (list untouched)`, stale.goneListed === true);
    const toastButton = await page.evaluate(() => {
      const btn = document.querySelector('.toast button');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), text: (btn.textContent || '').trim() };
    });
    check(
      `${pass}: the toast close button stays on one line`,
      Boolean(toastButton && toastButton.h <= 24 && toastButton.text === '关闭'),
      JSON.stringify(toastButton),
    );
    await page.screenshot({ path: shot(pass, 'stale-toast'), fullPage: false });

    // ---- 3b. nothing left on the server → a fresh chat ------------------
    state.chats = [];
    await page.evaluate(() => {
      localStorage.setItem('webchannel.chats', JSON.stringify(['chat-gone', 'chat-alpha']));
      localStorage.setItem('webchannel.activeChat', 'chat-gone');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const emptyFallback = await page.evaluate(() => ({
      active: (document.querySelector('.chat-item.active .chat-id') || {}).textContent || '',
      stored: localStorage.getItem('webchannel.activeChat'),
      rows: document.querySelectorAll('.messages .row').length,
      toast: (document.querySelector('.toast') || {}).textContent || '',
    }));
    check(
      `${pass}: an empty server list falls back to a fresh chat`,
      Boolean(emptyFallback.active) &&
        emptyFallback.active !== 'chat-gone' &&
        emptyFallback.stored === emptyFallback.active &&
        emptyFallback.rows === 0 &&
        /已新建会话/.test(emptyFallback.toast),
      JSON.stringify(emptyFallback),
    );

    // ---- 6. keyboard shortcuts ------------------------------------------
    const searchState = await activateSearch(page);
    check(
      `${pass}: Ctrl/Cmd+K focuses the archive search`,
      /chat-search/.test(searchState.active) && searchState.tag === 'INPUT',
      JSON.stringify(searchState),
    );
    if (mobile) {
      check(`${pass}: Ctrl/Cmd+K opens the drawer on mobile`, searchState.drawer === true);
    }
    await page.keyboard.type('Alpha');
    await sleep(250);
    const filtered = await page.evaluate(() => document.querySelectorAll('.chat-item').length);
    check(`${pass}: typing filters the chat list`, filtered === 1, String(filtered));
    await page.locator('.chat-search').fill('');

    const before = await page.evaluate(() => localStorage.getItem('webchannel.activeChat'));
    await page.keyboard.press('Control+Shift+O');
    await sleep(400);
    const newChat = await page.evaluate(() => ({
      active: (document.querySelector('.chat-item.active .chat-id') || {}).textContent || '',
      stored: localStorage.getItem('webchannel.activeChat'),
      rows: document.querySelectorAll('.messages .row').length,
      focused: document.activeElement ? document.activeElement.tagName : '',
    }));
    check(
      `${pass}: Ctrl/Cmd+Shift+O starts a new chat`,
      newChat.active && newChat.active !== before && newChat.stored === newChat.active && newChat.rows === 0,
      JSON.stringify({ before, ...newChat }),
    );
    check(`${pass}: the new chat focuses the composer`, newChat.focused === 'TEXTAREA', newChat.focused);

    await openDrawer();
    await page.locator('.help-btn[aria-label="帮助"]').click();
    await page.waitForSelector('.help-dialog', { timeout: 4000 });
    const help = await page.evaluate(() => (document.querySelector('.help-dialog') || {}).textContent || '');
    check(`${pass}: help lists Cmd/Ctrl+K`, help.includes('⌘/Ctrl + K'));
    check(`${pass}: help lists Cmd/Ctrl+Shift+O`, help.includes('⌘/Ctrl + Shift + O'));
    // Bring the new section into the shot: the dialog scrolls on its own.
    await page.evaluate(() => {
      const heading = [...document.querySelectorAll('.help-dialog h4')].find((el) =>
        (el.textContent || '').includes('键盘快捷键'),
      );
      if (heading) heading.scrollIntoView({ block: 'start' });
    });
    await sleep(200);
    await page.screenshot({ path: shot(pass, 'help'), fullPage: false });
    await page.keyboard.press('Escape');
    await sleep(200);
    const helpClosed = await page.evaluate(() => document.querySelectorAll('.help-dialog').length);
    check(`${pass}: Escape closes help`, helpClosed === 0);

    // ---- 7. M22: theme, highlighting, paste, drafts, prompt library ------
    await runM22Checks(page, pass, mobile);

    check(`${pass}: no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();

  // Never hijack (or silently use) a relay already listening on the port: the
  // build's URL is baked in, so a foreign relay would fake a pass.
  for (const [port, label] of [
    [RELAY_PORT, 'relay'],
    [PREVIEW_PORT, 'preview'],
  ]) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      throw new Error(
        `port ${port} (${label}) is already in use — stop it before running the M19 suite`,
      );
    } catch (err) {
      if (err && /already in use/.test(String(err.message))) throw err;
    }
  }

  if (process.env.M19_SKIP_BUILD !== '1') {
    log('building the SPA (npm run build)…');
    await run('npm', ['run', 'build'], SPA_DIR);
  }
  if (!existsSync(join(SPA_DIR, 'dist', 'index.html'))) {
    throw new Error('spa/dist is missing — run `npm run build` in spa/');
  }

  log('starting relay-node…');
  background('node', ['server.js'], RELAY_DIR, 'relay');
  await waitHttp(`http://127.0.0.1:${RELAY_PORT}/health`, 'relay-node');

  log('connecting the mock agent…');
  await connectAgent();

  log('starting vite preview…');
  const viteBin = join(SPA_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  background(
    'node',
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT), '--strictPort'],
    SPA_DIR,
    'preview',
  );
  await waitHttp(BASE, 'vite preview');

  const browser = await chromium.launch({ headless: !HEADED });
  try {
    await runPass(browser, 'desktop', { width: 1280, height: 900 }, false);
    await runPass(browser, 'mobile', { width: 390, height: 844 }, true);
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  log(`checks: ${checks.length}, failed: ${failed.length}, elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failed.length) {
    for (const item of failed) log(`FAILED ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    console.log('M19+M22 E2E FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('M19+M22 E2E PASS');
}

main()
  .catch((err) => {
    log(`fatal: ${err && err.stack ? err.stack : err}`);
    console.log('M19+M22 E2E FAIL');
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
