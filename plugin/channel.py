# -*- coding: utf-8 -*-
"""WebChannel: bridge QwenPaw to the WebChannel relay (protocol/frames.md v1).

Dials the relay as an agent, turns inbound ``msg`` frames into the native queue
payload QwenPaw's manager expects, and turns streaming hooks / send calls into
``start`` / ``evt`` / ``end`` / ``msg`` / ``approval`` frames. Inbound ``stop``,
``hist``, ``approve`` and ``deny`` are served through the local QwenPaw HTTP API
(``chat/stop``, ``chats``, ``console/upload``, ``approval/*``). Protocol v2 adds
chunked uploads -- ``file_begin`` / ``file_chunk`` / ``file_end`` answered with
``file_ready`` / ``file_error`` -- whose files are staged for ten minutes and
then referenced as ``msg.files[].ref``.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

import httpx

# Real import lines from the v2.2.2.post1 sources: BaseChannel lives in
# qwenpaw.app.channels.base, which (like console/channel.py's ``..base``
# import) re-exports ContentType / TextContent / FileContent from
# qwenpaw.schemas.
from qwenpaw.app.channels.base import (
    BaseChannel,
    ContentType,
    FileContent,
    TextContent,
)

try:  # package-relative (tests, ``python -m plugin...``)
    from .frames import (
        RingBuffer,
        SeqCounter,
        StreamDiffer,
        approval_frame,
        check_size,
        end_frame,
        error_frame,
        evt_frame,
        file_error_frame,
        file_ready_frame,
        hist_frame,
        msg_frame,
        resync_frame,
        start_frame,
    )
    from .relay_client import RelayClient
    from .util import (
        ANSWER_STREAM_TYPE,
        FileTransfers,
        approval_owner_ok,
        decode_file_entry,
        hist_limit,
        history_messages,
        pack_history,
        trailing_msg_text,
    )
except ImportError:  # loaded as a top-level module by the plugin loader
    from frames import (
        RingBuffer,
        SeqCounter,
        StreamDiffer,
        approval_frame,
        check_size,
        end_frame,
        error_frame,
        evt_frame,
        file_error_frame,
        file_ready_frame,
        hist_frame,
        msg_frame,
        resync_frame,
        start_frame,
    )
    from relay_client import RelayClient
    from util import (
        ANSWER_STREAM_TYPE,
        FileTransfers,
        approval_owner_ok,
        decode_file_entry,
        hist_limit,
        history_messages,
        pack_history,
        trailing_msg_text,
    )

logger = logging.getLogger(__name__)

DEFAULT_RELAY_URL = "ws://127.0.0.1:8787/ws/agent"
DEFAULT_TOKEN = "dev-agent-token"
# Local QwenPaw HTTP API (design 5.1: unauthenticated on localhost, but every
# call must carry X-Agent-Id so the bound workspace agent is selected).
API_BASE = "http://127.0.0.1:8088"
# Protocol v1 has no user identity; a session is one chat.
SENDER_ID = "web-user"
# Uploads (A4) can be up to the relay's 256 KB frame budget; give the local
# API room to write them to the console media dir.
_UPLOAD_TIMEOUT_S = 60.0

# Short human-readable ``file_error.msg`` bodies, keyed by protocol code.
_FILE_ERROR_MSG = {
    "E_CHECKSUM": "file checksum mismatch; resend the file once",
    "E_TOOBIG": "file exceeds the 10 MB limit",
    "E_STATE": "chunk or end without a valid begin",
}

# Content-part fields copied into ``parts[]`` dicts (getattr-based, defensive).
_PART_FIELDS = (
    "text",
    "refusal",
    "image_url",
    "video_url",
    "data",
    "file_url",
    "file_id",
    "filename",
    "name",
    "mime",
)


def _part_to_dict(part: Any) -> Dict[str, Any]:
    """Serialize one outgoing content part to a plain JSON-ready dict."""
    if isinstance(part, dict):
        out = dict(part)
        if "type" in out:
            out["type"] = getattr(out["type"], "value", out["type"])
        return out
    raw_type = getattr(part, "type", None)
    part_type = getattr(raw_type, "value", raw_type)
    out: Dict[str, Any] = {
        "type": str(part_type) if part_type is not None else "unknown",
    }
    for field in _PART_FIELDS:
        value = getattr(part, field, None)
        if value is not None:
            out[field] = value
    return out


class WebChannel(BaseChannel):
    """QwenPaw channel backed by the WebChannel relay WebSocket."""

    channel = "web"
    uses_manager_queue = True
    streaming_enabled = True
    _STREAM_DELTA_MIN_INTERVAL_S = 0.0

    def __init__(
        self, process, relay_url: str = DEFAULT_RELAY_URL,
        token: str = DEFAULT_TOKEN, on_reply_sent=None, display_config=None,
        no_text_debounce: bool = True,
    ):
        # ``no_text_debounce`` is accepted for BaseChannel signature parity but
        # deliberately not forwarded: every inbound ``msg`` frame is one
        # complete user turn, and an attachment-only turn carries no text at
        # all -- the debounce would park it until a later text message
        # (console_channel.py disables it for the same reason).
        del no_text_debounce
        super().__init__(
            process,
            on_reply_sent=on_reply_sent,
            display_config=display_config,
            no_text_debounce=False,
            # BaseChannel.__init__ overwrites the class attribute, so this
            # must be passed explicitly for the streaming hooks to fire.
            streaming_enabled=True,
        )
        self.relay_url = relay_url or DEFAULT_RELAY_URL
        self.token = token or DEFAULT_TOKEN
        self._relay: Optional[RelayClient] = None
        self._seq = SeqCounter()
        self._ring = RingBuffer(400)
        self._differ = StreamDiffer()
        # Chats whose current stream segment already delivered a text ``msg``
        # via send()/send_content_parts (A1). Cleared on on_streaming_start.
        self._text_msg_sent: set = set()
        # (chat, stream_type) pairs with a segment in flight; text sent while
        # one is open is tool output, not the answer, so it must not count as
        # "the reply was already delivered".
        self._active_streams: set = set()
        # Web chat id -> ChatSpec.id, resolved once per chat (A2/A3).
        self._chat_ids: Dict[str, str] = {}
        # Protocol v2 chunked uploads: in-progress assemblies + staged files.
        self._files = FileTransfers()

    # -- construction / session mapping ---------------------------------

    @classmethod
    def from_config(
        cls, process, config, on_reply_sent=None,
        display_config=None, no_text_debounce: bool = True,
    ) -> "WebChannel":
        """Build from a (possibly SimpleNamespace) config, getattr-safe."""
        return cls(
            process=process,
            relay_url=getattr(config, "relay_url", "") or DEFAULT_RELAY_URL,
            token=getattr(config, "token", "") or DEFAULT_TOKEN,
            on_reply_sent=on_reply_sent,
            display_config=display_config,
            no_text_debounce=no_text_debounce,
        )

    def resolve_session_id(
        self, sender_id: str, channel_meta: Optional[Dict[str, Any]] = None,
    ) -> str:
        chat_id = (channel_meta or {}).get("chat_id") or "default"
        return f"{self.channel}:{sender_id}:{chat_id}"

    def build_agent_request_from_native(self, native_payload: Any):
        """Turn the queue payload built by ``_handle_msg`` into an AgentRequest."""
        payload = native_payload if isinstance(native_payload, dict) else {}
        channel_id = payload.get("channel_id") or self.channel
        sender_id = payload.get("sender_id") or ""
        content_parts = payload.get("content_parts") or []
        meta = payload.get("meta") or {}
        session_id = self.resolve_session_id(sender_id, meta)
        request = self.build_agent_request_from_user_content(
            channel_id=channel_id,
            sender_id=sender_id,
            content_parts=content_parts,
            session_id=session_id,
            channel_meta=meta,
        )
        request.channel_meta = meta
        request_context = meta.get("request_context")
        if isinstance(request_context, dict) and request_context:
            request.request_context = request_context
        return request

    # -- lifecycle (BaseChannel.start / stop are the real hooks) ---------

    async def start(self) -> None:
        if self._relay is not None:
            return
        self._relay = RelayClient(
            self.relay_url,
            self.token,
            agent_id=self._agent_id(),
            on_frame=self._on_relay_frame,
        )
        await self._relay.start()
        logger.info(
            "webchannel started: relay=%s agent=%s",
            self.relay_url,
            self._agent_id(),
        )

    async def stop(self) -> None:
        relay, self._relay = self._relay, None
        if relay is not None:
            await relay.stop()
        logger.info("webchannel stopped")

    def _agent_id(self) -> str:
        """Bound workspace agent id, read exactly as base.py does."""
        workspace = self._workspace
        if workspace is None:
            return "default"
        return getattr(workspace, "agent_id", "default")

    # -- local API helpers (A2/A3/A4/A5) --------------------------------

    def _headers(self) -> Dict[str, str]:
        """Headers for the local QwenPaw API (selects the bound agent)."""
        return {"X-Agent-Id": self._agent_id()}

    async def _resolve_chat_id(self, chat: str) -> Optional[str]:
        """``ChatSpec.id`` backing this web chat, or None when it has none yet.

        ``GET /api/chats`` answers every ``ChatSpec`` of the agent; the one for
        this chat is the entry with ``channel == "web"`` whose ``session_id``
        equals our own ``resolve_session_id(SENDER_ID, {chat_id: chat})``.
        A chat is created by the manager on its first message, so a client that
        asks for history before saying anything gets no id (empty history, not
        an error). The id is cached per chat once found.
        """
        cached = self._chat_ids.get(chat)
        if cached:
            return cached

        session_id = self.resolve_session_id(SENDER_ID, {"chat_id": chat})
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{API_BASE}/api/chats",
                    params={"channel": self.channel},
                    headers=self._headers(),
                )
            if response.status_code >= 400:
                logger.warning(
                    "webchannel: GET /api/chats failed for chat=%s: HTTP %s",
                    chat, response.status_code,
                )
                return None
            specs = response.json()
        except Exception:  # noqa: BLE001 - a failed lookup sends nothing
            logger.warning(
                "webchannel: chat lookup failed for chat=%s", chat, exc_info=True,
            )
            return None

        if not isinstance(specs, list):
            specs = []
        for spec in specs:
            if not isinstance(spec, dict):
                continue
            if spec.get("channel") != self.channel:
                continue
            if spec.get("session_id") != session_id:
                continue
            chat_id = spec.get("id")
            if chat_id:
                self._chat_ids[chat] = str(chat_id)
                logger.debug(
                    "webchannel: chat=%s -> ChatSpec.id=%s", chat, chat_id,
                )
                return str(chat_id)
        logger.debug("webchannel: no ChatSpec yet for chat=%s", chat)
        return None

    async def _get_history(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """``ChatHistory`` for *chat_id* (``{messages: [...], status}``)."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{API_BASE}/api/chats/{chat_id}", headers=self._headers(),
                )
            if response.status_code >= 400:
                logger.warning(
                    "webchannel: GET /api/chats/%s failed: HTTP %s",
                    chat_id, response.status_code,
                )
                return None
            payload = response.json()
        except Exception:  # noqa: BLE001 - a failed read sends no history
            logger.warning(
                "webchannel: history read failed for chat_id=%s",
                chat_id, exc_info=True,
            )
            return None
        return payload if isinstance(payload, dict) else None

    # -- outbound plumbing: seq + ring buffer + relay --------------------

    def _chat_for(self, to_handle: str, meta: Any, request: Any = None) -> str:
        meta = meta or {}
        chat = meta.get("chat_id")
        if chat:
            return str(chat)
        session_id = (
            meta.get("session_id")
            or getattr(request, "session_id", "")
            or ""
        )
        prefix = f"{self.channel}:"
        if session_id.startswith(prefix):
            tail = session_id.rsplit(":", 1)[-1]
            if tail:
                return tail
        return str(to_handle or "default")

    def _stream_is_active(self, chat: str) -> bool:
        """True while any streaming segment for *chat* is open."""
        return any(key[0] == chat for key in self._active_streams)

    async def _emit(self, chat: str, build) -> None:
        """Assign the next per-chat seq, buffer, then send the built frame."""
        seq = self._seq.next(chat)
        frame = build(seq)
        self._ring.append(chat, seq, frame)
        relay = self._relay
        if relay is None:
            logger.debug(
                "webchannel: relay not running, dropping t=%s", frame.get("t"),
            )
            return
        await relay.send(frame)

    # -- inbound relay frames -------------------------------------------

    async def _on_relay_frame(self, frame: Dict[str, Any]) -> None:
        kind = frame.get("t")
        if kind == "msg":
            await self._handle_msg(frame)
        elif kind == "resume":
            await self._handle_resume(frame)
        elif kind == "hist":
            await self._handle_hist(frame)
        elif kind in ("approve", "deny"):
            await self._handle_approval(kind, frame)
        elif kind == "stop":
            await self._handle_stop(frame)
        elif kind == "file_begin":
            await self._handle_file_begin(frame)
        elif kind == "file_chunk":
            await self._handle_file_chunk(frame)
        elif kind == "file_end":
            await self._handle_file_end(frame)
        else:
            logger.debug("webchannel: ignoring inbound frame t=%s", kind)

    async def _handle_msg(self, frame: Dict[str, Any]) -> None:
        chat = str(frame.get("chat") or "default")
        self._purge_files(time.monotonic())
        text = frame.get("text")
        text = text if isinstance(text, str) else ""

        content_parts: List[Any] = []
        if text.strip():
            content_parts.append(TextContent(type=ContentType.TEXT, text=text))
        files = frame.get("files")
        if isinstance(files, list):
            for entry in files:
                part = await self._resolve_file_entry(chat, entry)
                if part is not None:
                    content_parts.append(part)
        if not content_parts:
            return

        native = {
            "channel_id": self.channel,
            "sender_id": SENDER_ID,
            "content_parts": content_parts,
            "meta": {
                "chat_id": chat,
                "session_id": self.resolve_session_id(SENDER_ID, {"chat_id": chat}),
            },
        }
        enqueue = self._enqueue
        if enqueue is None:
            logger.warning(
                "webchannel: no enqueue callback (manager not attached); "
                "dropping msg for chat=%s",
                chat,
            )
            return
        enqueue(native)

    async def _resolve_file_entry(
        self, chat: str, entry: Any,
    ) -> Optional[FileContent]:
        """Turn one ``msg.files[]`` item into a ``FileContent`` (A4 + v2 refs).

        ``{"ref": "<id>"}`` (no ``data``) consumes a file staged by a chunked
        upload; everything else takes the v1 inline ``{name, mime, data}``
        path. Refs are one-shot, so an unknown/expired/consumed one is logged
        and the entry skipped.
        """
        ref = entry.get("ref") if isinstance(entry, dict) else None
        if isinstance(ref, str) and ref and "data" not in entry:
            taken = self._files.take(ref, time.monotonic())
            if taken is None:
                logger.warning(
                    "webchannel: chat=%s referenced file id=%r but it is "
                    "unknown, expired or already used; entry dropped",
                    chat, ref,
                )
                return None
            name, mime, data = taken
            return await self._store_file(chat, name, mime, data)
        return await self._upload_file(chat, entry)

    async def _upload_file(self, chat: str, entry: Any) -> Optional[FileContent]:
        """Store one inline inbound ``files[]`` item (A4).

        Decodes ``{name, mime, base64 data}`` and hands the bytes to
        ``_store_file``. Returns None (after logging) for an undecodable or
        failed item; the rest of the message still goes through.
        """
        decoded = decode_file_entry(entry)
        if decoded is None:
            logger.warning(
                "webchannel: chat=%s sent an undecodable file entry; dropped",
                chat,
            )
            return None
        return await self._store_file(chat, *decoded)

    async def _store_file(
        self, chat: str, name: str, mime: str, data: bytes,
    ) -> Optional[FileContent]:
        """Upload raw *data* via the console API; the matching ``FileContent``.

        The console channel receives attachments as ``FileContent(file_url=…)``
        pointing at an absolute path inside its media dir, and
        ``POST /api/console/upload`` is what produces exactly that, so the
        plugin reuses it instead of inventing a second storage location.
        Returns None (after logging) when the upload fails.
        """
        try:
            async with httpx.AsyncClient(timeout=_UPLOAD_TIMEOUT_S) as client:
                response = await client.post(
                    f"{API_BASE}/api/console/upload",
                    files={"file": (name, data, mime)},
                    headers=self._headers(),
                )
            if response.status_code >= 400:
                logger.warning(
                    "webchannel: upload of %r for chat=%s failed: HTTP %s",
                    name, chat, response.status_code,
                )
                return None
            payload = response.json()
        except Exception:  # noqa: BLE001 - one bad upload must not drop the turn
            logger.warning(
                "webchannel: upload of %r for chat=%s failed", name, chat,
                exc_info=True,
            )
            return None

        url = payload.get("url") if isinstance(payload, dict) else None
        if not url:
            logger.warning(
                "webchannel: upload of %r for chat=%s returned no url", name, chat,
            )
            return None
        logger.info(
            "webchannel: chat=%s attached %r (%d bytes)", chat, name, len(data),
        )
        return FileContent(
            type=ContentType.FILE, filename=name, file_url=str(url),
        )

    # -- protocol v2: chunked file transfer -----------------------------

    def _purge_files(self, now: float) -> None:
        """Drop transfers/staged files older than the TTL (log the former)."""
        for tid in self._files.purge(now):
            logger.warning(
                "webchannel: dropped expired file transfer id=%s", tid,
            )

    @staticmethod
    def _file_target(frame: Dict[str, Any]):
        """``(chat, transfer_id)``; *transfer_id* is None when unusable.

        Without a non-empty string ``id`` there is nothing to reply about, so
        the caller only logs and drops the frame.
        """
        chat = str(frame.get("chat") or "default")
        tid = frame.get("id")
        if not (isinstance(tid, str) and tid):
            return chat, None
        return chat, tid

    async def _file_error(
        self, chat: str, tid: str, code: str,
    ) -> None:
        """Reply ``file_error`` for a rejected ``file_*`` step."""
        detail = _FILE_ERROR_MSG.get(code, "")
        await self._emit(
            chat,
            lambda seq: file_error_frame(chat, tid, code, detail, seq=seq),
        )

    async def _handle_file_begin(self, frame: Dict[str, Any]) -> None:
        """``file_begin``: validate metadata and start assembling."""
        now = time.monotonic()
        self._purge_files(now)
        chat, tid = self._file_target(frame)
        if tid is None:
            logger.warning(
                "webchannel: file_begin without a usable id for chat=%s "
                "ignored",
                chat,
            )
            return
        ok, code = self._files.begin(tid, frame, now)
        if not ok:
            logger.warning(
                "webchannel: file_begin for chat=%s id=%s rejected: %s",
                chat, tid, code,
            )
            await self._file_error(chat, tid, code)

    async def _handle_file_chunk(self, frame: Dict[str, Any]) -> None:
        """``file_chunk``: store one chunk (no reply on success)."""
        now = time.monotonic()
        self._purge_files(now)
        chat, tid = self._file_target(frame)
        if tid is None:
            logger.warning(
                "webchannel: file_chunk without a usable id for chat=%s "
                "ignored",
                chat,
            )
            return
        ok, code = self._files.chunk(tid, frame.get("i"), frame.get("data"), now)
        if not ok:
            logger.warning(
                "webchannel: file_chunk for chat=%s id=%s i=%s rejected: %s",
                chat, tid, frame.get("i"), code,
            )
            await self._file_error(chat, tid, code)

    async def _handle_file_end(self, frame: Dict[str, Any]) -> None:
        """``file_end``: verify the file, then answer ``file_ready``."""
        now = time.monotonic()
        self._purge_files(now)
        chat, tid = self._file_target(frame)
        if tid is None:
            logger.warning(
                "webchannel: file_end without a usable id for chat=%s ignored",
                chat,
            )
            return
        ok, code, info = self._files.end(tid, now)
        if not ok:
            logger.warning(
                "webchannel: file_end for chat=%s id=%s rejected: %s",
                chat, tid, code,
            )
            await self._file_error(chat, tid, code)
            return
        logger.info(
            "webchannel: chat=%s staged file %r id=%s (%d bytes)",
            chat, info["name"], tid, info["size"],
        )
        await self._emit(
            chat, lambda seq: file_ready_frame(chat, tid, seq=seq),
        )

    async def _handle_resume(self, frame: Dict[str, Any]) -> None:
        chat = str(frame.get("chat") or "default")
        try:
            last_seq = int(frame.get("last_seq") or 0)
        except (TypeError, ValueError):
            last_seq = 0
        buffered = self._ring.since(chat, last_seq)
        if buffered is None:
            # Buffer miss: tell the client to reload history.
            await self._emit(
                chat, lambda seq: {**resync_frame(chat, "gap"), "seq": seq},
            )
            return
        relay = self._relay
        if relay is None or not buffered:
            return
        for stored in buffered:  # redelivery keeps the original seq
            await relay.send(stored)

    async def _handle_hist(self, frame: Dict[str, Any]) -> None:
        """Reply to ``{t:"hist", chat, limit?}`` with ``hist`` frame(s) (A3)."""
        chat = str(frame.get("chat") or "default")
        limit = hist_limit(frame.get("limit"))

        messages: List[Dict[str, str]] = []
        chat_id = await self._resolve_chat_id(chat)
        if chat_id:
            history = await self._get_history(chat_id)
            if history is not None:
                messages = history_messages(history, limit)

        if not messages:
            await self._emit(
                chat, lambda seq: hist_frame(chat, [], seq=seq),
            )
            return

        # Pack against the widest variant (non-final frames carry "more":true)
        # so every frame the client sees is inside the 256 KB wire limit.
        chunks = pack_history(
            messages,
            lambda chunk: check_size(hist_frame(chat, chunk, more=True)),
        )
        if len(chunks) > 1:
            logger.info(
                "webchannel: chat=%s history split into %d frames (%d messages)",
                chat, len(chunks), len(messages),
            )
        for index, chunk in enumerate(chunks):
            more = index < len(chunks) - 1
            await self._emit(
                chat,
                lambda seq, chunk=chunk, more=more: hist_frame(
                    chat, chunk, more=more, seq=seq,
                ),
            )

    async def _handle_stop(self, frame: Dict[str, Any]) -> None:
        """Cancel the running turn via ``POST /api/console/chat/stop`` (A2)."""
        chat = str(frame.get("chat") or "default")
        chat_id = await self._resolve_chat_id(chat)
        if not chat_id:
            logger.warning(
                "webchannel: stop for chat=%s ignored: no QwenPaw chat exists "
                "for this session yet, so there is nothing to cancel",
                chat,
            )
            return
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{API_BASE}/api/console/chat/stop",
                    params={"chat_id": chat_id},
                    headers=self._headers(),
                )
            if response.status_code >= 400:
                logger.warning(
                    "webchannel: stop for chat=%s (chat_id=%s) failed: HTTP %s",
                    chat, chat_id, response.status_code,
                )
                return
            logger.info(
                "webchannel: stop for chat=%s (chat_id=%s): %s",
                chat, chat_id, response.text,
            )
        except Exception:  # noqa: BLE001 - a failed stop must not kill the socket
            logger.warning(
                "webchannel: stop POST failed for chat=%s (chat_id=%s)",
                chat, chat_id, exc_info=True,
            )

    async def _find_pending_approval(self, req_id: str) -> Optional[Dict[str, Any]]:
        """The ``/api/approval/list`` entry for *req_id*, or None (A5)."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{API_BASE}/api/approval/list", headers=self._headers(),
                )
            if response.status_code >= 400:
                logger.warning(
                    "webchannel: GET /api/approval/list failed: HTTP %s",
                    response.status_code,
                )
                return None
            payload = response.json()
        except Exception:  # noqa: BLE001 - refuse rather than approve blind
            logger.warning(
                "webchannel: approval list lookup failed", exc_info=True,
            )
            return None

        pending = payload.get("pending_approvals") if isinstance(
            payload, dict,
        ) else None
        if not isinstance(pending, list):
            pending = []
        for entry in pending:
            if isinstance(entry, dict) and str(entry.get("request_id")) == req_id:
                return entry
        return None

    async def _handle_approval(self, action: str, frame: Dict[str, Any]) -> None:
        chat = str(frame.get("chat") or "default")
        req_id = frame.get("req_id")
        if not req_id:
            logger.warning(
                "webchannel: %s frame without req_id for chat=%s ignored",
                action, chat,
            )
            return
        req_id = str(req_id)

        pending = await self._find_pending_approval(req_id)
        if not approval_owner_ok(pending, self._agent_id()):
            logger.warning(
                "webchannel: refusing %s for chat=%s req_id=%s: not pending for "
                "agent=%s",
                action, chat, req_id, self._agent_id(),
            )
            await self._emit(
                chat,
                lambda seq: {
                    **error_frame("E_AUTH", "approval not pending for this agent"),
                    "chat": chat,
                    "req_id": req_id,
                    "seq": seq,
                },
            )
            return

        # /api/approval/{approve,deny} matches the pending's root_session_id
        # against the body's required session_id, so pass it through.
        body: Dict[str, Any] = {"request_id": req_id}
        session_id = pending.get("root_session_id") or pending.get("session_id")
        if session_id:
            body["session_id"] = str(session_id)

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{API_BASE}/api/approval/{action}",
                    json=body,
                    headers=self._headers(),
                )
            if response.status_code >= 400:
                logger.warning(
                    "webchannel: %s for chat=%s req_id=%s failed: HTTP %s",
                    action, chat, req_id, response.status_code,
                )
        except Exception:  # noqa: BLE001 - a failed POST must not kill the socket
            logger.warning(
                "webchannel: %s POST failed for chat=%s req_id=%s",
                action, chat, req_id, exc_info=True,
            )

    # -- outbound hooks --------------------------------------------------

    async def on_streaming_start(
        self, request, to_handle: str, event, send_meta: Dict[str, Any],
        stream_type: str, accumulated_text: str = "",
    ) -> None:
        chat = self._chat_for(to_handle, send_meta, request)
        self._differ.reset((chat, stream_type))
        self._text_msg_sent.discard(chat)
        self._active_streams.add((chat, stream_type))
        await self._emit(
            chat, lambda seq: start_frame(chat, seq, stream_type=stream_type),
        )

    async def on_streaming_delta(
        self, request, to_handle: str, event, send_meta: Dict[str, Any],
        stream_type: str, accumulated_text: str = "",
    ) -> None:
        chat = self._chat_for(to_handle, send_meta, request)
        chunk = self._differ.diff((chat, stream_type), accumulated_text or "")
        if not chunk:
            return
        await self._emit(
            chat, lambda seq: evt_frame(chat, seq, chunk, stream_type),
        )

    async def on_streaming_end(
        self, request, to_handle: str, event, send_meta: Dict[str, Any],
        stream_type: str, accumulated_text: str = "",
    ) -> None:
        chat = self._chat_for(to_handle, send_meta, request)
        key = (chat, stream_type)
        # The completed event can carry text no delta flushed (BaseChannel
        # coalesces flushes), so emit the tail before ``end``.
        chunk = self._differ.diff(key, accumulated_text or "")
        if chunk:
            await self._emit(
                chat, lambda seq: evt_frame(chat, seq, chunk, stream_type),
            )
        await self._emit(
            chat, lambda seq: end_frame(chat, seq, stream_type=stream_type),
        )

        # A1: a streamed reply never reaches send() -- base.py's
        # ``_on_stream_msg_end`` consumes the completed message event itself --
        # so close the segment with the full text as a ``msg`` frame, after
        # ``end``. Only the ANSWER segment gets that trailing msg: a
        # ``reasoning`` segment is start/evt/end and nothing more. Nothing
        # extra either when send()/send_content_parts already delivered text
        # for this segment (non-streamed replies).
        if stream_type == ANSWER_STREAM_TYPE:
            trailing = trailing_msg_text(
                stream_type, self._differ.last(key), chat in self._text_msg_sent,
            )
            if trailing:
                await self._emit(
                    chat,
                    lambda seq: msg_frame(
                        chat, seq, [{"type": "text", "text": trailing}],
                    ),
                )
        self._active_streams.discard(key)
        self._differ.reset(key)

    async def send(
        self, to_handle: str, text: str, meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        chat = self._chat_for(to_handle, meta)
        body = text if isinstance(text, str) else str(text)
        if body.strip() and not self._stream_is_active(chat):
            self._text_msg_sent.add(chat)
        parts: List[Dict[str, Any]] = [{"type": "text", "text": body}]
        await self._emit(chat, lambda seq: msg_frame(chat, seq, parts))

    async def send_content_parts(
        self, to_handle: str, parts: List[Any],
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not parts:
            return
        chat = self._chat_for(to_handle, meta)
        serialized = [_part_to_dict(part) for part in parts]
        if not self._stream_is_active(chat) and any(
            part.get("type") == "text" and (part.get("text") or "").strip()
            for part in serialized
        ):
            self._text_msg_sent.add(chat)
        await self._emit(chat, lambda seq: msg_frame(chat, seq, serialized))

    async def send_approval_notification(
        self, *, session_id: str, user_id: str, request_id: str,
        tool_name: str, severity: str, result_summary: str,
        channel_meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        chat = self._chat_for(
            user_id, {**(channel_meta or {}), "session_id": session_id},
        )
        await self._emit(
            chat,
            lambda seq: approval_frame(
                chat, request_id, seq=seq, tool=tool_name,
                severity=severity, summary=result_summary,
            ),
        )
