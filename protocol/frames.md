# WebChannel frame protocol — v11

Status: current (envelope v1 plus additive revisions v2–v11; §17 documents the never-numbered M8
frames that were previously implemented but unwritten). Scope: the two WebSocket legs
(`container ↔ relay`, `browser ↔ relay`).
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
| `hb` | `id` | **v3** end-to-end heartbeat (M7.3); the relay process echoes `hb_ack` with the same `id`. Never forwarded, never stamps `agentLastSeen`, exempt from the rate limit |
| `ping` | — | answered locally with `pong`, not forwarded |
| `pong` | `id?` | answer to `ping`; echoes the request's `id` when present |

### 2.2 relay → container

| `t` | fields | notes |
|---|---|---|
| `ready` | `agentOnline` | ack of `hello` / attach |
| `peer` | `clients` | connected client count, sent when an agent's hello wins the slot and on every client join/leave |
| `error` | `code`, `id?` | protocol error |
| `hb_ack` | `id` | **v3** echoed answer to `hb`; produced by the relay process itself, never by the edge |
| `pong` | `id?` | answer to `ping`; the request's `id` is echoed when present |

**Why `hb` exists (v3).** `ping`/`pong` and WebSocket-level ping frames are answered *at the edge*:
the hosted relay's `ping` is served by `setWebSocketAutoResponse` without waking the Durable
Object, and Cloudflare also answers protocol pings in its WebSocket front end. Neither ever
reaches the container's tunnel, so a half-open agent ↔ relay path looks perfectly healthy from
both ends — pings keep being answered while no business frame can pass. `hb` is handled by the
relay process itself, so its ack is real end-to-end evidence. The container sends it every 15 s,
expects `hb_ack` within 10 s, and reconnects after 2 consecutive missed beats. `hb` is **not** a
business frame: it is never forwarded to clients, does not update `agentLastSeen`, and (hosted
relay) consumes no rate-limit token. A socket that does not own the agent slot (parked or
superseded generation) is not acked.

### 2.3 container → browser (forwarded verbatim)

| `t` | fields | notes |
|---|---|---|
| `start` | `chat`, `seq?`, `stream_type?` | streaming segment starts; client creates a bubble (optional) |
| `evt` | `chat`, `seq`, `data` | `{"text": <delta>, "stream_type": <segment>}`; per-delta |
| `end` | `chat`, `seq?`, `stream_type?` | streaming segment finished; render markdown, commit to history (optional) |
| `msg` | `chat`, `seq?`, `parts[]` | complete message, tool result or attachment reference |
| `approval` | `chat`, `req_id`, `tool`, `severity`, `summary`, `seq?` | approval request; it is emitted through the sequencer, so a replayed/resumed frame keeps its number |
| `resync` | `chat`, `reason?`, `seq?` | ring buffer miss; client must reload history |
| `error` | `code`, `id?`, `chat?`, `req_id?`, `detail?`, `status?`, `reason?`, `seq?` | protocol/domain error (§6); `chat` (and `req_id` for approvals) marks it request-scoped — only `E_AUTH` **without** either is connection-fatal. Almost all errors are control frames; the approval refusal is emitted through the sequencer and carries `seq` |
| `hist` | `chat`, `messages:[{role, text, files?, turn?}]`, `more?`, `seq?` | reply to a `hist` request; `more:true` means another `hist` frame follows; `turn` is the **v8** optional per-turn usage receipt (§11.2); `files` is the **v10** optional attachment list (§15.3) |
| `chats` | `items:[{chat, title, updated_at}]` | **M8** chat list, reply to a `chats` request (§17.1); control frame |
| `chat_deleted` | `chat` | **M8** acknowledgement of `del_chat` (§17.2); control frame |
| `chat_renamed` | `chat`, `title` | **M8** acknowledgement of `rename_chat` (§17.3); the title is a client display label, not a server-side rename; control frame |
| `prompts` | `files:{SOUL.md, AGENTS.md, PROFILE.md, MEMORY.md}` | **M8** the workspace prompt files, each a string (§17.4); control frame |
| `prompt_saved` | `file` | **M8** one prompt file was written (§17.4); control frame |
| `skills` | `items:[{id, name, description}]` | **M8** available skills, reply to `skills` (§17.5); control frame |
| `models` | `items:[{provider, model, active, vision?}]` | **v3** reply to a `models` request; exactly one item has `active:true` when the agent's current (effective) model is known; `vision` is the **v10** optional boolean picture capability (omitted when unprobed, §15.4) |
| `model_changed` | `provider`, `model` | **v3** a `set_model` succeeded; this pair is now the agent's active model |
| `status` | `agent_name`, `provider?`, `model?` | **v3** identity push, sent when the agent attaches and whenever a client joins/leaves; the header displays it. The relay reuses the same `t` for **v11** presence by adding `agentOnline` (and no `agent_name`) — see §16 |
| `effort` | `chat`, `level`, `effective`, `budget_tokens?`, `supported?`, `kind?`, `model_key?` | **v4** session thinking state: reply to `get_effort` / `set_effort`; control frame |
| `usage` | `chat`, `id?`, `input_total?`, `output_total?`, `context_tokens?`, `context_limit?`, `last_turn?` | **v5**/**v8** session token usage: reply to `get_usage`; every numeric field is optional (absent = unknown); `last_turn` is the newest turn's receipt (§11.2); control frame |
| `stats` | `id?`, `totals`, `days`, `chats`, `covered_chats?`, `uncovered_chats?`, `undated_turns?`, `day_basis`, `day_tz?` | **v9** all-chats usage dashboard: reply to `get_stats`; every count is optional except `totals.turns`; control frame (§14) |
| `export_begin` | `chat`, `id`, `bytes`, `chunks`, `sha256` | **v6** export snapshot: whole-document UTF-8 byte length, chunk count, lower-case hex digest; control frame |
| `export_chunk` | `chat`, `id`, `i`, `data` | **v6** one export chunk; `i` is 0-based, `data` is base64 of ≤96 KB raw bytes; control frame |
| `export_end` | `chat`, `id` | **v6** all export chunks sent; the client verifies and saves; control frame |
| `search_results` | `id`, `q`, `items:[{chat, title, role, snippet, match_start, match_len, ts}]`, `total` | **v7** archive full-text search reply to `search`; control frame |
| `att_begin` | `chat`, `id`, `bytes`, `chunks`, `sha256`, `name`, `mime?` | **v10** attachment snapshot: exact byte length, chunk count, lower-case hex digest, bare display name; control frame (§15.2) |
| `att_chunk` | `chat`, `id`, `i`, `data` | **v10** one attachment chunk; `i` is 0-based, `data` is base64 of ≤96 KB raw bytes; control frame |
| `att_end` | `chat`, `id` | **v10** all attachment chunks sent; the client verifies before rendering/saving; control frame |
| `file_ready` | `chat`, `id`, `seq?` | **v2** chunked upload verified and staged; `files[]` may now use `{"ref": id}` |
| `file_error` | `chat`, `id`, `code`, `msg?`, `seq?` | **v2** chunked upload failed; `code` ∈ `E_CHECKSUM` / `E_TOOBIG` / `E_STATE` |

`parts[]` is a list of content parts. v1 defines `{"type":"text","text":...}` and
`{"type":"file","name","mime","data"}` where `data` is base64. Other part types are forwarded as-is.

A streaming reply has up to two segments, labelled by `stream_type` ∈ `{"reasoning","message"}`:
`evt.data.stream_type` says which segment a delta belongs to, and `start`/`end` carry the segment's
`stream_type` at the top level. Only `message` deltas form the answer; `reasoning` deltas are the
model's thinking and MUST NOT be concatenated into it. A reply is streaming until the `message`
segment's `end` — an `end` for `reasoning` closes that segment only. Missing `stream_type` means
`message` (older containers).

`models`, `model_changed`, `status`, `effort`, `usage`, `stats`, the `export_*` frames,
`search_results`, the `att_*` frames and the M8 chat/prompt/skill frames (`chats`, `chat_deleted`,
`chat_renamed`, `prompts`, `prompt_saved`, `skills`) are **control frames**: they carry no `seq`,
belong to no chat's stream, and are never ring-buffered or replayed on `resume` (§9.4, §10.3,
§11.3, §12.4, §13.4, §14.4, §15.2, §17). `error` is a control frame too, except the sequenced
approval refusal (`E_AUTH` with `chat` + `req_id` + `seq`, §6).

### 2.4 browser → container

| `t` | fields | notes |
|---|---|---|
| `msg` | `chat`, `text`, `files[]` | send a message; `files[]` items are `{name, mime, data}` with base64 `data` |
| `stop` | `chat` | cancel the current generation |
| `approve` / `deny` | `chat`, `req_id` | resolve an approval |
| `resume` | `chat`, `last_seq` | replay frames with `seq > last_seq` |
| `hist` | `chat`, `limit?` | request history (agent answers with `hist` frame(s)); `limit` is a positive integer, anything else falls back to 50 |
| `chats` | — | **M8** request the server-side chat list (§17.1); answered with `chats` |
| `del_chat` | `chat` | **M8** delete the chat's QwenPaw `ChatSpec`; answered with `chat_deleted` (§17.2) |
| `rename_chat` | `chat`, `title` | **M8** change the browser's display name; answered with `chat_renamed` (§17.3) |
| `get_prompts` | — | **M8** read the four workspace prompt files; answered with `prompts` (§17.4) |
| `set_prompt` | `file`, `content` | **M8** write one prompt file (`SOUL.md` / `AGENTS.md` / `PROFILE.md` / `MEMORY.md`, ≤65536 UTF-8 bytes); answered with `prompt_saved` or `error{code:"E_PROMPT"}` (§17.4) |
| `skills` | — | **M8** request the agent's skill list (§17.5); answered with `skills` |
| `models` | — | **v3** request the agent's switchable model list |
| `set_model` | `provider`, `model` | **v3** switch the agent's active model |
| `get_effort` | `chat` | **v4** request that chat's session thinking setting |
| `set_effort` | `chat`, `level` | **v4** set that chat's thinking level (`default` clears the override) |
| `get_usage` | `chat`, `id?` | **v5** request that chat's cumulative token usage and current context approximation |
| `get_stats` | `id?` | **v9** request the all-chats usage dashboard (§14) |
| `export` | `chat`, `id` | **v6** request a Markdown export of that chat; answered with `export_begin` / `export_chunk` / `export_end` |
| `search` | `id`, `q`, `limit?` | **v7** full-text search over the archive; answered with `search_results` or `error{code:"E_SEARCH"}` |
| `att_get` | `chat`, `id`, `ref` | **v10** fetch one history attachment by its opaque plugin-issued `ref`; answered with `att_begin` / `att_chunk` / `att_end` or `error{code:"E_ATT"}` |
| `file_begin` | `chat`, `id`, `name`, `mime`, `size`, `chunks`, `sha256` | **v2** start a chunked upload; `chunks` is how many `file_chunk` frames follow |
| `file_chunk` | `chat`, `id`, `i`, `data` | **v2** one chunk; `i` is 0-based, `data` is base64 of ≤96 KB raw bytes |
| `file_end` | `chat`, `id` | **v2** client finished sending; agent answers `file_ready` or `file_error` |

`ping` is **not** in this table: the relay answers it itself and never forwards it to the
container (§2.6). `hb` from a browser is dropped the same way.

`approve`/`deny` MUST carry `req_id`; the container validates that it belongs to the given
`chat`/session before acting (design §8), so a replayed or cross-session `req_id` is rejected.

`msg.files[]` items are `{name, mime, data}` (v1 inline, base64 `data`) or, after a `file_ready`,
`{"ref": "<id>"}` (v2) referring to a file staged by a chunked upload. Since **v10** a `ref` item
also carries the metadata the browser already knows -- `{"ref", "name", "mime", "size"}` -- so the
archive keeps the file name even after the staged record expires (§15.6). See §8.

### 2.5 relay → browser

| `t` | fields | notes |
|---|---|---|
| `ready` | `agentOnline` | sent once on client connect |
| `status` | `agentOnline` | **v11** presence edge: `true` after a winning `hello`, `false` when the slot holder goes away; broadcast to every client, no `seq`, never replayed (§16) |
| `error` | `code`, `id?` | protocol error |
| `pong` | `id?` | answer to `ping`; echoes the request's `id` when present |

`status` has two producers with disjoint fields: the plugin's identity push (`agent_name`, optional
`provider` / `model`) and the relay's presence edge (`agentOnline`). See §16.

### 2.6 browser → relay (answered locally)

| `t` | fields | notes |
|---|---|---|
| `ping` | `id?` | client heartbeat every 25 s; the relay answers `pong` with the same `id` and never forwards it |
| `hb` | `id` | agent-side liveness only; a browser `hb` is dropped, never forwarded |

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
| end-to-end heartbeat (v3) | `hb` every 15 s, `hb_ack` expected within 10 s, 2 consecutive missed beats | container closes and reconnects with backoff |

**Files (v1).** Files travel as base64 inside `msg.files[]`, so the *whole frame* must stay
≤ 256 KB. Base64 inflates payloads by 4/3, leaving roughly **180 KB of raw file data** after JSON
overhead. Any file that would push the frame over 256 KB **MUST be rejected with `E_TOOBIG`** in v1
(the browser shows the error instead of sending). Separate `file` frames / chunked uploads are
**v2** (§8): there a file may be up to 10 MB. The relay enforces the size limit; the container
re-validates `msg` size.

## 6. Error codes

Error frame:

```json
{"t":"error","code":"E_MODEL","id":"<offending frame id>","chat":"…","req_id":"…",
 "detail":"…","status":422,"reason":"bad_query"}
```

Only `t` and `code` are always present. `id` echoes the request's envelope id; `chat` (and, for
approvals, `req_id`) makes the error request-scoped; `detail` is a human-readable explanation;
`status` is the local app's HTTP status when there was one; `reason` is the machine-readable
variant used by search (§13.2).

| code | scenario | handling |
|---|---|---|
| `E_AUTH` | bad/expired agent token or client credential; **also** the plugin refusing an `approve`/`deny` | connection-level (no `chat`/`req_id`): container stops reconnecting and logs, browser redirects to login. Request-scoped (`chat` + `req_id` present): the approval card shows the error and the socket stays up |
| `E_BUSY` | the hosted relay's 30 frames/s tenant bucket is empty | the offending frame is dropped; at most one notice per second. Slow down and resend deliberately — it is **not** a delivery receipt (§5) |
| `E_TOOBIG` | frame exceeds 256 KB, or an export/attachment exceeds 10 MB (§12) | send smaller message / reject file (v1); use a chunked v2 upload (§8) for larger files |
| `E_BADFRAME` | not JSON, not an object, missing/non-string `t`, binary message | drop frame; sender may fix and retry |
| `E_RESYNC` | legacy alias for a resume buffer miss | the plugin sends a `resync` frame instead; a client that receives `error{code:"E_RESYNC",chat}` MUST treat it exactly like `resync` and reload history |
| `E_MODEL` | model list unavailable, unknown provider/model, or the app rejected the switch | client shows the error; the connection is unaffected |
| `E_EFFORT` | thinking setting unavailable, unknown level, unsupported by the current model, or the app rejected the write | client restores the last confirmed level and shows the error; a 404 is different: the chat has no server record yet, so the local choice is kept **without any error UI** and re-applied after the first completed turn (§10.2); the connection is unaffected |
| `E_EXPORT` | export requested for a chat with no server record, or its history could not be read or rendered | client shows the error; the connection is unaffected |
| `E_SEARCH` | search with an empty query, an archive that is not configured, or a Turso request that failed | client shows "search unavailable"; the connection is unaffected |
| `E_ATT` | attachment ref unknown, expired or from another chat; the message is gone; the file is outside the media directory, missing or over 10 MB | client keeps the attachment chip and shows no toast; always carries `chat` and `id`, and the connection is unaffected |
| `E_PROMPT` | `set_prompt` with an unknown `file`, a non-string or >65536-byte `content`, or an OS error while writing | client shows the save failed and keeps the editor content; the connection is unaffected (§17.4) |

`E_AUTH` is enforced at the HTTP upgrade (401 before the socket opens), so it is normally not seen
as a frame — a browser only observes a bare `close`. Because there is no close reason to read, a
client that stores a login token may treat a few consecutive handshakes that never opened as an auth
failure and return to its login gate (the SPA uses three). `E_BADFRAME` is relay-local and never
forwarded. `E_CHECKSUM` and `E_STATE` (§8) are file-transfer codes and appear only in `file_error`,
never in a generic `error` frame.

## 7. Versioning

v1 is additive: new optional fields and new `t` values may appear without a version bump. A breaking
change (for example a different envelope) will be negotiated via a `v` field in `hello` and announced
here.

The M8 frames in §17 were never assigned a version; they are additive in exactly this sense and were
implemented and shipped before this document listed them, so adding them here is documentation
catch-up, not a wire change.

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

## 10. Protocol v4 — session thinking effort

Lets the browser display and change the per-session reasoning effort QwenPaw already supports. The
relay needs **no changes**: these are ordinary frames it forwards verbatim. The plugin stores nothing
of its own — QwenPaw's `chat.meta.runtime_context.thinking` is the single source of truth.

### 10.1 Wire format

Client → agent:

```json
{"t":"get_effort","chat":"…"}
{"t":"set_effort","chat":"…","level":"medium"}
```

Agent → client:

```json
{"t":"effort","chat":"…","level":"medium","effective":"medium","supported":["low","medium","high"],
 "kind":"effort","model_key":"openai:gpt-4o"}
{"t":"effort","chat":"…","level":"high","effective":"budget","budget_tokens":24832,
 "supported":["low","medium","high","max"],"kind":"budget","model_key":"anthropic:claude-…"}
{"t":"error","code":"E_EFFORT","chat":"…","status":422,"detail":"…","id":"effort-set"}
```

- `level` is the **only** vocabulary the SPA sends: `default | low | medium | high | max`.
  `default` means "no session override" and maps to QwenPaw's `inherit`.
- `effective` is the server's resolved `effective.level`. It may be a value outside the SPA
  vocabulary (`budget`, `off`, …); it is informational, not a selectable option.
- `budget_tokens` is present when the effective preference is budget mode (the actual token count
  the server resolved).
- `supported` lists the selectable SPA levels (the plugin always sends it). `default` is always
  legal and therefore never listed. Budget-mode models list all four levels; effort-mode models list
  only the levels they declare; unknown/unsupported models send an empty list, leaving only
  `default` selectable. Clients MUST disable options absent from the list, but never `default`.
- `kind` is QwenPaw's control kind (`effort | budget | unknown | unsupported`) and `model_key` is
  the `provider:model` the preference is stored under.

### 10.2 Server semantics

- `GET`/`PUT` use the chat's `ChatSpec.id`; the plugin resolves the web chat to that id first. A chat
  that has never received a message has no `ChatSpec` yet, so both requests answer
  `E_EFFORT` with `status: 404`. A failed lookup (the plugin could not read `/api/chats`) is **not**
  that state: it answers `E_EFFORT` with the lookup's HTTP status (or no `status` when the app is
  unreachable) and a `chat list unavailable…` detail, so clients never mistake an outage for "the
  chat does not exist yet".
- `default` is always accepted: the plugin sends `{"level":"inherit"}`, which clears this session's
  override.
- For any other level the plugin inspects `control` **before** writing:
  - `effort`: the level must be exactly one of `control.efforts`. If it is not, the request is
    `E_EFFORT` — the server would adapt it and then reject the non-inherit preference with 422
    because its resolved `reason` is `adapted`.
  - `budget`: the plugin converts the level to
    `N = round(budget_min + (budget_max - budget_min) * ratio)` with ratio 0.15 / 0.4 / 0.75 / 1.0
    for low / medium / high / max, and sends `{"level":"budget","budget_tokens":N}`. Sending a bare
    level here would also be adapted and rejected with 422.
  - `unknown` / `unsupported`: `E_EFFORT`.
- A preference is keyed by `model_key`. Switching the model switches to that model's own
  preference/default, so clients MUST re-request `get_effort` after `model_changed`.
- `E_EFFORT` carries `chat` and, when the local app produced an HTTP status, `status`; it echoes the
  request's optional envelope `id` (`effort-get` / `effort-set` in the SPA). A 404 is not a validation
  failure: the client keeps its local selection **silently** and re-applies it once the chat's first
  turn has completed (the point where the `ChatSpec` exists). Every other `E_EFFORT` for `set_effort`
  is a real rejection and must stay visible to the user.

### 10.3 Control frames

`effort` is sent **without `seq`**, like `models` / `model_changed` / `status`; it is not
ring-buffered and not replayed on `resume`. A reconnecting client re-requests `get_effort` for the
visible chat.

## 11. Protocol v5/v8 — per-session token usage and per-turn receipts

Lets the browser show a context meter above the composer and one tiny receipt
under the assistant bubble that closed each turn. The relay needs **no
changes**: these are ordinary frames it forwards verbatim. The plugin keeps no
counter of its own — it reads the per-turn usage QwenPaw already persists on
the session's messages.

### 11.1 Wire format

Client → agent:

```json
{"t":"get_usage","chat":"…","id":"usage-get"}
```

Agent → client:

```json
{"t":"usage","chat":"…","id":"usage-get","input_total":12345,"output_total":6789,
 "context_tokens":68000,"context_limit":200000,
 "last_turn":{"id":"<Msg.id>","input":1234,"output":567,"total":1801}}
{"t":"usage","chat":"…"}
```

- Every numeric field is optional and independent. **A missing field means "unknown", never 0**;
  endpoints must not substitute a placeholder. `0` is sent only when the recorded data really is 0
  (which is how a real empty total differs from "no record at all").
- `id` echoes the request's envelope `id` when it had one.
- `chat` is always present. The agent **always answers** — the second frame above is the documented
  "no usage data" result (new chat, no persisted turn yet, unreadable/absent session file). There is
  no `E_*` error for usage; a client must treat an empty frame as "hide the meter" rather than keep
  another chat's numbers.
- `context_limit` is the active model's `effective_max_input_length` and may appear without any token
  fields.
- `last_turn` (**v8**) is the receipt of the session's **newest** assistant reply, in the same shape
  as `hist`'s `turn` (below). It is present only when that reply recorded usable usage; a still
  streaming, failed, cancelled or legacy reply yields no `last_turn` at all. Clients must **not**
  reuse an older turn's numbers for the new bubble and should deduplicate by `id` against the turn
  they already show.

### 11.2 Data basis

- `input_total` / `output_total` — sums of `prompt_tokens` / `completion_tokens` over every assistant
  message of the chat's session. Source: `metadata["qwenpaw_turn_usage"].usage` on the messages
  persisted in `workspace/sessions/web/*.json` (the same data `agent_stats` aggregates). The plugin
  matches the file to the chat's `session_id` (`web:web-user:<chat>`) and caches parses by file
  mtime/size. Missing, malformed or non-numeric fields are skipped; they are never zero-filled.
- `context_tokens` — **approximation**, `basis=last_turn_prompt`: the latest recorded turn's context
  estimate, in priority order `usage.last_prompt_tokens`, then
  `qwenpaw_turn_usage.context_usage.estimated_tokens`, then `usage.prompt_tokens`. Only a positive
  value is usable; a turn with none is skipped in favour of the previous usable one.
  `prompt_tokens` accumulates **every model call of the turn**, so a turn with several tool calls
  would overstate the context (often by a multiple); `last_prompt_tokens` is the last call's prompt
  and is therefore the primary numerator. This is still an approximation, not a live tokenizer
  count, which is why every client render marks it with `≈`.
- `context_limit` — `GET /api/models/active?scope=effective&agent_id=<id>` →
  `effective_max_input_length`. The window belongs to the model, so clients refresh after
  `model_changed`.

#### `turn` receipts (v8)

`hist` carries one optional `turn` on the assistant **text** message that closes a persisted
`Msg`; `usage.last_turn` carries the same object for the newest reply:

```json
{"id":"<Msg.id>","input":1234,"output":567,"total":1801,"estimated":true}
```

- `id` — the persisted `Msg.id` (QwenPaw's `metadata.original_id` on history messages). It is the
  deduplication key between `hist` and `last_turn`.
- `input` / `output` — that turn's `prompt_tokens` / `completion_tokens`; `total` — the recorded
  `total_tokens`, or `input + output` when both are known.
- `estimated` — present and `true` only when QwenPaw marked the turn's usage as an estimate; absent
  means "not estimated", not `false`.
- `duration_ms` **was removed (M20)**. QwenPaw stamps `finished_at` at the first `REPLY_END` of a
  reply, so the span against `timestamp` was always ~0 and never the turn's real duration; the SPA
  had already stopped parsing it in M17. Clients must ignore the field if an older plugin still
  sends it — it is an optional extra, so its absence needs no version negotiation (§7).
- **A message without `turn` means "no usable usage for this turn", never 0.** Reasons include a
  turn that recorded no usage, a group with conflicting usage, no assistant text segment, or a
  history window that does not contain the anchor. Fields absent inside a `turn` are unknown and
  must not be rendered as 0. One persisted `Msg` may be split into reasoning / tool / text
  messages; only the last text segment is an anchor, so a turn is never counted twice.

The SPA renders the meter above the composer as `上下文 ≈<pct>%` with a thin bar (fill colour turns
amber from 75% and red from 90%) and, on desktop, the session totals `↑<input> ↓<output>` on the
same row; tapping the row opens a small panel with the exact numbers. Each assistant bubble shows
`≈本轮 ↑<input> ↓<output>` (the `≈` only for estimated turns) with exact numbers and total. Without
`context_limit` the meter degrades to the text `上下文 ≈<context>` (no percentage); with only totals
it shows just `↑… ↓…`; with neither it is hidden. Numbers use a compact `k`/`M` format.

### 11.3 Control frames

`usage` is sent **without `seq`**, like `models` / `model_changed` / `status` / `effort`; it is not
ring-buffered and not replayed on `resume`. A reconnecting client re-requests `get_usage` for the
visible chat. The SPA asks for it when a chat is opened/switched, after each assistant turn completes
(debounced until the app has had time to persist that turn's metadata), after `model_changed`, and on
every transition to `live`.

## 12. Protocol v6 — conversation export (Markdown)

Lets the browser download one conversation as a single Markdown document. The relay needs **no
changes**: these are ordinary frames it forwards verbatim. The plugin builds the document from the
same raw `ChatHistory` the app serves (`GET /api/chats/{ChatSpec.id}`), so message type, role,
timestamp, reasoning, tool calls and attachment metadata are preserved; it is never derived from
Turso or from a lossy `{role, text}` projection.

### 12.1 Wire format

Client → agent:

```json
{"t":"export","chat":"…","id":"export-1"}
```

Agent → client:

```json
{"t":"export_begin","chat":"…","id":"export-1","bytes":456789,"chunks":5,
 "sha256":"<64 lowercase hex chars>"}
{"t":"export_chunk","chat":"…","id":"export-1","i":0,"data":"<base64 of ≤96 KB raw bytes>"}
{"t":"export_chunk","chat":"…","id":"export-1","i":1,"data":"…"}
{"t":"export_end","chat":"…","id":"export-1"}
{"t":"error","code":"E_EXPORT","chat":"…","id":"export-1","detail":"…"}
```

- `id` is the client's correlation id and is echoed on every reply. The agent→client stream is
  broadcast to every tab, so a client MUST ignore frames carrying another `id`.
- `bytes` is the exact UTF-8 byte length of the whole document, `chunks` the number of
  `export_chunk` frames that follow, and `sha256` its lower-case hex digest.
- Chunks are a **pure byte-stream split** of the document, not aligned to messages: `i` is 0-based
  and `data` is base64 of at most 96 KB raw bytes (`CHUNK_RAW_BYTES`, the same budget as §8). A
  boundary never splits a UTF-8 code point, so every chunk decodes on its own.
- `export_begin` is sent only after the whole document exists and its size has been checked. A
  rejected export never sends a partial stream: `E_EXPORT` (no server-side chat, unreadable history,
  render failure) or `E_TOOBIG` (over 10 MB) arrives instead and nothing else follows.
- The client verifies the reassembled byte length and sha256 against `export_begin`; a mismatch is
  discarded and reported to the user, never saved.
- Interrupted exports are not resumed: reconnect and request a fresh `export` with a new `id`.

### 12.2 Document rules

The header names the chat title (`ChatSpec.name`/`title`, else the chat id), the agent
(`GET /api/agents/{id}` display name, else the agent id), the model when the effective model is known
(`provider/model`), the export time (ISO-8601), the number of exported messages and one basis
statement: *基于 QwenPaw 会话历史导出；上下文若已被后端压缩，早期轮次以历史接口返回为准；思考过程以
折叠形式附后（若包含）；附件仅记录文件名等元信息，不含附件内容。* An unavailable agent/model lookup
only drops its line — it never fails the export.

Every `Message` keeps its type:

- `MESSAGE` — a `### <role> · <metadata.timestamp>` heading followed by its text and any
  `[附件: name · mime · size bytes]` lines (one per file; the size is omitted when it could not be
  measured).
- `REASONING` — a collapsible `<details><summary>思考过程</summary>…</details>` block.
- `PLUGIN_CALL` / `PLUGIN_CALL_OUTPUT` — compact blocks: the tool name on one line, arguments/output
  in a fenced code block.
- Attachments are metadata only: the bare `filename` (or the last path segment of a URL, or
  `内嵌附件` for a data URL), the MIME (declared, taken from a data URL, or guessed from the
  extension) and the size in bytes when the file could be stat'ed. Absolute hosted paths and payload
  bytes never appear. A file that is both a `file` and an `image` part (G2-A) is deduplicated by
  URL, so it produces exactly one line.

**Turn usage footnotes (M20).** When the history payload already carries QwenPaw's
`qwenpaw_turn_usage`, the assistant message that closes a persisted `Msg` (the same anchor `hist`
uses, §11.2) gets one blockquote line under its body:

```markdown
> 本轮用量：输入 1,234 · 输出 567 · 合计 1,801 tokens（估算）
```

Only the fields present in the `turn` receipt are shown (absent ≠ 0), and `（估算）` appears only for
`estimated:true`. A turn without usable usage adds nothing — the export never invents numbers and
never reads a second source for them.

Message text and reasoning are never truncated. Tool output is the one oversized field and is cut at
8000 characters with a trailing `…（输出过长，已截断；原始 N 个字符）` note. Titles are collapsed to
one line (control characters become spaces) and truncated by code point at 120, so a title cannot
inject headings or break the document. An empty conversation exports its header alone.

### 12.3 Limits and pacing

- Whole document ≤ **10 MB**, the same ceiling as a chunked upload. The check happens before
  `export_begin`; going over is `E_TOOBIG`.
- One `export_chunk` carries at most 96 KB raw bytes (~128 KB base64), well inside the 256 KB frame
  limit.
- The agent paces chunks ~40 ms apart (≈25 frames/s), leaving room for streaming and heartbeat
  traffic in the shared 30 frames/s tenant bucket (§5).
- A successful export produces exactly `export_begin`, `chunks` × `export_chunk`, `export_end`.
  Errors use the generic `error` frame with `code:"E_EXPORT"` (or `E_TOOBIG`), always carrying
  `chat` and echoing `id`.

### 12.4 Control frames

`export_begin` / `export_chunk` / `export_end` are **control frames**: they carry no `seq`, are not
ring-buffered and are not replayed on `resume`. A reconnecting client requests the export again
rather than expecting chunks in the replay. They must never go through the `seq` path — one export
would otherwise evict most of the 400-frame ring buffer.

## 13. Protocol v7 — archive full-text search

Lets the browser search the **archived** history of every conversation by message body. The relay
needs **no changes**: these are ordinary frames it forwards verbatim. The plugin answers from its
Turso archive (`messages` joined with `chats`, parameterised `LIKE`), so it finds turns that are no
longer in the live session store, and it never touches the archive schema.

### 13.1 Wire format

Client → agent:

```json
{"t":"search","id":"search-1","q":"上下文","limit":20}
```

Agent → client:

```json
{"t":"search_results","id":"search-1","q":"上下文","total":3,
 "items":[{"chat":"chat-abc","title":"旧会话","role":"user",
           "snippet":"…这里的上下文…","match_start":3,"match_len":3,
           "ts":1700000000000}]}
{"t":"error","code":"E_SEARCH","id":"search-1","reason":"disabled",
 "detail":"archive not configured"}
```

- `id` is the client's correlation id and is required: a `search` without a non-empty string `id`
  is dropped with a log line, because there is nothing to correlate a reply with.
- `q` is trimmed, its internal whitespace collapsed and the result cut to 100 characters. A query
  that normalises to empty is `E_SEARCH` / `bad_query`.
- `limit` is optional. A non-integer value means 50; an integer is clamped to **1..50**.
- `q` in the reply is the normalised query the hits were found for, not necessarily the exact
  request string.
- `items[]` carries at most one page (newest first) and **never** the message body: `snippet` is
  the match plus up to 40 code points of context on each side.
- `match_start` / `match_len` locate the hit **inside `snippet`**, in **UTF-16 code units** — i.e.
  exactly what JavaScript's `String.prototype.slice` indexes. They are `-1` / `0` when the hit
  cannot be located in the snippet (the LIKE and the in-memory scan disagree about whitespace).
- `ts` is the archived message time in Unix milliseconds; `title` falls back to the chat id when
  the archive has no title for it.
- `total` is the number of rows the predicate matches overall, not `items.length`; it lets the
  client say "showing N of M" without a second request.
- Search is scoped to the requesting agent when the plugin knows its id.

### 13.2 Error reasons

| `reason` | meaning |
|---|---|
| `bad_query` | `q` is missing, not a string, or empty after normalisation |
| `disabled` | `turso_url` / `turso_token` is not configured on the plugin |
| `unavailable` | the Turso request failed, a pipeline result was an error, or the response was malformed |

The `error` frame always carries `id` and `reason` and never `chat`: a search spans every
conversation. HTTP is attempted exactly once — the read path does not retry.

### 13.3 Coverage

Only archived turns are searchable. Archiving is best-effort (bounded queue, retries, then a drop),
so **a missing hit is not proof the conversation never said it** — the UI states this next to the
results. Messages that have not been archived yet are invisible until their turn is flushed.

### 13.4 Control frames

`search_results` is a **control frame**: it carries no `seq`, is not ring-buffered and is not
replayed on `resume`. Reconnect and re-issue the `search` with a new `id` instead.


## 14. Protocol v9 — all-chats usage dashboard

Aggregates the per-turn receipts of §11 across every persisted web chat, so the SPA's 用量统计
view can show totals, cache hit/miss (§14.5), a per-model breakdown (§14.6), a per-day series and
a top-chats ranking. The relay needs **no changes**;
both frames are forwarded verbatim.

### 14.1 Wire format

Client → agent:

```json
{"t":"get_stats","id":"stats-1"}
```

Agent → client:

```json
{"t":"stats","id":"stats-1",
 "totals":{"turns":95,"input":1648974,"output":12314,
           "cache_hit":341141,"cache_miss":1307833,
           "cache_eligible":1648974,"cache_hit_rate":20.69},
 "by_model":[
   {"provider":"kilo","model":"openrouter/free","turns":52,"input":892049,
    "output":6330,"cache_hit":26038,"cache_miss":866011,
    "cache_eligible":892049,"cache_hit_rate":2.92},
   {"provider":"kilo","model":"kilo-auto/free","turns":43,"input":756925,
    "output":5984,"cache_hit":315103,"cache_miss":441822,
    "cache_eligible":756925,"cache_hit_rate":41.63}],
 "covered_chats":37,"uncovered_chats":0,
 "days":[{"date":"2026-10-26","turns":20,"input":406196,"output":4556,
          "cache_hit":234486,"cache_miss":171710,"cache_eligible":406196,
          "cache_hit_rate":57.73}],
 "chats":[{"chat":"m2file","title":"…","turns":10,"input":273651,"output":1271}],
 "day_basis":"container-local","day_tz":"UTC"}
{"t":"stats"}
```

- `totals` — `{turns, input?, output?, cache_hit?, cache_miss?, cache_eligible?,
  cache_hit_rate?}` across all covered chats. A missing token side means **no turn recorded it**;
  it is never sent as 0. `turns` is present even when it is 0. The four cache keys appear as one
  group, only when at least one turn reported cache usage (§14.5).
- `by_model[]` — `{provider?, model, turns, input?, output?, cache_*?}`, one row per
  `(provider_id, model_name)` plus the `未知模型` bucket, sorted by `input` descending (§14.6).
- `covered_chats` — how many chats contributed at least one usable turn. Real `0` is sent.
- `uncovered_chats` — known web chats (the `GET /api/chats?channel=web` list) that contributed no
  usable data. **Omitted when the chat list could not be read**: unknown is not 0.
- `days[]` — `{date, turns, input?, output?, cache_*?}`, ascending by ISO `YYYY-MM-DD`. The cache
  group follows the same rule as `totals` and can cover fewer turns than the day's `input`.
- `chats[]` — top chats by `input + output` (then `turns`, then chat id), **capped at 10**.
  `title` appears only when the chat list resolved one.
- `undated_turns` — present only when counted turns had no usable timestamp. Those turns are in
  `totals` but not in `days`.
- `day_basis` — always `"container-local"`; `day_tz` carries the container's local time-zone name
  when known.
- `id` echoes the request's envelope `id` when it had one.

The agent **always answers**, at worst `{"t":"stats"}`, and never raises into the chat path. Every
malformed field is dropped rather than replaced by a placeholder.

### 14.2 Day bucketing

A turn's day is the **container's local calendar day**. QwenPaw (AgentScope) stamps
`Msg.created_at` with a naive local wall-clock ISO timestamp, so its date prefix is already local;
an offset-aware timestamp is converted to local time first, and `finished_at` is the fallback.
A turn without a parseable timestamp is counted in the totals but **not** in a made-up day bucket
(`undated_turns` says how many). Day boundaries therefore follow the container's `TZ`, which may
differ from the browser's.

### 14.3 Coverage

Covered data is every `sessions/web/*.json` (plus legacy `sessions/*.json`) file that parses, has
at least one assistant message carrying `qwenpaw_turn_usage.usage` with a usable
`prompt_tokens`/`completion_tokens`, and resolves to a chat id (recorded session id, a known
ChatSpec id / chat id, or the QwenPaw file name `web-user_web--web-user--<chat>.json`).
Malformed, empty and usage-less files are skipped silently. Turns that QwenPaw compacted away,
replies never persisted, and chats with no session file are not in the numbers — which is exactly
what `uncovered_chats` tells the UI.

The scan reuses the `usage` handler's `(mtime_ns, size)` cache, so opening the dashboard re-stats
files but only re-parses those that changed.

### 14.4 Control frame

`stats` carries **no `seq`**, belongs to no chat stream, and is never ring-buffered or replayed on
`resume`. A reconnecting client re-issues `get_stats` with a new `id`.

### 14.5 Cache accounting (M28)

Every turn's receipt (`qwenpaw_turn_usage.usage`, §11.1) already carries **normalised** cache
numbers: the plugin never parses a provider response. QwenPaw converts the raw fields like this
(`qwenpaw-ref/src/qwenpaw/providers/adapters/usage.py`, `token_usage/model_wrapper.py`):

| provider family | raw field the model adapter reads | normalised to |
|---|---|---|
| DeepSeek | `usage.prompt_cache_hit_tokens` (prompt = hit + miss) | `cache_read_tokens`; eligible = `prompt_tokens` |
| OpenAI-compatible chat (OpenAI, Kilo, OpenCode chat models, OpenRouter, compatible endpoints) | `usage.prompt_tokens_details.cached_tokens` (also `input_tokens_details.cached_tokens`) | same |
| OpenAI Responses | `usage.input_tokens_details.cached_tokens` | same |
| Anthropic (incl. OpenCode models routed to the anthropic protocol) | `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`; **`input_tokens` excludes both** | read/write split; eligible = `prompt + read + write` |
| DashScope / Moonshot / Volcengine | `usage.prompt_tokens_details.cached_tokens` | same as OpenAI |
| Gemini | `usage.cached_content_token_count` | same as OpenAI |
| xAI | `usage.cached_prompt_text_tokens` | same as OpenAI |
| adapter outside QwenPaw's cache-usage whitelist | none | `cache_observed=false`, read/write forced to 0 |

`prompt_cache_miss_tokens` is **never read** by QwenPaw or AgentScope, so a miss is always derived.
Per turn, the plugin applies exactly:

```text
observed = usage.cache_observed is True          # false / missing => not reported
hit      = usage.cache_read_tokens               # int >= 0
eligible = usage.cache_eligible_input_tokens     # must be > 0
miss     = eligible - hit                        # never prompt_tokens - hit
rate     = hit / eligible * 100                  # 0-100, never 0-1
```

Rules that are part of the contract:

- A turn contributes to `cache_hit` / `cache_miss` / `cache_eligible` **only** when
  `observed` is `true` and `eligible > 0`. Everything else contributes **nothing** — a missing flag
  (legacy receipt), `cache_observed=false`, a zero denominator, or `hit > eligible`. Such turns are
  still counted in `turns`, `input` and `output`.
- `0` is a real value: a reported turn with `cache_read_tokens=0` is a 0% hit and stays in the
  denominator. **"Not reported" and "0%" are different**; the first omits the group, the second
  sends zeros.
- The group is all-or-nothing: `cache_hit`, `cache_miss`, `cache_eligible` and `cache_hit_rate`
  are present together or absent together, and `cache_hit + cache_miss == cache_eligible`.
- `cache_hit_rate` is always recomputed as `Σhit / Σeligible * 100` (rounded to 2 decimals) from
  the integer sums — **per-turn rates are never averaged**, because a large turn must weigh more.
  The plugin recomputes it at both the aggregation and the frame-building boundary; a received
  rate that contradicts the sums is discarded.
- `session_cache_read_tokens` / `session_cache_eligible_input_tokens` /
  `session_cache_hit_rate` are **cumulative session snapshots**, not per-turn increments. They are
  never summed and never used to derive a rate; adding them would count early turns again and
  again.
- `input` keeps the M24 meaning: `Σ prompt_tokens`. `cache_eligible` is a separate denominator.
  For OpenAI/DeepSeek `cache_eligible == input`; for Anthropic `prompt_tokens` excludes cache
  reads/writes, so `cache_eligible > input` **for that model** and, when other turns did not report
  cache at all, `totals.cache_eligible` may be *smaller* than `totals.input`. Clients must not
  assume `hit + miss == input`; draw cache shares against `cache_eligible`.

### 14.6 Per-model breakdown (M28)

`by_model` answers "which model actually spent these tokens". The attribution is the **turn's own**
`usage.provider_id` / `usage.model_name`, recorded from the model instance that was called. It is
never back-filled from the chat's current model: one chat's history can span several models
(`m2main`: 6 turns on `kilo-auto/free`, then 4 on `openrouter/free`, while the chat's active model
is only the latter).

- Grouping key is `(provider_id, model_name)`; a row is
  `{provider?, model, turns, input?, output?, cache_hit?, cache_miss?, cache_eligible?,
  cache_hit_rate?}`. `provider` is omitted when the receipt has none.
- A turn whose `model_name` is missing, empty or the literal `"unknown"` (QwenPaw's fallback when
  the model object has no name) goes to the single bucket `model:"未知模型"` with no `provider`.
  Those turns **still count** in `totals` and in the row's `turns`/`input`/`output`; the UI states
  that the model is unknown rather than inventing one.
- Rows are sorted by `input` descending, then `turns` descending, then `model` ascending, then
  `provider` ascending. There is no cap.
- Consistency guarantee: `Σ by_model.turns == totals.turns`, and for every present field
  `Σ by_model.input == totals.input`, `Σ by_model.output == totals.output`, plus the same identity
  for `cache_hit` / `cache_miss` / `cache_eligible`. The unknown bucket is what makes this exact.
- A turn that made several model calls is one row: the token sums cover all calls while the model
  label is the **last** call's model (QwenPaw merges the receipt this way), so a mid-turn model
  switch cannot be seen in the data.
- Cache keys follow §14.5 per row: a model with no observed turn shows no cache fields (the UI
  prints `—`), which is **not** a 0% hit rate.

## 15. Protocol v10 — attachment history and retrieval (M31)

History used to carry text only: a picture or a document vanished on reload, and a turn that had no
text disappeared entirely (with its answer left hanging). v10 makes attachments first-class in
`hist` and adds a bounded, opaque way to fetch the bytes back. The relay needs **no changes**:
every `att_*` frame is an ordinary frame it forwards verbatim.

### 15.1 Why refs instead of paths

`GET /api/chats/{id}` reports a local attachment as an absolute container path
(`FileContent.file_url` / `ImageContent.image_url`). That path is useful to the plugin (it is the
same machine) and meaningless to a browser, and publishing it would leak the container layout. The
plugin therefore mints an opaque, random `ref` per `(chat, message original_id, part index)` and
keeps the path in memory only. The browser can ask for a ref; it can never name a path.

### 15.2 Wire format (control frames, no `seq`)

```
browser → container : {"t":"att_get","chat":"…","id":"<request id>","ref":"<opaque>"}
container → browser : {"t":"att_begin","chat","id","bytes","chunks","sha256","name","mime?"}
                      {"t":"att_chunk","chat","id","i","data"}   // ≤96 KB raw bytes, 40 ms apart
                      {"t":"att_end","chat","id"}
                      {"t":"error","code":"E_ATT","chat","id","detail"}
```

- `id` is the client's correlation id and is echoed by every reply; frames for an unknown id are
  ignored. `bytes` is the exact file length, `chunks` the number of `att_chunk` frames, `sha256` the
  lower-case hex digest of the whole file, `name` the bare display name.
- Chunks are contiguous slices of the file and reassembly is byte-identical; the stream is paced
  like an export (§12.3) so a 10 MB file stays inside the relay's 30 frames/s budget.
- The client MUST verify the length and SHA-256 before rendering or saving, and MUST ignore a
  stream that never received `att_end`.
- `att_*` frames are control frames: no ring buffering, no replay on `resume`.

### 15.3 `hist.messages[].files`

An optional array on a message:

```json
{"role":"user","text":"","files":[
  {"name":"截图.png","mime":"image/png","size":28417,"kind":"image","ref":"hT3…"}
]}
```

- `name` is the bare file name (no directory, no URL, no data URL payload).
- `mime` is omitted when unknown; `size` is omitted when the file could not be stat'ed — never 0.
- `kind` is `"image"` or `"file"`. An image that the plugin sends as both `FileContent` and
  `ImageContent` (G2-A, same URL) is one entry with `kind:"image"`.
- `ref` is present only for files that live on the container filesystem; a data URL or an HTTP
  attachment has none and is display-only.
- A message with attachments and no text is still a turn: `text` is `""` and `files` is non-empty.
  A message with neither is still skipped. Turn receipts (`turn`) keep their M15 anchoring rules:
  only the group's last assistant **text** segment carries one.

Refs expire ten minutes after being issued (re-issued by a later `hist` answer) and are bound to one
chat.

### 15.4 `models.items[].vision`

An optional boolean copied from the model's own metadata (`supports_image`, falling back to
`supports_multimodal`). Omitted means "not probed" and MUST NOT be treated as `false`: QwenPaw
fails open for unprobed models and may still accept images. Only this boolean leaves
`ProviderInfo` — never `api_key`, `base_url` or any other provider field. The SPA shows a subtle
hint only when `vision` is `false`.

### 15.5 Server-side validation (all required)

A request is refused with `E_ATT` (and nothing is streamed) when any of these fails:

1. the ref is unknown or older than ten minutes;
2. the ref belongs to another chat;
3. a fresh `GET /api/chats/{id}` no longer contains that message (`metadata.original_id`) with the
   same attachment URL;
4. `Path(path).resolve()` is not inside the console media directory (`CONSOLE_MEDIA_DIR`, else
   `<workspace_dir>/media`) — this rejects `..` traversal and a symlink that points outside;
5. the target is not a regular file, or is larger than **10 MB**.

### 15.6 Upload metadata (G4)

A chunked upload still travels as `file_begin` / `file_chunk` / `file_end` (§8). The `msg.files[]`
entry that consumes it now also carries the metadata the browser already knows:

```json
{"ref":"file-…","name":"报告.pdf","mime":"application/pdf","size":123456}
```

The plugin prefers the entry's own `name`/`mime`/`size` and falls back to the staged record, so an
archive entry keeps its file name even when the staged upload has expired. The archive uses the
first attachment name as the chat title when a turn has no text.

## 16. Protocol v11 — agent presence (M39)

Before v11 a browser could learn "the agent is here" only from the `ready` handshake and from the
plugin's identity `status` push. Neither ever says "the agent left": `ready` is a one-shot snapshot
and the identity push can only be produced by a plugin that is attached. A browser with a live
relay socket therefore kept displaying the last `ready.agentOnline` value while a restarting (or
dead) plugin was unreachable, and a message sent in that window looked delivered while it was
actually parked in the relay's offline buffer.

The relay always knew the truth — it owns the single agent slot. v11 is the missing exit: the two
relay implementations broadcast the slot state to every connected client (on the hosted relay a
client must have passed the token check at the upgrade, so "connected" already means authenticated).

### 16.1 Frame

Presence reuses the existing `status` control frame rather than inventing a type:

```json
{"t":"status","agentOnline":false}
```

- `agentOnline` is a boolean and is always present in a relay presence frame.
- The plugin's identity push keeps its shape — `agent_name`, optional `provider` / `model`, and
  **no** `agentOnline` (plugin `status_frame`). The two producers share one `t` with disjoint
  fields: an absent `agentOnline` means "identity only", which also implies online because only an
  attached plugin can send it; a present `agentOnline` is the relay's slot state. A client that
  understands only one of the two keeps working: it sees the other's frames as unknown fields.
- Control frame: no `seq`, not ring-buffered, not replayed on `resume`, and never sent to the agent
  (the broadcast iterates client sockets only).

### 16.2 When it is sent

Presence is an **edge**, never a beat. The relay broadcasts only when the value changes.

| edge | relay-side trigger | frame |
|---|---|---|
| offline → online | a `hello` wins the slot: `peer` → flush the offline buffer → presence → `ready` | `{"t":"status","agentOnline":true}` |
| online → offline | the **slot holder** closed or errored (its `close` / `error` event) | `{"t":"status","agentOnline":false}` |

Presence is published **after** the offline buffer is flushed, so a client that reacts to "online"
by sending can never overtake frames that were already waiting for that agent.

These events MUST NOT produce a presence frame:

- a **parked** socket (connected, no `hello` yet) or a **superseded** generation
  (closed with 4000 for an older `started`) — it never held the slot, so its departure is not an
  edge;
- a **generation handover** (a newer `hello` closes the old holder and takes the slot): the winner
  is installed before the old socket's close is delivered, so the slot never appears empty and the
  clients see no edge at all;
- a **re-hello** from the current holder (metadata refresh only);
- a client joining or leaving (that is `peer`, agent-side only);
- `ping` / `hb` (a beat is not a state change).

### 16.3 What "offline" means

The relay's existing death points, and nothing more sensitive:

- the TCP/WebSocket `close` or `error` event of the holder socket, and
- the plugin's own decision to close: `hb` every 15 s, ack expected within 10 s, two consecutive
  misses (~37 s worst case) → the plugin closes and reconnects.

The relay does **not** add an `hb` timeout, a `/health` poll or any other liveness guess. A
half-open socket that has not produced a close event is still "online" here exactly as it is in
`/health` and in the offline buffer; the plugin's heartbeat is what eventually converts that into a
close.

**No debounce delay is added.** A plugin restart can therefore show 在线 → 离线 → 在线 within a
second or two. That is deliberate:

1. delaying "offline" only lengthens the window in which a browser believes it can deliver: it
   keeps writing `msg` frames into the relay's offline buffer, whose memory copy dies with a
   `relay-node` restart and whose 500-frame / 1 MB cap drops the oldest — the exact failure M37
   exists to avoid;
2. the client-side queue already makes the fast flip harmless: a send inside the gap is queued as
   待发送 and flushes in order on the next online edge, and nothing that was written to a socket is
   ever auto-resent;
3. a debounce would be a second, softer liveness judgement layered on top of the relay's real one,
   which is exactly the "don't invent a more sensitive detector" rule.

### 16.4 Client behaviour

- `ready{agentOnline}` remains the authoritative snapshot for a new connection; presence only
  updates it afterwards.
- On an offline presence the client MUST treat the agent as unreachable: new sends are queued
  locally (not written to the socket), and the header shows the agent as offline.
- On an online presence the client flushes that queue in order through the ordinary `{t:"msg"}`
  path.
- Presence is an **early warning, not a delivery receipt**. A frame written before the agent died
  can still be lost; the M37 history-tail reconcile after a reconnect MUST keep running for those
  entries.

### 16.5 Compatibility

The frame is additive. A v10 browser does not know the `agentOnline` field; it treats every
`status` as the plugin's identity push (the M7 handler sets "online" on receipt), so a v11 relay's
offline edge is ignored and the header keeps its pre-v11 value. That is exactly the old behaviour —
no lost messages, no new error — which is what makes the relay deployable before the SPA. An older
relay never sends presence at all, and a v11 browser degrades to the pre-v11 behaviour. Either
deployment order is safe; deploying the relay first starts producing edges for clients that already
understand them.

## 17. Unversioned extras — chat list, workspace prompts, skills (M8)

These six request/response pairs shipped with M8, between the numbered revisions, and were never
assigned a protocol version of their own. They were implemented in `plugin/frames.py` long before
this document listed them. They are ordinary frames the relays forward verbatim; every reply is a
control frame (no `seq`, no ring buffer, no replay).

### 17.1 `chats`

```json
browser → container : {"t":"chats"}
container → browser : {"t":"chats","items":[{"chat":"chat-abc","title":"旧会话",
                                             "updated_at":"2026-10-28T09:00:00Z"}]}
```

- One item per `GET /api/chats?channel=web` ChatSpec whose `session_id` is `web:web-user:<chat>`.
  `title` is the spec's `name`, else `title`, else `""`; `updated_at` falls back to `created_at` and
  is `""` when neither exists.
- An unreadable chat list answers `items: []`. **An empty reply is not authoritative**: the plugin
  also answers `[]` when its own API call fails, so a client MUST NOT prune its local chat list,
  pins or tags on it (only a non-empty list may prune).
- The SPA requests `chats` after every (re)connect and from the sidebar's refresh button.

### 17.2 `del_chat` / `chat_deleted`

```json
browser → container : {"t":"del_chat","chat":"chat-abc"}
container → browser : {"t":"chat_deleted","chat":"chat-abc"}
```

- The plugin resolves the web chat to its `ChatSpec.id` and issues `DELETE /api/chats/{id}`. It
  acknowledges even when the chat is unknown or the delete failed; there is no `E_*` for this pair,
  so a client that needs the truth re-requests `chats`.
- The SPA removes the row locally at once and does not wait for the ack.

### 17.3 `rename_chat` / `chat_renamed`

```json
browser → container : {"t":"rename_chat","chat":"chat-abc","title":"新名字"}
container → browser : {"t":"chat_renamed","chat":"chat-abc","title":"新名字"}
```

- M8 rename is a **browser display name**: the plugin acknowledges the frame but does not write
  `ChatSpec.name`. The SPA stores the name in `webchannel.chatNames` (localStorage), and its `chats`
  merge keeps local names over server titles. A server-side rename would need a new frame; none
  exists.
- The ack echoes the received `title` after trimming. The SPA only sends a non-empty title; clearing
  a local label is done by removing it from `webchannel.chatNames`, not by this frame.

### 17.4 `get_prompts` / `prompts` and `set_prompt` / `prompt_saved`

The four workspace prompt files are `SOUL.md`, `AGENTS.md`, `PROFILE.md` and `MEMORY.md`.

```json
browser → container : {"t":"get_prompts"}
container → browser : {"t":"prompts","files":{"SOUL.md":"…","AGENTS.md":"…",
                                              "PROFILE.md":"","MEMORY.md":""}}
browser → container : {"t":"set_prompt","file":"SOUL.md","content":"…"}
container → browser : {"t":"prompt_saved","file":"SOUL.md"}
container → browser : {"t":"error","code":"E_PROMPT","detail":"invalid prompt file or content"}
```

- `get_prompts` always answers with all four keys; a missing or unreadable file is `""`, and a file
  is truncated to 65536 characters when read.
- `set_prompt` accepts only those four names and a string `content` of at most 65536 **UTF-8 bytes**;
  anything else, or an OS error while writing, is `E_PROMPT` and no success ack is sent. Success
  writes `<workspace>/<file>` and answers `prompt_saved`.
- The SPA loads the editor with `get_prompts` and shows `prompt_saved` as the save confirmation.

### 17.5 `skills`

```json
browser → container : {"t":"skills"}
container → browser : {"t":"skills","items":[{"id":"web-search","name":"联网搜索",
                                              "description":"…"}]}
```

- Items come from `GET /api/skills`, falling back to the local skill registry and then
  `agent.json`; disabled entries are dropped, bare strings are accepted as ids, and duplicates are
  removed. `items: []` is a valid answer.
- Only `id`, `name` and `description` cross the wire; skill instructions stay in the container.
- The SPA requests `skills` after connect and whenever the skill picker (the `@` pill) opens.

### 17.6 Control-frame status

All six replies are control frames: no `seq`, not ring-buffered, not replayed on `resume`. A
reconnecting client re-requests them. `chats` is also how a client learns about chats created or
deleted elsewhere.
