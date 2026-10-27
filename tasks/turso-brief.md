# M6 brief — archive WebChannel conversations into Turso

Engine: CodeBuddy CLI pinned `--model deepseek-v4.1-flash` (fallback
glm-5.3-flash). Repo AGENTS.md applies. Credentials live ONLY in
`.secrets/turso.env` (gitignored, chmod 600): TURSO_DB_URL (libsql://…),
TURSO_DB_TOKEN, TURSO_PLATFORM_TOKEN, TURSO_ORG. Never print token values,
never commit them, never put them in test fixtures or docs.

## Target behaviour

Every conversation that flows through the webchannel plugin is archived to
the Turso database `webchannel-chats`:

- one row per chat in `chats`, one row per message in `messages`
  (user messages as received, assistant messages = the final full text,
  i.e. the trailing-msg content, not per-delta rows).
- Attachment metadata only (name, mime, size) — never file bytes.
- Archiving must be failure-isolated: Turso down/slow/misconfigured can
  never break, delay or error a chat. Fire-and-forget with a bounded
  in-memory queue, a background sender, small retry (2 tries, backoff),
  then drop + log.

## Design (fixed choices)

- Transport: Turso HTTP pipeline API — POST
  `https://<host>/v2/pipeline` with `Authorization: Bearer <db token>`,
  body `{"requests":[{"type":"execute","stmt":{"sql":…,"args":[…]}},…,
  {"type":"close"}]}`. Host = TURSO_DB_URL with the `libsql://` scheme
  swapped to `https://`. Use httpx (already a plugin dependency).
  Args use the pipeline typed-value format
  (`{"type":"text","value":…}` / `{"type":"integer","value":"…"}`).
- Schema (create-if-not-exists at writer start):
  `chats(chat_id TEXT PRIMARY KEY, agent_id TEXT, created_at INTEGER,
  updated_at INTEGER, title TEXT)`;
  `messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`;
  index `idx_messages_chat` on `messages(chat_id, id)`.
  Timestamps: unix milliseconds. Title: first user message, truncated
  to 80 chars, set once.
- New module `plugin/turso_archive.py`: pure builders (SQL + args,
  pipeline body) + `TursoArchiver` class (queue, background task,
  `archive_user(chat, text, files_meta, ts)`, `archive_assistant(chat,
  text, ts)`, `start()`, `stop()`); all network errors swallowed inside.
  `channel.py` wires it: construct from channel config, start/stop with
  the channel, call the two archive methods at the existing user-msg and
  trailing-msg points. Keep the diff in channel.py minimal.
- Config: channel config keys `turso_url` and `turso_token`, declared the
  same way `relay_url` / `agent_token` are declared in the plugin's
  channel config schema (find how those surface in the console Web
  Settings dialog and mirror it, so the parent can fill them there).
  Missing/empty config → archiver disabled, plugin otherwise unchanged.
- Read-back tool `tools/turso_history.py`: reads `.secrets/turso.env`,
  `--list` prints chats (id, updated_at, message count, title),
  `--chat <id>` prints the transcript in order. Plain python + urllib or
  httpx, no new deps. This is the verification surface — make it solid.

## Tests (coordinator-run)

- Unit tests (plain python, ALL PASS style): pipeline body shape and
  typed args, SQL builders, title truncation, archiver with a fake
  transport (records requests) → user+assistant calls produce the right
  statements; archiver with a failing transport → no exception escapes,
  queue drains/drops; disabled config → total no-op.
- Local e2e (`tests/e2e_turso.mjs` or .py): local stack (relay-node :8787,
  local QwenPaw :8088) with the plugin configured from `.secrets/turso.env`
  (inject via the local instance's channel config, do not hardcode).
  Send one user message with a unique marker, await the reply, wait a few
  seconds, then `tools/turso_history.py --chat <id>` must show BOTH rows
  with the exact marker text and the exact reply text. Verdict line
  `E2E_TURSO PASS`.
- Regression: existing plugin tests + e2e_m2 still pass.

## Ship

- Rebuild plugin ZIP (tools/package_plugin.sh). No SPA or relay changes.
- docs/turso-report.md (design as built, test evidence, how the parent
  enables it on the hosted side: console Web Settings fields + restart),
  git commit "M6: Turso conversation archiving".
- The hosted install + config fill-in is the parent's job afterwards.
