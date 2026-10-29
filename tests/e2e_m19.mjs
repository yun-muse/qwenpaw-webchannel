#!/usr/bin/env node
/**
 * M19 — SPA polish pack E2E (items 1–4, 6; item 5 is asserted alongside the
 * meter). Runs entirely local against a production build:
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
    for (let i = 0; i < 12; i += 1) {
      await sleep(90);
      const counts = await page.evaluate(() => ({
        pres: document.querySelectorAll('.md pre').length,
        copies: document.querySelectorAll('.md pre .pre-copy').length,
      }));
      samples += 1;
      if (counts.pres > 1) sawTwoPres = true;
      if (counts.pres !== counts.copies) stable = false;
    }
    check(`${pass}: re-renders never duplicate or drop copy buttons`, stable, `${samples} samples, two blocks seen: ${sawTwoPres}`);

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
    const finalCounts = await page.evaluate(() => ({
      pres: document.querySelectorAll('.md pre').length,
      copies: document.querySelectorAll('.md pre .pre-copy').length,
    }));
    check(`${pass}: final render keeps one button per block`, finalCounts.pres === finalCounts.copies, JSON.stringify(finalCounts));

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
    console.log('M19 E2E FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('M19 E2E PASS');
}

main()
  .catch((err) => {
    log(`fatal: ${err && err.stack ? err.stack : err}`);
    console.log('M19 E2E FAIL');
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
