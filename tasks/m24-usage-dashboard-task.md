# M24 — Usage dashboard (CodeBuddy task, plugin + SPA)

1. Probe the data first: M11/M15 already read workspace session files
   (workspace/sessions/web/*.json) for per-chat usage. Establish what an
   ALL-chats aggregate can honestly claim: which chats have session files,
   what timestamps each turn carries, timezone basis. Write the coverage
   conclusion into the report before coding.
2. Plugin: a stats control frame (follow the get_usage/usage control-frame
   conventions: no seq, never raises into the chat path) returning:
   totals (turns, input, output) across covered chats, a per-day series
   (date, turns, input, output; day boundary in the container's local
   time — state it), and top chats by total tokens (chat id, title if
   resolvable, turns, input, output; cap 10). Unknown/uncovered chats are
   excluded silently from numbers but their count is reported as
   `uncovered_chats` so the UI can be honest. Cache like the usage handler
   does (mtime/size) — stats must not rescan everything per open if the
   existing cache pattern can be reused.
3. SPA: a 用量统计 view reachable from the sidebar: totals cards, a
   per-day bar chart (pure CSS/SVG, no chart dependency), top-chats list
   (click jumps to that chat), and a basis note （数据来源/覆盖范围 from
   the probe). Loading + empty states; mobile layout at 390px checked.
4. Tests: plugin plain-assert suite with fake session files (aggregation,
   day bucketing, uncovered counting, malformed files skipped); SPA vitest
   for the series-shaping helper. All existing suites pass; SPA build +
   npm test pass. Rebuild dist/webchannel.zip and report size + MD5.
   Do NOT commit, do NOT install to the hosted instance (coordinator +
   parent handle deployment).
