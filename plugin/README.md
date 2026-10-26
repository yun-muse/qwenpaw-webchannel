# WebChannel plugin (QwenPaw)

A QwenPaw channel that connects **outbound** to the WebChannel relay
(`ws://…/ws/agent`) and bridges it to the agent. The browser never talks to the
container directly: it connects to the relay, which forwards frames verbatim
(`protocol/frames.md`). This plugin needs no inbound port and no new
dependencies.

Files:

| File | Purpose |
|---|---|
| `plugin.json` | plugin manifest (`id: webchannel`, `type: channel`) |
| `plugin.py` | `register_channel(...)` — label + `relay_url` / `token` fields |
| `channel.py` | `WebChannel(BaseChannel)`: relay I/O, streaming, approvals, local-API calls |
| `frames.py` | frame builders/parser (`protocol/frames.md`), size check |
| `util.py` | pure helpers: `StreamDiffer`, `SeqCounter`, `RingBuffer` + the M2 decisions |
| `relay_client.py` | `websockets` client: hello/auth, heartbeat, backoff, queue |
| `tests/test_diff.py` | plain-python tests for the helpers (no pytest needed) |
| `tests/test_m2.py` | plain-python tests for the A1/A3/A4/A5 decisions |

## Install

The plugin targets QwenPaw **2.2.0 – 2.3.0** (`qwenpaw_version` in
`plugin.json`) and requires a running relay (local default
`ws://127.0.0.1:8787/ws/agent`). `dependencies` is deliberately empty:
`websockets>=15.0.1,<16` and `httpx>=0.27.0` are QwenPaw core dependencies, so
installation never runs pip.

### A. Local directory hot-install (no restart)

`source` must point at the directory that contains `plugin.json` — i.e. this
`plugin/` directory, not the repo root:

```bash
curl -X POST localhost:8088/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"/root/qwenpaw-webchannel/plugin","force":true}'
```

### B. ZIP hot-install (recommended for a hosted container)

Build the ZIP so that `plugin.json` sits at its **root**:

```bash
cd plugin && zip -r ../webchannel.zip . -x 'tests/*' && cd ..
curl -X POST localhost:8088/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"https://<your-static-host>/webchannel.zip","force":true}'
```

Both A and B return without restarting the process (the plugin manager reloads
agents in the background). Check `GET /api/plugins` for `webchannel`.

### C. Manual (requires a process restart)

```bash
cp -r plugin ~/.qwenpaw/plugins/webchannel     # PLUGINS_DIR = WORKING_DIR/plugins
```

### Enable the channel

After install, a **Web** card appears in Console → Control → Channels. Enable
it for the agent that should be reachable and fill in the two fields below, or
add to that agent's config:

```yaml
channels:
  web:
    enabled: true
    relay_url: "ws://127.0.0.1:8787/ws/agent"
    token: "dev-agent-token"
```

The token must equal the relay's `AGENT_TOKEN`. Multi-agent works the normal
QwenPaw way: **one plugin instance per agent workspace**, each dialling with its
own `hello{agent: <workspace.agent_id>}`.

## Config fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `relay_url` | text | `ws://127.0.0.1:8787/ws/agent` | relay agent endpoint; auth is `Authorization: Bearer <token>` on the upgrade |
| `token` | password | `dev-agent-token` | agent token sent both as the bearer header and in `hello` |

Defaults are applied when the field is missing/empty, so a SimpleNamespace
config without either key still starts. The channel's `start()` hook dials the
relay; `stop()` closes it cleanly.

## How cumulative-text diffing works

`BaseChannel.on_streaming_delta` receives **cumulative** text — everything
accumulated for that stream so far, including the current chunk
(`docs/source-notes.md` Q1). The protocol wants per-delta `evt` frames, so the
plugin diffs:

1. `StreamDiffer.diff((chat, stream_type), accumulated)` returns
   `accumulated[len(prev):]` and stores the new value.
2. Only a non-empty suffix becomes
   `{"t":"evt","chat":…,"seq":…,"data":{"text":chunk,"stream_type":…}}`;
   empty suffixes send nothing.
3. A suffix that is not an extension of the stored value (segment replaced) is
   re-sent in full, so no text can be lost.
4. `on_streaming_start` and `on_streaming_end` reset the key for that
   `(chat, stream_type)`, which also covers a new segment without a start.
5. `on_streaming_end` flushes one last suffix (the completed event may carry
   text that BaseChannel coalesced away from the deltas) **before** `end`.

Because the diff is taken from cumulative text, BaseChannel's in-flight flush
coalescing (it can skip intermediate flushes) is harmless: the next call simply
carries the fuller text and the diff catches up.

Each chat has its own `SeqCounter` (starting at 1) and a 400-frame
`RingBuffer`. Every outbound frame is numbered, buffered, then handed to
`RelayClient`. On `{"t":"resume","chat","last_seq"}` the plugin replays frames
with `seq > last_seq` (same seqs, no renumbering); a miss (too old, or buffer
empty after a restart) produces `{"t":"resync","chat","reason":"gap"}`.

## M2 changes (A1–A5)

**A1 — trailing full-text `msg`.** `base.py`'s streaming path consumes the
completed message event itself (`_on_stream_msg_end` returns `True`), so
`on_event_message_completed` — and therefore `send()` — never runs for a
streamed reply; only the `evt` deltas ever reached the browser. `on_streaming_end`
now closes the segment in the order **`evt` tail → `end` → `msg`**, where the
`msg` carries the whole answer:

```json
{"t":"msg","chat":"…","seq":7,"parts":[{"type":"text","text":"<full answer>"}]}
```

The decision is `util.trailing_msg_text(stream_type, streamed_text, text_sent)`:
emit only for the `message` stream (never `reasoning`, which is streamed but is
not the answer) and only when no text `msg` was already delivered for that
segment. `send()`/`send_content_parts()` mark "text already delivered" only
while **no** stream is open for that chat, because text sent mid-stream is tool
output (`base.py::on_event_content`), not the answer. `StreamDiffer.last(key)`
supplies the full text. Nothing extra is emitted for non-streamed replies.

**A2 — `stop`.** `{t:"stop", chat}` → resolve `ChatSpec.id` (see below) →
`POST /api/console/chat/stop?chat_id=<id>` with `X-Agent-Id`. A chat that does
not exist yet, or a failed lookup/POST, is logged; no frame is sent and the
socket stays up.

**A3 — `hist`.** `{t:"hist", chat, limit?}` → resolve `ChatSpec.id` →
`GET /api/chats/{id}` → `util.history_messages()` (concatenate a message's text
parts, skip textless messages, keep the last `limit`, default 50) →
`util.pack_history()` splits the list so **every frame stays ≤ 256 KB**
(packed against the `more:true` variant) with `"more": true` on all but the
last. No chat yet (or a failed read) → one `{t:"hist", chat, messages: []}`.
Frames go through `_emit`, so **history replies consume `seq`** and are
replayable on `resume`.

**Chat-id resolution (shared by A2/A3).** `GET /api/chats?channel=web` and pick
the `ChatSpec` whose `session_id` equals this channel's
`resolve_session_id("web-user", {chat_id})` (`web:web-user:<chat>`); the result
is cached per chat. The manager creates that `ChatSpec` on the first message.
This is why the stop endpoint gets the resolved id rather than a session id —
its own fallback lookup is hardcoded to `channel="console"`.

**A4 — inbound files.** Each `files[]` `{name, mime, data}` item is
base64-decoded (`util.decode_file_entry`) and POSTed as multipart `file` to
`/api/console/upload`; the returned absolute `url` becomes
`FileContent(filename=<name>, file_url=<url>)`, appended **after** the
`TextContent` in `content_parts`. A bad or failed item is logged and skipped.
Attachment-only turns are supported: the `TextContent` is omitted when the text
is blank, and the channel passes `no_text_debounce=False` to `BaseChannel`
(otherwise a text-less payload is parked until some later text arrives — the
same reason `console_channel.py` disables the debounce).

**A5 — approval ownership.** Before `POST /api/approval/{approve,deny}` the
plugin calls `GET /api/approval/list` and requires the `req_id` to be pending
for this agent (`owner_agent_id`, else `agent_id`, must equal
`self._agent_id()`; neither field present → accepted on presence alone).
Not found, mismatched, or a failed list call → `{t:"error", code:"E_AUTH",
chat, req_id}` via `_emit` and **no POST**.

Remaining deviations are in the table below; everything else (frame names,
per-chat `seq` from 1, ring buffer, `resume`/`resync`) is unchanged. New tests
live in `tests/test_m2.py` and cover every decision above.

## HTTP library for approvals / history / stop / upload

All local QwenPaw API calls use **httpx** with `X-Agent-Id: <bound workspace
agent_id>`:

```
GET  /api/approval/list                      -> pending approvals for the check
POST /api/approval/approve | /deny           {"request_id", "session_id"}
GET  /api/chats?channel=web                  -> ChatSpec[] (chat id lookup)
GET  /api/chats/{ChatSpec.id}                -> ChatHistory (history)
POST /api/console/chat/stop?chat_id=<id>     -> {"stopped": bool}
POST /api/console/upload                     multipart "file" -> {url, file_name, size}
```

`httpx>=0.27.0` is a declared core dependency in QwenPaw's `pyproject.toml`
(line 10), so it adds nothing to install; its `AsyncClient` matches the
asyncio-based channel and gives explicit timeouts. `aiohttp` was rejected as a
direct dependency (even though some channels use it) because the brief requires
core-only libraries, and `urllib`-in-an-executor would need extra thread
plumbing for no benefit. A client is created per call (they are rare) with a
10 s timeout (60 s for uploads); failures are logged and never disconnect the
relay socket.

The `agent_id` comes from `getattr(self._workspace, "agent_id", "default")`
(with no workspace → `"default"`), exactly as `base.py` does it. `agent_id` is
**not** carried in frames for routing: a channel instance is bound to one
workspace.

## Deviations from `docs/design.md` / `tasks/m1-plugin.md`

Followed the real v2.2.2.post1 source where it contradicts the docs.

| Item | Deviation | Reason |
|---|---|---|
| `from_config` signature | Uses `(process, config, on_reply_sent=None, display_config=None, no_text_debounce=True)`. The design sketch's `workspace_dir` is gone. | `BaseChannel.from_config` (`base.py:1261`) has no `workspace_dir`; `ConsoleChannel.from_config` adds `workspace_dir` only for media resolution, which this channel does not need. |
| `enabled` / `bot_prefix` | Not stored or checked by the channel. | Neither is a `BaseChannel.__init__` parameter; the manager only starts enabled channels and this channel never prefixes text. |
| Inbound `sender_id` | Constant `"web-user"`, so sessions are `web:web-user:<chat>`. Design used `user_id`. | Protocol v1 (`frames.md` §2.4) carries `chat` only — there is no user identity to use. |
| Inbound `msg.files[]` | Uploaded through `POST /api/console/upload` and attached as `FileContent(file_url=<absolute path>)` after the `TextContent` (M2 A4). An undecodable entry, or a failed upload, is logged and skipped; the rest of the turn still runs. | The console channel's own attachments are `FileContent(file_url=…)` pointing into the console media dir, and the upload endpoint is what creates exactly that — reusing it avoids a second media location the agent could not read. |
| `stop` frame | `POST /api/console/chat/stop?chat_id=<ChatSpec.id>` (M2 A2). No chat id yet (or a failed lookup/POST) → logged, nothing sent. | The endpoint's session fallback is hard-coded to `channel="console"`, so the resolved `ChatSpec.id` must be passed; the plugin finds it via `GET /api/chats?channel=web` and caches it per chat. |
| `approve` / `deny` body | `{"request_id", "session_id"}` where `session_id` is the pending entry's `root_session_id`, plus `X-Agent-Id` (M2 A5). | `ApprovalActionRequest.session_id` is required and the router rejects anything whose `root_session_id` differs (`router_approval.py`); the M1 body (`request_id` only) could never have been accepted. |
| `req_id` ownership check | `GET /api/approval/list` before the POST; the entry must exist and its `owner_agent_id` (else `agent_id`) must equal this channel's agent. Otherwise, or when the list call fails, `error{code:"E_AUTH", chat, req_id}` is emitted and nothing is POSTed (M2 A5). | Design §8. Only the agent-id check is enforced; the session check is skipped because the pending entry's ids are the agent's own runtime session ids, not the web chat id. |
| `resync` frame | Carries an extra `seq` and is buffered. | `frames.resync_frame` has no `seq` (protocol has none); adding it as an unknown field (allowed by §1) keeps the "every outbound frame has a seq" invariant and replay ordering intact. |
| `evt.data` shape | `{"text": <chunk>, "stream_type": <"reasoning" / "message">}` from `frames.evt_frame`; `start`/`end` also carry a top-level `stream_type`. | The console SSE stream runs two segments, and a browser concatenating both would put the model's thinking into the answer. The discriminator is additive (§7) and documented in `protocol/frames.md` §2.3; a missing `stream_type` still means `message` for older containers. |
| `hist` frame | Implemented (M2 A3) as a new reply type: `{t:"hist", chat, messages:[{role, text}...], more?, seq}`. Unknown chats answer `messages: []`; `limit` (default 50, last N) is honoured, `before` is ignored. | `protocol/frames.md` §2.4 lists `hist` browser→container and leaves the reply to `msg`/`resync`; `msg` cannot carry a typed list and `resync` carries no content, so the agent answers with a `hist` frame instead (additive per §7). It goes through `_emit`, so **`hist` frames consume `seq`** like every other outbound frame. |
| Outgoing media parts | Serialised as `{type, image_url/file_url/file_id/…}` plain dicts inside `msg.parts`; no base64 `file` parts are produced. | v1 file transport (`msg.files[]`) is browser→container; attachments coming back from the agent are M2. |
| `plugin.py` registration | Only `channel_class`, `label`, `description`, `config_fields` — no `icon` / `doc_url`, and exactly two config fields. | `register_channel` (`plugins_api.py:689`) makes `icon`/`doc_url` optional; the brief specifies `relay_url` + `token` only. `config_fields` uses the same `name/label/type/required/placeholder/default` keys as the Azure Bot plugin. |
| Single oversized history message | A message whose own text exceeds the 256 KB frame limit is still sent alone in a `hist` frame (the relay drops it) instead of being truncated. | Truncating would silently rewrite conversation history; file/segment transport for one huge message is v2 work. |

Everything else — frame names/shapes, per-chat `seq` from 1, ring buffer of
400, `resume`/`resync` semantics, approval endpoint paths, and both config
defaults — follows `protocol/frames.md`, `docs/design.md` and
`tasks/m1-plugin.md` unchanged.

## Implementation notes (not deviations)

- `streaming_enabled = True` must be passed to `super().__init__()`:
  `BaseChannel.__init__` assigns `self.streaming_enabled = streaming_enabled`
  (default `False`), which would otherwise shadow the class attribute and
  silently disable all streaming hooks.
- `build_agent_request_from_native` is implemented because
  `BaseChannel._payload_to_request` calls it for dict payloads; without it the
  manager queue path raises `NotImplementedError`.
- Inbound frames go through `self._enqueue(native)` (set by `ChannelManager`
  via `set_enqueue`); the plugin never runs its own consumer loop.
- Tests: `cd plugin && python3 tests/test_diff.py` and
  `cd plugin && python3 tests/test_m2.py` → `ALL PASS` (pytest is not
  required; it collects the same `test_*` functions if installed).
