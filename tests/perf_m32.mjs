#!/usr/bin/env node
/**
 * M32 — long-chat performance harness (measurement only, no assertions).
 *
 * Builds a deterministic 300-message mixed fixture (prose + code fences +
 * tables + attachment chips + per-turn receipts), serves the production SPA
 * with `vite preview`, drives it with a mock agent on relay-node, and records
 * the four metrics the M32 brief asks for, on desktop (1280x900) and a 390px
 * phone (390x844):
 *
 *   1. open  — document start -> 300 rows + two animation frames (medians)
 *   2. stream— long tasks + frame intervals while a long reply streams, on the
 *              300-message chat and on a 2-message control chat (the delta is
 *              the cost of re-rendering the list per delta)
 *   3. typing— keydown -> next animation frame latency during that stream
 *   4. scroll— `.messages` scrollTop=0 -> stable top row, plus the long tasks
 *              the scroll's re-render causes
 *
 * Same page/protocol as tests/e2e_m19.mjs; run from the repo root:
 *
 *   M32_LABEL=before node tests/perf_m32.mjs
 *   M32_LABEL=after  node tests/perf_m32.mjs
 *
 * Writes tests/perf-m32-<label>.json and prints a summary table. Env:
 *   M32_SKIP_BUILD=1   reuse spa/dist
 *   M32_PREVIEW_PORT   default 4191
 *   M32_HEADED=1       visible browser
 *   M32_RUNS           open-to-interactive repetitions (default 5)
 *   M32_STREAM_RUNS    repetitions per stream scenario (default 2)
 *   M32_SHOT=1         save a mid-stream screenshot (tests/m32-stream.png)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPA_DIR = join(ROOT, 'spa');
const RELAY_DIR = join(ROOT, 'relay-node');
const PREVIEW_PORT = Number(process.env.M32_PREVIEW_PORT || 4191);
const RELAY_PORT = Number(process.env.M32_RELAY_PORT || 8787);
const BASE = `http://127.0.0.1:${PREVIEW_PORT}/`;
const LABEL = process.env.M32_LABEL || 'run';
const RUNS = Number(process.env.M32_RUNS || 5);
const HEADED = process.env.M32_HEADED === '1';
/** Each stream scenario runs twice; the table uses the mean of both. */
const STREAM_RUNS = Number(process.env.M32_STREAM_RUNS || 2);
/** Skip the scaling opens and the mobile pass (hotspot profiling loops). */
const FAST = process.env.M32_FAST === '1';

const require = createRequire(join(ROOT, 'mock', 'package.json'));
const WebSocket = require('ws');

const log = (...args) => console.log('[m32-perf]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PARA =
  '长对话的性能问题往往不在单条消息，而在“每来一个增量就把整个页面重新算一遍”。这一段文字用来模拟真实会话里的大段说明：它足够长，能撑出纵向高度，也让 Markdown 解析与布局测量有真实的分量。';
const PARA2 =
  '渲染路径里最容易忽略的是布局抖动：流式期间容器高度每一帧都在变化，如果滚动位置依赖测量结果，就会触发强制同步布局（forced reflow），把本来可以合并的帧拆成多次主线程工作。';

const CODE_PY = `\`\`\`python
import time
from dataclasses import dataclass

@dataclass
class Frame:
    seq: int
    delta: str

def coalesce(frames, window_ms=16):
    """Merge deltas that arrive inside one animation frame."""
    out = []
    batch = []
    budget = 0
    for frame in frames:
        batch.append(frame.delta)
        budget += 1
        if budget * 4 >= window_ms:
            out.append("".join(batch))
            batch = []
            budget = 0
    if batch:
        out.append("".join(batch))
    return out

started = time.perf_counter()
merged = coalesce([Frame(i, "t") for i in range(200)])
print(len(merged), time.perf_counter() - started)
\`\`\``;

const CODE_JS = `\`\`\`javascript
export function frameBudget(now, last) {
  const delta = now - last;
  return {
    delta,
    missed: delta > 50,
    // 60 fps budget is 16.7 ms; anything past 50 ms is a visible hitch.
    headroom: Math.max(0, 16.7 - delta),
  };
}
\`\`\``;

const CODE_SH = `\`\`\`bash
$ node tests/perf_m32.mjs
[perf] open=812ms rows=300 longtasks=3/240ms
[perf] stream chunks=160 longtasks=41/3.2s
$ echo "baseline captured"
\`\`\``;

const TABLE = [
  '| 指标 | 优化前 | 优化后 | 说明 |',
  '| --- | --- | --- | --- |',
  '| 首屏渲染 | 820 ms | 240 ms | 300 条消息 |',
  '| 流式长任务 | 3.4 s | 0.4 s | 单条长回复 |',
  '| 打字延迟 p95 | 180 ms | 22 ms | 手机视口 |',
  '| 回滚到顶部 | 0 ms | 18 ms | 最近 N 条窗口 |',
].join('\n');

/** 300 mixed messages: prose, code fences, tables, receipts, file chips. */
function longHistory(count = 300) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (i % 2 === 0) {
      const user = {
        role: 'user',
        text:
          i % 10 === 0
            ? `第 ${i + 1} 条提问：请把刚才的结论整理成一份可以复用的检查清单，并说明每一步的观测方法。`
            : `第 ${i + 1} 条：继续。`,
      };
      if (i % 37 === 0) {
        user.files = [
          { name: `trace-${i}.json`, mime: 'application/json', size: 48213, kind: 'file' },
        ];
      }
      out.push(user);
      continue;
    }
    const parts = [`## 第 ${i + 1} 条回答`, PARA, PARA2];
    if (i % 6 === 1) parts.push(CODE_PY);
    if (i % 6 === 3) parts.push(TABLE);
    if (i % 6 === 5) parts.push(CODE_JS, CODE_SH);
    parts.push(
      [
        `1. 第 ${i + 1} 步：先确认帧预算，再决定是否合并增量。`,
        `2. 第 ${i + 1} 步：把解析结果按消息内容做缓存，内容不变就不重新解析。`,
        `3. 第 ${i + 1} 步：代码高亮延迟到流结束，避免每个 delta 都重跑一遍。`,
      ].join('\n'),
    );
    out.push({
      role: 'assistant',
      text: parts.join('\n\n'),
      turn: { id: `turn-${i}`, input: 1200 + i * 13, output: 300 + i },
    });
  }
  return out;
}

const SHORT_HISTORY = [
  { role: 'user', text: '给我一段 Python 代码' },
  {
    role: 'assistant',
    text: `这是示例：\n\n${CODE_PY}\n\n${PARA}`,
    turn: { id: 'turn-short', input: 1200, output: 340 },
  },
];

/** The streamed reply: ~1.6k chars, two code fences and a table. */
const STREAM_TEXT = [
  '下面按“测量 → 定位 → 验证”的顺序给出一份可以直接复用的分析。',
  PARA,
  CODE_PY,
  TABLE,
  PARA2,
  CODE_JS,
  PARA,
  '最后强调一点：任何优化都必须用同一套方法复测，否则只是换了一种卡顿。',
].join('\n\n');

/**
 * Same length, no Markdown syntax at all: the difference against STREAM_TEXT
 * isolates the per-delta Markdown parse cost from the list re-render cost.
 */
const STREAM_PLAIN = Array.from(
  { length: Math.ceil(STREAM_TEXT.length / PARA.length) },
  (_, i) => `第 ${i + 1} 段纯文本回答，没有代码块与表格，只用来对照解析成本。${PARA}`,
).join('。').slice(0, STREAM_TEXT.length);

function streamChunks(text, size) {
  const chunks = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// Mock agent
// ---------------------------------------------------------------------------

const state = {
  chats: [
    { chat: 'chat-long', title: '长会话 300 条', updated_at: '2026-10-30T09:00:00Z' },
    { chat: 'chat-short', title: '短会话', updated_at: '2026-10-29T09:00:00Z' },
    { chat: 'chat-100', title: '长会话 100 条', updated_at: '2026-10-28T09:00:00Z' },
    { chat: 'chat-200', title: '长会话 200 条', updated_at: '2026-10-28T08:00:00Z' },
  ],
  history: {
    'chat-long': longHistory(300),
    'chat-short': SHORT_HISTORY,
    'chat-100': longHistory(100),
    'chat-200': longHistory(200),
  },
  streaming: new Map(),
  /** Send STREAM_PLAIN (no Markdown syntax) for the next reply. */
  plainNext: false,
  streams: 0,
};

let agent = null;
let seq = 0;
const agentSend = (frame) => {
  if (agent && agent.readyState === 1) agent.send(JSON.stringify(frame));
};

function streamReply(chat) {
  const previous = state.streaming.get(chat);
  if (previous) clearInterval(previous);
  const text = state.plainNext ? STREAM_PLAIN : STREAM_TEXT;
  state.plainNext = false;
  const chunks = streamChunks(text, 10);
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
  }, 24);
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
        items: [{ provider: 'mock', model: 'mock-1', active: true, vision: true }],
      });
      break;
    case 'skills':
      agentSend({ t: 'skills', items: [] });
      break;
    case 'hist':
      agentSend({ t: 'hist', chat: String(frame.chat || ''), messages: state.history[frame.chat] || [] });
      break;
    case 'get_usage':
      agentSend({
        t: 'usage',
        chat: String(frame.chat || ''),
        input_total: 12345,
        output_total: 678,
        context_tokens: 4321,
        context_limit: 32768,
      });
      break;
    case 'get_stats':
      agentSend({ t: 'stats', id: frame.id, totals: { turns: 0 }, by_model: [], days: [], chats: [] });
      break;
    case 'get_effort':
      agentSend({
        t: 'effort',
        chat: String(frame.chat || ''),
        level: 'default',
        effective: 'inherit',
        supported: ['low', 'medium', 'high', 'max'],
        kind: 'budget',
        model_key: 'mock:mock-1',
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
      ws.send(JSON.stringify({ t: 'hello', started: Date.now(), session: 'm32-mock' }));
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
      if (frame.t === 'ready' || frame.t === 'peer' || frame.t === 'pong' || frame.t === 'hb_ack') return;
      handleAgentFrame(frame);
    });
    ws.on('error', err => rejectP(err));
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
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') log(`[${label}] exited ${code}\n${out.slice(0, 2000)}`);
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
// In-page probes
// ---------------------------------------------------------------------------

/** Install the long-task observer + frame clock before the app boots. */
function installProbes() {
  const m = {
    t0: performance.now(),
    longtasks: [],
    frames: [],
    keys: [],
    observer: null,
    onKey: null,
  };
  window.__m32 = m;
  m.observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) m.longtasks.push({ start: entry.startTime, duration: entry.duration });
  });
  m.observer.observe({ type: 'longtask', buffered: false });
  m.onKey = (event) => {
    if (!event.target || event.target.tagName !== 'TEXTAREA') return;
    const started = event.timeStamp;
    requestAnimationFrame((ts) => m.keys.push(ts - started));
  };
  window.addEventListener('keydown', m.onKey, true);
}

const resetLongTasks = () => {
  const m = window.__m32;
  m.longtasks = [];
  m.frames = [];
  m.keys = [];
  // Only present in an instrumented build; harmless otherwise.
  if (window.__m32prof) {
    window.__m32prof = { parse: 0, sanitize: 0, mdN: 0, hl: 0, hlN: 0, decorate: 0, viewN: 0 };
  }
  // `readAndStop` removed both, so a second measurement on the same page needs
  // a fresh observer/listener, not just cleared arrays.
  m.observer.disconnect();
  m.observer.observe({ type: 'longtask', buffered: false });
  window.removeEventListener('keydown', m.onKey, true);
  window.addEventListener('keydown', m.onKey, true);
  // Generation token: a loop left pending by the previous run must die when
  // the next run resets, or two rAF loops would interleave and halve the gaps.
  m.gen = (m.gen || 0) + 1;
  const gen = m.gen;
  const loop = (ts) => {
    if (m.gen !== gen) return;
    m.frames.push(ts);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

const readAndStop = () => {
  const m = window.__m32;
  m.gen = (m.gen || 0) + 1;
  m.observer.disconnect();
  window.removeEventListener('keydown', m.onKey, true);
  return { longtasks: m.longtasks, frames: m.frames, keys: m.keys, prof: window.__m32prof || null };
};

function buildContext(browser, viewport, mobile, active) {
  return browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    locale: 'zh-CN',
  }).then(async (context) => {
    await context.addInitScript(installProbes);
    await context.addInitScript(
      ({ chat }) => {
        window.__m32Seed = chat;
        if (localStorage.getItem('m32.seeded')) return;
        localStorage.setItem('m32.seeded', '1');
        localStorage.setItem(
          'webchannel.chats',
          JSON.stringify(['chat-long', 'chat-short', 'chat-100', 'chat-200']),
        );
        localStorage.setItem('webchannel.activeChat', chat);
        localStorage.setItem('webchannel.chatNames', '{}');
        localStorage.removeItem('webchannel.drafts');
      },
      { chat: active },
    );
    return context;
  });
}

async function openPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

/** Wait until the restored chat has rendered `expected` message rows. */
async function waitRows(page, expected) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.messages .row').length >= count,
    expected,
    { timeout: 60000 },
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function measureOpen(browser, viewport, mobile, active, expected) {
  const context = await buildContext(browser, viewport, mobile, active);
  const { page, errors } = await openPage(context);
  try {
    await waitRows(page, expected);
    const data = await page.evaluate((want) => {
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        open_ms: performance.now() - window.__m32.t0,
        rows: document.querySelectorAll('.messages .row').length,
        nodes: document.querySelectorAll('*').length,
        pre_blocks: document.querySelectorAll('.md pre').length,
        pre_copies: document.querySelectorAll('.md pre .pre-copy').length,
        tables: document.querySelectorAll('.md table').length,
        splash: Boolean(document.querySelector('#boot-splash')),
        dom_content_loaded: nav ? nav.domContentLoadedEventEnd : null,
        expected: want,
        // Settled message typography: the last block must still lose its
        // bottom margin (the head is the only child once the tail is empty).
        settled: (() => {
          const bubbles = [...document.querySelectorAll('.row.assistant .md')];
          const md = bubbles[bubbles.length - 1];
          if (!md) return null;
          const blocks = [...md.querySelectorAll('.md-head > *, .md-tail > *')];
          const last = blocks[blocks.length - 1];
          return {
            blocks: blocks.length,
            tails: md.querySelectorAll('.md-tail').length,
            lastMarginBottom: last ? getComputedStyle(last).marginBottom : null,
          };
        })(),
      };
    }, expected);
    return { data, errors };
  } finally {
    await context.close();
  }
}

/** Stream one reply and record long tasks / frame gaps / typing latency. */
async function measureStream(page, plain = false) {
  state.plainNext = plain;
  await page.evaluate(resetLongTasks);
  const started = Date.now();
  await page.locator('.composer textarea').fill('性能测试：请重新分析一遍');
  await page.locator('.send').click();
  await page.waitForFunction(() => document.querySelectorAll('.bubble.streaming').length > 0, null, {
    timeout: 15000,
  });
  // Type into the composer while the reply is streaming (~40% in).
  await sleep(900);
  const layout = await page.evaluate(() => {
    const bubble = document.querySelector('.bubble.streaming');
    if (!bubble) return null;
    const head = bubble.querySelector('.md-head');
    const tail = bubble.querySelector('.md-tail');
    const blocks = [...bubble.querySelectorAll('.md-head > *, .md-tail > *')];
    const gaps = [];
    for (let i = 1; i < blocks.length; i += 1) {
      const a = blocks[i - 1].getBoundingClientRect();
      const b = blocks[i].getBoundingClientRect();
      gaps.push(Math.round(b.top - a.bottom));
    }
    return {
      headDisplay: head ? getComputedStyle(head).display : null,
      tailDisplay: tail ? getComputedStyle(tail).display : null,
      headBlocks: head ? head.children.length : 0,
      tailBlocks: tail ? tail.children.length : 0,
      gaps: gaps.slice(-8),
      firstMarginTop: blocks[0] ? getComputedStyle(blocks[0]).marginTop : null,
      lastMarginBottom: blocks.length
        ? getComputedStyle(blocks[blocks.length - 1]).marginBottom
        : null,
      tailClass: tail ? tail.className : null,
    };
  });
  await page.locator('.composer textarea').click();
  await page.keyboard.type('typing latency probe', { delay: 40 });
  if (process.env.M32_SHOT === '1' && !plain) {
    await page.evaluate(() => {
      const el = document.querySelector('.messages');
      if (el) {
        el.style.scrollBehavior = 'auto';
        el.scrollTop = el.scrollHeight;
      }
    });
    await sleep(120);
    await page.screenshot({ path: join(HERE, 'm32-stream.png') });
  }
  await page.waitForFunction(() => document.querySelectorAll('.bubble.streaming').length === 0, null, {
    timeout: 60000,
  });
  const wall = Date.now() - started;
  const raw = await page.evaluate(readAndStop);
  return { ...summarizeStream(raw, wall), layout };
}

/** Run one stream scenario `n` times and average its numeric metrics. */
async function measureStreamRuns(page, plain = false, n = STREAM_RUNS) {
  const runs = [];
  for (let i = 0; i < n; i += 1) runs.push(await measureStream(page, plain));
  const out = { runs: runs.map((r) => r.wall_ms), n, layout: runs.map((r) => r.layout).find(Boolean) || null };
  const first = runs[0];
  for (const key of Object.keys(first)) {
    if (typeof first[key] !== 'number') continue;
    const values = runs.map((r) => r[key]).filter((v) => typeof v === 'number');
    out[key] = values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  }
  for (const key of ['frame_p50_by_quarter', 'frame_mean_by_quarter']) {
    out[key] = first[key].map((_, i) =>
      round(runs.reduce((sum, r) => sum + (r[key][i] || 0), 0) / runs.length),
    );
  }
  return out;
}

function stats(list, key) {
  if (!list.length) return { n: 0, p50: null, p95: null, max: null, sum: null };
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: list.length,
    p50: round(at(0.5)),
    p75: round(at(0.75)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    max: round(Math.max(...list)),
    sum: round(list.reduce((a, b) => a + b, 0)),
  };
}

const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

function summarizeStream(raw, wall) {
  const gaps = [];
  for (let i = 1; i < raw.frames.length; i += 1) gaps.push(raw.frames[i] - raw.frames[i - 1]);
  const long = raw.longtasks || [];
  const longTotal = long.reduce((sum, item) => sum + item.duration, 0);
  const typing = (raw.keys || []).filter((v) => Number.isFinite(v) && v >= 0);
  // Per-quarter medians: the list cost is constant per frame, the Markdown
  // parse cost grows with the accumulated text, so a rising curve is evidence
  // that re-parsing (not re-rendering) dominates the tail of the stream.
  const quarter = Math.max(1, Math.floor(gaps.length / 4));
  const quarters = [0, 1, 2, 3].map((i) =>
    gaps.slice(i * quarter, i === 3 ? gaps.length : (i + 1) * quarter),
  );
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  return {
    wall_ms: wall,
    longtask_count: long.length,
    longtask_total_ms: round(longTotal),
    longtask_max_ms: long.length ? round(Math.max(...long.map((i) => i.duration))) : 0,
    frames: gaps.length,
    frame_mean_ms: round(mean(gaps)),
    frame_p50_ms: stats(gaps).p50,
    frame_p75_ms: stats(gaps).p75,
    frame_p90_ms: stats(gaps).p90,
    frame_p95_ms: stats(gaps).p95,
    frame_max_ms: stats(gaps).max,
    frames_over_20: gaps.filter((g) => g > 20).length,
    frames_over_50: gaps.filter((g) => g > 50).length,
    frame_p50_by_quarter: quarters.map((list) => stats(list).p50),
    frame_mean_by_quarter: quarters.map((list) => round(mean(list))),
    typing_n: typing.length,
    typing_p50_ms: stats(typing).p50,
    typing_p95_ms: stats(typing).p95,
    typing_max_ms: stats(typing).max,
    typing_mean_ms: round(mean(typing)),
    // Instrumented build only (M32 hotspot pass); null otherwise.
    prof: raw.prof
      ? {
          md_calls: raw.prof.mdN,
          parse_ms: round(raw.prof.parse),
          sanitize_ms: round(raw.prof.sanitize),
          highlight_calls: raw.prof.hlN,
          highlight_ms: round(raw.prof.hl),
          decorate_ms: round(raw.prof.decorate),
          message_renders: raw.prof.viewN,
        }
      : null,
  };
}

/** Scroll `.messages` to the top and time the re-render it triggers. */
async function measureScrollTop(page) {
  return page.evaluate(async () => {
    const el = document.querySelector('.messages');
    const m = window.__m32;
    m.longtasks = [];
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) m.longtasks.push({ duration: entry.duration });
    });
    obs.observe({ type: 'longtask', buffered: false });
    const previous = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    const t0 = performance.now();
    el.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const paint = performance.now() - t0;
    const firstRow = document.querySelector('.messages .row');
    const box = el.getBoundingClientRect();
    const rect = firstRow ? firstRow.getBoundingClientRect() : null;
    const topVisible = Boolean(rect && rect.bottom > box.top && rect.top < box.bottom);
    // Give the scroll handler's state update + re-render time to land.
    await new Promise((r) => setTimeout(r, 700));
    obs.disconnect();
    el.style.scrollBehavior = previous;
    el.scrollTop = el.scrollHeight;
    return {
      scroll_top_ms: paint,
      top_visible: topVisible,
      scroll_top: el.scrollTop,
      rows: document.querySelectorAll('.messages .row').length,
      longtask_count: m.longtasks.length,
      longtask_total_ms: Math.round(m.longtasks.reduce((sum, i) => sum + i.duration, 0)),
      scroll_button: Boolean(document.querySelector('.scroll-bottom')),
    };
  });
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

async function runPass(browser, pass, viewport, mobile) {
  const result = {
    pass,
    viewport,
    open: [],
    open_scaling: [],
    stream_long: null,
    stream_plain: null,
    stream_short: null,
    scroll: null,
    errors: [],
  };
  log(`${pass}: open-to-interactive x${RUNS}…`);
  for (let i = 0; i < RUNS; i += 1) {
    const { data, errors } = await measureOpen(browser, viewport, mobile, 'chat-long', 300);
    result.open.push(data);
    result.errors.push(...errors);
    log(`${pass}: open run ${i + 1} = ${Math.round(data.open_ms)} ms (${data.rows} rows, ${data.nodes} nodes)`);
  }

  // How open-to-interactive scales with history length (justifies or rejects
  // windowing against a real curve rather than a hunch).
  for (const [chat, rows] of FAST
    ? []
    : [
        ['chat-100', 100],
        ['chat-200', 200],
      ]) {
    const { data, errors } = await measureOpen(browser, viewport, mobile, chat, rows);
    result.open_scaling.push({ chat, open_ms: data.open_ms, rows: data.rows, nodes: data.nodes });
    result.errors.push(...errors);
    log(`${pass}: open ${chat} = ${Math.round(data.open_ms)} ms (${data.rows} rows, ${data.nodes} nodes)`);
  }

  // Streaming on the 300-message chat.
  const longContext = await buildContext(browser, viewport, mobile, 'chat-long');
  const longPage = await openPage(longContext);
  result.errors.push(...longPage.errors);
  try {
    await waitRows(longPage.page, 300);
    log(`${pass}: streaming a long reply on the 300-message chat…`);
    result.stream_long = await measureStreamRuns(longPage.page);
    log(`${pass}: streaming the same length without Markdown syntax…`);
    result.stream_plain = await measureStreamRuns(longPage.page, true);
    result.scroll = await measureScrollTop(longPage.page);
  } finally {
    await longContext.close();
  }

  // Streaming on the 2-message control chat (same reply, same viewport).
  const shortContext = await buildContext(browser, viewport, mobile, 'chat-short');
  const shortPage = await openPage(shortContext);
  result.errors.push(...shortPage.errors);
  try {
    await waitRows(shortPage.page, 2);
    log(`${pass}: streaming the same reply on the 2-message control chat…`);
    result.stream_short = await measureStreamRuns(shortPage.page);
  } finally {
    await shortContext.close();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  for (const [port, label] of [
    [RELAY_PORT, 'relay'],
    [PREVIEW_PORT, 'preview'],
  ]) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      throw new Error(`port ${port} (${label}) is already in use — stop it before running the M32 harness`);
    } catch (err) {
      if (err && /already in use/.test(String(err.message))) throw err;
    }
  }

  if (process.env.M32_SKIP_BUILD !== '1') {
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
  const report = { label: LABEL, at: new Date().toISOString(), runs: RUNS, passes: [] };
  try {
    report.passes.push(await runPass(browser, 'desktop', { width: 1280, height: 900 }, false));
    if (!FAST) report.passes.push(await runPass(browser, 'mobile', { width: 390, height: 844 }, true));
  } finally {
    await browser.close().catch(() => {});
  }

  const file = join(HERE, `perf-m32-${LABEL}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

  for (const pass of report.passes) {
    const opens = pass.open.map((o) => o.open_ms).sort((a, b) => a - b);
    const median = opens[Math.floor(opens.length / 2)];
    log(`${pass.pass}: open median ${Math.round(median)} ms (${opens.map((o) => Math.round(o)).join(' / ')})`);
    log(`${pass.pass}: nodes ${pass.open[0].nodes}, domContentLoaded ${Math.round(pass.open[0].dom_content_loaded)} ms`);
    for (const row of pass.open_scaling) {
      log(`${pass.pass}: open ${row.chat} ${Math.round(row.open_ms)} ms (${row.rows} rows, ${row.nodes} nodes)`);
    }
    for (const key of ['stream_long', 'stream_plain', 'stream_short']) {
      const s = pass[key];
      log(
        `${pass.pass}: ${key} longtasks ${s.longtask_count}/${s.longtask_total_ms} ms, ` +
          `frames ${s.frames} (mean ${s.frame_mean_ms} p50 ${s.frame_p50_ms} p90 ${s.frame_p90_ms} ` +
          `p95 ${s.frame_p95_ms} ms, >20 ms ${s.frames_over_20}, >50 ms ${s.frames_over_50}, ` +
          `mean-by-quarter ${s.frame_mean_by_quarter.join('/')}), ` +
          `typing p95 ${s.typing_p95_ms} ms (n=${s.typing_n})`,
      );
      if (s.prof) log(`${pass.pass}: ${key} profile ${JSON.stringify(s.prof)}`);
    }
    log(
      `${pass.pass}: scroll-top ${Math.round(pass.scroll.scroll_top_ms)} ms, ` +
        `longtasks ${pass.scroll.longtask_count}/${pass.scroll.longtask_total_ms} ms, top visible ${pass.scroll.top_visible}`,
    );
  }
  log(`wrote ${file}`);
  const failures = report.passes.flatMap((pass) => pass.errors);
  if (failures.length) {
    log(`page errors: ${failures.join(' | ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    log(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
