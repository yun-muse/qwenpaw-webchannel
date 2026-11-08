# M44 — 手机端紧凑输入区（composer）

Task: `tasks/m44-mobile-composer-task.md`. SPA-only; `plugin/` and both relays
are untouched.

---

## 0. User-directed design input (2026-11-08)

The user explicitly steered the solution towards **overlays/popovers**, not
inline expansion:

- Controls such as model selection and thinking effort are naturally
  "press a button, get a floating panel".
- Prefer popovers / floating sheets wherever that saves vertical space; fold
  more aggressively if it still reads well (e.g. secondary utilities behind
  one expand affordance).
- Hard limits on that freedom: every feature stays at most **1 extra tap**
  away, tap-target/audit rules hold, and the busy-state 停止 button plus the
  排队/立即发送 mode control stay visible **without opening anything**.

This is why both chips open floating panels and why no second "more" menu was
introduced: the three utility buttons (附件 / 技能 / 提示词) are already only
one tap from the strip, so folding them one level deeper would have cost a tap
without saving a row.

---

## 1. Before (measure, don't eyeball)

Harness: `M44_BEFORE=1 M44_ONLY=1 OUT_DIR=./out node tests/e2e_m19.mjs`, which
loads `chat-alpha` at 390×844 and reads `.composer-card` with
`getBoundingClientRect()`.

**Before: 216.0 px** at 390×844 idle. Desktop 1280×900 idle: **97.0 px**.

The measured number is lower than the brief's "~250–290 px" estimate because
the card's own padding is small; the bulk is the toolbar wrapping into three
rows at 390 px (the toolbar alone was 161 px: three 44 px utility buttons, a
full-width model row, then the effort segments + send row).

Evidence: `tests/out/m44-before-idle.png`.

---

## 2. Design shipped

Idle (390 px), card = 110 px:

```
row A   [ textarea (44 px, 16 px font) ...................... ] [ 发送 44 ]
row B   [附件44] [技能44] [提示词44] [ mock / mock-1   ▾ ] [ 默认 ▾ ]
```

- **Row A** — the existing textarea with the send/stop button moved inline at
  its right. The field is 44 px tall for one line (font stays 16 px), autogrows
  to 104 px (four lines at 16 px / 1.5) and then scrolls internally.
- **Row B** — one 44 px strip:
  - icon-only 附件 / 技能 / 提示词 buttons, still 44×44, with the original
    `title` plus a new `aria-label` (the visible label is hidden by CSS);
  - a **model chip**: the existing `Cpu` icon + truncated
    `provider / model`, opening the **existing** model picker;
  - an **effort chip** showing the current Chinese level label
    （默认/低/中/高/最大）, opening the **existing** five segments as a floating
    panel above the composer.
- **Placeholder** — mobile: `输入问题…` (single, short line); offline:
  `断线中 — 发送会先排队`. Desktop keeps the long placeholder verbatim.
- **Busy** — the card gains `.busy`: model and effort chips yield (hidden),
  停止 stays inline in row A, the 排队/立即发送 switch sits at the right of
  row B, and the three utility icons remain at the left. Card = 114 px; stop
  (72×44) and switch (133×48) are fully on screen at 390×844.
- **Desktop** — no mobile rule applies; the two-deck toolbar, labelled pills,
  inline segments and 97 px card are unchanged.

### Implementation notes

- The compact layout is a **CSS-only reflow of the same DOM** (no duplicated
  controls, refs or handlers). At `max-width: 720px`, `.composer-card` becomes
  a two-column grid and `.composer-toolbar` / `.composer-tools-right` become
  `display: contents`, so the existing toolbar children join the grid:
  textarea → row 2 / column 1, `.send`/`.stop` → row 2 / column 2,
  `.composer-tools-left` → row 3. Pending skill/attachment chips span both
  columns in row 1 (`spa/src/App.css`, M44 block).
- The 4-line autogrow cap is read from the **computed** `max-height`, replacing
  the hardcoded `200` in the textarea effect. Desktop still computes 200 px, so
  its behaviour is unchanged.
- `useNarrowViewport()` exists only to swap the placeholder text (CSS cannot
  change an attribute); it listens to the same `(max-width: 720px)` query.
- The effort popover has its own open state, closes on choice, outside click
  and Escape, and reuses the existing `.effort-group` buttons untouched.
- Because the model chip is now mid-strip, `.model-wrap` is `position: static`
  on phones and the existing picker anchors to `.composer` with 8 px insets;
  the effort panel does the same. Both float above the whole composer, like the
  prompt library already did.
- The `vision:false` hint collapses to a 22 px `!` badge on phones (same
  `title`), so an exotic model cannot wrap the strip onto a second line.
- Composer key handling was not touched: `lib/keys.ts` still owns Enter /
  IME / palette behaviour.

---

## 3. Measured heights

All numbers are `getBoundingClientRect().height` of `.composer-card`, live DOM,
idle unless stated. The context meter (28 px on phones) and the M37/M43 strips
are siblings **outside** the card, so they are excluded by construction.

| State | Viewport | Before | After |
| --- | --- | ---: | ---: |
| Idle, empty textarea | 390×844 | **216.0 px** | **110.0 px** |
| Idle, empty textarea | 1280×900 | 97.0 px | 97.0 px |
| 3-line draft | 390×844 | — | 146.0 px |
| 10-line draft (capped) | 390×844 | — | 170.0 px (field 104 px, scrolls) |
| Busy (turn running) | 390×844 | — | 114.0 px |

The 150 px gate is an **idle** budget and is met with 40 px of headroom. A
draft deliberately grows the card up to the four-line cap; the harness
therefore asserts *bounded* growth (`card growth <= textarea gain` and the
field scrolls) instead of `<= 150 px` for the capped state. That assertion was
added by the stopped session and adjusted here to match the design, not
weakened.

---

## 4. Tap targets

**No audit exclusions were added.** The existing 44 px `TAP_TARGET_SCRIPT` still
runs unmodified at 390 px idle (`M44`, `M22 light/dark`), and now covers:

- 附件 / 技能 / 提示词: 44×44 (were 44 tall but labelled);
- model chip 44 px tall; effort chip 56×44;
- 发送 72×44; busy 停止 72×44; 排队/立即发送 switch 133×48 with 44 px options;
- the five effort options at 44×44 while the popover is open.

The strip is **44 px** tall rather than the brief's suggested 36–40 px: 44 px
is the audit floor, and the task explicitly forbids shrinking below it. The
M15 context-meter exclusion is untouched and unrelated.

---

## 5. Tests

| Suite | Result |
| --- | --- |
| `spa/npx vitest run` | **330 / 330** (21 files) |
| `tests/node e2e_m19.mjs` | **701 / 701**, 338.6 s |
| `tests/node e2e_m29.mjs` | **26 / 26**, 25.7 s |
| plugin | untouched, not run |

`M44_ONLY=1 OUT_DIR=./out node tests/e2e_m19.mjs` reports 23 checks (locale
preflight + 4 desktop + 18 mobile), 0 failed.

The stopped session's harness was kept and reviewed. Changes made:

- desktop baseline corrected to the measured **97 px** (the previous `92.4`
  constant did not match HEAD);
- `M44_STRIP` compares **vertical centres** instead of tops (the compact
  vision badge is shorter than the buttons);
- the capped-draft assertion now checks bounded growth (see §3);
- the effort flow expects the popover to **close on choice** and then re-opens
  it, instead of assuming it stays open;
- the stop cleanup tolerates a mock turn that finished during the screenshot
  (the busy assertions already ran);
- `runM44Checks` is now part of the **full** desktop/mobile run, not only
  `M44_ONLY`;
- `runM27Checks` opens the effort chip first on phones (its segments now live
  behind the popover), via a local `pickEffortLevel()` helper.

M44 assertions cover: idle ≤150 px, send inline with the field, one-line strip
(5 controls, centres aligned), 44 px audit, single-line 16 px placeholder,
autogrow + 4-line cap, model picker open/choose/restore, effort popover
open/choose/reopen, busy stop + mode control in viewport without scrolling,
model/effort yielding while busy, and `@` / `/` palettes still opening from
the textarea. Desktop asserts the two-deck toolbar, three labelled pills, five
inline segments, long placeholder and the unchanged 97 px height.

---

## 6. Screenshots

All under the gitignored `tests/out/` (M40 artifact policy):

| File | Content |
| --- | --- |
| `m44-before-idle.png` | 390×844 idle, pre-change build |
| `m44-after-idle.png` | 390×844 idle, compact layout |
| `m44-after-typing.png` | 390×844 with a 3-line draft (146 px) |
| `m44-after-busy.png` | 390×844 busy: 停止 + 排队/立即发送, chips yielded |
| `m44-after-desktop.png` | 1280×900 idle, unchanged deck |

Phone shots use Playwright's iPhone 13 context (deviceScaleFactor 3); the
desktop shot is 1×. The full-suite run leaves `git status --porcelain` clean
except for the intended `spa/src/App.{tsx,css}`, `tests/e2e_m19.mjs`,
`AGENTS.md` and this report.

---

## 7. Deliberately unchanged

- Desktop layout and behaviour (same DOM, same CSS above 720 px; 97 px card).
- `plugin/` and both relay implementations (no protocol change).
- Textarea font (16 px on phones, 15 px on desktop) and all message/global
  font sizes.
- `lib/keys.ts` IME/Enter guards; M41 tests stay green.
- M37 outbox rows and the M43 queue strip (still above the card).
- Pending attachment/skill chips (still above the textarea, row 1).
- Command palette, `@` skill picker and `/` command flows.
- Safe-area handling: `.composer` padding is untouched
  (`6px 12px 12px` on phones), so the bottom inset behaves exactly as before.
- Context meter row (28 px mobile, already excluded from the tap audit).

---

## 8. Deviations and notes

1. **Strip height 44 px, not 36–40 px** — the 44 px tap-target audit is the
   floor; a 36 px strip would fail it.
2. **Drafts exceed 150 px** — only idle is a budget. Three lines = 146 px;
   the four-line cap = 170 px. The brief asks for "~4 lines then scrolls", so
   the card must grow; the field stops growing and scrolls instead.
3. **Busy switch is on its own row below 停止**, not literally beside it. At
   390 px, stopping + switch + a usable textarea cannot share one row
   (72 + 133 + textarea). Both are on screen without scrolling and M43's
   "switch before stop" DOM-order check still passes; the textarea keeps
   264 px.
4. **No provider artwork** — the codebase has one model icon (`Cpu`); the chip
   keeps it and truncates the existing `provider / model` label.
5. **Effort popover closes on selection** (the earlier harness snapshot
   assumed it stayed open); choosing a level is a complete action, and the
   chip immediately shows the new label.
6. **Vision hint is icon-only on phones** — a 22 px `!` badge with the original
   `title`; the full sentence returns on desktop.
7. **Desktop baseline 97 px** — the old `92.4` assertion in the stopped
   session's harness was stale; this report records the measured value.
8. **Verification was measurement-based** — this non-interactive session was
   denied `ViewImage`, so the shots could not be inspected by eye here. Layout
   was checked through `getBoundingClientRect`, in-viewport assertions,
   overlap/one-line checks and a coarse pixel/ASCII pass over the captured
   PNGs. The screenshots are committed to `tests/out/` for human review.
