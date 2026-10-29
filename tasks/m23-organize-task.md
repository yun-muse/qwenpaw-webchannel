# M23 — Organization & navigation (CodeBuddy task, SPA only)

Probe first (sidebar, pinning/chatState lib, archive search, history
rendering). SPA only; no plugin/relay changes.

1. Chat tags: assign one or more text tags to a chat from the existing
   chat-item actions; tags persist in localStorage keyed by chat id
   (extend the chatState patterns from pinning; prune tags for chats that
   vanish server-side the same way pins are pruned). Sidebar shows tag
   filter chips （全部 + each tag); a chat matches when it has the tag.
   Keep 置顶 grouping working with and without an active tag filter.
2. Command palette: upgrade Ctrl/⌘+K into a real palette — a centered
   overlay with one input that filters BOTH actions （新建会话， 导出当前
   会话， 全文搜索， 切换主题， 切换模型， 打开用量/帮助 — only actions that
   already exist as features) AND chat titles (jump to chat). Arrow keys +
   Enter + Esc fully supported. The previous Ctrl/⌘+K behaviour (focus
   archive search) becomes one palette action instead of a separate
   binding; update Help text accordingly. Mobile: palette is full-width
   and reachable from the existing header menu too.
3. Search jump-to-message: clicking an archive search result opens the
   chat AND scrolls to the matched message with a brief highlight flash.
   Probe what identity a history message carries (ids in the hist payload,
   original_id anchors from M15, or index/text matching) and use the most
   reliable available anchor; if exact anchoring is impossible for some
   messages, land at the nearest position and say so in the report —
   never fake precision. Search results for archived-only chats keep the
   existing 「仅归档」 behaviour.

Tests: vitest for tag storage/filtering + palette filtering logic;
Playwright for palette keyboard flow, tag assign+filter, and a
jump-to-message case against a seeded local conversation if feasible
(otherwise a component-level test with recorded hist data — state which).
Existing suites keep passing; build + npm test pass. No commit/deploy.
Report per item with probe evidence and any precision limits.
