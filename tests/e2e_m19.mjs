#!/usr/bin/env node
/**
 * M19 — SPA polish pack E2E (items 1–4, 6; item 5 is asserted alongside the
 * meter) plus the M22 SPA experience pack (dark theme, highlighting,
 * paste-to-attach, per-chat drafts, prompt library), the M23 pack (chat
 * tags, Ctrl/⌘+K command palette, archive search jump) and the M24 pack
 * (all-chats usage dashboard: totals, day chart, ranking, empty state), and
 * the M25 pack (导出全部: progress, failure accounting, cancel), the M26
 * pack (compact sidebar rows, the per-row ⋯ menu on phone + desktop, and
 * BEFORE/AFTER drawer evidence), and the M27 pack (a thinking level chosen
 * before the chat's ChatSpec exists: silent 404, applied after the first turn,
 * while a real 422 stays visible).
 * Runs entirely local against a production build:
 *
 *   1. `npm run build` in spa/ (fails the run if the build fails)
 *   2. relay-node on :8787 (the build's baked-in local relay URL)
 *   3. an in-process mock agent that speaks the frames the SPA needs
 *      (chats / hist / models / skills / usage / stats / effort / export / msg streaming)
 *   4. `vite preview` on :4173 serving spa/dist
 *
 * Two passes share the same server: desktop 1280x900 and iPhone 13
 * (390x664; the M26 evidence switches to a real 390x844 canvas).
 * Screenshots land in ./m19-shots/.
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
 *   M26_ONLY=1         run only the M26 menu checks + evidence (fast loop)
 *   M27_ONLY=1         run only the M27 effort checks (fast before/after loop)
 *
 * M26 evidence (BEFORE vs AFTER) is the same structure-agnostic block, so the
 * BEFORE shots come from the unmodified build:
 *   M26_ONLY=1 OUT_DIR=./m26-shots/before node e2e_m19.mjs   (before editing)
 *   M26_ONLY=1 OUT_DIR=./m26-shots/after  node e2e_m19.mjs   (after editing)
 *
 * The browser always runs with a UTF-8 locale (see UTF8_LOCALE), whatever the
 * invoking shell exports: Chromium sanitizes `a[download]` names through the
 * process locale, so under e.g. `LC_ALL=C` every CJK filename collapses to the
 * literal "download" and the M25 filename assertions would test the shell
 * rather than the SPA.
 *
 * The process exits 1 on the first failing check summary; every check is
 * collected and printed so one run reports the whole pack.
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/**
 * Chromium converts an `a[download]` name into the *browser process* locale's
 * charset before the download manager sees it. Under a non-UTF-8 locale
 * (`LC_ALL=C`, the default of many plain/CI shells) the CJK titles are
 * unrepresentable, the conversion yields nothing and Chromium falls back to
 * its generic default name "download": the download still fires, only its
 * name is lost. Nothing in the SPA can prevent that — the anchor's `download`
 * attribute is already the exact title when click() runs — so the suite hands
 * the browser an explicit UTF-8 locale instead of inheriting the shell's.
 */
const UTF8_LOCALE =
  [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].find(
    (value) => value && /utf-?8/i.test(value),
  ) || 'C.UTF-8';
const BROWSER_ENV = {
  ...process.env,
  LANG: UTF8_LOCALE,
  LC_ALL: UTF8_LOCALE,
  LC_CTYPE: UTF8_LOCALE,
};

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

/** M23: the unique sentence the jump-to-message search will land on. */
const ANCHOR_PHRASE = '风起于青萍之末，浪成于微澜之间';
const ANCHOR_MESSAGE = `这是历史中的第 18 条消息。它包含唯一的跳转锚点：${ANCHOR_PHRASE}。搜索命中后应当滚动到这里并闪一下。`;

/**
 * A long chat-beta history puts the anchor well below the fold on both
 * passes, so "scrolled to the message" is measurable rather than assumed.
 */
const BETA_HISTORY = Array.from({ length: 24 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  text:
    i === 17
      ? ANCHOR_MESSAGE
      : `历史消息 ${i + 1}：这是一段用来把列表撑高的说明文字，滚动定位测试需要足够的纵向空间，所以每条都写上两行左右的内容。`,
}));

/** M23: a hit whose chat is not in localStorage/chats (仅归档 behaviour). */
const ARCHIVED_HIT_TEXT = `只存在于归档的旧项目记录，关键词：归档专属，原会话已经不在服务器列表中。`;
const ARCHIVED_HIT = {
  chat: 'chat-archived',
  title: '旧项目归档',
  role: 'assistant',
  text: ARCHIVED_HIT_TEXT,
  ts: 1760000000,
};

/**
 * M24: the plugin's `stats` payload. Same shape the real handler builds, with
 * the numbers the local probe produced (95 turns over two container-local
 * days, 37 covered chats, 2 known chats without data).
 */
const DEFAULT_STATS = {
  totals: { turns: 95, input: 1648974, output: 12314 },
  covered_chats: 37,
  uncovered_chats: 2,
  days: [
    { date: '2026-10-26', turns: 20, input: 406196, output: 4556 },
    { date: '2026-10-27', turns: 75, input: 1242778, output: 7758 },
  ],
  chats: [
    { chat: 'chat-beta', title: 'Beta 会话', turns: 40, input: 900000, output: 6000 },
    { chat: 'chat-alpha', title: 'Alpha 会话', turns: 30, input: 500000, output: 4000 },
  ],
  day_basis: 'container-local',
  day_tz: 'UTC',
};

/** M24 empty dashboard: real zeros, no days, no ranked chats. */
const EMPTY_STATS = {
  totals: { turns: 0 },
  covered_chats: 0,
  uncovered_chats: 2,
  days: [],
  chats: [],
  day_basis: 'container-local',
  day_tz: 'UTC',
};

/** Build the same snippet shape the plugin sends (40 code points of context). */
function searchHitFor(chat, title, role, text, q, ts) {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + q.length + 40);
  return {
    chat,
    title,
    role,
    snippet: text.slice(start, end),
    match_start: at - start,
    match_len: q.length,
    ts,
  };
}

function mockSearchItems(query) {
  const items = [];
  for (const [chat, messages] of Object.entries(state.history)) {
    const title = (state.chats.find((item) => item.chat === chat) || {}).title || chat;
    for (const message of messages) {
      const hit = searchHitFor(chat, title, message.role, message.text, query, 1760000000);
      if (hit) items.push(hit);
    }
  }
  const archived = searchHitFor(
    ARCHIVED_HIT.chat,
    ARCHIVED_HIT.title,
    ARCHIVED_HIT.role,
    ARCHIVED_HIT.text,
    query,
    ARCHIVED_HIT.ts,
  );
  if (archived) items.push(archived);
  return items;
}

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
  stats: JSON.parse(JSON.stringify(DEFAULT_STATS)),
  streaming: new Map(),
  /** M25: chats whose mock export fails, and an artificial per-export delay. */
  exportFail: [],
  exportDelay: 0,
  /** M27: chats without a ChatSpec yet, their accepted level, and every
   *  set_effort the SPA sent (`created` says whether the mock had the chat). */
  notCreated: new Set(),
  efforts: {},
  effortLog: [],
  effortGetLog: [],
  /** M27: a level the mock refuses with 422, per chat. */
  effortReject: {},
  /** M27: how long the first `msg` takes to create the ChatSpec. */
  createDelay: 2500,
};

function resetState() {
  state.chats = [
    { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
    { chat: 'chat-beta', title: 'Beta 会话', updated_at: '2026-10-27T09:00:00Z' },
  ];
  state.history = { 'chat-alpha': HISTORY, 'chat-beta': BETA_HISTORY };
  state.usage = {
    'chat-alpha': {
      input_total: 12345,
      output_total: 678,
      context_tokens: 4321,
      context_limit: 32768,
    },
    'chat-beta': { input_total: 300, output_total: 42, context_tokens: 900, context_limit: 32768 },
  };
  state.stats = JSON.parse(JSON.stringify(DEFAULT_STATS));
  state.exportFail = [];
  state.exportDelay = 0;
  state.notCreated = new Set();
  state.efforts = {};
  state.effortLog = [];
  state.effortGetLog = [];
  state.effortReject = {};
  state.createDelay = 2500;
  for (const timer of state.streaming.values()) clearInterval(timer);
  state.streaming.clear();
}

/** M25: a deterministic Markdown document per chat (what the plugin exports). */
function exportDocFor(chat) {
  const title = (state.chats.find((item) => item.chat === chat) || {}).title || chat;
  return `# ${title}\n\n> mock export for ${chat}\n\n## 对话\n\n用户：你好\n\n助手：这是 ${chat} 的导出内容。\n`;
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
    case 'search': {
      const q = String(frame.q || '').trim();
      const items = q ? mockSearchItems(q) : [];
      agentSend({ t: 'search_results', id: frame.id, q, items, total: items.length });
      break;
    }
    case 'get_usage': {
      const chat = String(frame.chat || '');
      agentSend({ t: 'usage', chat, ...(state.usage[chat] || {}) });
      break;
    }
    case 'export': {
      const chat = String(frame.chat || '');
      const id = String(frame.id || '');
      const fail = state.exportFail.includes(chat);
      setTimeout(() => {
        if (fail) {
          agentSend({
            t: 'error',
            chat,
            id,
            code: 'E_EXPORT',
            detail: 'mock export refused',
          });
          return;
        }
        const body = Buffer.from(exportDocFor(chat), 'utf-8');
        const sha256 = createHash('sha256').update(body).digest('hex');
        agentSend({ t: 'export_begin', chat, id, bytes: body.length, chunks: 1, sha256 });
        agentSend({ t: 'export_chunk', chat, id, i: 0, data: body.toString('base64') });
        agentSend({ t: 'export_end', chat, id });
      }, state.exportDelay);
      break;
    }
    case 'get_stats':
      agentSend({ t: 'stats', id: frame.id, ...state.stats });
      break;
    case 'get_effort': {
      // M27: a chat that has never been sent to has no ChatSpec yet, so the
      // plugin answers E_EFFORT 404 -- an expected state, not a failure.
      const chat = String(frame.chat || '');
      state.effortGetLog.push(chat);
      if (state.notCreated.has(chat)) {
        agentSend({
          t: 'error',
          code: 'E_EFFORT',
          chat,
          status: 404,
          id: frame.id,
          detail: 'no QwenPaw chat exists for this session yet',
        });
        break;
      }
      const level = state.efforts[chat] || 'default';
      agentSend({
        t: 'effort',
        chat,
        level,
        effective: level === 'default' ? 'inherit' : level,
        supported: ['low', 'medium', 'high', 'max'],
        kind: 'budget',
        model_key: 'mock:mock-1',
      });
      break;
    }
    case 'set_effort': {
      const chat = String(frame.chat || '');
      const level = String(frame.level || 'default');
      state.effortLog.push({ chat, level, created: !state.notCreated.has(chat) });
      if (state.notCreated.has(chat)) {
        agentSend({
          t: 'error',
          code: 'E_EFFORT',
          chat,
          status: 404,
          id: frame.id,
          detail: 'no QwenPaw chat exists for this session yet',
        });
        break;
      }
      if (state.effortReject[chat] === level) {
        agentSend({
          t: 'error',
          code: 'E_EFFORT',
          chat,
          status: 422,
          id: frame.id,
          detail: 'mock model rejects this level',
        });
        break;
      }
      state.efforts[chat] = level;
      agentSend({
        t: 'effort',
        chat,
        level,
        effective: level === 'default' ? 'inherit' : level,
        supported: ['low', 'medium', 'high', 'max'],
        kind: 'budget',
        model_key: 'mock:mock-1',
      });
      break;
    }
    case 'msg': {
      // M27: the ChatSpec is created while the first message is processed,
      // deliberately slower than the old 1.2 s re-apply timer.
      const chat = String(frame.chat || '');
      if (state.notCreated.has(chat)) {
        setTimeout(() => state.notCreated.delete(chat), state.createDelay);
      }
      streamReply(chat);
      break;
    }
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
  // M23: Ctrl/Cmd+K opens the palette; 全文搜索 is now the action that focuses
  // the archive box (the old direct binding moved inside the palette).
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.cmd-palette', { timeout: 4000 });
  await page.locator('.cmd-input').fill('全文搜索');
  await page.waitForFunction(() => document.querySelectorAll('.cmd-row').length > 0);
  await page.keyboard.press('Enter');
  await sleep(250);
  return page.evaluate(() => ({
    active: document.activeElement ? document.activeElement.className : '',
    tag: document.activeElement ? document.activeElement.tagName : '',
    drawer: Boolean(document.querySelector('.app.sidebar-open')),
    palette: Boolean(document.querySelector('.cmd-palette')),
  }));
}

async function openCommandPalette(page) {
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.cmd-palette', { timeout: 4000 });
  await sleep(120);
}

async function commandLabels(page) {
  return page.evaluate(() => ({
    rows: [...document.querySelectorAll('.cmd-row')].map((row) => ({
      label: (row.querySelector('.cmd-row-label') || {}).textContent || '',
      hint: (row.querySelector('.cmd-row-hint') || {}).textContent || '',
      active: row.classList.contains('active'),
    })),
    groups: [...document.querySelectorAll('.cmd-group-label')].map((el) =>
      (el.textContent || '').trim(),
    ),
    focused: document.activeElement ? document.activeElement.className : '',
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
 * M26: every per-chat action moved behind the row's single ⋯ button. The
 * helper opens that menu (bottom sheet on phones, dropdown on desktop) and
 * leaves the caller to click one `.chat-menu-item`.
 */
async function openRowMenu(page, title) {
  const row = page.locator('.chat-item', { hasText: title }).first();
  await row.hover().catch(() => {});
  await row.locator('.chat-more').click();
  await page.waitForSelector('.chat-menu', { timeout: 4000 });
  await sleep(260);
  return row;
}

/** Click a labelled item inside the open ⋯ menu. */
async function clickMenuItem(page, label) {
  await page.locator('.chat-menu-item', { hasText: label }).first().click();
  await sleep(200);
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
// M23 — tags, command palette (keyboard flow lives in section 6), jump
// ---------------------------------------------------------------------------

async function runM23Checks(page, pass, mobile) {
  resetState();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha', 'chat-beta']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.pinnedChats', '[]');
    localStorage.removeItem('webchannel.chatTags');
    localStorage.setItem('webchannel.chatNames', '{}');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(350);

  const openDrawer = async () => {
    if (!mobile) return;
    if (await page.locator('.app.sidebar-open').count()) return;
    await page.locator('.hamburger').click();
    await sleep(350);
  };

  const assignTags = async (title, tags) => {
    await openRowMenu(page, title);
    await clickMenuItem(page, '标签');
    await page.locator('.chat-tag-input').fill(tags);
    await page.locator('.chat-tag-input').press('Enter');
    await sleep(220);
  };

  // ---- M23.1: tags live behind the M26 ⋯ menu ---------------------------
  await openDrawer();
  await assignTags('Alpha 会话', '工作, 重要');
  await assignTags('Beta 会话', '读书');
  await openRowMenu(page, 'Alpha 会话');
  const tagged = await page.evaluate(() => ({
    stored: JSON.parse(localStorage.getItem('webchannel.chatTags') || '{}'),
    menuTags: ((document.querySelector('.chat-menu-tags') || {}).textContent || '').trim(),
    itemTags: ((document.querySelector('.chat-menu-item em') || {}).textContent || '').trim(),
    inlineChips: document.querySelectorAll('.chat-item .chat-tag').length,
    filters: [...document.querySelectorAll('.tag-filter')].map((el) => ({
      text: (el.textContent || '').trim(),
      active: el.classList.contains('active'),
    })),
  }));
  await page.keyboard.press('Escape');
  await sleep(150);
  check(
    `${pass}: tags persist per chat id in localStorage`,
    JSON.stringify(tagged.stored['chat-alpha']) === JSON.stringify(['工作', '重要']) &&
      JSON.stringify(tagged.stored['chat-beta']) === JSON.stringify(['读书']),
    JSON.stringify(tagged.stored),
  );
  check(
    `${pass}: the row menu shows a chat's tags (no inline chips)`,
    tagged.menuTags === '工作、重要' && tagged.itemTags === '工作、重要' && tagged.inlineChips === 0,
    JSON.stringify(tagged),
  );
  check(
    `${pass}: the sidebar shows 全部 plus every tag`,
    tagged.filters.map((item) => item.text).join('|') === '全部|工作|重要|读书' &&
      tagged.filters[0].active,
    JSON.stringify(tagged.filters),
  );
  await page.screenshot({ path: shot(pass, 'm23-tags'), fullPage: false });

  // ---- M23.2: filtering, with 置顶 grouping still intact ----------------
  await page.locator('.tag-filter', { hasText: '工作' }).click();
  await sleep(200);
  const filtered = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.chat-item .chat-id')].map((el) =>
      (el.textContent || '').trim(),
    ),
    active: [...document.querySelectorAll('.tag-filter.active')].map((el) =>
      (el.textContent || '').trim(),
    ),
  }));
  check(
    `${pass}: a tag chip keeps only chats carrying that tag`,
    filtered.rows.length === 1 && filtered.rows[0] === 'chat-alpha' && filtered.active.join('') === '工作',
    JSON.stringify(filtered),
  );

  await openRowMenu(page, 'Alpha 会话');
  await clickMenuItem(page, '置顶');
  const pinnedWithTag = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.chat-group-label')].map((el) =>
      (el.textContent || '').trim(),
    ),
    first: (document.querySelector('.chat-item .chat-id') || {}).textContent || '',
  }));
  check(
    `${pass}: 置顶 grouping still works under a tag filter`,
    pinnedWithTag.labels.includes('置顶') && pinnedWithTag.first === 'chat-alpha',
    JSON.stringify(pinnedWithTag),
  );

  await page.locator('.tag-filter', { hasText: '全部' }).click();
  await sleep(200);
  const allFilter = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.chat-item .chat-id')].map((el) =>
      (el.textContent || '').trim(),
    ),
    label: (document.querySelector('.chat-group-label') || {}).textContent || '',
    first: (document.querySelector('.chat-item .chat-id') || {}).textContent || '',
  }));
  check(
    `${pass}: 全部 restores every chat and keeps the pin first`,
    allFilter.rows.length === 2 &&
      allFilter.label.trim() === '置顶' &&
      allFilter.first === 'chat-alpha',
    JSON.stringify(allFilter),
  );

  // The same menu item unpins: its label flips to 取消置顶.
  await openRowMenu(page, 'Alpha 会话');
  const unpinLabel = (
    (await page.locator('.chat-menu-item', { hasText: '取消置顶' }).count()) ? '取消置顶' : ''
  );
  await clickMenuItem(page, '取消置顶');
  const unpinned = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.chat-group-label')].map((el) =>
      (el.textContent || '').trim(),
    ),
    stored: localStorage.getItem('webchannel.pinnedChats'),
    pinMarks: document.querySelectorAll('.chat-pin-mark').length,
  }));
  check(
    `${pass}: the menu flips to 取消置顶 and clears the group`,
    unpinLabel === '取消置顶' && unpinned.labels.length === 0 && unpinned.stored === '[]',
    JSON.stringify({ unpinLabel, ...unpinned }),
  );
  check(`${pass}: no pin glyph is left behind`, unpinned.pinMarks === 0, String(unpinned.pinMarks));

  // ---- M23.3: tags survive a reload, then prune like pins --------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(350);
  await openDrawer();
  const persistedTags = await page.evaluate(() => ({
    filters: [...document.querySelectorAll('.tag-filter')].map((el) =>
      (el.textContent || '').trim(),
    ),
    stored: JSON.parse(localStorage.getItem('webchannel.chatTags') || '{}'),
  }));
  check(
    `${pass}: tags and their filter chips survive a reload`,
    persistedTags.filters.includes('工作') &&
      persistedTags.filters.includes('读书') &&
      persistedTags.stored['chat-beta']?.[0] === '读书',
    JSON.stringify(persistedTags),
  );

  state.chats = [
    { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
  ];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(450);
  await openDrawer();
  const prunedTags = await page.evaluate(() => ({
    stored: JSON.parse(localStorage.getItem('webchannel.chatTags') || '{}'),
    filters: [...document.querySelectorAll('.tag-filter')].map((el) =>
      (el.textContent || '').trim(),
    ),
  }));
  check(
    `${pass}: tags for vanished chats are pruned like pins`,
    !('chat-beta' in prunedTags.stored) &&
      prunedTags.stored['chat-alpha']?.length === 2 &&
      !prunedTags.filters.includes('读书'),
    JSON.stringify(prunedTags),
  );

  // ---- M23.4: search hit jumps to the anchored message -----------------
  resetState();
  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha', 'chat-beta']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.pinnedChats', '[]');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(350);

  await openDrawer();
  await page.locator('.chat-search').fill(ANCHOR_PHRASE);
  await page.waitForSelector('.search-hit', { timeout: 5000 });
  const hitMeta = await page.evaluate(() => ({
    count: document.querySelectorAll('.search-hit').length,
    badge: Boolean(document.querySelector('.search-hit-badge')),
    mark: (document.querySelector('.search-hit-snippet mark') || {}).textContent || '',
  }));
  check(
    `${pass}: archive search returns the seeded message`,
    hitMeta.count === 1 && hitMeta.mark === ANCHOR_PHRASE && !hitMeta.badge,
    JSON.stringify(hitMeta),
  );

  await page.locator('.search-hit').first().click();
  await page.waitForSelector('.row.jump-flash', { timeout: 5000 });
  await sleep(450);
  const jumped = await page.evaluate(() => {
    const row = document.querySelector('.row.jump-flash');
    const list = document.querySelector('.messages');
    if (!row || !list) return null;
    const rr = row.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return {
      active: localStorage.getItem('webchannel.activeChat'),
      text: (row.textContent || '').trim(),
      scrollTop: Math.round(list.scrollTop),
      visible: rr.top >= lr.top - 1 && rr.bottom <= lr.bottom + 1,
      toast: (document.querySelector('.toast') || {}).textContent || '',
    };
  });
  check(
    `${pass}: clicking a hit opens the chat and scrolls to the message`,
    Boolean(
      jumped &&
        jumped.active === 'chat-beta' &&
        jumped.text.includes(ANCHOR_PHRASE) &&
        jumped.scrollTop > 0 &&
        jumped.visible,
    ),
    JSON.stringify(jumped),
  );
  check(
    `${pass}: an exact text anchor does not claim to be approximate`,
    Boolean(jumped && !/无法精确锚定/.test(jumped.toast)),
    jumped ? jumped.toast : 'null',
  );
  await page.screenshot({ path: shot(pass, 'm23-jump'), fullPage: false });
  await sleep(1800);
  const flashGone = await page.evaluate(
    () => document.querySelectorAll('.row.jump-flash').length,
  );
  check(`${pass}: the highlight flash is brief`, flashGone === 0, String(flashGone));

  // ---- M23.5: archived-only hits keep their existing behaviour ----------
  await openDrawer();
  await page.locator('.chat-search').fill('归档专属');
  await page.waitForSelector('.search-hit-badge', { timeout: 5000 });
  const archivedBadge = await page.evaluate(() => ({
    badge: (document.querySelector('.search-hit-badge') || {}).textContent || '',
    text: (document.querySelector('.search-hit') || {}).textContent || '',
  }));
  check(
    `${pass}: an archived-only hit is still labelled 仅归档`,
    archivedBadge.badge === '仅归档',
    JSON.stringify(archivedBadge).slice(0, 160),
  );
  await page.locator('.search-hit').first().click();
  await page.waitForSelector('.toast', { timeout: 5000 });
  await sleep(300);
  const archivedJump = await page.evaluate(() => ({
    active: localStorage.getItem('webchannel.activeChat'),
    toast: (document.querySelector('.toast') || {}).textContent || '',
    rows: document.querySelectorAll('.messages .row').length,
  }));
  check(
    `${pass}: an archived-only jump opens the chat and says it cannot locate`,
    archivedJump.active === 'chat-archived' &&
      archivedJump.rows === 0 &&
      /仅存在于归档/.test(archivedJump.toast),
    JSON.stringify(archivedJump),
  );
}

// ---------------------------------------------------------------------------
// M24 helpers (all-chats usage dashboard)
// ---------------------------------------------------------------------------

async function runM24Checks(page, pass, mobile) {
  state.stats = JSON.parse(JSON.stringify(DEFAULT_STATS));

  const openStatsView = async () => {
    if (mobile && !(await page.locator('.app.sidebar-open').count())) {
      await page.locator('.hamburger').click();
      await sleep(350);
    }
    await page.locator('.stats-open').click();
    await page.waitForSelector('.stats-view', { timeout: 4000 });
    await sleep(300);
  };

  await openStatsView();
  await page.screenshot({ path: shot(pass, 'm24-stats'), fullPage: false });

  const view = await page.evaluate(() => {
    const text = (sel) => (document.querySelector(sel) || {}).textContent || '';
    const cards = [...document.querySelectorAll('.stats-card')].map((el) => ({
      label: (el.querySelector('.stats-card-label') || {}).textContent || '',
      value: (el.querySelector('.stats-card-value') || {}).textContent || '',
      sub: (el.querySelector('.stats-card-sub') || {}).textContent || '',
    }));
    const bars = [...document.querySelectorAll('.stats-bar-col')].map((el) => {
      const fill = el.querySelector('.stats-bar-fill');
      const track = el.querySelector('.stats-bar-track');
      let ratio = null;
      if (fill && track) {
        const f = fill.getBoundingClientRect();
        const t = track.getBoundingClientRect();
        ratio = t.height > 0 ? Math.round((f.height / t.height) * 1000) / 1000 : null;
      }
      return {
        label: (el.querySelector('.stats-bar-label') || {}).textContent || '',
        turns: (el.querySelector('.stats-bar-turns') || {}).textContent || '',
        ratio,
      };
    });
    const rows = [...document.querySelectorAll('.stats-chat-row')].map((el) => ({
      rank: (el.querySelector('.stats-chat-rank') || {}).textContent || '',
      title: (el.querySelector('.stats-chat-title') || {}).textContent || '',
      id: (el.querySelector('.stats-chat-id') || {}).textContent || '',
      turns: (el.querySelector('.stats-chat-turns') || {}).textContent || '',
    }));
    const box = document.querySelector('.stats-view');
    const rect = box ? box.getBoundingClientRect() : null;
    return {
      cards,
      bars,
      rows,
      head: text('.stats-title'),
      chartHead: text('.stats-chart-wrap .stats-section-head'),
      topHead: text('.stats-top .stats-section-head'),
      basis: text('.stats-basis'),
      dialog: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewport: { w: innerWidth, h: innerHeight },
    };
  });

  check(`${pass}: stats view opens from the sidebar`, view.dialog != null, JSON.stringify(view.dialog));
  check(
    `${pass}: stats has four totals cards`,
    view.cards.length === 4,
    view.cards.map((c) => `${c.label}=${c.value}`).join(' · '),
  );
  check(
    `${pass}: totals show turns / input / output / covered chats`,
    view.cards[0].value === '95' &&
      view.cards[1].value === '1.6M' &&
      view.cards[2].value === '12.3k' &&
      view.cards[3].value === '37',
    view.cards.map((c) => c.value).join(','),
  );
  check(
    `${pass}: exact input total and uncovered count are stated`,
    view.cards[1].sub.includes('1,648,974') && view.cards[3].sub.includes('另有 2 个无数据'),
    `${view.cards[1].sub} | ${view.cards[3].sub}`,
  );
  check(
    `${pass}: day chart has one bar per day, ascending`,
    view.bars.length === 2 && view.bars[0].label === '10/26' && view.bars[1].label === '10/27',
    JSON.stringify(view.bars.map((b) => b.label)),
  );
  check(
    `${pass}: bars scale to the peak day`,
    view.bars[0].ratio != null &&
      Math.abs(view.bars[0].ratio - 0.328) < 0.02 &&
      Math.abs(view.bars[1].ratio - 1) < 0.01,
    JSON.stringify(view.bars.map((b) => b.ratio)),
  );
  check(
    `${pass}: every bar keeps its turn count`,
    view.bars[0].turns === '20 轮' && view.bars[1].turns === '75 轮',
    JSON.stringify(view.bars.map((b) => b.turns)),
  );
  check(
    `${pass}: chart header names the peak`,
    view.chartHead.includes('峰值') && view.chartHead.includes('1.3M'),
    view.chartHead.trim(),
  );
  check(
    `${pass}: top chats are ranked with titles`,
    view.rows.length === 2 &&
      view.rows[0].rank === '1' &&
      view.rows[0].title === 'Beta 会话' &&
      view.rows[0].id === 'chat-beta' &&
      view.rows[0].turns === '40 轮' &&
      view.rows[1].title === 'Alpha 会话',
    JSON.stringify(view.rows),
  );
  check(
    `${pass}: ranking header explains the cap`,
    view.topHead.includes('共 37 个会话有数据') && view.topHead.includes('前 2'),
    view.topHead.trim(),
  );
  check(
    `${pass}: basis note states source, coverage and timezone`,
    view.basis.includes('数据来源与覆盖范围') &&
      view.basis.includes('sessions/web/*.json') &&
      view.basis.includes('容器本地时区') &&
      view.basis.includes('（UTC）') &&
      view.basis.includes('37 个会话有可用数据') &&
      view.basis.includes('2 个已知会话没有可统计的用量'),
    view.basis.replace(/\s+/g, ' ').slice(0, 160),
  );

  if (mobile) {
    check(
      `${pass}: stats dialog fills the 390px screen`,
      view.viewport.w === 390 &&
        view.dialog != null &&
        Math.abs(view.dialog.w - 390) <= 1 &&
        view.dialog.h >= view.viewport.h - 1,
      JSON.stringify({ dialog: view.dialog, viewport: view.viewport }),
    );
    check(
      `${pass}: stats view has no horizontal overflow`,
      view.overflowX <= 0,
      String(view.overflowX),
    );
    // Scope the audit to the dialog: the M23 toast's compact "关闭" button
    // (asserted to stay ≤24px above) may still be on screen behind it.
    const audit = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.stats-view button')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width < 44 || r.height < 44) {
          out.push({
            text: (el.textContent || '').trim().slice(0, 40),
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
          });
        }
      }
      return out;
    });
    check(
      `${pass}: stats tap targets stay 44px`,
      audit.length === 0,
      JSON.stringify(audit.slice(0, 4)),
    );
  }

  // ---- Jump from a ranking row to that chat ---------------------------
  await page.locator('.stats-chat-row').first().click();
  await sleep(350);
  const jumped = await page.evaluate(() => ({
    open: document.querySelectorAll('.stats-view').length,
    title: ((document.querySelector('.top-title') || {}).textContent || '').trim(),
    active: localStorage.getItem('webchannel.activeChat'),
  }));
  check(
    `${pass}: clicking a ranked chat opens it`,
    jumped.open === 0 && jumped.title === 'Beta 会话' && jumped.active === 'chat-beta',
    JSON.stringify(jumped),
  );

  // ---- Empty state (a real zero, not a missing field) ------------------
  await openStatsView();
  state.stats = JSON.parse(JSON.stringify(EMPTY_STATS));
  await page.locator('.stats-icon-btn[aria-label="刷新用量统计"]').click();
  await page.waitForSelector('.stats-empty', { timeout: 4000 });
  await sleep(250);
  const empty = await page.evaluate(() => ({
    text: ((document.querySelector('.stats-empty') || {}).textContent || '').trim(),
    cards: document.querySelectorAll('.stats-card').length,
    bars: document.querySelectorAll('.stats-bar-col').length,
    rows: document.querySelectorAll('.stats-chat-row').length,
    basis: ((document.querySelector('.stats-basis') || {}).textContent || '').trim(),
  }));
  check(
    `${pass}: empty stats shows an honest empty state`,
    empty.text.includes('还没有可统计的用量') &&
      empty.cards === 0 &&
      empty.bars === 0 &&
      empty.rows === 0,
    JSON.stringify({ cards: empty.cards, bars: empty.bars, rows: empty.rows }),
  );
  check(
    `${pass}: empty-state basis reports zero coverage`,
    empty.basis.includes('0 个会话有可用数据'),
    empty.basis.replace(/\s+/g, ' ').slice(0, 120),
  );
  await page.screenshot({ path: shot(pass, 'm24-stats-empty'), fullPage: false });

  state.stats = JSON.parse(JSON.stringify(DEFAULT_STATS));
  await page.keyboard.press('Escape');
  await sleep(250);
  const closed = await page.evaluate(() => document.querySelectorAll('.stats-view').length);
  check(`${pass}: Escape closes the stats view`, closed === 0);
}

// ---------------------------------------------------------------------------
// M25 — bulk export (导出全部)
// ---------------------------------------------------------------------------

/** Wait for a toast whose text contains `needle`, then return its text/tone. */
async function waitToast(page, needle, timeout = 8000) {
  await page.waitForFunction(
    (text) => {
      const el = document.querySelector('.toast');
      return Boolean(el && (el.textContent || '').includes(text));
    },
    needle,
    { timeout },
  );
  return page.evaluate(() => {
    const el = document.querySelector('.toast');
    return { text: (el.textContent || '').trim(), cls: el.className };
  });
}

/** Close the current toast so the next wait cannot match a stale one. */
async function dismissToast(page) {
  // The mobile sidebar scrim sits above the toast: click the close control
  // through the DOM instead of hit-testing, which the scrim would intercept.
  await page.evaluate(() => {
    const button = document.querySelector('.toast button');
    if (button) button.click();
  });
  await page.waitForFunction(() => !document.querySelector('.toast'), null, {
    timeout: 4000,
  });
}

/** Node-side poll for asynchronous side effects (download events). */
async function waitUntil(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

/**
 * Prove once that this browser really can name a non-ASCII download (see
 * UTF8_LOCALE). Without the guard the same environment bug reappears as four
 * unrelated M25 failures whose detail is only ["download","download"].
 * Returns an empty string when naming works, otherwise the diagnosis.
 */
async function probeDownloadNames(browser) {
  const expected = '导出检查-2026-01-01.md';
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    const event = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.evaluate((name) => {
      const url = URL.createObjectURL(
        new Blob(['probe'], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, expected);
    const download = await event;
    if (!download) return 'blob download produced no download event';
    const suggested = download.suggestedFilename();
    if (suggested !== expected) {
      return (
        `browser named a non-ASCII download ${JSON.stringify(suggested)} instead of ` +
        `${JSON.stringify(expected)} — its locale ${JSON.stringify(UTF8_LOCALE)} is not ` +
        'UTF-8, so every CJK filename would collapse to "download"'
      );
    }
    return '';
  } catch (err) {
    return `non-ASCII download probe failed: ${err && err.message ? err.message : err}`;
  } finally {
    await context.close().catch(() => {});
  }
}

async function runM25Checks(page, pass, mobile) {
  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(350);
  }

  const note = ((await page.locator('.bulk-note').textContent()) || '').trim();
  check(
    `${pass}: bulk export states its scope next to the action`,
    note.includes('服务器') && note.includes('100') && note.includes('归档'),
    note,
  );
  const button = ((await page.locator('.bulk-open').textContent()) || '').trim();
  check(`${pass}: 导出全部 shows the server chat count`, button.includes('（2）'), button);

  const downloads = [];
  const warnings = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });

  // ---- 1. both chats export, one at a time, with progress ---------------
  state.exportFail = [];
  state.exportDelay = 300;
  await page.locator('.bulk-open').click();
  await page.waitForSelector('.bulk-panel', { timeout: 4000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.bulk-panel-head');
      return Boolean(el && (el.textContent || '').includes('/2'));
    },
    null,
    { timeout: 4000 },
  );
  const panel = await page.evaluate(() => ({
    head: ((document.querySelector('.bulk-panel-head') || {}).textContent || '').trim(),
    title: ((document.querySelector('.bulk-panel-title') || {}).textContent || '').trim(),
  }));
  check(
    `${pass}: bulk progress shows n/N and the current title`,
    panel.head.includes('1/2') && panel.title.startsWith('Alpha'),
    JSON.stringify(panel),
  );
  await page.screenshot({ path: shot(pass, 'm25-bulk-progress'), fullPage: false });

  let toast = await waitToast(page, '批量导出完成');
  await waitUntil(() => downloads.length === 2);
  check(
    `${pass}: bulk export summary counts both chats`,
    toast.text.includes('成功 2') && toast.text.includes('失败 0') && toast.cls.includes('toast-ok'),
    toast.text,
  );
  check(
    `${pass}: bulk export downloaded two Markdown files in order`,
    downloads.length === 2 &&
      /Alpha 会话.*\.md$/.test(downloads[0]) &&
      /Beta 会话.*\.md$/.test(downloads[1]),
    JSON.stringify(downloads),
  );
  const panelGone = await page.evaluate(
    () => document.querySelectorAll('.bulk-panel').length,
  );
  check(`${pass}: the progress panel closes when the batch ends`, panelGone === 0);

  // ---- 2. a failed chat is counted, named and logged --------------------
  await dismissToast(page);
  state.exportFail = ['chat-beta'];
  state.exportDelay = 120;
  await page.locator('.bulk-open').click();
  toast = await waitToast(page, '批量导出完成');
  await waitUntil(() => downloads.length === 3);
  check(
    `${pass}: partial failure is counted and names the chat`,
    toast.text.includes('成功 1') &&
      toast.text.includes('失败 1') &&
      toast.text.includes('Beta 会话') &&
      toast.cls.includes('toast-danger'),
    toast.text,
  );
  check(
    `${pass}: the failed chat is logged with its reason`,
    warnings.some((line) => line.includes('[bulk-export] 失败 Beta 会话') && line.includes('E_EXPORT')),
    warnings.slice(-3).join(' | '),
  );
  check(
    `${pass}: the failed chat produced no download`,
    downloads.length === 3 && /Alpha 会话/.test(downloads[2]),
    JSON.stringify(downloads),
  );

  // ---- 3. cancel drops the in-flight file and leaves the rest ----------
  await dismissToast(page);
  state.exportFail = [];
  state.exportDelay = 700;
  const beforeCancel = downloads.length;
  await page.locator('.bulk-open').click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.bulk-panel-head');
      return Boolean(el && (el.textContent || '').includes('1/2'));
    },
    null,
    { timeout: 4000 },
  );
  await page.locator('.bulk-cancel').click();
  toast = await waitToast(page, '批量导出已取消');
  check(
    `${pass}: cancel stops the batch and reports the remainder`,
    toast.text.includes('成功 0') && toast.text.includes('剩余 2 个未导出'),
    toast.text,
  );
  check(
    `${pass}: cancel dropped the in-flight download`,
    downloads.length === beforeCancel,
    JSON.stringify(downloads.slice(beforeCancel)),
  );

  state.exportDelay = 0;
  state.exportFail = [];
}

// ---------------------------------------------------------------------------
// M26 — sidebar redesign: one ⋯ menu per row (tag / pin / rename / delete)
// ---------------------------------------------------------------------------

async function runM26Checks(page, pass, mobile) {
  resetState();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha', 'chat-beta']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.pinnedChats', '[]');
    localStorage.removeItem('webchannel.chatTags');
    localStorage.setItem('webchannel.chatNames', '{}');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(350);
  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(350);
  } else {
    await page.mouse.move(600, 300).catch(() => {});
    await sleep(120);
  }

  // ---- 1. structure: flat single-line rows, exactly one affordance ------
  const structure = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chat-item')];
    const first = rows[0];
    const more = first.querySelector('.chat-more');
    const title = first.querySelector('.chat-title-text');
    const tr = title.getBoundingClientRect();
    const mr = more.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    return {
      rows: rows.length,
      mores: document.querySelectorAll('.chat-item .chat-more').length,
      strayButtons: rows.reduce(
        (count, row) =>
          count +
          [...row.querySelectorAll('button')].filter(
            (btn) => !btn.classList.contains('chat-more') && !btn.classList.contains('chat-title'),
          ).length,
        0,
      ),
      heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
      moreOpacity: getComputedStyle(more).opacity,
      moreSize: [Math.round(mr.width), Math.round(mr.height)],
      titleEllipsis: titleStyle.textOverflow,
      titleWrap: titleStyle.whiteSpace,
      titleHeight: Math.round(tr.height),
      inlineChips: document.querySelectorAll('.chat-item .chat-tag').length,
    };
  });
  check(
    `${pass}: every row has exactly one ⋯ affordance (old 4-icon row is gone)`,
    structure.rows === 2 && structure.mores === 2 && structure.strayButtons === 0,
    JSON.stringify(structure),
  );
  check(
    `${pass}: chat rows are one compact line in 44–52px`,
    structure.heights.length === 1 &&
      structure.heights[0] >= 44 &&
      structure.heights[0] <= 52 &&
      structure.titleHeight <= 24,
    JSON.stringify(structure),
  );
  check(
    `${pass}: long titles ellipsize on one line (no wrap, no clipping)`,
    structure.titleEllipsis === 'ellipsis' && structure.titleWrap === 'nowrap',
    JSON.stringify(structure),
  );
  check(
    `${pass}: tags never render inline in a row`,
    structure.inlineChips === 0,
    String(structure.inlineChips),
  );
  if (mobile) {
    check(
      `${pass}: the ⋯ is always visible and a 44px tap target`,
      structure.moreOpacity === '1' && structure.moreSize[0] >= 44 && structure.moreSize[1] >= 44,
      JSON.stringify(structure),
    );
    const drawerAudit = await page.evaluate(TAP_TARGET_SCRIPT);
    check(
      `${pass}: the open M26 drawer keeps every tap target ≥44px`,
      drawerAudit.length === 0,
      JSON.stringify(drawerAudit.slice(0, 4)),
    );
  } else {
    check(
      `${pass}: the ⋯ stays hidden until the row is hovered`,
      structure.moreOpacity === '0',
      structure.moreOpacity,
    );
    await page.locator('.chat-item').first().hover();
    await sleep(180);
    const hovered = await page.evaluate(
      () => getComputedStyle(document.querySelector('.chat-item .chat-more')).opacity,
    );
    check(`${pass}: hovering reveals the ⋯`, hovered === '1', hovered);
  }

  // ---- 2. the menu itself: dropdown on desktop, bottom sheet on mobile --
  await openRowMenu(page, 'Beta 会话');
  const menu = await page.evaluate(() => {
    const el = document.querySelector('.chat-menu');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      sheet: el.classList.contains('sheet'),
      dropdown: el.classList.contains('dropdown'),
      position: getComputedStyle(el).position,
      rect: {
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
      },
      vw: innerWidth,
      vh: innerHeight,
      items: [...el.querySelectorAll('.chat-menu-item span')].map((span) =>
        (span.textContent || '').trim(),
      ),
      itemHeight: Math.round(el.querySelector('.chat-menu-item').getBoundingClientRect().height),
      tags: ((el.querySelector('.chat-menu-tags') || {}).textContent || '').trim(),
    };
  });
  check(
    `${pass}: the menu offers 标签 / 置顶 / 重命名 / 删除`,
    Boolean(menu) && menu.items.join('|') === '标签|置顶|重命名|删除',
    menu ? JSON.stringify(menu.items) : 'no menu',
  );
  check(
    `${pass}: the menu is a fixed ${mobile ? 'bottom sheet' : 'anchored dropdown'}`,
    Boolean(menu) &&
      menu.position === 'fixed' &&
      (mobile
        ? menu.sheet && !menu.dropdown && menu.rect.bottom === menu.vh && menu.rect.left === 0 && menu.rect.right === menu.vw
        : menu.dropdown && !menu.sheet && menu.rect.left >= 0 && menu.rect.right <= menu.vw && menu.rect.bottom <= menu.vh),
    JSON.stringify(menu && menu.rect),
  );
  check(
    `${pass}: menu items are ${mobile ? '48' : '40'}px tall and thumb-friendly`,
    Boolean(menu) && menu.itemHeight >= (mobile ? 44 : 36),
    menu ? String(menu.itemHeight) : '',
  );
  await page.screenshot({ path: shot(pass, mobile ? 'm26-menu-sheet' : 'm26-menu-dropdown'), fullPage: false });
  await page.keyboard.press('Escape');
  await sleep(180);
  check(
    `${pass}: Escape closes the ⋯ menu`,
    (await page.locator('.chat-menu').count()) === 0,
    String(await page.locator('.chat-menu').count()),
  );

  // Scrim click closes it too (tap the far corner, away from the menu).
  await openRowMenu(page, 'Beta 会话');
  await page.locator('.chat-menu-scrim').click({ position: { x: 6, y: 6 } });
  await sleep(200);
  check(
    `${pass}: tapping outside closes the ⋯ menu`,
    (await page.locator('.chat-menu').count()) === 0,
    String(await page.locator('.chat-menu').count()),
  );

  // ---- 3. 标签: the editor moved into the menu, tags show in the menu ----
  await openRowMenu(page, 'Beta 会话');
  await clickMenuItem(page, '标签');
  const tagEditor = await page.evaluate(() => {
    const input = document.querySelector('.chat-menu .chat-tag-input');
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return {
      focused: document.activeElement === input,
      h: Math.round(r.height),
      font: getComputedStyle(input).fontSize,
    };
  });
  check(
    `${pass}: 标签 opens an inline editor inside the menu`,
    Boolean(
      tagEditor &&
        tagEditor.focused &&
        tagEditor.h >= (mobile ? 44 : 28) &&
        (!mobile || tagEditor.font === '16px'),
    ),
    JSON.stringify(tagEditor),
  );
  await page.locator('.chat-tag-input').fill('项目, 待办');
  await page.locator('.chat-tag-input').press('Enter');
  await sleep(250);
  const tagState = await page.evaluate(() => ({
    stored: JSON.parse(localStorage.getItem('webchannel.chatTags') || '{}'),
    menu: document.querySelectorAll('.chat-menu').length,
    filters: [...document.querySelectorAll('.tag-filter')].map((el) => (el.textContent || '').trim()),
  }));
  check(
    `${pass}: committing tags stores them and closes the menu`,
    JSON.stringify(tagState.stored['chat-beta']) === JSON.stringify(['项目', '待办']) &&
      tagState.menu === 0,
    JSON.stringify(tagState),
  );
  check(
    `${pass}: the tag row appears above the list`,
    tagState.filters.join('|') === '全部|项目|待办',
    JSON.stringify(tagState.filters),
  );

  await openRowMenu(page, 'Beta 会话');
  const menuTags = await page.evaluate(() => ({
    head: ((document.querySelector('.chat-menu-tags') || {}).textContent || '').trim(),
    row: ((document.querySelector('.chat-menu-item em') || {}).textContent || '').trim(),
  }));
  check(
    `${pass}: reopening the menu shows the tags on the chat`,
    menuTags.head === '项目、待办' && menuTags.row === '项目、待办',
    JSON.stringify(menuTags),
  );

  // ---- 4. 置顶 rewrites the menu to 取消置顶 ----------------------------
  await clickMenuItem(page, '置顶');
  const pinned = await page.evaluate(() => {
    const label = document.querySelector('.chat-group-label');
    return {
      label: (label ? label.textContent : '').trim(),
      position: label ? getComputedStyle(label).position : '',
      stored: localStorage.getItem('webchannel.pinnedChats'),
      pinMarks: document.querySelectorAll('.chat-pin-mark').length,
    };
  });
  check(
    `${pass}: 置顶 moves the chat into a sticky 置顶 group`,
    pinned.label === '置顶' && pinned.position === 'sticky' && pinned.stored === '["chat-beta"]',
    JSON.stringify(pinned),
  );
  check(`${pass}: the pinned row shows its single pin glyph`, pinned.pinMarks === 1, String(pinned.pinMarks));

  await openRowMenu(page, 'Beta 会话');
  const flipLabel = await page.evaluate(
    () => [...document.querySelectorAll('.chat-menu-item span')].map((el) => el.textContent.trim()),
  );
  check(`${pass}: the pinned menu offers 取消置顶`, flipLabel.includes('取消置顶'), JSON.stringify(flipLabel));

  // ---- 5. 重命名 starts the inline editor in the row -------------------
  await clickMenuItem(page, '重命名');
  const renameOpen = await page.evaluate(() => {
    const input = document.querySelector('.chat-rename');
    return {
      exists: Boolean(input),
      focused: Boolean(input) && document.activeElement === input,
      value: input ? input.value : '',
      menu: document.querySelectorAll('.chat-menu').length,
    };
  });
  check(
    `${pass}: 重命名 opens the row editor with the old title`,
    renameOpen.exists && renameOpen.focused && renameOpen.value === 'Beta 会话' && renameOpen.menu === 0,
    JSON.stringify(renameOpen),
  );
  await page.locator('.chat-rename').fill('改名后的会话');
  await page.locator('.chat-rename').press('Enter');
  await sleep(250);
  const renamed = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('.chat-item .chat-title-text')].map((el) =>
      (el.textContent || '').trim(),
    ),
    stored: JSON.parse(localStorage.getItem('webchannel.chatNames') || '{}'),
  }));
  check(
    `${pass}: Enter saves the new title`,
    renamed.titles.includes('改名后的会话') &&
      !renamed.titles.includes('Beta 会话') &&
      renamed.stored['chat-beta'] === '改名后的会话',
    JSON.stringify(renamed),
  );

  // ---- 6. lighter, horizontally scrollable tag chips --------------------
  const chips = await page.evaluate(() => {
    const wrap = document.querySelector('.tag-filters');
    if (!wrap) return null;
    const cs = getComputedStyle(wrap);
    return {
      overflowX: cs.overflowX,
      wrap: cs.flexWrap,
      border: getComputedStyle(wrap.querySelector('.tag-filter')).borderWidth,
      chipHeight: Math.round(wrap.querySelector('.tag-filter').getBoundingClientRect().height),
    };
  });
  check(
    `${pass}: tag filters scroll horizontally as light chips`,
    Boolean(chips) && chips.overflowX === 'auto' && chips.wrap === 'nowrap' && chips.border === '0px',
    JSON.stringify(chips),
  );

  // ---- 7. the selected row is a quiet but distinct background ----------
  const selection = await page.evaluate(() => {
    const active = document.querySelector('.chat-item.active');
    const idle = document.querySelector('.chat-item:not(.active)');
    return {
      active: active ? getComputedStyle(active).backgroundColor : '',
      idle: idle ? getComputedStyle(idle).backgroundColor : '',
      shadow: active ? getComputedStyle(active).boxShadow : '',
    };
  });
  check(
    `${pass}: the active row differs from an idle row (flat, no card)`,
    selection.active !== selection.idle &&
      selection.active !== 'rgba(0, 0, 0, 0)' &&
      selection.shadow === 'none',
    JSON.stringify(selection),
  );

  // ---- 8. 删除 goes through the menu and the confirm dialog ------------
  let dialogText = '';
  page.once('dialog', (dialog) => {
    dialogText = dialog.message();
    dialog.accept().catch(() => {});
  });
  await openRowMenu(page, '改名后的会话');
  await clickMenuItem(page, '删除');
  await sleep(350);
  const deleted = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.chat-item .chat-id')].map((el) => el.textContent.trim()),
    stored: JSON.parse(localStorage.getItem('webchannel.chats') || '[]'),
    tags: JSON.parse(localStorage.getItem('webchannel.chatTags') || '{}'),
    pins: localStorage.getItem('webchannel.pinnedChats'),
    menu: document.querySelectorAll('.chat-menu').length,
  }));
  check(`${pass}: 删除 confirms with the chat title`, /改名后的会话/.test(dialogText), dialogText);
  check(
    `${pass}: 删除 removes the row, its id, tags and pin`,
    !deleted.ids.includes('chat-beta') &&
      !deleted.stored.includes('chat-beta') &&
      !('chat-beta' in deleted.tags) &&
      deleted.pins === '[]' &&
      deleted.menu === 0,
    JSON.stringify(deleted),
  );

  resetState();
}

// ---------------------------------------------------------------------------
// M27 — thinking effort before the chat exists
// ---------------------------------------------------------------------------

async function activeEffortLabel(page) {
  return page.evaluate(
    () => (document.querySelector('.effort-opt.active') || {}).textContent || '',
  );
}

async function toastText(page) {
  return page.evaluate(
    () => (document.querySelector('.toast') || {}).textContent || '',
  );
}

/**
 * The two paths from the field report, plus the one that must stay loud:
 *
 *  1. open the page on a chat that has never been sent to (its `ChatSpec`
 *     does not exist, so `get_effort` answers 404): no error popup, the
 *     saved level is still selected, and the first completed turn applies it;
 *  2. a new chat where the level is chosen before the first message: silent,
 *     then applied after that message;
 *  3. an existing chat whose model rejects a level with 422: visible toast
 *     and a rollback to the confirmed level (no global swallowing).
 */
async function runM27Checks(page, pass, mobile) {
  const openDrawer = async () => {
    if (!mobile) return;
    if (await page.locator('.app.sidebar-open').count()) return;
    await page.locator('.hamburger').click();
    await sleep(350);
  };

  // ---- M27.1: restoring a chat that has never been sent to ---------------
  resetState();
  const fresh = 'chat-fresh';
  // Listed so M19's stale-restored-chat check keeps it active; its thinking
  // record is deliberately still missing (the 404 the plugin emits until the
  // first turn creates the session).
  state.chats.unshift({ chat: fresh, title: '未发送会话', updated_at: '2026-10-29T09:00:00Z' });
  state.history[fresh] = [];
  state.notCreated.add(fresh);
  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-fresh', 'chat-alpha']));
    localStorage.setItem('webchannel.activeChat', 'chat-fresh');
    localStorage.setItem('webchannel.chatNames', '{}');
    localStorage.setItem('webchannel.pinnedChats', '[]');
    localStorage.removeItem('webchannel.chatTags');
    localStorage.setItem('webchannel.effort', JSON.stringify({ 'chat-fresh': 'high' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restoredAsked = await waitUntil(() => state.effortGetLog.includes(fresh), 15000);
  await sleep(600); // let the 404 reply land
  const restoredToast = await toastText(page);
  check(
    `${pass}: restoring an unsent chat keeps its level without an error`,
    restoredAsked && (await activeEffortLabel(page)) === '高' && !/思考等级/.test(restoredToast),
    JSON.stringify({ asked: restoredAsked, toast: restoredToast }),
  );

  await page.locator('.composer textarea').fill('恢复后的第一条消息');
  await page.keyboard.press('Enter');
  const restoredApplied = await waitUntil(() => state.efforts[fresh] === 'high', 20000);
  await sleep(200);
  const restoredSent = state.effortLog.filter((item) => item.chat === fresh);
  check(
    `${pass}: the restored level is applied after the first turn`,
    restoredApplied &&
      restoredSent.length > 0 &&
      restoredSent[restoredSent.length - 1].created,
    JSON.stringify(restoredSent),
  );
  check(
    `${pass}: applying a deferred level is silent`,
    !/思考等级/.test(await toastText(page)),
    await toastText(page),
  );

  // ---- M27.2: new chat — pick the level before the first message ---------
  resetState();
  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.chatNames', '{}');
    localStorage.setItem('webchannel.pinnedChats', '[]');
    localStorage.removeItem('webchannel.chatTags');
    localStorage.removeItem('webchannel.effort');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await openDrawer();
  await page.locator('.new-chat').click();
  await sleep(300);
  const newId = await page.evaluate(
    () => localStorage.getItem('webchannel.activeChat') || '',
  );
  state.notCreated.add(newId);
  await page.locator('.effort-opt', { hasText: /^高$/ }).click();
  const pickLogged = await waitUntil(
    () => state.effortLog.some((item) => item.chat === newId && item.level === 'high'),
    15000,
  );
  await sleep(600);
  const pickToast = await toastText(page);
  check(
    `${pass}: picking a level before the chat exists is silent and kept`,
    Boolean(newId) &&
      pickLogged &&
      !/思考等级/.test(pickToast) &&
      (await activeEffortLabel(page)) === '高',
    JSON.stringify({ newId, pickLogged, toast: pickToast }),
  );
  check(
    `${pass}: the pre-creation write really was a 404`,
    state.effortLog.some((item) => item.chat === newId && !item.created),
    JSON.stringify(state.effortLog.filter((item) => item.chat === newId)),
  );

  await page.locator('.composer textarea').fill('新会话的第一条消息');
  await page.keyboard.press('Enter');
  const newApplied = await waitUntil(() => state.efforts[newId] === 'high', 20000);
  await sleep(200);
  const attempts = state.effortLog.filter((item) => item.chat === newId);
  check(
    `${pass}: the pre-creation choice is applied after the first message`,
    newApplied && attempts.length >= 2 && attempts[attempts.length - 1].created,
    JSON.stringify({ newApplied, attempts }),
  );
  check(
    `${pass}: the server-confirmed level matches the choice`,
    (await activeEffortLabel(page)) === '高' && state.efforts[newId] === 'high',
    `${await activeEffortLabel(page)} / ${state.efforts[newId]}`,
  );
  check(
    `${pass}: the deferred apply is silent`,
    !/思考等级/.test(await toastText(page)),
    await toastText(page),
  );

  // ---- M27.3: a real rejection on an existing chat stays visible ---------
  state.effortReject[newId] = 'max';
  await page.locator('.effort-opt', { hasText: /^最大$/ }).click();
  await page.waitForSelector('.toast', { timeout: 5000 }).catch(() => {});
  const rejectToast = await toastText(page);
  check(
    `${pass}: a 422 on an existing chat is still reported`,
    /思考等级未生效/.test(rejectToast) && /mock model rejects this level/.test(rejectToast),
    rejectToast,
  );
  check(
    `${pass}: a rejected level rolls back to the confirmed one`,
    (await activeEffortLabel(page)) === '高',
    await activeEffortLabel(page),
  );

  state.effortReject = {};
  resetState();
}

// ---------------------------------------------------------------------------
// M26 — sidebar evidence: BEFORE/AFTER screenshots + density
// ---------------------------------------------------------------------------

/**
 * A full, realistic sidebar. Long CJK titles prove the row ellipsizes without
 * wrapping, and 14 chats overflow any phone-scale drawer at 44–52 px a row.
 */
const M26_CHATS = [
  '构建 QwenPaw WebChannel 的完整设计记录',
  '关于多模态检索增强生成流程的评审意见',
  '每周同步：路线图与优先级调整',
  '把侧边栏重做成成熟产品该有的样子',
  '京都七日：行程、预算与备选方案',
  'Kubernetes 集群升级复盘（含回滚预案）',
  '读书笔记：《设计中的设计》第三章节',
  '给新同事的入职说明与常用链接',
  '数据导出格式讨论：Markdown 还是 JSON',
  'DeepSeek 长上下文推理的价格对比',
  '重构 relay 心跳：hb / hb_ack 方案',
  '移动端 44px 触控规范的落地清单',
  '周末露营装备清单与采购预算',
  '把会议纪要整理成可执行的待办列表',
];

/**
 * M26 evidence is deliberately structure-agnostic: it only opens the drawer,
 * sets the theme and screenshots. That lets the same block produce the BEFORE
 * shots against the pre-redesign build and the AFTER shots afterwards.
 *
 * Screenshots: <OUT_DIR>/m26-<pass>-<theme>.png
 * Run BEFORE with `OUT_DIR=./m26-shots/before node e2e_m19.mjs`.
 */
async function runM26Evidence(page, pass, mobile) {
  resetState();
  // The M14 descriptor is 390×664 (chrome-less phone layout); the M26 brief
  // asks for the full 390×844 canvas, so the evidence shots use it explicitly.
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  state.chats = M26_CHATS.map((title, index) => ({
    chat: `chat-m26-${String(index + 1).padStart(2, '0')}`,
    title,
    updated_at: `2026-10-${String(28 - index).padStart(2, '0')}T09:00:00Z`,
  }));
  state.history = Object.fromEntries(state.chats.map((item) => [item.chat, HISTORY]));
  const ids = state.chats.map((item) => item.chat);

  for (const theme of ['dark', 'light']) {
    await page.evaluate(
      ({ chatIds, active, mode }) => {
        localStorage.setItem('webchannel.chats', JSON.stringify(chatIds));
        localStorage.setItem('webchannel.activeChat', active);
        localStorage.setItem('webchannel.pinnedChats', JSON.stringify([chatIds[2]]));
        localStorage.setItem(
          'webchannel.chatTags',
          JSON.stringify({ [chatIds[1]]: ['工作', '重要'], [chatIds[3]]: ['读书'] }),
        );
        localStorage.setItem('webchannel.chatNames', '{}');
        localStorage.setItem('webchannel.theme', mode);
      },
      { chatIds: ids, active: ids[0], mode: theme },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHistory(page);
    await sleep(500);
    if (mobile && !(await page.locator('.app.sidebar-open').count())) {
      await page.locator('.hamburger').click();
      await sleep(450);
    }

    const density = await page.evaluate(() => {
      const list = document.querySelector('.chat-list');
      if (!list) return null;
      const lr = list.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.chat-item')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top * 10) / 10,
          bottom: Math.round(r.bottom * 10) / 10,
          height: Math.round(r.height * 10) / 10,
          flat: getComputedStyle(el).boxShadow === 'none',
        };
      });
      const visible = rows.filter((row) => row.top >= lr.top - 1 && row.bottom <= lr.bottom + 1);
      return {
        drawerHeight: Math.round(innerHeight),
        listHeight: Math.round(lr.height),
        rows: rows.length,
        visible: visible.length,
        heights: [...new Set(rows.map((row) => row.height))],
        flat: rows.every((row) => row.flat),
      };
    });
    const target = 8;
    check(
      `${pass}: M26 ${theme} drawer shows ≥${target} full chat rows`,
      Boolean(density && density.visible >= target),
      JSON.stringify(density),
    );
    if (density && density.heights.length === 1) {
      check(
        `${pass}: M26 ${theme} chat rows are ${density.heights[0]}px (44–52 px spec)`,
        density.heights[0] >= 44 && density.heights[0] <= 52,
        JSON.stringify(density.heights),
      );
    }
    check(`${pass}: M26 ${theme} chat rows are flat`, Boolean(density && density.flat), JSON.stringify(density));

    const path = join(OUT_DIR, `m26-${pass}-${theme}.png`);
    await page.screenshot({ path, fullPage: false });
    log(`${pass}: M26 ${theme} evidence → ${path} (${density ? density.visible : '?'} rows visible)`);

    // The ⋯ menu shot is M26-only evidence (skipped on the BEFORE build).
    if (await page.locator('.chat-item .chat-more').count()) {
      await page.locator('.chat-item .chat-more').nth(1).click();
      await page.waitForSelector('.chat-menu', { timeout: 4000 });
      await sleep(320);
      await page.screenshot({
        path: join(OUT_DIR, `m26-${pass}-${theme}-menu.png`),
        fullPage: false,
      });
      await page.keyboard.press('Escape');
      await sleep(180);
    }

    if (mobile) {
      await page.locator('.sidebar-close').click();
      await sleep(300);
    }
  }
  resetState();
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

    if (process.env.M26_ONLY === '1') {
      await runM26Checks(page, pass, mobile);
      await runM26Evidence(page, pass, mobile);
      check(`${pass}: no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
      return;
    }

    if (process.env.M27_ONLY === '1') {
      await runM27Checks(page, pass, mobile);
      check(`${pass}: no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
      return;
    }

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

    // ---- 4. pinning (M26: behind the row's ⋯ menu) -----------------------
    await openDrawer();
    await openRowMenu(page, 'Beta 会话');
    await clickMenuItem(page, '置顶');
    const pinned = await page.evaluate(() => {
      const label = document.querySelector('.chat-group-label');
      const firstItem = document.querySelector('.chat-item');
      return {
        label: label ? (label.textContent || '').trim() : '',
        first: firstItem ? (firstItem.querySelector('.chat-id') || {}).textContent : '',
        stored: localStorage.getItem('webchannel.pinnedChats'),
        menu: document.querySelectorAll('.chat-menu').length,
      };
    });
    check(`${pass}: pin creates a 置顶 group`, pinned.label === '置顶', pinned.label);
    check(`${pass}: pinned chat sits in the group`, pinned.first === 'chat-beta', pinned.first);
    check(`${pass}: pin persists in localStorage`, pinned.stored === '["chat-beta"]', pinned.stored || 'null');
    check(`${pass}: the pin menu closes after the action`, pinned.menu === 0, String(pinned.menu));
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

    // ---- 6. keyboard shortcuts (M23: Ctrl/⌘+K is a command palette) ------
    await openCommandPalette(page);
    const paletteOpen = await commandLabels(page);
    check(
      `${pass}: Ctrl/Cmd+K opens the command palette`,
      paletteOpen.focused.includes('cmd-input') && paletteOpen.groups.includes('操作'),
      JSON.stringify({ focused: paletteOpen.focused, groups: paletteOpen.groups }),
    );
    check(
      `${pass}: the palette lists actions and chats in two groups`,
      paletteOpen.groups.includes('操作') &&
        paletteOpen.groups.includes('会话') &&
        paletteOpen.rows.some((row) => row.label === '新建会话') &&
        paletteOpen.rows.some((row) => row.label === 'Alpha 会话'),
      JSON.stringify(paletteOpen.groups),
    );
    await page.screenshot({ path: shot(pass, 'm23-palette'), fullPage: false });

    await page.locator('.cmd-input').fill('会话');
    await sleep(150);
    const filteredPalette = await commandLabels(page);
    check(
      `${pass}: one query filters actions and chat titles`,
      filteredPalette.rows.some((row) => row.label === '新建会话') &&
        filteredPalette.rows.some((row) => row.label === 'Alpha 会话') &&
        !filteredPalette.rows.some((row) => row.label === '切换主题'),
      JSON.stringify(filteredPalette.rows.map((row) => row.label)),
    );

    const firstActive = filteredPalette.rows.findIndex((row) => row.active);
    await page.keyboard.press('ArrowDown');
    await sleep(80);
    const downActive = (await commandLabels(page)).rows.findIndex((row) => row.active);
    await page.keyboard.press('ArrowUp');
    await sleep(80);
    const upActive = (await commandLabels(page)).rows.findIndex((row) => row.active);
    check(
      `${pass}: arrow keys move the palette selection`,
      firstActive === 0 && downActive === 1 && upActive === 0,
      JSON.stringify({ firstActive, downActive, upActive }),
    );

    await page.keyboard.press('Escape');
    await sleep(150);
    const paletteClosed = await page.evaluate(
      () => document.querySelectorAll('.cmd-palette').length,
    );
    check(`${pass}: Escape closes the palette`, paletteClosed === 0);

    // Enter executes a chat row: the palette jumps to that conversation.
    await openCommandPalette(page);
    await page.locator('.cmd-input').fill('Alpha');
    await sleep(120);
    await page.keyboard.press('Enter');
    await sleep(350);
    const paletteJump = await page.evaluate(() => ({
      active: localStorage.getItem('webchannel.activeChat'),
      palette: document.querySelectorAll('.cmd-palette').length,
    }));
    check(
      `${pass}: Enter on a chat row opens that chat`,
      paletteJump.active === 'chat-alpha' && paletteJump.palette === 0,
      JSON.stringify(paletteJump),
    );

    const searchState = await activateSearch(page);
    check(
      `${pass}: 全文搜索 still focuses the archive search`,
      /chat-search/.test(searchState.active) && searchState.tag === 'INPUT' && !searchState.palette,
      JSON.stringify(searchState),
    );
    if (mobile) {
      check(`${pass}: 全文搜索 opens the drawer on mobile`, searchState.drawer === true);
    }
    await page.keyboard.type('Alpha');
    await sleep(250);
    const filtered = await page.evaluate(() => document.querySelectorAll('.chat-item').length);
    check(`${pass}: typing filters the chat list`, filtered === 1, String(filtered));
    await page.locator('.chat-search').fill('');

    if (mobile) {
      // 全文搜索 just opened the drawer; its scrim would swallow the header tap.
      if (await page.locator('.app.sidebar-open').count()) {
        await page.locator('.sidebar-close').click();
        await sleep(300);
      }
      await page.locator('.top-more-btn').click();
      await sleep(150);
      await page.locator('.top-menu button[aria-label="打开命令面板"]').click();
      await page.waitForSelector('.cmd-palette', { timeout: 4000 });
      await sleep(180);
      const fromMenu = await page.evaluate(() => ({
        palette: Boolean(document.querySelector('.cmd-palette')),
        focused: document.activeElement ? document.activeElement.className : '',
      }));
      check(
        `${pass}: the header menu opens the palette on mobile`,
        fromMenu.palette && fromMenu.focused.includes('cmd-input'),
        JSON.stringify(fromMenu),
      );
      await page.keyboard.press('Escape');
      await sleep(150);
    }

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

    // ---- 8. M23: tags, command palette, search jump ----------------------
    await runM23Checks(page, pass, mobile);

    // ---- 9. M24: all-chats usage dashboard -------------------------------
    await runM24Checks(page, pass, mobile);

    // ---- 10. M25: bulk export (progress, failures, cancel) ----------------
    await runM25Checks(page, pass, mobile);

    // ---- 11. M26: sidebar redesign (⋯ menu flows) -------------------------
    await runM26Checks(page, pass, mobile);

    // ---- 12. M26: sidebar evidence (BEFORE/AFTER shots + density) ---------
    await runM26Evidence(page, pass, mobile);

    // ---- 13. M27: deferred thinking level (pre-creation 404) -------------
    await runM27Checks(page, pass, mobile);

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

  const browser = await chromium.launch({ headless: !HEADED, env: BROWSER_ENV });
  try {
    const namingProblem = await probeDownloadNames(browser);
    check('browser can name a non-ASCII download (UTF-8 locale)', !namingProblem, namingProblem);
    if (namingProblem) throw new Error(namingProblem);
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
