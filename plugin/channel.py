# -*- coding: utf-8 -*-
"""WebChannel: bridge QwenPaw to the WebChannel relay (protocol/frames.md v1).

Dials the relay as an agent, turns inbound ``msg`` frames into the native queue
payload QwenPaw's manager expects, and turns streaming hooks / send calls into
``start`` / ``evt`` / ``end`` / ``msg`` / ``approval`` frames.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

# Real import lines from the v2.2.2.post1 sources: BaseChannel lives in
# qwenpaw.app.channels.base, which (like console/channel.py's ``..base``
# import) re-exports ContentType / TextContent from qwenpaw.schemas.
from qwenpaw.app.channels.base import BaseChannel, ContentType, TextContent

try:  # package-relative (tests, ``python -m plugin...``)
    from .frames import (
        RingBuffer,
        SeqCounter,
        StreamDiffer,
        approval_frame,
        end_frame,
        evt_frame,
        msg_frame,
        resync_frame,
        start_frame,
    )
    from .relay_client import RelayClient
except ImportError:  # loaded as a top-level module by the plugin loader
    from frames import (
        RingBuffer,
        SeqCounter,
        StreamDiffer,
        approval_frame,
        end_frame,
        evt_frame,
        msg_frame,
        resync_frame,
        start_frame,
    )
    from relay_client import RelayClient

logger = logging.getLogger(__name__)

DEFAULT_RELAY_URL = "ws://127.0.0.1:8787/ws/agent"
DEFAULT_TOKEN = "dev-agent-token"
# Local QwenPaw HTTP API (design 5.1: unauthenticated on localhost, but every
# call must carry X-Agent-Id so the bound workspace agent is selected).
API_BASE = "http://127.0.0.1:8088"
# Protocol v1 has no user identity; a session is one chat.
SENDER_ID = "web-user"

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
        super().__init__(
            process,
            on_reply_sent=on_reply_sent,
            display_config=display_config,
            no_text_debounce=no_text_debounce,
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
        elif kind in ("approve", "deny"):
            await self._handle_approval(kind, frame)
        elif kind == "stop":
            self._handle_stop(frame)
        else:
            logger.debug("webchannel: ignoring inbound frame t=%s", kind)

    async def _handle_msg(self, frame: Dict[str, Any]) -> None:
        chat = str(frame.get("chat") or "default")
        text = frame.get("text")
        text = text if isinstance(text, str) else ""
        files = frame.get("files") or []
        if files:
            logger.warning(
                "webchannel: msg chat=%s carries %d file(s); uploads are not "
                "decoded by this plugin version, ignoring them",
                chat,
                len(files),
            )
        if not text.strip():
            return
        native = {
            "channel_id": self.channel,
            "sender_id": SENDER_ID,
            "content_parts": [TextContent(type=ContentType.TEXT, text=text)],
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

    def _handle_stop(self, frame: Dict[str, Any]) -> None:
        logger.warning(
            "webchannel: stop for chat=%s ignored: BaseChannel / workspace in "
            "v2.2.2.post1 expose no documented cancel-by-chat API",
            frame.get("chat"),
        )

    async def _handle_approval(self, action: str, frame: Dict[str, Any]) -> None:
        chat = str(frame.get("chat") or "default")
        req_id = frame.get("req_id")
        if not req_id:
            logger.warning(
                "webchannel: %s frame without req_id for chat=%s ignored",
                action, chat,
            )
            return
        url = f"{API_BASE}/api/approval/{action}"
        headers = {"X-Agent-Id": self._agent_id()}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    url, json={"request_id": str(req_id)}, headers=headers,
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
        await self._emit(chat, lambda seq: start_frame(chat, seq))

    async def on_streaming_delta(
        self, request, to_handle: str, event, send_meta: Dict[str, Any],
        stream_type: str, accumulated_text: str = "",
    ) -> None:
        chat = self._chat_for(to_handle, send_meta, request)
        chunk = self._differ.diff((chat, stream_type), accumulated_text or "")
        if not chunk:
            return
        await self._emit(chat, lambda seq: evt_frame(chat, seq, chunk))

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
            await self._emit(chat, lambda seq: evt_frame(chat, seq, chunk))
        await self._emit(chat, lambda seq: end_frame(chat, seq))
        self._differ.reset(key)

    async def send(
        self, to_handle: str, text: str, meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        chat = self._chat_for(to_handle, meta)
        parts: List[Dict[str, Any]] = [
            {"type": "text", "text": text if isinstance(text, str) else str(text)},
        ]
        await self._emit(chat, lambda seq: msg_frame(chat, seq, parts))

    async def send_content_parts(
        self, to_handle: str, parts: List[Any],
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not parts:
            return
        chat = self._chat_for(to_handle, meta)
        serialized = [_part_to_dict(part) for part in parts]
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
