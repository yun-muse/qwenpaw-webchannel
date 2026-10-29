# M3 Prep Report — Cloudflare relay, SPA login/config, plugin packaging, hosted deploy plan

Date: 2026-10-27. Everything here was done WITHOUT the user's Cloudflare
account and WITHOUT touching the hosted QwenPaw instance: the relay was
verified against `wrangler dev --local`, and all account-dependent steps
live in `docs/m3-plan.md` only.

## Engine & model evidence

All product code/docs were written by **CodeBuddy CLI**, always pinned
`--model deepseek-v4.1-flash` (no fallback needed). Session jsonl under
`~/.codebuddy/projects/home-hatch-workspace-qwenpaw-webchannel/`:

| Run | Session | Model entries in jsonl |
|---|---|---|
| Part 1 relay-cf | `01a1790b-c900-7fc0-a7a8-7fb6a4d141d8` | 78 × `deepseek-v4.1-flash`, no other model |
| Part 2 SPA | `01a1790d-c651-74c0-b7dc-956d24878651` | 97 × `deepseek-v4.1-flash` |
| Part 3 packaging + plan | `01a17913-04db-768c-b44e-6c8472d859bf` | 111 × `deepseek-v4.1-flash` |

The coordinator independently re-ran every check below (Bash is denied in
the CodeBuddy sessions, so all builds/tests were coordinator-run anyway).

## Part 1 — relay-cf/ (Worker + Durable Object) — DONE, locally verified

Files: `src/index.ts` (Worker + `RelayDO` in one module), `wrangler.toml`
(name `qwenpaw-webchannel-relay`, DO binding `RELAY`, SQLite migration
`v1`, var `TENANT=main`), `package.json`, `tsconfig.json`, `README.md`
(routes, secrets table, local dev, deploy-later commands, /poll note),
`.dev.vars.example`, `.gitignore`.

Semantics match relay-node: envelope check only (JSON object, string `t`,
≤256 KB → else `E_TOOBIG`/`E_BADFRAME` to the sender), `hello`→`ready`,
`peer` notifications, verbatim forwarding, offline buffer 500 frames /
1 MB drop-oldest — persisted in DO storage (`outbox` key) and flushed in
order on agent reconnect. Hibernation API used as specified:
`acceptWebSocket` + `serializeAttachment({role})`,
`setWebSocketAutoResponse` for the exact `{"t":"ping"}` payload (a parsed
`ping` with an `id` is answered by the handler as fallback), socket lists
rebuilt from `getWebSockets()` in `blockConcurrencyWhile`.

New vs relay-node, per brief:
- `POST /api/login {password}` → `{token, expires}`; token =
  `v1.<expires>.<base64url HMAC-SHA256(LOGIN_SECRET)>`, 12 h TTL;
  `/ws/client` requires `?token=` (browsers can't set WS headers) — 401
  otherwise; `/ws/agent` requires the `AGENT_TOKEN` bearer — 401 otherwise.
- Per-tenant rate limit: token bucket (capacity 30, refill 30/s, both
  directions, pings exempt); excess frames dropped + `E_BUSY` to the
  sender at most once per second.
- `GET /poll` → **501 `{error:"not_implemented"}` — deferred** (allowed by
  the brief): v1 has exactly one transport; relay-node has no /poll
  either, and a long-poll queue would need new protocol semantics
  (frames.md has none). Documented in relay-cf/README.md.

Coordinator fixes during verification (dependency drift, not logic):
`@cloudflare/workers-types` bumped ^4 → ^5 (wrangler 4.153's peer range)
and `typescript` added as a devDep so `tsc --noEmit` is a real check —
**tsc passes**.

Local verification — `wrangler dev --local --port 8788` booted
(`Ready on http://localhost:8788`, `/health` 200), then
`tests/e2e_cf.mjs` (frames in `tests/e2e_cf.frames.log`), **all PASS**:

```
ASSERT LOGIN: PASS bad=401 good=200 expires=1793075999
ASSERT AUTH-REJECT: PASS clientNoToken=401 agentBadToken=401
ASSERT PAIRING: PASS ready.agentOnline=true msgText="hello relay-cf"
ASSERT STREAM-ORDER: PASS evtCount=20 seqs=2..21 in order
ASSERT E_TOOBIG: PASS agentForwarded=false
ASSERT OFFLINE-BUFFER: PASS flushed=["buffered-0","buffered-1","buffered-2"]
ASSERT RATE-LIMIT: PASS delivered=32/40 busyFrames=1
ASSERT POLL-AND-HEALTH: PASS poll=501 health={ok,agentOnline:true,clients:1}
E2E_CF PASS
```

(RATE-LIMIT: 40-frame burst → 32 delivered = 30 bucket + refill during the
burst, 8 dropped, exactly one throttled `E_BUSY`.)

## Part 2 — SPA production wiring — DONE, build verified both modes

- `spa/src/config.ts`: `RELAY_WS_URL` (`VITE_RELAY_WS` ??
  `ws://127.0.0.1:8787/ws/client`), `RELAY_HTTP_URL` (`VITE_RELAY_HTTP` ??
  `''`), `LOGIN_REQUIRED = RELAY_HTTP_URL !== ''`. `spa/.env.example`
  documents both vars; `spa/src/vite-env.d.ts` (was missing) added with
  typed env vars.
- `relay.ts`: optional `getToken` (read fresh on every connect, appended
  as `?token=`/`&token=`), optional `onAuthFailure` invoked from the
  existing connection-level `E_AUTH` branch.
- `App.tsx`: token in `sessionStorage` (`webchannel.token`); when
  `LOGIN_REQUIRED` and no token, a styled login gate renders instead of
  the chat UI (`POST {RELAY_HTTP_URL}/api/login`, server error shown,
  button disabled in flight); on auth failure the token is cleared and
  the gate returns. Local dev (no env) is untouched: no gate, no token,
  same default URL.
- Coordinator verification: `npm run build` passes (JS 231.24 kB /
  gzip 76.05 kB). Default build's bundle contains
  `ws://127.0.0.1:8787/ws/client`; a build with
  `VITE_RELAY_WS`/`VITE_RELAY_HTTP` set embeds the workers.dev URLs —
  build-time wiring proven in both modes.

## Part 3 — plugin packaging + hosted deploy plan — DONE

- `tools/package_plugin.sh` (coordinator-ran): builds
  `dist/webchannel.zip` deterministically via python3 `zipfile`
  (whitelist of the 7 plugin files, fixed timestamps; `zip` fallback),
  after validating `plugin.json`'s entry point is in the archive.
  Contract verified against the ref's `routers/plugins.py`:
  `_find_plugin_dir` accepts `plugin.json` at the archive root;
  `POST /api/plugins/upload` takes a multipart `.zip` (`?force=true` to
  reinstall); `POST /api/plugins/install` takes a local path or an
  HTTP(S) ZIP URL. Zip listing (24,939 bytes):
  `plugin.json, plugin.py, channel.py, frames.py, util.py,
  relay_client.py, README.md` — all at the root, no `tests/`,
  no `__pycache__`. (`dist/` is gitignored; the zip is a build artifact.)
- `docs/m3-plan.md`: the 10-step hosted checklist (secrets → connector
  deploy → `work` agent → §13.3 skills whitelist → plugin install →
  channel enable → SPA hosting → real approval round-trip → persistence
  observation → rollback), each with owner + a verify that can fail, plus
  three open questions for the user (SPA host, LOGIN_PASSWORD shape,
  keep-alive pause for the sleep test). Nothing in it has been executed.

### Cloudflare connector update (input received during prep, 2026-10-27)

The user's Cloudflare credential is now connected as the
`custom.cloudflare` connector and **verified live** (token verify →
active, expires 2027-10-27). Account id
`<cloudflare-account-id>` ("<owner-email>'s
Account") is recorded in `docs/m3-plan.md` as the
`CLOUDFLARE_ACCOUNT_ID`; connector doc + read helper live at
`~/workspace/custom-connectors/custom.cloudflare/` (`bin/cf.py`).
The plan therefore deploys **through the connector** — no
`wrangler login` / browser OAuth, and no user credential was requested
for this prep. Recorded caveat: wrangler reads `CLOUDFLARE_API_TOKEN`
from the environment, which the connector does not populate, so the
wrangler-token route is **untested**; plan step 2a is a small
deploy-time auth test (`wrangler whoami` with the token supplied via
the connector), with step 2c as the fallback — upload the Worker
through the Cloudflare REST API (metadata carrying the DO binding +
`v1` migration, the easy-to-drop parts). This changed plan/report
content only; prep scope was not altered.

## Deferrals & notes

- `GET /poll`: deferred by design (501 + README rationale, above).
- Hosted deploy: not attempted — it needs the user's account actions as
  laid out in `docs/m3-plan.md`. The wrangler-token-vs-connector
  question can only be settled at deploy time (plan step 2a/2c).
- `relay-cf/.dev.vars` (dev-only placeholder values from the .example)
  exists locally for `wrangler dev`; it is gitignored and contains no
  real secret. The wrangler dev server used for verification has been
  shut down.
- Next: execute `docs/m3-plan.md` with the user (M3 proper).
