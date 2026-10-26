# M4 task — SPA restore-on-load + attach limit alignment (spa/ only)

Read AGENTS.md first. Work ONLY in spa/src/App.tsx (touch relay.ts only if
strictly needed — it already forgets last_seq on resync; do not change its
protocol behaviour). Do not run builds; the coordinator builds and verifies.

## Fix 1 — restore the previous chat on page load
Current defect (verified on disk, App.tsx top of the App component): the
chat list is NOT persisted anywhere. `chatIds` is initialised as
`useState(() => [newChatId()])` on every page load, so a reload always lands
on a brand-new empty chat. Fix it:

- Persist the chat id list and the active chat id in localStorage, e.g.
  keys `webchannel.chats` (JSON array of strings) and
  `webchannel.activeChat` (string). Guard all localStorage access with
  try/catch (private mode may throw).
- Lazy initialisers: on load, read the persisted list; if it is a non-empty
  array of strings, use it and set the active chat to the persisted active
  id when it is in the list (else the first entry). Only when there is NO
  usable persisted state (true first visit) create one fresh chat via
  newChatId().
- Persist on change: a useEffect writing chatIds and activeChat whenever
  they change.
- `messagesByChat` initial state must contain an (empty) entry for every
  restored chat id, so titleOf/rendering don't break before hist arrives.
- History on load already flows through onState('live') →
  maybeRequestHist(activeRef.current); with the restored chat active this
  must result in {t:"hist"} being sent for it once connected, and the chat
  showing its returned messages (or the empty state if hist is empty).
  Do NOT create a new chat anywhere on mount/connect.
- "New chat" stays exclusively the sidebar button handler (newChat).
- Chat switching already hist-loads via selectChat → maybeRequestHist;
  keep that. Keep the resync case semantics (clear messages, loaded=false,
  requestHist) unchanged.

## Fix 2 — attach limit wording alignment
The frame-size enforcement already exists (MAX_FRAME_BYTES = 256*1024,
byteSize() of the serialized frame, checked in both onPickFile and send).
There is no "10MB" string left in the SPA. What is wrong is the wording:
two different long English error messages. Unify them:

- Add one helper, e.g. `oversizeError(sizeBytes)` returning exactly:
  `附件太大：v1 单条消息上限 256KB（含正文与附件编码），当前约 ${fmtKb(sizeBytes)}`
  and use it in BOTH the onPickFile rejection and the send() rejection,
  replacing the two existing English messages.
- Keep the enforcement points exactly as they are (check at pick time AND
  at send time; never send an oversize frame).
- Also change the Attach button title to `Attach a file (v1: whole message ≤ 256 KB)`
  so the visible wording matches the rule.

## Acceptance (coordinator will verify)
- `npm run build` passes (run by coordinator, not you).
- Built bundle contains: `webchannel.activeChat`, `附件太大` and the
  production relay URL when built with the production env.
- No `10MB` / `10 MB` strings anywhere under spa/src.
- Behaviour by construction: reload → same chat list, same active chat,
  hist requested on live, no new chat created on load.
