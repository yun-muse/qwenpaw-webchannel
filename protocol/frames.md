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
| `hello` | `token?`, `instance`, `agent`, `session`, `started` | first frame after the upgrade; wins the agent slot by generation (see §3); relay acks with `ready`, frame is not forwarded |
| `ping` | — | answered locally with `pong`, not forwarded |
| `pong` | — | reserved; the relay answers `ping` locally in v1 |

### 2.2 relay → container

| `t` | fields | notes |
|---|---|---|
| `ready` | `agentOnline` | ack of `hello` / attach |
| `peer` | `clients` | connected client count, sent when an agent's hello wins the slot and on every client join/leave |
| `error` | `code`, `id?` | protocol error |
| `pong` | — | answer to `ping` |

### 2.3 container → browser (forwarded verbatim)

| `t` | fields | notes |
|---|---|---|
| `start` | `chat`, `seq?`, `stream_type?` | streaming segment starts; client creates a bubble (optional) |
| `evt` | `chat`, `seq`, `data` | `{"text": <delta>, "stream_type": <segment>}`; per-delta |
| `end` | `chat`, `seq?`, `stream_type?` | streaming segment finished; render markdown, commit to history (optional) |
| `msg` | `chat`, `seq?`, `parts[]` | complete message, tool result or attachment reference |
| `approval` | `chat`, `req_id`, `tool`, `severity`, `summary` | approval request |
| `resync` | `chat`, `reason?` | ring buffer miss; client must reload history |
| `models` | `items:[{provider, model, active}]` | **v3** reply to a `models` request; exactly one item has `active:true` when the agent's current (effective) model is known |
| `model_changed` | `provider`, `model` | **v3** a `set_model` succeeded; this pair is now the agent's active model |
| `status` | `agent_name`, `provider?`, `model?` | **v3** identity push, sent when the agent attaches and whenever a client joins/leaves; the header displays it |
| `file_ready` | `chat`, `id`, `seq?` | **v2** chunked upload verified and staged; `files[]` may now use `{"ref": id}` |
| `file_error` | `chat`, `id`, `code`, `msg?`, `seq?` | **v2** chunked upload failed; `code` ∈ `E_CHECKSUM` / `E_TOOBIG` / `E_STATE` |
| `pong` | — | reserved; the relay answers `ping` locally in v1 |

`parts[]` is a list of content parts. v1 defines `{"type":"text","text":...}` and
`{"type":"file","name","mime","data"}` where `data` is base64. Other part types are forwarded as-is.

A streaming reply has up to two segments, labelled by `stream_type` ∈ `{"reasoning","message"}`:
`evt.data.stream_type` says which segment a delta belongs to, and `start`/`end` carry the segment's
`stream_type` at the top level. Only `message` deltas form the answer; `reasoning` deltas are the
model's thinking and MUST NOT be concatenated into it. A reply is streaming until the `message`
segment's `end` — an `end` for `reasoning` closes that segment only. Missing `stream_type` means
`message` (older containers).

`models`, `model_changed` and `status` are **control frames**: they carry no `seq`, belong to no
chat's stream, and are never ring-buffered or replayed on `resume` (§9.4).

### 2.4 browser → container

| `t` | fields | notes |
|---|---|---|
| `msg` | `chat`, `text`, `files[]` | send a message; `files[]` items are `{name, mime, data}` with base64 `data` |
| `stop` | `chat` | cancel the current generation |
| `approve` / `deny` | `chat`, `req_id` | resolve an approval |
| `resume` | `chat`, `last_seq` | replay frames with `seq > last_seq` |
| `hist` | `chat`, `before?`, `limit?` | request history (agent answers with `msg`/`resync` frames) |
| `models` | — | **v3** request the agent's switchable model list |
| `set_model` | `provider`, `model` | **v3** switch the agent's active model |
| `file_begin` | `chat`, `id`, `name`, `mime`, `size`, `chunks`, `sha256` | **v2** start a chunked upload; `chunks` is how many `file_chunk` frames follow |
| `file_chunk` | `chat`, `id`, `i`, `data` | **v2** one chunk; `i` is 0-based, `data` is base64 of ≤96 KB raw bytes |
| `file_end` | `chat`, `id` | **v2** client finished sending; agent answers `file_ready` or `file_error` |
| `ping` | — | heartbeat, every 25 s |

`approve`/`deny` MUST carry `req_id`; the container validates that it belongs to the given
`chat`/session before acting (design §8), so a replayed or cross-session `req_id` is rejected.

`msg.files[]` items are `{name, mime, data}` (v1 inline, base64 `data`) or, after a `file_ready`,
`{"ref": "<id>"}` (v2) referring to a file staged by a chunked upload. See §8.

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
    │ hello(session,started)│                        │
    ├─────────────────────▶│                        │
    │        peer(n)       │                        │
    │◀─────────────────────┤                        │
    │        ready         │                        │
    │◀─────────────────────┤                        │
    │                      │◀──── ws /ws/client ────┤
    │                      │──────── ready ────────▶│
    │◀──── peer(n) ────────┤                        │
    │                      │                        │
    │──── evt/msg/... ────▶│──── evt/msg/... ──────▶│
    │◀─── msg/stop/... ────│◀─── msg/stop/... ──────┤
```

- Agent auth happens on the HTTP upgrade (`Authorization: Bearer`). The socket is then *parked*:
  the single agent slot is won by the `hello` frame, by generation. `started` is the client
  instance's construction time (wall-clock microseconds) and `session` its per-instance id.
  A hello whose `started` is older than the current holder's is *superseded*: the relay closes
  that socket with code 4000 and the holder is not disturbed. A newer-or-equal hello takes the
  slot, closing the previous socket with code 4000 ("replaced by new agent connection"); the
  relay then sends `peer`, flushes the offline buffer, and answers `ready`. A client whose
  socket was closed with 4000 has been superseded by a newer instance and MUST NOT reconnect.
  Legacy hellos without `started` count as generation 0. There is no separate login round-trip
  in local dev.
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
| file size | inline `msg.files[]` data stays bound by the **256 KB frame** rule; a **chunked** (v2, §8) file may be up to **10 MB** | declared or accumulated size above 10 MB → `file_error{code:"E_TOOBIG"}`; the transfer is dropped |
| rate | **30 frames/s per tenant**, both directions combined | hosted relay may drop/close; `relay-node` local dev does not enforce |
| offline buffer | 500 frames / 1 MB per tenant | oldest frames dropped first |
| ring buffer | 400 frames per chat (container) | `resync` on miss |
| heartbeat | `ping` every 25 s, `pong` expected within 10 s | otherwise reconnect with backoff |

**Files (v1).** Files travel as base64 inside `msg.files[]`, so the *whole frame* must stay
≤ 256 KB. Base64 inflates payloads by 4/3, leaving roughly **180 KB of raw file data** after JSON
overhead. Any file that would push the frame over 256 KB **MUST be rejected with `E_TOOBIG`** in v1
(the browser shows the error instead of sending). Separate `file` frames / chunked uploads are
**v2** (§8): there a file may be up to 10 MB. The relay enforces the size limit; the container
re-validates `msg` size.

## 6. Error codes

Error frame: `{"t":"error","code":"...","id":"<offending frame id, if any>"}`.

| code | scenario | handling |
|---|---|---|
| `E_AUTH` | bad/expired agent token or client credential | container stops reconnecting and logs; browser redirects to login |
| `E_BUSY` | a run is already active for this chat | client shows a notice; do not resend |
| `E_TOOBIG` | frame exceeds 256 KB | send smaller message / reject file (v1); use a chunked v2 upload (§8) for larger files |
| `E_BADFRAME` | not JSON, not an object, missing/non-string `t`, binary message | drop frame; sender may fix and retry |
| `E_RESYNC` | resume buffer miss | client reloads history |
| `E_MODEL` | model list unavailable, unknown provider/model, or the app rejected the switch | client shows the error; the connection is unaffected |

`E_AUTH` is enforced at the HTTP upgrade (401 before the socket opens), so it is normally not seen
as a frame. `E_BADFRAME` is relay-local and never forwarded. `E_CHECKSUM` and `E_STATE` (§8) are
file-transfer codes and appear only in `file_error`, never in a generic `error` frame.

## 7. Versioning

v1 is additive: new optional fields and new `t` values may appear without a version bump. A breaking
change (for example a different envelope) will be negotiated via a `v` field in `hello` and announced
here.

**v2 (chunked file transfer, §8) is additive — there is no negotiation.** It introduces only new
`t` values (`file_begin`, `file_chunk`, `file_end`, `file_ready`, `file_error`) and the optional
`{"ref": id}` form of `msg.files[]`, all covered by the "unknown `t` values SHOULD be ignored"
rule in §1. An endpoint that does not know these frames simply ignores them — which means a client
that sent `file_begin` to a **v1 container** gets no `file_ready` and must **time out** (then fall
back to a v1 inline `msg` if the file is small enough, or report the failure); it must not wait
forever. The same applies in reverse: a v1 browser ignores `file_ready`/`file_error` frames.

## 8. Protocol v2 — chunked file transfer

Lets the browser send one file of up to **10 MB** without ever exceeding the 256 KB frame limit.
The relay needs **no changes**: chunks are ordinary frames it forwards verbatim.

### 8.1 Wire format

Client → agent:

```json
{"t":"file_begin","chat":"…","id":"u1","name":"report.pdf","mime":"application/pdf",
 "size":1834210,"chunks":20,"sha256":"<64 lowercase hex chars>"}
{"t":"file_chunk","chat":"…","id":"u1","i":0,"data":"<base64 of ≤96 KB raw bytes>"}
{"t":"file_chunk","chat":"…","id":"u1","i":1,"data":"…"}
{"t":"file_end","chat":"…","id":"u1"}
```

- **96 KB of raw bytes** per `file_chunk` (base64 in `data`, ~128 KB on the wire — inside the frame
  limit). `i` is 0-based and must be `< chunks`.
- `size` is the exact raw byte length, `chunks` the number of `file_chunk` frames that will follow,
  `sha256` the lowercase hex digest of the raw file bytes.
- Max file size **10 MB**, enforced by both ends (`size` at `file_begin`, and the accumulated chunk
  bytes during the transfer).
- Chunks may arrive out of order; the container assembles by index. A repeated index overwrites
  (last wins) — the sha256 check is the arbiter.

Agent → client:

```json
{"t":"file_ready","chat":"…","id":"u1"}
{"t":"file_error","chat":"…","id":"u1","code":"E_CHECKSUM","msg":"file checksum mismatch…"}
```

| `code` | meaning |
|---|---|
| `E_CHECKSUM` | sha256 or size mismatch — including missing chunks seen at `file_end` |
| `E_TOOBIG` | declared `size` or the accumulated chunk bytes exceed 10 MB |
| `E_STATE` | `file_chunk`/`file_end` without `file_begin`, expired or already-dropped transfer, malformed frame (bad index, invalid base64, missing/invalid `id`) |

A successful `file_begin` / `file_chunk` produces **no reply**; only `file_end` is acknowledged
(with exactly one `file_ready` or `file_error`). After `file_ready` the client sends the actual
message and references the staged file:

```json
{"t":"msg","chat":"…","text":"see attached","files":[{"ref":"u1"}]}
```

`files[]` entries may mix v1 inline `{name, mime, data}` items and v2 `{ref}` items.

### 8.2 Staging

- Refs are **one-shot**: the container consumes the staged file when the `msg` uses it. A second
  `msg` with the same ref is dropped (the container logs it and skips that entry).
- Staged files and half-received transfers **expire after 10 minutes**. An expired transfer is
  treated as absent (`E_STATE` on a late chunk/end, silent skip on a late ref).
- A new `file_begin` with an id that already exists restarts that transfer from scratch; that is
  what makes a whole-file retry with the same id legal.

### 8.3 Pacing and retries

The hosted relay enforces **30 frames/s per tenant** (§5) in both directions combined, so a client
sending chunks must **pace** them (~40 ms between `file_chunk` frames, and leave room for other
traffic). A 10 MB file is ~107 chunks, i.e. roughly 4–5 s of paced sends.

On `file_error{code:"E_CHECKSUM"}` the client **retries the whole file once** — same `id`, a new
`file_begin` followed by every chunk again. A second failure is reported to the user; there is no
per-chunk retransmit protocol.

## 9. Protocol v3 — model listing and switching

Lets the browser list the models the bound agent can switch to and change the agent's active model.
The relay needs **no changes**: these are ordinary frames it forwards verbatim. Each plugin instance
serves one agent workspace, so the list is that agent's own view.

### 9.1 Wire format

Client → agent:

```json
{"t":"models"}
{"t":"set_model","provider":"openai","model":"gpt-4o-mini"}
```

Agent → client:

```json
{"t":"models","items":[{"provider":"openai","model":"gpt-4o","active":true},
                       {"provider":"openai","model":"gpt-4o-mini","active":false}]}
{"t":"model_changed","provider":"openai","model":"gpt-4o-mini"}
{"t":"status","agent_name":"Research","provider":"openai","model":"gpt-4o-mini"}
{"t":"error","code":"E_MODEL","detail":"unknown model: openai/does-not-exist"}
```

- `items[]` carries **only** `{provider, model, active}`. Exactly one item is `active:true` when the
  agent's current (effective) model is known; when that model is not in the list it is inserted as an
  extra active item, so the header always has something to display.
- `status` is the identity push: `agent_name`, plus `provider` / `model` when the active model is
  known. It is sent when the agent attaches and whenever a client joins or leaves.
- `set_model` is answered with exactly one of `model_changed` (success, including switching to the
  model that is already active) or `error{code:"E_MODEL"}`.

### 9.2 Eligibility mirror

The agent mirrors the console's model selector: a provider is listed only when it is enabled and
usable (`hub-managed` and free-tier providers always; others need models plus configured credentials
for their kind — a `base_url` for custom providers, an API key when one is required). The plugin
projects each raw provider object down to `{provider, model, active}`; **credential material
(`api_key`) and every other provider field never cross the wire.** Clients treat the list as
authoritative and never fetch provider data themselves.

### 9.3 Validate before switching

`set_model` is validated against the pair set the client was just offered **before** anything is
written: a missing `provider`/`model`, or a pair that is not listed, is `E_MODEL` and no switch is
attempted. The app validates the slot again and may still reject it (unknown model, unavailable
model); that rejection is reported as `E_MODEL` carrying the app's `detail`, and the connection stays
up. Switching to the pair that is already active is a no-op that still answers `model_changed`, so
clients need no special case.

### 9.4 Control frames

`models` / `model_changed` / `status` are **control frames** — they are sent **without `seq`**, are
not part of any chat's stream, and are not ring-buffered or replayed on `resume`. A client that
reconnects must request `models` again (or wait for the `status` push) rather than expect these frames
in the replay.

