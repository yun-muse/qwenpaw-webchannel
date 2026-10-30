# M26 — Sidebar redesign (CodeBuddy task, SPA only)

The owner looked at the mobile sidebar (dark theme) and called it ugly.
He is right about the chat list in particular. Redesign the sidebar —
above all the chat list — to mature-product standard (think ChatGPT /
Claude sidebars). SPA only; no behaviour/feature may be lost.

What is wrong today (from the owner's screenshot, 390px, dark):
- Each chat item is a tall chunky card (~110px): title line plus a
  permanently visible row of 4 action icons （标签/置顶/重命名/删除）.
  Only ~3 chats fit on a phone screen.
- Item styling is inconsistent: some items render as raised cards,
  others flat (group/state-dependent), titles truncate awkwardly.
- The top actions （新建会话 / 用量统计 / 导出全部） are oversized blocks;
  the export scope note sits inside the block wasting more height.

Design requirements:
1. Chat list = compact flat rows, 44–52px tall, one line: title
   (ellipsis, proper CJK truncation) + at most one small status/pin
   glyph. No card backgrounds; selected chat gets a clear but quiet
   active background; hover/pressed states subtle. Target: at least 8
   chat rows visible in the 390×844 drawer (excluding header/actions).
2. Per-chat actions move behind ONE affordance per row: a "⋯" button on
   mobile (always visible, ≥44px tap area) / hover-revealed on desktop,
   opening a menu (bottom sheet on mobile, dropdown on desktop is fine)
   with 标签 / 置顶（取消置顶） / 重命名 / 删除. All existing actions must
   work exactly as before, incl. tag chips display — show a chat's tags
   as tiny muted text or a dot-row under the title ONLY if density
   targets still hold; otherwise show them inside the ⋯ menu state.
   Choose and justify.
3. 置顶/其他会话 group headers stay, styled as small muted section
   labels (sticky within the list is a plus). Tag filter chips stay,
   visually lighter and horizontally scrollable.
4. Top area slimmed: 新建会话 / 用量统计 / 导出全部 become compact rows
   (icon + label, ~44px). The export scope note leaves the button block:
   put it in the bulk-export confirm/progress UI or as one small muted
   caption line under the row — keep the honesty, lose the bulk.
   Search input stays, visually consistent with the new rows.
5. Both themes (light + dark) and both viewports (390×844, 1280px)
   must look intentional. Keep the 44px tap-target audit green, keep
   drawer backdrop/close behaviour, keep the sidebar footer as-is
   unless a spacing tidy is free.

Tests/evidence (yours): update the Playwright suite for the new item
structure (menu-open flows for pin/tag/rename/delete on mobile +
desktop), keep vitest green, and produce BEFORE/AFTER screenshots of
the open drawer at 390×844 dark + light and 1280px dark (before = from
the currently deployed build or git stash — state which). Save the
AFTER mobile-dark shot also to tests/m26-after-mobile-dark.png.
`npm run build` + `npm test` + full Playwright suite must pass.
Do NOT commit, do NOT deploy. Report: design decisions (esp. item 2's
tag display choice), density achieved (rows visible), test results,
screenshot paths.
