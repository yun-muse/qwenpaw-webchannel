# M46 — Thinking block loses its identity (Part A: investigation)

**Status: complete (Part A investigation, Session 2a plugin fix, Session 2b SPA +
Part B).** The SPA now consumes `hist.kind`, renders a reasoning-only row as a
collapsed thinking block, guards the pre-v13 stopped-msg shape, and every
thinking block is collapsed by default in live, settled and history states (§10).
Part A itself changed no product code — only the test harness
(`tests/e2e_m19.mjs`, new `tests/repro_m46_plugin.py`) and this report.
Artifacts are under gitignored `tests/out/`.

**Bottom line:** there are **two** independent ways the "this is reasoning" identity
is dropped, and both are in the plugin's projection of a QwenPaw *message type*
into a different wire shape:

1. **History / reload / resync** — `plugin/util.py::history_messages` flattens a
   QwenPaw `Message(type="reasoning")` to `{role:"assistant", text:"<reasoning>"}`.
   The type is never sent, so `hist` (and therefore reload, chat switch, resync)
   renders the reasoning as an ordinary assistant message. This is the "block
   disappears" symptom: after a reload there is no block at all, only body text.
2. **Stop / cancel** — `plugin/util.py::response_partial_text` concatenates every
   content block whose own type is `text` without looking at the enclosing
   `Message.type`. QwenPaw's cancelled envelope contains completed **REASONING**
   messages whose content blocks are `TextContent(type="text")`, so the plugin's
   "authoritative partial answer" is `reasoning + answer`. `_finalize_turn` emits
   it as a `message` `evt` and a `stopped` `msg`; the SPA's `msg` handler replaces
   the bubble's `text` with it. The reasoning is now body text, next to the
   collapsed thinking row.

Both are intermittent from the user's point of view because they need a trigger
(reload/switch/restart vs. pressing 停止), not every turn.

Paths 1, 2, 6 and 8 are clean; path 7 is clean for the "kind" question (there is
no continuation frame) but has a separate >256 KB drop risk. Full table in §3.

---

## 1. The persisted source does carry a marker

This is the foundation: the marker exists, the plugin throws it away. It is not a
case of a provider that never labelled its reasoning.

One real persisted `Msg` from
`~/workspace/qwenpaw-local/home/workspaces/default/sessions/web/*.json`
(37 web session files; **28** contain `"type":"thinking"` blocks; **0** store a
persisted `"type":"reasoning"` block — reasoning is a read-side synthesis):

```json
{
  "role": "assistant",
  "content": [
    {"type": "thinking", "thinking": "The user attached a file named m5.bin. …"},
    {"type": "text", "text": "RECEIVED"}
  ],
  "metadata": {"qwenpaw_turn_usage": {"usage": {"prompt_tokens": 12255, …}}}
}
```

`GET /api/chats/{id}` converts that into **two** runtime messages
(`src/qwenpaw/app/chats/utils.py:718-745`, in `~/workspace/qwenpaw-ref`):

```json
{"type":"reasoning","role":"assistant","content":[{"type":"text","text":"The user attached a file named m5.bin. …"}]}
{"type":"message","role":"assistant","content":[{"type":"text","text":"RECEIVED"}]}
```

I ran the real converter (`agentscope_msg_to_message()` + `AgentState.model_validate`)
on that session file and then fed its `model_dump(mode="json")` through the real
`plugin/util.py::history_messages`; the output was:

```json
[
 {"role":"user","text":"I attached a file named m5.bin. …"},
 {"role":"assistant","text":"The user attached a file named m5.bin. They want me to reply with …"},
 {"role":"assistant","text":"RECEIVED","turn":{"id":"33baf…","input":12255,"output":56,"total":12311}}
]
```

Note the second entry: the reasoning row is indistinguishable from an answer row.
The turn receipt is correctly absent from it (turn anchoring is computed on
`type=="MESSAGE"` in `_attach_history_turns`, `plugin/util.py:313-361`).

Harness backends converge on the same marker: `harnesses/session.py:155-157`
(codex/qoder) writes `{"type":"thinking","thinking": item.text}`, so this is not
a "provider used a different field" problem.

---

## 2. Root cause 1 — the hist projection drops `Message.type`

### 2.1 Mechanism (file:line)

- QwenPaw returns `Message.type == "reasoning"` for the reasoning half
  (`src/qwenpaw/runtime/envelope.py:350-373` builds that envelope on
  `THINKING_BLOCK_END`; `src/qwenpaw/app/chats/utils.py:720-733` builds it for
  history).
- `plugin/util.py::history_messages` (`:590-647`) builds every row as
  `{"role": …, "text": …}` and only copies `files` / `turn`. It calls
  `_part_texts` (`:238-252`), which yields text from every part whose own type
  is `text` **regardless of the message type**.
- `_hist_entries` (`:532-562`) and `_history_entries` (`:650-676`) keep `type`
  internally, but the projection at `:636-647` never writes it out.
- `plugin/frames.py::hist_frame` has no field for it (`hist` is
  `{t, chat, messages:[{role, text, files?, turn?}], more?, busy?, seq?}`,
  `protocol/frames.md` §2.3), so the wire format itself cannot express it today.
- SPA `historyMessages` (`spa/src/App.tsx:776-801`) therefore has only
  `role`/`text`; `appendHistory` (`:3407-3460`) creates an ordinary
  `kind:'text'` bubble; `MessageView` (`:1482-1644`) only renders a
  `.thinking` block when `message.thinking` is set, which it never is here.

### 2.2 Frame sequence that loses the kind

Actual frame dumped from the e2e run (`tests/out/m46-frames-repro.log`, line 8):

```json
{"t":"hist","chat":"chat-thinking","messages":[
  {"role":"user","text":"M46 请先思考再回答"},
  {"role":"assistant","text":"M46-REASONING-MARKER 我先梳理这个问题。\n\n第 1 段思考…"},
  {"role":"assistant","text":"M46-ANSWER-MARKER 这是最终答复。","turn":{…}}
],"busy":false}
```

The kind is already gone **before** `hist_frame()` is built; there is no later
frame or client-side step that could restore it. `pack_history`
(`plugin/util.py:679-698`) then only groups these rows into ≤256 KB chunks and
preserves the (already untyped) order.

### 2.3 Why it looks intermittent

`hist` is requested when a chat is first activated (`maybeRequestHist`,
`spa/src/App.tsx:3400-3405`), after `resync` (`:4344-4361`), and on reload. A
live turn looks correct; the block disappears as soon as the conversation is
rebuilt from history. A container restart always lands here (§4 path 4).
`show_thinking=false` makes it worse: the live reasoning is suppressed
(`src/qwenpaw/app/channels/base.py:679-681, 717-719, 832-834`) while history
still contains it, so a reload is guaranteed to dump it (the web channel does
not read `display_config`; `display_config=None` from `plugin/plugin.py`).

### 2.4 Evidence

- Plugin probe (`tests/repro_m46_plugin.py`, HIST): **BROKEN**, exit 1.
- e2e (`M46_ONLY=1`), both passes: "hist renders the reasoning as a thinking
  block" **FAIL**, "hist never renders the reasoning as body text" **FAIL**.
  Detail from the failing run:
  `[{"t":false,"s":"M46-REASONING-MARKER …"},{"t":false,"s":"M46-ANSWER-MARKER …"}]`.
- Screenshot of the same defect after resync/stop: `tests/out/m46-before-bug.png`
  (390×844, explicitly set).

---

## 3. Root cause 2 — the cancelled-envelope partial text includes reasoning

### 3.1 Mechanism (file:line)

QwenPaw's cancel path:

- A completed reasoning block was appended to `AgentResponse.output` when its
  `THINKING_BLOCK_END` fired (`src/qwenpaw/runtime/envelope.py:350-373`).
- `_finalize_response` appends the partial **answer** message and marks the
  response `Cancelled` (`envelope.py:858-903`); it does not remove the reasoning
  message from `output`.
- `MessageType.REASONING = "reasoning"` (`src/qwenpaw/schemas.py:26-36`);
  `Message.content` for a reasoning message is a list of `TextContent` whose
  own type is `"text"`.

Plugin:

- `plugin/util.py::response_partial_text` (`:183-223`) iterates `response.output`
  messages, then their `content`, and keeps every block with
  `block.type == "text"`. It **never inspects the message's `type`**. Its
  docstring claims it ignores "thinking/tool blocks", which is only true for the
  old *single-message mixed-block* shape; the real 2.x envelope uses a separate
  `Message.type="reasoning"` with text parts.
- `WebChannel.on_event_response` (`plugin/channel.py:2520-2532`) stores that
  string in `_cancel_text` and calls `_finalize_turn(chat, "stopped", text=…)`.
- `_finalize_turn` (`plugin/channel.py:1282-1324`) takes `full = text`, diffs it
  against the last flushed answer (`StreamDiffer.diff` returns the **whole**
  string because it is not a prefix extension), emits
  `evt(message, full)` → `end(message)` → `msg(stopped, full)` → `turn(stopped)`.
- SPA `case 'msg'` with `rt.endedId != null` (`spa/src/App.tsx:4020-4054`) sets
  `text: text || m.text`; `thinking` is left untouched. Result: the collapsed
  thinking row plus the entire reasoning duplicated as body text.

The existing unit test only covers the old shape: `plugin/tests/test_m42.py:146-156`
puts a `{"type":"thinking"}` **block** and a text block in **one** message. The
real shape (two messages, the reasoning one `type="reasoning"` with text blocks)
was never tested, which is why this survived M42.

### 3.2 Frame sequence that loses the kind

Generated by the real `WebChannel` in `tests/repro_m46_plugin.py`
(`tests/out/m46-frames-plugin.log`):

```
start(reasoning)                         seq 1
evt(reasoning, reasoning text)           seq 2
end(reasoning)                           seq 3
start(message)                           seq 4
evt(message, answer)                     seq 5
evt(message, "reasoning + answer")       seq 6   ← full resend from differ.diff
end(message)                             seq 7
msg(parts=[text "reasoning + answer"], stopped)  seq 8
turn(stopped)                            seq 9
```

The e2e mock emits the same sequence (`tests/out/m46-frames-repro.log`, the
`stopped:true` frame at the end). The SPA applies `evt` as an append and then
`msg` as a replacement; the final body text is the reasoning + answer.

### 3.3 Evidence

- Plugin probe: `response_partial_text()` returned
  `'M46-REASONING-MARKER …M46-ANSWER-MARKER'` → **BROKEN**; the channel frame
  dump → **BROKEN**.
- e2e, both passes: "stop never dumps the reasoning into body text" **FAIL**,
  while "stop closes the turn and keeps the live thinking block" **PASS** (the
  block exists; the body is wrong).
- Screenshot: `tests/out/m46-before-bug.png` shows the slim collapsed
  "思考过程 (Reasoning)" row with the entire reasoning repeated below as body
  paragraphs.

---

## 4. Path-by-path verdicts

| # | Path | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Live stream: reasoning deltas → segment state → settled render | **CLEAN** | `evt_frame` carries `stream_type` (`plugin/frames.py:124-142`); the plugin passes it on every delta (`channel.py:2565-2575`); the SPA routes `reasoning` to `thinking` and everything else to `text` (`App.tsx:3983-3991`). e2e live case: thinking block present, no marker in body (both passes). |
| 2 | Trailing full-text `msg` from `on_streaming_end` | **CLEAN** | `trailing_msg_text` returns `""` for `reasoning` (`util.py:154-171`); `on_streaming_end` only emits the trailing msg for `ANSWER_STREAM_TYPE` (`channel.py:2601-2614`). The SPA merge (`App.tsx:4027-4045`) replaces `text` only and never touches `thinking`. (The stop path's msg is a different producer — see path 5.) |
| 3 | History: `hist` projection from session files / reload | **BROKEN** | RC1. Real session → `agentscope_msg_to_message` (`ref:app/chats/utils.py:718-745`) → `history_messages` (`util.py:590-647`) emits `{role:"assistant", text:<reasoning>}` with no kind. e2e hist checks fail in both passes; frame dump line 8. |
| 4 | `resync` / `resume` after reconnect or container restart | **BROKEN via resync; `resume` replay CLEAN** | `resume` re-sends stored frames verbatim (`channel.py:1045-1062`; `RingBuffer.since`, `util.py:117-142`) and the SPA de-dupes by `seq` (`relay.ts:181-182, 232-236`), so `stream_type` survives. But a ring-buffer miss (container restart, old `last_seq`) returns `None` → `resync` (`util.py:131-142`) → the SPA clears the list and requests `hist` (`App.tsx:4344-4361`) → RC1. e2e proves the routing: a mock `resync` causes another `hist` request (`before:1, after:2`) and that frame is the defective projection. |
| 5 | Stop/cancel (M42 cancelled-envelope partial capture) | **BROKEN** | RC2. `response_partial_text` (`util.py:183-223`) ignores `Message.type`; `_finalize_turn` (`channel.py:1282-1324`) emits reasoning as `evt(message)` + `msg(stopped)`; the SPA applies it as `text` (`App.tsx:4020-4054`). Plugin probe and e2e both red; frame dumps in §3.2. |
| 6 | Interleaving: reasoning → tool → reasoning → text; reasoning after text; multiple reasoning segments | **CLEAN** | The SPA's segment state machine handles it: a reasoning `start` only creates a bubble when none is active, a reasoning `end` does not close the bubble, and a settled answer clears `activeId` so the next reasoning gets its own bubble (`App.tsx:3971-4018`). e2e interleaved case: exactly 2 thinking blocks, zero reasoning markers in body (both passes). A reasoning segment that arrives after the answer starts still appends to that bubble's `thinking`, never to `text`. |
| 7 | Frame-size packing: long reasoning split by the 256 KB cap | **CLEAN for kind; latent drop risk** | There is no continuation frame: `hist` chunks are lists of **whole** messages (`pack_history`, `util.py:679-698`), and live reasoning travels as small `evt` deltas. A split therefore cannot change a kind — but `hist` has no kind to preserve (path 3). Separately, a single message whose frame exceeds 256 KB is emitted as its own chunk and then **dropped** by `RelayClient.send` (`plugin/relay_client.py:188-203`); the probe measured a 307,288-byte frame for a 300 KB reasoning message. That is silent content loss, not text reclassification, and is out of scope for this milestone. |
| 8 | Provider content-shape variance | **CLEAN for shipped shapes; residual inline CoT** | QwenPaw/AgentScope normalizes `reasoning_content` to `ThinkingBlock` for every shipped provider (`agentscope/model/_deepseek/_model.py:304-311`, `_openai_chat/_model.py:378`, plus dashscope/moonshot/volcengine/xai), and harness backends persist `{"type":"thinking"}` (`ref:harnesses/session.py:155-157`). A provider that puts CoT **inside ordinary text** leaves no marker anywhere; see R1. `utils/model_response.py:15-43` lists `analysis`/`reasoning`/`reasoning_content`/`thinking` precisely because compatible providers vary, but those are response-side shapes, not persisted Msg blocks. |

---

## 5. Reproduction

### 5.1 Plugin probe (deterministic, no browser)

```
~/workspace/qwenpaw-local/venv/bin/python tests/repro_m46_plugin.py
```

Current result (red):

```
HIST (3/4): BROKEN — reasoning projected as an ordinary assistant message (no kind)
STOP (5): BROKEN — response_partial_text() returns reasoning + answer
STOP-FRAMES (5): BROKEN — message evt/msg carries the reasoning text
PACK (7): CLEAN — 1 chunk(s), every chunk is a list of whole messages; …
REPRO_M46 PLUGIN: 3 broken path(s): HIST (3/4), STOP (5), STOP-FRAMES (5)
exit 1
```

It writes `tests/out/m46-frames-plugin.log` (the real `WebChannel` frames).

### 5.2 Browser e2e

```
cd tests && M46_ONLY=1 node e2e_m19.mjs
```

`M46_ONLY` runs both the desktop (1280×900) and mobile (390×844) passes:

```
checks: 25, failed: 6
FAIL desktop: M46 hist renders the reasoning as a thinking block
FAIL desktop: M46 hist never renders the reasoning as body text
FAIL desktop: M46 stop never dumps the reasoning into body text
FAIL mobile:  … same three
PASS desktop/mobile: M46 live reasoning renders in a thinking block
PASS desktop/mobile: M46 live reasoning never leaks into body text
PASS desktop/mobile: M46 interleaved keeps two separate thinking blocks
PASS desktop/mobile: M46 interleaved never leaks reasoning into body text
PASS desktop/mobile: M46 stop closes the turn and keeps the live thinking block
PASS desktop/mobile: M46 resync re-requests history (the defective hist projection)
```

The six red checks are exactly roots 1 and 2. Artifacts:

- `tests/out/m46-frames-repro.log` — wire frames for the failing `chat-thinking`
  path (hist + resync + live + interleaved + stop).
- `tests/out/m46-before-bug.png` — the reproduced bug at 390×844 (explicit
  `setViewportSize(390, 844)`).
- `tests/out/m46-frames-plugin.log` — the same stop sequence generated by the
  real channel, plus the hist projection.

The mock mirrors the real plugin's frame shapes; it does not invent them:
`m46LiveTurn` / `m46InterleavedTurn` copy `start`/`evt`/`end` with
`stream_type` plus the answer-only trailing `msg`; `m46StopTurn` copies the
sequence measured from `_finalize_turn`. The `hist` fixture is the projection
proved by the plugin probe.

---

## 6. What the fix must touch (design; implemented in §9 and §10)

### 6.1 RC1 — carry the kind through `hist` (plugin + SPA + protocol)

**Plugin** (`plugin/util.py::history_messages`, `plugin/frames.py::hist_frame`,
`protocol/frames.md`):

- Bump the protocol revision to **13** (advertised in the identity `status`,
  `plugin/frames.py::PROTOCOL_VERSION`).
- When `_message_type(message) == "REASONING"`, emit the row as
  `{"role": <role>, "text": <joined text>, "kind": "reasoning"}` instead of a
  plain text row. `kind` is optional on the wire; existing clients ignore it.
- Keep every existing rule unchanged: turn receipts still anchor on
  `type=="MESSAGE"` (`_attach_history_turns`), attachments/turn fields are
  untouched, and `pack_history` keeps chunking whole message dicts.
- Re-use `_reasoning_text` (`util.py:2872-2890`, currently only used by export)
  for the joining rule, so `hist` and the Markdown export agree. Export already
  renders REASONING as a folded `<details>` (`_render_message`, `:2926-2945`).
- Add a hist unit test with the real two-message shape and assert `kind`.

**SPA** (`spa/src/App.tsx`):

- `HistoryMessage` (`:768-774`) gains `kind?: 'reasoning'`; `historyMessages`
  (`:776-801`) copies it through.
- `appendHistory` (`:3407-3460`): a reasoning row becomes
  `{role:'assistant', kind:'text', text:'', thinking:item.text}`; a normal row is
  unchanged. The row keeps its position, so interleaved histories stay ordered.
- `MessageView` (`:1482-1644`): when `thinking` is set and `text` is empty and
  the message is not streaming, render only the thinking block (no empty
  bubble/footer). This also serves Part B.
- Do **not** merge the reasoning row into the following answer row. It would
  work for the common reasoning→answer pair but loses order for
  reasoning-after-tool/text and for multiple reasoning segments.
- `copySource` (`:938-944`) stays as is: copy has never included thinking.
  Export keeps including it as a folded block; state that in the Part B report.

### 6.2 RC2 — stop must never promote reasoning to answer text (plugin; optional SPA guard)

**Plugin** (`plugin/util.py::response_partial_text`):

- Skip every output message whose `Message.type` is present and is not
  `MESSAGE` (i.e. `REASONING`, `PLUGIN_CALL`, `PLUGIN_CALL_OUTPUT`, `PROGRESS`,
  `RESULT`). Keep the existing per-block `type == "text"` check for the legacy
  mixed-block shape. Accept an absent message type as `MESSAGE`.
- After this, `_finalize_turn`'s `full` is the answer only; `StreamDiffer.diff`
  emits just the missing tail, and the stopped `msg` carries the partial answer.
- Replace/extend the `test_m42.py` helper with the **real** two-message shape:
  one `Message(type=REASONING, content=[TextContent])`, one
  `Message(type=MESSAGE, status=cancelled, content=[TextContent])`; assert the
  partial text is only the answer.

**SPA (optional defense-in-depth, for the rollout window and pre-v13 plugins):**
in `case 'msg'` when `rt.endedId != null && frame.stopped === true`, if
`m.thinking` is non-empty and the incoming `text` starts with it, use
`text.slice(m.thinking.length)` instead of the full text. This is a heuristic
(a legitimate stopped answer that literally repeats the reasoning prefix would
be trimmed), so it should be a secondary guard, not the fix. The plugin change
is authoritative.

### 6.3 Tests / harness follow-up

- Keep `tests/repro_m46_plugin.py` in the plugin regression loop; after the fix
  it must exit 0.
- In the fix session the mock must serve `kind:"reasoning"` in the M46 hist
  fixture and stop without the reasoning prefix (otherwise the e2e would keep
  testing the bug). Keep one legacy-leak switch if the SPA guard is implemented.
- Add the two-message cancel shape to `plugin/tests/` so a future refactor cannot
  re-break it without the e2e.

### 6.4 No relay changes

Both relays forward frames verbatim; `hist` packing is already inside the cap
rule. Nothing in `relay-node` / `relay-cf` needs to change.

---

## 7. Residual risks (honest cases with no marker)

**R1 — a provider that inlines chain-of-thought into ordinary text.** If a model
returns its reasoning inside a normal text block (no `reasoning_content`, no
`thinking` block), QwenPaw persists it as `{"type":"text"}` and neither the
console nor the plugin can tell it apart from the answer. Evidence:
`src/qwenpaw/utils/model_response.py:15-43` exists because compatible providers
use `analysis`/`reasoning`/`reasoning_content`/`thinking` shapes, and
AgentScope only maps `reasoning_content` when the provider exposes it
(`agentscope/model/_openai_chat/_model.py:378` and the per-provider models).
For a plain `content` string there is no signal to preserve; no client-side
fallback can recover it. Document as unsupported rather than guess.

**R2 — `show_thinking=false` deployments.** The live path drops reasoning
frames (`src/qwenpaw/app/channels/base.py:679-681, 717-719, 832-834`), but the
history endpoint still returns the reasoning messages. Today that guarantees
the path-3 dump on every reload. The RC1 fix makes it a thinking block again;
whether a "do not show thinking" deployment should hide it from history is a
product decision (the web channel currently never sets `display_config`, so this
is an edge case). Recommendation: do not silently swallow content; if hiding is
wanted, gate the `kind` in the plugin from `display_config`, not in the SPA.

**R3 — single messages over 256 KB.** `pack_history` cannot split one message;
`RelayClient.send` drops the oversize frame (`plugin/relay_client.py:188-203`).
A >256 KB reasoning message disappears on reload (and so would an equally long
answer). This is content loss, not kind loss; it needs its own change (splitting
one `hist` message into continuation rows would affect turn/attachment
anchoring). Measured: a 300 KB reasoning message becomes a 307,288-byte frame.

**R4 — history window truncation.** `hist` keeps the last 50 messages
(`DEFAULT_HIST_LIMIT`); reasoning rows consume that budget. A reasoning-heavy
conversation can push older turns out of the reload window. Adding `kind` does
not change the count; noted so it is not mistaken for a new regression.

---

## 8. Files and artifacts

Tracked changes in this session:

| Path | Change |
| --- | --- |
| `tests/e2e_m19.mjs` | M46 fixtures, `m46LiveTurn` / `m46InterleavedTurn` / `m46StopTurn`, `M46_ONLY=1` pack, frame recorder, 390×844 evidence shot |
| `tests/repro_m46_plugin.py` | new standalone probe: real QwenPaw shapes through `history_messages`, `response_partial_text`, real channel stop frames, `pack_history` |
| `docs/m46-report.md` | this report |

Untracked, gitignored evidence (`tests/out/`): `m46-frames-repro.log`,
`m46-frames-plugin.log`, `m46-before-bug.png`.

Part A touched no product code, so `spa/dist` was still a build of `HEAD`; the M46
e2e run rebuilt it with the default local-demo `VITE_RELAY_*` values, exactly as
`e2e_m19` always does. Session 2a's plugin change does not alter `spa/dist`, but a
later release sweep must rebuild the plugin ZIP and `spa/dist` with the production
relay env before `tools/verify_release.py` (M38 §0).

Session 2b's files are listed in §10.7 (SPA, e2e, docs).

---

## 9. Session 2a — plugin fix (RC1 + RC2, protocol v13)

**Status: the plugin half is fixed; the SPA half (§6.1 SPA bullets, §6.2 optional
guard) and the e2e mock update are still pending (Session 2b).** No file under
`spa/` and no `tests/e2e_m19.mjs` line was touched in this session.

### 9.1 RC1 — `hist` carries `kind:"reasoning"`

`plugin/util.py`:

- `_hist_entries()` now asks `_message_type()` first. For a
  `Message.type == "REASONING"` row it builds the text with `_reasoning_text()` —
  the same `\n\n` joining rule (text/thinking parts) the Markdown export uses in
  `_render_message()` (`:2926-2945`) — and tags the entry `kind="reasoning"`.
- `history_messages()` writes that optional `kind` onto the wire row, after
  `role`/`text` and before `files`/`turn`. Every other row is unchanged; a
  non-reasoning message still uses `_part_texts()`, so a thinking *block* inside a
  `MESSAGE` row is still ignored rather than promoted.
- Turn anchoring is untouched: `_attach_history_turns()` still runs on the old
  text-only `_history_entries()` projection and still requires
  `type == "MESSAGE"`, `role == "assistant"` and non-empty text. Attachments
  (`_hist_entries()`) and `pack_history()` are unchanged.
- `_message_type()` also reads `.type` from model objects now (it was dict-only).
  `hist` still passes dicts; the stop hook passes `qwenpaw.schemas.Message`.
  Absent type means `MESSAGE`, as before.

Wire result for the real two-message shape:

```json
{"t":"hist","chat":"…","messages":[
  {"role":"assistant","text":"<reasoning>","kind":"reasoning"},
  {"role":"assistant","text":"<answer>","turn":{"id":"…","input":10,"output":5,"total":15}}
],"seq":1}
```

### 9.2 RC2 — stop captures the answer only

`plugin/util.py::response_partial_text()` now skips every output message whose
`Message.type` is present and is not `MESSAGE` (REASONING, PLUGIN_CALL,
PLUGIN_CALL_OUTPUT, PROGRESS, RESULT …) *before* the existing per-block
`type == "text"` filter. The legacy single-message mixed-block shape keeps its
block-level filter, so `plugin/tests/test_m42.py`'s existing case still passes.

Effect: `_finalize_turn()`'s `full` is the answer prefix, `StreamDiffer.diff`
no longer emits the whole `reasoning + answer` string, and the stopped `msg` /
`turn{state:"stopped"}` carry only the partial answer. The pre-existing
non-prefix replacement (`evt` resending the partial answer when it is not an
extension of the streamed text) remains — that is M42 differ behaviour, not a
reasoning leak.

### 9.3 Protocol v13

- `plugin/frames.py::PROTOCOL_VERSION` → **13**, advertised in the identity
  `status`; the constant is the only plugin-side pin (tests import it).
- `protocol/frames.md`: title/status line → v13; the §2.3 `hist` row documents
  `kind?`; new §19 defines the field, the anchoring guarantees, the stop fix and
  the compatibility rule (absent `kind` = ordinary message; older clients ignore
  the unknown field). The §18 material stays as the historical v12 record.
- No relay change: `hist` is forwarded verbatim and `pack_history()` still chunks
  whole message dicts.

### 9.4 Tests and evidence

- New `plugin/tests/test_m46.py` (plain asserts, `main()` runner, **7 cases**):
  real two-message `hist` shape (kind on reasoning, no kind on the answer, one
  receipt on the answer only), the `\n\n` join rule, a thinking block inside a
  `MESSAGE` row, the real two-message cancelled envelope through
  `response_partial_text`, the legacy mixed-block shape, and
  `PROTOCOL_VERSION == 13`.
- Full plugin suite (venv python, `plugin/tests/test_*.py`): **23 suites, 415
  tests, all pass** (`test_m42.py` reports `ALL PASS (14 tests)` in its own
  format; every other suite prints one `ok` line per test).
- `tests/repro_m46_plugin.py` (venv python): **exit 0**, 4/4 paths CLEAN — HIST
  and STOP + STOP-FRAMES flipped by this fix. PACK stays as the documented
  drop-risk note, unchanged: a 300 KB reasoning message still becomes a
  307,309-byte frame that `RelayClient.send` drops (R3).

### 9.5 Left for Session 2b (SPA / e2e, deliberately untouched)

**Done in §10** — kept here as the handoff record.

- `spa/src/App.tsx` hardcodes revision `12` as a lower bound at `:4007`, `:4102`,
  `:4117`, `:4221`. All four are "at least v12" gates — safe against a v13 plugin
  — but should be bumped (or renamed) for clarity.
- `HistoryMessage` / `historyMessages` / `appendHistory` / `MessageView` do not
  read `kind` yet; a v13 `hist` still renders the reasoning row as body text
  until Session 2b lands.
- `tests/e2e_m19.mjs` still sends `protocol: 12` in the mock identity frames
  (`:1003`, `:1251`) and its M46 hist/stop fixtures still model the pre-fix
  shapes; Session 2b updates them together with the SPA.

---

## 10. Session 2b — SPA fix + Part B (collapsed thinking)

**Status: complete.** No file under `plugin/` was touched in this session; the
wire is the v13 shape from §9 (`hist` rows carry `kind:"reasoning"`, the stopped
partial is answer-only).

### 10.1 RC1 on the client — consume `kind`

`spa/src/App.tsx`:

- `HistoryMessage` (`:779`) gains `kind?: 'reasoning'`; `historyMessages()`
  (`:789`) copies it through only when the value is exactly `"reasoning"` (an
  unknown kind stays an ordinary row, the documented forward-compatibility
  rule from §9.3).
- `appendHistory()` (`:3459`) maps a reasoning row to
  `{role:'assistant', kind:'text', text:'', thinking:item.text}` **in the same
  list position**. It is never merged into the following answer row: order is
  what keeps interleaved histories (reasoning → answer → tool → reasoning)
  correct. A reasoning row still accepts `files`/`turn` if a future plugin
  attaches them.
- `MessageView` (`:1498-1696`) renders a message with `thinking`, empty `text`
  and `streaming !== true` as **only** the thinking block — no empty bubble and
  no `.bubble-foot` (no copy/regenerate row). A message with both thinking and
  text keeps the existing block-above-bubble structure.

The hist path is therefore: reasoning row → one collapsed `.thinking` row, its
answer → an ordinary bubble; the reasoning never becomes body text.

### 10.2 Rollout guard for pre-v13 plugins

`case 'msg'` stopped branch (`:4091-4122`): when `frame.stopped === true` and
`rt.endedId != null`, the incoming text is applied as before **unless** the
bubble's `thinking` is non-empty and the text starts with exactly that string —
in which case the prefix is sliced off. It is a defence-in-depth heuristic for a
mixed deploy (old plugin + new SPA), commented as such; the v13 plugin fix is
authoritative. A legitimate stopped answer that literally repeats the whole
reasoning prefix would be trimmed, which is why this is secondary.

### 10.3 Protocol pin

The SPA never pinned "current protocol = 12": the four literals were *lower
bounds* for the v12 `turn` semantics (SPA-deployed-first protection). Bumping
them to 13 would make a v12 plugin look pre-`turn` and regress that protection,
so they are now named constants (with the same values):

```ts
const PROTOCOL_TURN = 12;    // v12 introduced `turn`; v13 keeps it unchanged
const PROTOCOL_VERSION = 13; // newest revision this build understands
```

The identity `status.protocol` is clamped to `PROTOCOL_VERSION` (`:4481-4487`):
a future v14 is interpreted with v13 rules. The `turn` and `hist.busy` fallbacks
use `Math.max(current, PROTOCOL_TURN)` instead of overwriting 13 with 12. The
e2e mock identity now advertises `protocol: 13` (`tests/e2e_m19.mjs:1003,1251`).
No behavioural gate changed: a v12 or v13 plugin both take the turn-boundary
path.

### 10.4 Part B — collapsible, collapsed by default

The native `<details open={streaming && !text}>` is gone. Each block is:

- **Header** — a real `<button type="button" class="thinking-toggle">`, full
  width, with `aria-expanded`. Label `💭 思考过程`; while the reasoning segment
  is still streaming it becomes `思考中…` preceded by a 6 px pulsing dot
  (`.thinking-dot`, 1.2 s ease-in-out). The right side always shows the honest
  character count `· N 字` from `thinking.length` (no duration, no estimate) and
  a `ChevronDown` that rotates 180° when open.
- **Default state** — `useState(false)` per block inside `MessageView`. It is
  closed in live-streaming, live-settled and history states; the old auto-open
  is removed. After reload all blocks are closed again by design. No props or
  row callbacks were added (M32 `memo` / `rowActionsRef` identity untouched).
- **Body** — `.thinking-body` plain text exactly as before (pre-wrap, **not**
  markdown, no KaTeX hydration), and **not mounted while closed** — the DOM
  probe asserts `.thinking-body` is absent.
- **Tap target** — header `min-height: 32px` on a fine pointer, 44 px under
  `@media (max-width: 720px), (pointer: coarse)` (M22/M44/M45 rule, no audit
  exclusions). The 44 px rule lives outside the 720 px block so a coarse tablet
  wider than 720 px is covered.
- **Visual** — `.thinking` keeps its bordered card, but padding moved into the
  toggle/body so the button is the whole header row. Class names `.thinking` and
  `.thinking-body` are unchanged; `.thinking-toggle`, `.thinking-label`,
  `.thinking-count`, `.thinking-chevron`, `.thinking-dot` are new.

Live state derivation: `thinkingLive = thinking && streaming && !text`. A
reasoning `end` does not close the bubble (only a message `end` does), so the
header stays in `思考中…` through the small gap before the first answer delta and
flips to `💭 思考过程` as soon as answer text exists. `thinkingOnly` uses the same
signals plus `!streaming`.

### 10.5 Copy / export semantics (unchanged)

- `copySource()` returns `message.text` (or the text part of a `parts` message).
  Thinking is **not** copied: 复制 Markdown / 复制 stay answer-only, and a
  thinking-only row now has no footer copy button at all.
- The Markdown export is plugin-side and unchanged: `_render_message()` still
  folds REASONING into a `<details>` block (§9.1), which is the same content the
  SPA shows collapsed. The collapse state is a per-browser, in-memory UI state
  and never affects exports or history frames.

### 10.6 Tests and evidence

`tests/e2e_m19.mjs` (M46 pack, both passes):

- Hist fixture now serves `kind:"reasoning"` and the answer receipt; the mock
  stop turn emits the fixed v13 sequence (`end(message)` → `msg(stopped,
  answer)` → `turn(stopped)`). A second, legacy trigger (`M46 思考停止旧版`)
  replays the pre-fix `evt(full = reasoning+answer)` sequence.
- Assertions (25 per pass / **50 total**): hist block present, collapsed, count
  `· 885 字`, no empty bubble/footer, 44/32 px header, no body dump; toggle expands (body shows
  the marker) and collapses again; live header shows `思考中…` while streaming
  and never auto-expands; settled block collapsed with the final count;
  interleaved two blocks both collapsed; fixed stop never dumps; legacy stop's
  body is exactly `M46_ANSWER` (guard trimmed the prefix); resync re-requests
  the v13 hist projection.
- The pack now runs in the full-suite flow (`runM46Checks` wired after
  `runM45Checks`), not only under `M46_ONLY=1`.
- Mock identity frames advertise `protocol: 13`.

Suites (this session):

| Suite | Result |
| --- | --- |
| `spa` vitest | **330/330** (21 files) |
| `tests/e2e_m19.mjs` full, desktop + mobile | **780/780** checks, 0 failed (338 s) |
| `tests/e2e_m19.mjs` `M46_ONLY=1` | **51/51** checks (25 per pass + the UTF-8 download-name probe) |
| `tests/e2e_m29.mjs` | **26/26** checks |
| plugin suites (§9.4) | 23 suites, 415 tests |

Evidence (gitignored `tests/out/`):

- `m46-after-collapsed.png` — 390×844 (explicit `setViewportSize`), the long
  reasoning as one collapsed row above its answer.
- `m46-after-expanded.png` — the same block expanded, plain-text body.
- `m46-frames-repro.log` — the v13 hist/live/fixed-stop/legacy-stop frames.
- `m46-before-bug.png` is the Part A failing-run artifact and is **not**
  regenerated by this pack any more (the current build would overwrite it with a
  correct page).

A full suite run leaves `git status` clean apart from the intended changes
(`tests/out/` is gitignored). This session did not build the deployable
`spa/dist` with production `VITE_RELAY_*` values and did not package or deploy
the plugin — the coordinator does that.

### 10.7 Files changed in Session 2b

| Path | Change |
| --- | --- |
| `spa/src/App.tsx` | `HistoryMessage.kind`, `historyMessages`, `appendHistory` mapping, thinking-only render, collapsed `<button>` block, stopped-msg prefix guard, protocol constants |
| `spa/src/App.css` | `.thinking` card reflow, `.thinking-toggle` (+label/count/chevron/dot), 32/44 px header, body padding |
| `tests/e2e_m19.mjs` | v13 hist fixture, fixed + legacy stop shapes, collapse/expand/live assertions, two 390×844 shots, full-suite wiring, mock protocol 13 |
| `docs/m46-report.md` | this section and the status updates |
| `AGENTS.md`, `docs/README.md` | M46 conventions + milestone row |
