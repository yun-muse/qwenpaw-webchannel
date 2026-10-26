# Task M3-1 — relay-cf/: Cloudflare Worker + Durable Object relay

Port `relay-node/server.js` (read it, plus `protocol/frames.md`) to a Cloudflare
Worker + Durable Object in a NEW directory `relay-cf/`. Semantics must match
relay-node exactly, plus login auth and a rate limiter (below). TypeScript,
minimal types. Do not modify relay-node, protocol, plugin, or spa.

## Files to create

- `relay-cf/package.json` — name `qwenpaw-webchannel-relay-cf`, private,
  scripts: `dev`: `wrangler dev --local`, `deploy`: `wrangler deploy`.
  devDependencies: `wrangler` (^4) and `@cloudflare/workers-types` (^4).
- `relay-cf/tsconfig.json` — target ES2022, module ESNext, moduleResolution
  bundler, types `["@cloudflare/workers-types"]`, strict false is fine.
- `relay-cf/wrangler.toml`:
  ```toml
  name = "qwenpaw-webchannel-relay"
  main = "src/index.ts"
  compatibility_date = "2025-09-01"

  [vars]
  TENANT = "main"

  [[durable_objects.bindings]]
  name = "RELAY"
  class_name = "RelayDO"

  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["RelayDO"]
  ```
- `relay-cf/.dev.vars.example` — placeholder values for AGENT_TOKEN,
  LOGIN_PASSWORD, LOGIN_SECRET (clearly fake, e.g. `dev-agent-token`,
  `dev-login-password`, `dev-login-secret-change-me`).
- `relay-cf/.gitignore` — `node_modules/`, `.wrangler/`, `.dev.vars`.
- `relay-cf/src/index.ts` — the whole implementation (Worker + DO in one file).
- `relay-cf/README.md` — what it is; secrets table (AGENT_TOKEN = agent bearer
  token, also configured in the plugin; LOGIN_PASSWORD = password the user
  types in the SPA login form; LOGIN_SECRET = HMAC key for client tokens);
  local dev (`npm i`, copy `.dev.vars.example` to `.dev.vars`,
  `npm run dev` → :8788); deploy (later, needs a CF account:
  `npx wrangler login`, `npx wrangler secret put AGENT_TOKEN` etc.,
  `npm run deploy`); the /poll deferral note (below); rate limit note.

## Worker (fetch handler) behaviour

Env: `RELAY` (DO namespace), `TENANT` (var), `AGENT_TOKEN`, `LOGIN_PASSWORD`,
`LOGIN_SECRET` (secrets).

Tenant stub for ALL routes below: `env.RELAY.get(env.RELAY.idFromName(env.TENANT || "main"))`.

- `POST /api/login` — NOT forwarded to the DO; handled in the Worker.
  - Parse JSON body `{password}`. Missing/invalid JSON → 400 `{error:"bad_request"}`.
  - If `LOGIN_PASSWORD` secret is unset → 500 `{error:"login_not_configured"}`.
  - Compare with the secret (plain compare is acceptable; length-check first).
    Mismatch → 401 `{error:"bad_password"}`.
  - Match → 200 `{token, expires}` where `expires` is a Unix-seconds timestamp
    12h ahead and the token is `v1.<expires>.<sig>`; `sig` = base64url of
    HMAC-SHA256(key = LOGIN_SECRET, message = `v1.<expires>`), computed with
    WebCrypto (`crypto.subtle`).
  - CORS: respond to `OPTIONS` preflight with 204 and
    `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, GET, OPTIONS`,
    `Access-Control-Allow-Headers: content-type, authorization`. Add
    `Access-Control-Allow-Origin: *` to the login response too.
- All other paths (`/ws/agent`, `/ws/client`, `/health`, `/poll`) forward to
  the tenant DO stub (`return stub.fetch(request)`).

Client-token validation helper (used by the DO for `/ws/client`):
parse `v1.<exp>.<sig>`, reject when malformed, `exp` in the past, or signature
mismatch (recompute HMAC with LOGIN_SECRET, compare). Export/share it inside
the same file (the DO is in the same file/module).

## Durable Object `RelayDO` (extends `DurableObject` from `cloudflare:workers`)

State (in-memory, rebuilt on wake):
- `agent: WebSocket | null`, `clients: Set<WebSocket>`.
- Constructor: `state.blockConcurrencyWhile(async () => { ... })` — call
  `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'))`,
  then rebuild: for each `state.getWebSockets()` socket, read
  `socket.deserializeAttachment()` → `{role}` and repopulate agent/clients.
- Offline buffer in DO storage under key `"outbox"`: a JSON array of frame
  strings. Load lazily / keep a cached copy in memory, persist on change.

`fetch(request)` in the DO:
- `GET /health` → JSON `{ok:true, agentOnline, clients}` (200, content-type json).
- `GET /poll` → 501 `{error:"not_implemented"}` (deferred: WS is the only
  transport in v1, same as relay-node; the README explains why).
- `GET /ws/agent` — require header `Authorization: Bearer <AGENT_TOKEN>`
  (env secret; if the secret is unset, reject everything). Mismatch → 401
  plain response, no upgrade. Match → create `WebSocketPair`, 
  `state.acceptWebSocket(server)`, `server.serializeAttachment({role:"agent"})`,
  then do the agent-attach steps (below) and return 101 with `webSocket: client`.
- `GET /ws/client` — require a valid client token in the query string
  (`?token=...`, browsers cannot set WS headers). Invalid/missing → 401.
  Valid → same upgrade flow with `{role:"client"}` + client-attach steps.
- Anything else → 404 `{error:"not_found"}`.

Attach steps (mirror relay-node):
- Agent attach: if an existing agent socket is open, close it with
  code 4000 reason "replaced by new agent connection". Set agent, send
  `{t:"peer", clients:<n>}`, then flush the outbox in order (send each stored
  frame string, then clear storage).
- Client attach: add to clients, send `{t:"ready", agentOnline:<bool>}`,
  notify agent `{t:"peer", clients:<n>}`.

`webSocketMessage(ws, message)`:
- If `message` is not a string (ArrayBuffer) → send error `E_BADFRAME` to ws.
- Byte length (UTF-8) > 256*1024 → error `E_TOOBIG`.
- JSON.parse failure, non-object, array, or non-string `t` → error `E_BADFRAME`
  (include `id` in the error frame only when the parsed value has a string `id`).
  Error frame shape: `{t:"error", code}` (+ `id` when known) — same as relay-node.
- `t === "ping"` → reply `{t:"pong"}` (echo `id` when present). (Auto-response
  handles the exact `{"t":"ping"}` payload; this is the fallback.)
- Rate limit (NEW): per-tenant token bucket in DO memory, capacity 30,
  refill 30 tokens/sec, applied to every valid frame from either role that is
  not `ping`. When a frame exceeds the bucket: drop it and send
  `{t:"error", code:"E_BUSY"}` to the sender, at most once per second
  (track last E_BUSY time).
- Role = the socket's attachment. Agent frames: `t === "hello"` → reply
  `{t:"ready", agentOnline:true}`, do not forward. Anything else → forward
  the RAW text unchanged to every open client socket.
- Client frames: if the agent socket is open → forward raw text to it;
  else append to the outbox (drop oldest while >500 frames or >1MB total),
  persisting to storage.

`webSocketClose(ws, code, reason, wasClean)` (and `webSocketError` similarly):
remove the socket from agent/clients; if it was a client, notify the agent
`{t:"peer", clients:<n>}`. (relay-node does not notify clients when the agent
drops — match that.)

Helper `isOpen(ws)`: with hibernation sockets there is no readyState check
equivalent to ws; treat a socket as usable if it is in our sets / is the
current agent; wrap sends in try/catch and drop dead sockets on failure.

## Acceptance (the coordinator will verify)

- `npm install` in relay-cf works; `npx tsc --noEmit` passes OR is skipped
  with the reason noted in your final summary (wrangler bundles TS itself).
- `npx wrangler dev --local --port 8788` boots and serves the routes.
- Do NOT run wrangler deploy or login. Do NOT create a real `.dev.vars`
  (only the `.example`).

Write clean, commented code mirroring relay-node's structure where sensible.
