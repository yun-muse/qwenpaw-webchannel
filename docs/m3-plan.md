# M3 — hosted deploy plan (execute later, with the user)

Status: **not executed.** Nothing here touches the hosted instance, the
`default` agent or the console until step 5. Each step names **who** acts and
ends with a **verify** that can fail — do not continue past a failed verify.

Reference values (fixed for this plan):

| item | value |
|---|---|
| Hosted instance | QwenPaw **v2.2.2.post1** on the AgentScope platform; auto-sleeps after 48 h idle; keep-alive cron already runs every 12 h |
| Plugin install routes | `POST /api/plugins/upload` (multipart `file`, name must end `.zip`, `?force=true` to reinstall) and `POST /api/plugins/install` (`{source, force}`, source = local path or HTTP(S) ZIP URL) |
| Archive contract | `plugin.json` at the ZIP root (or one top-level dir); extraction is Zip-Slip guarded |
| Worker name | `qwenpaw-webchannel-relay` (from `relay-cf/wrangler.toml`) |
| `CLOUDFLARE_ACCOUNT_ID` | ` <cloudflare-account-id>` (account " <owner-email>'s Account") |
| Cloudflare credential | connected as the `custom.cloudflare` connector, verified live (token active, expires 2027-10-27); doc + read helper at `~/workspace/custom-connectors/custom.cloudflare/` (`bin/cf.py`: verify / accounts / get) |
| Relay routes | `POST /api/login` `{password}` → `{token}` · `GET /ws/agent` (Bearer `AGENT_TOKEN`) · `GET /ws/client?token=…` · `GET /health` |
| Plugin channel config keys | `relay_url`, `token` (both `required`, defaults point at localhost — they must be overwritten) |

---

## 1. Secrets & tokens

**Who:** User runs the generators. Muse may run the two `rand -hex 32` ones —
`AGENT_TOKEN` has to be typed into the channel config anyway, so it cannot stay
secret from Muse. **`LOGIN_PASSWORD` is generated and kept by the User only**
(never in chat, a commit, a shell history line, or any file in this repo).

Generate (User's terminal):

```bash
openssl rand -hex 32     # AGENT_TOKEN
openssl rand -hex 32     # LOGIN_SECRET   (HMAC key for client tokens; rotating it logs everyone out)
openssl rand -base64 24  # LOGIN_PASSWORD (or the User picks a passphrase — their call)
```

Where each value goes:

| value | Cloudflare Worker secret | Plugin channel config | User's password manager |
|---|---|---|---|
| `AGENT_TOKEN` | ✔ | ✔ (`token` field) | ✔ |
| `LOGIN_PASSWORD` | ✔ | — | ✔ |
| `LOGIN_SECRET` | ✔ | — | optional |

**Verify:** the three values exist outside this chat; nothing landed in
`git status`. Muse holds `AGENT_TOKEN` only (it must be typed into the channel
config in step 6) and never sees `LOGIN_PASSWORD`.

## 2. Deploy relay-cf through the `custom.cloudflare` connector

**Who:** Muse (connector + wrangler); User only if a secret must be typed into
a prompt.

The credential is already connected and verified, so there is **no
`wrangler login` / browser OAuth** in this flow. The open unknown is wrangler's
token: wrangler reads `CLOUDFLARE_API_TOKEN` from the environment and the
connector does not populate it — **the wrangler-token route is untested.**

**2a — deploy-time auth test** (run first; ~1 min, read-only):

```bash
cd relay-cf && npm install
export CLOUDFLARE_ACCOUNT_ID= <cloudflare-account-id>
export CLOUDFLARE_API_TOKEN="<token value the connector surfaces>"
npx wrangler whoami
```

- **PASS** — prints the account (id ` <cloudflare-account-id>…` and/or the account name) →
  continue with 2b.
- **FAIL / the connector exposes no raw token value** — do not fight it, and do
  not fall back to `wrangler login` (no browser). Go to 2c (REST fallback).
  Record which route was taken; it decides step 7's SPA hosting route too.

**2b — wrangler route:**

```bash
npx wrangler deploy                      # creates the script + applies the v1 RelayDO SQLite migration
npx wrangler secret put AGENT_TOKEN      # paste, Enter (stdin — never argv)
npx wrangler secret put LOGIN_PASSWORD
npx wrangler secret put LOGIN_SECRET
```

Deploy first: `secret put` 404s on a script that does not exist yet. Between
the deploy and the secrets being set, `/health` answers but `/api/login`
returns `500 login_not_configured` and all agent sockets are rejected — that is
expected, not a bug.

**2c — REST fallback (connector route, no wrangler auth):**

```bash
npx wrangler deploy --dry-run --outdir .cf-build   # bundles, uploads nothing
# expect .cf-build/index.js (+ any chunks it reports); confirm the files exist

curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/qwenpaw-webchannel-relay" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F 'metadata={"main_module":"index.js","compatibility_date":"2025-09-01","bindings":[{"type":"durable_object_namespace","name":"RELAY","class_name":"RelayDO"}],"migrations":[{"tag":"v1","new_sqlite_classes":["RelayDO"]}]};type=application/json' \
  -F 'index.js=@.cf-build/index.js;type=application/javascript+module'

for n in AGENT_TOKEN LOGIN_PASSWORD LOGIN_SECRET; do
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/qwenpaw-webchannel-relay/secrets" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
    -d "{\"name\":\"$n\",\"text\":\"$VALUE\",\"type\":\"secret_text\"}"
done
```

The binding + `migrations` in `metadata` are the parts that are easy to drop:
without them the Worker uploads, deploys, and fails at runtime with no `RELAY`
namespace.

**Record:** the deployed host, `<worker>.<subdomain>.workers.dev`. `wrangler
deploy` prints it; on the REST route read it from the dashboard (Workers &
Pages → `qwenpaw-webchannel-relay` → the `workers.dev` URL). The `<subdomain>`
is per account and not part of this plan.

**Verify:**

```bash
curl -s https://qwenpaw-webchannel-relay.<subdomain>.workers.dev/health
# {"ok":true,"agentOnline":false,"clients":0}

curl -s -X POST https://qwenpaw-webchannel-relay.<subdomain>.workers.dev/api/login \
  -H 'content-type: application/json' -d '{"password":"<LOGIN_PASSWORD>"}'
# {"token":"v1.<expires>.<sig>","expires":...}
# wrong password → 401 {"error":"bad_password"}
# 500 {"error":"login_not_configured"} → LOGIN_PASSWORD / LOGIN_SECRET not set
```

## 3. Create the `work` agent

**Who:** User (console UI).

Console → Agents → new agent, id `work`. Keep `default` exactly as it is.
Rationale (design §13.2): workspace/memory isolation, independent channel
config, independent model routing — not tidiness.

**Verify:** `work` is listed and its workspace exists
(`~/.qwenpaw/workspaces/work/agent.json`); `default`'s config is unchanged.

## 4. Skills channel whitelist check (design §13.3)

**Who:** Muse inspects, User approves the edits.

`resolve_effective_skills(workspace_dir, channel_name)` does:

```python
channels = entry.get("channels") or ["all"]
if "all" not in channels and channel_name not in channels:
    continue          # silent skip, no error
```

For **every** skill the `work` agent needs:

1. Open the skill's manifest (console → Skills page, or the skill dir under the
   `work` workspace) and read `channels`.
2. If it lacks `web` and lacks `all`, add `"web"`.
3. Also confirm the three other silent switches: `enabled` (must be true),
   `preload` (if the flow expects it preloaded), and `requires.env` (a missing
   env var skips the skill with no error).

**Silent-failure symptom:** the skill never triggers on the web channel, no
error anywhere in the UI, one log line. If a skill "doesn't work" in the SPA but
works in the console, this is the first thing to check.

**Verify:** for each skill, its resolved `channels` contains `web` or `all`
(record the list in the step-8 test notes so a later regression is visible).

## 5. Install the plugin

**Who:** Muse builds, User uploads (or Muse uploads if the console session is
already authenticated).

```bash
bash tools/package_plugin.sh        # → dist/webchannel.zip
```

**Preferred route — ZIP upload.** Console → Plugins → install/upload, pick
`dist/webchannel.zip`. This is `POST /api/plugins/upload` behind the same
console UI, so it works remotely. A **local path is not viable**: `source`
would resolve inside the container.

**Fallback — public URL.** `dist/` is gitignored, so the zip is not in the
repo: publish it as a GitHub release asset (or upload it to CF Pages) and

```bash
curl -X POST https://<console-host>/api/plugins/install \
  -H 'content-type: application/json' \
  -d '{"source":"https://<public-host>/webchannel.zip","force":true}'
```

Reinstalling a changed plugin needs `force=true` (upload: `?force=true`); a
second install without it is rejected (409, the `ValueError` path) or leaves the
old build loaded.

**Verify:** `GET /api/plugins` lists `webchannel` with `"loaded": true`; the
Channels page now offers a **Web** card whose fields are *Relay URL* and
*Agent Token*. If the card is missing, the plugin loaded but registration
failed — read the container log before touching step 6.

## 6. Enable the web channel on `work`

**Who:** User (console), with the `AGENT_TOKEN` from step 1.

On the `work` agent's **Web** channel card:

```
relay_url = wss://qwenpaw-webchannel-relay.<subdomain>.workers.dev/ws/agent
token     = <AGENT_TOKEN>          # must equal the Worker secret exactly
```

Both fields default to localhost values; leaving either at its default yields a
channel that dials nothing (or gets 401).

**Verify:** within a few seconds,

```bash
curl -s https://qwenpaw-webchannel-relay.<subdomain>.workers.dev/health
# {"ok":true,"agentOnline":true,"clients":0}
```

`agentOnline:false` = wrong token (401) or the channel is still disabled — check
that before rebuilding anything.

## 7. Build & host the SPA

**Who:** Muse builds and deploys; User owns the resulting URL.

```bash
cd spa
npm ci
VITE_RELAY_WS=wss://qwenpaw-webchannel-relay.<subdomain>.workers.dev/ws/client \
VITE_RELAY_HTTP=https://qwenpaw-webchannel-relay.<subdomain>.workers.dev \
npm run build                       # → spa/dist
```

Both variables are build-time; a wrong value needs a rebuild, not a restart.
`VITE_RELAY_HTTP` being non-empty is also what turns the login gate **on**.
Serving the SPA over https requires `wss://` — mixed content will not connect.

Hosting: CF Pages on the same account (proposal), via the same credential:

```bash
npx wrangler pages deploy spa/dist --project-name qwenpaw-webchannel-spa
# if the token route failed in step 2: dashboard → Pages → upload spa/dist
```

**Verify (public e2e):** open the Pages URL → login form → `LOGIN_PASSWORD` →
send a message → the answer streams in per-delta (not one block at the end).
Reload and send again to confirm the stored token survives (`sessionStorage`).

## 8. Real approval round-trip (M2 leftover)

**Who:** Muse drives, User approves in the browser.

The M2 tests ran against a mock whose guard does not gate shell tools; the
hosted `work` agent's tool guard does. In the SPA:

1. Ask: *"Run `uname -a` and paste the output."*
2. Expect an approval card (`{t:"approval", chat, req_id, tool, severity,
   summary}`) — not a silent refusal.
3. **Approve** → the command runs, output returns in the same chat; the socket
   stays up across the card (approval errors reuse `E_AUTH` and must not kill
   the connection).
4. Second request, **Deny** → the tool does not execute and the agent reports
   the refusal; no command output appears.

The plugin's ownership check (`GET /api/approval/list`, `owner_agent_id` must
equal the channel's agent) runs before both POSTs — a mismatch yields
`E_AUTH` on the card instead of a request, which is itself worth noting if it
happens (wrong agent id in the channel workspace).

**Verify:** both paths recorded in the M3 findings notes (created when this
step runs), with the observed card text and the approve/deny outcome.

## 9. Persistence observation

**Who:** Muse observes, User decides when.

Check, after the instance sleeps and wakes (or after a platform
restart/upgrade):

| # | check | how |
|---|---|---|
| 1 | plugin still installed | `GET /api/plugins` → `webchannel`, `loaded: true` |
| 2 | channel config intact | `work` agent's Web card still has `wss://…` + token; `agent.json` still has the `channels.web` block |
| 3 | agent reconnected | relay `/health` → `agentOnline: true`, without touching the console |

**Caveat:** the existing keep-alive cron (every 12 h) may prevent the 48 h idle
sleep entirely, so this check may have to wait for a platform-initiated
restart/upgrade. Do not disable the cron just to force a sleep without asking
(see open questions).

**If the plugin does not survive:** reinstall via step 5 becomes the standing
procedure after every restart; record it as such (and note that the channel
config lives in the agent config, so it should survive even if the plugin
directory does not).

## 10. Rollback

**Who:** Muse (API/CLI) or User (console). Order matters: cut traffic first,
then remove the code.

1. Disable the **Web** channel on `work` (channel off ⇒ the plugin stops
   dialling; `/health` goes `agentOnline:false`).
2. Uninstall the plugin: console → Plugins → uninstall, or
   `DELETE /api/plugins/webchannel`.
3. Cut the relay: delete the Worker (removes the DO and its stored offline
   buffer) or, to keep the deployment for later, delete/rotate its secrets
   (`AGENT_TOKEN` — all agent sockets rejected; `LOGIN_SECRET` — every client
   token invalid).

`default` and the console are untouched at every step; nothing in this plan
migrates a chat, a workspace or a memory store.

**Verify:** `/health` unreachable or `agentOnline:false`, SPA login fails, and
the console still reaches `default` normally.

---

## Open questions for the user

1. **SPA host** — default proposal is CF Pages on the same account
   (`qwenpaw-webchannel-spa`). GitHub Pages or anything else changes step 7's
   commands only; confirm or override.
2. **`LOGIN_PASSWORD`** — generated random (`openssl rand -base64 24`, painful
   to type on mobile) or a passphrase the User chooses? It is the only value
   that will be typed by hand.
3. **Step 9 timing** — is it acceptable to pause the 12 h keep-alive cron for
   one cycle to force a natural sleep, or should the persistence check wait for
   a platform restart/upgrade?
