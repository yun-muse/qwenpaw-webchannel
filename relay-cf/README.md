# relay-cf — hosted WebSocket relay (Cloudflare Worker + Durable Object)

The hosted version of [`../relay-node`](../relay-node/README.md): a single Worker that
pairs one **agent** socket (the QwenPaw container / plugin) with many **client**
sockets (the SPA) and forwards frames verbatim. It never parses business
payloads and never stores message content — the only thing it persists is the
offline client→agent buffer.

One Durable Object instance per tenant holds the sockets, so all tabs of a
tenant share the same stream. Socket state (which socket is the agent, which are
clients, and the winning agent's generation) is rebuilt from WebSocket
attachments after hibernation; the offline buffer lives in DO storage, so it
survives a restart.

Frame definitions: [`../protocol/frames.md`](../protocol/frames.md).

## Routes

| route | auth | purpose |
|---|---|---|
| `POST /api/login` | `{password}` body | exchanges `LOGIN_PASSWORD` for a client token |
| `GET /ws/agent` | `Authorization: Bearer $AGENT_TOKEN` (401 otherwise) | container/plugin socket |
| `GET /ws/client` | `?token=<client token>` (401 otherwise) | browser socket |
| `GET /health` | none | `{ok, agentOnline, clients, agentLastSeen}` |
| `GET /poll` | none | `501 {error:"not_implemented"}` (deferred, see below) |

`/api/login` is answered by the Worker itself (with CORS headers, because the
SPA logs in cross-origin); every other route is forwarded to the tenant DO.

`agentLastSeen` is the epoch-millisecond timestamp of the last **business**
frame from the current agent socket, or `null` when no agent has spoken since
the object was built (or since the agent socket was forgotten). It is
in-memory only (a hibernation rebuild starts it at 0 again) and is a liveness
hint, not persisted state. `ping` and `hb` never stamp it.

## Secrets

Set these as Worker secrets (`npx wrangler secret put <NAME>`); locally they come
from `.dev.vars`.

| name | meaning |
|---|---|
| `AGENT_TOKEN` | bearer token the agent (plugin) presents on `/ws/agent`. Must match the token configured in the plugin. If unset, **all** agent connections are rejected. |
| `LOGIN_PASSWORD` | the password a user types in the SPA login form. If unset, `/api/login` returns `500 {error:"login_not_configured"}`. |
| `LOGIN_SECRET` | HMAC-SHA256 key used to sign client tokens (`v1.<expires>.<sig>`, **30 day** TTL). Rotating it invalidates every outstanding token. |

`TENANT` is a plain var (`wrangler.toml`), not a secret; it names the DO
instance. The deployment is single-tenant: every non-login route uses the same
DO.

## Client tokens

`POST /api/login` compares the body password with `LOGIN_PASSWORD` without an
early exit (length first), and mints `v1.<expires>.<sig>`, where `expires` is
Unix seconds (30 days from now) and the signature is
`HMAC-SHA256(LOGIN_SECRET, "v1.<expires>")`, base64url-encoded. `/ws/client`
verifies the version, expiry and signature on every upgrade. The browser cannot
set headers on a WebSocket handshake, so the token rides as the `?token=` query
parameter.

## Local dev

```bash
cd relay-cf
npm install
cp .dev.vars.example .dev.vars   # fake dev values; .dev.vars is gitignored
npm run dev                      # http://localhost:8788
```

`npm run dev` is `wrangler dev --local --port 8788`.
`wrangler` uses Miniflare, so no Cloudflare account or network is needed.

Smoke check:

```bash
curl -s localhost:8788/health
# {"ok":true,"agentOnline":false,"clients":0,"agentLastSeen":null}

TOKEN=$(curl -s localhost:8788/api/login \
  -H 'content-type: application/json' \
  -d "{\"password\":\"$LOGIN_PASSWORD\"}" | sed -e 's/.*"token":"//' -e 's/".*//')
echo "$TOKEN"
# then: ws://localhost:8788/ws/client?token=$TOKEN
```

If your shell sets `HTTP_PROXY`, add `--noproxy '*'` so curl talks to localhost
directly.

## Deploy

```bash
npx wrangler login
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put LOGIN_PASSWORD
npx wrangler secret put LOGIN_SECRET
npm run deploy
```

The first deploy applies the `v1` migration that creates the `RelayDO` SQLite
class; do not rename it afterwards without adding a new migration.

**Rollout order for heartbeat changes:** deploy `relay-cf` **before**
reinstalling/restarting the plugin. An old relay does not understand `hb`, so a
new plugin would reconnect-loop instead of healing
([`../docs/m7.3-report.md`](../docs/m7.3-report.md)).

## Behaviour

### Sockets and hibernation

- Sockets are accepted with `ctx.acceptWebSocket()` and tagged with a
  serialized attachment (`{role: 'agent'|'client', won?, started?, session?}`),
  so hibernation can rebuild the bookkeeping without closing anything.
- One agent socket owns the slot; any number of clients.
- On hibernation wake the DO scans `getWebSockets()`: the agent socket with the
  greatest `started` wins (legacy attachments count as generation 0; ties go to
  the last one), and every `role: 'client'` socket is re-added to the client
  set. No socket is closed during the rebuild.

### Agent slot generations

The slot is won at **hello** time, not at the WebSocket upgrade:

- An upgrade is parked; the `hello` frame carries `started` (client
  construction time in wall-clock microseconds) and `session`.
- A `hello` older than the current holder is **superseded**: that socket is
  closed with code `4000`, reason `superseded by newer agent connection`, and
  the holder is not disturbed.
- A newer-or-equal `hello` **wins**: the previous agent is closed with `4000`,
  reason `replaced by new agent connection`; the relay sends `peer`, flushes
  the offline buffer, then answers `ready`.
- A `hello` from the socket that already owns the slot just refreshes its
  generation metadata and answers `ready`.
- Legacy hellos without `started` count as generation 0.

A plugin closed with `4000` treats it as fatal and never reconnects — the newer
instance owns the slot.

### Frames

- Frames must be JSON objects with a string `t`, sent as text, and at most
  **256 KB** UTF-8; otherwise they are dropped and the sender gets
  `{"t":"error","code":"E_TOOBIG"|"E_BADFRAME"}` (with `id` when the frame
  parsed well enough to have one).
- Only the agent that owns the slot may broadcast; frames from parked or
  superseded agent sockets are dropped.
- Agent frames are broadcast to all clients; client frames go to the agent.
- A new client gets `{"t":"ready","agentOnline":<bool>}`. The agent gets
  `{"t":"peer","clients":<n>}` on winning the slot and whenever a client joins
  or leaves. Clients are **not** told when the agent drops (same as
  relay-node).

### `ping` and `hb`

- `ping` is answered locally with `{"t":"pong"}` and never forwarded. The exact
  payload `{"t":"ping"}` is answered by the DO's auto-response
  (`setWebSocketAutoResponse`), so it does not even wake the object. This is
  why `ping` cannot prove the agent path is alive: Cloudflare answers it at the
  edge.
- `hb` is the end-to-end heartbeat. After envelope validation and before the
  rate-limit bucket, the DO answers the **slot holder** with
  `{"t":"hb_ack","id":<same id>}` and returns. It costs no bucket token, is
  never forwarded, and never stamps `agentLastSeen`. A parked or superseded
  socket gets no ack on purpose: it should notice the misses, reconnect, and be
  told `4000` if it is genuinely stale.
- The plugin sends `hb` every 15 s, expects the ack within 10 s, and reconnects
  after 2 consecutive misses.

### Offline buffer

While the agent is offline, client→agent frames are buffered in DO storage
(max **500 frames / 1 MB**, oldest dropped first) and flushed in order on the
next winning `hello`. The buffer is persisted as a single `outbox` key and
deleted when empty.

### Rate limit

A per-tenant token bucket lives in DO memory: capacity **30**, refilling at
**30 tokens/s**, applied to every valid frame from either role except `ping`
and `hb` (both directions share the bucket). A frame over budget is dropped and
the sender gets `{"t":"error","code":"E_BUSY"}`, at most once per second so a
burst does not produce a storm of error frames.

Two consequences worth knowing: the bucket resets when the DO hibernates or
restarts, and since it is per tenant (not per socket) one chatty tab can use up
the budget for everyone on that tenant.

## /poll — deferred

`GET /poll` returns `501 {error:"not_implemented"}` deliberately. v1 has exactly
one transport, the WebSocket pair, and `relay-node` exposes no `/poll` either, so
there is no consumer to design an API for. The route exists (and says so
explicitly) only so a long-poll fallback can be added later without changing the
route table or having clients wonder whether it is missing by accident. Any
implementation would need cursor semantics for the offline buffer, which is a
protocol decision, not a relay implementation detail.

## Typecheck

Wrangler bundles TypeScript itself (esbuild, types stripped). To typecheck
without emitting:

```bash
npx tsc --noEmit
```

`tsconfig.json` is `ES2022` / `ESNext` / `bundler` with
`@cloudflare/workers-types` globals and `strict: false`.

## Related docs

- Plugin side: [`../plugin/README.md`](../plugin/README.md)
- Protocol: [`../protocol/frames.md`](../protocol/frames.md)
- Hosted deploy record: [`../docs/m3-deploy-cf.md`](../docs/m3-deploy-cf.md)
