/**
 * qwenpaw-webchannel-relay — Cloudflare Worker + Durable Object relay.
 *
 * Port of `relay-node/server.js` to the hosted shape: one Worker that
 * terminates `/api/login` and forwards everything else to the tenant's
 * Durable Object, which pairs one agent socket with many client sockets and
 * forwards frames verbatim (it never parses business payloads).
 *
 * Differences from relay-node, both deliberate:
 *   - `/ws/client` requires a client token from `/api/login` (`?token=`;
 *     browsers cannot set headers on a WebSocket handshake).
 *   - a per-tenant token bucket enforces the 30 frames/s limit from
 *     `protocol/frames.md` §5 (relay-node does not).
 *
 * Socket state is rebuilt from `getWebSockets()` attachments after
 * hibernation; the offline buffer lives in DO storage.
 */
import { DurableObject } from 'cloudflare:workers';

// ---- limits (protocol/frames.md §5) ---------------------------------------

const MAX_FRAME_BYTES = 256 * 1024; // checked ourselves so we can reply
const MAX_BUFFERED_FRAMES = 500;
const MAX_BUFFERED_BYTES = 1024 * 1024;

const RATE_CAPACITY = 30; // burst
const RATE_REFILL_PER_SEC = 30; // steady state
const BUSY_NOTICE_MS = 1000; // at most one E_BUSY per second

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // login token lifetime
const OUTBOX_KEY = 'outbox';
const REPLACED_CODE = 4000;
const REPLACED_REASON = 'replaced by new agent connection';

const encoder = new TextEncoder();

export interface Env {
  RELAY: DurableObjectNamespace;
  TENANT?: string;
  AGENT_TOKEN?: string;
  LOGIN_PASSWORD?: string;
  LOGIN_SECRET?: string;
}

// ---- small helpers --------------------------------------------------------

const byteLength = (text: string): number => encoder.encode(text).length;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

/** Compare secrets without an early exit; length first, as the brief allows. */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url(HMAC-SHA256(secret, message)) via WebCrypto. */
async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64Url(new Uint8Array(signature));
}

/** Mint a client token: `v1.<expires>.<sig>` (expires = Unix seconds). */
async function issueClientToken(
  secret: string,
  nowSeconds: number,
): Promise<{ token: string; expires: number }> {
  const expires = nowSeconds + TOKEN_TTL_SECONDS;
  const payload = `v1.${expires}`;
  return { token: `${payload}.${await sign(secret, payload)}`, expires };
}

/**
 * Validate a client token. Rejects malformed values, expired tokens and
 * signatures that do not match LOGIN_SECRET.
 */
export async function verifyClientToken(
  token: string | null | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!token || !secret) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [version, rawExpires, signature] = parts;
  if (version !== 'v1') return false;
  if (!/^[0-9]{1,12}$/.test(rawExpires)) return false;

  const expires = Number(rawExpires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expires) || expires <= now) return false;

  return equals(signature, await sign(secret, `v1.${rawExpires}`));
}

// ---- Worker ---------------------------------------------------------------

/**
 * `/api/login` is handled here (it needs only secrets, not tenant state);
 * every other route goes to the tenant Durable Object.
 */
async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, CORS_HEADERS);
  }
  const password = body?.password;
  if (typeof password !== 'string') return json({ error: 'bad_request' }, 400, CORS_HEADERS);

  // Both secrets are needed: LOGIN_PASSWORD is the check, LOGIN_SECRET signs.
  if (!env.LOGIN_PASSWORD || !env.LOGIN_SECRET) {
    return json({ error: 'login_not_configured' }, 500, CORS_HEADERS);
  }
  if (!equals(password, env.LOGIN_PASSWORD)) {
    return json({ error: 'bad_password' }, 401, CORS_HEADERS);
  }

  const { token, expires } = await issueClientToken(
    env.LOGIN_SECRET,
    Math.floor(Date.now() / 1000),
  );
  return json({ token, expires }, 200, CORS_HEADERS);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight (the SPA logs in from a different origin).
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      return handleLogin(request, env);
    }

    // One tenant per deployment: every remaining route hits the same DO.
    const stub = env.RELAY.get(env.RELAY.idFromName(env.TENANT || 'main'));
    return stub.fetch(request);
  },
};

// ---- Durable Object -------------------------------------------------------

export class RelayDO extends DurableObject {
  /** Bindings/secrets, kept local so we do not rely on the base class fields. */
  private readonly cfg: Env;

  /** The single container socket (a newer agent replaces it). */
  private agent: WebSocket | null = null;
  /** Every connected browser socket. */
  private clients = new Set<WebSocket>();

  /** Offline buffer: client→agent frames, cached copy of storage["outbox"]. */
  private outbox: string[] = [];
  private outboxBytes = 0;
  private outboxLoaded = false;

  /** Per-tenant token bucket (reset when the object hibernates). */
  private bucket = RATE_CAPACITY;
  private bucketAt = Date.now();
  private lastBusyAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.cfg = env;

    // Rebuild in-memory state before any request/message is delivered.
    this.ctx.blockConcurrencyWhile(async () => {
      // Answer the heartbeat without waking the object when possible.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
      );

      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as { role?: string } | null;
        if (attachment?.role === 'agent') {
          this.agent = socket; // last one wins, same as relay-node
        } else if (attachment?.role === 'client') {
          this.clients.add(socket);
        }
      }
    });
  }

  // ---- routing ------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /health') {
      return json({ ok: true, agentOnline: this.agent !== null, clients: this.clients.size });
    }
    // Deferred: WebSocket is the only transport in v1 (relay-node has no
    // /poll either). See README.
    if (route === 'GET /poll') return json({ error: 'not_implemented' }, 501);
    if (route === 'GET /ws/agent') return this.upgradeAgent(request);
    if (route === 'GET /ws/client') return this.upgradeClient(url);

    return json({ error: 'not_found' }, 404);
  }

  // ---- upgrades -----------------------------------------------------------

  private async upgradeAgent(request: Request): Promise<Response> {
    // No secret configured means no agent is allowed in.
    const secret = this.cfg.AGENT_TOKEN;
    const header = request.headers.get('authorization') || '';
    if (!secret || !equals(header, `Bearer ${secret}`)) {
      return new Response('unauthorized', { status: 401 });
    }

    const [client, server] = this.accept('agent');

    if (this.agent && this.agent !== server) {
      try {
        this.agent.close(REPLACED_CODE, REPLACED_REASON);
      } catch {
        /* already gone; the close handler is a no-op for a stale socket */
      }
    }
    this.agent = server;

    this.sendJson(server, { t: 'peer', clients: this.clients.size });
    await this.flushOutbox();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async upgradeClient(url: URL): Promise<Response> {
    const valid = await verifyClientToken(url.searchParams.get('token'), this.cfg.LOGIN_SECRET);
    if (!valid) return json({ error: 'unauthorized' }, 401);

    const [client, server] = this.accept('client');
    this.clients.add(server);

    this.sendJson(server, { t: 'ready', agentOnline: this.agent !== null });
    this.notifyPeer();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Accept a hibernatable socket and tag it with its role. */
  private accept(role: 'agent' | 'client'): [WebSocket, WebSocket] {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role });
    return [client, server];
  }

  // ---- inbound frames -----------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const role = this.roleOf(ws);
    if (!role) return; // unknown socket: ignore

    // Envelope validation, mirroring relay-node's readFrame().
    if (typeof message !== 'string') return this.sendError(ws, 'E_BADFRAME');
    if (byteLength(message) > MAX_FRAME_BYTES) return this.sendError(ws, 'E_TOOBIG');

    let frame: any;
    try {
      frame = JSON.parse(message);
    } catch {
      return this.sendError(ws, 'E_BADFRAME');
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.t !== 'string') {
      return this.sendError(ws, 'E_BADFRAME', typeof frame?.id === 'string' ? frame.id : undefined);
    }

    // Heartbeats are free: no bucket token, never forwarded.
    if (frame.t === 'ping') {
      return this.sendPong(ws, typeof frame.id === 'string' ? frame.id : undefined);
    }

    // Every other valid frame costs a token (both directions share the bucket).
    if (!this.takeToken()) {
      return this.tooBusy(ws, typeof frame.id === 'string' ? frame.id : undefined);
    }

    if (role === 'agent') {
      if (this.agent === null) this.agent = ws; // re-adopt after a lost wake
      if (frame.t === 'hello') {
        this.sendJson(ws, { t: 'ready', agentOnline: true });
        return;
      }
      this.broadcast(message);
      return;
    }

    // client → agent: forward verbatim, or buffer while the agent is offline.
    if (this.sendText(this.agent, message)) return;
    await this.bufferForAgent(message);
  }

  /** Hibernation close/error: drop the socket from our bookkeeping. */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.forget(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.forget(ws);
  }

  private roleOf(ws: WebSocket): 'agent' | 'client' | null {
    const attachment = ws.deserializeAttachment() as { role?: string } | null;
    if (attachment?.role === 'agent') return 'agent';
    if (attachment?.role === 'client') return 'client';
    // Fallback for sockets adopted without an attachment (should not happen).
    if (ws === this.agent) return 'agent';
    if (this.clients.has(ws)) return 'client';
    return null;
  }

  // ---- send helpers -------------------------------------------------------

  /**
   * Hibernation sockets have no `readyState`; "open" means it is the current
   * agent or a tracked client. Dead sockets are dropped when a send throws.
   */
  private isOpen(ws: WebSocket | null): ws is WebSocket {
    return ws !== null && (ws === this.agent || this.clients.has(ws));
  }

  private sendText(ws: WebSocket | null, text: string): boolean {
    if (!this.isOpen(ws)) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      this.forget(ws);
      return false;
    }
  }

  private sendJson(ws: WebSocket | null, obj: unknown): boolean {
    return this.sendText(ws, JSON.stringify(obj));
  }

  private sendError(ws: WebSocket, code: string, id?: string): void {
    this.sendJson(ws, id === undefined ? { t: 'error', code } : { t: 'error', code, id });
  }

  private sendPong(ws: WebSocket, id?: string): void {
    this.sendJson(ws, id === undefined ? { t: 'pong' } : { t: 'pong', id });
  }

  private notifyPeer(): void {
    this.sendJson(this.agent, { t: 'peer', clients: this.clients.size });
  }

  private broadcast(text: string): void {
    for (const client of Array.from(this.clients)) this.sendText(client, text);
  }

  /** Remove a dead/closed socket. Clients notify the agent; the agent does not. */
  private forget(ws: WebSocket): void {
    if (ws === this.agent) {
      this.agent = null;
      return;
    }
    if (this.clients.delete(ws)) this.notifyPeer();
  }

  // ---- rate limiting ------------------------------------------------------

  private takeToken(): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.bucketAt) / 1000;
    this.bucketAt = now;
    this.bucket = Math.min(RATE_CAPACITY, this.bucket + elapsed * RATE_REFILL_PER_SEC);

    if (this.bucket < 1) return false;
    this.bucket -= 1;
    return true;
  }

  /** Tell the sender it is over budget, at most once per second. */
  private tooBusy(ws: WebSocket, id?: string): void {
    const now = Date.now();
    if (now - this.lastBusyAt < BUSY_NOTICE_MS) return;
    this.lastBusyAt = now;
    this.sendError(ws, 'E_BUSY', id);
  }

  // ---- offline buffer -----------------------------------------------------

  private async loadOutbox(): Promise<void> {
    if (this.outboxLoaded) return;
    const stored = await this.ctx.storage.get<string[]>(OUTBOX_KEY);
    this.outbox = Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string') : [];
    this.outboxBytes = this.outbox.reduce((sum, entry) => sum + byteLength(entry), 0);
    this.outboxLoaded = true;
  }

  private async persistOutbox(): Promise<void> {
    if (this.outbox.length === 0) {
      await this.ctx.storage.delete(OUTBOX_KEY);
      return;
    }
    await this.ctx.storage.put(OUTBOX_KEY, this.outbox);
  }

  private async bufferForAgent(text: string): Promise<void> {
    await this.loadOutbox();

    this.outbox.push(text);
    this.outboxBytes += byteLength(text);

    // Drop oldest frames while over either limit.
    while (this.outbox.length > MAX_BUFFERED_FRAMES || this.outboxBytes > MAX_BUFFERED_BYTES) {
      const dropped = this.outbox.shift() as string;
      this.outboxBytes -= byteLength(dropped);
    }

    await this.persistOutbox();
  }

  /** Flush buffered frames in order on agent attach, then clear storage. */
  private async flushOutbox(): Promise<void> {
    await this.loadOutbox();
    if (this.outbox.length === 0) return;

    let sent = 0;
    while (sent < this.outbox.length && this.sendText(this.agent, this.outbox[sent])) {
      sent += 1;
    }
    if (sent === 0) return;

    this.outbox = this.outbox.slice(sent);
    this.outboxBytes = this.outbox.reduce((sum, entry) => sum + byteLength(entry), 0);
    await this.persistOutbox();
  }
}
