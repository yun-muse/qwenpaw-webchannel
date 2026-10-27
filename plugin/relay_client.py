"""Async WebSocket client for the WebChannel relay (protocol/frames.md v1).

Only third-party dependency: ``websockets`` (a QwenPaw core dependency).
Handles bearer auth, the ``hello`` handshake, an app-level heartbeat every
25 s, exponential-backoff reconnect (1 s -> 30 s) and an ordered send queue
that buffers frames while the socket is down. Reconnect stops permanently
when the relay closes the socket with code 4000 (the client was superseded by
a newer instance).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import socket
import time
import uuid
from typing import Any, Awaitable, Callable, Optional

import websockets

try:  # package-relative (tests, ``python -m plugin...``)
    from .frames import MAX_FRAME_BYTES, check_size, parse_inbound
except ImportError:  # loaded as a top-level module by the plugin loader
    from frames import MAX_FRAME_BYTES, check_size, parse_inbound

logger = logging.getLogger(__name__)

PING_INTERVAL_S = 25.0
PONG_TIMEOUT_S = 10.0
BACKOFF_INITIAL_S = 1.0
BACKOFF_MAX_S = 30.0
QUEUE_MAXSIZE = 1000
# The relay closes a superseded agent socket with this code, reason
# "replaced by new agent connection" (see protocol/frames.md). Such a client
# must never reconnect: the newer instance owns the single agent slot.
REPLACED_CLOSE_CODE = 4000

FrameCallback = Optional[Callable[[dict], Any]]


def _encode(frame: dict) -> str:
    """Serialize a frame exactly as ``frames.check_size`` measures it."""
    return json.dumps(frame, ensure_ascii=False, separators=(",", ":"))


class RelayClient:
    """Maintain one outbound WebSocket to the relay.

    ``on_frame`` is called for every inbound business frame (``pong`` and
    ``ping`` are handled locally). It may be a plain function or a coroutine
    function; exceptions in it are logged and never kill the connection.
    """

    def __init__(
        self,
        relay_url: str,
        token: str,
        agent_id: str = "default",
        on_frame: FrameCallback = None,
        *,
        instance: Optional[str] = None,
        ping_interval: float = PING_INTERVAL_S,
        pong_timeout: float = PONG_TIMEOUT_S,
        queue_maxsize: int = QUEUE_MAXSIZE,
    ):
        self.relay_url = relay_url
        self.token = token
        self.agent_id = agent_id or "default"
        self.session = uuid.uuid4().hex
        # Wall-clock microseconds; fits exactly in a JS double so the relay can
        # compare generations without precision loss.
        self.started_us = time.time_ns() // 1000
        self.instance = instance or socket.gethostname()
        self.on_frame = on_frame
        self.ping_interval = ping_interval
        self.pong_timeout = pong_timeout

        self._queue: asyncio.Queue = asyncio.Queue(maxsize=queue_maxsize)
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None
        self._close_code: Optional[int] = None
        self._tx_lock = asyncio.Lock()
        self._pong = asyncio.Event()
        self._closed = False
        self._fatal = False
        self._connected = False
        self._backoff = BACKOFF_INITIAL_S

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected

    async def start(self) -> None:
        """Start the connection loop in the background (returns immediately)."""
        if self._task is not None and not self._task.done():
            return
        self._closed = False
        self._fatal = False
        self._task = asyncio.create_task(
            self._run(),
            name="webchannel-relay-client",
        )

    async def stop(self) -> None:
        """Cancel the loop and close the socket cleanly."""
        self._closed = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # pragma: no cover - best-effort shutdown
                logger.debug("relay: error while stopping", exc_info=True)
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # pragma: no cover - best-effort shutdown
                logger.debug("relay: close failed", exc_info=True)
        self._connected = False

    async def send(self, frame: dict) -> None:
        """Queue one frame for delivery (dropped if over 256 KB).

        The writer task preserves order and flushes the backlog after a
        reconnect; while offline frames simply accumulate (oldest dropped
        once the queue is full).
        """
        if not isinstance(frame, dict):
            return
        if not check_size(frame):
            logger.warning(
                "relay: dropping oversize frame t=%s (>%d bytes)",
                frame.get("t"),
                MAX_FRAME_BYTES,
            )
            return
        try:
            self._queue.put_nowait(frame)
        except asyncio.QueueFull:
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:  # pragma: no cover - racy but harmless
                pass
            logger.warning("relay: send queue full, dropped oldest frame")
            try:
                self._queue.put_nowait(frame)
            except asyncio.QueueFull:  # pragma: no cover
                pass

    # ------------------------------------------------------------------
    # Connection loop
    # ------------------------------------------------------------------

    async def _run(self) -> None:
        while not self._closed and not self._fatal:
            ws = None
            try:
                ws = await self._connect()
                self._close_code = None
                self._ws = ws
                self._connected = True
                self._backoff = BACKOFF_INITIAL_S
                logger.info(
                    "relay: connected %s as agent=%s",
                    self.relay_url,
                    self.agent_id,
                )
                await self._send_direct(
                    ws,
                    {
                        "t": "hello",
                        "token": self.token,
                        "instance": self.instance,
                        "agent": self.agent_id,
                        "session": self.session,
                        "started": self.started_us,
                    },
                )
                writer = asyncio.create_task(self._writer(ws))
                heartbeat = asyncio.create_task(self._heartbeat(ws))
                try:
                    await self._reader(ws)
                finally:
                    writer.cancel()
                    heartbeat.cancel()
                    await asyncio.gather(
                        writer,
                        heartbeat,
                        return_exceptions=True,
                    )
                if self._close_code == REPLACED_CLOSE_CODE and not self._closed:
                    self._fatal = True
                    logger.error(
                        "relay: superseded by a newer instance (close 4000); "
                        "not reconnecting"
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect on any failure
                if self._is_auth_error(exc):
                    self._fatal = True
                    logger.error(
                        "relay: authentication rejected (%s); not reconnecting",
                        exc,
                    )
                else:
                    logger.warning("relay: connection lost: %s", exc)
            finally:
                self._connected = False
                self._ws = None
                if ws is not None:
                    try:
                        await ws.close()
                    except Exception:  # pragma: no cover
                        pass

            if self._closed or self._fatal:
                break
            delay = self._backoff
            self._backoff = min(BACKOFF_MAX_S, self._backoff * 2)
            logger.info("relay: reconnecting in %.0fs", delay)
            await asyncio.sleep(delay)

    async def _connect(self):
        headers = {"Authorization": f"Bearer {self.token}"}
        kwargs = {
            "additional_headers": headers,
            "max_size": MAX_FRAME_BYTES,
            "open_timeout": 10,
            "close_timeout": 5,
            "ping_interval": None,  # app-level ping/pong instead
        }
        try:
            return await websockets.connect(self.relay_url, **kwargs)
        except TypeError:
            # websockets < 14 used extra_headers; QwenPaw pins >= 15.
            kwargs.pop("additional_headers")
            kwargs["extra_headers"] = headers
            return await websockets.connect(self.relay_url, **kwargs)

    @staticmethod
    def _is_auth_error(exc: Exception) -> bool:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        if status is None:
            status = getattr(exc, "status_code", None)
        return status in (401, 403)

    # ------------------------------------------------------------------
    # IO tasks
    # ------------------------------------------------------------------

    async def _reader(self, ws) -> None:
        while True:
            try:
                raw = await ws.recv()
            except websockets.ConnectionClosed as exc:
                self._close_code = getattr(exc, "code", None)
                return
            frame = parse_inbound(raw)
            if frame is None:
                logger.debug("relay: dropped malformed inbound frame")
                continue
            kind = frame.get("t")
            if kind == "pong":
                self._pong.set()
                continue
            if kind == "ping":
                await self._send_direct(ws, {"t": "pong"})
                continue
            if kind == "error" and frame.get("code") == "E_AUTH":
                self._fatal = True
                logger.error("relay: E_AUTH received; stopping reconnect loop")
                return
            await self._dispatch(frame)

    async def _dispatch(self, frame: dict) -> None:
        if self.on_frame is None:
            return
        try:
            result = self.on_frame(frame)
            if inspect.isawaitable(result):
                await result
        except Exception:  # noqa: BLE001 - one bad frame must not disconnect
            logger.exception("relay: inbound frame handler failed")

    async def _writer(self, ws) -> None:
        while True:
            frame = await self._queue.get()
            try:
                await self._send_direct(ws, frame)
            except asyncio.CancelledError:
                self._requeue(frame)
                raise
            except Exception:
                self._requeue(frame)
                raise
            finally:
                self._queue.task_done()

    async def _heartbeat(self, ws) -> None:
        while True:
            await asyncio.sleep(self.ping_interval)
            self._pong.clear()
            try:
                await self._send_direct(ws, {"t": "ping"})
                await asyncio.wait_for(
                    self._pong.wait(),
                    timeout=self.pong_timeout,
                )
            except asyncio.TimeoutError:
                logger.warning("relay: pong timeout, reconnecting")
                await ws.close()
                return
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - socket died; let reader notice
                logger.debug("relay: heartbeat send failed", exc_info=True)
                await ws.close()
                return

    async def _send_direct(self, ws, frame: dict) -> None:
        text = _encode(frame)
        async with self._tx_lock:
            await ws.send(text)

    def _requeue(self, frame: dict) -> None:
        """Put a failed in-flight frame back at the head of the queue."""
        pending = []
        while True:
            try:
                pending.append(self._queue.get_nowait())
                self._queue.task_done()
            except asyncio.QueueEmpty:
                break
        for item in [frame, *pending]:
            try:
                self._queue.put_nowait(item)
            except asyncio.QueueFull:  # pragma: no cover
                break
