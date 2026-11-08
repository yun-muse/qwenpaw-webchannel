# M45 — 消息操作与表格操作栏改为图标按钮

Task: user complaint (2026-11-08). SPA-only; `plugin/` and both relays are
untouched. M44's composer is untouched.

---

## 0. User-directed design input (2026-11-08)

The user's words: the labelled action buttons on messages are **oversized and
ugly** — specifically 复制为 Markdown and 编辑 in the per-message action row,
and by the same logic the table action bar. The requested pattern: **small
icon buttons; the text appears only as a tooltip when the pointer hovers**.

That is why every action in both rows is now icon-only, the old label lives in
`aria-label` (accessible name) and `title` (native hover tooltip), and no
visible text remains in either row. This is desktop behaviour too — the
message footer is a hover-tooltip surface — and the phone keeps the same
glyphs with the label as the accessible name (touch has no hover).

---

## 1. Button inventory (old label → glyph → name/title)

Lucide (`lucide-react` v1.62.0, already the app's icon set) is used for every
React-rendered button. All action glyphs are 16 px, stroke 2, round
caps/joins — the same visual weight as the M44 composer icons (13 px) and the
stats header icons (16/18 px); the table bar's decorative label glyph is
14 px so it sits with 11 px text.

| Row | Old visible text | Glyph (lucide) | `aria-label` | `title` |
| --- | --- | --- | --- | --- |
| message · assistant | 复制 Markdown | `FileCode2` (file-code-corner) | 复制 Markdown | 复制 Markdown（未渲染的原始源码） |
| message · user | 复制 | `Copy` (overlapping pages) | 复制 | 复制消息文本 |
| message · assistant | 重新生成 | `RotateCcw` | 重新生成 | 重新生成此回答 |
| message · user | 编辑 | `Edit3` | 编辑 | 编辑：放回输入框修改并重发 |
| table bar | 复制 Markdown 表格 | `ClipboardList` (16 px) | 复制 Markdown 表格 | 复制 Markdown 表格 |
| table bar | 复制到 Excel | `FileSpreadsheet` | 复制到 Excel | 复制到 Excel |
| table bar | 📊 结构化表格 | `Table` (14 px) + text | — (not a button) | — |

The table bar is built imperatively in `decorateMarkdown` (it decorates
`dangerouslySetInnerHTML` output), so its glyphs are emitted as inline SVG
strings by `spa/src/lib/glyphs.ts`. The path data is copied verbatim from
lucide-react v1.62.0 (ISC), with the same 24 viewBox / stroke 2 / round caps,
so the two rendering paths look like one set. `glyphs.ts` also carries the
`check` glyph used for copy feedback.

### Collision resolution

- **Plain copy vs Markdown copy**: distinct glyphs, not just a label. `Copy`
  means "copy the message text" (user bubbles); `FileCode2` means "copy raw
  Markdown source" (assistant bubbles).
- **Message Markdown copy vs table Markdown copy**: this was the one real
  collision — the table toolbar sits ~50 px above the message footer, so two
  identical `FileCode2` marks would look like the same action. The table
  action therefore uses `ClipboardList` (a clipboard with row markers: "copy
  these rows"), while the footer keeps `FileCode2` (the whole source file).
  Both tooltips state the exact scope.
- **Excel vs Markdown table**: `FileSpreadsheet` (grid in a file) vs
  `ClipboardList` — clearly different at 16 px.
- **Structured-table label vs Excel**: `Table` (grid) belongs to the bar's
  label; it is not an action and never sits next to the Excel button as a
  peer action.
- The `Check` glyph is used only as transient copy feedback (1.4 s, green
  `.copied` state), never as a resting state.

`结构化表格` is **not** a button: it has no click handler and never had one.
It keeps its text (an icon-only label would communicate nothing and remove
information) and gains the table glyph so the bar reads as one icon family.
Adding a button there would have been a behaviour change, which the task
forbids.

---

## 2. Sizing vs the tap-target audit

| Surface | Desktop (fine pointer) | Phone (≤720 px) | Coarse tablet |
| --- | --- | --- | --- |
| Message actions | 30×28 box, 16 px glyph | 44×44 box, 16 px glyph | 30×28 |
| Table actions | 30×28 box, 16 px glyph | 44×44 box, 16 px glyph | 44×44 |
| Table bar height | 36 px min | 48 px min | 48 px min |

- **No audit exclusions were added** and no assertion was weakened. The
  mobile message row is 44×44, so `TAP_TARGET_SCRIPT` passes unchanged.
- The M45 block is the first suite block whose chat contains a markdown table,
  so it now audits the table toolbar's hit areas too: 44×44 on the phone
  (measured `[[44,44],[44,44]]`), 0 audit violations.
- The table bar is gated on `@media (max-width: 720px), (pointer: coarse)`
  rather than the 720 px breakpoint alone, following the M22 lesson about
  coarse-pointer tablets wider than 720 px. The message row keeps its existing
  `max-width: 720px` block (its hover-reveal rule lives there too); no coarse
  tablet can reveal the user row's actions anyway, which is pre-existing
  behaviour and out of scope.
- Desktop deliberately sits at 28–32 px as the brief asks: this is the same
  house pattern as `.stats-icon-btn` (32×32, borderless, 16 px glyph).

The buttons are borderless at rest (`transparent` border/background) and gain
a quiet border + panel background on hover, so the visual footprint is the
icon itself, not a 44 px pill.

---

## 3. Tooltip and accessibility

- Every icon button carries **both** `title` and `aria-label`; the
  `aria-label` is exactly the old visible label (复制 Markdown / 复制 /
  重新生成 / 编辑 / 复制 Markdown 表格 / 复制到 Excel). The `title` starts
  with that label and, for the message row, keeps the old explanatory hint
  (e.g. 复制 Markdown（未渲染的原始源码）).
- The tooltip is the **native `title`** — the codebase has no tooltip
  framework, and the brief forbids inventing one. On touch there is no hover;
  `aria-label` is the floor, as required.
- No `tabindex`/focus popover was added: the buttons were already natively
  focusable, and the brief only allows a focus tooltip where an existing
  pattern exists.
- Feedback is now a glyph change (green check + `.copied` for 1.4 s) instead
  of a text swap; the accessible name stays the action name so it never
  changes mid-interaction.

---

## 4. Behaviour parity

No handler, frame, menu or visibility rule changed.

- `copy` still calls the same `copyText(copySource(message))`.
- 重新生成 still calls the same `onRegenerate` prop, 编辑 the same
  `onEditResend`; the M32 latest-ref dispatch (`rowActionsRef`) and the memo'd
  `MessageView` props are untouched — no new closures crossed the memo
  boundary.
- Table actions still delegate through `Markdown`'s one `onContainerClick`
  and the same `htmlTableToMarkdown` / `htmlTableToTsv` payloads.
- Desktop hover-reveal of the user footer is unchanged (`opacity` rule kept);
  phone footers stay always visible. M22 code-block chrome (`.pre-lang` /
  `.pre-copy`) was not touched.

The M45 checks click the message copy, 重新生成, 编辑, table Markdown and
table Excel buttons and verify the original effect: raw Markdown on the
clipboard, pipe-table Markdown, tab-separated Excel payload, the user text
returning to the composer, and 重新生成 re-sending the preceding user turn.
(The user bubble's 复制 shares the same `copy` handler as the assistant copy,
so it is asserted for name/size/title rather than clicked twice.)

---

## 5. Tests

| Suite | Result |
| --- | --- |
| `spa/npx vitest run` | **330 / 330** (21 files) |
| `tests/node e2e_m19.mjs` | **732 / 732**, 354.9 s |
| `tests/node e2e_m29.mjs` | **26 / 26**, 25.8 s |
| plugin / relay | untouched, not run |

`M45_ONLY=1 node e2e_m19.mjs` reports **34 checks, 0 failed** (15 desktop +
16 mobile + 2 no-page-errors + the one locale preflight). The 31 new M45
checks are the +31 over M44's 701.

New assertions (both desktop and mobile passes):

1. all four message actions are icon-only (`textContent === ""`, one SVG,
   16×16);
2. their `aria-label`s are exactly 复制 Markdown / 重新生成 / 复制 / 编辑;
3. every one has a non-empty `title`;
4. message action boxes are 28–32 px on desktop and 44×44 on the phone;
5. the table bar keeps the 结构化表格 label **with** a glyph;
6. table actions are exactly 复制 Markdown 表格 / 复制到 Excel and icon-only
   with titles;
7. table action boxes are 28–32 px desktop / 44×44 phone;
8. mobile-only: the full 44 px tap-target audit passes with the table on
   screen;
9. clicking copy yields the raw Markdown and shows the check feedback;
10. clicking the table Markdown action yields `| 项目 | 旧版 | 新版 |` /
    `| --- | --- | --- |`;
11. clicking the Excel action yields tab-separated cells;
12. clicking 编辑 restores the user text into the composer;
13. clicking 重新生成 sends the preceding user turn to the mock agent.

No existing e2e assertion clicked these buttons by visible text: the only
text-based checks in `e2e_m19.mjs` belong to the M22 `.pre-copy` code-block
chrome, which is a different element and was left alone. `tests/mobile_e2e.mjs`
selects `.copy-btn` / `.msg-act-btn` by class (unchanged) and only records
their text for diagnostics.

---

## 6. Screenshots (M40 policy)

Written by the M45 block through `tests/artifacts.mjs`; by default they land in
the gitignored `tests/out/` and a full-suite run leaves `git status` clean.

| File | Content |
| --- | --- |
| `tests/out/m45-before-mobile.png` | 390×844 (DSR 3), HEAD build: labelled pills |
| `tests/out/m45-before-desktop.png` | 1280×900, HEAD build: labelled pills |
| `tests/out/m45-after-mobile.png` | 390×844 (DSR 3), icon row + table bar |
| `tests/out/m45-after-desktop.png` | 1280×900, icon row + table bar |

Each shot contains one assistant message with its action row **and** a table
with its action bar. The harness measured both elements fully inside the
viewport in all four shots (`table+foot on one screen = true`), so the
`-msg` / `-table` split was not needed. The before shots see 119.9×24.1
labelled pills and 140.9×25.3 table pills at desktop; the after shots see
30×28 icon boxes. Native `title` tooltips are OS-level chrome and are not
captured by Playwright screenshots; the title text is asserted in the DOM.

---

## 7. Deliberate choices / deviations

1. **Mobile stays 44×44**, not the brief's "visual ~28–32 px". The 44 px
   audit measures the element box, so a 30 px visual would need an invisible
   padding wrapper (extra DOM, extra selectors) or an audit exclusion. 44 px
   is the M44 precedent; the box is borderless, so what the eye sees is the
   16 px glyph.
2. **The table label keeps its text** (结构化表格) — it is a label, not an
   action, and giving it an icon-only treatment would hide information without
   adding a tooltip that has nothing to explain.
3. **The table Markdown action uses `ClipboardList`, not `FileCode2`** —
   sharing the footer's Markdown glyph would put two identical marks ~50 px
   apart with different scopes (whole message vs table only); see §1.
4. **Copy feedback is a check glyph**, not the old "已复制 Markdown" text —
   the user asked for no visible text, and the green `.copied` state plus the
   check is the icon-only equivalent.
5. **Assistant copy's title changed** from 直接复制未渲染的原始 Markdown 源码
   to 复制 Markdown（未渲染的原始源码） so the hover text opens with the old
   visible label, as the brief requires.
6. **`spa/src/lib/glyphs.ts` duplicates four lucide paths** (table,
   clipboard-list, file-spreadsheet, check) for the imperative table bar.
   React cannot render into that DOM walk, and pulling `react-dom/server` into
   the bundle for four icons would be worse; the file is documented as
   verbatim lucide v1.62.0 data.
7. **ViewImage was denied in this non-interactive session** (same limitation
   as M44 §8.8), so the screenshots could not be inspected by eye here. The
   design was verified through `getBoundingClientRect` measurements, computed
   geometry (30×28 / 44×44, 16×16 glyphs), the audit, PNG dimension/colour
   checks and a coarse ASCII render of the table-bar and footer glyph regions
   (the two table glyphs and the file-code/rotate pair are visibly distinct).
   The four shots are left in `tests/out/` for human review.

---

## 8. Files changed

- `spa/src/App.tsx` — icon-only message footer, title/aria-label, table bar
  built with glyphs + updated feedback.
- `spa/src/App.css` — 30×28 / 44×44 icon-button boxes, table bar/title/action
  styles and the coarse-pointer gate.
- `spa/src/lib/glyphs.ts` — new; inline SVG for the imperative table toolbar.
- `tests/e2e_m19.mjs` — `runM45Checks`, table fixture, `M45_ONLY` /
  `M45_BEFORE`, screenshot capture.
- `docs/m45-report.md` — this report.
