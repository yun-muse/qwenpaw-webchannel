# M4 brief — SPA restore-on-load + attach limit alignment (SPA only, then redeploy)

Engine: CodeBuddy CLI pinned `--model deepseek-v4.1-flash`. Repo AGENTS.md applies.
Scope is spa/ only (plugin and relay already handle hist/resume correctly).

## Fix 1 — restore the previous chat on page load (the M3 acceptance defect)
Observed live: after a page reload the SPA kept the login and reconnected, but
landed on a brand-new empty chat; the previous chat and its history did not
come back in the UI.
Required behaviour:
- The chat list and the active chat id are persisted in localStorage (the list
  already is; make the ACTIVE chat id persisted too, if it is not).
- On load: if a persisted active chat exists, select it (do NOT create a new
  chat). After the WS connects and `ready` arrives, send {t:"hist"} for that
  chat and render the returned messages. If hist returns empty, show the empty
  state for that chat (still not a new chat).
- "New chat" is created only from the explicit button, or on a true first
  visit with no persisted state.
- Keep resync semantics from AGENTS.md: on {t:"resync"} forget last_seq for
  the chat, then hist-reload it.
- Switching chats in the sidebar must also hist-load the selected chat when
  its messages aren't already in memory.

## Fix 2 — attach limit wording/behaviour alignment
- The v1 protocol rule is: the whole msg frame must be ≤256KB (relay rejects
  larger with E_TOOBIG). Any "10MB" wording/limit in the SPA is wrong.
- Before sending, compute the serialized frame size (JSON with files[]
  base64 included); if it exceeds 256KB, do not send, and show a clear error
  like "附件太大：v1 单条消息上限 256KB（含正文与附件编码）". Remove/replace
  the 10MB references in the SPA UI code accordingly.

## Verify + ship (coordinator-run)
- `npm run build` passes; grep the built bundle to confirm the new limit text
  and the restore logic strings are present.
- Local smoke: serve the built SPA against the local stack if it is up
  (else just record that local stack was down); at minimum, unit-eyeball the
  state flow in code and say what was/wasn't runtime-verified.
- Redeploy to Cloudflare Pages: project qwenpaw-webchannel-spa,
  `wrangler pages deploy spa/dist --project-name qwenpaw-webchannel-spa --branch main`
  with the connector route (surrogate from dynamic_credentials in a shell var
  as CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>;
  see ~/workspace/custom-connectors/custom.cloudflare/CONNECTOR.md).
  The build MUST carry the production relay env (VITE_RELAY_WS /
  VITE_RELAY_HTTP for qwenpaw-webchannel-relay.yxliwangsheng.workers.dev)
  as in the M3 deploy (check docs/m3-deploy-cf.md for the exact values used).
- After deploy: curl the Pages URL (200) and confirm the served JS contains
  the production wss URL and the new limit text.
- docs/m4-report.md + git commit "M4: SPA restore-on-load + attach limit alignment".
