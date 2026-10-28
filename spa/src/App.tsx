import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import {
  ArrowDown,
  AtSign,
  Check,
  ChevronUp,
  Cloud,
  Code2,
  Compass,
  Copy,
  Cpu,
  Download,
  Edit3,
  FileText,
  GitCompare,
  HelpCircle,
  Layers,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Sliders,
  Sparkles,
  Square,
  Sun,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { RelayClient } from './relay';
import type { ConnState, ContentPart, Frame } from './relay';
import { LOGIN_REQUIRED, RELAY_HTTP_URL, RELAY_WS_URL } from './config';
import {
  DEFAULT_SKILLS,
  FEYNMAN_AGENTS_MD,
  FEYNMAN_SOUL_MD,
  STARTER_PROMPTS,
} from './prompts';
import type { SkillItem, StarterPrompt } from './prompts';
import { BUILD_GIT, formatBuildLabel } from './version';
import './App.css';

/** protocol/frames.md §5 — UTF-8 bytes of the serialized JSON. */
const MAX_FRAME_BYTES = 256 * 1024;

/** protocol/frames.md §8 — largest file a chunked (v2) upload may carry. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** §8.1 — raw bytes per `file_chunk` frame (base64 in `data`). */
const CHUNK_BYTES = 96 * 1024;

/** §8.3 — the hosted relay allows 30 frames/s per tenant, so ~40 ms apart. */
const CHUNK_PACE_MS = 40;

/** §7 — a v1 container ignores `file_begin`, so `file_end` must not wait forever. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Raw size above which an inline v1 frame cannot fit: skip the base64 probe. */
const INLINE_PROBE_BYTES = 180 * 1024;

/** M12 — the whole Markdown document is capped at 10 MB, like an upload. */
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
/** M12 — no chunk can ever be larger than 96 KB, so this many is the max. */
const MAX_EXPORT_CHUNKS = Math.ceil(MAX_EXPORT_BYTES / CHUNK_BYTES);
/** M12 — give up when no complete export arrives (10 MB ≈ 4–5 s of chunks). */
const EXPORT_TIMEOUT_MS = 120_000;

/** M13 — wait this long after the last keystroke before asking the plugin. */
const SEARCH_DEBOUNCE_MS = 300;
/** M13 — give up when the archive does not answer (plugin + Turso timeout). */
const SEARCH_TIMEOUT_MS = 15_000;

/** Client token for the hosted relay, kept across tabs and restarts (M11). */
const TOKEN_KEY = 'webchannel.token';
/** Expiry of TOKEN_KEY (Unix seconds, as answered by `POST /api/login`). */
const TOKEN_EXPIRES_KEY = 'webchannel.tokenExpires';

/** Chat list + visible chat from the previous visit (survives a reload). */
const CHATS_KEY = 'webchannel.chats';
const ACTIVE_KEY = 'webchannel.activeChat';

/** User-given chat titles, keyed by chat id (M7). */
const NAMES_KEY = 'webchannel.chatNames';
/** Per-chat thinking level, keyed by chat id (M9). */
const EFFORT_KEY = 'webchannel.effort';
/** A chat gets its server record on the first message; retry the pending
 *  level once that message has had time to be processed (M9). */
const EFFORT_REAPPLY_MS = 1200;
/** 'light' | 'dark' (M7). */
const THEME_KEY = 'webchannel.theme';
/** Optional endpoint override ('local' | 'cloud') for dev preview convenience. */
const ENDPOINT_KEY = 'webchannel.endpoint';

const CLOUD_WS_URL = 'wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/client';
const CLOUD_HTTP_URL = 'https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev';
const LOCAL_WS_URL = 'ws://127.0.0.1:8787/ws/client';

/** Distance from the bottom (px) that still counts as "reading the latest". */
const NEAR_BOTTOM_PX = 80;

const PROMPT_FILE_TABS = ['SOUL.md', 'AGENTS.md', 'PROFILE.md', 'MEMORY.md'] as const;
type PromptFileName = (typeof PROMPT_FILE_TABS)[number];

/** How long after a reply ends the usage refresh waits for the session file. */
const USAGE_REFRESH_MS = 1200;

/**
 * The stored token, or null when it is missing or locally expired.
 *
 * `expires` is Unix seconds from the relay. It is only a local pre-check:
 * clocks may disagree, so the connection itself stays authoritative and a
 * server-side rejection still lands on `onAuthFailure`.
 */
function readToken(): string | null {
  const token = storageGet(TOKEN_KEY);
  if (!token) return null;
  const raw = storageGet(TOKEN_EXPIRES_KEY);
  if (raw) {
    const expires = Number(raw);
    if (Number.isFinite(expires) && expires > 0 && expires * 1000 <= Date.now()) {
      clearStoredAuth();
      return null;
    }
  }
  return token;
}

function clearStoredAuth(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_EXPIRES_KEY);
  } catch {
    /* storage blocked — nothing to clear */
  }
}

/** Persist the login credential; the password itself is never stored. */
function rememberAuth(token: string, expires: number | null): void {
  storageSet(TOKEN_KEY, token);
  if (expires != null && Number.isFinite(expires) && expires > 0) {
    storageSet(TOKEN_EXPIRES_KEY, String(Math.floor(expires)));
  } else {
    try {
      window.localStorage.removeItem(TOKEN_EXPIRES_KEY);
    } catch {
      /* not persisted */
    }
  }
}

/** localStorage is best-effort: private mode / blocked storage throws. */
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not persisted — the session still works, it just won't be restored */
  }
}

function persistedChats(): string[] {
  const raw = storageGet(CHATS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/** Per-chat thinking levels from the last visit; malformed entries are dropped. */
function persistedEfforts(): Record<string, EffortLevel> {
  const raw = storageGet(EFFORT_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, EffortLevel> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const level = asEffortLevel(value);
      if (level) out[id] = level;
    }
    return out;
  } catch {
    return {};
  }
}

/** Custom chat titles from the last visit; anything malformed is dropped. */
function persistedNames(): Record<string, string> {
  const raw = storageGet(NAMES_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === 'string' && name.trim()) out[id] = name;
    }
    return out;
  } catch {
    return {};
  }
}

type Theme = 'light' | 'dark';

/** The five levels the SPA sends; `default` maps to QwenPaw's `inherit`. */
type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'max';

const EFFORT_LEVELS: readonly EffortLevel[] = ['default', 'low', 'medium', 'high', 'max'];
const EFFORT_LABELS: Record<EffortLevel, string> = {
  default: '默认',
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
};
const EFFORT_TITLE = '已设置；个别模型可能不支持或忽略';

function asEffortLevel(value: unknown): EffortLevel | null {
  if (typeof value !== 'string') return null;
  return (EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as EffortLevel)
    : null;
}

/** Stored choice first, then the OS preference. */
function initialTheme(): Theme {
  const stored = storageGet(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function restoreSession(): { chats: string[]; active: string } {
  const chats = persistedChats();
  if (chats.length > 0) {
    const saved = storageGet(ACTIVE_KEY);
    const active = saved && chats.includes(saved) ? saved : chats[0];
    return { chats, active };
  }
  const id = newChatId();
  return { chats: [id], active: id };
}

type Role = 'user' | 'assistant';

interface ApprovalMeta {
  reqId: string;
  tool: string;
  severity: string;
  summary: string;
  status: 'pending' | 'sent' | 'error';
  action?: 'approve' | 'deny';
  error?: string;
}

interface ChatMessage {
  id: number;
  role: Role;
  kind: 'text' | 'parts' | 'approval';
  text: string;
  thinking?: string;
  streaming?: boolean;
  parts?: ContentPart[];
  attachments?: string[];
  approval?: ApprovalMeta;
  ts?: number;
}

interface ModelItem {
  provider: string;
  model: string;
  active: boolean;
}

interface ModelRef {
  provider: string;
  model: string;
}

/** Last server-confirmed effort state for one chat (M9). */
interface EffortMeta {
  confirmed: EffortLevel | null;
  /** Selectable levels from the last `effort` frame; null = unknown. */
  supported: string[] | null;
  kind: string;
  modelKey: string;
  pending: boolean;
}

function effortSupportedOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw) {
    const level = asEffortLevel(entry);
    if (level) out.push(level);
  }
  return out;
}

interface CommandSpec {
  id: string;
  label: string;
  hint: string;
}

const COMMANDS: CommandSpec[] = [
  { id: 'model', label: '切换模型', hint: '直接在输入框上方方向键选模型' },
  { id: 'skill', label: '选择技能 (@)', hint: '挂载联网搜索 / 费曼拆解 / 浏览器等技能' },
  { id: 'new', label: '新建会话', hint: '开启一个全新的独立对话' },
  { id: 'stop', label: '停止生成', hint: '中断当前正在输出的回答' },
  { id: 'prompt', label: '人设与提示词', hint: '在线编辑 SOUL.md / AGENTS.md' },
  { id: 'rename', label: '重命名当前会话', hint: '自定义当前对话标题' },
  { id: 'delete', label: '删除当前会话', hint: '同步移除当前对话记录' },
  { id: 'clear', label: '清空当前屏幕', hint: '仅清空本地显示的聊天气泡' },
  { id: 'theme', label: '切换深浅色主题', hint: 'Claude 暖陶纸本 ↔ Cursor 曜石暗黑' },
  { id: 'help', label: '快捷键与帮助', hint: '查看全部斜杠命令与 @ 技能说明' },
];

interface AttachmentInline {
  kind: 'inline';
  name: string;
  mime: string;
  data: string;
  size: number;
}

interface AttachmentChunked {
  kind: 'chunked';
  id: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  sent: number;
  status: 'uploading' | 'ready' | 'failed';
  ref?: string;
}

type Attachment = AttachmentInline | AttachmentChunked;

interface Upload {
  id: string;
  chat: string;
  name: string;
  mime: string;
  size: number;
  bytes: ArrayBuffer;
  chunks: number;
  sha256: string;
  cancelled: boolean;
  retried: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One in-flight `export` request; chunks are keyed by their 0-based index. */
interface ExportJob {
  id: string;
  title: string;
  bytes: number;
  chunks: number;
  sha256: string;
  parts: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One archived message that matched a search (M13). */
interface SearchHit {
  chat: string;
  title: string;
  role: string;
  snippet: string;
  /** Match offset/length inside `snippet`, in UTF-16 code units (JS slices). */
  matchStart: number;
  matchLen: number;
  ts: number | null;
}

/** One in-flight `search` request; a newer query supersedes it. */
interface SearchJob {
  id: string;
  timer: ReturnType<typeof setTimeout> | null;
}

type SearchState = 'idle' | 'loading' | 'done' | 'unavailable';

interface ChatRuntime {
  activeId: number | null;
  endedId: number | null;
  histPending: boolean;
  histOpen: boolean;
  loaded: boolean;
}

let nextId = 1;
let uploadCounter = 1;
let exportCounter = 1;
let searchCounter = 1;

function newChatId(): string {
  return `chat-${Date.now().toString(36)}`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function fmtKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/** Compact token count for the usage line: 950, 12.3k, 1.2M. */
function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Per-chat usage as reported by the plugin's `usage` control frame (M11). */
interface ChatUsage {
  inputTotal?: number;
  outputTotal?: number;
  contextTokens?: number;
  contextLimit?: number;
}

const USAGE_TITLE =
  '本会话累计输入/输出取自 QwenPaw 每轮 usage 元数据；上下文占用为最近一轮输入近似（≈），多轮工具调用时可能略低';

function usageCount(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw)
    : undefined;
}

/** Parse one `usage` frame; absent/invalid fields stay absent. */
function usageOf(frame: Frame): ChatUsage {
  const usage: ChatUsage = {};
  const input = usageCount(frame.input_total);
  const output = usageCount(frame.output_total);
  const context = usageCount(frame.context_tokens);
  const limit = usageCount(frame.context_limit);
  if (input != null) usage.inputTotal = input;
  if (output != null) usage.outputTotal = output;
  if (context != null) usage.contextTokens = context;
  if (limit != null && limit > 0) usage.contextLimit = limit;
  return usage;
}

/** One compact line, e.g. `本会话 ↑12.3k ↓4.5k · 上下文 ≈34%（68k/200k）`. */
function usageLine(usage: ChatUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];

  if (usage.inputTotal != null || usage.outputTotal != null) {
    const totals: string[] = [];
    if (usage.inputTotal != null) totals.push(`↑${formatTokens(usage.inputTotal)}`);
    if (usage.outputTotal != null) totals.push(`↓${formatTokens(usage.outputTotal)}`);
    parts.push(`本会话 ${totals.join(' ')}`);
  }

  if (usage.contextTokens != null) {
    if (usage.contextLimit != null) {
      const percent = Math.round((usage.contextTokens / usage.contextLimit) * 100);
      parts.push(
        `上下文 ≈${percent}%（${formatTokens(usage.contextTokens)}/${formatTokens(usage.contextLimit)}）`,
      );
    } else {
      parts.push(`上下文 ≈${formatTokens(usage.contextTokens)}`);
    }
  }

  return parts.join(' · ');
}

function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function base64Of(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Decode one `export_chunk` payload; null when it is not valid base64. */
function bytesOfBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * `<title>-<YYYY-MM-DD>.md` — illegal file-name characters are replaced and
 * the title is truncated by code point (never in the middle of a surrogate
 * pair), per M12.
 */
function exportFileName(title: string, date: Date): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base =
    Array.from(cleaned).slice(0, 50).join('').replace(/[. ]+$/, '') || 'chat';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

/** Hand one Blob to the browser's download machinery. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uploadPercent(file: AttachmentChunked): number {
  if (file.chunks <= 0) return file.status === 'ready' ? 100 : 0;
  return Math.min(100, Math.round((file.sent / file.chunks) * 100));
}

function chipNote(file: Attachment): string {
  if (file.kind === 'inline') return '已就绪 · 随下一条消息发送';
  if (file.status === 'uploading') return `正在分片上传… ${uploadPercent(file)}%`;
  if (file.status === 'ready') return '已上传 · 随下一条消息发送';
  return '上传失败 — 请移除后重新选择';
}

function oversizeError(sizeBytes: number): string {
  return `附件太大：v1 单条消息上限 256KB（含正文与附件编码），当前约 ${fmtKb(sizeBytes)}`;
}

function deltaOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as { text?: unknown; delta?: unknown };
    if (typeof d.text === 'string') return d.text;
    if (typeof d.delta === 'string') return d.delta;
  }
  return '';
}

function streamTypeOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const st = (value as { stream_type?: unknown }).stream_type;
  return typeof st === 'string' ? st : '';
}

function partsOf(frame: Frame): ContentPart[] {
  return Array.isArray(frame.parts) ? frame.parts : [];
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

function modelItemsOf(raw: unknown): ModelItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { provider?: unknown; model?: unknown; active?: unknown };
    const provider = asString(record.provider);
    const model = asString(record.model);
    if (!provider || !model) continue;
    out.push({ provider, model, active: record.active === true });
  }
  return out;
}

function mergeSkillItems(raw: unknown): SkillItem[] {
  const byId = new Map<string, SkillItem>();
  for (const s of DEFAULT_SKILLS) {
    byId.set(s.id, s);
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as { id?: unknown; name?: unknown; description?: unknown };
      const id = asString(rec.id).trim();
      if (!id) continue;
      const existing = byId.get(id);
      const name = asString(rec.name).trim() || existing?.name || id;
      const description =
        asString(rec.description).trim() || existing?.description || '容器已启用技能';
      byId.set(id, {
        id,
        name,
        description,
        instruction: existing?.instruction ?? `[请优先调用技能 ${id} 处理本轮请求]`,
        category: existing?.category ?? 'agent',
      });
    }
  }
  return [...byId.values()];
}

interface HistoryMessage {
  role: Role;
  text: string;
}

function historyMessages(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { role?: unknown; text?: unknown };
    const role: Role | null =
      record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null;
    if (!role) continue;
    out.push({ role, text: typeof record.text === 'string' ? record.text : '' });
  }
  return out;
}

/** Parse one `search_results` payload; malformed rows are dropped (M13). */
function searchHitsOf(raw: unknown): SearchHit[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchHit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      chat?: unknown;
      title?: unknown;
      role?: unknown;
      snippet?: unknown;
      match_start?: unknown;
      match_len?: unknown;
      ts?: unknown;
    };
    const chat = asString(record.chat);
    if (!chat) continue;
    const matchStart =
      typeof record.match_start === 'number' && Number.isInteger(record.match_start)
        ? record.match_start
        : -1;
    const matchLen =
      typeof record.match_len === 'number' && Number.isInteger(record.match_len)
        ? record.match_len
        : 0;
    out.push({
      chat,
      title: asString(record.title),
      role: asString(record.role),
      snippet: asString(record.snippet),
      matchStart,
      matchLen,
      ts: typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : null,
    });
  }
  return out;
}

/** Split a hit snippet on its match; slices are UTF-16 units, like the plugin. */
function snippetParts(hit: SearchHit): { before: string; match: string; after: string } {
  const { snippet, matchStart, matchLen } = hit;
  if (matchStart < 0 || matchLen <= 0 || matchStart + matchLen > snippet.length) {
    return { before: snippet, match: '', after: '' };
  }
  return {
    before: snippet.slice(0, matchStart),
    match: snippet.slice(matchStart, matchStart + matchLen),
    after: snippet.slice(matchStart + matchLen),
  };
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true }) as unknown as string;
  return DOMPurify.sanitize(html);
}

function htmlTableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const matrix = rows.map((tr) =>
    Array.from(tr.querySelectorAll('th, td')).map((cell) =>
      (cell.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|'),
    ),
  );
  const colCount = Math.max(...matrix.map((r) => r.length), 1);
  const norm = matrix.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push('');
    return padded;
  });
  const header = `| ${norm[0].join(' | ')} |`;
  const sep = `| ${norm[0].map(() => '---').join(' | ')} |`;
  const body = norm.slice(1).map((r) => `| ${r.join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function htmlTableToTsv(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  return rows
    .map((tr) =>
      Array.from(tr.querySelectorAll('th, td'))
        .map((cell) => (cell.textContent ?? '').trim().replace(/\s+/g, ' '))
        .join('\t'),
    )
    .join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function clockOf(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function copySource(message: ChatMessage): string {
  if (message.kind === 'parts' && message.parts?.length) {
    const text = textOf(message.parts);
    if (text) return text;
  }
  return message.text;
}

function partTitle(part: ContentPart): string {
  const name = asString(part.name) || asString(part.filename) || asString(part.file_name);
  return name ? `${part.type} · ${name}` : part.type;
}

function displayPart(part: ContentPart): string {
  const copy: Record<string, unknown> = { ...part };
  if (typeof copy.data === 'string' && copy.data.length > 200) {
    copy.data = `<${copy.data.length} base64 chars>`;
  }
  return JSON.stringify(copy, null, 2);
}

const STATE_LABEL: Record<ConnState, string> = {
  idle: '离线',
  connecting: '连接中',
  live: '已连接',
  resuming: '恢复中',
  resync: '同步中',
};

function StarterIcon({ name }: { name: StarterPrompt['icon'] }) {
  switch (name) {
    case 'compass':
      return <Compass size={16} />;
    case 'git-compare':
      return <GitCompare size={16} />;
    case 'layers':
      return <Layers size={16} />;
    case 'code':
    default:
      return <Code2 size={16} />;
  }
}

function PartCard({ part }: { part: ContentPart }) {
  return (
    <details className="part-card">
      <summary>⚡ {partTitle(part)}</summary>
      <pre>{displayPart(part)}</pre>
    </details>
  );
}

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    root.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      let lang = 'code';
      if (codeEl) {
        const cls = Array.from(codeEl.classList).find((c) => c.startsWith('language-'));
        if (cls) lang = cls.replace('language-', '') || 'code';
        if (!codeEl.dataset.highlighted) {
          try {
            if (lang !== 'code' && hljs.getLanguage(lang)) {
              codeEl.innerHTML = hljs.highlight(codeEl.textContent ?? '', { language: lang }).value;
            } else {
              codeEl.innerHTML = hljs.highlightAuto(codeEl.textContent ?? '').value;
            }
            codeEl.dataset.highlighted = 'yes';
          } catch {
            /* ignore highlight errors during partial stream */
          }
        }
      }
      if (!pre.querySelector('.pre-lang')) {
        const langBar = document.createElement('div');
        langBar.className = 'pre-lang';
        langBar.textContent = lang;
        pre.appendChild(langBar);
      }
      if (!pre.querySelector('.pre-copy')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pre-copy';
        button.textContent = 'Copy';
        pre.appendChild(button);
      }
    });

    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('table-scroll')) return;
      const box = document.createElement('div');
      box.className = 'table-box';

      const bar = document.createElement('div');
      bar.className = 'table-bar';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = '📊 结构化表格';

      const actions = document.createElement('div');
      actions.className = 'table-bar-actions';

      const mdBtn = document.createElement('button');
      mdBtn.type = 'button';
      mdBtn.className = 'table-copy-btn table-copy-md';
      mdBtn.textContent = '📋 复制 Markdown 表格';

      const tsvBtn = document.createElement('button');
      tsvBtn.type = 'button';
      tsvBtn.className = 'table-copy-btn table-copy-tsv';
      tsvBtn.textContent = '📊 复制到 Excel';

      actions.appendChild(mdBtn);
      actions.appendChild(tsvBtn);
      bar.appendChild(titleSpan);
      bar.appendChild(actions);

      const scroll = document.createElement('div');
      scroll.className = 'table-scroll';

      table.parentNode?.insertBefore(box, table);
      scroll.appendChild(table);
      box.appendChild(bar);
      box.appendChild(scroll);
    });
  }, [html]);

  const onContainerClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const preBtn = target.closest('.pre-copy');
    if (preBtn instanceof HTMLElement) {
      const pre = preBtn.closest('pre');
      if (!pre) return;
      const code = pre.querySelector('code');
      const source = code?.textContent ?? pre.textContent ?? '';
      void copyText(source).then((ok) => {
        if (!ok) return;
        preBtn.textContent = 'Copied';
        window.setTimeout(() => {
          preBtn.textContent = 'Copy';
        }, 1200);
      });
      return;
    }

    const mdTableBtn = target.closest('.table-copy-md');
    if (mdTableBtn instanceof HTMLElement) {
      const box = mdTableBtn.closest('.table-box');
      const table = box?.querySelector('table');
      if (!table) return;
      void copyText(htmlTableToMarkdown(table)).then((ok) => {
        if (!ok) return;
        mdTableBtn.textContent = '✅ 已复制 Markdown';
        window.setTimeout(() => {
          mdTableBtn.textContent = '📋 复制 Markdown 表格';
        }, 1400);
      });
      return;
    }

    const tsvTableBtn = target.closest('.table-copy-tsv');
    if (tsvTableBtn instanceof HTMLElement) {
      const box = tsvTableBtn.closest('.table-box');
      const table = box?.querySelector('table');
      if (!table) return;
      void copyText(htmlTableToTsv(table)).then((ok) => {
        if (!ok) return;
        tsvTableBtn.textContent = '✅ 已复制 Excel 格式';
        window.setTimeout(() => {
          tsvTableBtn.textContent = '📊 复制到 Excel';
        }, 1400);
      });
    }
  };

  return (
    <div className="md-wrap">
      <div
        className="md"
        ref={ref}
        onClick={onContainerClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {streaming ? <i className="caret" /> : null}
    </div>
  );
}

function ApprovalCard({
  message,
  chat,
  onApproval,
}: {
  message: ChatMessage;
  chat: string;
  onApproval: (chat: string, message: ChatMessage, action: 'approve' | 'deny') => void;
}) {
  const approval = message.approval;
  if (!approval) return null;
  const locked = approval.status !== 'pending';
  const severityClass = approval.severity.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return (
    <div className="approval-card">
      <div className="approval-head">
        <ShieldAlert size={16} />
        <span className="approval-tool">{approval.tool}</span>
        <span className={`severity sev-${severityClass || 'info'}`}>{approval.severity}</span>
      </div>
      {approval.summary ? <pre className="approval-summary">{approval.summary}</pre> : null}
      <div className="approval-actions">
        <button className="approve" disabled={locked} onClick={() => onApproval(chat, message, 'approve')}>
          批准执行 (Approve)
        </button>
        <button className="deny" disabled={locked} onClick={() => onApproval(chat, message, 'deny')}>
          拒绝 (Deny)
        </button>
        {approval.status === 'sent' ? (
          <span className="approval-note">已发送… ({approval.action})</span>
        ) : null}
        {approval.status === 'error' ? (
          <span className="approval-error">{approval.error ?? 'rejected'}</span>
        ) : null}
      </div>
      <div className="approval-req">request {approval.reqId}</div>
    </div>
  );
}

function MessageView({
  message,
  chat,
  onApproval,
  onRegenerate,
  onEditResend,
}: {
  message: ChatMessage;
  chat: string;
  onApproval: (chat: string, message: ChatMessage, action: 'approve' | 'deny') => void;
  onRegenerate?: (message: ChatMessage) => void;
  onEditResend?: (message: ChatMessage) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  if (message.kind === 'approval') {
    return (
      <div className="row assistant">
        <div className="assistant-avatar">
          <Sparkles size={13} />
        </div>
        <div className="assistant-col">
          <ApprovalCard message={message} chat={chat} onApproval={onApproval} />
        </div>
      </div>
    );
  }

  const copy = () => {
    void copyText(copySource(message)).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1400);
    });
  };

  const isAssistant = message.role === 'assistant';
  const bubble = (
    <div className={`bubble${message.streaming ? ' streaming' : ''}`}>
      {isAssistant ? (
        message.text ? (
          <Markdown text={message.text} streaming={message.streaming} />
        ) : (
          <span className="plain">
            {message.streaming ? <i className="caret" /> : null}
          </span>
        )
      ) : (
        <span className="plain">{message.text}</span>
      )}
      {message.parts?.map((part, index) => (
        <PartCard key={`${message.id}-${index}`} part={part} />
      ))}
      {message.attachments?.length ? (
        <div className="bubble-files">
          {message.attachments.map((name) => (
            <span className="chip" key={name}>
              <FileText size={12} />
              {name}
            </span>
          ))}
        </div>
      ) : null}
      {message.streaming ? null : (
        <div className="bubble-foot">
          {message.ts ? <span className="bubble-time">{clockOf(message.ts)}</span> : null}
          <button
            className={`copy-btn${copied ? ' copied' : ''}`}
            onClick={copy}
            title={isAssistant ? '直接复制未渲染的原始 Markdown 源码' : '复制消息文本'}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? '已复制 Markdown' : isAssistant ? '复制 Markdown' : '复制'}</span>
          </button>
          {isAssistant && onRegenerate ? (
            <button
              className="msg-act-btn"
              onClick={() => onRegenerate(message)}
              title="重新生成此回答"
            >
              <RotateCcw size={12} />
              <span>重新生成</span>
            </button>
          ) : null}
          {!isAssistant && onEditResend ? (
            <button
              className="msg-act-btn"
              onClick={() => onEditResend(message)}
              title="放回输入框修改并重发"
            >
              <Edit3 size={12} />
              <span>编辑</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  if (isAssistant) {
    return (
      <div className="row assistant">
        <div className="assistant-avatar" title="QwenPaw Agent">
          <Sparkles size={13} />
        </div>
        <div className="assistant-col">
          {message.thinking ? (
            <div className="reply">
              <details className="thinking" open={message.streaming && !message.text}>
                <summary>💭 思考过程 (Reasoning)</summary>
                <div className="thinking-body">{message.thinking}</div>
              </details>
              {bubble}
            </div>
          ) : (
            bubble
          )}
        </div>
      </div>
    );
  }

  return <div className="row user">{bubble}</div>;
}

function LoginGate({
  httpUrl,
  onSuccess,
  onSwitchLocal,
}: {
  httpUrl: string;
  onSuccess: (token: string, expires: number | null) => void;
  onSwitchLocal?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!password) {
      setError('请输入 Relay 访问口令');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${httpUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => null)) as {
        token?: unknown;
        expires?: unknown;
        error?: unknown;
      } | null;
      if (!res.ok) {
        const serverError = body && typeof body.error === 'string' ? body.error : '';
        setError(serverError || `登录失败 (${res.status}).`);
        setBusy(false);
        return;
      }
      const token = body && typeof body.token === 'string' ? body.token : '';
      if (!token) {
        setError('登录失败 — Relay 未返回有效凭证');
        setBusy(false);
        return;
      }
      const expires =
        body && typeof body.expires === 'number' && Number.isFinite(body.expires)
          ? body.expires
          : null;
      onSuccess(token, expires);
    } catch {
      setError('无法连接到 Relay 服务，请稍后重试');
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-logo">
            <Sparkles size={15} />
          </span>
          <span>QwenPaw Studio</span>
        </div>
        <p className="login-sub">输入 Relay 访问口令以连接你的云端阿里云 Agent 容器</p>
        <input
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="请输入访问口令…"
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? '正在连接…' : '连接云端 Agent'}
        </button>
        {onSwitchLocal ? (
          <button
            type="button"
            className="endpoint-switch"
            style={{ justifyContent: 'center', padding: '8px' }}
            onClick={onSwitchLocal}
          >
            切换到本地免密演示节点 (127.0.0.1:8787)
          </button>
        ) : null}
        {error ? <div className="login-error">{error}</div> : null}
      </form>
    </div>
  );
}

export default function App() {
  const [session] = useState(restoreSession);
  const [chatIds, setChatIds] = useState<string[]>(() => [...session.chats]);
  const [activeChat, setActiveChat] = useState<string>(session.active);
  const [messagesByChat, setMessagesByChat] = useState<Record<string, ChatMessage[]>>(() => {
    const out: Record<string, ChatMessage[]> = {};
    for (const id of session.chats) out[id] = [];
    return out;
  });
  const [input, setInput] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [state, setState] = useState<ConnState>('idle');
  const [agentOnline, setAgentOnline] = useState(false);

  // Endpoint mode: if env vars are baked in, use them; otherwise allow switching between local (:8787) and cloud CF relay
  const [endpointMode, setEndpointMode] = useState<'local' | 'cloud'>(() => {
    if (LOGIN_REQUIRED) return 'cloud';
    return storageGet(ENDPOINT_KEY) === 'cloud' ? 'cloud' : 'local';
  });

  const activeWsUrl =
    LOGIN_REQUIRED ? RELAY_WS_URL : endpointMode === 'cloud' ? CLOUD_WS_URL : LOCAL_WS_URL;
  const activeHttpUrl =
    LOGIN_REQUIRED ? RELAY_HTTP_URL : endpointMode === 'cloud' ? CLOUD_HTTP_URL : '';
  const requiresAuth = Boolean(activeHttpUrl);

  const [needsLogin, setNeedsLogin] = useState<boolean>(() => requiresAuth && !readToken());

  // --- M7 & M8: identity, models, skills, sidebar, palette, theme, prompt drawer ---
  const [agentName, setAgentName] = useState('');
  const [modelItems, setModelItems] = useState<ModelItem[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelRef | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Skills & Inline Palette Mode ('cmd' | 'model' | 'skill')
  const [skills, setSkills] = useState<SkillItem[]>(DEFAULT_SKILLS);
  const [activeSkill, setActiveSkill] = useState<SkillItem | null>(null);
  const [inlineSubMode, setInlineSubMode] = useState<'model' | 'skill' | null>(null);

  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteMuted, setPaletteMuted] = useState<string | null>(null);
  const [chatNames, setChatNames] = useState<Record<string, string>>(persistedNames);
  // M9: local choice per chat (restored first), plus what the server confirmed.
  const [effortLevels, setEffortLevels] = useState<Record<string, EffortLevel>>(persistedEfforts);
  const [effortMeta, setEffortMeta] = useState<Record<string, EffortMeta>>({});
  // M11: last `usage` frame per chat (control frame; re-requested on demand).
  const [usageByChat, setUsageByChat] = useState<Record<string, ChatUsage>>({});
  const [search, setSearch] = useState('');
  // M13: server-side full-text hits for the search box (the local title
  // filter below keeps working on its own).
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [draggingFile, setDraggingFile] = useState(false);
  // M12: one export at a time; the button shows "导出中…" while it runs.
  const [exporting, setExporting] = useState(false);

  // Persona / Prompt Drawer state
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false);
  const [activePromptTab, setActivePromptTab] = useState<PromptFileName>('SOUL.md');
  const [promptFiles, setPromptFiles] = useState<Record<string, string>>({
    'SOUL.md': '',
    'AGENTS.md': '',
    'PROFILE.md': '',
    'MEMORY.md': '',
  });
  const [promptStatus, setPromptStatus] = useState<string>('');

  const clientRef = useRef<RelayClient | null>(null);
  const activeRef = useRef<string>(session.active);
  const runtimes = useRef<Map<string, ChatRuntime>>(new Map());
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const answeredApprovals = useRef<Set<string>>(new Set());
  const uploadRef = useRef<Upload | null>(null);
  // M12: the export being collected (chunks arrive as control frames).
  const exportRef = useRef<ExportJob | null>(null);
  // M13: the archive search in flight (debounce is local to its effect).
  const searchRef = useRef<SearchJob | null>(null);
  const modelsRequested = useRef(false);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastChatRef = useRef<string>(session.active);
  // M9: onFrame runs outside React's render closure, so the effort state it
  // reads (and rolls back) lives in refs mirrored from the React state.
  const effortLevelsRef = useRef<Record<string, EffortLevel>>(effortLevels);
  const effortMetaRef = useRef<Record<string, EffortMeta>>({});
  const effortRollbackRef = useRef<Record<string, EffortLevel>>({});
  const effortRetryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // M11: debounced usage refresh per chat (set after a reply finishes).
  const usageTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runtimeOf = (chat: string): ChatRuntime => {
    let rt = runtimes.current.get(chat);
    if (!rt) {
      rt = { activeId: null, endedId: null, histPending: false, histOpen: false, loaded: false };
      runtimes.current.set(chat, rt);
    }
    return rt;
  };

  const updateChat = (chat: string, fn: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessagesByChat((prev) => ({ ...prev, [chat]: fn(prev[chat] ?? []) }));
  };

  const ensureChat = (chat: string) => {
    setChatIds((prev) => (prev.includes(chat) ? prev : [...prev, chat]));
    setMessagesByChat((prev) => (chat in prev ? prev : { ...prev, [chat]: [] }));
  };

  // ---- M9: thinking effort (per chat, server is authoritative) ----
  const showToastBriefly = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      // Only dismiss our own notice, never a newer one.
      setToast((current) => (current === message ? null : current));
    }, 4000);
  };

  const applyEffortLevel = (chat: string, level: EffortLevel) => {
    const next = { ...effortLevelsRef.current, [chat]: level };
    effortLevelsRef.current = next;
    setEffortLevels(next);
  };

  const mergeEffortMeta = (chat: string, patch: Partial<EffortMeta>) => {
    const prev = effortMetaRef.current[chat];
    const next: EffortMeta = {
      confirmed: prev?.confirmed ?? null,
      supported: prev?.supported ?? null,
      kind: prev?.kind ?? '',
      modelKey: prev?.modelKey ?? '',
      pending: prev?.pending ?? false,
      ...patch,
    };
    const all = { ...effortMetaRef.current, [chat]: next };
    effortMetaRef.current = all;
    setEffortMeta(all);
  };

  const forgetEffort = (chat: string) => {
    const timer = effortRetryTimers.current.get(chat);
    if (timer) {
      clearTimeout(timer);
      effortRetryTimers.current.delete(chat);
    }
    delete effortRollbackRef.current[chat];
    if (chat in effortLevelsRef.current) {
      const next = { ...effortLevelsRef.current };
      delete next[chat];
      effortLevelsRef.current = next;
      setEffortLevels(next);
    }
    if (chat in effortMetaRef.current) {
      const next = { ...effortMetaRef.current };
      delete next[chat];
      effortMetaRef.current = next;
      setEffortMeta(next);
    }
  };

  const requestEffort = (chat: string) => {
    clientRef.current?.send({ t: 'get_effort', chat, id: 'effort-get' });
  };

  const requestUsage = (chat: string) => {
    clientRef.current?.send({ t: 'get_usage', chat, id: 'usage-get' });
  };

  /**
   * The closing `end` and the trailing `msg` of one turn both land here; the
   * timer collapses them and gives the app time to persist the turn's usage
   * meta into the session file before the plugin reads it (M11).
   */
  const scheduleUsageRefresh = (chat: string) => {
    const pending = usageTimers.current.get(chat);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      usageTimers.current.delete(chat);
      requestUsage(chat);
    }, USAGE_REFRESH_MS);
    usageTimers.current.set(chat, timer);
  };

  // ---- M12: conversation export (chunked control frames) ----
  const failExport = (job: ExportJob, message: string) => {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    if (exportRef.current === job) {
      exportRef.current = null;
      setExporting(false);
    }
    showToastBriefly(message);
  };

  /** Verify the collected chunks against `export_begin`, then save the Blob. */
  const finishExport = async (job: ExportJob) => {
    if (!(job.chunks > 0) || !(job.bytes > 0) || !job.sha256) {
      failExport(job, '导出失败：插件返回的文档信息不完整');
      return;
    }
    const ordered: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < job.chunks; i += 1) {
      const raw = job.parts.get(i);
      if (raw == null) {
        failExport(job, '导出失败：分块缺失，请重试');
        return;
      }
      const chunk = bytesOfBase64(raw);
      if (!chunk) {
        failExport(job, '导出失败：分块无法解码，请重试');
        return;
      }
      ordered.push(chunk);
      total += chunk.length;
    }
    if (total !== job.bytes) {
      failExport(job, '导出校验失败：字节数不符，已丢弃');
      return;
    }
    const buffer = new ArrayBuffer(total);
    const merged = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of ordered) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    let digest = '';
    try {
      digest = hexOf(await crypto.subtle.digest('SHA-256', buffer));
    } catch {
      failExport(job, '导出失败：无法计算校验值');
      return;
    }
    if (digest !== job.sha256.toLowerCase()) {
      failExport(job, '导出校验失败：内容不完整，已丢弃');
      return;
    }
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    saveBlob(
      new Blob([buffer], { type: 'text/markdown;charset=utf-8' }),
      exportFileName(job.title, new Date()),
    );
  };

  const requestHist = (chat: string) => {
    const rt = runtimeOf(chat);
    if (rt.histPending) return;
    rt.histPending = true;
    const client = clientRef.current;
    if (!client || !client.send({ t: 'hist', chat })) {
      rt.histPending = false;
    }
  };

  const maybeRequestHist = (chat: string) => {
    const rt = runtimeOf(chat);
    if (rt.loaded || rt.histPending || rt.histOpen) return;
    if (clientRef.current?.getState() !== 'live') return;
    requestHist(chat);
  };

  const appendHistory = (chat: string, incoming: HistoryMessage[]) => {
    if (incoming.length === 0) return;
    updateChat(chat, (prev) => {
      let start = 0;
      const max = Math.min(prev.length, incoming.length);
      for (let overlap = max; overlap > 0; overlap -= 1) {
        let matches = true;
        for (let i = 0; i < overlap; i += 1) {
          const shown = prev[prev.length - overlap + i];
          const next = incoming[i];
          if (!shown || shown.role !== next.role || shown.text !== next.text) {
            matches = false;
            break;
          }
        }
        if (matches) {
          start = overlap;
          break;
        }
      }
      const out = [...prev];
      for (let i = start; i < incoming.length; i += 1) {
        const item = incoming[i];
        out.push({ id: nextId++, role: item.role, kind: 'text', text: item.text });
      }
      return out;
    });
  };

  const cancelUpload = () => {
    const up = uploadRef.current;
    uploadRef.current = null;
    if (!up) return;
    up.cancelled = true;
    if (up.timer) {
      clearTimeout(up.timer);
      up.timer = null;
    }
  };

  const failUpload = (up: Upload, message: string) => {
    if (up.timer) {
      clearTimeout(up.timer);
      up.timer = null;
    }
    if (uploadRef.current === up) uploadRef.current = null;
    setComposerError(message);
    setAttachment((prev) =>
      prev && prev.kind === 'chunked' && prev.id === up.id ? { ...prev, status: 'failed' } : prev,
    );
  };

  const sendUploadFrame = (frame: Frame): boolean => clientRef.current?.send(frame) ?? false;

  const runUpload = async (up: Upload) => {
    if (up.cancelled) return;
    setAttachment((prev) =>
      prev && prev.kind === 'chunked' && prev.id === up.id
        ? { ...prev, sent: 0, status: 'uploading' }
        : prev,
    );

    if (!up.sha256) {
      try {
        up.sha256 = hexOf(await crypto.subtle.digest('SHA-256', up.bytes));
      } catch {
        failUpload(up, '无法计算文件校验值：浏览器不支持 SHA-256。');
        return;
      }
      if (up.cancelled) return;
    }

    if (
      !sendUploadFrame({
        t: 'file_begin',
        chat: up.chat,
        id: up.id,
        name: up.name,
        mime: up.mime,
        size: up.size,
        chunks: up.chunks,
        sha256: up.sha256,
      })
    ) {
      failUpload(up, '未连接 — 正在重连，请稍后重试。');
      return;
    }

    const bytes = new Uint8Array(up.bytes);
    for (let i = 0; i < up.chunks; i += 1) {
      await sleep(CHUNK_PACE_MS);
      if (up.cancelled) return;
      const start = i * CHUNK_BYTES;
      const data = base64Of(bytes.subarray(start, Math.min(start + CHUNK_BYTES, bytes.length)));
      if (!sendUploadFrame({ t: 'file_chunk', chat: up.chat, id: up.id, i, data })) {
        failUpload(up, '未连接 — 正在重连，请稍后重试。');
        return;
      }
      setAttachment((prev) =>
        prev && prev.kind === 'chunked' && prev.id === up.id ? { ...prev, sent: i + 1 } : prev,
      );
    }

    if (up.chunks > 0) await sleep(CHUNK_PACE_MS);
    if (up.cancelled) return;
    if (!sendUploadFrame({ t: 'file_end', chat: up.chat, id: up.id })) {
      failUpload(up, '未连接 — 正在重连，请稍后重试。');
      return;
    }
    if (up.cancelled) return;
    if (up.timer) clearTimeout(up.timer);
    up.timer = setTimeout(() => {
      up.timer = null;
      if (up.cancelled || uploadRef.current !== up) return;
      failUpload(up, '文件传输超时：插件未确认收到（可能插件版本不支持分片传输）');
    }, UPLOAD_TIMEOUT_MS);
  };

  const startChunkedUpload = (file: File, bytes: ArrayBuffer, mime: string) => {
    const up: Upload = {
      id: `file-${Date.now().toString(36)}-${uploadCounter++}`,
      chat: activeRef.current,
      name: file.name,
      mime,
      size: file.size,
      bytes,
      chunks: Math.ceil(file.size / CHUNK_BYTES),
      sha256: '',
      cancelled: false,
      retried: false,
      timer: null,
    };
    uploadRef.current = up;
    setComposerError(null);
    setAttachment({
      kind: 'chunked',
      id: up.id,
      name: up.name,
      mime: up.mime,
      size: up.size,
      chunks: up.chunks,
      sent: 0,
      status: 'uploading',
    });
    void runUpload(up);
  };

  useEffect(() => {
    activeRef.current = activeChat;
  }, [activeChat]);

  useEffect(() => {
    storageSet(CHATS_KEY, JSON.stringify(chatIds));
    storageSet(ACTIVE_KEY, activeChat);
  }, [chatIds, activeChat]);

  useEffect(() => {
    storageSet(NAMES_KEY, JSON.stringify(chatNames));
  }, [chatNames]);

  useEffect(() => {
    // The ref is the write-through source for event handlers; every setter
    // (applyEffortLevel / forgetEffort) updates it together with the state.
    storageSet(EFFORT_KEY, JSON.stringify(effortLevels));
  }, [effortLevels]);

  useEffect(() => {
    // M13: every keystroke invalidates the previous search — its timer, its
    // request id and the hits it produced. A non-empty query is then debounced
    // and sent once; `searchRef` is the only thing onFrame trusts.
    const q = search.trim();
    const previous = searchRef.current;
    if (previous) {
      if (previous.timer) clearTimeout(previous.timer);
      searchRef.current = null;
    }
    setHits([]);
    setSearchState('idle');
    if (!q) return;

    const debounce = setTimeout(() => {
      const client = clientRef.current;
      if (!client) {
        setSearchState('unavailable');
        return;
      }
      const id = `search-${Date.now().toString(36)}-${searchCounter++}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const job: SearchJob = { id, timer: null };
      searchRef.current = job;
      setSearchState('loading');
      job.timer = setTimeout(() => {
        if (searchRef.current !== job) return;
        searchRef.current = null;
        setSearchState('unavailable');
      }, SEARCH_TIMEOUT_MS);
      if (!client.send({ t: 'search', id, q })) {
        if (searchRef.current === job) {
          if (job.timer) clearTimeout(job.timer);
          job.timer = null;
          searchRef.current = null;
        }
        setSearchState('unavailable');
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounce);
  }, [search]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      for (const timer of effortRetryTimers.current.values()) clearTimeout(timer);
      effortRetryTimers.current.clear();
      for (const timer of usageTimers.current.values()) clearTimeout(timer);
      usageTimers.current.clear();
      const exportJob = exportRef.current;
      if (exportJob?.timer) clearTimeout(exportJob.timer);
      const searchJob = searchRef.current;
      if (searchJob?.timer) clearTimeout(searchJob.timer);
      searchRef.current = null;
    },
    [],
  );

  useEffect(() => {
    // M11: open/switch refreshes the usage line too (control frames are never
    // replayed, so every chat switch asks explicitly).
    requestUsage(activeChat);
    // The local value is already rendered from localStorage; align it with
    // the server's stored choice (a chat with no record yet answers 404 and
    // keeps the local value).
    if (effortMetaRef.current[activeChat]?.pending) return;
    requestEffort(activeChat);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only chat switches
  }, [activeChat]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storageSet(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    setPaletteIndex(0);
    if (!input.startsWith('/model') && !input.startsWith('/skill')) {
      if (inlineSubMode && input.length > 0 && !input.startsWith('/')) {
        setInlineSubMode(null);
      }
    }
  }, [input, inlineSubMode]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (event: MouseEvent) => {
      const wrap = modelWrapRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        setPickerOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  useEffect(() => {
    if (needsLogin) return;
    let raf = 0;
    const pending = new Map<
      string,
      { chat: string; id: number; field: 'text' | 'thinking'; add: string }
    >();

    const applyPending = () => {
      raf = 0;
      if (pending.size === 0) return;
      const batch = [...pending.values()];
      pending.clear();
      setMessagesByChat((prev) => {
        const next = { ...prev };
        for (const { chat, id, field, add } of batch) {
          const list = next[chat];
          if (!list) continue;
          next[chat] = list.map((m) => {
            if (m.id !== id) return m;
            return field === 'thinking'
              ? { ...m, thinking: (m.thinking ?? '') + add }
              : { ...m, text: m.text + add };
          });
        }
        return next;
      });
    };
    const flushNow = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      applyPending();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(applyPending);
    };

    const newBubble = (chat: string): number => {
      const id = nextId++;
      runtimeOf(chat).activeId = id;
      updateChat(chat, (prev) => [
        ...prev,
        {
          id,
          role: 'assistant',
          kind: 'text',
          text: '',
          thinking: '',
          streaming: true,
          ts: Date.now(),
        },
      ]);
      return id;
    };

    const bump = (chat: string, field: 'text' | 'thinking', delta: string) => {
      const rt = runtimeOf(chat);
      const id = rt.activeId ?? newBubble(chat);
      const key = `${chat}|${field}`;
      const buffered = pending.get(key);
      if (buffered && buffered.id === id) buffered.add += delta;
      else pending.set(key, { chat, id, field, add: delta });
      schedule();
    };

    const onFrame = (frame: Frame) => {
      const chat = asString(frame.chat) || activeRef.current;

      switch (frame.t) {
        case 'start': {
          ensureChat(chat);
          flushNow();
          const rt = runtimeOf(chat);
          rt.endedId = null;
          if (rt.activeId == null) newBubble(chat);
          break;
        }

        case 'evt': {
          const delta = deltaOf(frame.data);
          if (!delta) break;
          ensureChat(chat);
          const streamType = streamTypeOf(frame.data);
          if (streamType === 'reasoning') bump(chat, 'thinking', delta);
          else if (!streamType || streamType === 'message') bump(chat, 'text', delta);
          break;
        }

        case 'end': {
          flushNow();
          const rt = runtimeOf(chat);
          if (streamTypeOf(frame) === 'reasoning') break;
          const id = rt.activeId;
          rt.activeId = null;
          rt.endedId = id;
          if (id != null) {
            updateChat(chat, (prev) =>
              prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
            );
          }
          if (chat === activeRef.current) scheduleUsageRefresh(chat);
          break;
        }

        case 'msg': {
          flushNow();
          const parts = partsOf(frame);
          const text = textOf(parts);
          const extra = parts.filter((p) => p && p.type !== 'text');
          const rt = runtimeOf(chat);

          if (rt.endedId != null) {
            const endedId = rt.endedId;
            rt.endedId = null;
            rt.activeId = null;
            updateChat(chat, (prev) =>
              prev.map((m) =>
                m.id === endedId
                  ? {
                      ...m,
                      text: text || m.text,
                      streaming: false,
                      kind: extra.length ? 'parts' : m.kind,
                      parts: extra.length ? [...(m.parts ?? []), ...extra] : m.parts,
                    }
                  : m,
              ),
            );
            // The turn is complete; refresh this chat's usage after the app
            // has had a moment to persist the turn's usage metadata (M11).
            if (chat === activeRef.current) scheduleUsageRefresh(chat);
            break;
          }

          if (rt.activeId != null) {
            if (extra.length) {
              updateChat(chat, (prev) => [
                ...prev,
                {
                  id: nextId++,
                  role: 'assistant',
                  kind: 'parts',
                  text: '',
                  parts: extra,
                  ts: Date.now(),
                },
              ]);
            }
            break;
          }

          if (!text && extra.length === 0) break;
          ensureChat(chat);
          updateChat(chat, (prev) => {
            const last = prev[prev.length - 1];
            if (
              extra.length === 0 &&
              last &&
              last.role === 'assistant' &&
              last.kind === 'text' &&
              last.text.trim() === text.trim()
            ) {
              return prev;
            }
            return [
              ...prev,
              {
                id: nextId++,
                role: 'assistant',
                kind: extra.length ? 'parts' : 'text',
                text,
                parts: extra.length ? extra : undefined,
                ts: Date.now(),
              },
            ];
          });
          // Non-streamed replies close the turn here; refresh like `end` does.
          if (chat === activeRef.current) scheduleUsageRefresh(chat);
          break;
        }

        case 'approval': {
          const reqId = asString(frame.req_id);
          if (!reqId) break;
          ensureChat(chat);
          const tool = asString(frame.tool) || 'tool';
          const severity = asString(frame.severity) || 'info';
          const summary = asString(frame.summary);
          updateChat(chat, (prev) => {
            if (prev.some((m) => m.kind === 'approval' && m.approval?.reqId === reqId)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: nextId++,
                role: 'assistant',
                kind: 'approval',
                text: '',
                approval: { reqId, tool, severity, summary, status: 'pending' },
                ts: Date.now(),
              },
            ];
          });
          break;
        }

        case 'hist': {
          ensureChat(chat);
          const rt = runtimeOf(chat);
          rt.histPending = false;
          appendHistory(chat, historyMessages(frame.messages));
          if (frame.more === true) {
            rt.histOpen = true;
          } else {
            rt.histOpen = false;
            rt.loaded = true;
          }
          break;
        }

        case 'file_ready': {
          const id = asString(frame.id);
          const up = uploadRef.current;
          if (!up || up.id !== id) break;
          if (up.timer) {
            clearTimeout(up.timer);
            up.timer = null;
          }
          uploadRef.current = null;
          setComposerError(null);
          setAttachment((prev) =>
            prev && prev.kind === 'chunked' && prev.id === id
              ? { ...prev, status: 'ready', ref: id, sent: prev.chunks }
              : prev,
          );
          break;
        }

        case 'file_error': {
          const id = asString(frame.id);
          const up = uploadRef.current;
          if (!up || up.id !== id) break;
          if (up.timer) {
            clearTimeout(up.timer);
            up.timer = null;
          }
          const code = asString(frame.code) || 'E_STATE';
          const detail = asString(frame.msg);
          if (code === 'E_CHECKSUM' && !up.retried) {
            up.retried = true;
            void runUpload(up);
            break;
          }
          failUpload(up, `文件传输失败：${code}${detail ? ` — ${detail}` : ''}`);
          break;
        }

        case 'export_begin': {
          const job = exportRef.current;
          if (!job || asString(frame.id) !== job.id) break;
          const bytes = typeof frame.bytes === 'number' ? frame.bytes : 0;
          const chunks = typeof frame.chunks === 'number' ? frame.chunks : 0;
          const sha = asString(frame.sha256);
          if (
            !Number.isInteger(bytes) ||
            !Number.isInteger(chunks) ||
            bytes <= 0 ||
            chunks <= 0 ||
            chunks > MAX_EXPORT_CHUNKS ||
            !sha
          ) {
            failExport(job, '导出失败：插件返回的文档信息无效');
            break;
          }
          if (bytes > MAX_EXPORT_BYTES) {
            failExport(job, '导出失败：文档超过 10MB');
            break;
          }
          job.bytes = bytes;
          job.chunks = chunks;
          job.sha256 = sha;
          job.parts.clear();
          break;
        }

        case 'export_chunk': {
          const job = exportRef.current;
          if (!job || asString(frame.id) !== job.id) break;
          const index = frame.i;
          const payload = frame.data;
          if (
            typeof index !== 'number' ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= job.chunks ||
            typeof payload !== 'string'
          ) {
            break;
          }
          job.parts.set(index, payload);
          break;
        }

        case 'export_end': {
          const job = exportRef.current;
          if (!job || asString(frame.id) !== job.id) break;
          // Detach before the async verification so a duplicated end frame
          // cannot start a second save.
          exportRef.current = null;
          setExporting(false);
          if (job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
          }
          void finishExport(job);
          break;
        }

        case 'resync': {
          flushNow();
          const rt = runtimeOf(chat);
          rt.activeId = null;
          rt.endedId = null;
          rt.histOpen = false;
          rt.histPending = false;
          rt.loaded = false;
          ensureChat(chat);
          updateChat(chat, () => []);
          requestHist(chat);
          break;
        }

        case 'status': {
          const name = asString(frame.agent_name);
          if (name) setAgentName(name);
          const provider = asString(frame.provider);
          const model = asString(frame.model);
          if (provider && model) setCurrentModel({ provider, model });
          break;
        }

        case 'models': {
          const items = modelItemsOf(frame.items);
          setModelItems(items);
          const active = items.find((item) => item.active);
          setCurrentModel(active ? { provider: active.provider, model: active.model } : null);
          break;
        }

        case 'model_changed': {
          const provider = asString(frame.provider);
          const model = asString(frame.model);
          if (provider && model) {
            setCurrentModel({ provider, model });
            setModelItems((prev) =>
              prev.map((item) => ({
                ...item,
                active: item.provider === provider && item.model === model,
              })),
            );
          }
          setModelBusy(false);
          setPickerOpen(false);
          setInlineSubMode(null);
          // A preference is keyed by provider:model, so the new model has its
          // own value/default. Re-align the visible chat (control frame: never
          // replayed on reconnect, always requested explicitly).
          requestEffort(activeRef.current);
          // The context window belongs to the model, so the usage line's
          // denominator may just have changed (M11).
          requestUsage(activeRef.current);
          break;
        }

        case 'usage': {
          setUsageByChat((prev) => ({ ...prev, [chat]: usageOf(frame) }));
          break;
        }

        case 'search_results': {
          // Only the request we are still waiting for may fill the hits area;
          // a late reply for a superseded query is dropped.
          const job = searchRef.current;
          if (!job || asString(frame.id) !== job.id) break;
          if (job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
          }
          searchRef.current = null;
          setHits(searchHitsOf(frame.items));
          setSearchState('done');
          break;
        }

        case 'effort': {
          const level = asEffortLevel(frame.level);
          if (!level) break;
          applyEffortLevel(chat, level);
          mergeEffortMeta(chat, {
            confirmed: level,
            supported: effortSupportedOf(frame.supported),
            kind: asString(frame.kind),
            modelKey: asString(frame.model_key),
            pending: false,
          });
          break;
        }

        case 'skills': {
          setSkills(mergeSkillItems(frame.items));
          break;
        }

        case 'chats': {
          if (Array.isArray(frame.items)) {
            const incomingIds: string[] = [];
            const incomingTitles: Record<string, string> = {};
            for (const raw of frame.items) {
              if (!raw || typeof raw !== 'object') continue;
              const rec = raw as { chat?: unknown; title?: unknown };
              const cid = asString(rec.chat);
              if (!cid) continue;
              incomingIds.push(cid);
              const t = asString(rec.title).trim();
              if (t) incomingTitles[cid] = t;
            }
            if (incomingIds.length > 0) {
              setChatIds((prev) => {
                const merged = [...prev];
                for (const cid of incomingIds) {
                  if (!merged.includes(cid)) merged.push(cid);
                }
                return merged;
              });
              setMessagesByChat((prev) => {
                const next = { ...prev };
                for (const cid of incomingIds) {
                  if (!(cid in next)) next[cid] = [];
                }
                return next;
              });
              if (Object.keys(incomingTitles).length > 0) {
                setChatNames((prev) => ({ ...incomingTitles, ...prev }));
              }
            }
          }
          break;
        }

        case 'prompts': {
          if (frame.files && typeof frame.files === 'object') {
            const filesObj = frame.files as Record<string, unknown>;
            setPromptFiles((prev) => {
              const next = { ...prev };
              for (const k of PROMPT_FILE_TABS) {
                if (typeof filesObj[k] === 'string') {
                  next[k] = filesObj[k] as string;
                }
              }
              return next;
            });
            setPromptStatus('已从容器加载最新提示词文件');
          }
          break;
        }

        case 'prompt_saved': {
          const file = asString(frame.file);
          setPromptStatus(`✅ ${file || '提示词'} 已保存到容器工作区并生效！`);
          break;
        }

        case 'error': {
          const code = asString(frame.code) || 'E_UNKNOWN';
          const detail = asString(frame.detail);
          // M13: a search failure is request-scoped too — it belongs in the
          // hits area, not in the generic toast.
          if (code === 'E_SEARCH') {
            const job = searchRef.current;
            if (job && asString(frame.id) === job.id) {
              if (job.timer) clearTimeout(job.timer);
              job.timer = null;
              searchRef.current = null;
              setHits([]);
              setSearchState('unavailable');
            }
            break;
          }
          // M12: an export failure is request-scoped — it must not fall
          // through to the generic toast and must not touch the socket.
          if (
            (code === 'E_EXPORT' || code === 'E_TOOBIG') &&
            exportRef.current &&
            asString(frame.id) === exportRef.current.id
          ) {
            failExport(
              exportRef.current,
              `导出失败：${code}${detail ? ` — ${detail}` : ''}`,
            );
            break;
          }
          const reqId = asString(frame.req_id);
          if (reqId) {
            updateChat(chat, (prev) =>
              prev.map((m) =>
                m.kind === 'approval' && m.approval && m.approval.reqId === reqId
                  ? { ...m, approval: { ...m.approval, status: 'error', error: code } }
                  : m,
              ),
            );
          }
          if (code === 'E_MODEL') setModelBusy(false);
          if (code === 'E_PROMPT') setPromptStatus(`❌ 保存失败: ${detail}`);
          if (code === 'E_EFFORT') {
            const effortReq = asString(frame.id);
            const effortChat = asString(frame.chat) || activeRef.current;
            const status = typeof frame.status === 'number' ? frame.status : 0;
            if (effortReq === 'effort-set') {
              // 404 means "the chat has no server record yet" (it is created
              // by its first message). Keep the local choice; send() retries
              // it after that message. Everything else is a real rejection.
              if (status !== 404) {
                const meta = effortMetaRef.current[effortChat];
                const rollback =
                  meta?.confirmed ?? effortRollbackRef.current[effortChat] ?? 'default';
                applyEffortLevel(effortChat, rollback);
              }
              mergeEffortMeta(effortChat, { pending: false });
              showToastBriefly(detail ? `思考等级未生效 — ${detail}` : '思考等级未生效');
            } else if (effortReq !== 'effort-get') {
              showToastBriefly(detail ? `思考等级未生效 — ${detail}` : '思考等级未生效');
            }
            // get_effort failures are silent: a new chat has no record yet,
            // and the local selection is still the best thing to show.
            break;
          }
          setToast(detail ? `${code} — ${detail}` : code);
          break;
        }

        case 'ready':
        case 'peer':
          break;

        default:
          break;
      }
    };

    const client = new RelayClient({
      url: activeWsUrl,
      getToken: () => (requiresAuth ? readToken() : null),
      onAuthFailure: requiresAuth
        ? () => {
            // Only the credential goes away; chats, titles, effort and theme
            // are local data and survive a re-login.
            clearStoredAuth();
            setNeedsLogin(true);
          }
        : undefined,
      onState: (next, info) => {
        setState(next);
        setAgentOnline(info.agentOnline);
        if (next === 'live') {
          maybeRequestHist(activeRef.current);
          // Control frames are not replayed, so re-align the visible chat's
          // thinking level on every (re)connect.
          clientRef.current?.send({
            t: 'get_effort',
            chat: activeRef.current,
            id: 'effort-get',
          });
          // Same for the usage line (M11): control frames are not replayed.
          requestUsage(activeRef.current);
          if (!modelsRequested.current) {
            modelsRequested.current = true;
            clientRef.current?.send({ t: 'models' });
            clientRef.current?.send({ t: 'chats' });
            clientRef.current?.send({ t: 'skills' });
          }
        } else if (next === 'connecting' || next === 'resuming') {
          modelsRequested.current = false;
          for (const rt of runtimes.current.values()) {
            rt.histPending = false;
            rt.histOpen = false;
          }
        }
      },
      onFrame,
    });
    clientRef.current = client;
    client.setActiveChat(activeRef.current);
    client.connect();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      client.close();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect when endpoint or login changes
  }, [needsLogin, activeWsUrl, requiresAuth]);

  const messages = messagesByChat[activeChat] ?? [];
  const streaming = messages.some((m) => m.streaming);
  const activeEffort = effortLevels[activeChat] ?? 'default';
  const activeEffortSupported = effortMeta[activeChat]?.supported ?? null;
  const usageText = usageLine(usageByChat[activeChat]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const chatChanged = lastChatRef.current !== activeChat;
    lastChatRef.current = activeChat;
    if (!chatChanged && !nearBottomRef.current) return;
    nearBottomRef.current = true;
    setNearBottom(true);
    el.scrollTop = el.scrollHeight;
  }, [messages, activeChat]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    nearBottomRef.current = atBottom;
    setNearBottom(atBottom);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = true;
    setNearBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const derivedTitle = (id: string): string => {
    const list = messagesByChat[id] ?? [];
    const first = list.find((m) => m.role === 'user' && m.text.trim());
    if (!first) return 'New chat';
    const text = first.text.trim().replace(/\s+/g, ' ');
    // Count code points, not UTF-16 units: a plain slice() can cut a surrogate
    // pair in half and render the title as a lone replacement glyph.
    const chars = Array.from(text);
    return chars.length > 34 ? `${chars.slice(0, 34).join('')}…` : text;
  };

  const titleOf = (id: string): string => {
    const custom = chatNames[id];
    return custom && custom.trim() ? custom : derivedTitle(id);
  };

  /** Ask the plugin for the visible chat's Markdown export (M12). */
  const startExport = () => {
    if (exportRef.current) return;
    const client = clientRef.current;
    if (!client) {
      showToastBriefly('未连接 — 无法导出');
      return;
    }
    const chat = activeChat;
    const nonce = Math.random().toString(36).slice(2, 6);
    const job: ExportJob = {
      id: `export-${Date.now().toString(36)}-${exportCounter++}-${nonce}`,
      title: titleOf(chat),
      bytes: 0,
      chunks: 0,
      sha256: '',
      parts: new Map(),
      timer: null,
    };
    exportRef.current = job;
    setExporting(true);
    job.timer = setTimeout(
      () => failExport(job, '导出超时：插件未返回完整文档'),
      EXPORT_TIMEOUT_MS,
    );
    if (!client.send({ t: 'export', chat, id: job.id })) {
      failExport(job, '未连接 — 无法导出');
    }
  };

  const query = search.trim().toLowerCase();
  const visibleChats = query
    ? chatIds.filter((id) => titleOf(id).toLowerCase().includes(query))
    : chatIds;

  const requestModels = () => {
    clientRef.current?.send({ t: 'models' });
  };

  const chooseEffort = (level: EffortLevel) => {
    const chat = activeRef.current;
    const current = effortLevelsRef.current[chat] ?? 'default';
    if (level === current) return;
    const supported = effortMetaRef.current[chat]?.supported;
    if (level !== 'default' && supported != null && !supported.includes(level)) {
      return;
    }
    const client = clientRef.current;
    if (!client) {
      showToastBriefly('未连接 — 思考等级未设置');
      return;
    }
    effortRollbackRef.current[chat] = current;
    applyEffortLevel(chat, level);
    mergeEffortMeta(chat, { pending: true });
    if (!client.send({ t: 'set_effort', chat, level, id: 'effort-set' })) {
      applyEffortLevel(chat, current);
      mergeEffortMeta(chat, { pending: false });
      showToastBriefly('未连接 — 思考等级未设置');
    }
  };

  /**
   * A chat only gets its server record on its first message. If the user has
   * an unconfirmed local level, retry it once that turn had time to create
   * the chat; the 404 reply itself deliberately keeps the local choice.
   */
  const scheduleEffortReapply = (chat: string) => {
    const level = effortLevelsRef.current[chat] ?? 'default';
    const meta = effortMetaRef.current[chat];
    if (level === 'default' || meta?.confirmed === level) return;
    if (effortRetryTimers.current.has(chat)) return;
    const timer = setTimeout(() => {
      effortRetryTimers.current.delete(chat);
      const current = effortLevelsRef.current[chat] ?? 'default';
      const now = effortMetaRef.current[chat];
      if (current === 'default' || now?.confirmed === current) return;
      const client = clientRef.current;
      if (!client) return;
      effortRollbackRef.current[chat] = now?.confirmed ?? 'default';
      mergeEffortMeta(chat, { pending: true });
      if (!client.send({ t: 'set_effort', chat, level: current, id: 'effort-set' })) {
        mergeEffortMeta(chat, { pending: false });
      }
    }, EFFORT_REAPPLY_MS);
    effortRetryTimers.current.set(chat, timer);
  };

  const openModelPicker = () => {
    setPickerOpen(true);
    if (modelItems.length === 0) requestModels();
  };

  const toggleModelPicker = () => {
    if (pickerOpen) setPickerOpen(false);
    else openModelPicker();
  };

  const chooseModel = (item: ModelItem) => {
    if (modelBusy) return;
    if (item.active) {
      setPickerOpen(false);
      setInlineSubMode(null);
      return;
    }
    if (!clientRef.current?.send({ t: 'set_model', provider: item.provider, model: item.model })) {
      setToast('未连接：模型未切换');
      return;
    }
    setModelBusy(true);
  };

  const chooseSkill = (skill: SkillItem) => {
    setActiveSkill(skill);
    setInlineSubMode(null);
    // Strip trailing `@query` or leading `/skill` from input
    setInput((prev) => {
      if (prev.startsWith('/skill')) return '';
      return prev.replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, '');
    });
    textareaRef.current?.focus();
  };

  const switchEndpoint = () => {
    const next = endpointMode === 'local' ? 'cloud' : 'local';
    storageSet(ENDPOINT_KEY, next);
    setEndpointMode(next);
    if (next === 'cloud' && !readToken()) {
      setNeedsLogin(true);
    } else {
      setNeedsLogin(false);
    }
  };

  /** Drop the stored credential and go back to the login gate (M11). */
  const logout = () => {
    clearStoredAuth();
    setNeedsLogin(true);
  };

  const openPromptDrawer = () => {
    setPromptDrawerOpen(true);
    setPromptStatus('正在从容器读取提示词文件…');
    clientRef.current?.send({ t: 'get_prompts' });
  };

  const saveCurrentPrompt = () => {
    const content = promptFiles[activePromptTab] ?? '';
    if (!clientRef.current?.send({ t: 'set_prompt', file: activePromptTab, content })) {
      setPromptStatus('❌ 未连接到 Relay，无法保存');
      return;
    }
    setPromptStatus(`正在保存 ${activePromptTab}…`);
  };

  const applyFeynmanPreset = () => {
    setPromptFiles((prev) => ({
      ...prev,
      'SOUL.md': FEYNMAN_SOUL_MD,
      'AGENTS.md': FEYNMAN_AGENTS_MD,
    }));
    const client = clientRef.current;
    if (client && state === 'live') {
      client.send({ t: 'set_prompt', file: 'SOUL.md', content: FEYNMAN_SOUL_MD });
      client.send({ t: 'set_prompt', file: 'AGENTS.md', content: FEYNMAN_AGENTS_MD });
      setPromptStatus('✨ 已填入费曼第一性原理导师模板并同步保存到容器！');
    } else {
      setPromptStatus('✨ 已填入费曼第一性原理导师模板（连接后点击保存生效）');
    }
  };

  const startRename = (id: string) => {
    if (!chatIds.includes(id)) return;
    setSidebarOpen(true);
    setRenamingId(id);
    setRenameDraft(titleOf(id));
  };

  const commitRename = () => {
    const id = renamingId;
    if (!id) return;
    const name = renameDraft.trim();
    setChatNames((prev) => {
      const next = { ...prev };
      if (name) next[id] = name;
      else delete next[id];
      return next;
    });
    if (name) {
      clientRef.current?.send({ t: 'rename_chat', chat: id, title: name });
    }
    setRenamingId(null);
    setRenameDraft('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const selectChat = (id: string) => {
    setActiveChat(id);
    activeRef.current = id;
    clientRef.current?.setActiveChat(id);
    setSidebarOpen(false);
    cancelUpload();
    setComposerError(null);
    setAttachment(null);
    maybeRequestHist(id);
  };

  /** Hit title: local rename → archived title → the chat id itself. */
  const hitTitle = (hit: SearchHit): string => {
    const custom = chatNames[hit.chat];
    if (custom && custom.trim()) return custom;
    if (hit.title.trim()) return hit.title;
    return hit.chat;
  };

  /** Open a hit's chat, adopting it from the archive when it is not local. */
  const openSearchHit = (hit: SearchHit) => {
    if (!chatIds.includes(hit.chat)) ensureChat(hit.chat);
    selectChat(hit.chat);
  };

  const newChat = () => {
    const id = newChatId();
    setChatIds((prev) => (prev.includes(id) ? prev : [id, ...prev]));
    setMessagesByChat((prev) => ({ ...prev, [id]: [] }));
    setActiveChat(id);
    activeRef.current = id;
    clientRef.current?.setActiveChat(id);
    setSidebarOpen(false);
    cancelUpload();
    setComposerError(null);
    setAttachment(null);
    maybeRequestHist(id);
  };

  const deleteChat = (id: string) => {
    const title = titleOf(id);
    if (!window.confirm(`删除会话「${title}」？`)) return;
    clientRef.current?.send({ t: 'del_chat', chat: id });
    const remaining = chatIds.filter((item) => item !== id);
    setChatIds(remaining);
    setMessagesByChat((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setChatNames((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    runtimes.current.delete(id);
    forgetEffort(id);
    setUsageByChat((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const usageTimer = usageTimers.current.get(id);
    if (usageTimer) {
      clearTimeout(usageTimer);
      usageTimers.current.delete(id);
    }
    if (renamingId === id) cancelRename();
    if (id !== activeChat) return;
    if (remaining.length > 0) selectChat(remaining[0]);
    else newChat();
  };

  const stop = () => {
    clientRef.current?.send({ t: 'stop', chat: activeChat });
  };

  const runCommand = (id: string) => {
    setPaletteMuted(null);
    setPaletteIndex(0);
    switch (id) {
      case 'model':
        // Stay right above the input box in inline model selection mode!
        setInput('');
        if (modelItems.length === 0) requestModels();
        setInlineSubMode('model');
        break;
      case 'skill':
        setInput('');
        clientRef.current?.send({ t: 'skills' });
        setInlineSubMode('skill');
        break;
      case 'new':
        setInput('');
        newChat();
        break;
      case 'stop':
        setInput('');
        stop();
        break;
      case 'prompt':
        setInput('');
        openPromptDrawer();
        break;
      case 'rename':
        setInput('');
        startRename(activeChat);
        break;
      case 'delete':
        setInput('');
        deleteChat(activeChat);
        break;
      case 'clear':
        setInput('');
        updateChat(activeChat, () => []);
        break;
      case 'theme':
        setInput('');
        toggleTheme();
        break;
      case 'help':
        setInput('');
        setHelpOpen(true);
        break;
      default:
        break;
    }
  };

  const removeAttachment = () => {
    cancelUpload();
    setAttachment(null);
    setComposerError(null);
  };

  const sendTextDirect = (rawText: string) => {
    const client = clientRef.current;
    if (!client) return;
    const chat = activeChat;
    const text = rawText.trim();
    if (!text) return;
    const frame: Frame = { t: 'msg', chat, text };
    const size = byteSize(frame);
    if (size > MAX_FRAME_BYTES) {
      setComposerError(oversizeError(size));
      return;
    }
    if (!client.send(frame)) {
      setComposerError('未连接 — 正在重连，请稍后重试。');
      return;
    }
    scheduleEffortReapply(chat);
    nearBottomRef.current = true;
    setNearBottom(true);
    updateChat(chat, (prev) => [
      ...prev,
      {
        id: nextId++,
        role: 'user',
        kind: 'text',
        text,
        ts: Date.now(),
      },
    ]);
  };

  const send = () => {
    const client = clientRef.current;
    if (!client) return;
    const chat = activeChat;
    const rawInput = input.trim();
    const file = attachment;
    if (!rawInput && !file) return;
    if (file && file.kind === 'chunked' && file.status !== 'ready') return;

    // If a skill is attached, prepend its structured instruction for the agent while keeping display clean
    const wireText = activeSkill
      ? `${activeSkill.instruction ?? `[使用技能: ${activeSkill.id}]`}\n\n${rawInput}`
      : rawInput;
    const displayText = activeSkill ? `@${activeSkill.id} ${rawInput}` : rawInput;

    const frame: Frame = { t: 'msg', chat, text: wireText };
    if (file) {
      frame.files =
        file.kind === 'inline'
          ? [{ name: file.name, mime: file.mime, data: file.data }]
          : [{ ref: file.ref ?? file.id }];
    }

    const size = byteSize(frame);
    if (size > MAX_FRAME_BYTES) {
      setComposerError(oversizeError(size));
      return;
    }
    if (!client.send(frame)) {
      setComposerError('未连接 — 正在重连，请稍后重试。');
      return;
    }
    scheduleEffortReapply(chat);
    nearBottomRef.current = true;
    setNearBottom(true);
    updateChat(chat, (prev) => [
      ...prev,
      {
        id: nextId++,
        role: 'user',
        kind: 'text',
        text: displayText,
        attachments: file ? [file.name] : undefined,
        ts: Date.now(),
      },
    ]);
    setInput('');
    setAttachment(null);
    setActiveSkill(null);
    setComposerError(null);
  };

  const handleRegenerate = (assistantMsg: ChatMessage) => {
    if (streaming) return;
    const list = messagesByChat[activeChat] ?? [];
    const idx = list.findIndex((m) => m.id === assistantMsg.id);
    if (idx <= 0) return;
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (list[i].role === 'user' && list[i].text.trim()) {
        sendTextDirect(list[i].text);
        return;
      }
    }
  };

  const handleEditResend = (userMsg: ChatMessage) => {
    setInput(userMsg.text);
    textareaRef.current?.focus();
  };

  const onApproval = (chat: string, message: ChatMessage, action: 'approve' | 'deny') => {
    const approval = message.approval;
    const client = clientRef.current;
    if (!approval || approval.status !== 'pending' || !client) return;
    if (answeredApprovals.current.has(approval.reqId)) return;
    if (!client.send({ t: action, chat, req_id: approval.reqId })) {
      setToast('未连接 — 审批指令未发送。');
      return;
    }
    answeredApprovals.current.add(approval.reqId);
    updateChat(chat, (prev) =>
      prev.map((m) =>
        m.id === message.id && m.approval
          ? { ...m, approval: { ...m.approval, status: 'sent', action } }
          : m,
      ),
    );
  };

  // ---- Unified Inline Palette above Composer (`/` commands, `/model ...`, or `@skill`) ----
  const atMatch = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(input);
  const isAtTyping = Boolean(atMatch) && paletteMuted !== input;
  const isSlashModelTyping = /^\/model(?:\s+(.*))?$/i.test(input) && paletteMuted !== input;
  const isSlashSkillTyping = /^\/skill(?:\s+(.*))?$/i.test(input) && paletteMuted !== input;
  const isSlashCmdTyping =
    input.startsWith('/') &&
    !/\s/.test(input) &&
    !isSlashModelTyping &&
    !isSlashSkillTyping &&
    paletteMuted !== input;

  type PaletteMode = 'cmd' | 'model' | 'skill' | null;
  let activePaletteMode: PaletteMode = inlineSubMode;
  let filterQuery = '';

  if (isSlashModelTyping) {
    activePaletteMode = 'model';
    filterQuery = (input.replace(/^\/model\s*/i, '') || '').toLowerCase();
  } else if (isSlashSkillTyping) {
    activePaletteMode = 'skill';
    filterQuery = (input.replace(/^\/skill\s*/i, '') || '').toLowerCase();
  } else if (isAtTyping && atMatch) {
    activePaletteMode = 'skill';
    filterQuery = (atMatch[1] || '').toLowerCase();
  } else if (isSlashCmdTyping) {
    activePaletteMode = 'cmd';
    filterQuery = input.slice(1).toLowerCase();
  }

  const filteredCommands =
    activePaletteMode === 'cmd'
      ? COMMANDS.filter((cmd) => cmd.id.toLowerCase().startsWith(filterQuery))
      : [];

  const filteredModels =
    activePaletteMode === 'model'
      ? modelItems.filter(
          (m) =>
            !filterQuery ||
            m.model.toLowerCase().includes(filterQuery) ||
            m.provider.toLowerCase().includes(filterQuery),
        )
      : [];

  const filteredSkills =
    activePaletteMode === 'skill'
      ? skills.filter(
          (s) =>
            !filterQuery ||
            s.id.toLowerCase().includes(filterQuery) ||
            s.name.toLowerCase().includes(filterQuery) ||
            s.description.toLowerCase().includes(filterQuery),
        )
      : [];

  const activeListLength =
    activePaletteMode === 'cmd'
      ? filteredCommands.length
      : activePaletteMode === 'model'
        ? filteredModels.length
        : activePaletteMode === 'skill'
          ? filteredSkills.length
          : 0;

  const paletteOpen = activePaletteMode !== null && (activeListLength > 0 || activePaletteMode === 'model');
  const paletteCursor = activeListLength > 0 ? Math.min(paletteIndex, activeListLength - 1) : 0;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (paletteOpen) {
      if (e.key === 'ArrowDown' && activeListLength > 0) {
        e.preventDefault();
        setPaletteIndex((index) => (index + 1) % activeListLength);
        return;
      }
      if (e.key === 'ArrowUp' && activeListLength > 0) {
        e.preventDefault();
        setPaletteIndex((index) => (index - 1 + activeListLength) % activeListLength);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInlineSubMode(null);
        setPaletteMuted(input);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (activePaletteMode === 'cmd') {
          const cmd = filteredCommands[paletteCursor];
          if (cmd) runCommand(cmd.id);
        } else if (activePaletteMode === 'model') {
          const item = filteredModels[paletteCursor];
          if (item) {
            setInput('');
            chooseModel(item);
          }
        } else if (activePaletteMode === 'skill') {
          const skill = filteredSkills[paletteCursor];
          if (skill) chooseSkill(skill);
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const handleFileObject = (file: File) => {
    cancelUpload();
    const mime = file.type || 'application/octet-stream';
    const reader = new FileReader();
    reader.onerror = () => setComposerError('无法读取该文件。');
    reader.onload = () => {
      const buffer = reader.result;
      if (!(buffer instanceof ArrayBuffer)) {
        setComposerError('无法读取该文件。');
        return;
      }
      if (file.size <= INLINE_PROBE_BYTES) {
        const data = base64Of(new Uint8Array(buffer));
        if (!data) {
          setComposerError('无法读取该文件。');
          return;
        }
        const probe: Frame = {
          t: 'msg',
          chat: activeRef.current,
          text: input.trim(),
          files: [{ name: file.name, mime, data }],
        };
        if (byteSize(probe) <= MAX_FRAME_BYTES) {
          setComposerError(null);
          setAttachment({ kind: 'inline', name: file.name, mime, data, size: file.size });
          return;
        }
      }
      if (file.size > MAX_FILE_BYTES) {
        setAttachment(null);
        setComposerError(`附件太大：单个附件上限 10MB，当前约 ${fmtKb(file.size)}`);
        return;
      }
      startChunkedUpload(file, buffer, mime);
    };
    reader.readAsArrayBuffer(file);
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    handleFileObject(file);
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleFileObject(file);
          return;
        }
      }
    }
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      if (!draggingFile) setDraggingFile(true);
    }
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDraggingFile(false);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingFile(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileObject(file);
  };

  const uploadBlocked = attachment?.kind === 'chunked' && attachment.status !== 'ready';
  const canSend =
    state === 'live' && (input.trim().length > 0 || attachment != null) && !uploadBlocked;

  if (needsLogin) {
    return (
      <LoginGate
        httpUrl={activeHttpUrl}
        onSuccess={(token, expires) => {
          rememberAuth(token, expires);
          setNeedsLogin(false);
        }}
        onSwitchLocal={
          !LOGIN_REQUIRED
            ? () => {
                storageSet(ENDPOINT_KEY, 'local');
                setEndpointMode('local');
                setNeedsLogin(false);
              }
            : undefined
        }
      />
    );
  }

  return (
    <div
      className={`app${sidebarOpen ? ' sidebar-open' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {draggingFile ? (
        <div className="drop-overlay">
          <Paperclip size={36} />
          <span>松开鼠标即可上传附件（最大支持 10MB 分片直传）</span>
        </div>
      ) : null}

      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">
            <span className="brand-logo">
              <Sparkles size={14} />
            </span>
            <span>QwenPaw</span>
          </div>
          <span className="brand-badge">Studio</span>
        </div>

        <button className="new-chat" onClick={newChat}>
          <span className="new-chat-left">
            <Plus size={15} />
            <span>新建会话</span>
          </span>
          <span className="new-chat-kbd">/new</span>
        </button>

        <div className="search-wrap">
          <Search size={13} className="search-icon" />
          <input
            className="chat-search"
            type="search"
            value={search}
            placeholder="搜索会话或正文…"
            aria-label="搜索会话与正文"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="sidebar-section-label">
          <span>对话记录 ({visibleChats.length})</span>
          <button
            className="chat-act"
            title="从容器刷新会话列表"
            onClick={() => clientRef.current?.send({ t: 'chats' })}
          >
            <RefreshCw size={11} />
          </button>
        </div>

        <nav className="chat-list">
          {visibleChats.length === 0 ? (
            <div className="chat-none">{chatIds.length === 0 ? '还没有会话' : '无匹配会话'}</div>
          ) : null}
          {visibleChats.map((id) => (
            <div
              key={id}
              className={`chat-item${id === activeChat ? ' active' : ''}${
                renamingId === id ? ' renaming' : ''
              }`}
            >
              {renamingId === id ? (
                <input
                  className="chat-rename"
                  value={renameDraft}
                  autoFocus
                  aria-label="会话名称"
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelRename();
                    }
                  }}
                />
              ) : (
                <button
                  className="chat-title"
                  onClick={() => selectChat(id)}
                  onDoubleClick={() => startRename(id)}
                  title={titleOf(id)}
                >
                  <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.65 }} />
                  <span className="chat-title-text">{titleOf(id)}</span>
                </button>
              )}
              <span className="chat-id">{id}</span>
              <span className="chat-actions">
                <button
                  className="chat-act"
                  title="重命名"
                  aria-label="重命名会话"
                  onClick={() => startRename(id)}
                >
                  <Edit3 size={12} />
                </button>
                <button
                  className="chat-act danger"
                  title="删除"
                  aria-label="删除会话"
                  onClick={() => deleteChat(id)}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}
        </nav>

        {query ? (
          <section className="search-hits" aria-label="正文命中">
            <div className="search-hits-note">搜索范围为已归档的历史，未归档的对话搜不到</div>
            {searchState === 'loading' ? <div className="search-hits-status">搜索中…</div> : null}
            {searchState === 'unavailable' ? (
              <div className="search-hits-status">搜索暂不可用（归档未配置或服务异常）</div>
            ) : null}
            {searchState === 'done' && hits.length === 0 ? (
              <div className="search-hits-status">无正文命中</div>
            ) : null}
            {hits.map((hit, index) => {
              const parts = snippetParts(hit);
              const archivedOnly = !chatIds.includes(hit.chat);
              return (
                <button
                  key={`${hit.chat}-${hit.ts ?? 0}-${index}`}
                  type="button"
                  className="search-hit"
                  onClick={() => openSearchHit(hit)}
                  title={hitTitle(hit)}
                >
                  <span className="search-hit-title">
                    <span className="search-hit-title-text">{hitTitle(hit)}</span>
                    {archivedOnly ? <span className="search-hit-badge">仅归档</span> : null}
                  </span>
                  <span className="search-hit-meta">
                    {hit.role === 'user' ? '我' : '助手'}
                    {hit.ts != null ? ` · ${clockOf(hit.ts)}` : ''}
                  </span>
                  <span className="search-hit-snippet">
                    {parts.before}
                    {parts.match ? <mark>{parts.match}</mark> : null}
                    {parts.after}
                  </span>
                </button>
              );
            })}
          </section>
        ) : null}

        <div className="sidebar-foot">
          {!LOGIN_REQUIRED ? (
            <button
              className="endpoint-switch"
              onClick={switchEndpoint}
              title="点击在「本地免密演示节点」与「阿里云真实容器 (CF Relay)」之间切换"
            >
              <Cloud size={12} />
              <span>{endpointMode === 'cloud' ? '云端 CF 节点' : '本地演示节点'}</span>
            </button>
          ) : (
            <span>
              {BUILD_GIT === 'unknown' || BUILD_GIT === 'dev'
                ? 'WebChannel · v2'
                : `WebChannel · v2 · ${BUILD_GIT}`}
            </span>
          )}
          <div className="sidebar-foot-actions">
            {requiresAuth ? (
              <button
                className="help-btn"
                onClick={logout}
                title="退出登录（清除本机保存的访问凭证）"
                aria-label="退出登录"
              >
                <LogOut size={13} />
              </button>
            ) : null}
            <button
              className="help-btn"
              onClick={openPromptDrawer}
              title="人设与提示词 (SOUL.md)"
              aria-label="人设与提示词"
            >
              <Sliders size={13} />
            </button>
            <button
              className="help-btn"
              onClick={() => setHelpOpen(true)}
              title="帮助"
              aria-label="帮助"
            >
              <HelpCircle size={13} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div className="top-left">
            <button
              className="hamburger"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="会话列表"
              aria-expanded={sidebarOpen}
            >
              <Menu size={18} />
            </button>
            <div className="top-titles">
              <div className="top-title">{titleOf(activeChat)}</div>
              {usageText ? (
                <div className="usage-line" title={USAGE_TITLE}>
                  {usageText}
                </div>
              ) : null}
            </div>
          </div>

          <div className="top-right">
            <div className="identity">
              <span className="agent-pill" title={`当前工作区 Agent: ${agentName || 'default'}`}>
                <Sparkles size={12} />
                <span className="agent-name">{agentName || 'Agent'}</span>
              </span>
            </div>

            <button
              className="icon-btn"
              onClick={startExport}
              disabled={exporting}
              title="导出当前会话为 Markdown（含思考过程与工具调用）"
              aria-label="导出当前会话"
            >
              <Download size={13} />
              <span>{exporting ? '导出中…' : '导出'}</span>
            </button>

            <button
              className="icon-btn"
              onClick={openPromptDrawer}
              title="在线配置 SOUL.md 与 AGENTS.md 人设提示词"
            >
              <Sliders size={13} />
              <span>人设</span>
            </button>

            <button
              className="icon-btn"
              onClick={toggleTheme}
              title={theme === 'dark' ? '切换到 Claude 暖陶纸本浅色' : '切换到 Cursor 曜石翡翠暗黑'}
              aria-label="切换主题"
            >
              {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
              <span>{theme === 'dark' ? '暖陶浅色' : '曜石暗黑'}</span>
            </button>

            <div className="status">
              <i className={`dot state-${state}`} />
              <span className="status-label">{STATE_LABEL[state]}</span>
              <i className={`dot agent-${agentOnline ? 'on' : 'off'}`} />
              <span className="status-label">{agentOnline ? 'Agent 在线' : 'Agent 离线'}</span>
            </div>
          </div>
        </header>

        {toast ? (
          <div className="toast" role="status">
            <span>{toast}</span>
            <button onClick={() => setToast(null)}>关闭</button>
          </div>
        ) : null}

        <div className="thread">
          <div className="messages" ref={listRef} onScroll={onListScroll}>
            {messages.length === 0 ? (
              <>
                <p className="empty">
                  No messages yet. Say hello — replies stream in through the relay.
                </p>
                <div className="welcome-hero">
                  <div className="welcome-icon">
                    <Sparkles size={22} />
                  </div>
                  <h2 className="welcome-title">
                    今天想拆解什么问题？
                  </h2>
                  <p className="welcome-sub">
                    输入 <code>@</code> 挂载技能（如 <code>@feynman</code>、<code>@web_search</code>）· 输入 <code>/model</code> 就地切换模型 · 一键复制纯正 Markdown 与表格
                  </p>
                  <div className="starter-grid">
                    {STARTER_PROMPTS.map((item) => (
                      <button
                        key={item.title}
                        className="starter-card"
                        onClick={() => {
                          if (item.skill) {
                            const found = skills.find((s) => s.id === item.skill);
                            if (found) setActiveSkill(found);
                          }
                          setInput(item.prompt);
                          textareaRef.current?.focus();
                        }}
                      >
                        <div className="starter-card-icon">
                          <StarterIcon name={item.icon} />
                        </div>
                        <div className="starter-card-body">
                          <div className="starter-card-title">
                            <span>{item.title}</span>
                            {item.skill ? (
                              <span className="starter-skill-tag">@{item.skill}</span>
                            ) : null}
                          </div>
                          <div className="starter-card-desc">{item.desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                chat={activeChat}
                onApproval={onApproval}
                onRegenerate={handleRegenerate}
                onEditResend={handleEditResend}
              />
            ))}
          </div>
          {!nearBottom && messages.length > 0 ? (
            <button
              className="scroll-bottom"
              onClick={scrollToBottom}
              title="回到最新"
              aria-label="回到最新"
            >
              <ArrowDown size={15} />
            </button>
          ) : null}
        </div>

        <div className="composer">
          {paletteOpen ? (
            <div className="palette" role="listbox" aria-label="快捷面板">
              <div className="palette-head">
                <span>
                  {activePaletteMode === 'model'
                    ? '🤖 选择对话模型（↑↓ 选择，Enter 切换，Esc 返回）'
                    : activePaletteMode === 'skill'
                      ? '⚡ 选择要挂载的技能 Skill（↑↓ 选择，Enter 挂载，Esc 关闭）'
                      : '⌨️ 快捷指令面板（输入 / 触发，输入 @ 呼出技能）'}
                </span>
                <button
                  className="chat-act"
                  onClick={() => {
                    setInlineSubMode(null);
                    setPaletteMuted(input);
                  }}
                >
                  ×
                </button>
              </div>

              {activePaletteMode === 'cmd' &&
                filteredCommands.map((command, index) => (
                  <button
                    key={command.id}
                    className={`palette-row${index === paletteCursor ? ' active' : ''}`}
                    role="option"
                    aria-selected={index === paletteCursor}
                    onMouseEnter={() => setPaletteIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runCommand(command.id)}
                  >
                    <span className="palette-cmd">/{command.id}</span>
                    <span className="palette-label">{command.label}</span>
                    <span className="palette-hint">{command.hint}</span>
                  </button>
                ))}

              {activePaletteMode === 'model' &&
                (filteredModels.length === 0 ? (
                  <div className="model-empty">暂无可用模型（请确认 Agent 在线）</div>
                ) : (
                  filteredModels.map((item, index) => (
                    <button
                      key={`${item.provider}/${item.model}`}
                      className={`palette-row${index === paletteCursor ? ' active' : ''}`}
                      role="option"
                      aria-selected={index === paletteCursor}
                      onMouseEnter={() => setPaletteIndex(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setInput('');
                        chooseModel(item);
                      }}
                    >
                      <span className="palette-cmd">{item.provider}</span>
                      <span className="palette-label">{item.model}</span>
                      <span className="palette-hint">{item.active ? '● 当前生效模型' : '回车切换'}</span>
                    </button>
                  ))
                ))}

              {activePaletteMode === 'skill' &&
                filteredSkills.map((skill, index) => (
                  <button
                    key={skill.id}
                    className={`palette-row${index === paletteCursor ? ' active' : ''}`}
                    role="option"
                    aria-selected={index === paletteCursor}
                    onMouseEnter={() => setPaletteIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseSkill(skill)}
                  >
                    <span className="palette-cmd">@{skill.id}</span>
                    <span className="palette-label">{skill.name}</span>
                    <span className="palette-hint">{skill.description}</span>
                  </button>
                ))}
            </div>
          ) : null}

          {composerError ? <div className="composer-error">{composerError}</div> : null}

          <div className="composer-card">
            {activeSkill || attachment ? (
              <div className="chips">
                {activeSkill ? (
                  <span className="skill-chip" title={activeSkill.description}>
                    <Zap size={12} />
                    <span>@{activeSkill.id} · {activeSkill.name}</span>
                    <button
                      className="chip-x"
                      aria-label="移除技能"
                      onClick={() => setActiveSkill(null)}
                    >
                      ×
                    </button>
                  </span>
                ) : null}

                {attachment ? (
                  <>
                    <span
                      className={`chip${attachment.kind === 'chunked' ? ` upload-${attachment.status}` : ''}`}
                      title={`${attachment.name} (${fmtKb(attachment.size)})`}
                    >
                      <FileText size={12} />
                      {attachment.name}
                      {attachment.kind === 'chunked' && attachment.status === 'uploading' ? (
                        <span className="chip-upload">
                          <span className="chip-bar">
                            <i style={{ width: `${uploadPercent(attachment)}%` }} />
                          </span>
                          <span className="chip-count">
                            {attachment.sent}/{attachment.chunks}
                          </span>
                        </span>
                      ) : null}
                      <button
                        className="chip-x"
                        aria-label="Remove attachment"
                        onClick={removeAttachment}
                      >
                        ×
                      </button>
                    </span>
                    <span className="chip-note">{chipNote(attachment)}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="composer-row">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                placeholder={
                  state === 'live'
                    ? '输入问题…（敲 @ 调用技能，敲 / 呼出指令与模型切换，支持粘贴截图）'
                    : '正在连接 Relay 节点…'
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
            </div>

            <div className="composer-toolbar">
              <div className="composer-tools-left">
                <button
                  className="attach"
                  onClick={() => fileRef.current?.click()}
                  title="上传文件或直接 Ctrl+V 粘贴截图（最大 10MB）"
                >
                  <Paperclip size={13} />
                  <span>附件</span>
                </button>
                <input ref={fileRef} type="file" hidden onChange={onPickFile} />

                <button
                  className="tool-pill"
                  onClick={() => {
                    setInlineSubMode((prev) => (prev === 'skill' ? null : 'skill'));
                    clientRef.current?.send({ t: 'skills' });
                    textareaRef.current?.focus();
                  }}
                  title="挂载 Skill 技能 (@)"
                >
                  <AtSign size={13} />
                  <span>技能</span>
                </button>

                {/* Model Selector anchored right in the Composer Toolbar (pops UPWARDS!) */}
                <div className="model-wrap" ref={modelWrapRef}>
                  <button
                    className={`model-button${pickerOpen ? ' open' : ''}`}
                    onClick={toggleModelPicker}
                    aria-haspopup="listbox"
                    aria-expanded={pickerOpen}
                    title={
                      currentModel
                        ? `当前模型: ${currentModel.provider} / ${currentModel.model}`
                        : '点击切换对话模型'
                    }
                  >
                    <Cpu size={13} />
                    <span className="model-label">
                      {currentModel ? `${currentModel.provider} / ${currentModel.model}` : 'model —'}
                    </span>
                    <span className="model-caret" aria-hidden="true">
                      <ChevronUp size={12} />
                    </span>
                  </button>
                  {pickerOpen ? (
                    <div className="model-picker" role="listbox" aria-label="模型">
                      <div className="model-picker-header">
                        <span>切换对话模型 ({modelItems.length})</span>
                        <button className="chat-act" title="刷新模型列表" onClick={requestModels}>
                          <RefreshCw size={11} />
                        </button>
                      </div>
                      {modelItems.length === 0 ? (
                        <div className="model-empty">暂无可用模型</div>
                      ) : (
                        modelItems.map((item) => (
                          <button
                            key={`${item.provider}/${item.model}`}
                            className={`model-row${item.active ? ' active' : ''}`}
                            role="option"
                            aria-selected={item.active}
                            aria-current={item.active ? 'true' : undefined}
                            disabled={modelBusy}
                            onClick={() => chooseModel(item)}
                          >
                            <span className="model-row-model">{item.model}</span>
                            <span className="model-row-provider">{item.provider}</span>
                            {item.active ? (
                              <span className="model-row-check" aria-hidden="true">
                                ●
                              </span>
                            ) : null}
                          </button>
                        ))
                      )}
                      {modelBusy ? <div className="model-busy">正在热切换模型…</div> : null}
                    </div>
                  ) : null}
                </div>

                <div className="effort-wrap" title={EFFORT_TITLE}>
                  <span className="effort-label">思考等级</span>
                  <div className="effort-group" role="group" aria-label="思考等级">
                    {EFFORT_LEVELS.map((level) => {
                      const disabled =
                        level !== 'default' &&
                        activeEffortSupported != null &&
                        !activeEffortSupported.includes(level);
                      return (
                        <button
                          key={level}
                          type="button"
                          className={`effort-opt${activeEffort === level ? ' active' : ''}`}
                          aria-pressed={activeEffort === level}
                          disabled={disabled}
                          title={
                            disabled
                              ? `${EFFORT_LABELS[level]} — ${EFFORT_TITLE} · 当前模型未声明支持该档位`
                              : `${EFFORT_LABELS[level]} — ${EFFORT_TITLE}`
                          }
                          onClick={() => chooseEffort(level)}
                        >
                          {EFFORT_LABELS[level]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="composer-tools-right">
                {streaming ? (
                  <button className="stop" onClick={stop}>
                    <Square size={12} />
                    <span>停止</span>
                  </button>
                ) : (
                  <button className="send" onClick={send} disabled={!canSend}>
                    <Send size={13} />
                    <span>发送</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="hint">
            <span>Enter 发送 · Shift+Enter 换行 · `@` 选择技能 · `/model` 就地切换模型</span>
            <span>会话: {activeChat}</span>
          </div>
        </div>
      </main>

      {promptDrawerOpen ? (
        <div className="drawer-overlay" onClick={() => setPromptDrawerOpen(false)}>
          <div
            className="prompt-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="人设与提示词配置"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <div className="drawer-title">
                <Sliders size={17} />
                <span>Agent 人设与系统提示词</span>
              </div>
              <button
                className="help-close"
                onClick={() => setPromptDrawerOpen(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div className="preset-banner">
              <div className="preset-banner-text">
                <div className="preset-banner-title">
                  🌟 GitHub 精选：费曼第一性原理与概念拆解导师
                </div>
                <div className="preset-banner-desc">
                  融合 Feynman 心智模型 + Fabric 结构化拆解 + OpenClaw 零废话规范，专为深层问答与表格对比打造
                </div>
              </div>
              <button className="preset-apply-btn" onClick={applyFeynmanPreset}>
                一键套用并保存
              </button>
            </div>

            <div className="prompt-tabs">
              {PROMPT_FILE_TABS.map((fname) => (
                <button
                  key={fname}
                  className={`prompt-tab${activePromptTab === fname ? ' active' : ''}`}
                  onClick={() => setActivePromptTab(fname)}
                >
                  {fname}
                </button>
              ))}
            </div>

            <textarea
              className="prompt-editor"
              value={promptFiles[activePromptTab] ?? ''}
              placeholder={`在此编辑容器工作区下的 ${activePromptTab} 内容…`}
              onChange={(e) =>
                setPromptFiles((prev) => ({ ...prev, [activePromptTab]: e.target.value }))
              }
            />

            <div className="drawer-foot">
              <span className="drawer-status">{promptStatus}</span>
              <button className="drawer-save-btn" onClick={saveCurrentPrompt}>
                保存 {activePromptTab} 到容器
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {helpOpen ? (
        <div className="help-overlay" onClick={() => setHelpOpen(false)}>
          <div
            className="help-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="帮助"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="help-head">
              <span>快捷键与技能指南</span>
              <button className="help-close" onClick={() => setHelpOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <h4>斜杠命令 (`/`)</h4>
            <ul className="help-list">
              {COMMANDS.map((command) => (
                <li key={command.id}>
                  <code>/{command.id}</code>
                  <span>{command.label}</span>
                  <em>{command.hint}</em>
                </li>
              ))}
            </ul>
            <h4>技能调用 (`@`)</h4>
            <p className="help-keys">
              • 在输入框敲 <strong><code>@</code></strong>（或点击左下角「技能」按钮）即可呼出技能列表（包含容器内已启用的技能与内置工作流技能）。<br />
              • 敲 <strong><code>/model</code></strong> 回车即可直接在输入框正上方用键盘方向键切换模型。<br />
              • 会话标题下方的用量行：<strong>↑输入 / ↓输出</strong> 为本会话累计值；<strong>上下文 ≈</strong> 为最近一轮输入近似（多轮工具调用时可能略低），百分比只在已知模型上下文上限时显示。
            </p>
            <p className="help-build">{formatBuildLabel()}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
