# M16 — README suite (CodeBuddy task)

Context: QwenPaw WebChannel is feature-complete through M15 (see git log and
docs/*-report.md). The GitHub repo https://github.com/yun-muse/qwenpaw-webchannel
currently has NO root README, plugin/README.md and relay-cf/README.md exist but
predate M6–M15, spa/ has no README at all. Fix the documentation, do not change
any product code in this task.

Deliverables:
1. `README.md` (root, NEW): project title + one-line pitch; live links
   (SPA https://qwenpaw-webchannel-spa.pages.dev, relay health endpoint);
   feature list reflecting reality at M15 (streaming chat, multi-chat sync,
   per-agent model switching, / commands + @skill, reasoning-effort selector,
   PWA forced-freshness, persistent 30-day login, per-turn usage receipts +
   context meter, Markdown export, Turso-archive full-text search, heartbeat
   self-healing); architecture section with a Mermaid diagram
   (browser SPA → Cloudflare Worker/Durable Object relay → plugin inside
   QwenPaw → work agent; plugin → Turso archive); repo layout table;
   quick-start for each component linking to its README; deployment summary
   (point to docs/m3-deploy-cf.md and the hosted-install route notes);
   protocol pointer (protocol/frames.md, current version); honest limits
   section (export = current context view only; search coverage best-effort
   archive; approvals intentionally auto-approved / no tool_guard).
   NO credentials, NO tokens, NO passwords anywhere — refer to secret NAMES only.
2. `plugin/README.md` (REWRITE/refresh to M15): install via the proven hosted
   route and local install, configuration/env (names only), modules map
   (channel.py, relay_client.py, frames.py, util.py, turso_archive.py,
   turso_search.py, filelog.py), heartbeat hb/hb_ack + slot generation rules,
   file log, how to run plugin/tests (plain-python suites, no pytest needed).
3. `spa/README.md` (NEW): dev/build/deploy (vite, Pages project
   qwenpaw-webchannel-spa, --branch main), PWA + version.json/__BUILD_ID__
   forced-freshness mechanism, localStorage token keys, mobile layout notes
   (M14) and usage meter/receipts UI (M15), source layout.
4. `relay-cf/README.md` (refresh to M7.3/M11): Worker + Durable Object design,
   hibernation WS, agent slot generations (close 4000 fatal), hb ack rules,
   30 fps tenant limit, offline buffer, /health + agentLastSeen, secrets by
   NAME only (AGENT_TOKEN / LOGIN_PASSWORD / LOGIN_SECRET), wrangler deploy.
5. `relay-node/README.md` (light refresh only if statements are stale vs
   relay-cf lockstep rules; keep it short).
6. A short `docs/README.md` index linking the milestone reports in order.

Rules: base every claim on the actual code/docs in this repo — read before
writing, cite file paths where a claim is non-obvious, do not invent features.
Chinese or English: match each existing file's current language; root README
bilingual heading + Chinese body is fine (project working language is Chinese).
Run a markdown sanity check (links to files in-repo must exist).
Do NOT commit; leave the working tree for review. Report: files changed,
line counts, any claim you could not verify from source.
