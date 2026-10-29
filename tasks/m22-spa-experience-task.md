# M22 — SPA experience pack (CodeBuddy task, SPA only)

Probe current code before EVERY item; implement in existing patterns
(spa/src/lib helpers + vitest where logic is pure; Playwright for UI).
Do not touch plugin/ or relay-*.

1. Dark theme: probe whether any theme support exists. Add a dark theme:
   toggle in the sidebar/header using existing icon patterns, default from
   prefers-color-scheme, persisted in localStorage, PWA theme-color meta
   follows the active theme. Both themes must keep the M14 mobile layout
   and 44px tap targets intact; check the usage meter, toasts, code blocks
   and 置顶 groups in dark at 390px and 1280px (screenshots).
2. Code highlighting: syntax-highlight fenced code blocks with a
   lightweight setup (highlight.js core + common languages or equivalent;
   report the bundle-size delta and keep it sane), show the language label
   next to the existing 复制 button, integrate with the streaming renderer
   without re-highlight flicker or duplicate wrappers.
3. Paste-to-attach: pasting files/images from the clipboard into the
   composer attaches them through the SAME path as the file picker /
   drag-drop (same size rules, same pending-attachment UI). Text paste
   must stay plain text paste.
4. Per-chat drafts: composer text is saved per chat id (localStorage),
   restored when switching back, cleared after a successful send. Unsent
   text in one chat must never leak into another.
5. Prompt library: user can save the current composer text (or a sent
   user message) as a named prompt, insert a saved prompt into the
   composer from a small panel (reachable from the composer area and/or
   the "/" palette — follow existing patterns), rename/delete entries.
   localStorage storage in a lib module with unit tests.

Tests: vitest for drafts + prompt library storage; Playwright additions
for theme toggle persistence, paste-attach (synthetic clipboard event is
acceptable), highlight presence. All existing tests keep passing;
`npm run build` + `npm test` pass. Do NOT commit, do NOT deploy.
Report per item: probe evidence, what shipped, bundle delta, test counts.
