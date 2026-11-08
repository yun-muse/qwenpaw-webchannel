# M46 — Thinking block lost (reasoning dumped as body text) + default-collapsed thinking

## User report (2026-11-09)

1. **Bug**: sometimes the thinking/reasoning block "莫名其妙丢掉" — the block
   wrapper disappears and the ENTIRE reasoning content renders as ordinary
   message body text. It is very long, so the conversation becomes unreadable.
   "有时候" = intermittent; the user cannot name the trigger.
2. **Feature**: thinking content should be collapsible and **collapsed by
   default**, the way Codex-class products do it.

## Known architecture (starting points — verify against code, don't trust blindly)

- Since M2, streamed replies carry two segment kinds: `evt`/`start`/`end`
  frames have `stream_type` (reasoning vs message); the trailing `msg` frame
  is emitted only for the message segment; the SPA renders reasoning in a
  distinct block.
- AGENTS.md: streaming replies never reach `send()`; `on_streaming_end` adds
  the trailing full-text `msg`. M15: in `hist`, reasoning/tool splits never
  carry the `turn` receipt (anchoring is computed on text segments).
- M32: streaming render splits `.md-head` / `.md-tail`; settled messages take
  single-pass rendering. M42: cancelled turns capture a partial envelope.
- QwenPaw ref source is available locally (see AGENTS.md paths) for how
  reasoning is persisted in session files (content block types / fields).

## Part A — root-cause the lost block (the core of this milestone)

Enumerate EVERY path a reasoning segment travels and check where its
"this is reasoning" identity can be dropped, then reproduce at least one
failing path end-to-end in the e2e harness (extend the mock agent to emit
reasoning segments if it cannot already):

1. Live stream: reasoning deltas → segment state → settled render at turn end.
2. The trailing full-text `msg` from `on_streaming_end` (does it reclassify
   or duplicate reasoning as text? does the SPA swap a correct live render
   for a wrong settled one?).
3. History: plugin `hist` projection from session files (`pack_history`) —
   are reasoning segments preserved with their kind? On reload, does a
   thinking block come back as body text?
4. `resync` / `resume` replay after reconnect or container restart.
5. Stop/cancel (M42 cancelled-envelope partial capture).
6. Interleaving: reasoning → tool call → reasoning → text (multiple reasoning
   segments in one turn), incl. a reasoning segment that arrives AFTER some
   text or after a tool result.
7. Frame-size packing: a very long reasoning segment split by the 256 KB
   frame cap — does the continuation lose its kind?
8. Model/provider variance: reasoning carried as a distinct content block vs
   a separate field (`reasoning_content`-style) vs inline — does one shape
   fall through the classifier?

Fix so that on every path reasoning renders as a thinking block, never as
body text. If some persisted source genuinely lacks the reasoning marker,
say so with evidence in the report and choose the least-bad honest fallback
(render as a thinking block if any signal remains; only if NO signal exists,
document the residual case — do not silently swallow content).

## Part B — collapsible, default collapsed (Codex-style)

- Every thinking block (live-streaming, live-settled, history-loaded) renders
  **collapsed by default**: one slim header row — a 思考/思考过程 label, a
  chevron, and a useful summary (character count and/or duration if the data
  is honestly available; don't fabricate numbers).
- While reasoning is still streaming, the collapsed header shows a live
  state （思考中… with a subtle pulse/shimmer); tapping expands and shows
  the streaming content; it must NOT auto-expand.
- Tap/click toggles open/closed; state is per-block, in-memory is fine
  (after reload everything is collapsed again — that IS the default).
- The toggle row must be comfortably tappable on mobile (respect the 44px
  audit where it applies, same rule as M44/M45).
- Do not change copy/export semantics: whatever 复制 Markdown / export
  include today regarding reasoning, keep it, and state it in the report.
- Keep M32 streaming performance intact (no full re-render per delta beyond
  what exists) and M36 math hydration rules (thinking content is not body
  markdown — check how it renders today and keep parity inside the block).

## Evidence & tests

- e2e: reasoning fixture covering live stream, turn settle, reload (hist
  path), stop-mid-reasoning if reproducible, and the interleaved case from
  Part A as applicable. Assert: reasoning text never appears as a body
  paragraph; thinking block present and collapsed by default; expand works.
- Screenshots 390×844: (a) the reproduced bug BEFORE the fix if captured,
  (b) after: a long-reasoning turn shown as one collapsed row in the
  conversation, (c) the same block expanded. tests/out/ per M40 policy.
- Full suites green (vitest / e2e_m19 / e2e_m29 / plugin suites if the
  plugin changes), git status clean after a full run.

## Deploy

- SPA: standard rules (VITE_RELAY_WS / VITE_RELAY_HTTP set, verify_release
  25/25, production version.json == commit, fresh-profile probe wired).
- If the PLUGIN changes: build the ZIP via tools/package_plugin.sh, FIRST
  preserve the current build as dist/webchannel-prev-m42.zip, host on
  plugin-dist, curl-verify, and report size + MD5 — do NOT install on the
  hosted instance (Muse does that via the browser route) and say plainly
  in the report that the hosted install is pending.
- Report: docs/m46-report.md — the root cause with file/frame-level
  evidence, which paths were checked clean, the fix, and the collapse UX.
