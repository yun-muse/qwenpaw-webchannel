# M3 deploy — Cloudflare side (executed 2026-10-27)

Scope: m3-plan.md steps 1, 2 and 7 (Cloudflare side only). Hosted-instance
steps 3–6 and 8 are handled separately. **No secret values appear in this
file** — the three generated values live only in `.secrets/m3.env`
(chmod 600, `.secrets/` added to `.gitignore`, `git status` clean).

## Step 1 — secrets

Generated locally: `AGENT_TOKEN` (`openssl rand -hex 32`), `LOGIN_SECRET`
(`openssl rand -hex 32`), `LOGIN_PASSWORD` (`openssl rand -base64 24`).
Stored in `.secrets/m3.env`; uploaded to the Worker as secrets in step 2b.
`LOGIN_PASSWORD` and `AGENT_TOKEN` were handed to the parent agent for the
plugin config (step 6) and for the user, respectively per plan (the password
is relayed to the user by the parent; it was never committed or logged).

## Step 2 — relay deploy: **wrangler route (2b) worked**

Step 2a test PASSED: connector verified live first
(`cf.py verify` → token `active`, expires 2027-10-27). The `hsurr:`
surrogate from `dynamic_credentials.dynamic_credential_entry("custom.cloudflare")`
was held only in a shell variable and passed as `CLOUDFLARE_API_TOKEN`
(with `CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>`):
`wrangler whoami` (wrangler 4.153.0) printed the account
"<owner-email>'s Account" / `<cloudflare-account-id>`. So the REST fallback
(2c) was **not** needed.

Deploy: `npx wrangler deploy` from `relay-cf/` →

- Worker: `qwenpaw-webchannel-relay`
- URL: **https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev**
- Version ID: `e49ea6dd-8e47-4b2f-9f44-b7debc36efab`
- Bindings confirmed in deploy output: `env.RELAY (RelayDO)` Durable Object,
  `env.TENANT ("main")`. Total upload 11.98 KiB.

Secrets (values via stdin from `.secrets/m3.env`, never argv):
`wrangler secret put AGENT_TOKEN|LOGIN_PASSWORD|LOGIN_SECRET` → all three
"Success! Uploaded secret".

Verify (after one transient `error code: 1042` + timeouts in the first
minute after the secret uploads — propagation; clean on retry):

```
GET /health            → 200 {"ok":true,"agentOnline":false,"clients":0}
POST /api/login (correct password) → 200 {"token":"v1.<expires>.<sig>","expires":1793076343}
POST /api/login (wrong password)   → 401 {"error":"bad_password"}
```

`agentOnline:false` is expected until the hosted plugin is configured
(step 6).

## Step 7 — SPA deploy (CF Pages, same wrangler credential route)

Built in `spa/` with the deployed relay host baked in:

```
VITE_RELAY_WS=wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/client
VITE_RELAY_HTTP=https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev
npm run build → dist/assets/index-DB_QePs8.js (231.41 kB / gzip 76.11 kB)
```

Pre-deploy check: the built JS contains the `wss://…/ws/client` URL and the
`/api/login` call (login gate on, since `VITE_RELAY_HTTP` is non-empty).

Pages: created project `qwenpaw-webchannel-spa` (`wrangler pages project
create --production-branch main`), then `wrangler pages deploy dist`.

**Deviation:** the first deploy inherited branch `master` from this repo's
git branch, so it became a *preview* deployment and the production root
returned 404 "Deployment Not Found". Fixed by redeploying with
`--branch main`; production then served immediately.

Verify (public):

```
GET https://qwenpaw-webchannel-spa.pages.dev/ → 200, <title>QwenPaw WebChannel</title>
Served asset assets/index-DB_QePs8.js (231,440 bytes) contains
  wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/client
  and the /api/login call → the deployed page shows the login form.
```

## Result

| piece | URL |
|---|---|
| Relay base | https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev |
| Relay agent WS | wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/agent |
| SPA | https://qwenpaw-webchannel-spa.pages.dev |

Remaining for full e2e: hosted steps 3–6 (work agent, plugin install,
channel config with `relay_url` + `AGENT_TOKEN`) — after that `/health`
should flip to `agentOnline:true` and the plan-step-7 public e2e
(login → streamed reply) can run.
