# M46 Session 2b — SPA: consume hist kind + stop guard + Part B collapse

Repo: ~/workspace/qwenpaw-webchannel. Read AGENTS.md,
tasks/m46-thinking-block-task.md Part B, and docs/m46-report.md (§2, §3, §6,
§7). The plugin fix (separate session) makes `hist` rows for reasoning
carry `kind: "reasoning"` and bumps the protocol to v13; the cancelled-turn
partial text is answer-only plugin-side. This session is SPA + e2e + docs.
Do NOT touch plugin/.

## Changes (spa/src/App.tsx, App.css, relay.ts if needed)

1. **Consume kind.** `HistoryMessage` gains `kind?: 'reasoning'`;
   `historyMessages()` copies it through; `appendHistory` maps a reasoning
   row to `{role:'assistant', kind:'text', text:'', thinking: item.text}`
   in the same list position (never merge it into the following answer
   row — order matters for interleaved histories).
2. **Thinking-only render.** In `MessageView`, when a message has
   `thinking`, empty `text`, and is not streaming, render only the
   thinking block — no empty bubble, no footer/copy row. Messages with
   both thinking and text keep the current structure.
3. **Rollout guard (defense-in-depth for pre-v13 plugins).** In the
   `case 'msg'` handler's stopped branch (`frame.stopped === true`,
   `rt.endedId != null`): if the bubble's `thinking` is non-empty and the
   incoming text starts with exactly that thinking string, strip that
   prefix before applying. Comment it as a rollout guard; the plugin fix
   is authoritative.
4. **Protocol pin.** If the SPA pins protocol version 12 anywhere
   (constant, test, comment with behavioural meaning), update to 13 to
   match the plugin; grep first.
5. **Part B — collapsible, collapsed by default.** Replace the native
   `<details className="thinking" open={...}>`:
   - Header row + body only when open. Default CLOSED in every state:
     live-streaming, live-settled, history-loaded. Remove the old
     auto-open (`open={streaming && !text}`) entirely.
   - Header: a real `<button type="button" className="thinking-toggle">`,
     full width, `aria-expanded`. Label `💭 思考过程`; while the reasoning
     segment is still streaming show `思考中…` plus a subtle pulsing dot;
     right side: character count `· N 字` (from `thinking.length` —
     honest data only, NO duration) and a chevron that flips when open.
   - State: per-block in-memory `useState` inside `MessageView`. Do NOT
     add props or new row callbacks (M32 memo / rowActionsRef identity
     rules). After reload all blocks are collapsed again — by design.
   - Body: plain text exactly as today (`.thinking-body`; NOT markdown;
     no KaTeX). Do not mount the body DOM while closed.
   - Tap target: header min-height 44px under
     `@media (max-width: 720px), (pointer: coarse)`; ~32px on desktop
     (M44/M45 approach; no audit exclusions).
   - Keep `.thinking` / `.thinking-body` class names; add
     `.thinking-toggle`.
6. **Copy/export semantics unchanged.** Verify and state in the report:
   bubble copy / 复制 Markdown excludes thinking (copySource); the
   Markdown export includes reasoning folded (plugin-side, unchanged).

## E2E (tests/e2e_m19.mjs, M46 pack)

- Mock hist fixture for the thinking chat now serves `kind:"reasoning"`
  on the reasoning row; the mock stop turn emits the FIXED sequence
  (answer-only partial).
- Add a legacy-stop variant (old buggy stopped sequence with the
  reasoning prefix) asserting the SPA guard (change 3) prevents the dump.
- Extend assertions: hist reasoning block present, collapsed by default,
  no body dump; toggle expands (body visible) and collapses again; live
  streaming header shows 思考中 and stays collapsed (never auto-expands);
  settled block collapsed; stop (fixed + legacy) never dumps; interleaved
  turn shows two thinking blocks, both collapsed.
  ALSO: wire runM46Checks into the full-suite flow the way runM44Checks /
  runM45Checks are wired (today it only runs under M46_ONLY).
- Screenshots (explicit setViewportSize(390, 844), tests/out/ per M40):
  `m46-after-collapsed.png` — a long-reasoning turn as ONE collapsed row
  above its answer; `m46-after-expanded.png` — the same block expanded.
- Full suites green: vitest, e2e_m19 full (both passes), e2e_m29. A full
  run leaves `git status` clean apart from intended changes.

## Docs

- Complete docs/m46-report.md: SPA fix + Part B sections (collapse
  behaviour in live/settled/hist states, header contents, tap target),
  final combined test counts (plugin counts are in the report already),
  the copy/export statement. Keep §7 residual risks as-is.
- Add the M46 one-liner to AGENTS.md (existing convention) and the
  milestone row in docs/README.md if prior milestones have one.
- Do NOT deploy. Do NOT package the plugin. The coordinator verifies,
  commits, deploys and packages.

## Environment note

Intermittent write gate (EPERM bursts) in this environment: retry failed
writes sequentially, read back to verify, keep going; note incidents in
your summary.

End your output with: files changed, test counts per suite, screenshot
paths, anything left unverified.
