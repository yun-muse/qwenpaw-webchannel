# M4 Report — SPA restore-on-load + attach limit alignment

Date: 2026-10-27. Scope: `spa/` only; plugin and relays untouched.

## Engine & model evidence

All product code was written by **CodeBuddy CLI**, pinned
`--model deepseek-v4.1-flash`. Session jsonl
`~/.codebuddy/projects/home-hatch-workspace-qwenpaw-webchannel/01a179b2-9cb0-74de-9ec5-4f53397d2629.jsonl`:
58 model entries, all `deepseek-v4.1-flash`, no other model. One file
changed: `spa/src/App.tsx` (+73/−15). The coordinator independently
reviewed the diff line by line and re-ran every check below.

## Fix 1 — restore the previous chat on load

Disk check first (per AGENTS.md): the brief assumed the chat list was
already persisted — it was **not**. `chatIds` was initialised as
`useState(() => [newChatId()])` on every load, which is exactly the M3
acceptance defect (reload → brand-new empty chat).

Changes in `spa/src/App.tsx`:

- New localStorage keys `webchannel.chats` (JSON id array) and
  `webchannel.activeChat`, all access wrapped in try/catch helpers
  (`storageGet`/`storageSet`) so blocked storage degrades to
  session-only behaviour instead of throwing.
- `restoreSession()` runs once as the `useState` initializer and is the
  single source for the initial `chatIds`, `activeChat` and
  `messagesByChat` (an empty entry per restored chat), so the three
  states can never disagree on first render. Persisted active id is
  honoured when it is in the list, else the first chat. A fresh
  `newChatId()` is created **only** when there is no usable persisted
  state (true first visit). Verified call sites: `newChatId()` now
  appears only in `restoreSession()` (fallback branch) and in the
  sidebar `newChat` button handler — never on mount/connect.
- A `useEffect` persists `[chatIds, activeChat]` on every change.
- History on load uses the existing flow unchanged: the RelayClient is
  created with `activeRef.current` = the restored chat, and
  `onState('live')` → `maybeRequestHist(active)` sends `{t:"hist"}` for
  it (its `loaded` flag starts false). Returned messages render via the
  existing `hist` handler; an empty hist marks the chat loaded and the
  UI shows the empty state **for that same chat**, not a new one.
- Sidebar switching keeps `selectChat` → `maybeRequestHist`, which
  hist-loads any chat whose history isn't loaded yet.
- Resync semantics unchanged (AGENTS.md): relay.ts still forgets the
  per-chat `last_seq` on `resync`; the App still clears the chat and
  re-requests hist.

## Fix 2 — attach limit wording alignment

Enforcement already matched the v1 rule (serialized frame size via
`byteSize()` against `MAX_FRAME_BYTES` = 256KB, checked at pick time
and again at send time; no `10MB`/`10 MB` string existed anywhere under
`spa/src` — the 10MB figure lives only in old reports and the
plugin-side decode cap). What was wrong was the wording: two different
long English errors. Changes:

- One helper `oversizeError(sizeBytes)` returning
  `附件太大：v1 单条消息上限 256KB（含正文与附件编码），当前约 <size>` —
  now used by BOTH the pick-time and the send-time rejection (same
  enforcement points, oversize frames are still never sent).
- Attach button title changed to
  `Attach a file (v1: whole message ≤ 256 KB)`.

## Build evidence (coordinator-run)

Production-env build (same values as the M3 deploy):

```
VITE_RELAY_WS=wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/client
VITE_RELAY_HTTP=https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev
npm run build → PASS (35 modules)
dist/assets/index-inEyK_eT.js  231.85 kB / gzip 76.32 kB
```

Bundle greps on the local build: `webchannel.activeChat` ×1,
`webchannel.chats` ×1, `附件太大：v1 单条消息上限 256KB` present,
production `wss://…/ws/client` present, `whole message ≤ 256 KB`
present, no `10MB`.

## Deploy (Cloudflare Pages, connector route)

- Connector re-verified first (`cf.py verify` → token `active`,
  expires 2027-10-27). Wrangler ran with the `hsurr:` surrogate from
  `dynamic_credentials` held only in a shell variable as
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID= <cloudflare-account-id>…`:
  `wrangler pages deploy dist --project-name qwenpaw-webchannel-spa
  --branch main` → success, deployment
  `https://7ee24ef7.qwenpaw-webchannel-spa.pages.dev`.
- Post-deploy check #1 hit the M3-known propagation lag: the
  production root still served the old M3 asset
  (`index-DB_QePs8.js`, 231,440 B) for the first minute. After ~45 s
  the production root serves `index-inEyK_eT.js`.
- Served-bundle verification (production domain): root **200**,
  `<title>QwenPaw WebChannel</title>`; served JS is 231,925 bytes and
  contains `webchannel.activeChat`, `webchannel.chats`,
  `附件太大：v1 单条消息上限 256KB`, the production `wss://…/ws/client`
  URL and `/api/login`; no `10MB`. Relay `/health` at the same time:
  `{"ok":true,"agentOnline":true,"clients":1}` — the hosted `work`
  agent is online behind the restored-chat hist path.

## What was NOT runtime-verified

- The actual in-browser reload behaviour (localStorage restore → hist
  render) was **not** driven in a live browser in this milestone; the
  state flow was verified by close code inspection (above) and by the
  bundle-content checks. The server side of the flow (`hist` handler,
  resume/resync) is unchanged code that passed the M2 live e2e.
- Local smoke was skipped: the local stack (relay-node :8787, local
  QwenPaw :8088) was down after a runtime restart and M4 touches no
  local-stack component; recorded here per the brief's allowance.
