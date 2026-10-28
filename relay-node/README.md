# relay-node — local-dev WebSocket relay (M0)

A tiny, dependency-light (`ws` only) stand-in for the Cloudflare Durable Object relay in
[`../docs/design.md`](../docs/design.md) §5.2. It pairs one agent socket with many client sockets and forwards frames
verbatim; it never parses business payloads.

Node.js **>= 20** required. It is a development tool: no client authentication, no rate limit,
no persistence.

## Run

```bash
cd relay-node
npm install
npm start
# relay-node listening on :8787
```

Environment:

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | HTTP/WS listen port |
| `AGENT_TOKEN` | local-dev placeholder | required `Authorization: Bearer <token>` for `/ws/agent` |

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

- **Agent slot by generation.** The upgrade parks the socket; the slot is won at `hello` time.
  An older `hello` (`started` lower than the holder) is closed with code `4000`, reason
  `superseded by newer agent connection`, and does not disturb the holder. A newer-or-equal
  `hello` wins and closes the previous agent with `4000`, reason
  `replaced by new agent connection`. Legacy hellos count as generation 0.
- Every agent frame is broadcast to all connected clients; client frames go to the agent.
- Frames must be JSON objects with a string `t`, encoded as text, and at most **256 KB**;
  otherwise the frame is dropped and the sender gets `{"t":"error","code":"E_TOOBIG"|"E_BADFRAME"}`.
- `ping` is answered locally with `{"t":"pong"}` and never forwarded. An optional agent `hello`
  gets `{"t":"ready","agentOnline":true}`.
- `hb` (the M7.3 end-to-end beat) is acked with `{"t":"hb_ack","id":…}` **only for the slot
  holder**; `hb` is never forwarded, and a client-sent `hb` is dropped. This is lockstep with
  `relay-cf`.
- A new client gets `{"t":"ready","agentOnline":<bool>}`. The agent gets
  `{"t":"peer","clients":<n>}` on winning the slot and whenever a client joins or leaves.
- While the agent is offline, client→agent frames are buffered in memory (max **500 frames /
  1 MB**, oldest dropped first) and flushed in order on agent reconnect.
- Rate limiting (30 frames/s per tenant, see `protocol/frames.md`) is specified for the hosted
  relay; this local relay does **not** enforce it.
- `/health` has no `agentLastSeen` field; that is a `relay-cf`-only liveness hint.

Frame definitions and the slot/heartbeat rules: [`../protocol/frames.md`](../protocol/frames.md).
Differences from the hosted relay: [`../relay-cf/README.md`](../relay-cf/README.md).

## Test

```bash
npm test
```

`test/smoke.mjs` starts the relay on port `18787`, connects a fake agent and client, checks
client→agent delivery, 20 ordered `evt` frames agent→client, and offline buffering. Prints
`PASS` or `FAIL` and exits non-zero on failure.
