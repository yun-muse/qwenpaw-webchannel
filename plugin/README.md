# WebChannel plugin (QwenPaw)

A QwenPaw channel that connects **outbound** to the WebChannel relay
(`/ws/agent`) and bridges it to the agent. The browser never talks to the
container directly: it connects to the relay, which forwards frames verbatim
([`../protocol/frames.md`](../protocol/frames.md)). No inbound port and no
third-party dependency beyond what QwenPaw core already ships.

- Target: QwenPaw **2.2.0 – 2.3.0** (`qwenpaw_version` in `plugin.json`).
- `dependencies` is deliberately empty: `websockets>=15.0.1,<16` and
  `httpx>=0.27.0` are QwenPaw core dependencies, so installation never runs
  pip.
- One plugin instance per agent workspace; each dials with its own
  `hello{agent: <workspace.agent_id>}`.

## Install

### Build the ZIP

```bash
bash tools/package_plugin.sh        # → dist/webchannel.zip
```

The archive is reproducible (fixed timestamps/mode, explicit allowlist) and
`plugin.json` sits at its **root**, which is what QwenPaw's installer expects.
`tests/`, `__pycache__/` and `*.pyc` are never packaged.

### A. Hosted container — the proven route

The console's Install dialog resolves its "or from URL" field inside the
container, and it accepts a **local path**. So the ZIP has to be on the
container's filesystem first. This four-step route is the one verified
end-to-end (most recently in M15):

1. **Build and host the ZIP.**

   ```bash
   bash tools/package_plugin.sh        # → dist/webchannel.zip
   md5sum dist/webchannel.zip
   ```

   Publish `dist/webchannel.zip` to the Cloudflare Pages project
   `qwenpaw-plugin-dist`, which serves it at
   `https://qwenpaw-plugin-dist.pages.dev/webchannel.zip`. Download it back and
   compare the MD5 with the local file — a stale or partial upload otherwise
   installs the previous build:

   ```bash
   curl -fsSL https://qwenpaw-plugin-dist.pages.dev/webchannel.zip | md5sum
   ```

2. **Stage it inside the container.** Open the QwenPaw console → **Web
   Terminal** and fetch/unpack the hosted ZIP there:

   ```bash
   mkdir -p ~/webchannel-staging
   curl -fsSL https://qwenpaw-plugin-dist.pages.dev/webchannel.zip -o /tmp/webchannel.zip
   unzip -o /tmp/webchannel.zip -d ~/webchannel-staging
   ls ~/webchannel-staging/plugin.json
   ```

3. **Uninstall, then install from the staging path.** Console → Plugins →
   **Uninstall** `webchannel` first (reinstalling over a loaded plugin is
   refused or leaves the old build loaded). Then open **Install** and enter the
   staging directory in the **"or from URL"** field — it takes a local path:

   ```
   ~/webchannel-staging
   ```

   That directory must contain `plugin.json` at its root, which is exactly how
   the archive is laid out.

4. **Verify, then restart.** `GET /api/plugins` lists `webchannel` with
   `"loaded": true`, and Console → Control → Channels shows the **Web** card
   with its *Relay URL* / *Agent Token* fields. Then perform a platform
   **Restart**.

> **Do not** copy the bare plugin directory into `PLUGINS_DIR`
> (`WORKING_DIR/plugins/webchannel`) and restart. The module may import, but the
> per-agent channel registration never runs: the **Web** card never appears and
> the channel stays wedged, and a restart does not repair it. Directory-copy +
> restart is **not** a working fallback.

### B. Local install

For a local-dev QwenPaw running on the same machine, point `source` at the
directory containing `plugin.json` — this `plugin/` directory, not the repo
root:

```bash
curl -X POST localhost:8088/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"/path/to/repo/plugin","force":true}'
```

This only works because the path resolves on that QwenPaw's own filesystem; a
hosted container needs the staging route in A. Restart QwenPaw after the install
reports success — installs are not relied on to hot-reload the running process.

### Enable the channel

Enable **Web** on the agent that should be reachable and fill the fields, or
add them to the agent config:

```yaml
channels:
  web:
    enabled: true
    relay_url: "wss://<relay-host>/ws/agent"
    token: "<AGENT_TOKEN>"
    turso_url: ""
    turso_token: ""
```

`token` must equal the relay's `AGENT_TOKEN` exactly. It is sent both as the
`Authorization: Bearer` upgrade header and in `hello`.

## Configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `relay_url` | text | `ws://127.0.0.1:8787/ws/agent` | relay agent endpoint |
| `token` | password | non-secret local-dev placeholder (see `plugin.py`) | agent token; must match the relay's `AGENT_TOKEN` |
| `turso_url` | text | empty | Turso/libSQL database URL for archiving + search |
| `turso_token` | password | empty | Turso token; both halves are required or archiving/search stay off |

Defaults are applied when a field is missing/empty, so a `SimpleNamespace`
config without the keys still starts. `start()` dials the relay; `stop()`
closes it and stops the archiver.

## Modules

| File | Purpose |
|---|---|
| `plugin.json` | manifest (`id: webchannel`, `type: channel`, entry `plugin.py`) |
| `plugin.py` | registration: label, description, four config fields; patches the skill whitelist so built-in `console` skills also resolve on `web` |
| `channel.py` | `WebChannel(BaseChannel)`: relay dispatch, streaming hooks, local API calls (stop / history / approvals / upload / models / thinking / usage / export / search / chats / prompts / skills) |
| `relay_client.py` | `websockets` client: bearer auth, `hello`, `hb` heartbeat, supervised reconnect, ordered send queue |
| `frames.py` | frame builders + parser; 256 KB size check; re-exports the pure helpers from `util.py` |
| `util.py` | stdlib-only helpers: `StreamDiffer`, `SeqCounter`, `RingBuffer`, `FileTransfers`, `SessionUsageStore`, model projection, effort mapping, Markdown export |
| `turso_archive.py` | best-effort archiver: bounded queue, two attempts, then drop |
| `turso_search.py` | read-only `/v2/pipeline` search (COUNT + one page, parameterised `LIKE`) |
| `filelog.py` | rotating, never-raising lifecycle log |
| `tests/` | plain-python suites (no pytest required) |

## Connection lifecycle

`start()` creates one `RelayClient` and returns; the client owns a supervisor
that restarts the connection loop after any non-fatal exit.

- **Handshake.** After the WebSocket upgrade the plugin sends
  `hello{token, instance, agent, session, started}`. The relay parks the
  socket until `hello` and then awards the single agent slot **by
  generation**: `started` is the client's construction time (wall-clock
  microseconds) and `session` is a per-instance id.
- **Slot generations.** An older `hello` is *superseded*: the relay closes
  that socket with code `4000` and does not disturb the current holder. A
  newer-or-equal `hello` wins the slot and closes the previous socket with
  `4000` ("replaced by new agent connection"). A `RelayClient` closed with
  `4000` treats it as fatal and never reconnects — this is what stops the
  post-reload replacement war when an old workspace's `stop()` arrives late.
- **Heartbeat (`hb` / `hb_ack`).** The app-level `ping` cannot prove the
  agent ↔ relay path: Cloudflare answers `{"t":"ping"}` at the edge (and
  protocol pings in its front end), so a silent tunnel still looks healthy.
  The plugin sends `{"t":"hb","id":"hb-<n>"}` every **15 s**, expects a
  matching `hb_ack` within **10 s**, and reconnects after **2 consecutive
  misses**. A miss is retried after 2 s rather than a full interval. `hb` is
  never forwarded, never stamps `agentLastSeen`, costs no rate-limit token on
  `relay-cf`, and is acked **only by the slot holder** — parked generations
  stay in the dark on purpose.
- **Transport keepalive.** WebSocket-level ping/pong is 20 s / 20 s, and
  every `ws.send()` is bounded by a 10 s timeout. Reader, writer and
  heartbeat run under `asyncio.wait(FIRST_COMPLETED)`; whichever ends, the
  whole connection phase is torn down and retried.
- **Reconnect.** Exponential backoff 1 s → 30 s. Only close `4000`, a
  connection-level `E_AUTH`, HTTP 401/403 on the upgrade, or an explicit
  `stop()` are fatal. Everything else reconnects.
- **Queue.** Outbound frames wait in a 1000-entry queue and flush in order
  after a reconnect; the oldest frame is dropped when the queue is full. A
  frame over 256 KB is dropped with a log line.

## What the channel implements

- **Streaming.** `on_streaming_delta` receives *cumulative* text, so
  `StreamDiffer` sends only the new suffix. `start` / `evt` / `end` carry
  `stream_type` (`reasoning` or `message`); the answer segment is closed with
  a trailing full-text `msg`, because QwenPaw's base channel consumes the
  completed message event and `send()` never runs for a streamed reply.
  Reasoning segments get no trailing `msg`.
- **History.** `hist` resolves the web chat to its `ChatSpec.id` via
  `GET /api/chats?channel=web`, reads `GET /api/chats/{id}`, and packs the
  `{role, text, turn?}` projection into one or more ≤256 KB frames
  (`more:true` on all but the last). History frames consume `seq` and are
  replayable.
- **Files.** v1 inline `files[]` are base64-decoded and uploaded through
  `POST /api/console/upload`; v2 chunked uploads are assembled by
  `FileTransfers` (96 KB raw per chunk, 10 MB per file, 10 min TTL, sha256 +
  size verification, one-shot `{"ref": id}`).
- **Models / effort.** `models` and `set_model` mirror the console's
  eligibility rules and never put credential fields on the wire. Effort
  levels are `default|low|medium|high|max`; budget models receive
  `{"level":"budget","budget_tokens":N}` computed from
  `[budget_min, budget_max]`, effort models only levels listed in
  `control.efforts`.
- **Usage.** `get_usage` reads `<workspace>/sessions/web/*.json` (cached by
  mtime/size), sums each assistant turn's `qwenpaw_turn_usage.usage`, and
  reports the newest reply's receipt as `last_turn`. Unknown fields are
  omitted, never zero-filled; the handler always answers.
- **Export / search.** `export` builds Markdown from the raw `ChatHistory` and
  streams it as control frames with a sha256 and a 10 MB ceiling. `search`
  answers from the Turso archive with snippets only.
- **Chats / prompts / skills.** `chats` (server list), `del_chat` (deletes the
  server-side `ChatSpec`), `get_prompts` / `set_prompt` (the four workspace
  Markdown files) and `skills` are served by the channel; all replies are
  control frames. `rename_chat` only acknowledges with `chat_renamed` — the
  custom title lives in the SPA's localStorage, not on the server.

## Local QwenPaw API

All calls use **httpx** with `X-Agent-Id: <bound workspace agent_id>` and a
10 s timeout (60 s for uploads). A failure is logged and never disconnects the
relay socket.

```
GET  /api/approval/list                         pending approvals (ownership check)
POST /api/approval/approve | /deny              {"request_id", "session_id"}
GET  /api/chats?channel=web                     ChatSpec[] (chat id lookup)
GET  /api/chats/{ChatSpec.id}                   ChatHistory
POST /api/console/chat/stop?chat_id=<id>        stop the running turn
POST /api/console/upload                        multipart "file" -> {url, ...}
GET  /api/models                                provider list (projected before sending)
GET  /api/models/active?scope=effective         active model + context window
PUT  /api/models/active                         switch the agent's model
GET  /api/chats/{id}/thinking                   session effort view
PUT  /api/chats/{id}/thinking                   persist an effort level
GET  /api/agents/{id}                           display name
GET  /api/skills                                skill list
```

Approval POSTs need both `request_id` and `session_id` (the pending entry's
`root_session_id`); the plugin first checks that `req_id` is pending for this
agent (`owner_agent_id`, else `agent_id`). A refusal is
`error{code:"E_AUTH", chat, req_id}` — a card error, not a connection error.

## File log

`start()` creates `<workspace>/webchannel.log` (falling back to the plugin
directory when there is no workspace) and mirrors the relay lifecycle into
it: `connect`, `hello`, `phase_end`, `close`, `reconnect`,
`supervisor_restart`, `hb_miss`, `fatal`, `channel_start`, `channel_stop`.

`FileLog` is best-effort by contract: `write()` catches everything and never
raises, so a full disk or a bogus path can never break the channel. Rotation
is 256 KB per file with two backups (`webchannel.log.1`, `.2`).

## Tests

Plain-python assert scripts; pytest is **not** required (it collects the same
`test_*` functions if installed):

```bash
cd plugin
python3 tests/test_diff.py    # StreamDiffer / SeqCounter / RingBuffer
python3 tests/test_m2.py      # A1/A3/A4/A5 decisions
python3 tests/test_m5.py      # chunked file transfer
python3 tests/test_turso.py   # archiver + search builders
python3 tests/test_m7.py      # models / set_model
python3 tests/test_m71.py     # slot generations
python3 tests/test_m72.py     # self-healing relay client
python3 tests/test_m73.py     # hb heartbeat
python3 tests/test_m8.py      # chats / prompts / skills
python3 tests/test_m9.py      # effort mapping
python3 tests/test_m11.py     # usage store
python3 tests/test_m12.py     # Markdown export
python3 tests/test_m13.py     # archive search
python3 tests/test_m15.py     # per-turn receipts / context meter
```

Each prints `ALL PASS` and exits non-zero on failure. The `channel`-importing
suites need `httpx` and `websockets` available (QwenPaw core provides both).

## Protocol notes worth knowing

- `resume` replays frames with the **original** `seq`; a miss sends
  `resync{chat, reason:"gap"}` (with an extra `seq`, which the protocol
  permits as an unknown field).
- `hist` is an additive reply type; `messages` is a typed list that `msg`
  cannot carry.
- `E_AUTH` is overloaded: no `chat`/`req_id` means connection-level (stop
  reconnecting); with those fields it is the plugin refusing an approval.
- `models` / `model_changed` / `status` / `effort` / `usage` / `export_*` /
  `search_results` are control frames: no `seq`, no ring buffer, no replay.

Deployment steps and the hosted rollout order are in
[`../docs/m3-plan.md`](../docs/m3-plan.md) and
[`../docs/m7.3-report.md`](../docs/m7.3-report.md).
