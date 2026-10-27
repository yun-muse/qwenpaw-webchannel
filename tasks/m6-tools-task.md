# M6 tools task — Turso read-back tool + local e2e harness

You are writing tooling/test code in this repo (read AGENTS.md and
tasks/turso-brief.md). Model: deepseek-v4.1-flash. Design choices are
FIXED — implement exactly. Never print or embed any real credential
value; the tool reads credentials from a file at runtime.

## 1. `tools/turso_history.py` — read-back / verification tool

Stdlib ONLY (`argparse`, `json`, `os`, `sys`, `urllib.request`,
`datetime`). No httpx import (must run anywhere).

Behaviour:

- Env file: default path `<repo root>/.secrets/turso.env` (repo root =
  parent of the `tools/` dir containing this file). `--env <path>`
  overrides. Parser: lines `KEY=VALUE`, skip blanks/`#`, strip
  surrounding whitespace and optional surrounding quotes. Needs
  `TURSO_DB_URL` and `TURSO_DB_TOKEN`; missing → exit 2 with a clear
  stderr message (no values printed).
- `pipeline_url(db_url)`: same scheme swap as the plugin
  (`libsql://`→`https://` etc.), + `/v2/pipeline`.
- `run_query(env, sql, args) -> list[list]`: build one execute request
  with typed args (text/integer/null encoding identical to the plugin's
  pipeline format), POST body `{"requests": [req, {"type": "close"}]}`
  via urllib with headers `Authorization: Bearer <token>` and
  `Content-Type: application/json`, **timeout 60 s** (first connect from
  some networks is slow). Parse the JSON response: take
  `results[0]`; if its `type` is `"error"` → raise/exit with the error
  message (no token); else rows = `results[0]["response"]["result"]["rows"]`,
  decoding each typed value: `{"type":"integer","value":"5"}` → `5`,
  `{"type":"text","value":...}` → the string, `{"type":"null"}` → None,
  `{"type":"float","value":...}` → float, blob → None.
  HTTP errors → exit 2 with `HTTP <code>` on stderr.
- `--list`: run
  `SELECT chat_id, agent_id, created_at, updated_at, title, (SELECT COUNT(*) FROM messages WHERE messages.chat_id = chats.chat_id) AS msg_count FROM chats ORDER BY updated_at DESC`
  and print one line per chat, exactly:
  `{chat_id}  msgs={msg_count}  updated={YYYY-MM-DD HH:MM:SS}Z  title={title}`
  (updated formatted from the ms epoch in UTC). No chats → print
  `no archived chats`.
- `--chat <id>`: run
  `SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC`
  with the id as a typed text arg. If zero rows: print
  `no archived messages for chat <id>` to stderr and exit 2. Else print
  header `chat <id> (<n> messages)` then one block per message:
  `{role}: {content}` (content printed as-is, may be multiline).
- Exactly one of `--list` / `--chat` per run (argparse mutually
  exclusive group, required).

## 2. `tests/e2e_turso.mjs` — local e2e against the REAL Turso DB

Node harness in the style of `tests/e2e_m2.mjs` (copy its WS client
scaffolding: same `createRequire` ws import from `../mock/package.json`,
same `connect()` / `waitFor` pattern, frames logged to
`tests/e2e_turso.frames.log`). It runs against the externally started
local stack (relay-node :8787 + local QwenPaw :8088 with the M6 plugin
configured for Turso). Flow:

1. `chat = "chat-turso-" + Date.now().toString(36)`,
   `marker = "TURSO-E2E-" + Date.now().toString(36) + "-" + process.pid`,
   `userText = "Archive check " + marker + ": please say hello."`
2. Connect a client WS to `ws://127.0.0.1:8787/ws/client`.
3. Send `{t: "msg", chat, text: userText}`.
4. Wait (up to 120 s) for the reply: collect `evt` deltas of the answer
   stream and the trailing `msg` frame; `replyText` = trailing msg text
   if a trailing msg frame arrives, else the concatenated deltas.
   Assert a reply arrived at all.
5. Poll the archive: every 5 s, up to 180 s, run
   `python3 tools/turso_history.py --chat <chat>` via
   `child_process.execFile` (cwd = repo root; resolve the tool path
   from the test file location). Success when the command exits 0 AND
   its stdout contains `userText` exactly AND contains `replyText`
   exactly.
6. Also run `python3 tools/turso_history.py --list` and assert its
   stdout contains the chat id.
7. Print per-step ASSERT lines like the other harnesses and the final
   verdict line: `E2E_TURSO PASS` or `E2E_TURSO FAIL` (+ reason).

Note: first-connect latency to Turso from this VM can be tens of
seconds — that is exactly why step 5 polls generously; do not shorten
the timeouts.

When done, list the files you created. Do NOT run the e2e or the tool;
the coordinator runs everything.
