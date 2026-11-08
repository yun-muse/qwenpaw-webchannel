# M44 — Mobile composer slimming (user-reported 2026-11-08)

## User complaint (their screenshot: ~/workspace/user/files/1000019789_1_qhpg.jpg)

On the phone (Redmi K70 Ultra, Android, 390 CSS px wide) the bottom composer eats
roughly 30% of the viewport, leaving too little room for the conversation. The
user's fonts are intentionally largish; the problem is the composer CHROME, not
the message text. Stacked today (idle state): 2-line textarea (placeholder
wraps to 2 lines), a row of three chunky labelled pills (附件 / @ 技能 /
提示词）, a full-width model selector row, and an effort segmented row
（默认/低/中/高/最大） + 发送 button. Plus the thin context bar above it
（上下文 ~20%).

## Goal

Mobile-only compact composer. Desktop layout byte-for-byte behaviourally
unchanged. Nothing removed — every feature reachable in at most one extra tap.

### Hard targets (measure, don't eyeball)

- At 390×844, IDLE (empty textarea, not busy): total composer height
  (textarea block incl. all control rows and internal padding, EXCLUDING the
  context-usage bar and any queue/outbox strips) **≤ 150 px**, down from the
  current ~250–290 px. Report before/after measurements from the live DOM
  (getBoundingClientRect) in the report.
- Textarea font-size stays ≥16px (iOS auto-zoom) and message-area / global
  font sizes are NOT touched.
- Safe-area bottom inset preserved.

### Suggested shape (starting point — iterate visually if needed)

- Row A: textarea (min-height one line, autogrows to ~4 lines then scrolls)
  with 发送/停止 button inline at its right.
- Row B, one compact strip (~36–40px tall): icon-only buttons for 附件 /
  @ 技能 / 提示词 (keep title + aria-label), a model chip (provider icon +
  truncated model name, tap opens the EXISTING model picker), and an effort
  chip showing the current level label （默认/低/中/高/最大）, tap expands
  the EXISTING segmented options (inline expand or popover — pick what fits
  the codebase cleanly).
- Placeholder: single line on mobile, ellipsised （输入问题… suffices; the
  @ / 提示 stays discoverable via the icon buttons).

### Must not break

- Busy state (M42/M43): 停止 button + 排队/立即发送 mode control must remain
  reachable and tappable in the compact layout while a turn is running (it is
  acceptable — even preferable — for the model/effort strip to yield space
  while busy, but the mode control and stop must not need scrolling).
- M43 queue strip and M37 outbox rows render above the composer as today.
- M41 IME guards: do not restructure composer key handling in a way that
  bypasses lib/keys.ts; M41 tests must stay green.
- Pending attachment chips row: still visible above the textarea when files
  are staged.
- Command palette / @ / slash flows still trigger from the textarea as today.

## Evidence & tests

- Before/after screenshots at 390×844 (idle, typing with text, busy with the
  mode control + stop) plus one desktop 1280×900 idle shot proving the desktop
  layout is unchanged. Screenshots go to tests/out/ per the M40 artifact
  policy; full suite run leaves `git status` clean.
- Add/extend e2e assertions: compact strip present at mobile width (composer
  height ≤150px idle), desktop width unchanged (existing layout markers),
  model picker + effort options still operable from the chips, busy state
  shows stop + mode control.
- Full suites green: plugin (untouched expected), vitest, e2e_m19, e2e_m29.

## Deploy

SPA only expected. Build MUST set
VITE_RELAY_WS=wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/client
and VITE_RELAY_HTTP=https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev,
then tools/verify_release.py must PASS and production version.json must match
the new commit. Report: docs/m44-report.md with the measured heights table.
