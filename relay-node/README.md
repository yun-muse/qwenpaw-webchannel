# relay-node — local-dev WebSocket relay (M0)

A tiny, dependency-light (`ws` only) stand-in for the Cloudflare Durable Object relay in
`docs/design.md` §5.2. It pairs one agent socket with many client sockets and forwards frames
verbatim; it never parses business payloads.

Node.js **>= 20** required.

## Run

```bash
cd relay-node
npm install
npm start
# relay-node listening on :8787 (agent token: dev default)
```

Environment:

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | HTTP/WS listen port |
| `AGENT_TOKEN` | `dev-agent-token` | required `Authorization: Bearer <token>` for `/ws/agent` |

Health check:

```bash
curl -s localhost:8787/health
# {"ok":true,"agentOnline":false,"clients":0}
```

If your shell sets `HTTP_PROXY`, add `--noproxy '*'` so curl talks to localhost directly.

## Routes

| route | auth | purpose |
|---|---|---|
| `GET /ws/agent` | `Authorization: Bearer $AGENT_TOKEN` (401 otherwise) | container/plugin socket |
| `GET /ws/client` | none in local dev (`?token=` accepted and ignored) | browser socket |
| `GET /health` | none | `{ok, agentOnline, clients}` |

## Behaviour

- One agent socket (a new agent connection replaces the old one) and any number of clients.
- Every agent frame is broadcast to all connected clients; client frames go to the agent.
- Frames must be JSON objects with a string `t`, encoded as text, and at most **256 KB**;
  otherwise the frame is dropped and the sender gets `{"t":"error","code":"E_TOOBIG"|"E_BADFRAME"}`.
- `ping` is answered locally with `{"t":"pong"}` and never forwarded. An optional agent `hello`
  gets `{"t":"ready","agentOnline":true}`.
- A new client gets `{"t":"ready","agentOnline":<bool>}`. The agent gets
  `{"t":"peer","clients":<n>}` on connect and whenever a client joins or leaves.
- While the agent is offline, client→agent frames are buffered (max **500 frames / 1 MB**, oldest
  dropped first) and flushed in order on agent reconnect.
- Rate limiting (30 frames/s per tenant, see `protocol/frames.md`) is specified for the hosted
  relay; this local relay does **not** enforce it.

Frame definitions: [`../protocol/frames.md`](../protocol/frames.md).

## Test

```bash
npm test
```

`test/smoke.mjs` starts the relay on port `18787`, connects a fake agent and client, checks
client→agent delivery, 20 ordered `evt` frames agent→client, and offline buffering. Prints
`PASS` or `FAIL` and exits non-zero on failure.
