# M25 — Fork + bulk export (CodeBuddy task)

1. Conversation fork (PROBE-GATED): against the QwenPaw v2.2.2.post1
   reference source (~/workspace/qwenpaw-ref), determine whether a NEW
   chat can be created with seeded history through a supported API (chat
   creation parameters, console chat APIs, session import). Fork means:
   new chat whose context is the source conversation up to a chosen
   message. If a clean supported path exists: implement plugin frame +
   SPA action （在此分叉） on messages, forked chat appears in the list
   with a distinguishable title suffix, original chat untouched.
   If the only paths are history-file surgery or replaying messages as
   fake user turns (context pollution), SKIP with cited evidence.
2. Bulk export (SPA only, uses existing per-chat export): an 导出全部
   action (sidebar/settings area, existing patterns) that iterates the
   server chat list, exports each chat through the EXISTING export frames
   one at a time, downloads each .md, shows progress (n/N, current title),
   can be cancelled, and ends with a summary toast (succeeded/failed
   counts; failed titles listed in console or a details line — never
   silently dropped). Respect the per-export 10MB cap behaviour per chat.
   Cap the batch at 100 chats with an honest note if the list is longer.
   Archived-only chats are not in the server list — state that limit in
   the UI copy near the action.

Tests: Playwright or vitest for the bulk-export orchestration with a
stubbed transport (order, progress, cancel, failure accounting); plugin
tests if the plugin changed. Existing suites pass; build + npm test pass.
Rebuild the plugin ZIP only if plugin code changed. No commit/deploy.
Report per item: probe evidence, shipped or skipped (why), test results.
