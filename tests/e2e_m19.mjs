#!/usr/bin/env node
/**
 * M19 — SPA polish pack E2E (items 1–4, 6; item 5 is asserted alongside the
 * meter) plus the M22 SPA experience pack (dark theme, highlighting,
 * paste-to-attach, per-chat drafts, prompt library), the M23 pack (chat
 * tags, Ctrl/⌘+K command palette, archive search jump) and the M24 pack
 * (all-chats usage dashboard: totals, day chart, ranking, empty state), the
 * M28 pack (cache hit/miss/rate cards, the per-model breakdown with its
 * `—` case, and the day cache strip), the M25 pack (导出全部: progress,
 * failure accounting, cancel), the M26 pack (compact sidebar rows, the
 * per-row ⋯ menu on phone + desktop, and BEFORE/AFTER drawer evidence), and
 * the M27 pack (a thinking level chosen before the chat's ChatSpec exists:
 * silent 404, applied after the first turn, while a real 422 stays visible),
 * and the M34 pack (备份全部会话: one .zip, every .md byte-identical to the
 * single-chat export, index.md/backup.json, failure and cancel paths), and the
 * M36 pack (LaTeX: lazy KaTeX chunk, frozen-block math during a stream,
 * code/currency exemptions, and the 390px wide-formula scroller).
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
 *   M34_ONLY=1         run only the M34 backup checks (fast loop)
 *   M36_ONLY=1         run only the M36 math checks (fast loop)
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
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/**
 * M35: the attachment entries the mock serves are the *real* plugin output,
 * not a hand-shaped mock. `real_history_m35.json` was produced by
 * `plugin/tests/test_m35.py` from a QwenPaw v2.2.2.post1
 * `GET /api/chats/{id}` body (ConsoleChannel.stream_one + Agent ingestion +
 * SafeJSONSession + chats.api.get_chat) projected through
 * `plugin/util.py::history_messages`. The key order below is the projection's
 * own, and `REAL_SINGLE_FILES` is what a reload of an uploaded image must
 * look like.
 */
const REAL_HISTORY = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'real_history_m35.json'), 'utf-8'),
);
const REAL_HIST_FILES = REAL_HISTORY.single.hist[0].files;
const REAL_FILE_KEYS = Object.keys(REAL_HIST_FILES[0]);
/** The 179-byte PNG the hosted acceptance used (also the M31 sample). */
const ATT_PNG = readFileSync(join(HERE, 'fixtures', 'm31-acceptance.png'));
/** IHDR dimensions of the fixture: the decoded <img> must match the bytes. */
const ATT_PNG_WIDTH = ATT_PNG.readUInt32BE(16);
const ATT_PNG_HEIGHT = ATT_PNG.readUInt32BE(20);

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

/**
 * M36: a chat whose history exercises every math path at once — inline math,
 * a display block, a deliberately wide formula (390px scroll check), currency
 * that must stay literal, and `$x$` inside both code forms.
 */
const M36_WIDE_FORMULA =
  '\\displaystyle \\sum_{k=1}^{n} \\frac{k^4 + 3k^3 + 7k^2 + 11k + 13}' +
  '{k^5 + 5k^4 + 9k^3 + 13k^2 + 17k + 19} + ' +
  '\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx + ' +
  '\\prod_{j=1}^{m} \\left(1 + \\frac{1}{j^2}\\right) = \\sqrt{\\frac{\\pi^3}{2}}';
const M36_HISTORY = [
  { role: 'user', text: '解释一下质能方程和勾股定理' },
  {
    role: 'assistant',
    text: [
      '质能方程 $E = mc^2$ 是相对论的核心，勾股定理 $a^2 + b^2 = c^2$ 同样经典。',
      '',
      '价格写作 $5 和 $10 时不应被当成公式。',
      '',
      '$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$',
      '',
      `$$\n${M36_WIDE_FORMULA}\n$$`,
      '',
      '行内代码 `$x$` 必须原样保留：',
      '',
      '```js',
      'const tex = "$x$";',
      '```',
    ].join('\n'),
  },
];
/** M36 streaming fixture: one inline + one display formula, then more prose. */
const M36_STREAM_TEXT = [
  '先看行内公式 $E=mc^2$，它在段落结束前应保持原文。',
  '',
  '块级公式即将出现：',
  '',
  '$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$',
  '',
  '公式之后还有一段很长的说明文字，用来把上面的块推进冻结区，让断言有足够的时间观察“冻结块已渲染、活尾巴仍是原文”的同时状态，而不是在流结束之后才看到结果。',
  '',
  '结束。',
].join('\n');

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
 * M24/M28: the plugin's `stats` payload. Same shape the real handler builds,
 * with the numbers the local probe produced (95 turns over two
 * container-local days from two Kilo models) plus one unknown-model bucket,
 * so the cache columns, the hit-rate bar and the `—` case all render.
 *
 * Internally consistent: the model rows and the day buckets each add up to
 * the totals, and the second day reports cache for only part of its input
 * (eligible < input), which is the real-world case.
 */
const DEFAULT_STATS = {
  totals: {
    turns: 98, input: 1_708_974, output: 12_714,
    cache_hit: 341_141, cache_miss: 1_307_833,
    cache_eligible: 1_648_974, cache_hit_rate: 20.69,
  },
  by_model: [
    {
      provider: 'kilo', model: 'openrouter/free', turns: 52,
      input: 892_049, output: 6_330, cache_hit: 26_038,
      cache_miss: 866_011, cache_eligible: 892_049, cache_hit_rate: 2.92,
    },
    {
      provider: 'kilo', model: 'kilo-auto/free', turns: 43,
      input: 756_925, output: 5_984, cache_hit: 315_103,
      cache_miss: 441_822, cache_eligible: 756_925, cache_hit_rate: 41.63,
    },
    { model: '未知模型', turns: 3, input: 60_000, output: 400 },
  ],
  covered_chats: 37,
  uncovered_chats: 2,
  days: [
    {
      date: '2026-10-26', turns: 20, input: 406_196, output: 4_556,
      cache_hit: 12_000, cache_miss: 394_196, cache_eligible: 406_196,
      cache_hit_rate: 2.95,
    },
    {
      date: '2026-10-27', turns: 78, input: 1_302_778, output: 8_158,
      cache_hit: 329_141, cache_miss: 913_637, cache_eligible: 1_242_778,
      cache_hit_rate: 26.48,
    },
  ],
  chats: [
    { chat: 'chat-beta', title: 'Beta 会话', turns: 40, input: 900000, output: 6000 },
    { chat: 'chat-alpha', title: 'Alpha 会话', turns: 30, input: 500000, output: 4000 },
  ],
  day_basis: 'container-local',
  day_tz: 'UTC',
};

/** M24 empty dashboard: real zeros, no days, no ranked chats, no models. */
const EMPTY_STATS = {
  totals: { turns: 0 },
  by_model: [],
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
  /** M31: keep sent turns (with attachments) in the mock history. */
  recordSends: false,
  /** M31: opaque ref -> {name, mime, bytes} for `att_get`. */
  media: {},
  attSeq: 0,
  /** M37: every `msg` the mock actually received, in arrival order. */
  received: [],
};

function resetState() {
  state.chats = [
    { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
    { chat: 'chat-beta', title: 'Beta 会话', updated_at: '2026-10-27T09:00:00Z' },
  ];
  // M31 appends to a chat's history; copy the fixtures so one pass cannot
  // leak turns (or attachment refs) into the next.
  state.history = {
    'chat-alpha': HISTORY.map((message) => ({ ...message })),
    'chat-beta': BETA_HISTORY.map((message) => ({ ...message })),
  };
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
  state.recordSends = false;
  state.media = {};
  state.staged = new Map();
  state.attGets = [];
  state.attSeq = 0;
  state.received = [];
  for (const timer of state.streaming.values()) clearInterval(timer);
  state.streaming.clear();
}

/**
 * M25: a deterministic Markdown document per chat (what the plugin exports).
 * M34: it carries the M20 header lines the backup reads back — `消息条数`
 * comes from the chat's mock history, exactly like the plugin's own count.
 */
function exportDocFor(chat) {
  const title = (state.chats.find((item) => item.chat === chat) || {}).title || chat;
  const messages = (state.history[chat] || []).length;
  return (
    `# ${title}\n\n` +
    '- 导出时间：2026-10-30 09:00:00\n' +
    `- 消息条数：${messages}\n` +
    '- 导出口径：mock 当前历史\n\n' +
    `## 对话\n\n用户：你好\n\n助手：这是 ${chat} 的导出内容。\n`
  );
}

let agent = null;
let seq = 0;
const agentSend = (frame) => {
  if (agent && agent.readyState === 1) agent.send(JSON.stringify(frame));
};

function streamText(chat, text, { chunkSize = 10, delay = 45 } = {}) {
  const previous = state.streaming.get(chat);
  if (previous) clearInterval(previous);
  // ~10 chars per frame: the SPA re-renders often enough to catch duplicates,
  // and the whole reply lasts ~4 s so a scroll-up happens mid-stream.
  const chunks = [];
  for (let at = 0; at < text.length; at += chunkSize) {
    chunks.push(text.slice(at, at + chunkSize));
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
    agentSend({ t: 'msg', chat, seq: seq++, parts: [{ type: 'text', text }] });
    if (state.recordSends) {
      const list = state.history[chat] || (state.history[chat] = []);
      list.push({ role: 'assistant', text });
    }
  }, delay);
  state.streaming.set(chat, timer);
}

function streamReply(chat) {
  streamText(chat, STREAM_TEXT);
}

/** M36: a slower stream so the frozen-head / live-tail window is observable. */
function streamMathReply(chat) {
  streamText(chat, M36_STREAM_TEXT, { chunkSize: 8, delay: 90 });
}

function handleAgentFrame(frame) {
  switch (frame.t) {
    case 'chats':
      agentSend({ t: 'chats', items: state.chats });
      break;
    case 'models':
      agentSend({
        t: 'models',
        items: [{ provider: 'mock', model: 'mock-1', active: true, vision: true }],
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
      // M37: record what actually arrived, in order (the outbox suite asks).
      state.received.push({ chat, text: String(frame.text || ''), at: Date.now() });
      if (state.notCreated.has(chat)) {
        setTimeout(() => state.notCreated.delete(chat), state.createDelay);
      }
      // M31/M35: mirror what QwenPaw persists -- one user turn carrying every
      // attachment of the message (empty text when the turn was
      // attachment-only). The entry is built exactly like the plugin's
      // `_project_history_files`: name, kind, mime, size, ref, in that order,
      // deduplicated by URL (an inline image is one entry, not two).
      if (state.recordSends && Array.isArray(frame.files) && frame.files.length) {
        const files = [];
        for (const file of frame.files) {
          const bytes = file.data
            ? Buffer.from(String(file.data), 'base64')
            : state.staged.get(String(file.ref || '')) || Buffer.alloc(0);
          const ref = `mock-att-${++state.attSeq}`;
          const name = String(file.name || 'attachment');
          const mime = String(file.mime || 'application/octet-stream');
          state.media[ref] = { name, mime, bytes };
          files.push({
            name,
            kind: mime.startsWith('image/') ? 'image' : 'file',
            mime,
            size: typeof file.size === 'number' ? file.size : bytes.length,
            ref,
          });
        }
        const list = state.history[chat] || (state.history[chat] = []);
        list.push({ role: 'user', text: String(frame.text || ''), files });
      }
      if (String(frame.text || '').includes('M36 流式公式')) {
        streamMathReply(chat);
      } else {
        streamReply(chat);
      }
      break;
    }
    case 'att_get': {
      const chat = String(frame.chat || '');
      const id = String(frame.id || '');
      state.attGets.push(String(frame.ref || ''));
      const media = state.media[String(frame.ref || '')];
      if (!media) {
        agentSend({
          t: 'error', code: 'E_ATT', chat, id, detail: 'unknown mock ref',
        });
        break;
      }
      const sha256 = createHash('sha256').update(media.bytes).digest('hex');
      const pieces = [];
      for (let at = 0; at < media.bytes.length; at += 96 * 1024) {
        pieces.push(media.bytes.subarray(at, at + 96 * 1024));
      }
      agentSend({
        t: 'att_begin',
        chat,
        id,
        bytes: media.bytes.length,
        chunks: pieces.length,
        sha256,
        name: media.name,
        mime: media.mime,
      });
      pieces.forEach((piece, i) => {
        agentSend({ t: 'att_chunk', chat, id, i, data: piece.toString('base64') });
      });
      agentSend({ t: 'att_end', chat, id });
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

function connectAgent({ statusDelayMs = 0 } = {}) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/agent`, {
      headers: { Authorization: 'Bearer dev-agent-token' },
    });
    const timer = setTimeout(() => rejectP(new Error('mock agent connect timeout')), 8000);
    const sendStatus = () => {
      if (ws.readyState !== 1) return;
      // M39: the real plugin pushes `status` right after the relay's `ready`
      // (plugin/channel.py:645-647). A caller can delay it to prove the SPA
      // reacts to the relay's presence edge instead.
      ws.send(JSON.stringify({ t: 'status', agent_name: 'mock-agent' }));
    };
    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ t: 'hello', started: Date.now(), session: 'm19-mock' }));
      agent = ws;
      if (statusDelayMs > 0) setTimeout(sendStatus, statusDelayMs);
      else sendStatus();
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

// M37: the outage scenario needs to stop and restart the relay process.
let relayProc = null;

function startRelayProcess() {
  log('starting relay-node…');
  relayProc = background('node', ['server.js'], RELAY_DIR, 'relay');
  return waitHttp(`http://127.0.0.1:${RELAY_PORT}/health`, 'relay-node');
}

async function stopRelayProcess() {
  if (!relayProc) return;
  const child = relayProc;
  relayProc = null;
  await new Promise((resolveP) => {
    const done = () => resolveP();
    child.once('exit', done);
    try {
      child.kill('SIGKILL');
    } catch {
      done();
    }
  });
}

/** Drop the mock agent's socket (the plugin-restart window, relay kept). */
async function disconnectMockAgent() {
  if (!agent) return;
  const ws = agent;
  agent = null;
  await new Promise((resolveP) => {
    ws.once('close', () => resolveP());
    try {
      ws.close();
    } catch {
      resolveP();
    }
    setTimeout(resolveP, 1500);
  });
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
    const ratioOf = (track, fill) => {
      if (!track || !fill) return null;
      const t = track.getBoundingClientRect();
      const f = fill.getBoundingClientRect();
      return t.width > 0 ? Math.round((f.width / t.width) * 1000) / 1000 : null;
    };
    const cards = [...document.querySelectorAll('.stats-card')].map((el) => ({
      label: (el.querySelector('.stats-card-label') || {}).textContent || '',
      value: (el.querySelector('.stats-card-value') || {}).textContent || '',
      sub: (el.querySelector('.stats-card-sub') || {}).textContent || '',
      bar: ratioOf(el.querySelector('.stats-rate'), el.querySelector('.stats-rate-fill')),
    }));
    const models = [...document.querySelectorAll('.stats-model-row')].map((el) => ({
      name: (el.querySelector('.stats-model-title') || {}).textContent || '',
      provider: (el.querySelector('.stats-model-provider') || {}).textContent || '',
      nums: ((el.querySelector('.stats-model-nums') || {}).textContent || '').trim(),
      rate: (el.querySelector('.stats-model-rate-value') || {}).textContent || '',
      hasBar: Boolean(el.querySelector('.stats-rate, .stats-rate-fill')),
      bar: ratioOf(el.querySelector('.stats-rate'), el.querySelector('.stats-rate-fill')),
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
        title: el.getAttribute('title') || '',
        strip: Boolean(el.querySelector('.stats-bar-cache-fill')),
        stripRatio: ratioOf(
          el.querySelector('.stats-bar-cache'),
          el.querySelector('.stats-bar-cache-fill'),
        ),
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
      models,
      bars,
      rows,
      head: text('.stats-title'),
      summary: text('.stats-summary'),
      modelsHead: text('.stats-models .stats-section-head'),
      modelsNote: text('.stats-models-note'),
      chartHead: text('.stats-chart-wrap .stats-section-head'),
      chartLegend: text('.stats-chart-legend'),
      topHead: text('.stats-top .stats-section-head'),
      basis: text('.stats-basis'),
      dialog: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewport: { w: innerWidth, h: innerHeight },
    };
  });

  check(`${pass}: stats view opens from the sidebar`, view.dialog != null, JSON.stringify(view.dialog));
  check(
    `${pass}: stats has five totals cards`,
    view.cards.length === 5,
    view.cards.map((c) => `${c.label}=${c.value}`).join(' · '),
  );
  check(
    `${pass}: totals show input / output / cached / uncached / hit rate`,
    view.cards.map((c) => c.label).join('|') ===
      '输入 tokens|输出 tokens|缓存命中|缓存未命中|缓存命中率',
    view.cards.map((c) => c.label).join(' · '),
  );
  check(
    `${pass}: cache totals come from the frame`,
    view.cards[0].value === '1.7M' &&
      view.cards[1].value === '12.7k' &&
      view.cards[2].value === '341.1k' &&
      view.cards[3].value === '1.3M' &&
      view.cards[4].value === '20.7%',
    view.cards.map((c) => c.value).join(','),
  );
  check(
    `${pass}: hit-rate card draws the 20.69% bar`,
    view.cards[4].bar != null && Math.abs(view.cards[4].bar - 0.207) < 0.02,
    JSON.stringify(view.cards[4].bar),
  );
  check(
    `${pass}: exact input total and hit-rate basis are stated`,
    view.cards[0].sub.includes('1,708,974') &&
      view.cards[4].sub.includes('341.1k') &&
      view.cards[4].sub.includes('1.6M'),
    `${view.cards[0].sub} | ${view.cards[4].sub}`,
  );
  check(
    `${pass}: summary line keeps turns / coverage counts`,
    view.summary.includes('98') &&
      view.summary.includes('37') &&
      view.summary.includes('另有 2 个无数据'),
    view.summary.replace(/\s+/g, ' ').trim(),
  );
  check(
    `${pass}: model rows are sorted by input with turns and tokens`,
    view.models.length === 3 &&
      view.models[0].name === 'openrouter/free' &&
      view.models[0].provider.includes('kilo') &&
      view.models[0].nums.includes('52 轮') &&
      view.models[0].nums.includes('入 892k') &&
      view.models[0].nums.includes('出 6.3k') &&
      view.models[0].nums.includes('命中 26k') &&
      view.models[1].name === 'kilo-auto/free' &&
      view.models[2].name === '未知模型',
    JSON.stringify(view.models),
  );
  check(
    `${pass}: model rows show the hit-rate bar`,
    view.models[0].rate === '2.9%' &&
      view.models[0].hasBar &&
      view.models[1].rate === '41.6%' &&
      view.models[1].bar != null &&
      Math.abs(view.models[1].bar - 0.416) < 0.03,
    JSON.stringify(view.models.map((m) => [m.rate, m.bar])),
  );
  check(
    `${pass}: a model without cache data shows a dash, not 0%`,
    view.models[2].rate === '—' &&
      view.models[2].hasBar === false &&
      view.models[2].nums.includes('3 轮') &&
      view.models[2].nums.includes('入 60k'),
    JSON.stringify(view.models[2]),
  );
  check(
    `${pass}: model header and basis note explain the dash`,
    view.modelsHead.includes('共 3 个模型') &&
      view.modelsNote.includes('没有上报') &&
      view.modelsNote.includes('而不是 0%'),
    `${view.modelsHead} | ${view.modelsNote}`,
  );
  check(
    `${pass}: day chart has one bar per day, ascending`,
    view.bars.length === 2 && view.bars[0].label === '10/26' && view.bars[1].label === '10/27',
    JSON.stringify(view.bars.map((b) => b.label)),
  );
  check(
    `${pass}: bars scale to the peak day`,
    view.bars[0].ratio != null &&
      Math.abs(view.bars[0].ratio - 0.313) < 0.02 &&
      Math.abs(view.bars[1].ratio - 1) < 0.01,
    JSON.stringify(view.bars.map((b) => b.ratio)),
  );
  check(
    `${pass}: every bar keeps its turn count`,
    view.bars[0].turns === '20 轮' && view.bars[1].turns === '78 轮',
    JSON.stringify(view.bars.map((b) => b.turns)),
  );
  check(
    `${pass}: each day carries a cache strip and its exact numbers`,
    view.bars[0].strip &&
      view.bars[1].strip &&
      view.bars[0].title.includes('缓存 12,000/406,196（3.0%）') &&
      view.bars[1].title.includes('缓存 329,141/1,242,778（26.5%）'),
    `${view.bars[0].title} | ${view.bars[1].title}`,
  );
  check(
    `${pass}: day cache strip is drawn against eligible input`,
    view.bars[0].stripRatio != null &&
      Math.abs(view.bars[0].stripRatio - 0.03) < 0.02 &&
      Math.abs(view.bars[1].stripRatio - 0.265) < 0.03,
    JSON.stringify(view.bars.map((b) => b.stripRatio)),
  );
  check(
    `${pass}: chart header names the peak and the cache legend`,
    view.chartHead.includes('峰值') &&
      view.chartHead.includes('1.3M') &&
      view.chartLegend.includes('2/2 天有上报'),
    `${view.chartHead.trim()} | ${view.chartLegend.trim()}`,
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
    `${pass}: basis note states source, cache rules, models and coverage`,
    view.basis.includes('数据来源与覆盖范围') &&
      view.basis.includes('sessions/web/*.json') &&
      view.basis.includes('容器本地时区') &&
      view.basis.includes('（UTC）') &&
      view.basis.includes('未上报的轮次不计入分子和分母') &&
      view.basis.includes('Σ命中') &&
      view.basis.includes('未知模型') &&
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

  // ---- M28 evidence: the phone layout in both themes -------------------
  // Screenshots: <OUT_DIR>/m28-stats-<pass>-<theme>.png
  if (mobile) {
    // The ranking jump above leaves chat-beta open. Its history is plain text,
    // while waitForHistory() proves a restored page by the rendered code block,
    // so reloading chat-beta would time out on the fence. Restore a chat whose
    // history has one instead. This goes through localStorage (same route as
    // the M26 evidence block) because M23's archive search may still filter the
    // sidebar down to no rows.
    await page.evaluate(() => localStorage.setItem('webchannel.activeChat', 'chat-alpha'));
    const previousTheme = await page.evaluate(
      () => localStorage.getItem('webchannel.theme') || '',
    );
    for (const theme of ['dark', 'light']) {
      await page.evaluate((mode) => localStorage.setItem('webchannel.theme', mode), theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForHistory(page);
      await sleep(400);
      await openStatsView();
      const shotState = await page.evaluate(() => {
        const body = document.querySelector('.stats-body');
        const card = document.querySelector('.stats-card-rate');
        const rect = card ? card.getBoundingClientRect() : null;
        return {
          theme: document.documentElement.dataset.theme || '',
          cards: document.querySelectorAll('.stats-card').length,
          models: document.querySelectorAll('.stats-model-row').length,
          pageOverflowX:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflowX: body ? body.scrollWidth - body.clientWidth : 0,
          rateCard: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        };
      });
      check(
        `${pass}: M28 ${theme} stats renders cards, models and no overflow`,
        shotState.theme === theme &&
          shotState.cards === 5 &&
          shotState.models === 3 &&
          shotState.pageOverflowX <= 0 &&
          shotState.bodyOverflowX <= 0 &&
          shotState.rateCard != null &&
          shotState.rateCard.w >= shotState.rateCard.h,
        JSON.stringify(shotState),
      );
      const path = join(OUT_DIR, `m28-stats-${pass}-${theme}.png`);
      await page.screenshot({ path, fullPage: false });
      log(`${pass}: M28 ${theme} evidence → ${path}`);
      await page.keyboard.press('Escape');
      await sleep(200);
    }
    await page.evaluate((mode) => {
      if (mode) localStorage.setItem('webchannel.theme', mode);
      else localStorage.removeItem('webchannel.theme');
    }, previousTheme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHistory(page);
    await sleep(300);
  }

  // ---- Empty state (a real zero, not a missing field) ------------------
  await openStatsView();
  state.stats = JSON.parse(JSON.stringify(EMPTY_STATS));
  await page.locator('.stats-icon-btn[aria-label="刷新用量统计"]').click();
  await page.waitForSelector('.stats-empty', { timeout: 4000 });
  await sleep(250);
  const empty = await page.evaluate(() => ({
    text: ((document.querySelector('.stats-empty') || {}).textContent || '').trim(),
    cards: document.querySelectorAll('.stats-card').length,
    models: document.querySelectorAll('.stats-model-row').length,
    bars: document.querySelectorAll('.stats-bar-col').length,
    rows: document.querySelectorAll('.stats-chat-row').length,
    basis: ((document.querySelector('.stats-basis') || {}).textContent || '').trim(),
  }));
  check(
    `${pass}: empty stats shows an honest empty state`,
    empty.text.includes('还没有可统计的用量') &&
      empty.cards === 0 &&
      empty.models === 0 &&
      empty.bars === 0 &&
      empty.rows === 0,
    JSON.stringify({
      cards: empty.cards, models: empty.models, bars: empty.bars, rows: empty.rows,
    }),
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
// M34 — one-file backup (备份全部会话)
// ---------------------------------------------------------------------------

/**
 * Independent store-only ZIP reader: EOCD → central directory → local header
 * → payload, with its own table CRC. It shares nothing with
 * `spa/src/lib/zip.ts`, so a writer bug cannot hide behind the same code.
 */
function unzipStore(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (end !== directoryOffset + directorySize) {
    throw new Error('central directory does not end at the EOCD');
  }

  const entries = new Map();
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`entry ${i}: bad central header`);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (method !== 0) throw new Error(`${name}: method ${method} is not store`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${name}: bad local header`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + size);
    if (crc32Chunk(data) !== crc) throw new Error(`${name}: payload does not match its CRC`);
    entries.set(name, Buffer.from(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

let crcTable = null;
function crc32Chunk(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Export one chat through the UI and return the downloaded file's bytes. */
async function singleChatExport(page, mobile, chat) {
  await openChat(page, mobile, chat);
  const event = page.waitForEvent('download', { timeout: 10000 });
  if (mobile) {
    await page.locator('.top-more-btn').click();
    await sleep(150);
    await page.locator('.top-menu button', { hasText: '导出 Markdown' }).click();
  } else {
    await page.locator('.top-secondary .icon-btn[aria-label="导出当前会话"]').click();
  }
  const download = await event;
  const path = await download.path();
  if (!path) throw new Error(`no download path for ${chat}`);
  return { name: download.suggestedFilename(), bytes: readFileSync(path) };
}

async function runM34Checks(page, pass, mobile) {
  state.exportFail = [];
  state.exportDelay = 120;

  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(350);
  }
  // M23.5 leaves 归档专属 in the search box, so the sidebar renders no rows.
  // Clear the query (and any tag filter) to get the two fixture chats back
  // before the single-chat baselines are taken.
  await page.locator('.chat-search').fill('');
  const allTags = page.locator('.tag-filter').first();
  if (await allTags.count()) await allTags.click();
  await sleep(250);

  // ---- 1. the action is separate from 导出全部 and states its output -----
  const button = ((await page.locator('.backup-open').textContent()) || '').trim();
  const buttonLabel = await page.locator('.backup-open').getAttribute('aria-label');
  check(
    `${pass}: 备份全部会话 is a separate action beside 导出全部 and says .zip`,
    button.includes('备份全部') &&
      button.includes('.zip') &&
      String(buttonLabel).includes('备份全部会话'),
    `${button} / ${buttonLabel}`,
  );

  // ---- 2. baseline: the same chat through the single-chat export ---------
  const alphaSingle = await singleChatExport(page, mobile, 'chat-alpha');
  const betaSingle = await singleChatExport(page, mobile, 'chat-beta');
  check(
    `${pass}: the single-chat baseline exported both chats`,
    alphaSingle.bytes.length > 0 && betaSingle.bytes.length > 0,
    `${alphaSingle.name} ${alphaSingle.bytes.length} · ${betaSingle.name} ${betaSingle.bytes.length}`,
  );

  // ---- 3. full backup: one download, one archive -------------------------
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(350);
  }
  await page.locator('.backup-open').click();
  let toast = await waitToast(page, '备份完成', 15000);
  await waitUntil(() => downloads.length === 1);
  check(
    `${pass}: a full backup downloads exactly one file`,
    downloads.length === 1,
    JSON.stringify(downloads.map((d) => d.suggestedFilename())),
  );
  const zipName = downloads[0].suggestedFilename();
  check(
    `${pass}: the archive is webchannel-backup-YYYYMMDD-HHmm.zip`,
    /^webchannel-backup-\d{8}-\d{4}\.zip$/.test(zipName),
    zipName,
  );
  const zipPath = await downloads[0].path();
  const zipBytes = readFileSync(zipPath);
  const entries = unzipStore(zipBytes);
  check(
    `${pass}: the archive holds every chat plus index.md and backup.json`,
    entries.size === 4 && entries.has('index.md') && entries.has('backup.json'),
    JSON.stringify([...entries.keys()]),
  );

  const alphaEntry = [...entries.keys()].find(
    (name) => name.startsWith('Alpha 会话-') && name.endsWith('.md'),
  );
  const betaEntry = [...entries.keys()].find(
    (name) => name.startsWith('Beta 会话-') && name.endsWith('.md'),
  );
  check(
    `${pass}: the archive reuses the single-export file names`,
    alphaEntry === alphaSingle.name && betaEntry === betaSingle.name,
    JSON.stringify({ alphaEntry, betaEntry, single: [alphaSingle.name, betaSingle.name] }),
  );
  check(
    `${pass}: every .md is byte-identical to its single-chat export`,
    Boolean(alphaEntry && betaEntry) &&
      entries.get(alphaEntry).equals(alphaSingle.bytes) &&
      entries.get(betaEntry).equals(betaSingle.bytes),
    `${entries.get(alphaEntry)?.length} / ${alphaSingle.bytes.length}`,
  );

  const index = entries.get('index.md').toString('utf8');
  check(
    `${pass}: index.md states the time, both chats and their counts`,
    index.includes('# WebChannel 会话备份') &&
      index.includes('- 备份时间：') &&
      index.includes('| 1 | Alpha 会话 |') &&
      index.includes('| 2 | Beta 会话 |') &&
      index.includes('成功 2'),
    index.slice(0, 400),
  );
  check(
    `${pass}: index.md links each in-archive file`,
    Boolean(alphaEntry && betaEntry) &&
      index.includes(`(<${alphaEntry}>)`) &&
      index.includes(`(<${betaEntry}>)`),
    index.split('\n').filter((line) => line.startsWith('|')).join(' | '),
  );

  const manifest = JSON.parse(entries.get('backup.json').toString('utf8'));
  check(
    `${pass}: backup.json is a machine-readable manifest`,
    manifest.generator === 'qwenpaw-webchannel' &&
      manifest.format === 1 &&
      /^\d{4}-\d{2}-\d{2}T/.test(manifest.generated_at) &&
      typeof manifest.build_id === 'string' &&
      manifest.build_id.length > 0 &&
      manifest.limit === 100 &&
      manifest.chats.length === 2 &&
      manifest.chats.every(
        (chat) => chat.status === 'ok' && chat.filename && typeof chat.messages === 'number',
      ),
    JSON.stringify(manifest).slice(0, 400),
  );
  check(
    `${pass}: backup.json repeats the header message counts`,
    manifest.chats[0]?.messages === state.history['chat-alpha'].length &&
      manifest.chats[1]?.messages === state.history['chat-beta'].length,
    JSON.stringify(manifest.chats.map((chat) => chat.messages)),
  );

  let pythonNote = 'python3 unavailable';
  let pythonNames = '';
  try {
    const out = execFileSync(
      'python3',
      [
        '-c',
        'import sys, zipfile\n' +
          'z = zipfile.ZipFile(sys.argv[1])\n' +
          'assert z.testzip() is None\n' +
          'print("\\n".join(sorted(z.namelist())))',
        zipPath,
      ],
      { encoding: 'utf8' },
    );
    pythonNames = out.trim().split('\n').sort().join('|');
    pythonNote = 'ok';
  } catch (err) {
    pythonNote = String((err && err.stderr) || (err && err.message) || err)
      .trim()
      .slice(0, 200);
  }
  check(
    `${pass}: a stock zip tool accepts the archive (python zipfile)`,
    pythonNote === 'ok' || pythonNote === 'python3 unavailable',
    pythonNote,
  );
  check(
    `${pass}: python zipfile lists the same entries`,
    pythonNote !== 'ok' || pythonNames === [...entries.keys()].sort().join('|'),
    pythonNames,
  );

  // ---- 4. a failed chat lands in index.md and backup.json ----------------
  await dismissToast(page);
  state.exportFail = ['chat-beta'];
  const beforeFailure = downloads.length;
  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(350);
  }
  await page.locator('.backup-open').click();
  toast = await waitToast(page, '备份完成', 15000);
  await waitUntil(() => downloads.length === beforeFailure + 1);
  check(
    `${pass}: a partial backup still downloads and names the failure`,
    toast.text.includes('成功 1') &&
      toast.text.includes('失败 1') &&
      toast.text.includes('Beta 会话') &&
      toast.cls.includes('toast-danger'),
    toast.text,
  );
  let failedEntries = new Map();
  try {
    failedEntries = unzipStore(readFileSync(await downloads[beforeFailure].path()));
  } catch (err) {
    check(`${pass}: the partial archive parses`, false, String(err && err.message));
  }
  const failedIndex = failedEntries.get('index.md')?.toString('utf8') || '';
  check(
    `${pass}: index.md lists the failed chat with its reason`,
    failedIndex.includes('## 失败') &&
      failedIndex.includes('**Beta 会话**（`chat-beta`）') &&
      failedIndex.includes('E_EXPORT') &&
      ![...failedEntries.keys()].some((name) => name.startsWith('Beta 会话-')),
    failedIndex.slice(failedIndex.indexOf('## 失败')),
  );
  const failedManifest = JSON.parse(failedEntries.get('backup.json')?.toString('utf8') || '{}');
  check(
    `${pass}: backup.json records the failure without a file name`,
    failedManifest.failed === 1 &&
      failedManifest.failures?.[0]?.id === 'chat-beta' &&
      String(failedManifest.failures?.[0]?.reason || '').includes('E_EXPORT') &&
      failedManifest.chats?.find((chat) => chat.id === 'chat-beta')?.filename === null,
    JSON.stringify(failedManifest.failures),
  );

  // ---- 5. cancel drops the archive and reports what was finished ---------
  await dismissToast(page);
  state.exportFail = [];
  state.exportDelay = 700;
  const beforeCancel = downloads.length;
  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(350);
  }
  await page.locator('.backup-open').click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.backup-panel .bulk-panel-head');
      return Boolean(el && (el.textContent || '').includes('1/2'));
    },
    null,
    { timeout: 4000 },
  );
  const panelHead = ((await page.locator('.backup-panel .bulk-panel-head').textContent()) || '').trim();
  check(
    `${pass}: the backup panel shows its own progress`,
    panelHead.includes('备份中 1/2'),
    panelHead,
  );
  await page.locator('.backup-cancel').click();
  toast = await waitToast(page, '备份已取消');
  check(
    `${pass}: cancel reports completed and remaining counts`,
    toast.text.includes('已完成 0 个') && toast.text.includes('剩余 2 个未备份'),
    toast.text,
  );
  await sleep(900);
  check(
    `${pass}: cancel downloads nothing`,
    downloads.length === beforeCancel,
    JSON.stringify(downloads.slice(beforeCancel).map((d) => d.suggestedFilename())),
  );
  const panelGone = await page.evaluate(
    () => document.querySelectorAll('.backup-panel').length,
  );
  check(`${pass}: the backup panel closes after a cancel`, panelGone === 0);

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


// ---------------------------------------------------------------------------
// M31 — attachments: send an image, reload, see it come back
// ---------------------------------------------------------------------------

/** 1x1 PNG: valid image bytes, small enough for the v1 inline path. */
async function runM31Checks(page, pass, mobile) {
  resetState();
  state.recordSends = true;
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
  await sleep(300);

  // ---- M31.1: attachment-only image turn --------------------------------
  // The draft is persisted per chat; clear it so this turn really has no text
  // (the point of the check is the attachment-only projection).
  await page.locator('.composer textarea').fill('');
  await page.setInputFiles('.composer input[type=file]', {
    name: '截图.png',
    mimeType: 'image/png',
    buffer: ATT_PNG,
  });
  const ready = await waitUntil(async () => {
    const note = await page.locator('.chips .chip-note').textContent().catch(() => '');
    return Boolean(note && note.includes('已就绪'));
  }, 5000);
  check(`${pass}: an image is picked and staged for sending`, ready);
  await page.locator('.composer .send').click();
  const sentImage = await waitUntil(
    () => (state.history['chat-alpha'] || []).some((m) => m.files && m.files.length),
    10000,
  );
  const streamed = await waitUntil(() => !state.streaming.has('chat-alpha'), 20000);
  check(`${pass}: an attachment-only image turn is sent`, sentImage && streamed);
  const optimistic = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.messages .bubble-files .att-name')].map(
      (el) => (el.textContent || '').trim(),
    ),
  }));
  check(
    `${pass}: the optimistic bubble names the image`,
    optimistic.names.includes('截图.png'),
    JSON.stringify(optimistic),
  );

  // ---- M31.2: the image survives a reload (hist files + att_get) ---------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  const thumbLoaded = await waitUntil(
    () => page.evaluate(() => {
      const img = document.querySelector('.messages img.att-thumb');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }),
    15000,
  );
  const thumb = await page.evaluate(() => {
    const img = document.querySelector('.messages img.att-thumb');
    const row = img ? img.closest('.row') : null;
    return {
      src: img ? img.getAttribute('src') || '' : '',
      alt: img ? img.getAttribute('alt') || '' : '',
      width: img ? img.naturalWidth : 0,
      height: img ? img.naturalHeight : 0,
      rowText: row ? (row.textContent || '').trim() : '',
      bubbleText: row && row.querySelector('.bubble .plain')
        ? (row.querySelector('.bubble .plain').textContent || '')
        : null,
      userRows: document.querySelectorAll('.messages .row.user').length,
    };
  });
  check(
    `${pass}: the image is visible after a history refresh`,
    thumbLoaded &&
      thumb.src.startsWith('blob:') &&
      thumb.alt === '截图.png' &&
      thumb.width === ATT_PNG_WIDTH &&
      thumb.height === ATT_PNG_HEIGHT &&
      thumb.userRows >= 2,
    JSON.stringify(thumb),
  );
  check(
    `${pass}: an attachment-only turn keeps an (empty-text) user row`,
    thumb.bubbleText === '' &&
      !thumb.rowText.includes('已经下载到') &&
      !thumb.rowText.includes('downloaded to'),
    JSON.stringify({ text: thumb.bubbleText, row: thumb.rowText }),
  );

  // ---- M31.3: a non-image attachment keeps its name + download button ----
  await page.setInputFiles('.composer input[type=file]', {
    name: '笔记.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('附件下载测试', 'utf-8'),
  });
  await waitUntil(async () => {
    const note = await page.locator('.chips .chip-note').textContent().catch(() => '');
    return Boolean(note && note.includes('已就绪'));
  }, 5000);
  await page.locator('.composer textarea').fill('请读一下附件');
  await page.locator('.composer .send').click();
  const sentFile = await waitUntil(
    () => (state.history['chat-alpha'] || []).some(
      (m) => m.files && m.files.some((f) => f.name === '笔记.txt'),
    ),
    10000,
  );
  check(`${pass}: a text attachment turn is sent`, sentFile);
  await waitUntil(() => !state.streaming.has('chat-alpha'), 20000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  const chipReady = await waitUntil(
    () => page.evaluate(() => [...document.querySelectorAll('.messages .att-chip .att-name')]
      .some((el) => (el.textContent || '').trim() === '笔记.txt')),
    15000,
  );
  check(`${pass}: a file attachment keeps its name after a refresh`, chipReady);

  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page
    .locator('.messages .att-chip', { hasText: '笔记.txt' })
    .first()
    .locator('.att-download')
    .click();
  const download = await downloadPromise;
  check(
    `${pass}: the file attachment downloads with its own name`,
    download.suggestedFilename() === '笔记.txt',
    download.suggestedFilename(),
  );
  check(
    `${pass}: the retried file turn still shows its text`,
    (await page.locator('.messages .row.user', { hasText: '请读一下附件' }).count()) === 1,
  );

  // ---- M35.0: the mock serves the real plugin's hist shape --------------
  // The entry was built by the mock, but its fields and order are the
  // projection's own (`name, kind, mime, size, ref`). A drift here means the
  // suite is testing an idealized shape again -- exactly the M31 failure.
  const servedEntry = (state.history['chat-alpha'] || [])
    .flatMap((message) => message.files || [])
    .find((file) => file.name === '截图.png');
  check(
    `${pass}: the served hist entry keeps the real projection's fields`,
    Boolean(servedEntry) &&
      JSON.stringify(Object.keys(servedEntry)) === JSON.stringify(REAL_FILE_KEYS),
    JSON.stringify({ served: servedEntry && Object.keys(servedEntry), real: REAL_FILE_KEYS }),
  );
  check(
    `${pass}: the thumbnail was fetched through an opaque ref`,
    Boolean(servedEntry && servedEntry.ref) && state.attGets.includes(servedEntry.ref),
    JSON.stringify({ ref: servedEntry && servedEntry.ref, gets: state.attGets }),
  );

  // ---- M35.1: three attachments in one message --------------------------
  await page.locator('.composer textarea').fill('');
  await page.setInputFiles('.composer input[type=file]', [
    { name: '图一.png', mimeType: 'image/png', buffer: ATT_PNG },
    { name: '图二.png', mimeType: 'image/png', buffer: ATT_PNG },
    { name: '笔记二.txt', mimeType: 'text/plain', buffer: Buffer.from('多附件', 'utf-8') },
  ]);
  const threeChips = await waitUntil(
    () => page.evaluate(() => document.querySelectorAll('.composer .chips .chip').length >= 3),
    8000,
  );
  const chipNames = await page.evaluate(() =>
    [...document.querySelectorAll('.composer .chips .chip')].map((el) =>
      (el.textContent || '').replace('×', '').trim(),
    ),
  );
  check(
    `${pass}: three attachments are pending in one message`,
    threeChips && JSON.stringify(chipNames) === JSON.stringify(['图一.png', '图二.png', '笔记二.txt']),
    JSON.stringify(chipNames),
  );

  // One chip's × removes only that chip.
  await page
    .locator('.composer .chips .chip', { hasText: '图二.png' })
    .locator('.chip-x')
    .click();
  const afterRemove = await page.evaluate(() =>
    [...document.querySelectorAll('.composer .chips .chip')].map((el) =>
      (el.textContent || '').replace('×', '').trim(),
    ),
  );
  check(
    `${pass}: a chip's × removes only that attachment`,
    JSON.stringify(afterRemove) === JSON.stringify(['图一.png', '笔记二.txt']),
    JSON.stringify(afterRemove),
  );
  // Put it back (a second pick appends instead of replacing).
  await page.setInputFiles('.composer input[type=file]', [
    { name: '图二.png', mimeType: 'image/png', buffer: ATT_PNG },
  ]);
  const restored = await waitUntil(
    () => page.evaluate(() => document.querySelectorAll('.composer .chips .chip').length === 3),
    8000,
  );
  check(`${pass}: a later pick appends to the pending list`, restored);
  // 图二 was removed and re-picked, so it now sits last: the wire order is
  // the chip order (append semantics), not the original pick order.
  const pendingOrder = await page.evaluate(() =>
    [...document.querySelectorAll('.composer .chips .chip')].map((el) =>
      (el.textContent || '').replace('×', '').trim(),
    ),
  );

  await page.locator('.composer .send').click();
  const sentMulti = await waitUntil(
    () => (state.history['chat-alpha'] || []).some(
      (m) => m.files && m.files.length === 3,
    ),
    10000,
  );
  await waitUntil(() => !state.streaming.has('chat-alpha'), 20000);
  const multiEntry = (state.history['chat-alpha'] || []).find(
    (m) => m.files && m.files.length === 3,
  );
  check(
    `${pass}: one message carries three attachments in order`,
    sentMulti &&
      JSON.stringify(pendingOrder) === JSON.stringify(['图一.png', '笔记二.txt', '图二.png']) &&
      JSON.stringify(multiEntry.files.map((f) => f.name)) === JSON.stringify(pendingOrder) &&
      JSON.stringify(multiEntry.files.map((f) => f.kind)) ===
        JSON.stringify(['image', 'file', 'image']),
    JSON.stringify(multiEntry && multiEntry.files),
  );
  const optimisticMulti = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.messages .bubble-files .att-name')].map(
      (el) => (el.textContent || '').trim(),
    ),
    thumbs: document.querySelectorAll('.messages img.att-thumb').length,
  }));
  check(
    `${pass}: the optimistic bubble lists every attachment`,
    optimisticMulti.names.includes('图一.png') &&
      optimisticMulti.names.includes('图二.png') &&
      optimisticMulti.names.includes('笔记二.txt'),
    JSON.stringify(optimisticMulti),
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  const multiThumbs = await waitUntil(
    () => page.evaluate(() => {
      const first = document.querySelector('.messages img.att-thumb[alt="图一.png"]');
      const second = document.querySelector('.messages img.att-thumb[alt="图二.png"]');
      return Boolean(
        first && first.complete && first.naturalWidth > 0 &&
        second && second.complete && second.naturalWidth > 0,
      );
    }),
    15000,
  );
  const multiChip = await page.evaluate(() =>
    [...document.querySelectorAll('.messages .att-chip .att-name')].some(
      (el) => (el.textContent || '').trim() === '笔记二.txt',
    ),
  );
  check(
    `${pass}: a three-attachment turn renders two thumbnails and one file chip`,
    multiThumbs && multiChip,
    JSON.stringify({ multiThumbs, multiChip }),
  );

  const multiDownload = page.waitForEvent('download', { timeout: 15000 });
  await page
    .locator('.messages .att-chip', { hasText: '笔记二.txt' })
    .first()
    .locator('.att-download')
    .click();
  const multiFile = await multiDownload;
  check(
    `${pass}: a multi-attachment turn downloads the non-image file`,
    multiFile.suggestedFilename() === '笔记二.txt',
    multiFile.suggestedFilename(),
  );

  // ---- M35.2: the 10-attachment cap -------------------------------------
  await page.locator('.composer textarea').fill('');
  await page.setInputFiles(
    '.composer input[type=file]',
    Array.from({ length: 11 }, (_, index) => ({
      name: `批${index}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('x', 'utf-8'),
    })),
  );
  const capped = await waitUntil(
    () => page.evaluate(() => document.querySelectorAll('.composer .chips .chip').length === 10),
    8000,
  );
  const capError = await page.locator('.composer-error').textContent().catch(() => '');
  check(
    `${pass}: an 11th attachment is refused with the cap stated`,
    capped && Boolean(capError && capError.includes('10')),
    JSON.stringify({ chips: capped, error: capError }),
  );
  const chipXs = page.locator('.composer .chips .chip .chip-x');
  for (let left = await chipXs.count(); left > 0; left = await chipXs.count()) {
    await chipXs.first().click();
    await sleep(20);
  }
  check(
    `${pass}: every pending chip can be removed`,
    (await page.evaluate(() => document.querySelectorAll('.composer .chips .chip').length)) === 0,
  );
}

// ---------------------------------------------------------------------------
// M36 — LaTeX: lazy chunk, frozen-block rendering, code/currency exemptions
// ---------------------------------------------------------------------------

async function runM36Checks(page, pass, mobile) {
  resetState();
  state.chats = [
    { chat: 'chat-alpha', title: 'Alpha 会话', updated_at: '2026-10-28T09:00:00Z' },
    { chat: 'chat-math', title: 'Math 会话', updated_at: '2026-10-29T09:00:00Z' },
  ];
  state.history['chat-math'] = M36_HISTORY.map((message) => ({ ...message }));

  await page.evaluate(() => {
    localStorage.setItem('webchannel.chats', JSON.stringify(['chat-alpha', 'chat-math']));
    localStorage.setItem('webchannel.activeChat', 'chat-alpha');
    localStorage.setItem('webchannel.chatNames', '{}');
    localStorage.setItem('webchannel.pinnedChats', '[]');
    localStorage.removeItem('webchannel.chatTags');
    localStorage.removeItem('webchannel.search');
    localStorage.setItem('webchannel.theme', 'dark');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistory(page);
  await sleep(400);

  // ---- M36.1: nothing math-related is fetched for a math-free chat -------
  const beforeResources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /katex/i.test(name)),
  );
  check(
    `${pass}: KaTeX is not fetched for a math-free chat`,
    beforeResources.length === 0,
    JSON.stringify(beforeResources),
  );

  if (mobile && !(await page.locator('.app.sidebar-open').count())) {
    await page.locator('.hamburger').click();
    await sleep(400);
  }
  await page.locator('.chat-item', { hasText: 'Math 会话' }).click();
  await sleep(400);
  if (mobile && (await page.locator('.app.sidebar-open').count())) {
    await page.locator('.sidebar-close').click();
    await sleep(350);
  }
  const mathLoaded = await waitUntil(
    () =>
      page.evaluate(
        () => document.querySelectorAll('.messages .row.assistant .md .katex').length >= 4,
      ),
    15000,
  );
  check(`${pass}: opening a math chat lazy-loads and renders KaTeX`, mathLoaded);

  // ---- M36.2: history projection ----------------------------------------
  const view = await page.evaluate(async () => {
    await document.fonts.ready;
    const md = [...document.querySelectorAll('.messages .row.assistant .md')].pop();
    if (!md) return null;
    const text = md.textContent || '';
    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name);
    return {
      spans: md.querySelectorAll('.math').length,
      inlineSpans: md.querySelectorAll('.math-inline').length,
      blockSpans: md.querySelectorAll('.math-block').length,
      katex: md.querySelectorAll('.katex').length,
      done: md.querySelectorAll('.math[data-math-state="done"]').length,
      pending: md.querySelectorAll('.math[data-math-state="pending"]').length,
      rawDollars: text.includes('$$'),
      currency: text.includes('$5 和 $10'),
      inlineCode: [...md.querySelectorAll('p code, li code')].some(
        (el) => (el.textContent || '') === '$x$',
      ),
      fencedCode: [...md.querySelectorAll('pre code')].some(
        (el) => (el.textContent || '').includes('$x$'),
      ),
      mathColor: md.querySelector('.katex')
        ? getComputedStyle(md.querySelector('.katex')).color
        : '',
      textColor: getComputedStyle(md).color,
      fontMain: document.fonts.check('16px KaTeX_Main'),
      js: resources.filter((name) => /\/assets\/katex-.*\.js$/.test(name)).length,
      css: resources.filter((name) => /\/assets\/katex-.*\.css$/.test(name)).length,
      fonts: resources.filter((name) => /\/assets\/KaTeX_.*\.woff2$/.test(name)).length,
      others: resources.filter((name) => /katex/i.test(name) && !/\/assets\//.test(name)),
    };
  });
  check(
    `${pass}: history renders 2 inline + 2 display formulas`,
    Boolean(view) &&
      view.spans === 4 &&
      view.inlineSpans === 2 &&
      view.blockSpans === 2 &&
      view.katex === 4 &&
      view.done === 4 &&
      view.pending === 0,
    JSON.stringify(view),
  );
  check(
    `${pass}: no raw $$ survives and currency text stays literal`,
    Boolean(view) && view.rawDollars === false && view.currency === true,
    JSON.stringify(view && { raw: view.rawDollars, currency: view.currency }),
  );
  check(
    `${pass}: $x$ inside inline code and a fenced block stays literal`,
    Boolean(view) && view.inlineCode && view.fencedCode,
    JSON.stringify(view && { inline: view.inlineCode, fenced: view.fencedCode }),
  );
  check(
    `${pass}: math inherits the message color in dark mode`,
    Boolean(view) && view.mathColor !== '' && view.mathColor === view.textColor,
    JSON.stringify(view && { math: view.mathColor, text: view.textColor }),
  );
  check(
    `${pass}: KaTeX chunk, CSS and a self-hosted font were fetched on demand`,
    Boolean(view) && view.js >= 1 && view.css >= 1 && view.fonts >= 1 && view.fontMain,
    JSON.stringify(view && { js: view.js, css: view.css, fonts: view.fonts, font: view.fontMain }),
  );

  // ---- M36.3: light theme is readable too -------------------------------
  const themes = await page.evaluate(async () => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    const out = {};
    for (const mode of ['dark', 'light']) {
      root.dataset.theme = mode;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const md = [...document.querySelectorAll('.messages .row.assistant .md')].pop();
      out[mode] = {
        math: md ? getComputedStyle(md.querySelector('.katex')).color : '',
        text: md ? getComputedStyle(md).color : '',
      };
    }
    if (previous) root.dataset.theme = previous;
    return out;
  });
  check(
    `${pass}: math inherits the message color in both themes`,
    themes.dark.math === themes.dark.text &&
      themes.light.math === themes.light.text &&
      themes.dark.text !== themes.light.text,
    JSON.stringify(themes),
  );

  // ---- M36.4: a wide formula scrolls inside its block at 390px ----------
  const layout = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.messages .math-block')];
    const block = blocks.find((el) => el.scrollWidth > el.clientWidth + 20) || blocks[0];
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return {
      docWidth: document.documentElement.scrollWidth,
      innerWidth,
      client: block.clientWidth,
      scroll: block.scrollWidth,
      left: Math.round(rect.left),
      right: Math.round(rect.right),
    };
  });
  check(
    `${pass}: a wide formula never widens the page`,
    Boolean(layout) &&
      layout.docWidth <= layout.innerWidth + 1 &&
      layout.left >= 0 &&
      layout.right <= layout.innerWidth + 1,
    JSON.stringify(layout),
  );
  if (mobile) {
    check(
      `${pass}: the wide formula has its own horizontal scroller at 390px`,
      Boolean(layout) && layout.scroll > layout.client,
      JSON.stringify(layout),
    );
  }

  // ---- M36.5: click-to-copy LaTeX (bonus) -------------------------------
  let copied = '';
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const tex = await page.evaluate(
      () => (document.querySelector('.messages .math') || {}).dataset?.tex || '',
    );
    await page.locator('.messages .math').first().click();
    copied = await page.evaluate(() => navigator.clipboard.readText());
    check(
      `${pass}: clicking a formula copies its LaTeX source`,
      Boolean(tex) && copied === tex,
      JSON.stringify({ copied, tex }),
    );
  } catch (error) {
    check(`${pass}: clicking a formula copies its LaTeX source`, false, String(error));
  }

  // ---- M36.6: streaming — tail plain, frozen blocks settle --------------
  await page.locator('.composer textarea').fill('M36 流式公式');
  await page.locator('.composer .send').click();
  const streamStarted = await waitUntil(
    () => page.evaluate(() => Boolean(document.querySelector('.caret'))),
    6000,
  );

  // One polling loop rather than two sequential waits: the window where the
  // display block is frozen AND the tail is still arriving is short, so both
  // observations must be sampled together.
  let tailPlainSeen = false;
  let frozenSeen = false;
  let lastSnap = null;
  const deadline = Date.now() + 18000;
  while (streamStarted && Date.now() < deadline) {
    lastSnap = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.messages .row')];
      const last = rows[rows.length - 1];
      const head = last ? last.querySelector('.md-head') : null;
      const tail = last ? last.querySelector('.md-tail') : null;
      const tailText = tail ? tail.textContent || '' : '';
      return {
        caret: Boolean(document.querySelector('.caret')),
        tailText: tailText.slice(0, 40),
        tailKatex: tail ? tail.querySelectorAll('.katex').length : 0,
        headKatex: head ? head.querySelectorAll('.math[data-math-state="done"] .katex').length : 0,
        tailPlain:
          Boolean(tail) &&
          tailText.includes('$E=mc^2$') &&
          tail.querySelectorAll('.katex').length === 0,
        frozen: Boolean(
          document.querySelector('.caret') &&
            head &&
            head.querySelector('.math-block[data-math-state="done"] .katex') &&
            head.querySelector('.math-inline[data-math-state="done"] .katex'),
        ),
      };
    });
    if (lastSnap.tailPlain) tailPlainSeen = true;
    if (lastSnap.frozen) {
      frozenSeen = true;
      break;
    }
    if (!lastSnap.caret) break;
    await sleep(50);
  }
  check(
    `${pass}: the math reply turns on the streaming caret`,
    streamStarted,
    JSON.stringify(lastSnap),
  );
  check(
    `${pass}: the live tail keeps literal $...$ while it streams`,
    tailPlainSeen,
    JSON.stringify(lastSnap),
  );
  check(
    `${pass}: completed blocks render math while the reply still streams`,
    frozenSeen,
    JSON.stringify(lastSnap),
  );

  await waitUntil(() => !state.streaming.has('chat-math'), 20000);
  const settled = await waitUntil(
    () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('.messages .row')];
        const last = rows[rows.length - 1];
        if (!last || document.querySelector('.caret')) return false;
        const md = last.querySelector('.md');
        if (!md) return false;
        const text = md.textContent || '';
        return (
          md.querySelectorAll('.katex').length === 2 &&
          md.querySelectorAll('.math[data-math-state="pending"]').length === 0 &&
          !text.includes('$$')
        );
      }),
    15000,
  );
  check(`${pass}: the settled reply shows both formulas and no raw delimiters`, settled);

  await page.screenshot({ path: shot(pass, 'math-history'), fullPage: false });
}

// ---------------------------------------------------------------------------
// M37 — offline send queue (outbox)
// ---------------------------------------------------------------------------

/**
 * The whole point of the outbox: a message the user sends while the backend
 * is gone must (a) never look delivered, (b) survive a reload, (c) go out in
 * order exactly once when the backend returns, (d) turn into the ordinary
 * local echo without a second bubble.
 */
async function runM37Checks(page, pass, mobile) {
  const snap = () =>
    page.evaluate(() => {
      const textOf = (row) => (row.querySelector('.plain') || row.querySelector('.bubble-text') || row).textContent.trim();
      return {
        labels: [...document.querySelectorAll('.status-label')].map((node) => node.textContent),
        pending: [...document.querySelectorAll('.messages .row.pending')].map((row) => ({
          id: row.getAttribute('data-outbox-id'),
          state: row.getAttribute('data-outbox-state'),
          text: textOf(row),
          hasCancel: Boolean(row.querySelector('button[aria-label="撤销这条待发送消息"]')),
        })),
        userRows: [...document.querySelectorAll('.messages .row.user:not(.pending)')].map((row) => textOf(row)),
        stored: localStorage.getItem('webchannel.outbox'),
        input: (document.querySelector('textarea') || {}).value || '',
        error: (document.querySelector('.composer-error') || {}).textContent || '',
      };
    });

  const sendText = async (text) => {
    await page.locator('textarea').fill(text);
    await page.locator('button.send').click();
    await sleep(250);
  };

  const scrollToEnd = async () => {
    await page.evaluate(() => {
      const el = document.querySelector('.messages');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await sleep(200);
  };

  // A clean chat: M36 left chat-math selected and its history on screen.
  await openChat(page, mobile, 'chat-alpha');
  await waitUntil(
    () => page.evaluate(() => document.querySelectorAll('.messages .row.user').length > 0),
    8000,
  );

  // ---- 1. online baseline -------------------------------------------------
  const baselineId = `M37 基线-${pass}`;
  await sendText(baselineId);
  const baselineArrived = await waitUntil(
    () => state.received.some((item) => item.text === baselineId),
    6000,
  );
  const baselineSnap = await snap();
  check(`${pass}: M37 baseline reaches the agent over the live path`, baselineArrived);
  check(
    `${pass}: M37 a live send has no pending row`,
    baselineSnap.pending.length === 0 && baselineSnap.userRows.includes(baselineId),
    JSON.stringify(baselineSnap.pending),
  );
  check(
    `${pass}: M37 a live send still echoes one user bubble`,
    baselineSnap.userRows.filter((text) => text === baselineId).length === 1,
  );
  // Let the mock's reply finish before the outage: its timers are global to
  // the process and would otherwise keep streaming into a dead socket.
  await waitUntil(() => !state.streaming.has('chat-alpha'), 20000);

  // ---- 2. relay down: two sends queue up --------------------------------
  await stopRelayProcess();
  const wentOffline = await waitUntil(
    () =>
      page.evaluate(() => {
        const label = document.querySelector('.status-label');
        return Boolean(label && ['恢复中', '连接中', '离线', '同步中'].includes(label.textContent));
      }),
    10000,
  );
  check(`${pass}: M37 killing the relay moves the header off 已连接`, wentOffline, JSON.stringify((await snap()).labels));

  const one = `M37 待发一-${pass}`;
  const two = `M37 待发二-${pass}`;
  await sendText(one);
  await sendText(two);
  const queued = await snap();
  check(
    `${pass}: M37 both offline sends show as 待发送 rows`,
    queued.pending.length === 2 &&
      queued.pending.every((row) => row.state === 'queued') &&
      queued.pending[0].text === one &&
      queued.pending[1].text === two,
    JSON.stringify(queued.pending),
  );
  check(
    `${pass}: M37 a queued row is cancellable and is not an ordinary bubble`,
    queued.pending.every((row) => row.hasCancel) &&
      !queued.userRows.includes(one) &&
      !queued.userRows.includes(two),
    JSON.stringify(queued.userRows),
  );
  check(`${pass}: M37 queueing clears the composer and shows no error`, queued.input === '' && queued.error === '', JSON.stringify({ input: queued.input, error: queued.error }));
  check(
    `${pass}: M37 the queue is persisted under webchannel.outbox`,
    (() => {
      try {
        const stored = JSON.parse(queued.stored || '[]');
        return (
          Array.isArray(stored) &&
          stored.filter((entry) => entry.chat === 'chat-alpha' && entry.status === 'queued').length === 2
        );
      } catch {
        return false;
      }
    })(),
    String(queued.stored).slice(0, 200),
  );
  check(
    `${pass}: M37 nothing reached the agent while it was down`,
    !state.received.some((item) => item.text === one || item.text === two),
  );

  await scrollToEnd();
  await page.screenshot({ path: shot(pass, 'm37-queued'), fullPage: false });

  // ---- 3. reload: the queue survives ------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(900);
  const restored = await snap();
  check(
    `${pass}: M37 the queue survives a reload`,
    restored.pending.length === 2 &&
      restored.pending[0].text === one &&
      restored.pending[1].text === two &&
      restored.pending.every((row) => row.state === 'queued'),
    JSON.stringify(restored.pending),
  );

  // ---- 4. backend back: in order, once, no duplicate bubbles ------------
  await startRelayProcess();
  await sleep(300);
  await connectAgent();
  const delivered = await waitUntil(
    () => state.received.filter((item) => item.text === one).length === 1 && state.received.filter((item) => item.text === two).length === 1,
    20000,
  );
  const order = state.received
    .filter((item) => item.text === one || item.text === two)
    .map((item) => (item.text === one ? 1 : 2))
    .join(',');
  check(`${pass}: M37 both queued messages are delivered after reconnect`, delivered);
  check(`${pass}: M37 delivery keeps queue order`, order === '1,2', order);
  check(
    `${pass}: M37 each queued message arrives exactly once`,
    state.received.filter((item) => item.text === one).length === 1 &&
      state.received.filter((item) => item.text === two).length === 1,
    JSON.stringify(state.received.map((item) => item.text)),
  );

  const settled = await waitUntil(async () => {
    const now = await snap();
    return now.pending.length === 0 && now.userRows.includes(one) && now.userRows.includes(two);
  }, 10000);
  const after = await snap();
  check(`${pass}: M37 the pending rows become ordinary bubbles`, settled, JSON.stringify(after.pending));
  check(
    `${pass}: M37 no message is shown twice`,
    after.userRows.filter((text) => text === one).length === 1 &&
      after.userRows.filter((text) => text === two).length === 1,
    JSON.stringify(after.userRows.filter((text) => text === one || text === two)),
  );
  check(
    `${pass}: M37 the drained queue is cleared from storage`,
    (() => {
      try {
        const stored = JSON.parse(after.stored || '[]');
        return Array.isArray(stored) && stored.filter((entry) => entry.chat === 'chat-alpha').length === 0;
      } catch {
        return false;
      }
    })(),
    String(after.stored).slice(0, 200),
  );

  // ---- 5. the agent leaves behind a live socket: presence ----------------
  // M39 replaces the old M37 gap (the header kept 在线 until a reconnect):
  // the relay broadcasts the slot edge, so the SPA knows before it writes
  // anything. The two replies must be finished first: a dead agent can never
  // send `end`, and the composer would be stuck on 停止.
  await waitUntil(() => !state.streaming.has('chat-alpha'), 20000);
  await disconnectMockAgent();
  const flipped = await waitUntil(async () => {
    const labels = (await snap()).labels;
    return labels[0] === '已连接' && labels[1] === 'Agent 离线';
  }, 6000);
  check(
    `${pass}: M39 the agent leaving behind a live socket flips the header to Agent 离线`,
    flipped,
    JSON.stringify((await snap()).labels),
  );

  // Same flag, same decision: a send now queues instead of being written to a
  // live socket whose peer is gone (that is the M37 "sent but unconfirmed"
  // path, which must not be the first thing a user sees any more).
  const off = `M37 离线入队-${pass}`;
  await sendText(off);
  const queuedOffline = await snap();
  check(
    `${pass}: M39 a send after the offline presence queues as 待发送, not 未确认`,
    queuedOffline.pending.length === 1 &&
      queuedOffline.pending[0].text === off &&
      queuedOffline.pending[0].state === 'queued' &&
      !queuedOffline.userRows.includes(off),
    JSON.stringify({ pending: queuedOffline.pending, users: queuedOffline.userRows }),
  );
  check(
    `${pass}: M39 nothing is handed to the relay while the agent is offline`,
    !state.received.some((item) => item.text === off),
  );

  // Single-item cancel: the row goes away, its text returns to the composer,
  // and the queue forgets it (no ghost that would send later).
  await page.locator('.row.pending button[aria-label="撤销这条待发送消息"]').click();
  await sleep(200);
  const cancelled = await snap();
  check(
    `${pass}: M37 撤销 drops exactly that entry and restores its text`,
    cancelled.pending.length === 0 && cancelled.input === off,
    JSON.stringify({ pending: cancelled.pending, input: cancelled.input }),
  );
  check(
    `${pass}: M37 a cancelled entry is gone from storage`,
    (() => {
      try {
        const stored = JSON.parse(cancelled.stored || '[]');
        return Array.isArray(stored) && stored.every((entry) => entry.id !== 'x' && !String(entry.text).includes(off));
      } catch {
        return false;
      }
    })(),
    String(cancelled.stored).slice(0, 160),
  );
  await sendText(off);
  check(`${pass}: M37 the re-sent offline message queues again`, (await snap()).pending.length === 1);

  // `ready{agentOnline:false}` is still authoritative for a fresh connection
  // (presence is an edge and is never replayed), and the queue survives it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const offlineReady = await snap();
  check(
    `${pass}: M37 a reconnect while the agent is down reports Agent 离线`,
    offlineReady.labels[0] === '已连接' && offlineReady.labels[1] === 'Agent 离线',
    JSON.stringify(offlineReady.labels),
  );
  check(
    `${pass}: M37 the queued offline message survives the reload`,
    offlineReady.pending.length === 1 && offlineReady.pending[0].text === off,
    JSON.stringify(offlineReady.pending),
  );

  // The agent returns. Its own `status` push is delayed on purpose: the header
  // flip and the queue flush below must come from the relay's presence edge —
  // the new M39 path. The status push still follows, as a second trigger that
  // must not send anything twice.
  await connectAgent({ statusDelayMs: 1500 });
  const onlineAgain = await waitUntil(async () => {
    const labels = (await snap()).labels;
    return labels[0] === '已连接' && labels[1] === 'Agent 在线';
  }, 1000);
  check(
    `${pass}: M39 the online presence flips the header back to Agent 在线 (status push still pending)`,
    onlineAgain,
    JSON.stringify((await snap()).labels),
  );
  const statusFlushed = await waitUntil(
    () => state.received.filter((item) => item.text === off).length === 1,
    12000,
  );
  const drained = await waitUntil(async () => (await snap()).pending.length === 0, 1200);
  check(`${pass}: M39 the online presence flushes the queue (status push is the second trigger)`, statusFlushed);
  check(`${pass}: M37 the queued row disappears once delivered`, drained);
  check(
    `${pass}: M37 the agent-offline message is shown exactly once`,
    state.received.filter((item) => item.text === off).length === 1 &&
      (await snap()).userRows.filter((text) => text === off).length === 1,
  );

  // ---- 6. interrupted flush: history is the only proof ------------------
  // Two entries claim "handed to a socket, connection lost". One of them is
  // really in the chat's history, the other never arrived. The reconcile must
  // remove the first, flag the second, and append no duplicate history rows.
  const known = `M37 已在历史-${pass}`;
  const unknown = `M37 未确认-${pass}`;
  state.history['chat-alpha'] = [...(state.history['chat-alpha'] || []), { role: 'user', text: known }];
  await page.evaluate(
    ([knownText, unknownText]) => {
      const entry = (id, text, ts) => ({
        id,
        chat: 'chat-alpha',
        text,
        display: text,
        raw: text,
        status: 'sent',
        unconfirmed: true,
        echo: true,
        attempts: 1,
        ts,
      });
      localStorage.setItem(
        'webchannel.outbox',
        JSON.stringify([entry('m37-known', knownText, 1), entry('m37-unknown', unknownText, 2)]),
      );
    },
    [known, unknown],
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  const reconciled = await waitUntil(
    async () => {
      const now = await snap();
      return (
        now.pending.length === 1 &&
        now.pending[0].state === 'unconfirmed' &&
        now.pending[0].text.includes(unknown)
      );
    },
    15000,
  );
  const recon = await snap();
  check(`${pass}: M37 history confirms the entry that did arrive`, reconciled, JSON.stringify(recon.pending));
  check(
    `${pass}: M37 the unconfirmed entry is kept, flagged for the user`,
    recon.pending.length === 1 &&
      recon.pending[0].state === 'unconfirmed' &&
      recon.pending[0].hasCancel,
    JSON.stringify(recon.pending),
  );
  check(
    `${pass}: M37 the reconcile adds no duplicate history row`,
    recon.userRows.filter((text) => text === known).length === 1,
    JSON.stringify(recon.userRows.filter((text) => text.includes('M37'))),
  );

  await scrollToEnd();
  await page.screenshot({ path: shot(pass, 'm37-unconfirmed'), fullPage: false });
}

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

    if (process.env.M34_ONLY === '1') {
      await runM34Checks(page, pass, mobile);
      check(`${pass}: no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
      return;
    }

    if (process.env.M36_ONLY === '1') {
      await runM36Checks(page, pass, mobile);
      check(`${pass}: no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
      return;
    }

    if (process.env.M37_ONLY === '1') {
      await runM37Checks(page, pass, mobile);
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

    // ---- 10b. M34: one-file backup (zip, index.md, backup.json) -----------
    await runM34Checks(page, pass, mobile);

    // ---- 11. M26: sidebar redesign (⋯ menu flows) -------------------------
    await runM26Checks(page, pass, mobile);

    // ---- 12. M26: sidebar evidence (BEFORE/AFTER shots + density) ---------
    await runM26Evidence(page, pass, mobile);

    // ---- 13. M27: deferred thinking level (pre-creation 404) -------------
    await runM27Checks(page, pass, mobile);

    // ---- 14. M31: attachments survive a history refresh -------------------
    await runM31Checks(page, pass, mobile);

    // ---- 15. M36: LaTeX math (lazy, frozen blocks, code/currency) --------
    await runM36Checks(page, pass, mobile);

    // ---- 16. M37: offline send queue (last: it restarts the relay) -------
    await runM37Checks(page, pass, mobile);

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
  await startRelayProcess();

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
