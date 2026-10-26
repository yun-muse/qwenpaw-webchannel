# WebChannel frame protocol — v1

Status: draft, M0. Scope: the two WebSocket legs (`container ↔ relay`, `browser ↔ relay`).
Design source: `docs/design.md` §6. The relay pairs sockets and forwards frames verbatim; it does
not interpret business payloads and does not persist message content.

## 1. Envelope

One JSON object per WebSocket **text** message, UTF-8 encoded:

```json
{ "t": "<type>", "id": "<optional>", "...": "type-specific fields" }
```

| field | required | meaning |
|---|---|---|
| `t` | yes | frame type, string |
| `id` | no | opaque correlation id, string; echoed on replies/errors |

- Binary messages are invalid (`E_BADFRAME`).
- Unknown fields MUST be ignored; unknown `t` values SHOULD be ignored (forward compatible).
- Endpoints: `GET /ws/agent` (container, `Authorization: Bearer <agent_token>`) and
  `GET /ws/client` (browser, session credential; local dev accepts anything).
- One agent socket per tenant, many client sockets. Every client receives the same
  agent→client stream (multi-tab broadcast).

## 2. Frame types

### 2.1 container → relay

| `t` | fields | notes |
|---|---|---|
| `hello` | `token?`, `instance`, `agent` | optional after header auth; relay acks with `ready`, frame is not forwarded |
| `ping` | — | answered locally with `pong`, not forwarded |
| `pong` | — | reserved; the relay answers `ping` locally in v1 |

### 2.2 relay → container

| `t` | fields | notes |
|---|---|---|
| `ready` | `agentOnline` | ack of `hello` / attach |
| `peer` | `clients` | connected client count, sent on agent connect and on every client join/leave |
| `error` | `code`, `id?` | protocol error |
| `pong` | — | answer to `ping` |

### 2.3 container → browser (forwarded verbatim)

| `t` | fields | notes |
|---|---|---|
| `start` | `chat`, `seq?` | streaming reply starts; client creates a bubble (optional) |
| `evt` | `chat`, `seq`, `data` | raw event JSON, same shape as the console SSE stream (per-delta) |
| `end` | `chat`, `seq?` | streaming reply finished; render markdown, commit to history (optional) |
| `msg` | `chat`, `seq?`, `parts[]` | complete message, tool result or attachment reference |
| `approval` | `chat`, `req_id`, `tool`, `severity`, `summary` | approval request |
| `resync` | `chat`, `reason?` | ring buffer miss; client must reload history |
| `pong` | — | reserved; the relay answers `ping` locally in v1 |

`parts[]` is a list of content parts. v1 defines `{"type":"text","text":...}` and
`{"type":"file","name","mime","data"}` where `data` is base64. Other part types are forwarded as-is.

### 2.4 browser → container

| `t` | fields | notes |
|---|---|---|
| `msg` | `chat`, `text`, `files[]` | send a message; `files[]` items are `{name, mime, data}` with base64 `data` |
| `stop` | `chat` | cancel the current generation |
| `approve` / `deny` | `chat`, `req_id` | resolve an approval |
| `resume` | `chat`, `last_seq` | replay frames with `seq > last_seq` |
| `hist` | `chat`, `before?`, `limit?` | request history (agent answers with `msg`/`resync` frames) |
| `ping` | — | heartbeat, every 25 s |

`approve`/`deny` MUST carry `req_id`; the container validates that it belongs to the given
`chat`/session before acting (design §8), so a replayed or cross-session `req_id` is rejected.

### 2.5 relay → browser

| `t` | fields | notes |
|---|---|---|
| `ready` | `agentOnline` | sent once on client connect |
| `error` | `code`, `id?` | protocol error |
| `pong` | — | answer to `ping` |

## 3. Handshake

```
container                relay                   browser
    │── ws upgrade ───────▶│                        │
    │   Bearer <token>     │                        │
    │        peer(n)       │                        │
    │◀─────────────────────┤                        │
    │ hello(token) [opt.]  │                        │
    ├─────────────────────▶│                        │
    │        ready         │                        │
    │◀─────────────────────┤                        │
    │                      │◀──── ws /ws/client ────┤
    │                      │──────── ready ────────▶│
    │◀──── peer(n) ────────┤                        │
    │                      │                        │
    │──── evt/msg/... ────▶│──── evt/msg/... ──────▶│
    │◀─── msg/stop/... ────│◀─── msg/stop/... ──────┤
```

- Agent auth happens on the HTTP upgrade (`Authorization: Bearer`); the relay sends `peer` as soon
  as the socket is attached. The `hello` frame is optional metadata in v1: the relay answers
  `ready` and does not forward it. There is no separate login round-trip in local dev.
- In local dev the agent token defaults to `dev-agent-token`; clients are not authenticated.
- After `ready`, either side may send frames immediately. The relay never rewrites payloads.
- `peer` is the only client-presence signal: the agent gets the current `clients` count on connect
  and after each join/leave (`peer-online`/`peer-offline` are folded into this single frame).

## 4. Sequencing, resume, dedupe

- `seq` is assigned by the container, monotonically increasing per `chat`, starting at 0 or 1.
- Clients dedupe by `seq` (drop `seq <= last_seen[chat]`), so redelivery is harmless.
- Container keeps a per-chat ring buffer of 400 frames.
- On reconnect the browser sends `resume{chat,last_seq}`:
  - buffer hit → container replays `seq > last_seq` frames;
  - buffer miss (too old / container restarted) → container sends `resync{chat}`, client reloads
    history from the container API and rebuilds state.
- While the agent is offline the relay buffers client→agent frames (see §5) and flushes them in
  order when the agent reconnects.

## 5. Limits

| limit | value | behaviour |
|---|---|---|
| frame size | **256 KB** (UTF-8 bytes of the serialized JSON) | sender gets `error{code:"E_TOOBIG"}`; frame is dropped |
| rate | **30 frames/s per tenant**, both directions combined | hosted relay may drop/close; `relay-node` local dev does not enforce |
| offline buffer | 500 frames / 1 MB per tenant | oldest frames dropped first |
| ring buffer | 400 frames per chat (container) | `resync` on miss |
| heartbeat | `ping` every 25 s, `pong` expected within 10 s | otherwise reconnect with backoff |

**Files (v1).** Files travel as base64 inside `msg.files[]`, so the *whole frame* must stay
≤ 256 KB. Base64 inflates payloads by 4/3, leaving roughly **180 KB of raw file data** after JSON
overhead. Any file that would push the frame over 256 KB **MUST be rejected with `E_TOOBIG`** in v1
(the browser shows the error instead of sending). There is no chunked file frame in v1: separate
`file` frames / chunked uploads are **v2**. The relay enforces the size limit; the container
re-validates `msg` size.

## 6. Error codes

Error frame: `{"t":"error","code":"...","id":"<offending frame id, if any>"}`.

| code | scenario | handling |
|---|---|---|
| `E_AUTH` | bad/expired agent token or client credential | container stops reconnecting and logs; browser redirects to login |
| `E_BUSY` | a run is already active for this chat | client shows a notice; do not resend |
| `E_TOOBIG` | frame exceeds 256 KB | send smaller message / reject file (v1); chunking is v2 |
| `E_BADFRAME` | not JSON, not an object, missing/non-string `t`, binary message | drop frame; sender may fix and retry |
| `E_RESYNC` | resume buffer miss | client reloads history |

`E_AUTH` is enforced at the HTTP upgrade (401 before the socket opens), so it is normally not seen
as a frame. `E_BADFRAME` is relay-local and never forwarded.

## 7. Versioning

v1 is additive: new optional fields and new `t` values may appear without a version bump. A breaking
change (for example the v2 chunked `file` frame) will be negotiated via a `v` field in `hello` and
announced here.
