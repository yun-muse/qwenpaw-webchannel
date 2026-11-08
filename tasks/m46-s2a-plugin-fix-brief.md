# M46 Session 2a — PLUGIN fix only (RC1 + RC2 + protocol v13)

Repo: ~/workspace/qwenpaw-webchannel. Read AGENTS.md and
docs/m46-report.md §6 (verified design from the investigation session).
This session changes ONLY plugin/ + protocol/frames.md + plugin tests.
Do NOT touch spa/ or tests/e2e_m19.mjs in this session.

## Verified root causes (do not re-investigate)

- RC1: `plugin/util.py::history_messages` flattens QwenPaw
  `Message(type="reasoning", content=[TextContent])` to `{role, text}` —
  the kind never reaches the wire; reload/switch/resync dump reasoning as
  body text.
- RC2: `plugin/util.py::response_partial_text` ignores the enclosing
  `Message.type`, so a cancelled turn's partial text = reasoning + answer;
  `_finalize_turn` emits it as message evt + stopped msg.

## Changes

1. **hist kind (RC1).** In `history_messages` / the `_hist_entries`
   projection: when `_message_type(message) == "REASONING"`, the wire row
   is `{"role": <role>, "text": <reasoning text>, "kind": "reasoning"}`.
   Join reasoning text with the same rule the export uses
   (`_reasoning_text`) so hist and export agree. All other rows unchanged;
   turn anchoring still computed on MESSAGE rows only; files/turn fields
   untouched; `pack_history` unchanged.
2. **Stop partial (RC2).** In `response_partial_text`: skip every output
   message whose message type is present and not MESSAGE (REASONING,
   PLUGIN_CALL, PLUGIN_CALL_OUTPUT, PROGRESS, RESULT, …) — reuse
   `_message_type` semantics (absent type = MESSAGE). Keep the existing
   per-block `type == "text"` filter for the legacy mixed-block shape so
   existing test_m42 cases still pass.
3. **Protocol v13.** `PROTOCOL_VERSION` in `plugin/frames.py` → 13. Grep
   the repo for other pins of the old value (12) in protocol contexts
   (protocol/frames.md, plugin tests, docs) and update the plugin-side
   ones; note any SPA-side pins in your summary but do NOT edit spa/ —
   the SPA session handles those. In protocol/frames.md: hist section
   gains the optional `kind` field + a v13 changelog note.
4. **Tests.** Add `plugin/tests/test_m46.py` in the established
   plain-assert style with a `main()` runner:
   - the real two-message API shape through `history_messages` → the
     reasoning row has `kind == "reasoning"`, the answer row has no kind,
     the turn receipt anchors to the answer row only;
   - the real two-message cancelled envelope (Message(type=REASONING,
     content=[TextContent]) + Message(type=MESSAGE, status=cancelled,
     content=[TextContent])) through `response_partial_text` → answer only;
   - the legacy single-message mixed-block shape still filters thinking
     blocks.
   Then `tests/repro_m46_plugin.py` (run with
   `~/workspace/qwenpaw-local/venv/bin/python`) must exit 0; adjust its
   expectations only where the fix legitimately changes behaviour (the
   PACK section stays as the documented drop-risk note).
   Run the FULL plugin suite the way the repo normally does (venv python,
   plugin/tests/test_*.py) and report the count.
5. **Report.** Append the plugin half of the fix section to
   docs/m46-report.md (what changed where, protocol v13, test counts).
   Leave the Part B / SPA sections for the next session.

## Environment note

This environment has an intermittent write gate (EPERM bursts). If a write
fails with EPERM: retry it sequentially, read the file back to verify it
landed, and keep going. Note any incident in your summary.

End your output with: files changed, plugin suite count, repro exit code.
