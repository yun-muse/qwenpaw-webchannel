# M6 report — Turso conversation archiving

Status: **M6 COMPLETE locally, verified end-to-end against the REAL Turso
database.** The hosted install (parent, via the console) is the only step
left; see "Enabling it on the hosted side" below.

Coding split (per the standing rule): all product/tool code by **CodeBuddy
CLI** pinned `--model deepseek-v4.1-flash` — plugin session `01a17ba9`
(86 model entries, all deepseek-v4.1-flash), tools session `01a17bac`
(40 entries, all deepseek-v4.1-flash). Specs: `tasks/m6-plugin-task.md`,
`tasks/m6-tools-task.md` (written by Muse from `tasks/turso-brief.md`).
Every claim below was verified by Muse on disk / by re-running, not
from session self-reports.

## Design as built

- `plugin/turso_archive.py` (new, stdlib + httpx only): pure builders for
  the Turso HTTP pipeline format (`pipeline_url` scheme swap
  libsql://→https://, typed args, `pipeline_body` ending in
  `{"type":"close"}`), the fixed schema (chats / messages /
  idx_messages_chat, create-if-not-exists), chat upsert (title set once
  via a CASE guard, first user message whitespace-collapsed and cut to
  80 chars), and `TursoArchiver`: bounded deque (200), background sender
  task, 2 tries with linear backoff, then drop + count + log. No public
  method raises; a half-configured channel (only one of url/token)
  archives nothing.
- Attachments: the brief's schema has no column for file metadata, so a
  user message's stored content gets one suffix line,
  `\n[attachments: name (mime, N bytes); …]`, built from the raw
  `msg.files[]` entries (name/mime always; size = decoded byte length of
  the inline data, or the entry's declared `size`). Chunked-upload
  (`{ref}`) entries carry no name in the msg frame, so they contribute
  no suffix in this version (known limitation). File bytes are never
  archived.
- `channel.py` wiring (minimal diff): the archiver is constructed in
  `__init__` from new `turso_url` / `turso_token` kwargs, read in
  `from_config`; `agent_id` is set and the sender started in `start()`,
  stopped first in `stop()`. Archive calls: `archive_user` right after a
  successful `enqueue` in `_handle_msg`; `archive_assistant` at the
  trailing-msg emit in `on_streaming_end`, and in `send()` /
  `send_content_parts()` under the exact conditions that already mark a
  message as the delivered answer (so streamed replies archive exactly
  once; intermediate tool-progress messages sent as their own msg frames
  are archived as their own rows, matching the wire).
- `plugin.py`: two new console config fields mirroring relay_url/token —
  `turso_url` (text) and `turso_token` (password), both optional,
  default empty → archiver disabled, plugin otherwise unchanged.
- `tools/turso_history.py` (new, stdlib only): reads
  `.secrets/turso.env` at runtime (never prints values), `--list` prints
  chats (id, message count, updated, title), `--chat <id>` prints the
  transcript in order; 60 s HTTP timeout.
- Credentials stayed in `.secrets/turso.env` throughout (gitignored);
  nothing token-shaped is in code, tests, fixtures or this report.

## Test evidence (all run by Muse)

- Pre-flight smoke (coordinator): a `SELECT 1` pipeline POST against the
  real DB answered in ~1.7 s — credentials and this VM's egress verified
  before any code was written.
- Unit tests `plugin/tests/test_turso.py` — **ALL PASS** (builders,
  typed args, title truncation, attachments suffix, fake-transport
  end-to-end incl. schema-first ordering and the Bearer header,
  failing-transport retry/drop accounting, disabled no-op, queue bound).
  Note: the suite needs an interpreter with httpx (the plugin runtime
  venv) — system python3 has no httpx, same as `channel.py` itself.
- Regressions: `test_diff.py`, `test_m2.py`, `test_m5.py` ALL PASS;
  `py_compile` clean on all plugin modules and the tool.
- Local e2e `tests/e2e_turso.mjs` (relay-node :8787 + local QwenPaw :8088
  with the M6 plugin installed into the local instance and the Turso
  config injected into the local default agent's channel config):
  **E2E_TURSO PASS** — reply received (trailing msg), and on the first
  poll the archive already held both rows. Independently re-checked by
  Muse with the read-back tool: `user: Archive check
  TURSO-E2E-mvq7dtun-5993: please say hello.` / `assistant: hello`,
  `--list` shows the chat with msgs=2 and the title set from the user
  message.
- Attachment metadata verified live as a side effect of the regression
  run: the e2e_m2 file chat archived as
  `…confirming you got it.\n[attachments: note.txt (text/plain, 28 bytes)]`.
- Regression e2e `tests/e2e_m2.mjs` against the M6 plugin:
  **E2E_M2 PASS** (trailing msg equality over 62 evt frames, hist
  round-trip, inline file attach, mid-stream resume with 41 redelivered
  frames assembled == trailing, bogus approve rejected E_AUTH). The
  approval stretch goal remains untriggered (unchanged since M3; user
  declined tool_guard on 2026-10-27).

## Packaging

- Plugin ZIP rebuilt: `dist/webchannel.zip`, **33,590 bytes** (M5:
  29,894), allowlist now 8 files (added `turso_archive.py`, 12,167 B);
  tests never packaged. No SPA or relay changes.

## Enabling it on the hosted side (parent's steps)

1. Reinstall `dist/webchannel.zip` on the hosted `work` agent via the
   console (uninstall old → install new), then **restart the instance**
   (the M5 lesson: after an uninstall/reinstall the channel toggle alone
   left a wedged channel; a platform Restart loads cleanly).
2. In the console: select the `work` agent → Channels → Web Settings —
   two new fields appear, **Turso DB URL** and **Turso DB Token**. Fill
   them with `TURSO_DB_URL` / `TURSO_DB_TOKEN` from
   `.secrets/turso.env`. Save.
3. Restart the instance (or toggle the Web channel off/on) so the
   channel restarts with the new config.
4. Verify: have any web chat conversation, wait a few seconds, then run
   `python3 tools/turso_history.py --list` — the chat should appear.
   Leaving the fields empty disables archiving with no other effect.
