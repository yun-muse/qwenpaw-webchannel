import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { RelayClient } from './relay';
import type { ConnState, ContentPart, Frame } from './relay';
import { LOGIN_REQUIRED, RELAY_HTTP_URL, RELAY_WS_URL } from './config';
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

/** Client token for the hosted relay, kept for the tab's lifetime. */
const TOKEN_KEY = 'webchannel.token';

/** Chat list + visible chat from the previous visit (survives a reload). */
const CHATS_KEY = 'webchannel.chats';
const ACTIVE_KEY = 'webchannel.activeChat';

/** User-given chat titles, keyed by chat id (M7). */
const NAMES_KEY = 'webchannel.chatNames';
/** 'light' | 'dark' (M7). */
const THEME_KEY = 'webchannel.theme';

/** Distance from the bottom (px) that still counts as "reading the latest". */
const NEAR_BOTTOM_PX = 80;

function readToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
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

/**
 * Chat list + active chat to start from: the persisted ones when usable,
 * otherwise exactly one fresh chat (true first visit). Never a second chat.
 */
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
  /** model thinking streamed before the answer (reasoning segment) */
  thinking?: string;
  streaming?: boolean;
  parts?: ContentPart[];
  attachments?: string[];
  approval?: ApprovalMeta;
  /** client-side creation time (ms epoch); absent on history rows */
  ts?: number;
}

/** One row of a `models` control frame (protocol §9.1). */
interface ModelItem {
  provider: string;
  model: string;
  active: boolean;
}

interface ModelRef {
  provider: string;
  model: string;
}

interface CommandSpec {
  /** matched against what the user typed after the slash; also the frame-free id */
  id: string;
  label: string;
  hint: string;
}

/** `/` palette (M7). Labels are fixed by the task spec. */
const COMMANDS: CommandSpec[] = [
  { id: 'new', label: '新建会话', hint: 'start a new chat' },
  { id: 'stop', label: '停止生成', hint: 'stop the current reply' },
  { id: 'model', label: '切换模型', hint: 'pick the agent model' },
  { id: 'rename', label: '重命名当前会话', hint: 'rename this chat' },
  { id: 'delete', label: '删除当前会话', hint: 'delete this chat' },
  { id: 'clear', label: '清空当前会话显示（仅本地）', hint: 'local display only' },
  { id: 'theme', label: '切换深浅色', hint: 'toggle dark mode' },
  { id: 'help', label: '帮助', hint: 'commands + shortcuts' },
];

interface AttachmentInline {
  kind: 'inline';
  name: string;
  mime: string;
  data: string;
  size: number;
}

/**
 * A v2 chunked upload (§8). `sent`/`chunks` drive the chip progress; `ref`
 * only exists once the plugin answered `file_ready` and may be sent.
 */
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

/**
 * One chunked transfer in flight. Kept in a ref (not state) so the frame
 * dispatch and the pacing loop share it without stale closures.
 */
interface Upload {
  id: string;
  chat: string;
  name: string;
  mime: string;
  size: number;
  bytes: ArrayBuffer;
  chunks: number;
  /** lowercase hex sha256 of `bytes`, computed once (also for the retry) */
  sha256: string;
  /** set by remove / chat switch / failure: the pacing loop must stop */
  cancelled: boolean;
  /** the automatic `E_CHECKSUM` retry has already been used */
  retried: boolean;
  /** 60 s watchdog for the reply to `file_end` */
  timer: ReturnType<typeof setTimeout> | null;
}

interface ChatRuntime {
  /** bubble currently receiving `evt` deltas */
  activeId: number | null;
  /** bubble that just got `end` and awaits the trailing `msg` */
  endedId: number | null;
  /** a `hist` request is in flight (no frame seen yet) */
  histPending: boolean;
  /** a `hist` batch is still incomplete (`more:true` seen) */
  histOpen: boolean;
  /** history has been requested once for this chat */
  loaded: boolean;
}

let nextId = 1;
/** Suffix for chunked transfer ids, unique per pick within the tab. */
let uploadCounter = 1;

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

/** §8.1 — the digest travels as 64 lowercase hex chars. */
function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Base64 in small sub-slices: spreading a 96 KB chunk into
 * `String.fromCharCode` would blow the argument limit.
 */
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

function uploadPercent(file: AttachmentChunked): number {
  if (file.chunks <= 0) return file.status === 'ready' ? 100 : 0;
  return Math.min(100, Math.round((file.sent / file.chunks) * 100));
}

/** Composer chip caption for the current attachment state. */
function chipNote(file: Attachment): string {
  if (file.kind === 'inline') return 'sent with your next message';
  if (file.status === 'uploading') return `uploading… ${uploadPercent(file)}%`;
  if (file.status === 'ready') return 'uploaded — sent with your next message';
  return 'upload failed — remove and pick the file again';
}

/** The one oversize-attachment message, shared by pick-time and send-time. */
function oversizeError(sizeBytes: number): string {
  return `附件太大：v1 单条消息上限 256KB（含正文与附件编码），当前约 ${fmtKb(sizeBytes)}`;
}

/** `evt.data` is a raw stream event; the plugin sends {text:<delta>}. */
function deltaOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as { text?: unknown; delta?: unknown };
    if (typeof d.text === 'string') return d.text;
    if (typeof d.delta === 'string') return d.delta;
  }
  return '';
}

/**
 * Stream segment of an `evt.data` / `start` / `end` frame: "reasoning" or
 * "message". '' (absent) is a legacy/mock frame and counts as the answer.
 */
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

/** `models.items` (§9.1): keep only well-formed rows the header can render. */
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

/** Finalized assistant text: markdown, sanitized before it touches the DOM. */
function renderMarkdown(text: string): string {
  const html = marked.parse(text) as unknown as string;
  return DOMPurify.sanitize(html);
}

/** Clipboard with a textarea fallback for insecure contexts. Silent on failure. */
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

/** Local wall clock, HH:MM. */
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
  idle: 'offline',
  connecting: 'connecting',
  live: 'live',
  resuming: 'resuming',
  resync: 'resyncing',
};

function PartCard({ part }: { part: ContentPart }) {
  return (
    <details className="part-card">
      <summary>{partTitle(part)}</summary>
      <pre>{displayPart(part)}</pre>
    </details>
  );
}

/**
 * Rendered markdown. Code blocks get a hover `Copy` button appended to the
 * `<pre>` (impure DOM work outside the React tree); the click itself is
 * delegated to this container, as the task spec asks.
 */
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.pre-copy')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pre-copy';
      button.textContent = 'Copy';
      pre.appendChild(button);
    });
  }, [html]);

  const onCopyClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('.pre-copy');
    if (!(button instanceof HTMLElement)) return;
    const pre = button.closest('pre');
    if (!pre) return;
    const code = pre.querySelector('code');
    const source = code?.textContent ?? pre.textContent ?? '';
    void copyText(source).then((ok) => {
      if (!ok) return;
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    });
  };

  return (
    <div className="md" ref={ref} onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
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
        <span className="approval-tool">{approval.tool}</span>
        <span className={`severity sev-${severityClass || 'info'}`}>{approval.severity}</span>
      </div>
      {approval.summary ? <pre className="approval-summary">{approval.summary}</pre> : null}
      <div className="approval-actions">
        <button className="approve" disabled={locked} onClick={() => onApproval(chat, message, 'approve')}>
          Approve
        </button>
        <button className="deny" disabled={locked} onClick={() => onApproval(chat, message, 'deny')}>
          Deny
        </button>
        {approval.status === 'sent' ? (
          <span className="approval-note">sent… ({approval.action})</span>
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
}: {
  message: ChatMessage;
  chat: string;
  onApproval: (chat: string, message: ChatMessage, action: 'approve' | 'deny') => void;
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
        <ApprovalCard message={message} chat={chat} onApproval={onApproval} />
      </div>
    );
  }

  const copy = () => {
    void copyText(copySource(message)).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    });
  };

  const markdown = message.role === 'assistant' && !message.streaming;
  const bubble = (
    <div className={`bubble${message.streaming ? ' streaming' : ''}`}>
      {markdown && message.text ? (
        <Markdown text={message.text} />
      ) : (
        <span className="plain">
          {message.text}
          {message.streaming ? <i className="caret" /> : null}
        </span>
      )}
      {message.parts?.map((part, index) => (
        <PartCard key={`${message.id}-${index}`} part={part} />
      ))}
      {message.attachments?.length ? (
        <div className="bubble-files">
          {message.attachments.map((name) => (
            <span className="chip" key={name}>
              {name}
            </span>
          ))}
        </div>
      ) : null}
      {message.streaming ? null : (
        <div className="bubble-foot">
          {message.ts ? <span className="bubble-time">{clockOf(message.ts)}</span> : null}
          <button className="copy-btn" onClick={copy} title="复制消息">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
  return (
    <div className={`row ${message.role}`}>
      {message.thinking ? (
        <div className="reply">
          <details className="thinking">
            <summary>thinking</summary>
            <div className="thinking-body">{message.thinking}</div>
          </details>
          {bubble}
        </div>
      ) : (
        bubble
      )}
    </div>
  );
}

/** Hosted-relay login gate — rendered instead of the chat UI until a token exists. */
function LoginGate({ onSuccess }: { onSuccess: (token: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!password) {
      setError('Enter the relay password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${RELAY_HTTP_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => null)) as {
        token?: unknown;
        error?: unknown;
      } | null;
      if (!res.ok) {
        const serverError = body && typeof body.error === 'string' ? body.error : '';
        setError(serverError || `Login failed (${res.status}).`);
        setBusy(false);
        return;
      }
      const token = body && typeof body.token === 'string' ? body.token : '';
      if (!token) {
        setError('Login failed — the relay returned no token.');
        setBusy(false);
        return;
      }
      onSuccess(token);
    } catch {
      setError('Could not reach the relay. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">QwenPaw</div>
        <p className="login-sub">Enter the relay password to connect.</p>
        <input
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? <div className="login-error">{error}</div> : null}
      </form>
    </div>
  );
}

export default function App() {
  // Restore once: chatIds, activeChat and messagesByChat must agree on the
  // same start, otherwise the first render points at a chat that isn't there.
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
  const [needsLogin, setNeedsLogin] = useState<boolean>(() => LOGIN_REQUIRED && !readToken());

  // --- M7: identity, models, sidebar, palette, theme, layout ---
  const [agentName, setAgentName] = useState('');
  const [modelItems, setModelItems] = useState<ModelItem[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelRef | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  /** composer text at the moment Esc closed the palette (suppresses it until edited) */
  const [paletteMuted, setPaletteMuted] = useState<string | null>(null);
  const [chatNames, setChatNames] = useState<Record<string, string>>(persistedNames);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);

  const clientRef = useRef<RelayClient | null>(null);
  const activeRef = useRef<string>(session.active);
  const runtimes = useRef<Map<string, ChatRuntime>>(new Map());
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const answeredApprovals = useRef<Set<string>>(new Set());
  /** the chunked transfer in flight (one attachment at a time) */
  const uploadRef = useRef<Upload | null>(null);
  /** `{t:"models"}` is asked once per connection, not per state change (§9.4) */
  const modelsRequested = useRef(false);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastChatRef = useRef<string>(session.active);

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

  /** Ask the agent for this chat's history (protocol §2.4 `hist`). */
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
      // Skip the longest prefix of `incoming` that the tail of `prev`
      // already shows (a re-requested batch after a dropped socket).
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

  /** Stop the pacing loop, disarm the watchdog, ignore late replies (§8.3). */
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

  /** The transfer is dead: chip stays failed, Send stays blocked until removal. */
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

  /** `file_begin`, the paced chunks, then `file_end` (§8.1/§8.3). Re-run on retry. */
  const runUpload = async (up: Upload) => {
    if (up.cancelled) return;
    // A retry restarts progress from 0 with the same id (§8.2).
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
      failUpload(up, 'Not connected — reconnecting. Try again in a moment.');
      return;
    }

    const bytes = new Uint8Array(up.bytes);
    for (let i = 0; i < up.chunks; i += 1) {
      // Pace every chunk (also the first, right after `file_begin`).
      await sleep(CHUNK_PACE_MS);
      if (up.cancelled) return;
      const start = i * CHUNK_BYTES;
      const data = base64Of(bytes.subarray(start, Math.min(start + CHUNK_BYTES, bytes.length)));
      if (!sendUploadFrame({ t: 'file_chunk', chat: up.chat, id: up.id, i, data })) {
        failUpload(up, 'Not connected — reconnecting. Try again in a moment.');
        return;
      }
      setAttachment((prev) =>
        prev && prev.kind === 'chunked' && prev.id === up.id ? { ...prev, sent: i + 1 } : prev,
      );
    }

    if (up.chunks > 0) await sleep(CHUNK_PACE_MS);
    if (up.cancelled) return;
    if (!sendUploadFrame({ t: 'file_end', chat: up.chat, id: up.id })) {
      failUpload(up, 'Not connected — reconnecting. Try again in a moment.');
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

  /** Start a v2 transfer for a file that cannot go inline and fits 10 MB. */
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

  // Persist so a reload restores this list and this conversation.
  useEffect(() => {
    storageSet(CHATS_KEY, JSON.stringify(chatIds));
    storageSet(ACTIVE_KEY, activeChat);
  }, [chatIds, activeChat]);

  // Custom titles survive a reload like the chat list itself.
  useEffect(() => {
    storageSet(NAMES_KEY, JSON.stringify(chatNames));
  }, [chatNames]);

  // The theme lives on <html data-theme>, which is what the CSS keys off.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storageSet(THEME_KEY, theme);
  }, [theme]);

  // A new query starts at the first command again.
  useEffect(() => {
    setPaletteIndex(0);
  }, [input]);

  // Esc / a click outside closes the model picker.
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

  // Esc closes the help dialog.
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
    /** `<chat>|<field>` -> text not yet rendered (rAF coalescing) */
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

    /** Append *delta* to the bubble's answer text or thinking block. */
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
          // A reply streams in two segments (reasoning, then message). A
          // start after an earlier segment of the same reply keeps its
          // bubble; only a fresh reply gets a new one.
          if (rt.activeId == null) newBubble(chat);
          break;
        }

        case 'evt': {
          const delta = deltaOf(frame.data);
          if (!delta) break;
          ensureChat(chat);
          // Only the answer segment feeds the bubble; reasoning goes to the
          // thinking block, and a missing stream_type is a legacy/mock frame
          // that counts as answer text.
          const streamType = streamTypeOf(frame.data);
          if (streamType === 'reasoning') bump(chat, 'thinking', delta);
          else if (!streamType || streamType === 'message') bump(chat, 'text', delta);
          break;
        }

        case 'end': {
          flushNow();
          const rt = runtimeOf(chat);
          // An end for reasoning closes that segment only: the reply is
          // still streaming until the message segment ends.
          if (streamTypeOf(frame) === 'reasoning') break;
          const id = rt.activeId;
          rt.activeId = null;
          rt.endedId = id;
          if (id != null) {
            updateChat(chat, (prev) =>
              prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
            );
          }
          break;
        }

        case 'msg': {
          flushNow();
          const parts = partsOf(frame);
          const text = textOf(parts);
          const extra = parts.filter((p) => p && p.type !== 'text');
          const rt = runtimeOf(chat);

          // The trailing full-text msg after `end` (A1) is the same answer:
          // merge it into the bubble instead of adding a second one.
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
            break;
          }

          // A msg while a reply is streaming: tool output. Text would clobber
          // the in-flight answer, but non-text parts are worth showing.
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
          // §8.3: a checksum mismatch retries the whole file once, same id.
          if (code === 'E_CHECKSUM' && !up.retried) {
            up.retried = true;
            void runUpload(up);
            break;
          }
          failUpload(up, `文件传输失败：${code}${detail ? ` — ${detail}` : ''}`);
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

        // ---- M7 control frames (protocol §9) ----
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
          break;
        }

        case 'error': {
          const code = asString(frame.code) || 'E_UNKNOWN';
          const detail = asString(frame.detail);
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
          // A refused switch keeps the picker open; the toast explains it.
          if (code === 'E_MODEL') setModelBusy(false);
          setToast(detail ? `${code} — ${detail}` : code);
          break;
        }

        case 'ready':
        case 'peer':
          // presence is reflected through onState
          break;

        default:
          break;
      }
    };

    const client = new RelayClient({
      url: RELAY_WS_URL,
      // Re-read on every attempt: the token can expire while the page is open.
      getToken: () => (LOGIN_REQUIRED ? readToken() : null),
      onAuthFailure: () => {
        if (!LOGIN_REQUIRED) return;
        sessionStorage.removeItem(TOKEN_KEY);
        setNeedsLogin(true);
      },
      onState: (next, info) => {
        setState(next);
        setAgentOnline(info.agentOnline);
        if (next === 'live') {
          maybeRequestHist(activeRef.current);
          // Control frames are never replayed on resume (§9.4): ask once per
          // connection, and again after a reconnect.
          if (!modelsRequested.current) {
            modelsRequested.current = true;
            clientRef.current?.send({ t: 'models' });
          }
        } else if (next === 'connecting' || next === 'resuming') {
          modelsRequested.current = false;
          // A hist request in flight dies with the socket; ask again later.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers only touch refs
  }, [needsLogin]);

  const messages = messagesByChat[activeChat] ?? [];
  const streaming = messages.some((m) => m.streaming);

  // Follow the tail only when the reader is already there (or switched chats);
  // otherwise their position in the history is left alone.
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

  /** Derived title from the first user message (today's behaviour). */
  const derivedTitle = (id: string): string => {
    const list = messagesByChat[id] ?? [];
    const first = list.find((m) => m.role === 'user' && m.text.trim());
    if (!first) return 'New chat';
    const text = first.text.trim().replace(/\s+/g, ' ');
    return text.length > 34 ? `${text.slice(0, 34)}…` : text;
  };

  const titleOf = (id: string): string => {
    const custom = chatNames[id];
    return custom && custom.trim() ? custom : derivedTitle(id);
  };

  const query = search.trim().toLowerCase();
  const visibleChats = query
    ? chatIds.filter((id) => titleOf(id).toLowerCase().includes(query))
    : chatIds;

  const requestModels = () => {
    clientRef.current?.send({ t: 'models' });
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
      return;
    }
    if (!clientRef.current?.send({ t: 'set_model', provider: item.provider, model: item.model })) {
      setToast('未连接：模型未切换');
      return;
    }
    setModelBusy(true);
  };

  const startRename = (id: string) => {
    if (!chatIds.includes(id)) return;
    // `/rename` on a narrow screen has to reveal the drawer to show the input.
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
    if (!window.confirm(`删除会话「${title}」？（仅从本浏览器移除）`)) return;
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
    if (renamingId === id) cancelRename();
    if (id !== activeChat) return;
    if (remaining.length > 0) selectChat(remaining[0]);
    else newChat();
  };

  const stop = () => {
    clientRef.current?.send({ t: 'stop', chat: activeChat });
  };

  const runCommand = (id: string) => {
    setInput('');
    setPaletteMuted(null);
    setPaletteIndex(0);
    switch (id) {
      case 'new':
        newChat();
        break;
      case 'stop':
        stop();
        break;
      case 'model':
        openModelPicker();
        break;
      case 'rename':
        startRename(activeChat);
        break;
      case 'delete':
        deleteChat(activeChat);
        break;
      case 'clear':
        updateChat(activeChat, () => []);
        break;
      case 'theme':
        toggleTheme();
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

  const send = () => {
    const client = clientRef.current;
    if (!client) return;
    const chat = activeChat;
    const text = input.trim();
    const file = attachment;
    if (!text && !file) return;
    // §8: a chunked file may only be referenced once the plugin staged it.
    if (file && file.kind === 'chunked' && file.status !== 'ready') return;

    const frame: Frame = { t: 'msg', chat, text };
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
      setComposerError('Not connected — reconnecting. Try again in a moment.');
      return;
    }
    // Own message: always follow it to the bottom.
    nearBottomRef.current = true;
    setNearBottom(true);
    updateChat(chat, (prev) => [
      ...prev,
      {
        id: nextId++,
        role: 'user',
        kind: 'text',
        text,
        attachments: file ? [file.name] : undefined,
        ts: Date.now(),
      },
    ]);
    setInput('');
    setAttachment(null);
    setComposerError(null);
  };

  const onApproval = (chat: string, message: ChatMessage, action: 'approve' | 'deny') => {
    const approval = message.approval;
    const client = clientRef.current;
    if (!approval || approval.status !== 'pending' || !client) return;
    if (answeredApprovals.current.has(approval.reqId)) return;
    if (!client.send({ t: action, chat, req_id: approval.reqId })) {
      setToast('Not connected — the approval was not sent.');
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

  // ---- `/` palette state for this keystroke ----
  const paletteTyping = input.startsWith('/') && !/\s/.test(input) && paletteMuted !== input;
  const paletteQuery = paletteTyping ? input.slice(1).toLowerCase() : '';
  const paletteItems = paletteTyping
    ? COMMANDS.filter((cmd) => cmd.id.toLowerCase().startsWith(paletteQuery))
    : [];
  const paletteOpen = paletteItems.length > 0;
  const paletteCursor = paletteOpen ? Math.min(paletteIndex, paletteItems.length - 1) : 0;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (paletteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIndex((index) => (index + 1) % paletteItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIndex((index) => (index - 1 + paletteItems.length) % paletteItems.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPaletteMuted(input);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const command = paletteItems[paletteCursor];
        if (command) runCommand(command.id);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // One attachment at a time: a new pick replaces (and cancels) the old one.
    cancelUpload();
    const mime = file.type || 'application/octet-stream';
    const reader = new FileReader();
    reader.onerror = () => setComposerError('Could not read that file.');
    reader.onload = () => {
      const buffer = reader.result;
      if (!(buffer instanceof ArrayBuffer)) {
        setComposerError('Could not read that file.');
        return;
      }
      // Small enough to possibly fit: keep the exact v1 inline rule (§5).
      if (file.size <= INLINE_PROBE_BYTES) {
        const data = base64Of(new Uint8Array(buffer));
        if (!data) {
          setComposerError('Could not read that file.');
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

  const uploadBlocked = attachment?.kind === 'chunked' && attachment.status !== 'ready';
  const canSend =
    state === 'live' && (input.trim().length > 0 || attachment != null) && !uploadBlocked;

  if (needsLogin) {
    return (
      <LoginGate
        onSuccess={(token) => {
          sessionStorage.setItem(TOKEN_KEY, token);
          setNeedsLogin(false);
        }}
      />
    );
  }

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">QwenPaw</div>
        <input
          className="chat-search"
          type="search"
          value={search}
          placeholder="搜索会话"
          aria-label="搜索会话"
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="new-chat" onClick={newChat}>
          + New chat
        </button>
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
                  title={id}
                >
                  {titleOf(id)}
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
                  ✎
                </button>
                <button
                  className="chat-act danger"
                  title="删除"
                  aria-label="删除会话"
                  onClick={() => deleteChat(id)}
                >
                  ×
                </button>
              </span>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>WebChannel · protocol v1</span>
          <button
            className="help-btn"
            onClick={() => setHelpOpen(true)}
            title="帮助"
            aria-label="帮助"
          >
            ?
          </button>
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
              ☰
            </button>
            <div className="top-title">{titleOf(activeChat)}</div>
          </div>
          <div className="top-right">
            <div className="identity">
              <span className="agent-name" title={agentName || 'agent'}>
                {agentName || 'agent'}
              </span>
              <div className="model-wrap" ref={modelWrapRef}>
                <button
                  className={`model-button${pickerOpen ? ' open' : ''}`}
                  onClick={toggleModelPicker}
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                  title={currentModel ? `${currentModel.provider} / ${currentModel.model}` : 'model —'}
                >
                  <span className="model-label">
                    {currentModel ? `${currentModel.provider} / ${currentModel.model}` : 'model —'}
                  </span>
                  <span className="model-caret" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {pickerOpen ? (
                  <div className="model-picker" role="listbox" aria-label="模型">
                    {modelItems.length === 0 ? (
                      <div className="model-empty">No models available</div>
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
                    {modelBusy ? <div className="model-busy">switching…</div> : null}
                  </div>
                ) : null}
              </div>
            </div>
            <button
              className="icon-btn"
              onClick={toggleTheme}
              title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
              aria-label="切换主题"
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <div className="status">
              <i className={`dot state-${state}`} />
              <span className="status-label">{STATE_LABEL[state]}</span>
              <i className={`dot agent-${agentOnline ? 'on' : 'off'}`} />
              <span className="status-label">{agentOnline ? 'agent online' : 'agent offline'}</span>
            </div>
          </div>
        </header>

        {toast ? (
          <div className="toast" role="status">
            <span>{toast}</span>
            <button onClick={() => setToast(null)}>Dismiss</button>
          </div>
        ) : null}

        <div className="thread">
          <div className="messages" ref={listRef} onScroll={onListScroll}>
            {messages.length === 0 ? (
              <p className="empty">
                No messages yet. Say hello — replies stream in through the relay.
              </p>
            ) : null}
            {messages.map((m) => (
              <MessageView key={m.id} message={m} chat={activeChat} onApproval={onApproval} />
            ))}
          </div>
          {!nearBottom && messages.length > 0 ? (
            <button
              className="scroll-bottom"
              onClick={scrollToBottom}
              title="回到最新"
              aria-label="回到最新"
            >
              ↓
            </button>
          ) : null}
        </div>

        <div className="composer">
          {paletteOpen ? (
            <div className="palette" role="listbox" aria-label="命令">
              {paletteItems.map((command, index) => (
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
            </div>
          ) : null}
          {composerError ? <div className="composer-error">{composerError}</div> : null}
          {attachment ? (
            <div className="chips">
              <span
                className={`chip${attachment.kind === 'chunked' ? ` upload-${attachment.status}` : ''}`}
                title={`${attachment.name} (${fmtKb(attachment.size)})`}
              >
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
                <button className="chip-x" aria-label="Remove attachment" onClick={removeAttachment}>
                  x
                </button>
              </span>
              <span className="chip-note">{chipNote(attachment)}</span>
            </div>
          ) : null}
          <div className="composer-row">
            <button
              className="attach"
              onClick={() => fileRef.current?.click()}
              title="Attach a file (≤ 10 MB via chunked upload; message ≤ 256 KB)"
            >
              Attach
            </button>
            <input ref={fileRef} type="file" hidden onChange={onPickFile} />
            <textarea
              rows={1}
              value={input}
              placeholder={state === 'live' ? 'Message the agent…' : 'Connecting…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {streaming ? (
              <button className="stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="send" onClick={send} disabled={!canSend}>
                Send
              </button>
            )}
          </div>
          <div className="hint">
            Enter to send · Shift+Enter for a newline · chat {activeChat}
          </div>
        </div>
      </main>

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
              <span>帮助</span>
              <button className="help-close" onClick={() => setHelpOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <h4>命令</h4>
            <ul className="help-list">
              {COMMANDS.map((command) => (
                <li key={command.id}>
                  <code>/{command.id}</code>
                  <span>{command.label}</span>
                  <em>{command.hint}</em>
                </li>
              ))}
            </ul>
            <h4>快捷键</h4>
            <p className="help-keys">Enter 发送 · Shift+Enter 换行 · `/` 命令面板 · Esc 关闭面板/对话框</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
