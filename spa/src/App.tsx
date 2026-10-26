import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { RelayClient } from './relay';
import type { ConnState, Frame } from './relay';

const CHAT = 'default';

type ChatMessage = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
};

let nextId = 1;

/** `evt.data` is a raw stream event; M0/mock uses {type:"text_delta", text}. */
function deltaOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as { text?: unknown; delta?: unknown };
    if (typeof d.text === 'string') return d.text;
    if (typeof d.delta === 'string') return d.delta;
  }
  return '';
}

function textOf(parts: Frame['parts']): string {
  return (parts ?? [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n');
}

const DOT: Record<ConnState, string> = {
  idle: '#9ca3af',
  connecting: '#f59e0b',
  live: '#22c55e',
  resuming: '#f59e0b',
  resync: '#3b82f6',
};

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  .app { max-width: 800px; margin: 0 auto; height: 100%; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px;
         padding: 12px 16px; border-bottom: 1px solid #8883; }
  .brand { font-weight: 600; }
  .status { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .8; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
  .list { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .empty { margin: auto; text-align: center; opacity: .5; max-width: 32ch; }
  .row { display: flex; }
  .row.user { justify-content: flex-end; }
  .bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px;
            white-space: pre-wrap; overflow-wrap: anywhere; }
  .assistant .bubble { background: #8881; }
  .user .bubble { background: #2563eb; color: #fff; }
  .caret { display: inline-block; width: .5em; height: 1em; margin-left: 2px;
           background: currentColor; opacity: .6; animation: pulse 1s steps(2) infinite;
           vertical-align: -2px; }
  @keyframes pulse { 50% { opacity: 0; } }
  .inputbar { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #8883; }
  textarea { flex: 1; resize: none; padding: 10px 12px; border: 1px solid #8886;
             border-radius: 10px; font: inherit; background: transparent; color: inherit; }
  button { padding: 0 18px; border: 0; border-radius: 10px; background: #2563eb;
           color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .hint { padding: 0 16px 10px; font-size: 12px; opacity: .55; }
`;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [state, setState] = useState<ConnState>('idle');
  const [agentOnline, setAgentOnline] = useState(false);

  const clientRef = useRef<RelayClient | null>(null);
  const activeRef = useRef<number | null>(null);
  const finalizingRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    /** bubble id -> text not yet rendered (rAF coalescing) */
    const pending = new Map<number, string>();

    const applyPending = () => {
      raf = 0;
      if (pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setMessages((prev) =>
        prev.map((m) => {
          const add = batch.get(m.id);
          return add ? { ...m, text: m.text + add } : m;
        }),
      );
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
    const bump = (id: number, delta: string) => {
      pending.set(id, (pending.get(id) ?? '') + delta);
      schedule();
    };
    const newAssistant = () => {
      const id = nextId++;
      activeRef.current = id;
      setMessages((prev) => [...prev, { id, role: 'assistant', text: '', streaming: true }]);
      return id;
    };

    const onFrame = (frame: Frame) => {
      switch (frame.t) {
        case 'start': {
          flushNow();
          finalizingRef.current = null;
          activeRef.current = null;
          newAssistant();
          break;
        }
        case 'evt': {
          const delta = deltaOf(frame.data);
          if (!delta) break;
          const id = activeRef.current ?? newAssistant();
          bump(id, delta);
          break;
        }
        case 'end': {
          flushNow();
          const id = activeRef.current;
          activeRef.current = null;
          if (id != null) {
            finalizingRef.current = id;
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
            );
          }
          break;
        }
        case 'msg': {
          flushNow();
          const text = textOf(frame.parts);
          if (!text) break;
          const id = activeRef.current ?? finalizingRef.current;
          activeRef.current = null;
          finalizingRef.current = null;
          if (id != null) {
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, text, streaming: false } : m)),
            );
          } else {
            setMessages((prev) => [...prev, { id: nextId++, role: 'assistant', text }]);
          }
          break;
        }
        case 'resync': {
          // M0: no history endpoint yet — settle any half-streamed bubble.
          flushNow();
          activeRef.current = null;
          finalizingRef.current = null;
          setMessages((prev) =>
            prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          );
          break;
        }
      }
    };

    const client = new RelayClient({
      onState: (next, info) => {
        setState(next);
        setAgentOnline(info.agentOnline);
      },
      onFrame,
    });
    clientRef.current = client;
    client.connect();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      client.close();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = input.trim();
    const client = clientRef.current;
    if (!text || !client || !client.send({ t: 'msg', chat: CHAT, text })) return;
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', text }]);
    setInput('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const canSend = state === 'live' && input.trim().length > 0;

  return (
    <div className="app">
      <style>{CSS}</style>
      <header className="top">
        <span className="brand">QwenPaw · WebChannel M0</span>
        <span className="status">
          <i className="dot" style={{ background: DOT[state] }} />
          {state} · {agentOnline ? 'agent online' : 'agent offline'}
        </span>
      </header>

      <main className="list" ref={listRef}>
        {messages.length === 0 && (
          <p className="empty">Say hello — the mock agent streams a reply through the relay.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`row ${m.role}`}>
            <div className="bubble">
              {m.text}
              {m.streaming && <span className="caret" />}
            </div>
          </div>
        ))}
      </main>

      <div className="inputbar">
        <textarea
          rows={1}
          value={input}
          placeholder="Message the mock agent…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button onClick={send} disabled={!canSend}>
          Send
        </button>
      </div>
      <div className="hint">Enter to send · Shift+Enter for newline · chat: {CHAT}</div>
    </div>
  );
}
