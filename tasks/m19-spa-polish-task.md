# M19 — SPA polish pack (CodeBuddy task, SPA only)

For EVERY item: probe the current code first, cite evidence, implement only
what is missing, keep changes minimal and in the SPA's existing patterns.
Do not touch plugin/ or relay-*. Items:

1. Code-block copy button: rendered markdown code blocks get a copy button
   (top-right of the block), click copies the raw code, brief "已复制"
   feedback. Must survive streaming re-renders without duplicate buttons.
2. Scroll-to-bottom button: when the user has scrolled up in the message
   list (especially while a reply streams), show a floating button that
   smooth-scrolls to the latest message. Hidden when already at bottom.
   Respect the existing auto-scroll behaviour otherwise.
3. Cross-device deletion edge (known leftover from M17): restoreSession()
   validates the persisted activeChat only against the locally persisted
   list, so a chat deleted on another device reopens empty. Fix: once the
   server chat list arrives, if the restored chat is absent server-side,
   fall back gracefully (newest server chat or a fresh chat) with a subtle
   toast, and clear the stale persisted id.
4. Chat pinning: pin/unpin a chat from the sidebar (context action in the
   existing chat-item UI patterns), pinned chats render in a 置顶 group on
   top, pins persist in localStorage keyed by chat id, pins for chats that
   no longer exist server-side are pruned silently. Server data model and
   plugin protocol unchanged.
5. Usage totals in the meter details: the context-meter click popover gains
   session totals IF the data is already available client-side (usage frame
   totals and/or per-turn receipts): turn count, total input/output tokens.
   Show only numbers the SPA actually has; omit missing ones, never estimate.
6. Keyboard shortcuts: Cmd/Ctrl+K focuses the archive search input;
   Cmd/Ctrl+Shift+O starts a new chat. Check for conflicts with existing
   handlers and browser defaults first; list the shortcuts in the existing
   Help surface.

Tests (yours to write AND run): extend or create a Playwright suite in the
repo's established style that exercises items 1–4 and 6 against a locally
served production build (vite preview) at desktop 1280px and mobile 390px,
with screenshots saved under tests/ for the new UI elements. All tests must
pass; `npm run build` must pass. Do NOT commit, do NOT deploy.
Report per item: probe evidence, change made or why skipped, test results.
