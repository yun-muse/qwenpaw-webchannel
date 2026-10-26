/**
 * Relay WebSocket client — design §5.3 state machine:
 *   idle -> connecting -> live -> resuming -> resync
 *
 * Reconnects with exponential backoff, resumes known chats with
 * `{t:"resume", chat, last_seq}`, and drops already-seen seq values.
 */

export type ConnState = 'idle' | 'connecting' | 'live' | 'resuming' | 'resync';

export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface Frame {
  t: string;
  chat?: string;
  seq?: number;
  data?: unknown;
  parts?: ContentPart[];
  agentOnline?: boolean;
  code?: string;
  [key: string]: unknown;
}

export interface RelayOptions {
  url?: string;
  onFrame?: (frame: Frame) => void;
  onState?: (state: ConnState, info: { agentOnline: boolean }) => void;
  /** Called on `resync`; reload history here. Returns to `live` when it settles. */
  onResync?: (chat: string) => void | Promise<void>;
}

const DEFAULT_URL = 'ws://127.0.0.1:8787/ws/client';
const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 8_000;

export class RelayClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private state: ConnState = 'idle';
  private agentOnline = false;
  private everOpen = false;
  private manualClose = false;
  private attempts = 0;
  private readonly lastSeq = new Map<string, number>();
  private readonly chats = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: RelayOptions = {}) {
    this.url = opts.url ?? DEFAULT_URL;
  }

  getState(): ConnState {
    return this.state;
  }

  getLastSeq(chat: string): number {
    return this.lastSeq.get(chat) ?? 0;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manualClose = false;
    this.setState(this.everOpen ? 'resuming' : 'connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      if (this.everOpen) this.resumeAll();
      this.everOpen = true;
      this.startHeartbeat();
      this.setState('live');
    };
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      /* 'close' always follows */
    };
  }

  /** Send a frame; returns false when the socket is not open. */
  send(frame: Frame): boolean {
    if (frame.chat) this.chats.add(frame.chat);
    return this.raw(frame);
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.agentOnline = false;
    this.setState('idle');
  }

  private raw(frame: Frame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private resumeAll(): void {
    for (const chat of this.chats) {
      const last = this.lastSeq.get(chat) ?? 0;
      if (last > 0) this.raw({ t: 'resume', chat, last_seq: last });
    }
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (!frame || typeof frame.t !== 'string') return;

    if (frame.t === 'pong') {
      this.clearPongTimer();
      return;
    }
    if (frame.t === 'ready') {
      this.agentOnline = frame.agentOnline === true;
      this.emitState();
      return;
    }
    if (frame.t === 'error') {
      this.handleError(frame);
      return;
    }

    if (frame.chat) this.chats.add(frame.chat);

    // Dedupe per chat: redelivered frames after resume are harmless.
    if (frame.chat && typeof frame.seq === 'number') {
      const seen = this.lastSeq.get(frame.chat) ?? 0;
      if (frame.seq <= seen) return;
      this.lastSeq.set(frame.chat, frame.seq);
    }

    if (frame.t === 'resync' && frame.chat) {
      this.setState('resync');
      Promise.resolve(this.opts.onResync?.(frame.chat))
        .catch(() => undefined)
        .finally(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.setState('live');
        });
    }

    this.opts.onFrame?.(frame);
  }

  private handleError(frame: Frame): void {
    if (frame.code === 'E_AUTH') {
      // Bad credential: stop reconnecting (protocol §6).
      this.manualClose = true;
      this.stopHeartbeat();
      this.ws?.close();
      this.setState('idle');
      return;
    }
    if (frame.code === 'E_RESYNC' && frame.chat) {
      this.receive(JSON.stringify({ t: 'resync', chat: frame.chat }));
      return;
    }
    console.warn('[relay] error frame', frame);
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopHeartbeat();
    this.agentOnline = false;
    if (this.manualClose) {
      this.setState('idle');
      return;
    }
    this.setState(this.everOpen ? 'resuming' : 'connecting');
    const delay = Math.min(500 * 2 ** this.attempts++, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.raw({ t: 'ping' })) return;
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => this.ws?.close(), PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private setState(state: ConnState): void {
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.opts.onState?.(this.state, { agentOnline: this.agentOnline });
  }
}
