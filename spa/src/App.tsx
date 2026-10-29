import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  BarChart3,
  BookmarkPlus,
  Check,
  ChevronUp,
  Cloud,
  Code2,
  Command,
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
  MoreHorizontal,
  Paperclip,
  Pin,
  PinOff,
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
  Tag,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { RelayClient } from './relay';
import type { ConnState, ContentPart, Frame } from './relay';
import { LOGIN_REQUIRED, RELAY_HTTP_URL, RELAY_WS_URL } from './config';
import {
  ACTIVE_KEY,
  CHATS_KEY,
  PINS_KEY,
  TAGS_KEY,
  allChatTags,
  chatMatchesTag,
  newestServerChat,
  newChatId,
  parseTagInput,
  persistedChatTags,
  persistedChats,
  pruneChatTags,
  prunePins,
  restoreSession,
  setChatTags,
  togglePin as togglePinIn,
} from './lib/chatState';
import type { ChatTags } from './lib/chatState';
import { draftOf, loadDrafts, saveDrafts, setDraft } from './lib/drafts';
import type { Drafts } from './lib/drafts';
import { EXPORT_ERROR_TEXT, base64Of, exportFileName, hexOf, verifyExport } from './lib/export';
import { bulkSummaryText, planBulk, runBulkExport } from './lib/bulkExport';
import type { BulkRunResult, BulkTarget } from './lib/bulkExport';
import {
  addPrompt,
  loadPrompts,
  promptNameOf,
  removePrompt,
  renamePrompt,
  savePrompts,
} from './lib/promptLibrary';
import type { SavedPrompt } from './lib/promptLibrary';
import { searchHitsOf, snippetParts } from './lib/search';
import type { SearchHit } from './lib/search';
import { findMessageAnchor } from './lib/jump';
import {
  movePaletteCursor,
  paletteEntries,
} from './lib/palette';
import type { PaletteEntry } from './lib/palette';
import { formatExact, formatTokens, turnTitle, turnUsageOf, usageOf } from './lib/usage';
import type { ChatUsage, TurnUsage } from './lib/usage';
import { statsBars, statsOf } from './lib/stats';
import type { StatsBar, UsageStats } from './lib/stats';
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
/** M25 — how long 导出全部 waits for the server chat list before giving up. */
const CHATS_WAIT_MS = 6_000;

/** M13 — wait this long after the last keystroke before asking the plugin. */
const SEARCH_DEBOUNCE_MS = 300;
/** M13 — give up when the archive does not answer (plugin + Turso timeout). */
const SEARCH_TIMEOUT_MS = 15_000;

/** Client token for the hosted relay, kept across tabs and restarts (M11). */
const TOKEN_KEY = 'webchannel.token';
/** Expiry of TOKEN_KEY (Unix seconds, as answered by `POST /api/login`). */
const TOKEN_EXPIRES_KEY = 'webchannel.tokenExpires';

/** User-given chat titles, keyed by chat id (M7). */
const NAMES_KEY = 'webchannel.chatNames';
/** Per-chat thinking level, keyed by chat id (M9). */
const EFFORT_KEY = 'webchannel.effort';
/** A chat gets its server record on the first message; retry the pending
 *  level once that message has had time to be processed (M9). */
const EFFORT_REAPPLY_MS = 1200;
/** 'light' | 'dark' (M7). */
const THEME_KEY = 'webchannel.theme';
/** The PWA status bar follows the active theme (M22). */
const THEME_COLORS: Record<Theme, string> = { light: '#faf8f4', dark: '#0a0b0e' };
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

/** M24: how long a `get_stats` reply may take before the view says so. */
const STATS_TIMEOUT_MS = 15000;

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

/** Keep the browser/PWA chrome in step with the CSS variables (M22). */
function applyThemeColor(theme: Theme): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
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
  /** Per-turn token receipt from `hist` / `usage.last_turn` (M15). */
  turn?: TurnUsage;
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
  { id: 'library', label: '提示词库', hint: '保存当前输入或插入已保存的常用提示词' },
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

/** The terminal result of one export request (M25: batches await these). */
type ExportOutcome = { ok: true; filename: string } | { ok: false; reason: string };

/** One in-flight `export` request; chunks are keyed by their 0-based index. */
interface ExportJob {
  id: string;
  chat: string;
  title: string;
  bytes: number;
  chunks: number;
  sha256: string;
  parts: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolved exactly once — frames and the timeout race, so guard it. */
  settled: boolean;
  /** `export_end` arrived; verification is in flight (ignore duplicates). */
  finishing: boolean;
  settle: (outcome: ExportOutcome) => void;
}

/** One in-flight `search` request; a newer query supersedes it. */
interface SearchJob {
  id: string;
  timer: ReturnType<typeof setTimeout> | null;
}

type SearchState = 'idle' | 'loading' | 'done' | 'unavailable';

/**
 * The status line under the header. `danger` is the historical look; `info`
 * (progress) and `ok` (success) exist so an export's progress/success notice
 * never masquerades as an error (M17).
 */
type ToastTone = 'info' | 'ok' | 'danger';

interface ToastNotice {
  text: string;
  tone: ToastTone;
}

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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function fmtKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

const USAGE_TITLE =
  '本会话累计 ↑↓ 取自 QwenPaw 每轮 usage 元数据；上下文占用 ≈ 最近一轮最后一次模型调用的输入，工具调用轮次不再累加，仍可能与实时值略有偏差';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  turn?: TurnUsage;
}

function historyMessages(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { role?: unknown; text?: unknown; turn?: unknown };
    const role: Role | null =
      record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null;
    if (!role) continue;
    const message: HistoryMessage = {
      role,
      text: typeof record.text === 'string' ? record.text : '',
    };
    const turn = turnUsageOf(record.turn);
    if (turn) message.turn = turn;
    out.push(message);
  }
  return out;
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

  // Layout effect, not a passive one: `html` replaces every child of the
  // container on each streaming frame, and the copy button must exist in the
  // same paint (M19 — no frame may render a code block without its button).
  useLayoutEffect(() => {
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
        button.textContent = '复制';
        button.title = '复制代码';
        button.setAttribute('aria-label', '复制代码');
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
        preBtn.textContent = '已复制';
        preBtn.classList.add('copied');
        window.setTimeout(() => {
          // A streaming re-render may have replaced the node meanwhile.
          preBtn.textContent = '复制';
          preBtn.classList.remove('copied');
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
  flash = false,
  onApproval,
  onRegenerate,
  onEditResend,
}: {
  message: ChatMessage;
  chat: string;
  flash?: boolean;
  onApproval: (chat: string, message: ChatMessage, action: 'approve' | 'deny') => void;
  onRegenerate?: (message: ChatMessage) => void;
  onEditResend?: (message: ChatMessage) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowClass = (role: Role) =>
    `row ${role}${flash ? ' jump-flash' : ''}`;

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  if (message.kind === 'approval') {
    return (
      <div className={rowClass('assistant')} data-mid={message.id}>
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
          {isAssistant && message.turn ? (
            <span className="bubble-usage" title={turnTitle(message.turn)}>
              {message.turn.estimated ? '≈' : ''}本轮
              {message.turn.input != null ? ` ↑${formatTokens(message.turn.input)}` : ''}
              {message.turn.output != null ? ` ↓${formatTokens(message.turn.output)}` : ''}
            </span>
          ) : null}
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
      <div className={rowClass('assistant')} data-mid={message.id}>
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

  return (
    <div className={rowClass('user')} data-mid={message.id}>
      {bubble}
    </div>
  );
}

/**
 * Context meter above the composer (M15). A thin bar plus `上下文 ≈N%` on
 * mobile; the exact tokens and the session totals join it on desktop and in
 * the tap-opened panel. Degrades to text-only rows when a part is missing and
 * renders nothing when only `context_limit` is known.
 */
function ContextMeter({
  usage,
  turns,
  open,
  onToggle,
}: {
  usage: ChatUsage | undefined;
  turns: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (!usage) return null;

  const { contextTokens, contextLimit, inputTotal, outputTotal } = usage;
  const hasTotals = inputTotal != null || outputTotal != null;
  const totals = hasTotals ? (
    <span className="context-meter-totals">
      {inputTotal != null ? `↑${formatTokens(inputTotal)}` : ''}
      {inputTotal != null && outputTotal != null ? ' ' : ''}
      {outputTotal != null ? `↓${formatTokens(outputTotal)}` : ''}
    </span>
  ) : null;

  if (contextTokens == null) {
    // No context size: the session totals alone are still worth a line.
    return hasTotals ? (
      <div className="context-meter context-meter-plain" title={USAGE_TITLE}>
        {totals}
      </div>
    ) : null;
  }

  if (contextLimit == null) {
    // A size without a window: text only, no bar and no percentage.
    return (
      <div className="context-meter context-meter-plain" title={USAGE_TITLE}>
        <span className="context-meter-label">
          上下文 ≈{formatTokens(contextTokens)}
        </span>
        {totals}
      </div>
    );
  }

  const percent = Math.round((contextTokens / contextLimit) * 100);
  const tone = percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : 'ok';
  const totalHint = hasTotals
    ? `；本会话累计输入 ${inputTotal != null ? formatTokens(inputTotal) : '未知'}，输出 ${
        outputTotal != null ? formatTokens(outputTotal) : '未知'
      }`
    : '';
  return (
    <>
      <button
        type="button"
        className={`context-meter context-meter-interactive tone-${tone}`}
        aria-expanded={open}
        aria-label={`上下文占用约 ${percent}%，${formatTokens(contextTokens)} / ${formatTokens(
          contextLimit,
        )} tokens${totalHint}`}
        title={USAGE_TITLE}
        onClick={onToggle}
      >
        <span className="context-meter-track">
          <span
            className="context-meter-fill"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </span>
        <span className="context-meter-label">上下文 ≈{percent}%</span>
        <span className="context-meter-detail">
          {formatTokens(contextTokens)} / {formatTokens(contextLimit)}
        </span>
        {totals}
      </button>
      {open ? (
        <div className="context-meter-panel">
          <div>
            上下文 ≈{formatExact(contextTokens)} / {formatExact(contextLimit)} tokens（最近一轮结束后刷新）
          </div>
          {hasTotals ? (
            <div>
              本会话累计
              {inputTotal != null ? ` ↑${formatExact(inputTotal)}` : ''}
              {outputTotal != null ? ` ↓${formatExact(outputTotal)}` : ''}
            </div>
          ) : null}
          {turns > 0 ? (
            <div className="context-meter-turns">
              轮次 {turns}（已加载历史中的用量回执）
            </div>
          ) : null}
          <div className="context-meter-note">{USAGE_TITLE}</div>
        </div>
      ) : null}
    </>
  );
}

/** M24: pure-CSS per-day bar chart (no chart dependency). */
function StatsChart({ bars }: { bars: StatsBar[] }) {
  const max = bars.reduce((top, bar) => Math.max(top, bar.total), 0);
  return (
    <section className="stats-chart-wrap" aria-label="按天用量">
      <div className="stats-section-head">
        <span>按天用量</span>
        <span>{max > 0 ? `峰值 ${formatTokens(max)} tokens` : '暂无 token 记录'}</span>
      </div>
      {bars.length === 0 ? (
        <div className="stats-empty-line">还没有可用的按天数据</div>
      ) : (
        <div className="stats-chart">
          {bars.map((bar) => {
            const input = bar.input != null ? `输入 ${formatExact(bar.input)}` : '输入未记录';
            const output = bar.output != null ? `输出 ${formatExact(bar.output)}` : '输出未记录';
            return (
              <div
                className="stats-bar-col"
                key={bar.date}
                title={`${bar.date} · ${bar.turns} 轮 · ${input} · ${output}`}
              >
                <span className="stats-bar-value">
                  {bar.total > 0 ? formatTokens(bar.total) : '—'}
                </span>
                <span className="stats-bar-track">
                  <span
                    className="stats-bar-fill"
                    style={{
                      height: bar.ratio > 0 ? `${Math.max(3, bar.ratio * 100)}%` : '0%',
                    }}
                  />
                </span>
                <span className="stats-bar-label">{bar.label}</span>
                <span className="stats-bar-turns">{bar.turns} 轮</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** M24: the 用量统计 view, reachable from the sidebar. */
function StatsView({
  stats,
  loading,
  error,
  onClose,
  onRefresh,
  onOpenChat,
}: {
  stats: UsageStats | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onOpenChat: (chat: string) => void;
}) {
  const bars = stats ? statsBars(stats.days) : [];
  const hasData = stats != null && (stats.totals.turns > 0 || stats.coveredChats > 0);
  const input = stats?.totals.input;
  const output = stats?.totals.output;
  const covered = stats?.coveredChats ?? 0;
  const uncovered = stats?.uncoveredChats;
  const undated = stats?.undatedTurns ?? 0;

  return (
    <section
      className="stats-view"
      role="dialog"
      aria-modal="true"
      aria-label="用量统计"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="stats-head">
        <div className="stats-title">
          <BarChart3 size={17} />
          <span>用量统计</span>
          {stats?.dayTz ? <span className="stats-tz">{stats.dayTz} 本地日</span> : null}
        </div>
        <div className="stats-head-actions">
          <button
            className="stats-icon-btn"
            type="button"
            onClick={onRefresh}
            aria-label="刷新用量统计"
            title={loading ? '正在刷新…' : '刷新用量统计'}
            disabled={loading}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="stats-icon-btn"
            type="button"
            onClick={onClose}
            aria-label="关闭用量统计"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="stats-body">
        {error ? <div className="stats-error">{error}</div> : null}
        {loading && !stats ? (
          <div className="stats-loading">正在汇总全部会话的用量…</div>
        ) : null}

        {stats != null && !hasData ? (
          <div className="stats-empty">
            <BarChart3 size={26} />
            <strong>还没有可统计的用量</strong>
            <span>发一条消息，助手回复落盘后这里就会出现数据。</span>
          </div>
        ) : null}

        {hasData ? (
          <>
            <div className="stats-cards">
              <div className="stats-card">
                <span className="stats-card-label">总轮次</span>
                <strong className="stats-card-value">{formatExact(stats.totals.turns)}</strong>
                <span className="stats-card-sub">有用量回执的助手轮次</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">输入 tokens</span>
                <strong className="stats-card-value">
                  {input != null ? formatTokens(input) : '—'}
                </strong>
                <span className="stats-card-sub" title={input != null ? formatExact(input) : ''}>
                  {input != null ? `${formatExact(input)} 累计` : '未记录'}
                </span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">输出 tokens</span>
                <strong className="stats-card-value">
                  {output != null ? formatTokens(output) : '—'}
                </strong>
                <span className="stats-card-sub" title={output != null ? formatExact(output) : ''}>
                  {output != null ? `${formatExact(output)} 累计` : '未记录'}
                </span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">覆盖会话</span>
                <strong className="stats-card-value">{formatExact(covered)}</strong>
                <span className="stats-card-sub">
                  {uncovered != null ? `另有 ${uncovered} 个无数据` : '未覆盖数未知'}
                </span>
              </div>
            </div>

            <StatsChart bars={bars} />

            <section className="stats-top" aria-label="会话用量排行">
              <div className="stats-section-head">
                <span>会话用量排行</span>
                <span>
                  共 {covered} 个会话有数据
                  {stats.chats.length < covered ? `，显示前 ${stats.chats.length}` : ''}
                </span>
              </div>
              {stats.chats.length === 0 ? (
                <div className="stats-empty-line">暂无可排序的会话</div>
              ) : (
                <div className="stats-chat-list">
                  {stats.chats.map((item, index) => (
                    <button
                      key={item.chat}
                      type="button"
                      className="stats-chat-row"
                      onClick={() => onOpenChat(item.chat)}
                      title={`打开会话 ${item.title ?? item.chat}`}
                    >
                      <span className="stats-chat-rank">{index + 1}</span>
                      <span className="stats-chat-main">
                        <span className="stats-chat-title">{item.title ?? item.chat}</span>
                        <span className="stats-chat-id">{item.chat}</span>
                      </span>
                      <span className="stats-chat-turns">{item.turns} 轮</span>
                      <span className="stats-chat-tokens">
                        {item.input != null ? `↑${formatTokens(item.input)}` : ''}
                        {item.input != null && item.output != null ? ' ' : ''}
                        {item.output != null ? `↓${formatTokens(item.output)}` : ''}
                      </span>
                      <ChevronUp size={13} className="stats-chat-go" />
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

        <div className="stats-basis">
          <div className="stats-basis-title">数据来源与覆盖范围</div>
          <p>
            来源：容器内 QwenPaw 会话历史（<code>sessions/web/*.json</code>）中每轮记录的
            token 用量；按<strong>容器本地时区</strong>
            {stats?.dayTz ? `（${stats.dayTz}）` : ''}的日历日分桶。
          </p>
          <p>
            覆盖：
            {stats == null
              ? '等待插件返回统计。'
              : (
                <>
                  {covered} 个会话有可用数据
                  {uncovered != null
                    ? `，另有 ${uncovered} 个已知会话没有可统计的用量`
                    : '；会话列表不可用，无法判断未覆盖数量'}
                  。
                </>
              )}
            {undated > 0 ? ` 其中 ${undated} 轮没有时间戳，只计入合计、不在按天图中。` : ''}
          </p>
          <p>
            仅统计已持久化的轮次：后端压缩掉的早期轮次、从未落盘的回复，以及没有会话文件的会话都不在数字里。
            {stats && stats.chats.length < covered ? ' 排行只显示用量最高的前 10 个会话。' : ''}
          </p>
        </div>
      </div>
    </section>
  );
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
  const [drafts, setDrafts] = useState<Drafts>(loadDrafts);
  const [input, setInput] = useState<string>(() => draftOf(drafts, session.active));
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastNotice | null>(null);
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
  // M14: the narrow-screen overflow menu in the top bar (secondary actions).
  const [moreOpen, setMoreOpen] = useState(false);

  // Skills & Inline Palette Mode ('cmd' | 'model' | 'skill')
  const [skills, setSkills] = useState<SkillItem[]>(DEFAULT_SKILLS);
  const [activeSkill, setActiveSkill] = useState<SkillItem | null>(null);
  const [inlineSubMode, setInlineSubMode] = useState<'model' | 'skill' | null>(null);

  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteMuted, setPaletteMuted] = useState<string | null>(null);
  const [chatNames, setChatNames] = useState<Record<string, string>>(persistedNames);
  // M19: pinned chats, most recently pinned first (the 置顶 group's order).
  const [pins, setPins] = useState<string[]>(() => persistedChats(PINS_KEY));
  // M23: free-text tags per chat, plus the sidebar's active filter.
  const [chatTags, setChatTagsState] = useState<ChatTags>(persistedChatTags);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [taggingId, setTaggingId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  // M23: Ctrl/⌘+K command palette (separate from the slash palette above).
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandCursor, setCommandCursor] = useState(0);
  // M23: search-hit jump target (consumed once the chat's history is loaded).
  const [jumpTarget, setJumpTarget] = useState<{
    chat: string;
    hit: SearchHit;
    archivedOnly: boolean;
  } | null>(null);
  const [flashMessageId, setFlashMessageId] = useState<number | null>(null);
  // Bumped on every `hist` frame so the jump effect re-runs after a late load.
  const [histTick, setHistTick] = useState(0);
  // M15: the usage panel is controlled so the command palette can open it.
  const [usageOpen, setUsageOpen] = useState(false);
  // M24: the all-chats usage dashboard (sidebar entry, control frame).
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
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
  // M22: named prompts, plus the composer panel that saves/inserts them.
  const [prompts, setPrompts] = useState<SavedPrompt[]>(loadPrompts);
  const [promptLibOpen, setPromptLibOpen] = useState(false);
  const [promptName, setPromptName] = useState('');
  const [promptLibStatus, setPromptLibStatus] = useState('');
  const [renamingPromptId, setRenamingPromptId] = useState<string | null>(null);
  const [promptRenameDraft, setPromptRenameDraft] = useState('');
  const [nearBottom, setNearBottom] = useState(true);
  const [draggingFile, setDraggingFile] = useState(false);
  // M12: one export at a time; the button shows "导出中…" while it runs.
  const [exporting, setExporting] = useState(false);
  // M25: the last server chat list (导出全部 targets) and its batch state.
  const [serverChats, setServerChats] = useState<BulkTarget[]>([]);
  const [bulkActive, setBulkActive] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    total: number;
    index: number;
    title: string;
    skipped: number;
  } | null>(null);

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
  // M22: write-through mirror of `drafts` so a chat switch in the same event
  // (type → click another chat) always reads the newest text.
  const draftsRef = useRef<Drafts>(drafts);
  const runtimes = useRef<Map<string, ChatRuntime>>(new Map());
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const answeredApprovals = useRef<Set<string>>(new Set());
  const uploadRef = useRef<Upload | null>(null);
  // M12: the export being collected (chunks arrive as control frames).
  const exportRef = useRef<ExportJob | null>(null);
  // M25: server list cache + cooperative cancel for 导出全部. The waiter is
  // installed by the click handler, so it always closes over fresh state.
  const serverChatsRef = useRef<BulkTarget[]>([]);
  const bulkRunningRef = useRef(false);
  const bulkCancelRef = useRef(false);
  const chatsWaiterRef = useRef<((targets: BulkTarget[]) => void) | null>(null);
  const chatsWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M13: the archive search in flight (debounce is local to its effect).
  const searchRef = useRef<SearchJob | null>(null);
  const modelsRequested = useRef(false);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const promptLibRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  /** M19: a smooth jump to the bottom is settling; ignore its scroll events. */
  const jumpRef = useRef(false);
  const lastChatRef = useRef<string>(session.active);
  // M19: the chat restored from localStorage is validated once, against the
  // first server chat list; a chat the user already touched is never yanked.
  const restoredChatRef = useRef<string | null>(session.restored ? session.active : null);
  const touchedChatsRef = useRef<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // M23: command palette input + the jump highlight's timeout.
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const commandOpenRef = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M9: onFrame runs outside React's render closure, so the effort state it
  // reads (and rolls back) lives in refs mirrored from the React state.
  const effortLevelsRef = useRef<Record<string, EffortLevel>>(effortLevels);
  const effortMetaRef = useRef<Record<string, EffortMeta>>({});
  const effortRollbackRef = useRef<Record<string, EffortLevel>>({});
  const effortRetryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // M11: debounced usage refresh per chat (set after a reply finishes).
  const usageTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // M24: the newest stats request; a late/duplicate reply must not overwrite
  // a newer one, and the timeout only clears its own request.
  const statsReqRef = useRef<{
    id: string;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const statsReqSeq = useRef(0);
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

  // ---- M22: per-chat composer drafts ----
  /** Update one chat's draft in state and in the write-through ref. */
  const rememberDraft = (chat: string, text: string) => {
    const next = setDraft(draftsRef.current, chat, text);
    if (next === draftsRef.current) return;
    draftsRef.current = next;
    setDrafts(next);
  };

  /** Composer edits always belong to the visible chat. */
  const setComposer = (text: string) => {
    setInput(text);
    rememberDraft(activeRef.current, text);
  };

  // ---- M9: thinking effort (per chat, server is authoritative) ----
  const showToastBriefly = (message: string, tone: ToastTone = 'danger') => {
    setToast({ text: message, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      // Only dismiss our own notice, never a newer one.
      setToast((current) => (current?.text === message ? null : current));
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
   * M24: ask the plugin for the all-chats dashboard. `stats` is a control
   * frame (no seq, never replayed), so every open/refresh is an explicit
   * request. Only the newest request may settle the view; a send that fails
   * because the socket is down reports it instead of hanging on the spinner.
   */
  const requestStats = () => {
    const previous = statsReqRef.current;
    if (previous?.timer != null) clearTimeout(previous.timer);
    const id = `stats-${statsReqSeq.current + 1}`;
    statsReqSeq.current += 1;
    const pending = { id, timer: null as ReturnType<typeof setTimeout> | null };
    statsReqRef.current = pending;
    setStatsError(null);
    setStatsLoading(true);
    if (!clientRef.current?.send({ t: 'get_stats', id })) {
      statsReqRef.current = null;
      setStatsLoading(false);
      setStatsError('未连接 — 正在重连，请稍后重试。');
      return;
    }
    pending.timer = setTimeout(() => {
      if (statsReqRef.current !== pending) return;
      statsReqRef.current = null;
      setStatsLoading(false);
      setStatsError('统计请求超时，请稍后重试。');
    }, STATS_TIMEOUT_MS);
  };

  /**
   * M15: a `usage` frame's `last_turn` belongs to the reply that just
   * finished. Attach it to the newest assistant text bubble only when it has
   * no receipt yet: the same id is already correct, and a different id
   * belongs to an older/newer turn and must not overwrite anything. A bubble
   * that is still streaming is a *new* turn, never the receipt's owner.
   */
  const attachLastTurn = (chat: string, turn: TurnUsage) => {
    updateChat(chat, (prev) => {
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        const message = prev[i];
        if (message.role !== 'assistant' || message.kind !== 'text') continue;
        if (message.streaming || message.turn) return prev;
        const out = [...prev];
        out[i] = { ...message, turn };
        return out;
      }
      return prev;
    });
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
  /**
   * Finish one export request exactly once. Frames, the timeout and a bulk
   * cancel all race for this; the first result wins and clears the slot.
   */
  const settleExport = (job: ExportJob, outcome: ExportOutcome) => {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    if (exportRef.current === job) {
      exportRef.current = null;
      setExporting(false);
    }
    job.settle(outcome);
  };

  const failExport = (job: ExportJob, message: string) => {
    settleExport(job, { ok: false, reason: message });
  };

  /** Verify the collected chunks against `export_begin`, then save the Blob. */
  const finishExport = async (job: ExportJob) => {
    const result = await verifyExport(
      job.parts,
      job.chunks,
      job.bytes,
      job.sha256,
      (buffer) => crypto.subtle.digest('SHA-256', buffer).then(hexOf),
    );
    if (!result.ok) {
      failExport(job, EXPORT_ERROR_TEXT[result.reason]);
      return;
    }
    // A cancel during verification drops the file instead of downloading it.
    if (job.settled) return;
    const filename = exportFileName(job.title, new Date());
    saveBlob(new Blob([result.buffer], { type: 'text/markdown;charset=utf-8' }), filename);
    settleExport(job, { ok: true, filename });
  };

  /**
   * Ask the plugin for one chat's Markdown. The caller decides how to report
   * the outcome — a single export toasts it, a batch counts it (M25).
   */
  const requestExport = (chat: string, title: string): Promise<ExportOutcome> => {
    const client = clientRef.current;
    if (exportRef.current || !client) {
      return Promise.resolve({ ok: false, reason: '未连接 — 无法导出' });
    }
    const nonce = Math.random().toString(36).slice(2, 6);
    return new Promise<ExportOutcome>((resolve) => {
      const job: ExportJob = {
        id: `export-${Date.now().toString(36)}-${exportCounter++}-${nonce}`,
        chat,
        title,
        bytes: 0,
        chunks: 0,
        sha256: '',
        parts: new Map(),
        timer: null,
        settled: false,
        finishing: false,
        settle: resolve,
      };
      exportRef.current = job;
      setExporting(true);
      job.timer = setTimeout(
        () => failExport(job, '导出超时：插件未返回完整文档'),
        EXPORT_TIMEOUT_MS,
      );
      let sent = false;
      try {
        sent = client.send({ t: 'export', chat, id: job.id });
      } catch {
        sent = false;
      }
      if (!sent) {
        failExport(job, '未连接 — 无法导出');
      }
    });
  };

  // ---- M25: bulk export over the server chat list ----
  const runBulk = async (targets: BulkTarget[]) => {
    if (bulkRunningRef.current) return;
    bulkRunningRef.current = true;
    bulkCancelRef.current = false;
    setBulkActive(true);
    setBulkProgress(null);
    const { planned, skipped } = planBulk(targets);
    let result: BulkRunResult | null = null;
    try {
      result = await runBulkExport(
        targets,
        (target) => requestExport(target.chat, target.title),
        {
          shouldCancel: () => bulkCancelRef.current,
          onProgress: (progress) =>
            setBulkProgress({ ...progress, skipped }),
        },
      );
    } catch (error) {
      console.error('[bulk-export] 批量导出中断', error);
      showToastBriefly('批量导出中断：内部错误');
    } finally {
      bulkRunningRef.current = false;
      bulkCancelRef.current = false;
      setBulkActive(false);
      setBulkProgress(null);
    }
    if (!result) return;
    // Failed titles are never silently dropped: every one is logged with its
    // reason, and the summary names as many as fit in a toast.
    for (const failure of result.failed) {
      console.warn(
        `[bulk-export] 失败 ${failure.title}（${failure.chat}）— ${failure.reason}`,
      );
    }
    if (result.skipped > 0) {
      console.warn(
        `[bulk-export] 仅导出前 ${planned.length} 个会话（共 ${result.total} 个），其余 ${result.skipped} 个未导出`,
      );
    }
    if (result.cancelled) {
      console.info(
        `[bulk-export] 已取消：成功 ${result.succeeded}，失败 ${result.failed.length}，未处理 ${result.planned - result.attempted} 个`,
      );
    }
    const tone: ToastTone =
      result.failed.length > 0 ? 'danger' : result.cancelled ? 'info' : 'ok';
    showToastBriefly(bulkSummaryText(result), tone);
  };

  /** Start 导出全部; without a server list yet, ask once and wait for it. */
  const startBulkExport = () => {
    if (bulkRunningRef.current || bulkPending) return;
    if (exportRef.current) {
      showToastBriefly('正在导出当前会话 — 请稍后再导出全部', 'info');
      return;
    }
    const targets = serverChatsRef.current;
    if (targets.length > 0) {
      void runBulk(targets);
      return;
    }
    const client = clientRef.current;
    if (!client) {
      showToastBriefly('未连接 — 无法导出');
      return;
    }
    setBulkPending(true);
    showToastBriefly('正在获取服务器会话列表…', 'info');
    chatsWaiterRef.current = (incoming) => {
      chatsWaiterRef.current = null;
      if (chatsWaitTimerRef.current) {
        clearTimeout(chatsWaitTimerRef.current);
        chatsWaitTimerRef.current = null;
      }
      setBulkPending(false);
      if (incoming.length === 0) {
        showToastBriefly('服务器没有可导出的会话', 'info');
        return;
      }
      void runBulk(incoming);
    };
    chatsWaitTimerRef.current = setTimeout(() => {
      chatsWaiterRef.current = null;
      chatsWaitTimerRef.current = null;
      setBulkPending(false);
      showToastBriefly('获取会话列表超时，请重试', 'info');
    }, CHATS_WAIT_MS);
    if (!client.send({ t: 'chats' })) {
      chatsWaiterRef.current = null;
      if (chatsWaitTimerRef.current) {
        clearTimeout(chatsWaitTimerRef.current);
        chatsWaitTimerRef.current = null;
      }
      setBulkPending(false);
      showToastBriefly('未连接 — 无法导出');
    }
  };

  /** Cancel the batch: drop the in-flight file and stop before the next. */
  const cancelBulkExport = () => {
    if (!bulkRunningRef.current) return;
    bulkCancelRef.current = true;
    const job = exportRef.current;
    if (job) failExport(job, '已取消');
    showToastBriefly('正在取消批量导出…', 'info');
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
      // Overlapping frames re-describe messages already on screen (the live
      // path has no receipt). Keep what is shown, but take a receipt that the
      // incoming history now carries; M15 anchors it to one text segment.
      for (let i = 0; i < start; i += 1) {
        const turn = incoming[i]?.turn;
        if (!turn) continue;
        const index = prev.length - start + i;
        const shown = out[index];
        if (!shown || shown.role !== 'assistant') continue;
        if (shown.turn && shown.turn.id === turn.id) continue;
        out[index] = { ...shown, turn };
      }
      for (let i = start; i < incoming.length; i += 1) {
        const item = incoming[i];
        const message: ChatMessage = {
          id: nextId++,
          role: item.role,
          kind: 'text',
          text: item.text,
        };
        if (item.turn) message.turn = item.turn;
        out.push(message);
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
    commandOpenRef.current = commandOpen;
  }, [commandOpen]);

  useEffect(() => {
    storageSet(PINS_KEY, JSON.stringify(pins));
  }, [pins]);

  useEffect(() => {
    storageSet(TAGS_KEY, JSON.stringify(chatTags));
  }, [chatTags]);

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
      // M25: stop a batch between chats and drop a pending list request.
      bulkCancelRef.current = true;
      chatsWaiterRef.current = null;
      if (chatsWaitTimerRef.current) clearTimeout(chatsWaitTimerRef.current);
      const searchJob = searchRef.current;
      if (searchJob?.timer) clearTimeout(searchJob.timer);
      searchRef.current = null;
      if (flashTimer.current) clearTimeout(flashTimer.current);
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
    applyThemeColor(theme);
  }, [theme]);

  useEffect(() => {
    saveDrafts(drafts);
  }, [drafts]);

  useEffect(() => {
    savePrompts(prompts);
  }, [prompts]);

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
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      const wrap = moreWrapRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        setMoreOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!promptLibOpen) return;
    const onDown = (event: MouseEvent) => {
      const wrap = promptLibRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        setPromptLibOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPromptLibOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [promptLibOpen]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  useEffect(() => {
    if (!statsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setStatsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [statsOpen]);

  // M19: global shortcuts. Neither key is claimed by the existing handlers
  // (panel Escape, composer Enter/Arrow) — the only conflict is the browser's
  // own Ctrl/⌘+K (address bar) and Ctrl/⌘+Shift+O (bookmarks), which the
  // preventDefault below suppresses wherever the page is allowed to see it.
  // Empty deps are safe: every callback below only touches setters and refs.
  //
  // M23: Ctrl/⌘+K now opens the command palette. Focusing the archive search
  // became one action inside it (全文搜索), not a separate binding.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        if (!commandOpenRef.current) {
          setCommandQuery('');
          setCommandCursor(0);
        }
        setCommandOpen(true);
        return;
      }
      if (key === 'o' && event.shiftKey) {
        event.preventDefault();
        newChat();
        textareaRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters + refs only
  }, []);

  // M23: the palette owns the keyboard while it is open.
  useEffect(() => {
    if (!commandOpen) return;
    const timer = setTimeout(() => {
      commandInputRef.current?.focus();
      commandInputRef.current?.select();
    }, 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCommandOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
    };
  }, [commandOpen]);

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
          // M23: a search-hit jump may be waiting for exactly this history.
          setHistTick((tick) => tick + 1);
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
          // The job stays in the slot while it is verified: a duplicated end
          // frame is ignored, and a batch cancel can still settle it (which
          // drops the file instead of downloading it).
          if (job.finishing) break;
          job.finishing = true;
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
          const lastTurn = turnUsageOf(frame.last_turn);
          if (lastTurn) attachLastTurn(chat, lastTurn);
          break;
        }

        case 'stats': {
          // Control frame: never replayed, so only the reply that answers the
          // newest request may settle the view (a late one is stale).
          const pending = statsReqRef.current;
          const id = asString(frame.id);
          if (pending && id && id !== pending.id) break;
          if (pending?.timer != null) clearTimeout(pending.timer);
          statsReqRef.current = null;
          setStats(statsOf(frame));
          setStatsLoading(false);
          setStatsError(null);
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
              // M25: 导出全部 iterates exactly this list, in server order.
              // An empty reply is not trusted (the plugin answers [] when its
              // own chat API fails), so the previous list survives it.
              const serverTargets = incomingIds.map((cid) => ({
                chat: cid,
                title: incomingTitles[cid] || cid,
              }));
              serverChatsRef.current = serverTargets;
              setServerChats(serverTargets);
              // M19: pins for chats the server no longer lists are dropped
              // silently. An empty list is not trusted — the plugin also
              // answers [] when its own chat API fails.
              setPins((prev) => prunePins(prev, incomingIds));
              // M23: tags follow the same rule as pins.
              setChatTagsState((prev) => pruneChatTags(prev, incomingIds));
            }

            // M25: a click on 导出全部 before the first `chats` reply arrives
            // waits here; this frame starts the batch (even when empty, so the
            // waiter can report it instead of hanging).
            const waiter = chatsWaiterRef.current;
            if (waiter) {
              chatsWaiterRef.current = null;
              if (chatsWaitTimerRef.current) {
                clearTimeout(chatsWaitTimerRef.current);
                chatsWaitTimerRef.current = null;
              }
              waiter(
                incomingIds.map((cid) => ({
                  chat: cid,
                  title: incomingTitles[cid] || cid,
                })),
              );
            }

            // M19: the chat restored from localStorage is only validated
            // against this first server list. A chat deleted on another
            // device would otherwise reopen empty forever.
            const pending = restoredChatRef.current;
            restoredChatRef.current = null;
            if (
              pending &&
              !incomingIds.includes(pending) &&
              activeRef.current === pending &&
              !touchedChatsRef.current.has(pending)
            ) {
              const fallback = newestServerChat(frame.items);
              if (fallback) {
                ensureChat(fallback);
                selectChat(fallback);
                showToastBriefly('该会话已不在服务器列表中，已切换到最近的会话', 'info');
              } else {
                newChat();
                showToastBriefly('该会话已不在服务器列表中，已新建会话', 'info');
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
          setToast({ text: detail ? `${code} — ${detail}` : code, tone: 'danger' });
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
  const activeUsage = usageByChat[activeChat];
  // M19: one receipt per assistant turn the SPA has actually loaded.
  const turnCount = messages.filter((m) => m.turn).length;

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

  // M23: once the hit's chat history is on screen, find the message whose
  // text contains the archive snippet and centre it in the thread. The
  // bottom-scroll effect above runs first; this one overrides it for the
  // jump. `histTick` lets a late history frame retry after an empty first
  // pass, and `rt.loaded` stops us from giving up mid-stream.
  useEffect(() => {
    if (!jumpTarget || jumpTarget.chat !== activeChat) return;
    const list = messagesByChat[activeChat] ?? [];
    const rt = runtimeOf(activeChat);
    if (list.length === 0) {
      if (!rt.loaded) return;
    }
    const anchor = list.length > 0 ? findMessageAnchor(list, jumpTarget.hit) : null;
    if (!anchor && !rt.loaded) return;

    setJumpTarget(null);
    if (!anchor) {
      showToastBriefly(
        jumpTarget.archivedOnly
          ? '该消息仅存在于归档，已打开会话，无法在会话内定位'
          : '该消息不在已加载的历史窗口中，已打开会话',
        'info',
      );
      return;
    }

    const target = list[anchor.index];
    const container = listRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-mid="${target.id}"]`);
    if (container && row) {
      const box = container.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      // `.messages` has scroll-behavior: smooth; a jump must land before the
      // highlight timer starts, so force this one scroll to be instant.
      const previousBehavior = container.style.scrollBehavior;
      container.style.scrollBehavior = 'auto';
      container.scrollTop += rect.top - box.top - (container.clientHeight - rect.height) / 2;
      container.style.scrollBehavior = previousBehavior;
    }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashMessageId(target.id);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlashMessageId(null);
    }, 1800);
    if (!anchor.exact) {
      showToastBriefly('已定位到最接近的匹配位置（该命中无法精确锚定）', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messages/histTick drive the retry
  }, [jumpTarget, activeChat, messages, histTick]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    // M19: while a smooth jump to the bottom is in flight, every intermediate
    // position would otherwise read as "the user scrolled up" and cancel the
    // jump halfway (visible on mobile with a long list that keeps streaming).
    if (atBottom) jumpRef.current = false;
    else if (jumpRef.current) return;
    nearBottomRef.current = atBottom;
    setNearBottom(atBottom);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    jumpRef.current = true;
    nearBottomRef.current = true;
    setNearBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    // The jump is short-lived; release the guard even if it never lands
    // exactly on the bottom (a stream that keeps growing).
    window.setTimeout(() => {
      jumpRef.current = false;
    }, 800);
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
  const startExport = async () => {
    if (bulkRunningRef.current) {
      showToastBriefly('批量导出进行中 — 请先等待或取消', 'info');
      return;
    }
    if (exportRef.current) return;
    const chat = activeChat;
    // M17: the desktop button also flips to "导出中…", but on narrow screens
    // that button is hidden behind the (already closed) overflow menu, so the
    // status line is the only progress signal.
    showToastBriefly('正在导出当前会话…', 'info');
    const outcome = await requestExport(chat, titleOf(chat));
    if (outcome.ok) {
      // M17: verification passed and the browser download has started.
      showToastBriefly(`已导出：${outcome.filename}`, 'ok');
    } else {
      showToastBriefly(outcome.reason);
    }
  };

  const query = search.trim().toLowerCase();
  // M23: the active tag narrows the list first; the text query then narrows
  // the result. Both sections (置顶 / 其他会话) are built from the same list,
  // so pinning keeps working with and without a tag filter.
  const tagOptions = allChatTags(chatTags, chatIds);
  const taggedChats =
    tagFilter == null
      ? chatIds
      : chatIds.filter((id) => chatMatchesTag(chatTags, id, tagFilter));
  const visibleChats = query
    ? taggedChats.filter((id) => titleOf(id).toLowerCase().includes(query))
    : taggedChats;

  // M19: pinned chats keep their pin order (newest first) in the 置顶 group.
  const pinnedSet = new Set(pins);
  const visiblePinned = pins.filter((id) => visibleChats.includes(id));
  const visibleOthers = visibleChats.filter((id) => !pinnedSet.has(id));

  // M23: the command palette filters actions and chat titles with one query.
  const commandEntries = paletteEntries(
    commandQuery,
    chatIds.map((id) => ({ id, title: titleOf(id) })),
  );
  const commandIndex =
    commandEntries.length > 0
      ? Math.min(commandCursor, commandEntries.length - 1)
      : 0;

  /** Drop a filter whose last tagged chat disappeared (pruned or deleted). */
  useEffect(() => {
    if (tagFilter != null && !allChatTags(chatTags, chatIds).includes(tagFilter)) {
      setTagFilter(null);
    }
  }, [tagFilter, chatTags, chatIds]);

  /** Pin or unpin one chat; the newest pin sits first in the 置顶 group. */
  const togglePin = (id: string) => {
    setPins((prev) => togglePinIn(prev, id));
  };

  // ---- M23: chat tags ----
  const setTagsForChat = (id: string, tags: readonly string[]) => {
    setChatTagsState((prev) => setChatTags(prev, id, tags));
  };

  const openTagEditor = (id: string) => {
    if (taggingId === id) {
      setTaggingId(null);
      setTagDraft('');
      return;
    }
    setTaggingId(id);
    setTagDraft((chatTags[id] ?? []).join(', '));
  };

  const commitTagEdit = (id: string) => {
    setTagsForChat(id, parseTagInput(tagDraft));
    setTaggingId(null);
    setTagDraft('');
  };

  const closeTagEditor = () => {
    setTaggingId(null);
    setTagDraft('');
  };

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
      setToast({ text: '未连接：模型未切换', tone: 'danger' });
      return;
    }
    setModelBusy(true);
  };

  const chooseSkill = (skill: SkillItem) => {
    setActiveSkill(skill);
    setInlineSubMode(null);
    // Strip trailing `@query` or leading `/skill` from input
    const next = input.startsWith('/skill')
      ? ''
      : input.replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, '');
    setComposer(next);
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
    // Only an explicit choice is persisted: until then the OS preference
    // keeps deciding on every load (M22).
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      storageSet(THEME_KEY, next);
      return next;
    });
  };

  // ---- M22: prompt library ----
  const openPromptLibrary = (seedName: string = promptNameOf(input)) => {
    setPromptLibStatus('');
    setRenamingPromptId(null);
    setPromptName(seedName);
    setPromptLibOpen(true);
  };

  const saveCurrentAsPrompt = () => {
    const next = addPrompt(prompts, promptName, input);
    if (!next) {
      setPromptLibStatus('请先输入提示词内容，并给它起个名字。');
      return;
    }
    setPrompts(next);
    setPromptLibStatus('已保存到本机提示词库。');
    setPromptName('');
  };

  /** Insert at the caret (or replace the selection), then close the panel. */
  const insertPromptText = (text: string) => {
    const node = textareaRef.current;
    const start = node?.selectionStart ?? input.length;
    const end = node?.selectionEnd ?? input.length;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    const insertion = `${lead}${text}${trail}`;
    setComposer(`${before}${insertion}${after}`);
    setPromptLibOpen(false);
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const caret = before.length + lead.length + text.length;
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  const startPromptRename = (entry: SavedPrompt) => {
    setRenamingPromptId(entry.id);
    setPromptRenameDraft(entry.name);
  };

  const commitPromptRename = () => {
    const id = renamingPromptId;
    if (!id) return;
    setPrompts((prev) => renamePrompt(prev, id, promptRenameDraft));
    setRenamingPromptId(null);
    setPromptRenameDraft('');
  };

  const cancelPromptRename = () => {
    setRenamingPromptId(null);
    setPromptRenameDraft('');
  };

  const deleteSavedPrompt = (id: string) => {
    setPrompts((prev) => removePrompt(prev, id));
    if (renamingPromptId === id) cancelPromptRename();
  };

  const selectChat = (id: string) => {
    setActiveChat(id);
    activeRef.current = id;
    clientRef.current?.setActiveChat(id);
    setSidebarOpen(false);
    setUsageOpen(false);
    cancelUpload();
    setComposerError(null);
    setAttachment(null);
    setInput(draftOf(draftsRef.current, id));
    maybeRequestHist(id);
  };

  /** Hit title: local rename → archived title → the chat id itself. */
  const hitTitle = (hit: SearchHit): string => {
    const custom = chatNames[hit.chat];
    if (custom && custom.trim()) return custom;
    if (hit.title.trim()) return hit.title;
    return hit.chat;
  };

  /**
   * Open a hit's chat, adopting it from the archive when it is not local,
   * and remember the hit so the jump effect can scroll to it once `hist`
   * arrives (M23). `hist` carries no ids/timestamps, so the anchor is the
   * hit's snippet text (see lib/jump.ts).
   */
  const openSearchHit = (hit: SearchHit) => {
    const archivedOnly = !chatIds.includes(hit.chat);
    setJumpTarget({ chat: hit.chat, hit, archivedOnly });
    if (archivedOnly) ensureChat(hit.chat);
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
    setUsageOpen(false);
    cancelUpload();
    setComposerError(null);
    setAttachment(null);
    setInput(draftOf(draftsRef.current, id));
    maybeRequestHist(id);
  };

  /** M24: open the dashboard and ask for fresh numbers. */
  const openStats = () => {
    setSidebarOpen(false);
    setStatsOpen(true);
    requestStats();
  };

  /** M24: a ranking row jumps to that chat (adopting an archived-only id). */
  const openStatsChat = (chat: string) => {
    setStatsOpen(false);
    if (!chatIds.includes(chat)) ensureChat(chat);
    selectChat(chat);
    requestUsage(chat);
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
    // M19: a deleted chat cannot stay pinned.
    setPins((prev) => (prev.includes(id) ? prev.filter((pin) => pin !== id) : prev));
    // M23: nor keep its tags around.
    setChatTagsState((prev) => setChatTags(prev, id, []));
    // M22: its unsent draft goes with it.
    rememberDraft(id, '');
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
        setComposer('');
        if (modelItems.length === 0) requestModels();
        setInlineSubMode('model');
        break;
      case 'skill':
        setComposer('');
        clientRef.current?.send({ t: 'skills' });
        setInlineSubMode('skill');
        break;
      case 'new':
        // M22: the old chat keeps its unsent draft; the new one starts empty.
        newChat();
        break;
      case 'stop':
        setComposer('');
        stop();
        break;
      case 'prompt':
        setComposer('');
        openPromptDrawer();
        break;
      case 'library':
        setComposer('');
        openPromptLibrary('');
        break;
      case 'rename':
        setComposer('');
        startRename(activeChat);
        break;
      case 'delete':
        setComposer('');
        deleteChat(activeChat);
        break;
      case 'clear':
        setComposer('');
        updateChat(activeChat, () => []);
        break;
      case 'theme':
        setComposer('');
        toggleTheme();
        break;
      case 'help':
        setComposer('');
        setHelpOpen(true);
        break;
      default:
        break;
    }
  };

  // ---- M23: Ctrl/⌘+K command palette ----
  const closeCommandPalette = () => {
    setCommandOpen(false);
    setCommandQuery('');
    setCommandCursor(0);
  };

  const openCommandPalette = () => {
    setCommandQuery('');
    setCommandCursor(0);
    setCommandOpen(true);
  };

  /** The old Ctrl/⌘+K behaviour, now the 全文搜索 palette action. */
  const focusArchiveSearch = () => {
    closeCommandPalette();
    setSidebarOpen(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 30);
  };

  const runPaletteEntry = (entry: PaletteEntry) => {
    closeCommandPalette();
    if (entry.kind === 'chat') {
      ensureChat(entry.id);
      selectChat(entry.id);
      return;
    }
    switch (entry.id) {
      case 'new':
        newChat();
        window.setTimeout(() => textareaRef.current?.focus(), 30);
        break;
      case 'export':
        startExport();
        break;
      case 'search':
        focusArchiveSearch();
        break;
      case 'theme':
        toggleTheme();
        break;
      case 'model':
        openModelPicker();
        break;
      case 'usage':
        requestUsage(activeChat);
        setUsageOpen(true);
        break;
      case 'help':
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
    // M19: a chat the user has written in is never replaced by the stale-chat
    // fallback, even if the server list predates this turn.
    touchedChatsRef.current.add(chat);
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
    // M19: a chat the user has written in is never replaced by the stale-chat
    // fallback, even if the server list predates this turn.
    touchedChatsRef.current.add(chat);
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
    rememberDraft(chat, '');
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
    setComposer(userMsg.text);
    textareaRef.current?.focus();
  };

  const onApproval = (chat: string, message: ChatMessage, action: 'approve' | 'deny') => {
    const approval = message.approval;
    const client = clientRef.current;
    if (!approval || approval.status !== 'pending' || !client) return;
    if (answeredApprovals.current.has(approval.reqId)) return;
    if (!client.send({ t: action, chat, req_id: approval.reqId })) {
      setToast({ text: '未连接 — 审批指令未发送。', tone: 'danger' });
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
            setComposer('');
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

  /** M19: one sidebar row, used by both the 置顶 group and the main list. */
  const chatRow = (id: string) => {
    const pinned = pinnedSet.has(id);
    const tags = chatTags[id] ?? [];
    return (
      <div
        key={id}
        className={`chat-item${id === activeChat ? ' active' : ''}${
          renamingId === id ? ' renaming' : ''
        }${pinned ? ' pinned' : ''}`}
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
            {pinned ? (
              <Pin size={12} className="chat-pin-mark" />
            ) : (
              <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.65 }} />
            )}
            <span className="chat-title-text">{titleOf(id)}</span>
          </button>
        )}
        {tags.length > 0 ? (
          <div className="chat-tags" aria-label="会话标签">
            {tags.map((tag) => (
              <span className="chat-tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {taggingId === id ? (
          <div className="chat-tag-edit">
            <input
              className="chat-tag-input"
              value={tagDraft}
              autoFocus
              aria-label="会话标签（逗号分隔）"
              placeholder="标签，逗号分隔"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTagEdit(id);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeTagEditor();
                }
              }}
            />
            <button
              className="chat-tag-save"
              type="button"
              onClick={() => commitTagEdit(id)}
            >
              保存
            </button>
          </div>
        ) : null}
        <span className="chat-id">{id}</span>
        <span className="chat-actions">
          <button
            className={`chat-act chat-tag-btn${taggingId === id ? ' on' : ''}`}
            title="标签"
            aria-label="管理标签"
            aria-pressed={taggingId === id}
            onClick={() => openTagEditor(id)}
          >
            <Tag size={12} />
          </button>
          <button
            className={`chat-act chat-pin${pinned ? ' on' : ''}`}
            title={pinned ? '取消置顶' : '置顶会话'}
            aria-label={pinned ? '取消置顶' : '置顶会话'}
            aria-pressed={pinned}
            onClick={() => togglePin(id)}
          >
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
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
    );
  };

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

      {sidebarOpen ? (
        <div
          className="sidebar-mask"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
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
          <button
            className="sidebar-close"
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="关闭会话列表"
          >
            <X size={16} />
          </button>
        </div>

        <button className="new-chat" onClick={newChat}>
          <span className="new-chat-left">
            <Plus size={15} />
            <span>新建会话</span>
          </span>
          <span className="new-chat-kbd">/new</span>
        </button>

        <button className="stats-open" type="button" onClick={openStats}>
          <BarChart3 size={14} />
          <span>用量统计</span>
        </button>

        <button
          className="bulk-open"
          type="button"
          onClick={startBulkExport}
          disabled={bulkActive || bulkPending}
          title="把服务器列表中的会话逐个导出为 Markdown（最多 100 个）"
        >
          <Download size={14} />
          <span>
            导出全部
            {serverChats.length > 0 ? `（${serverChats.length}）` : ''}
          </span>
          {bulkPending ? <span className="bulk-waiting">获取列表…</span> : null}
        </button>
        <p className="bulk-note">
          仅服务器列表中的会话 · 最多 100 个 · 仅归档的会话不在列表，无法导出
        </p>

        {bulkActive ? (
          <div className="bulk-panel" role="status" aria-live="polite">
            <div className="bulk-panel-head">
              <span>
                {bulkProgress
                  ? `导出中 ${bulkProgress.index}/${bulkProgress.total}`
                  : '导出中…'}
              </span>
              <button className="bulk-cancel" type="button" onClick={cancelBulkExport}>
                取消
              </button>
            </div>
            <div className="bulk-panel-title" title={bulkProgress?.title}>
              {bulkProgress?.title ?? '等待插件响应…'}
            </div>
            <div className="bulk-bar" aria-hidden="true">
              <i
                style={{
                  width: `${
                    bulkProgress
                      ? Math.round(((bulkProgress.index - 1) / bulkProgress.total) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
            {bulkProgress && bulkProgress.skipped > 0 ? (
              <div className="bulk-panel-note">
                仅前 {bulkProgress.total} 个（共 {bulkProgress.total + bulkProgress.skipped} 个）
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="search-wrap">
          <Search size={13} className="search-icon" />
          <input
            className="chat-search"
            type="search"
            ref={searchInputRef}
            value={search}
            placeholder="搜索会话或正文…"
            aria-label="搜索会话与正文"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {tagOptions.length > 0 ? (
          <div className="tag-filters" role="group" aria-label="标签筛选">
            <button
              type="button"
              className={`tag-filter${tagFilter == null ? ' active' : ''}`}
              aria-pressed={tagFilter == null}
              onClick={() => setTagFilter(null)}
            >
              全部
            </button>
            {tagOptions.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-filter${tagFilter === tag ? ' active' : ''}`}
                aria-pressed={tagFilter === tag}
                onClick={() => setTagFilter((current) => (current === tag ? null : tag))}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : null}

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
          {visiblePinned.length > 0 ? (
            <div className="chat-group-label">置顶</div>
          ) : null}
          {visiblePinned.map(chatRow)}
          {visiblePinned.length > 0 && visibleOthers.length > 0 ? (
            <div className="chat-group-label">其他会话</div>
          ) : null}
          {visibleOthers.map(chatRow)}
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
              <div className="top-title" title={titleOf(activeChat)}>
                {titleOf(activeChat)}
              </div>
            </div>
          </div>

          <div className="top-right">
            <div className="top-secondary">
              <div className="identity">
                <span className="agent-pill" title={`当前工作区 Agent: ${agentName || 'default'}`}>
                  <Sparkles size={12} />
                  <span className="agent-name">{agentName || 'Agent'}</span>
                </span>
              </div>

              <button
                className="icon-btn"
                onClick={startExport}
                disabled={exporting || bulkActive || bulkPending}
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
            </div>

            <div
              className="status"
              title={`${STATE_LABEL[state]} · ${agentOnline ? 'Agent 在线' : 'Agent 离线'}`}
              aria-label={`${STATE_LABEL[state]}，${agentOnline ? 'Agent 在线' : 'Agent 离线'}`}
            >
              <i className={`dot state-${state}`} />
              <span className="status-label">{STATE_LABEL[state]}</span>
              <i className={`dot agent-${agentOnline ? 'on' : 'off'}`} />
              <span className="status-label">{agentOnline ? 'Agent 在线' : 'Agent 离线'}</span>
            </div>

            <div className="top-more-wrap" ref={moreWrapRef}>
              <button
                className="icon-btn top-more-btn"
                onClick={() => setMoreOpen((open) => !open)}
                title="更多操作"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                <MoreHorizontal size={16} />
                <span>更多</span>
              </button>
              {moreOpen ? (
                <div className="top-menu" role="menu" aria-label="更多操作">
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="打开命令面板"
                    onClick={() => {
                      setMoreOpen(false);
                      openCommandPalette();
                    }}
                  >
                    <Command size={14} />
                    <span>命令面板</span>
                    <span className="top-menu-kbd">⌘K</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={exporting || bulkActive || bulkPending}
                    onClick={() => {
                      setMoreOpen(false);
                      startExport();
                    }}
                  >
                    <Download size={14} />
                    <span>{exporting ? '导出中…' : '导出 Markdown'}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      openPromptDrawer();
                    }}
                  >
                    <Sliders size={14} />
                    <span>人设与提示词</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到暗黑主题'}
                    onClick={() => {
                      setMoreOpen(false);
                      toggleTheme();
                    }}
                  >
                    {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                    <span>{theme === 'dark' ? '暖陶浅色' : '曜石暗黑'}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {toast ? (
          <div className={`toast toast-${toast.tone}`} role="status">
            <span>{toast.text}</span>
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
                          setComposer(item.prompt);
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
                flash={m.id === flashMessageId}
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
                        setComposer('');
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

          <ContextMeter
            usage={activeUsage}
            turns={turnCount}
            open={usageOpen}
            onToggle={() => {
              if (!activeUsage) requestUsage(activeChat);
              setUsageOpen((open) => !open);
            }}
          />

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
                onChange={(e) => setComposer(e.target.value)}
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

                {/* M22: save the composer text, or insert a saved prompt. */}
                <div className="prompt-lib-wrap" ref={promptLibRef}>
                  <button
                    className={`tool-pill prompt-lib-btn${promptLibOpen ? ' open' : ''}`}
                    onClick={() => (promptLibOpen ? setPromptLibOpen(false) : openPromptLibrary())}
                    aria-haspopup="dialog"
                    aria-expanded={promptLibOpen}
                    title="提示词库：保存当前输入，或插入已保存的提示词"
                  >
                    <BookmarkPlus size={13} />
                    <span>提示词</span>
                  </button>
                  {promptLibOpen ? (
                    <div className="prompt-lib" role="dialog" aria-label="提示词库">
                      <div className="prompt-lib-head">
                        <span>提示词库 ({prompts.length})</span>
                        <button
                          type="button"
                          className="chat-act"
                          onClick={() => setPromptLibOpen(false)}
                          aria-label="关闭提示词库"
                        >
                          <X size={13} />
                        </button>
                      </div>

                      <form
                        className="prompt-save"
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveCurrentAsPrompt();
                        }}
                      >
                        <input
                          value={promptName}
                          onChange={(e) => setPromptName(e.target.value)}
                          placeholder="给这段提示词起个名字…"
                          aria-label="提示词名称"
                        />
                        <button
                          className="prompt-save-btn"
                          type="submit"
                          disabled={!input.trim() || !promptName.trim()}
                        >
                          保存当前输入
                        </button>
                      </form>

                      {promptLibStatus ? (
                        <div className="prompt-lib-status" role="status">
                          {promptLibStatus}
                        </div>
                      ) : null}

                      {prompts.length === 0 ? (
                        <div className="prompt-lib-empty">
                          还没有保存的提示词。先在输入框写下内容，再回到这里命名保存。
                        </div>
                      ) : (
                        <div className="prompt-lib-list">
                          {prompts.map((entry) => (
                            <div
                              className={`prompt-row${
                                renamingPromptId === entry.id ? ' renaming' : ''
                              }`}
                              key={entry.id}
                            >
                              {renamingPromptId === entry.id ? (
                                <input
                                  className="prompt-rename"
                                  value={promptRenameDraft}
                                  autoFocus
                                  aria-label="提示词名称"
                                  onChange={(e) => setPromptRenameDraft(e.target.value)}
                                  onBlur={commitPromptRename}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      commitPromptRename();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      cancelPromptRename();
                                    }
                                  }}
                                />
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="prompt-main"
                                    onClick={() => insertPromptText(entry.text)}
                                    title={entry.text}
                                  >
                                    <span className="prompt-name">{entry.name}</span>
                                    <span className="prompt-preview">
                                      {entry.text.replace(/\s+/g, ' ')}
                                    </span>
                                  </button>
                                  <span className="prompt-actions">
                                    <button
                                      type="button"
                                      className="prompt-act"
                                      onClick={() => startPromptRename(entry)}
                                      aria-label="重命名提示词"
                                      title="重命名"
                                    >
                                      <Edit3 size={12} />
                                    </button>
                                    <button
                                      type="button"
                                      className="prompt-act danger"
                                      onClick={() => deleteSavedPrompt(entry.id)}
                                      aria-label="删除提示词"
                                      title="删除"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </span>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

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

      {statsOpen ? (
        <div className="stats-overlay" onClick={() => setStatsOpen(false)}>
          <StatsView
            stats={stats}
            loading={statsLoading}
            error={statsError}
            onClose={() => setStatsOpen(false)}
            onRefresh={requestStats}
            onOpenChat={openStatsChat}
          />
        </div>
      ) : null}

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

      {commandOpen ? (
        <div
          className="cmd-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCommandPalette();
          }}
        >
          <div className="cmd-palette" role="dialog" aria-modal="true" aria-label="命令面板">
            <div className="cmd-head">
              <Command size={16} className="cmd-head-icon" />
              <input
                ref={commandInputRef}
                className="cmd-input"
                type="text"
                role="combobox"
                aria-label="搜索操作或会话"
                aria-expanded="true"
                aria-controls="cmd-results"
                aria-activedescendant={
                  commandEntries[commandIndex] ? `cmd-opt-${commandIndex}` : undefined
                }
                placeholder="搜索操作或会话…"
                value={commandQuery}
                onChange={(e) => {
                  setCommandQuery(e.target.value);
                  setCommandCursor(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCommandCursor(
                      movePaletteCursor(commandIndex, 1, commandEntries.length),
                    );
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCommandCursor(
                      movePaletteCursor(commandIndex, -1, commandEntries.length),
                    );
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const entry = commandEntries[commandIndex];
                    if (entry) runPaletteEntry(entry);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeCommandPalette();
                  }
                }}
              />
              <button
                type="button"
                className="cmd-close"
                aria-label="关闭命令面板"
                onClick={closeCommandPalette}
              >
                <X size={15} />
              </button>
            </div>

            <div className="cmd-results" id="cmd-results" role="listbox" aria-label="操作与会话">
              {commandEntries.length === 0 ? (
                <div className="cmd-empty">没有匹配的操作或会话</div>
              ) : null}
              {commandEntries.map((entry, index) => {
                const previous = commandEntries[index - 1];
                return (
                  <Fragment key={entry.key}>
                    {!previous || previous.kind !== entry.kind ? (
                      <div className="cmd-group-label">
                        {entry.kind === 'action' ? '操作' : '会话'}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      id={`cmd-opt-${index}`}
                      role="option"
                      aria-selected={index === commandIndex}
                      className={`cmd-row${index === commandIndex ? ' active' : ''}`}
                      onMouseEnter={() => setCommandCursor(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runPaletteEntry(entry)}
                    >
                      {entry.kind === 'action' ? (
                        <Command size={14} className="cmd-row-icon" />
                      ) : (
                        <MessageSquare size={14} className="cmd-row-icon" />
                      )}
                      <span className="cmd-row-label">{entry.label}</span>
                      <span className="cmd-row-hint">{entry.hint}</span>
                    </button>
                  </Fragment>
                );
              })}
            </div>

            <div className="cmd-foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> 选择
              </span>
              <span>
                <kbd>Enter</kbd> 执行
              </span>
              <span>
                <kbd>Esc</kbd> 关闭
              </span>
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
            <h4>键盘快捷键</h4>
            <ul className="help-list">
              <li>
                <code>⌘/Ctrl + K</code>
                <span>打开命令面板</span>
                <em>一个输入框同时搜索操作与会话；全文搜索也在这里（↑↓ 选择，Enter 执行，Esc 关闭）</em>
              </li>
              <li>
                <code>⌘/Ctrl + Shift + O</code>
                <span>新建会话</span>
                <em>等价于左侧「新建会话」按钮，输入框随即可用</em>
              </li>
            </ul>
            <h4>技能调用 (`@`)</h4>
            <p className="help-keys">
              • 在输入框敲 <strong><code>@</code></strong>（或点击左下角「技能」按钮）即可呼出技能列表（包含容器内已启用的技能与内置工作流技能）。<br />
              • 敲 <strong><code>/model</code></strong> 回车即可直接在输入框正上方用键盘方向键切换模型。<br />
              • 输入框上方是上下文计量条：<strong>上下文 ≈</strong> 取最近一轮最后一次模型调用的输入（工具调用轮次不再累加），百分比只在已知模型上下文上限时显示；右侧 <strong>↑输入 / ↓输出</strong> 为本会话累计，点按可展开完整数字。<br />
              • 每条助手回答的底部有 <strong>本轮 ↑… ↓…</strong> 小字，悬停可看精确 token 与合计；估算轮次带 ≈。
            </p>
            <p className="help-build">{formatBuildLabel()}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
