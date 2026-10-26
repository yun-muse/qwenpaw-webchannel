You are coding in /home/hatch/workspace/qwenpaw-webchannel. Small M2 fix-up: streamed replies contain TWO stream segments — reasoning and the actual answer (stream_type values in QwenPaw base.py are exactly "reasoning" and "message"). Today the plugin's evt frames don't say which segment a delta belongs to, so clients concatenate the model's thinking into the answer text. Fix that end-to-end:

1. plugin/channel.py (+ plugin/frames.py builders if that's where evt/start/end frames are built):
   - evt frames: data becomes {text, stream_type} (additive; keep data.text as is).
   - start and end frames: add a top-level "stream_type" field with the segment's type.
   - on_streaming_end trailing-msg (A1): make it explicit that the trailing full-text msg is emitted ONLY when stream_type == "message" (if the current code already achieves this indirectly, refactor to the explicit check and say so in your report). Reasoning segments get start/evt/end but never a trailing msg.
   - Extend plugin/tests/test_m2.py (plain-python asserts, main() prints ALL PASS) with cases: trailing decision for stream_type "reasoning" → no trailing msg even when text was streamed and send() never fired; for "message" → trailing msg as before. Factor the stream_type into the existing pure helper in plugin/util.py (helpers live ONLY in util.py per AGENTS.md).
2. spa/src/App.tsx (+ spa/src/relay.ts types if needed):
   - evt handling: accumulate ONLY deltas whose data.stream_type is "message" or missing (mock compat) into the answer bubble. Deltas with stream_type "reasoning" accumulate into a separate thinking text rendered as a collapsed <details class="thinking"><summary>thinking</summary>…</details> above the in-flight/final bubble (plain text, small grey styling in App.css; add CSS if missing).
   - start/end frames may carry stream_type; the reply is "streaming" until the MESSAGE segment's end (an end for reasoning alone must not finalize the bubble).
3. protocol/frames.md: document evt data.stream_type ∈ {"reasoning","message"} and start/end stream_type field in the frame table/notes (small edit, match existing style).

Do NOT touch: relay-node/, mock/, tests/, docs/, .ref_tmp/, plugin/relay_client.py, plugin/plugin.py, plugin/plugin.json, plugin/util.py's existing helper contracts (extending trailing_msg_text's signature is allowed if tests are updated accordingly).
Verify what you can: if Bash works, run python3 plugin/tests/test_m2.py and test_diff.py, and in spa/ npm run build; if Bash is denied, say so. Report: files changed + how the trailing-msg guard works now.
