# -*- coding: utf-8 -*-
"""Fire-and-forget archiving of WebChannel conversations into Turso.

Turns one user turn and one assistant turn into Turso HTTP-pipeline batches
(``POST /v2/pipeline``) and hands them to a background sender. Everything is
best-effort: no public method raises, the queue is bounded, a failed batch is
retried twice and then dropped with a log line. A chat must never wait on,
or break because of, the archive.

Only stdlib + httpx here (no qwenpaw imports) so the module can be imported
by the plugin loader as a top-level module or as part of the package.
"""

from __future__ import annotations

import asyncio
import collections
import logging
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

PIPELINE_PATH = "/v2/pipeline"
TITLE_MAX = 80
DEFAULT_MAX_QUEUE = 200
_RETRIES = 2
_BACKOFF_S = 0.5
_TIMEOUT_S = 15.0

SCHEMA_STATEMENTS = (
    "CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY, agent_id TEXT, "
    "created_at INTEGER, updated_at INTEGER, title TEXT)",
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, "
    "chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, "
    "created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)",
)

_SCHEME_SWAPS = (
    ("libsql://", "https://"),
    ("wss://", "https://"),
    ("ws://", "http://"),
)


# -- pure builders ---------------------------------------------------------

def now_ms() -> int:
    """Current unix time in milliseconds."""
    return int(time.time() * 1000)


def pipeline_url(db_url: str) -> str:
    """Turso ``/v2/pipeline`` endpoint for a ``libsql://`` style database URL."""
    url = str(db_url or "").strip()
    for prefix, replacement in _SCHEME_SWAPS:
        if url.startswith(prefix):
            url = replacement + url[len(prefix):]
            break
    return url.rstrip("/") + PIPELINE_PATH


def typed_arg(value: Any) -> Dict[str, Any]:
    """One Turso pipeline typed value."""
    if value is None:
        return {"type": "null"}
    # bool is an int subclass; the pipeline expects "true"/"false" values,
    # which this module never sends, so a bool is not the integer case.
    if isinstance(value, int) and not isinstance(value, bool):
        return {"type": "integer", "value": str(value)}
    return {"type": "text", "value": str(value)}


def execute_request(sql: str, args=()) -> Dict[str, Any]:
    """One pipeline ``execute`` request for *sql* with *args*."""
    return {
        "type": "execute",
        "stmt": {"sql": sql, "args": [typed_arg(arg) for arg in args]},
    }


def pipeline_body(requests) -> Dict[str, Any]:
    """Pipeline body: the requests in order, closed by ``{"type": "close"}``."""
    return {"requests": [*requests, {"type": "close"}]}


def schema_requests() -> List[Dict[str, Any]]:
    """The create-if-not-exists batch run once at sender start."""
    return [execute_request(sql) for sql in SCHEMA_STATEMENTS]


def make_title(text: Any) -> str:
    """Chat title: *text* with all whitespace collapsed, cut to TITLE_MAX."""
    return " ".join(str(text or "").split())[:TITLE_MAX]


def format_files_suffix(files_meta) -> str:
    """``"\\n[attachments: …]"`` for a ``msg.files`` metadata list, else ``""``."""
    parts: List[str] = []
    for entry in files_meta or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not name:
            continue
        mime = entry.get("mime") or "application/octet-stream"
        size = entry.get("size")
        if size is None:
            parts.append("%s (%s)" % (name, mime))
        else:
            parts.append("%s (%s, %s bytes)" % (name, mime, size))
    if not parts:
        return ""
    return "\n[attachments: " + "; ".join(parts) + "]"


_CHAT_UPSERT_SQL = (
    "INSERT INTO chats (chat_id, agent_id, created_at, updated_at, title) "
    "VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET "
    "agent_id = excluded.agent_id, updated_at = excluded.updated_at, "
    "title = CASE WHEN chats.title IS NULL OR chats.title = '' "
    "THEN excluded.title ELSE chats.title END"
)

_MESSAGE_INSERT_SQL = (
    "INSERT INTO messages (chat_id, role, content, created_at) "
    "VALUES (?, ?, ?, ?)"
)


def chat_upsert_request(
    chat_id: str, agent_id: str, ts: int, title: str,
) -> Dict[str, Any]:
    """Upsert the chat row; the title is only ever filled in, never replaced."""
    return execute_request(
        _CHAT_UPSERT_SQL, [chat_id, agent_id, ts, ts, title],
    )


def message_insert_request(
    chat_id: str, role: str, content: str, ts: int,
) -> Dict[str, Any]:
    """Append one message row."""
    return execute_request(_MESSAGE_INSERT_SQL, [chat_id, role, content, ts])


def user_requests(
    chat_id: str, agent_id: str, text: Any, files_meta, ts: int,
) -> List[Dict[str, Any]]:
    """Batch for an inbound user turn (title comes from this first text)."""
    return [
        chat_upsert_request(chat_id, agent_id, ts, make_title(text)),
        message_insert_request(
            chat_id, "user", (text or "") + format_files_suffix(files_meta), ts,
        ),
    ]


def assistant_requests(
    chat_id: str, agent_id: str, text: Any, ts: int,
) -> List[Dict[str, Any]]:
    """Batch for the assistant's final answer (never touches the title)."""
    return [
        chat_upsert_request(chat_id, agent_id, ts, ""),
        message_insert_request(chat_id, "assistant", text or "", ts),
    ]


# -- background sender -----------------------------------------------------

class TursoArchiver:
    """Bounded queue + background sender for Turso pipeline batches."""

    def __init__(
        self, url: str = "", token: str = "", agent_id: str = "",
        transport=None, max_queue: int = DEFAULT_MAX_QUEUE,
        timeout_s: float = _TIMEOUT_S, backoff_s: float = _BACKOFF_S,
    ):
        self._url = url or ""
        self._token = token or ""
        self.agent_id = agent_id or ""
        self._max_queue = max_queue
        self._timeout_s = timeout_s
        self._backoff_s = backoff_s
        self._transport = (
            transport if transport is not None else self._httpx_transport
        )
        # Both halves of the credential are required; a half-configured
        # channel simply archives nothing.
        self.enabled = bool(url and token)
        self._queue: collections.deque = collections.deque()
        self._wake: Optional[asyncio.Event] = None
        self._task: Optional[asyncio.Task] = None
        self._stopped = False
        self.sent_batches = 0
        self.dropped_batches = 0
        self._schema_queued = False
        self._pipeline = pipeline_url(url) if url else ""

    # -- transport ------------------------------------------------------

    async def _httpx_transport(
        self, url: str, headers: Dict[str, str], body: Dict[str, Any],
    ) -> None:
        """Default transport: one HTTP POST that raises on any failure."""
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            resp = await client.post(url, json=body, headers=headers)
            resp.raise_for_status()

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": "Bearer %s" % self._token,
            "Content-Type": "application/json",
        }

    # -- public API (never raises) --------------------------------------

    def archive_user(
        self, chat: str, text: Any, files_meta=None, ts: Optional[int] = None,
    ) -> None:
        """Queue the user turn; a no-op unless the archiver is configured."""
        if not self.enabled:
            return
        try:
            stamp = now_ms() if ts is None else ts
            batch = user_requests(
                chat, self.agent_id, text, files_meta or [], stamp,
            )
            self._enqueue(batch)
        except Exception:  # noqa: BLE001 - archiving must never break a turn
            logger.debug("turso: user archive failed for chat=%s", chat,
                         exc_info=True)

    def archive_assistant(
        self, chat: str, text: Any, ts: Optional[int] = None,
    ) -> None:
        """Queue the assistant's final text; same failure isolation as above."""
        if not self.enabled:
            return
        try:
            stamp = now_ms() if ts is None else ts
            batch = assistant_requests(chat, self.agent_id, text, stamp)
            self._enqueue(batch)
        except Exception:  # noqa: BLE001 - archiving must never break a turn
            logger.debug("turso: assistant archive failed for chat=%s", chat,
                         exc_info=True)

    async def start(self) -> None:
        """Create the sender task (idempotent, never raises)."""
        try:
            if not self.enabled or self._task is not None:
                return
            self._wake = asyncio.Event()
            if not self._schema_queued:
                self._queue.appendleft(schema_requests())
                self._schema_queued = True
            self._task = asyncio.create_task(self._run())
            if self._queue:
                self._wake.set()
        except Exception:  # noqa: BLE001 - a dead sender must not fail start
            logger.warning("turso: archiver start failed", exc_info=True)

    async def stop(self) -> None:
        """Stop the sender; queued batches are dropped (fire-and-forget)."""
        try:
            self._stopped = True
            if self._wake is not None:
                self._wake.set()
            task = self._task
            if task is not None:
                try:
                    await asyncio.wait_for(task, timeout=5)
                except Exception:  # noqa: BLE001 - timeout/cancel is fine
                    task.cancel()
            self._task = None
        except Exception:  # noqa: BLE001 - stop must not raise either
            logger.warning("turso: archiver stop failed", exc_info=True)

    # -- internals ------------------------------------------------------

    def _enqueue(self, batch: List[Dict[str, Any]]) -> None:
        """Append *batch*, or drop it when the queue is already full."""
        if len(self._queue) >= self._max_queue:
            self.dropped_batches += 1
            logger.warning(
                "turso: archive queue full (%d), dropping batch",
                self._max_queue,
            )
            return
        self._queue.append(batch)
        if self._wake is not None:
            self._wake.set()

    async def _run(self) -> None:
        """Drain the queue whenever the wake event is set."""
        while not self._stopped:
            try:
                wake = self._wake
                if wake is None:
                    return
                await wake.wait()
                wake.clear()
                while self._queue and not self._stopped:
                    batch = self._queue.popleft()
                    ok = await self._send_with_retry(batch)
                    if ok:
                        self.sent_batches += 1
                    else:
                        self.dropped_batches += 1
            except Exception:  # noqa: BLE001 - the task must never die
                logger.warning("turso: sender loop error", exc_info=True)
                await asyncio.sleep(0.1)

    async def _send_with_retry(self, batch: List[Dict[str, Any]]) -> bool:
        """POST one batch, retrying _RETRIES times with linear backoff."""
        body = pipeline_body(batch)
        headers = self._headers()
        for attempt in range(_RETRIES):
            try:
                await self._transport(self._pipeline, headers, body)
                return True
            except Exception:  # noqa: BLE001 - retried, then dropped
                logger.warning(
                    "turso: pipeline POST failed (attempt %d/%d)",
                    attempt + 1, _RETRIES, exc_info=True,
                )
                if attempt + 1 < _RETRIES:
                    await asyncio.sleep(self._backoff_s * (attempt + 1))
        return False
