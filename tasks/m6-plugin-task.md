# M6 plugin task — Turso conversation archiving (plugin side)

You are writing product code in this repo (read AGENTS.md first, plus
tasks/turso-brief.md for the full work order). Model: deepseek-v4.1-flash.
All design choices below are FIXED — implement them exactly; do not
redesign. Never print or embed any credential value anywhere.

## 1. New module `plugin/turso_archive.py`

Stdlib + httpx only. No qwenpaw imports. Everything network-related is
failure-isolated: no public method of `TursoArchiver` may raise.

Constants: `PIPELINE_PATH = "/v2/pipeline"`, `TITLE_MAX = 80`,
`DEFAULT_MAX_QUEUE = 200`, `_RETRIES = 2`, `_BACKOFF_S = 0.5`,
`_TIMEOUT_S = 15.0`.

Pure helpers (exact names/signatures):

- `now_ms() -> int`: `int(time.time() * 1000)`.
- `pipeline_url(db_url) -> str`: strip whitespace; swap scheme
  `libsql://`→`https://`, `wss://`→`https://`, `ws://`→`http://`
  (only the prefix); rstrip `/`; append `PIPELINE_PATH`.
- `typed_arg(value)`: `None` → `{"type": "null"}`; `bool` is not an int
  case here (never passed); `int` → `{"type": "integer", "value": str(value)}`;
  anything else → `{"type": "text", "value": str(value)}`.
- `execute_request(sql, args=())` →
  `{"type": "execute", "stmt": {"sql": sql, "args": [typed_arg(a) ...]}}`.
- `pipeline_body(requests)` → `{"requests": [*requests, {"type": "close"}]}`.
- `SCHEMA_STATEMENTS`: exactly these three SQL strings (single-line):
  1. `CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY, agent_id TEXT, created_at INTEGER, updated_at INTEGER, title TEXT)`
  2. `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`
  3. `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)`
- `schema_requests()` → `[execute_request(s) for s in SCHEMA_STATEMENTS]`.
- `make_title(text) -> str`: `" ".join(str(text or "").split())[:TITLE_MAX]`
  (collapses all whitespace, truncates to 80 chars).
- `format_files_suffix(files_meta) -> str`: `files_meta` is a list of
  dicts `{"name", "mime", "size"}` (size may be None). Skip entries
  without a truthy name. Per entry: if size is None →
  `"{name} ({mime})"`, else `"{name} ({mime}, {size} bytes)"`; mime
  defaults to `application/octet-stream` when empty. If any parts:
  return `"\n[attachments: " + "; ".join(parts) + "]"`, else `""`.
- `chat_upsert_request(chat_id, agent_id, ts, title)` → execute_request of:
  `INSERT INTO chats (chat_id, agent_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at, title = CASE WHEN chats.title IS NULL OR chats.title = '' THEN excluded.title ELSE chats.title END`
  with args `[chat_id, agent_id, ts, ts, title]`.
- `message_insert_request(chat_id, role, content, ts)` → execute_request of
  `INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)`
  with args `[chat_id, role, content, ts]`.
- `user_requests(chat_id, agent_id, text, files_meta, ts)` →
  `[chat_upsert_request(chat_id, agent_id, ts, make_title(text)), message_insert_request(chat_id, "user", (text or "") + format_files_suffix(files_meta), ts)]`.
- `assistant_requests(chat_id, agent_id, text, ts)` →
  `[chat_upsert_request(chat_id, agent_id, ts, ""), message_insert_request(chat_id, "assistant", text or "", ts)]`.

`class TursoArchiver`:

- `__init__(self, url="", token="", agent_id="", transport=None, max_queue=DEFAULT_MAX_QUEUE, timeout_s=_TIMEOUT_S, backoff_s=_BACKOFF_S)`:
  stores args; `self.agent_id` is a public settable attribute;
  `self.enabled = bool(url and token)`; `self._queue = collections.deque()`;
  `self._wake = None` (asyncio.Event, created in start()); `self._task = None`;
  `self._stopped = False`; public counters `self.sent_batches = 0`,
  `self.dropped_batches = 0`; `self._schema_queued = False`;
  `self._pipeline = pipeline_url(url) if url else ""`.
- Default transport `_httpx_transport(self, url, headers, body)`:
  `async with httpx.AsyncClient(timeout=self._timeout_s) as client: resp = await client.post(url, json=body, headers=headers); resp.raise_for_status()`.
  The transport protocol is `async def t(url, headers, body) -> None`,
  raising on failure; a custom `transport` overrides the default.
- `_headers()` → `{"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}`.
- `archive_user(self, chat, text, files_meta=None, ts=None)` (SYNC):
  if not enabled → return. `ts = now_ms()` when None. Build
  `user_requests(chat, self.agent_id, text, files_meta or [], ts)` and
  `_enqueue`. Whole body wrapped in try/except Exception → logger.debug.
- `archive_assistant(self, chat, text, ts=None)` (SYNC): same pattern
  with `assistant_requests`.
- `_enqueue(self, batch)`: if `len(self._queue) >= self._max_queue`:
  `dropped_batches += 1`, logger.warning, return. Else append; if
  `self._wake is not None`: `self._wake.set()`.
- `async start(self)`: never raises. If not enabled or `self._task` is
  not None → return. Create `self._wake = asyncio.Event()`. If not
  `self._schema_queued`: `self._queue.appendleft(schema_requests())`,
  `self._schema_queued = True`. `self._task = asyncio.create_task(self._run())`.
  If `self._queue` non-empty, set the wake event.
- `async _run(self)`: loop while not `self._stopped`: `await self._wake.wait()`;
  `self._wake.clear()`; then while queue non-empty and not stopped:
  popleft a batch, `ok = await self._send_with_retry(batch)`;
  increment `sent_batches` or `dropped_batches`. Wrap the loop body in
  try/except Exception → log, and `await asyncio.sleep(0.1)` before
  continuing, so the task can never die from an unexpected error.
- `async _send_with_retry(self, batch) -> bool`: body =
  `pipeline_body(batch)`; for attempt in range(_RETRIES): try transport,
  return True; except Exception → log warning with attempt number; if
  more attempts remain `await asyncio.sleep(self._backoff_s * (attempt + 1))`.
  Return False after the last failure.
- `async stop(self)`: never raises. `self._stopped = True`; if wake:
  set it; if task: `await asyncio.wait_for(self._task, timeout=5)`
  inside try/except (on timeout/exception → `self._task.cancel()`);
  `self._task = None`. No drain-on-stop (fire-and-forget).

Module logger: `logger = logging.getLogger(__name__)`.

## 2. `plugin/channel.py` wiring (minimal diff, exact anchors)

- Imports: add `TursoArchiver` to BOTH import blocks:
  `from .turso_archive import TursoArchiver` (try branch) /
  `from turso_archive import TursoArchiver` (except branch). Add
  `import base64` at the top if not already imported.
- `WebChannel.__init__`: add keyword params `turso_url: str = ""`,
  `turso_token: str = ""`. After `self.token = ...` add:
  `self._archiver = TursoArchiver(turso_url or "", turso_token or "")`.
- `from_config`: pass `turso_url=getattr(config, "turso_url", "") or ""`
  and `turso_token=getattr(config, "turso_token", "") or ""`.
- `start()`: after `await self._relay.start()` add:
  `self._archiver.agent_id = self._agent_id()` then
  `await self._archiver.start()`.
- `stop()`: before stopping the relay add `await self._archiver.stop()`.
- `_handle_msg`: the frame's raw `files` list is already read there.
  BEFORE the per-entry resolution loop, build `files_meta`:
  for each entry that is a dict with a truthy `name`: size = decoded
  byte length of `entry["data"]` when it is a non-empty base64 str
  (try/except → None), else `entry["size"]` when that is an int, else
  None; append `{"name": str(name), "mime": str(entry.get("mime") or ""), "size": size}`.
  AFTER `enqueue(native)` (only on the path where enqueue actually
  happens), call:
  `self._archiver.archive_user(chat, text, files_meta, int(time.time() * 1000))`.
- `on_streaming_end`: immediately after the `await self._emit(...)` that
  sends the trailing msg frame (inside the `if trailing:` block), call:
  `self._archiver.archive_assistant(chat, trailing, int(time.time() * 1000))`.
- `send()`: compute `counts = bool(body.strip()) and not self._stream_is_active(chat)`
  once; use it for the existing `self._text_msg_sent.add(chat)`; after
  the `await self._emit(...)`, `if counts:` call
  `self._archiver.archive_assistant(chat, body, int(time.time() * 1000))`.
- `send_content_parts()`: capture the existing delivered-answer
  condition into `counts` (not stream active AND any text part with
  non-empty text); after the `await self._emit(...)`, `if counts:`:
  join the text parts (`part.get("text") or ""` for parts with
  `type == "text"`) and if the joined text is non-empty after strip,
  call `archive_assistant(chat, joined, int(time.time() * 1000))`.

Do not change any other behaviour. `py_compile` must pass on all files.

## 3. `plugin/plugin.py` config fields

Append two entries to `config_fields` (after `token`):
```python
{
    "name": "turso_url",
    "label": "Turso DB URL",
    "type": "text",
    "required": False,
    "placeholder": "libsql://webchannel-chats-<org>.turso.io",
    "default": "",
},
{
    "name": "turso_token",
    "label": "Turso DB Token",
    "type": "password",
    "required": False,
    "placeholder": "",
    "default": "",
},
```

## 4. `tools/package_plugin.sh`

Add `turso_archive.py` to the `FILES` allowlist (after `relay_client.py`).

## 5. Unit tests `plugin/tests/test_turso.py`

Style: mirror `plugin/tests/test_m5.py` — plain-python assert script,
path setup inserting the plugin dir into `sys.path`, a `main()` runner
printing `ALL PASS`. Import from `turso_archive` directly (top-level,
like test_m5 imports `frames`). Use `asyncio.run(...)` per async test.

Cover at least:

- `pipeline_url`: `libsql://db-org.turso.io` → `https://db-org.turso.io/v2/pipeline`;
  trailing slash tolerated; `https://x/` → `https://x/v2/pipeline`.
- `typed_arg`: text/integer (value is the STRING form)/null shapes.
- `pipeline_body`: requests end with `{"type": "close"}` and preserve order.
- `schema_requests`: 3 execute requests; SQL contains `chats`,
  `messages`, `idx_messages_chat`.
- `make_title`: 100-char input → 80 chars; whitespace/newlines collapsed;
  empty → "".
- `format_files_suffix`: empty list → ""; with size → exact
  `\n[attachments: a.png (image/png, 12 bytes)]`; size None →
  `\n[attachments: a.png (image/png)]`; unnamed entries skipped.
- `user_requests` / `assistant_requests`: two requests each; message
  insert args are `[chat, role, content, ts]` with content exact
  (user content includes the attachments suffix when meta given);
  upsert args `[chat, agent, ts, ts, title]`.
- Fake transport (async callable recording `(url, headers, body)`
  calls): archiver enabled with it → `start()`, `archive_user(...)`,
  `archive_assistant(...)`, wait until `sent_batches >= 3` (schema +
  user + assistant) with a polling helper (timeout ~5 s); assert: first
  recorded call is the schema batch; the Authorization header is
  `Bearer <token>` (use a dummy token string like `"test-token"` —
  never a real one); a recorded body contains the exact user text and
  the exact assistant text in the message-insert args; then `stop()`.
- Failing transport (always raises, counts attempts): archiver with
  `backoff_s=0.01` → `start()` + one `archive_user` + wait until
  `dropped_batches >= 2`; assert attempts >= 4 (2 batches × 2 tries)
  and that no exception escaped anywhere; `stop()`.
- Disabled archiver (`url=""` or `token=""`) with a transport that
  raises AssertionError if ever called: `start()`, both archive calls,
  `stop()` all no-op; `enabled is False`.
- Queue bound: enabled archiver, `max_queue=2`, never started: call
  `archive_user` 5 times → `len(archiver._queue) == 2` and
  `dropped_batches == 3`.

When done, list the files you created/changed. Do NOT run anything
else; the coordinator runs all tests.
