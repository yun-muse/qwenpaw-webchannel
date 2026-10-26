# relay-cf — hosted WebSocket relay (Cloudflare Worker + Durable Object)

The hosted version of [`../relay-node`](../relay-node): a single Worker that
pairs one **agent** socket (the QwenPaw container / plugin) with many **client**
sockets (the SPA) and forwards frames verbatim. It never parses business
payloads and never stores message content — the only thing it persists is the
offline client→agent buffer.

One Durable Object instance per tenant holds the sockets, so all tabs of a
tenant share the same stream. Socket state (which socket is the agent, which are
clients) is rebuilt from WebSocket attachments after hibernation; the offline
buffer lives in DO storage, so it survives a restart.

Frame definitions: [`../protocol/frames.md`](../protocol/frames.md).

## Routes

| route | auth | purpose |
|---|---|---|
| `POST /api/login` | `{password}` body | exchanges `LOGIN_PASSWORD` for a client token |
| `GET /ws/agent` | `Authorization: Bearer $AGENT_TOKEN` (401 otherwise) | container/plugin socket |
| `GET /ws/client` | `?token=<client token>` (401 otherwise) | browser socket |
| `GET /health` | none | `{ok, agentOnline, clients}` |
| `GET /poll` | none | `501 {error:"not_implemented"}` (deferred, see below) |

`/api/login` is answered by the Worker itself; every other route is forwarded to
the tenant DO.

## Secrets

Set these as Worker secrets (`npx wrangler secret put <NAME>`); locally they come
from `.dev.vars`.

| name | meaning |
|---|---|
| `AGENT_TOKEN` | bearer token the agent (plugin) presents on `/ws/agent`. Must match the token configured in the plugin. If unset, **all** agent connections are rejected. |
| `LOGIN_PASSWORD` | the password a user types in the SPA login form. If unset, `/api/login` returns `500 {error:"login_not_configured"}`. |
| `LOGIN_SECRET` | HMAC-SHA256 key used to sign client tokens (`v1.<expires>.<sig>`, 12 h TTL). Rotating it invalidates every outstanding token. |

`TENANT` is a plain var (`wrangler.toml`), not a secret; it names the DO instance.

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
# {"ok":true,"agentOnline":false,"clients":0}

TOKEN=$(curl -s localhost:8788/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"dev-login-password"}' | sed -e 's/.*"token":"//' -e 's/".*//')
echo "$TOKEN"
# then: ws://localhost:8788/ws/client?token=$TOKEN
```

If your shell sets `HTTP_PROXY`, add `--noproxy '*'` so curl talks to localhost
directly.

## Deploy

Deferred until there is a Cloudflare account for this project:

```bash
npx wrangler login
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put LOGIN_PASSWORD
npx wrangler secret put LOGIN_SECRET
npm run deploy
```

The first deploy applies the `v1` migration that creates the `RelayDO` SQLite
class; do not rename it afterwards without adding a new migration.

## Behaviour

Mirrors `relay-node`:

- One agent socket (a new agent connection closes the old one with code `4000`,
  reason `replaced by new agent connection`) and any number of clients.
- Agent frames are broadcast to all clients; client frames go to the agent.
- Frames must be JSON objects with a string `t`, sent as text, and at most
  **256 KB** UTF-8; otherwise they are dropped and the sender gets
  `{"t":"error","code":"E_TOOBIG"|"E_BADFRAME"}` (with `id` when the frame
  parsed well enough to have one).
- `ping` is answered locally with `{"t":"pong"}` and never forwarded. The exact
  payload `{"t":"ping"}` is answered by the DO's auto-response, so it does not
  even wake the object. An optional agent `hello` gets
  `{"t":"ready","agentOnline":true}` and is not forwarded.
- A new client gets `{"t":"ready","agentOnline":<bool>}`. The agent gets
  `{"t":"peer","clients":<n>}` on connect and whenever a client joins or leaves.
  Clients are **not** told when the agent drops (same as relay-node).
- While the agent is offline, client→agent frames are buffered in DO storage
  (max **500 frames / 1 MB**, oldest dropped first) and flushed in order on the
  next agent attach.

### Rate limit

A per-tenant token bucket lives in DO memory: capacity **30**, refilling at
**30 tokens/s**, applied to every valid frame from either role except `ping`
(both directions share the bucket). A frame over budget is dropped and the
sender gets `{"t":"error","code":"E_BUSY"}`, at most once per second so a burst
does not produce a storm of error frames.

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
