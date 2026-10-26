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
| `channel.py` | `WebChannel(BaseChannel)`: relay I/O, streaming, approvals |
| `frames.py` | frame builders/parser (`protocol/frames.md`), size check |
| `util.py` | pure helpers: `StreamDiffer`, `SeqCounter`, `RingBuffer` |
| `relay_client.py` | `websockets` client: hello/auth, heartbeat, backoff, queue |
| `tests/test_diff.py` | plain-python tests for the helpers (no pytest needed) |

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
2. Only a non-empty suffix becomes `{"t":"evt","chat":…,"seq":…,"data":{"text":chunk}}`;
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

## HTTP library for approvals

`approve` / `deny` frames are forwarded to the local API with **httpx**:

```
POST http://127.0.0.1:8088/api/approval/approve   (or /deny)
X-Agent-Id: <bound workspace agent_id>
{"request_id": "<req_id>"}
```

`httpx>=0.27.0` is a declared core dependency in QwenPaw's `pyproject.toml`
(line 10), so it adds nothing to install; its `AsyncClient` matches the
asyncio-based channel and gives explicit timeouts. `aiohttp` was rejected as a
direct dependency (even though some channels use it) because the brief requires
core-only libraries, and `urllib`-in-an-executor would need extra thread
plumbing for no benefit. A client is created per approval call (they are rare)
with a 10 s timeout; failures are logged and never disconnect the relay socket.

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
| Inbound `msg.files[]` | Logged and ignored (text still delivered). | Base64 decode → `media_dir` → `FileContent` is M2 work; v1 goal is text streaming. |
| `stop` frame | Logged at warning, no cancellation. | `BaseChannel` / the workspace expose no documented cancel-by-chat API in the reference (`task_tracker` only shows `attach_or_start` / `stream_from_queue`). Native `/stop` command or M2. |
| `approve` / `deny` body | `{"request_id": ...}` plus `X-Agent-Id`. | The approve/deny endpoint's request schema is not in the reference copies; `request_id` is the field the approval service keys on. |
| `req_id` ownership check | Not implemented (no cross-session validation). | Design §8 asks for it, but the reference copies expose no approval registry to check against; the local API still enforces request-id validity. M2. |
| `resync` frame | Carries an extra `seq` and is buffered. | `frames.resync_frame` has no `seq` (protocol has none); adding it as an unknown field (allowed by §1) keeps the "every outbound frame has a seq" invariant and replay ordering intact. |
| `evt.data` shape | `{"text": <chunk>}` only, from `frames.evt_frame`; both `reasoning` and `message` deltas produce `evt` frames, with no `stream_type` discriminator (so reasoning text, when the agent emits it, shares the bubble). | `frames.py` (M0) fixed the data shape; adding a field would change the shared M0 protocol. |
| `hist` frame | Not implemented; unknown inbound frames are ignored. | History is M2; protocol §1 says unknown types should be ignored. |
| Outgoing media parts | Serialised as `{type, image_url/file_url/file_id/…}` plain dicts inside `msg.parts`; no base64 `file` parts are produced. | v1 file transport (`msg.files[]`) is browser→container; attachments coming back from the agent are M2. |
| `plugin.py` registration | Only `channel_class`, `label`, `description`, `config_fields` — no `icon` / `doc_url`, and exactly two config fields. | `register_channel` (`plugins_api.py:689`) makes `icon`/`doc_url` optional; the brief specifies `relay_url` + `token` only. `config_fields` uses the same `name/label/type/required/placeholder/default` keys as the Azure Bot plugin. |
| `channel.py` size | Under 400 lines. | none |

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
- Tests: `cd plugin && python3 tests/test_diff.py` → `ALL PASS` (pytest is not
  required; it collects the same `test_*` functions if installed).
