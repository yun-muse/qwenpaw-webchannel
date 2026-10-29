# Task M3-3 — plugin packaging script + hosted deploy plan (docs only)

Two deliverables. Do NOT touch the hosted QwenPaw instance; this task only
writes a script and a plan document. Reference: `.ref_tmp/plugins_router.py`
is a copy of the ref source's `src/qwenpaw/app/routers/plugins.py`
(QwenPaw v2.2.2.post1) — read it for the exact install contracts.

## Deliverable 1 — `tools/package_plugin.sh`

A bash script (set -euo pipefail, runnable from the repo root as
`bash tools/package_plugin.sh`) that builds `dist/webchannel.zip` from
`plugin/`:

- First verify against `.ref_tmp/plugins_router.py` how install works
  (facts already established: `POST /api/plugins/install` takes a local
  path or an HTTP(S) URL to a ZIP; `POST /api/plugins/upload` accepts a
  multipart `.zip` upload; `_find_plugin_dir` locates `plugin.json` at the
  archive root OR in a single top-level subdirectory).
- Build the zip with the plugin files at the zip ROOT (plugin.json,
  plugin.py, channel.py, frames.py, util.py, relay_client.py, README.md),
  EXCLUDING `tests/`, `__pycache__/`, and any `*.pyc`.
- Use `zip` if available, else fall back to `python3 -m zipfile` or a small
  python3 inline script — the script must work in a plain environment;
  prefer python3 zipfile for determinism. Create `dist/` if needed.
  Print the resulting path and `unzip -l`-style listing (python3 equivalent
  is fine) at the end.

## Deliverable 2 — `docs/m3-plan.md`

The exact hosted-deployment plan to execute LATER with the user. Write it as
a checklist with concrete commands/values where known. Facts you can rely on
(from the ref source, this repo, and the design doc `docs/design.md`):

- Hosted instance: QwenPaw v2.2.2.post1 on the AgentScope platform
  (auto-sleeps after 48h idle; a keep-alive cron already runs every 12h).
- Plugin install routes (from `.ref_tmp/plugins_router.py`): the console
  backend exposes `POST /api/plugins/upload` (multipart ZIP upload,
  `?force=true` to reinstall) and `POST /api/plugins/install`
  (`{source}` = local path or HTTP(S) ZIP URL). The hosted console UI is
  the same backend's frontend, so ZIP upload through the UI/API is viable
  remotely; a local path is NOT (it would be a path inside the container).
- Relay: `relay-cf/` deploys to the user's Cloudflare account as Worker
  `qwenpaw-webchannel-relay` (wrangler), secrets AGENT_TOKEN /
  LOGIN_PASSWORD / LOGIN_SECRET; the SPA is built with `VITE_RELAY_WS` /
  `VITE_RELAY_HTTP` pointing at the deployed Worker.
- Cloudflare access (updated 2026-10-27): the user's Cloudflare credential
  is connected as the `custom.cloudflare` connector and VERIFIED live
  (token verify → active, expires 2027-10-27). Account id
  `<cloudflare-account-id>` (account name
  "<owner-email>'s Account") — this is the
  `CLOUDFLARE_ACCOUNT_ID` for deploys. Connector doc + read helper:
  `~/workspace/custom-connectors/custom.cloudflare/` (`bin/cf.py`:
  verify/accounts/get). Deploys will run THROUGH this connector. Caveat:
  wrangler reads `CLOUDFLARE_API_TOKEN` from the environment, which the
  connector does NOT populate — the wrangler-token route is UNTESTED.
  The plan must include a small deploy-time test of that route (e.g.
  pointing wrangler at the API via the connector's surrogate value) with
  a fallback of uploading the Worker through the Cloudflare REST API
  directly if wrangler auth fails.
- Design §13.3: skills are filtered per channel whitelist — a skill whose
  manifest `channels` lacks `"web"` (and lacks `"all"`) is silently skipped
  on the web channel. Also `enabled`, `preload`, `requires.env` can skip.

Sections (numbered steps, each with "who does it" — user vs Muse — and a
verify line):

1. **Secrets & tokens**: generate AGENT_TOKEN (e.g. `openssl rand -hex 32`)
   and a LOGIN_PASSWORD; LOGIN_SECRET = another random hex. Where each value
   goes: CF Worker secrets (all three), plugin channel config (AGENT_TOKEN +
   relay URL), user's own password manager (LOGIN_PASSWORD + AGENT_TOKEN).
   State explicitly: Muse never sees/stores the LOGIN_PASSWORD in chat or
   git; the user sets CF secrets themselves OR pastes values into the
   wrangler secret prompts.
2. **Deploy relay-cf** via the `custom.cloudflare` connector (account id
   `<cloudflare-account-id>` = `CLOUDFLARE_ACCOUNT_ID`; credential
   already connected and verified — no `wrangler login` / browser OAuth
   needed from the user). First a deploy-time auth test: try wrangler
   with `CLOUDFLARE_API_TOKEN` supplied through the connector (surrogate)
   + `CLOUDFLARE_ACCOUNT_ID` set — `wrangler whoami` / a dry deploy. If
   wrangler auth fails, fall back to uploading the Worker via the
   Cloudflare REST API (connector route). Then set the three secrets
   (AGENT_TOKEN / LOGIN_PASSWORD / LOGIN_SECRET — via wrangler secret put
   or the API), deploy, record the workers.dev URL, verify `GET /health`.
3. **Create the `work` agent** in the hosted console (dedicated agent for
   the web frontend; `default` untouched — rationale from design §13.2:
   workspace/memory isolation, independent channel config).
4. **Skills channel whitelist check** (design §13.3): how to check each
   skill the work agent needs — inspect the skill manifest's `channels`
   (console skill page / workspace skill dir), add `"web"` (or `"all"`)
   where missing; note the silent-skip symptom (skill never triggers, one
   log line) and the other skip switches (enabled / requires.env).
5. **Install the plugin**: preferred route — `tools/package_plugin.sh` →
   upload `dist/webchannel.zip` via the console's plugin upload
   (`POST /api/plugins/upload` equivalent in the UI). Fallback — host the
   zip at a public URL (GitHub release asset or CF Pages) and use
   `POST /api/plugins/install` with that URL. Verify: plugin list shows
   `webchannel` loaded; channel type `web` registered.
6. **Enable the web channel on the `work` agent**: set relay_url =
   `wss://<worker>/ws/agent` and the AGENT_TOKEN in the channel config;
   verify the relay /health shows agentOnline:true.
7. **Build & host the SPA**: build with VITE_RELAY_WS/VITE_RELAY_HTTP set;
   host the static build (propose CF Pages on the same account); public
   e2e: login with LOGIN_PASSWORD → send a message → streaming reply.
8. **Real approval round-trip test** (M2 leftover): on the hosted work
   agent (whose tool guard actually gates shell tools), ask for a shell
   command, expect an approval card in the SPA, approve → command runs;
   also deny path. Record the result.
9. **Persistence observation**: after the instance's next natural
   sleep/wake (keep-alive cron may prevent sleep — note that observation
   then waits for a platform restart/upgrade), check: plugin still
   installed? channel config intact? agent auto-reconnects to the relay?
   Record findings; if the plugin does not survive, note reinstall via
   step 5 as the standing procedure.
10. **Rollback**: disable the web channel on the work agent and/or
    uninstall the plugin from the console; delete the CF Worker (or just
    its secrets) to cut traffic. `default` agent and the console remain
    untouched throughout.

Keep the document tight and operational — no design re-argument. Also add a
short "Open questions for the user" section ONLY if something genuinely
needs their decision (e.g. where to host the SPA/zip if not CF/GitHub).
