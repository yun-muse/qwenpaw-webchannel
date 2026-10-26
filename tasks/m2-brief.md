# M2 brief — approval / files / history / resume + SPA polish (all local)

Engine: CodeBuddy CLI, ALWAYS pinned `--model deepseek-v4.1-flash` (fallback glm-5.3-flash).
Follow repo AGENTS.md conventions (helpers only in plugin/util.py; frames.py re-export pattern;
approval_frame keyword seq; plain-python tests). Reference source: ~/workspace/qwenpaw-ref
(v2.2.2.post1). CodeBuddy cannot read outside the workspace under acceptEdits — copy the
specific reference files it needs into an in-workspace `.ref_tmp/` first, delete when done.
Ground truth = files on disk + your own re-runs, never the coding session's self-report.

## Part A — plugin (plugin/channel.py et al.)
A1. Trailing msg frame: investigate in ref base.py why streamed replies never trigger a
    full-text send() on this channel. Fix inside the plugin: at on_streaming_end, if no
    send()/send_content_parts delivered the final text for that stream segment, emit
    {t:"msg", chat, seq, parts:[{type:"text", text:<accumulated full text>}]} AFTER the end
    frame. Must not double-emit for non-streamed replies. Unit-test the decision logic.
A2. stop frame: try the localhost stop API from design Appendix A
    (POST /api/console/chat/stop?chat_id=...) — first work out from ref source what chat_id
    a web-channel session maps to (manager/chat records). If a reliable mapping exists,
    implement stop via httpx with X-Agent-Id; if not, keep log-only and document why.
A3. hist frame: inbound {t:"hist", chat, limit?} → resolve the QwenPaw chat for this web
    session (research GET /api/chats and /api/chats/{id} shapes in ref source), fetch via
    localhost httpx + X-Agent-Id, reply with {t:"hist", chat, messages:[{role, text}...]}
    frames, each ≤256KB (split if needed, with `more` flag). If a chat doesn't exist yet,
    reply with empty messages (not an error).
A4. Inbound files: msg frames may carry files[] {name, mime, data(base64)}; total frame
    ≤256KB is already enforced by the relay. Decode and save into the agent workspace
    (find how console channel / upload API stores media in ref source; prefer
    POST /api/console/upload if its contract fits, else write the file and reference it).
    Include the file in the native payload the same way the console channel attaches
    uploaded files (research its content-part shape). If the native shape cannot be
    determined reliably, save the file + append a text note "[file saved: <name>]" to the
    message text and document the deviation.
A5. Approval ownership check: before POSTing approve/deny, GET /api/approval/list and
    verify the req_id is pending for this channel's agent/session; if not found, send
    {t:"error", code:"E_AUTH", ...} back to the client instead of POSTing. Keep it simple.

## Part B — SPA polish (spa/) — the user-facing focus of M2
Layout like a real chat app: left sidebar (chat list with at least the current chat +
"new chat" that rotates chat id), main pane (messages, streaming bubble), bottom composer.
Features, all wired to the existing relay protocol in protocol/frames.md:
- Markdown rendering for assistant messages (add `marked` + `dompurify` deps; code blocks
  with basic styling; sanitize HTML).
- Tool / non-text parts: render msg parts that aren't plain text as collapsible cards
  (title = part type/name, body = pretty JSON).
- Approval cards: on {t:"approval"} show a card (tool, summary, severity) with Approve /
  Deny buttons → send {t:"approve"|"deny", chat, req_id}; card locks after click and shows
  the outcome when subsequent frames arrive.
- Composer: textarea (Enter to send, Shift+Enter newline), Send button; while streaming a
  Stop button → {t:"stop", chat}. File attach button: reads file as base64 into files[];
  client-side check: whole frame must stay ≤256KB — if too big, show a clear error and do
  not send (protocol v1 rule).
- History: on first connect and on resync, send {t:"hist"} and render returned messages;
  on {t:"resync"} refetch history and rebuild the message list.
- Resume: existing reconnect logic must send {t:"resume", chat, last_seq}; verify the UI
  shows a "reconnecting/resuming" state and continues the in-flight bubble without dupes.
- Connection status pill (offline / connecting / live / resuming) + agentOnline indicator.
- Clean CSS: light theme, ChatGPT-like spacing, mobile-tolerable (sidebar collapses under
  720px). No UI framework; keep bundle sane.
Acceptance: `npm run build` passes; served locally it loads and works against the local stack.

## Part C — verification (coordinator-run, against the local stack only)
Restart local stack as needed (relay :8787; local QwenPaw :8088 with sanitized NO_PROXY;
reinstall the updated plugin into the LOCAL instance; re-enable web channel).
Harness tests/e2e_m2.mjs must assert:
 1. normal reply now ends with end frame FOLLOWED BY a msg frame whose text equals the
    concatenation of evt deltas (A1);
 2. hist: after that reply, a fresh client sending {t:"hist"} receives messages containing
    both the user text and the assistant reply (A3);
 3. resume: start a reply, disconnect the client mid-stream, reconnect with resume +
    last_seq, assert the missed frames arrive and the full text assembles (use a prompt
    that yields several deltas; if the real model is too terse, document and fall back to
    asserting resume against the mock agent through the same relay);
 4. files: send a msg with a small base64 text file attached; assert no error frame comes
    back and the conversation continues (reply received) (A4).
Approval end-to-end (real tool_guard trigger) is a stretch goal: attempt once with a
prompt that should trigger a shell-tool approval on the local agent; time-box it, and if
the local setup doesn't produce an approval, verify A5 by unit test + document.
Serve the built SPA (vite preview or a static server on :5173) and curl-check 200 + title.
Write docs/m2-report.md (per-part status, evidence, deviations), git commit
"M2: approval/files/history/resume + SPA polish".
