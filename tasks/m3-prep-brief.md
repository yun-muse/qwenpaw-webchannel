# M3 prep brief — everything that does NOT need the user's Cloudflare account

Engine: CodeBuddy CLI pinned `--model deepseek-v4.1-flash` (fallback glm-5.3-flash).
Follow repo AGENTS.md. Ground truth = disk + coordinator re-runs.

## Part 1 — relay-cf/ (Cloudflare Worker + Durable Object port of relay-node)
Semantics must match relay-node/server.js + protocol/frames.md, plus the M0/M2 deltas:
- Worker routes: GET /ws/agent (Authorization: Bearer <AGENT_TOKEN secret>), GET /ws/client
  (browser token, see login), POST /api/login {password} → {token} (short-lived, HMAC-signed
  with a LOGIN_SECRET; password compared against LOGIN_PASSWORD secret), GET /health,
  GET /poll?cursor= (long-poll fallback — implement simply via DO storage queue if cheap,
  else document as deferred with reason).
- One Durable Object per tenant (idFromName(tenant) from the agent token hash / "main").
  Use the Hibernation API: state.acceptWebSocket, serializeAttachment({role}) per socket,
  setWebSocketAutoResponse for ping→pong. On wake, rebuild socket lists from
  state.getWebSockets().
- Forwarding rules identical to relay-node: don't parse business payload beyond envelope
  check (JSON with string t, ≤256KB → else error frame E_TOOBIG/E_BADFRAME to sender);
  ping answered locally by auto-response; agent offline → buffer client frames in DO
  storage (max 500 frames / 1MB, drop oldest), flush in order on agent reconnect; notify
  clients {t:"ready", agentOnline} and agent {t:"peer", clients:n}.
- NEW vs relay-node: per-tenant rate limit 30 frames/sec (token bucket in DO memory;
  excess frames dropped + {t:"error", code:"E_BUSY"} at most once per second).
- Files: relay-cf/src/index.ts (or .js — pick TS with wrangler types kept minimal),
  wrangler.toml (name qwenpaw-webchannel-relay, DO binding RELAY, SQLite migration,
  vars for TENANT), package.json (wrangler devDep), README.md (secrets to set:
  AGENT_TOKEN, LOGIN_PASSWORD, LOGIN_SECRET; deploy commands).
- Local verification WITHOUT a CF account: `npx wrangler dev --local` (or `wrangler dev`)
  on :8788 must boot; harness tests/e2e_cf.mjs (wrangler dev on a test port) asserting:
  login → client token; mock agent connects; client msg → agent receives; agent streams
  20 evt → client receives all in order; oversize frame → E_TOOBIG; agent offline buffer:
  client sends 3 frames while agent down, agent reconnects → receives all 3 in order.

## Part 2 — SPA production wiring
- Relay endpoint configurable: build-time `VITE_RELAY_WS` (e.g. wss://relay.example.workers.dev)
  and `VITE_RELAY_HTTP`; default stays ws://127.0.0.1:8787 for local dev. Login flow: if a
  relay HTTP base is configured and no client token is stored, show a login form
  (password → POST /api/login → store token in sessionStorage) before connecting;
  local dev mode (default URL) skips login. Build must pass; local behaviour unchanged.

## Part 3 — plugin packaging + hosted deploy plan (docs only, do NOT touch hosted yet)
- tools/package_plugin.sh: build dist/webchannel.zip from plugin/ (contents at zip root,
  excluding tests/__pycache__), matching what the ref's plugin install expects for ZIP/URL
  sources — verify against src/qwenpaw/app/routers/plugins.py in ~/workspace/qwenpaw-ref.
  Run it; verify zip listing.
- docs/m3-plan.md: exact hosted steps for later execution: (1) generate agent token +
  login password (where they get stored: CF secrets + plugin config + user keeps copy),
  (2) create dedicated `work` agent in the hosted console (default untouched), (3) skills
  channels whitelist check for `web` per design §13.3 (list how to check/fix), (4) install
  plugin (ZIP URL needs public hosting of the zip — propose GitHub release or CF Pages
  static; local-dir install impossible remotely; console upload if the UI supports it —
  research from ref source/UI knowledge), (5) enable web channel on work agent with
  relay_url + token, (6) public e2e from the deployed SPA, (7) real approval round-trip
  test (M2 leftover), (8) persistence observation plan (plugin presence after instance
  sleep/wake — platform-driven, observe at next natural wake; note keep-alive cron exists),
  (9) rollback = disable channel/uninstall plugin.
- Write docs/m3-prep-report.md with per-part status + local test evidence; git commit
  "M3 prep: Cloudflare relay, SPA login/config, plugin packaging, hosted deploy plan".
