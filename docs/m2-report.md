# M2 Report — approval / files / history / resume + SPA polish

Date: 2026-10-26. All verification against the LOCAL stack only (relay-node
:8787 + local QwenPaw :8088); the hosted instance was never touched.

## Engine & model evidence

All product code was written by **CodeBuddy CLI**
(`@tencent-ai/codebuddy-code`), always pinned `--model deepseek-v4.1-flash`.
Session jsonl under `~/.codebuddy/projects/home-hatch-workspace-qwenpaw-webchannel/`:

| Run | Session | Turns | Model entries in jsonl |
|---|---|---|---|
| A plugin | `01a178d4-0048-7f2b-a648-66ab8e55e12a` | 229 | 228 × `deepseek-v4.1-flash`, no other model |
| B SPA | `01a178df-e9e9-7bc0-aea2-c12ed3141f8b` | 115 | 114 × `deepseek-v4.1-flash` |
| Fix-up (stream_type) | `01a178ed-902d-7858-a481-2c791dc6a64a` | 144 | 143 × `deepseek-v4.1-flash` |

The coordinator independently re-ran every check below (session
self-reports were not trusted: one earlier wrapper process had to be
killed mid-run, yet the A session had already completed and flushed —
ground truth was taken from disk + re-runs, per AGENTS.md practice).

## Part A — plugin (`plugin/channel.py`, `util.py`, `frames.py`)

- **A1 trailing msg**: pure helper `util.trailing_msg_text` +
  `StreamDiffer.last()`; `on_streaming_end` emits `end` then, only when the
  reply produced evt deltas but no successful `send()` this turn, one
  `msg{role:"assistant", parts:[{type:"text", text:<full answer>}]}`.
  Text sent by the agent *while streaming* counts as tool output, not as
  the answer (rule recorded in AGENTS.md).
- **A2 stop completion**: `_handle_stop` resolves the web ChatSpec id via
  the shared `_resolve_chat_id` (GET /api/chats?channel=web + session_id
  match, cached per chat) and POSTs `/api/console/chat/stop?chat_id=<id>`;
  unresolvable → log + drop (sending the client chat name is useless).
- **A3 hist**: `_handle_hist` resolves the chat, GETs `/api/chats/{id}`,
  maps via `util.history_messages` (text parts only), packs with
  `util.pack_history` (newest suffix fitting 256KB, `more` flag), emits via
  `_emit` so hist consumes seq and is ring-buffer replayable.
- **A4 files**: msg `files[]` decoded (base64, name-sanitized, 10MB cap) →
  `POST /api/console/upload` → `FileContent(type=FILE, filename,
  file_url=<returned url>)` attached to the inbound message. Any failure →
  file skipped + log; text always delivered.
- **A5 approval ownership**: approve/deny first GET `/api/approval/list`;
  only if `req_id` is pending **and** `owner_agent_id` == own agent does it
  POST (with `session_id = pending.root_session_id`, which the API requires
  — req_id alone is 422). Otherwise it replies
  `{t:"error", code:"E_AUTH", chat, req_id}` and never calls the POST.
- Coordinator checks: `py_compile` OK; `python3 plugin/tests/test_diff.py`
  → ALL PASS; `python3 plugin/tests/test_m2.py` → ALL PASS (A1–A5 pure
  logic, fake-HTTP handler tests for upload/approval flows, pack_history
  budget). `plugin.json` untouched and valid; README updated.

## Verification discovery → fix-up (stream_type)

Live A1 initially "failed" by 2 chars: Kilo replies stream **two
segments** — `reasoning` (the model's thinking) then `message` (the
answer) — and evt frames didn't say which was which, so clients
concatenated thinking into the answer. Fix-up run:

- evt `data` now carries `stream_type` (`"reasoning"` | `"message"`);
  `start`/`end` frames carry a top-level `stream_type`; the trailing msg
  is explicitly emitted only for the `message` segment's end.
  `protocol/frames.md` documents the field.
- SPA accumulates only `message` deltas into the answer bubble; reasoning
  renders in a collapsed `<details class="thinking">` block.
- New unit cases cover the reasoning/message trailing decision.

## Part B — SPA (`spa/`)

Rewritten `App.tsx` / `App.css` / `relay.ts`:

- Markdown rendering via `marked` ^15 + `dompurify` ^3 (sanitized),
  connection-state banner (agentOffline / resuming), auto-reconnect with
  per-chat `resume`, `resync` → forget `last_seq` + reload hist,
  approval cards (tool/severity/summary, approve/deny, `E_AUTH` refusal
  shown on the card and `E_APPROVAL_EXPIRED` handled — connection-level
  `E_AUTH` without chat/req_id is the only fatal one, see relay.ts),
  file attach (paperclip + drag-drop, 10MB cap), stop button while
  streaming, Enter-to-send, multi-chat list (create/switch, persisted in
  localStorage), page title "QwenPaw WebChannel".
- Coordinator checks: `npm install` (deps were declared but not installed
  by the session) then `npm run build` PASS — 34 modules, JS 229.51 kB /
  gzip 75.44 kB, CSS 9.09 kB. `vite preview` on :5173 → **HTTP 200**,
  `<title>QwenPaw WebChannel</title>`.

## Part C — local end-to-end (`tests/e2e_m2.mjs`, frames in
`tests/e2e_m2.frames.log`)

Plugin reinstall response: `"loaded":true`; relay `/health` →
`{"ok":true,"agentOnline":true}`. Final harness run — **all PASS**:

```
ready agentOnline = true
ASSERT A5-bogus-approve-rejected: PASS code=E_AUTH
ASSERT A1-trailing-msg: PASS evt_frames=43 concat_len=330 trailing_len=330 equal=true
ASSERT A3-hist-roundtrip: PASS hist_messages=12 roles=user,assistant,assistant,...
ASSERT A4-file-attach: PASS error=none (reply trailing msg with 88-char text part in frames log)
ASSERT RESUME-mid-stream: PASS pre_frames=2 last_seq=93 redelivered=44 end=true assembled_len=1789 trailing_len=1789 equal=true
E2E_M2 PASS (mandatory assertions)
```

Resume was proven against the REAL agent (not the mock): disconnect after
2 frames, reconnect, `{t:"resume", last_seq:93}` redelivered 44 frames and
the deduped message-segment text equals the trailing msg text exactly.

### Approval end-to-end — attempted, not triggered (documented per brief)

One time-boxed attempt: prompted the local agent through the web channel
to run `echo m2-approval-probe` via its shell tool and waited 120s — no
`approval` frame arrived (the local Kilo agent produced no gated tool
call in this setup). A5 therefore stands verified by (a) unit tests with a
fake approval API (ownership match/mismatch, approve/deny bodies), and
(b) the live negative test above: a bogus `req_id` approve got
`{t:"error", code:"E_AUTH", chat, req_id}` back and the app log shows
`webchannel: refusing approve ... not pending for agent=default`.
A real pending-approval round-trip remains unverified — needs an
environment whose tool calls actually hit the approval gate (candidate:
the hosted `work` agent in M3 prep, or a local agent config with the
guard in enforcing mode).

### Harness notes (test code, not product)

`tests/e2e_m2.mjs` needed two fixes while being written: cursor-based
frame consumption (naive find-from-start re-matched stale frames) and
message-segment end semantics (a `reasoning` end must not close a reply).
The local stack also died once mid-verification (service restart) and was
relaunched; background processes do not survive runtime restarts.

## Deviations / leftovers

- `spa/src/App.css` had never been committed (M0/M1 oversight) — included
  in this commit.
- Frame rule unchanged: whole frame ≤256KB; chunked file transfer stays
  v2 (protocol/frames.md).
- Real approval round-trip unverified (above).
- Next: M3 (relay-cf port, tenant limits, hosted `work` agent test deploy).
