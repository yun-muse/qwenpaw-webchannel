import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { RelayClient } from './relay';
import type { ConnState, ContentPart, Frame } from './relay';
import { LOGIN_REQUIRED, RELAY_HTTP_URL, RELAY_WS_URL } from './config';
import './App.css';

/** protocol/frames.md §5 — UTF-8 bytes of the serialized JSON. */
const MAX_FRAME_BYTES = 256 * 1024;

/** Client token for the hosted relay, kept for the tab's lifetime. */
const TOKEN_KEY = 'webchannel.token';

function readToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
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
}

interface Attachment {
  name: string;
  mime: string;
  data: string;
  size: number;
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
  if (message.kind === 'approval') {
    return (
      <div className="row assistant">
        <ApprovalCard message={message} chat={chat} onApproval={onApproval} />
      </div>
    );
  }
  const markdown = message.role === 'assistant' && !message.streaming;
  const bubble = (
    <div className={`bubble${message.streaming ? ' streaming' : ''}`}>
      {markdown && message.text ? (
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
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
  const [chatIds, setChatIds] = useState<string[]>(() => [newChatId()]);
  const [activeChat, setActiveChat] = useState<string>(() => chatIds[0]);
  const [messagesByChat, setMessagesByChat] = useState<Record<string, ChatMessage[]>>(() => ({
    [chatIds[0]]: [],
  }));
  const [input, setInput] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [state, setState] = useState<ConnState>('idle');
  const [agentOnline, setAgentOnline] = useState(false);
  const [needsLogin, setNeedsLogin] = useState<boolean>(() => LOGIN_REQUIRED && !readToken());

  const clientRef = useRef<RelayClient | null>(null);
  const activeRef = useRef<string>(chatIds[0]);
  const runtimes = useRef<Map<string, ChatRuntime>>(new Map());
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const answeredApprovals = useRef<Set<string>>(new Set());

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

  useEffect(() => {
    activeRef.current = activeChat;
  }, [activeChat]);

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
                { id: nextId++, role: 'assistant', kind: 'parts', text: '', parts: extra },
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
        } else if (next === 'connecting' || next === 'resuming') {
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

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeChat]);

  const titleOf = (id: string): string => {
    const list = messagesByChat[id] ?? [];
    const first = list.find((m) => m.role === 'user' && m.text.trim());
    if (!first) return 'New chat';
    const text = first.text.trim().replace(/\s+/g, ' ');
    return text.length > 34 ? `${text.slice(0, 34)}…` : text;
  };

  const selectChat = (id: string) => {
    setActiveChat(id);
    activeRef.current = id;
    clientRef.current?.setActiveChat(id);
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
    setComposerError(null);
    setAttachment(null);
    maybeRequestHist(id);
  };

  const send = () => {
    const client = clientRef.current;
    if (!client) return;
    const chat = activeChat;
    const text = input.trim();
    const file = attachment;
    if (!text && !file) return;

    const frame: Frame = { t: 'msg', chat, text };
    if (file) frame.files = [{ name: file.name, mime: file.mime, data: file.data }];

    const size = byteSize(frame);
    if (size > MAX_FRAME_BYTES) {
      setComposerError(
        `This message would be ${fmtKb(size)} — protocol v1 allows at most 256 KB per frame ` +
          `(roughly 180 KB of file data). Remove the file or shorten the text.`,
      );
      return;
    }
    if (!client.send(frame)) {
      setComposerError('Not connected — reconnecting. Try again in a moment.');
      return;
    }
    updateChat(chat, (prev) => [
      ...prev,
      {
        id: nextId++,
        role: 'user',
        kind: 'text',
        text,
        attachments: file ? [file.name] : undefined,
      },
    ]);
    setInput('');
    setAttachment(null);
    setComposerError(null);
  };

  const stop = () => {
    clientRef.current?.send({ t: 'stop', chat: activeChat });
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => setComposerError('Could not read that file.');
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const data = comma >= 0 ? result.slice(comma + 1) : '';
      if (!data) {
        setComposerError('Could not read that file.');
        return;
      }
      const mime = file.type || 'application/octet-stream';
      const frame: Frame = {
        t: 'msg',
        chat: activeRef.current,
        text: input.trim(),
        files: [{ name: file.name, mime, data }],
      };
      const size = byteSize(frame);
      if (size > MAX_FRAME_BYTES) {
        setComposerError(
          `${file.name} is too large: the frame would be ${fmtKb(size)} and protocol v1 caps a ` +
            `whole message at 256 KB (about 180 KB of file data before base64 overhead).`,
        );
        return;
      }
      setComposerError(null);
      setAttachment({ name: file.name, mime, data, size: file.size });
    };
    reader.readAsDataURL(file);
  };

  const canSend = state === 'live' && (input.trim().length > 0 || attachment != null);

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
    <div className="app">
      <aside className="sidebar">
        <div className="brand">QwenPaw</div>
        <button className="new-chat" onClick={newChat}>
          + New chat
        </button>
        <nav className="chat-list">
          {chatIds.map((id) => (
            <button
              key={id}
              className={`chat-item${id === activeChat ? ' active' : ''}`}
              onClick={() => selectChat(id)}
              title={id}
            >
              <span className="chat-title">{titleOf(id)}</span>
              <span className="chat-id">{id}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">WebChannel · protocol v1</div>
      </aside>

      <main className="main">
        <header className="top">
          <div className="top-title">{titleOf(activeChat)}</div>
          <div className="status">
            <i className={`dot state-${state}`} />
            <span className="status-label">{STATE_LABEL[state]}</span>
            <i className={`dot agent-${agentOnline ? 'on' : 'off'}`} />
            <span className="status-label">{agentOnline ? 'agent online' : 'agent offline'}</span>
          </div>
        </header>

        {toast ? (
          <div className="toast" role="status">
            <span>{toast}</span>
            <button onClick={() => setToast(null)}>Dismiss</button>
          </div>
        ) : null}

        <div className="messages" ref={listRef}>
          {messages.length === 0 ? (
            <p className="empty">
              No messages yet. Say hello — replies stream in through the relay.
            </p>
          ) : null}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} chat={activeChat} onApproval={onApproval} />
          ))}
        </div>

        <div className="composer">
          {composerError ? <div className="composer-error">{composerError}</div> : null}
          {attachment ? (
            <div className="chips">
              <span className="chip" title={`${attachment.name} (${fmtKb(attachment.size)})`}>
                {attachment.name}
                <button
                  className="chip-x"
                  aria-label="Remove attachment"
                  onClick={() => setAttachment(null)}
                >
                  x
                </button>
              </span>
              <span className="chip-note">sent with your next message</span>
            </div>
          ) : null}
          <div className="composer-row">
            <button
              className="attach"
              onClick={() => fileRef.current?.click()}
              title="Attach a file (v1: about 180 KB max)"
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
    </div>
  );
}
