# M3 findings — hosted deployment (2026-10-27)

## Live endpoints
- SPA: https://qwenpaw-webchannel-spa.pages.dev (login password in .secrets/m3.env)
- Relay: https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev (agentOnline:true
  once the work agent connected)
- Hosted side: dedicated `work` agent on the user's QwenPaw v2.2.2.post1;
  `default` and QA Agent untouched. Plugin installed via console upload
  (POST /api/plugins/upload route), Web channel enabled with
  relay_url=wss://…/ws/agent.

## Public e2e (browser-driven, 2026-10-27 ~02:00 CST)
- Login with the relay password → chat UI, status "live" + "agent online".
- Chat round-trip works through the public path (SPA → CF relay → plugin →
  work agent); reasoning renders in a collapsed thinking block.
- Shell tool works end-to-end via the web channel (`uname -a` returned the
  container's real output).
- Reload keeps the login and auto-reconnects (~15 s), BUT lands on a new
  empty chat; the previous chat was not restored in the UI (observed once;
  M4 polish item — restore last chat from localStorage + hist on load).

## Approval round-trip — still not triggered, root cause identified
- No approval card appeared for `uname -a` on the hosted work agent either.
- Config comparison (container agent.json files): work's agent.json has NO
  `tool_guard` / `file_guard` keys at all; default's has both. Both have
  `approval_level: "AUTO"`. A fresh workspace simply has no guard config,
  so nothing gates tool calls. The plugin-side approval path remains
  verified by unit tests + the live E_AUTH negative test (M2).
- To verify for real: enable tool_guard on the work agent (console security
  settings or copy default's tool_guard block), then re-run the M3 plan
  step-8 script. Awaiting the user's go-ahead (it changes the agent's
  security posture).

## Persistence — partially verified already
- The instance was fully restarted during M3 (platform Restart, container
  killed and recreated 2026-10-27 01:18 CST). After the restart the plugin
  was rediscovered, re-registered and loaded, and the work agent's Web
  channel config (relay_url, token, enabled) survived intact in agent.json.
  So plugin + config survive a platform restart. Sleep/wake persistence
  remains unobserved (keep-alive cron prevents natural sleep).

## Incident: credential transcription corruption (root cause of the long offline hunt)
- The AGENT_TOKEN and LOGIN_PASSWORD strings in the CF deploy handoff were
  corrupted in transcription (same length, wrong characters; proven by
  SHA-256 comparisons in all directions). The Worker held the .secrets
  values; the console received the corrupted strings, so the plugin's
  connections were rejected 401 and — by design — it stopped retrying,
  invisibly (plugin module loggers do not reach qwenpaw.log; absence of
  "webchannel started" lines in the log proved nothing, the same is true
  on the working local instance).
- Resolution without re-typing: the Worker's AGENT_TOKEN secret was
  rotated to the exact string already saved in agent.json (hash-verified),
  and LOGIN_PASSWORD was rotated to an authored passphrase verified live
  via /api/login. Canonical values live only in .secrets/m3.env (600).
- Lesson: never move a credential through an LLM handoff unverified —
  always close the loop with a hash comparison or a live auth test.

## Debugging notes for future sessions
- Hosted container: app python /app/venv/bin/python (websockets 15.0.1),
  log file on the NAS mount (…/qwenpaw.log); the console's Web Terminal
  app gives root shell. `curl` from inside reaches workers.dev fine.
- The relay's agent-auth failure body is the DO's lowercase 'unauthorized'.
