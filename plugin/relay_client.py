"""Async WebSocket client for the WebChannel relay (protocol/frames.md v1).

Only third-party dependency: ``websockets`` (a QwenPaw core dependency).
Handles bearer auth, the ``hello`` handshake, an end-to-end ``hb`` heartbeat
every 15 s (M7.3), WebSocket-level ping/pong, exponential-backoff reconnect
(1 s -> 30 s) and an ordered send queue that buffers frames while the socket
is down. Reconnect stops permanently when the relay closes the socket with code
4000 (the client was superseded by a newer instance).

M7.2 self-healing: every connection phase runs reader / writer / heartbeat
under ``asyncio.wait(FIRST_COMPLETED)``, so a parked frame callback or a dead
writer ends the phase instead of parking the loop; sends are time-bounded;
and a supervisor restarts ``_run`` after any non-fatal exit.

M7.3 end-to-end liveness: the app-level ``ping`` is answered at the edge
(``setWebSocketAutoResponse`` on Cloudflare, and WebSocket-level pings are
answered there too), so neither can see a dead agent<->relay path. ``hb`` is
processed by the relay process itself and acked with ``hb_ack``; missing acks
end the phase and the run loop reconnects.
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
    from .filelog import FileLog
    from .frames import MAX_FRAME_BYTES, check_size, parse_inbound
except ImportError:  # loaded as a top-level module by the plugin loader
    from filelog import FileLog
    from frames import MAX_FRAME_BYTES, check_size, parse_inbound

logger = logging.getLogger(__name__)

# End-to-end heartbeat (M7.3). The parameter names predate the frame change
# (``ping_interval`` / ``pong_timeout`` drive the ``hb`` beat) and are kept so
# existing callers and tests keep working. ``ping_interval=None`` disables it.
PING_INTERVAL_S = 15.0
PONG_TIMEOUT_S = 10.0
HB_MAX_MISSED = 2
# A missed beat is retried almost immediately rather than waiting a full
# interval: two misses should cost seconds, not minutes.
HB_RETRY_DELAY_S = 2.0
# WebSocket-level keepalive (protocol pings), so a half-open tunnel is noticed
# by the transport itself instead of by the app-level pong.
WS_PING_INTERVAL_S = 20.0
WS_PING_TIMEOUT_S = 20.0
# One stuck ``ws.send()`` must not wedge every sender.
SEND_TIMEOUT_S = 10.0
# Cancelling the losing phase tasks must never hang the loop.
PHASE_CLEANUP_TIMEOUT_S = 5.0
SUPERVISOR_RESTART_DELAY_S = 1.0
BACKOFF_INITIAL_S = 1.0
BACKOFF_MAX_S = 30.0
QUEUE_MAXSIZE = 1000
# The relay closes a superseded agent socket with this code, reason
# "replaced by new agent connection" (see protocol/frames.md). Such a client
# must never reconnect: the newer instance owns the single agent slot.
REPLACED_CLOSE_CODE = 4000

FrameCallback = Optional[Callable[[dict], Any]]


def _task_detail(task: "asyncio.Task") -> str:
    """Exception repr of a finished phase task ("" when it ended cleanly)."""
    if task.cancelled():
        return "cancelled"
    try:
        exc = task.exception()
    except asyncio.CancelledError:  # pragma: no cover - raced with a cancel
        return "cancelled"
    return "" if exc is None else repr(exc)


def _encode(frame: dict) -> str:
    """Serialize a frame exactly as ``frames.check_size`` measures it."""
    return json.dumps(frame, ensure_ascii=False, separators=(",", ":"))


class RelayClient:
    """Maintain one outbound WebSocket to the relay.

    ``on_frame`` is called for every inbound business frame (``pong``,
    ``ping`` and ``hb_ack`` are handled locally). It may be a plain function or
    a coroutine function; exceptions in it are logged and never kill the
    connection.
    """

    def __init__(
        self,
        relay_url: str,
        token: str,
        agent_id: str = "default",
        on_frame: FrameCallback = None,
        *,
        instance: Optional[str] = None,
        ping_interval: Optional[float] = PING_INTERVAL_S,
        pong_timeout: float = PONG_TIMEOUT_S,
        hb_max_missed: int = HB_MAX_MISSED,
        queue_maxsize: int = QUEUE_MAXSIZE,
        ws_ping_interval: float = WS_PING_INTERVAL_S,
        ws_ping_timeout: float = WS_PING_TIMEOUT_S,
        send_timeout: float = SEND_TIMEOUT_S,
        file_log: Optional[FileLog] = None,
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
        self.hb_max_missed = max(1, int(hb_max_missed))
        self.ws_ping_interval = ws_ping_interval
        self.ws_ping_timeout = ws_ping_timeout
        self.send_timeout = send_timeout
        self._flog = file_log

        self._queue: asyncio.Queue = asyncio.Queue(maxsize=queue_maxsize)
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None
        self._close_code: Optional[int] = None
        self._tx_lock = asyncio.Lock()
        self._pong = asyncio.Event()
        # End-to-end heartbeat state; reset on every connect.
        self._hb_counter = 0
        self._hb_missed = 0
        self._hb_outstanding: Optional[str] = None
        self._hb_ack = asyncio.Event()
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
            self._supervise(),
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
        self._log_event("stopped", agent=self.agent_id)

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

    async def _supervise(self) -> None:
        """Keep ``_run`` alive: any non-fatal exit restarts it (M7.2).

        A 4000 close and an auth rejection set ``_fatal``, and ``stop()`` sets
        ``_closed``; those end the supervisor for good. Everything else --
        including a plain return -- is treated as a crashed run loop.
        """
        while not self._closed:
            returned = False
            try:
                await self._run()
                returned = True
            except asyncio.CancelledError:
                raise
            except BaseException as exc:  # noqa: BLE001 - never die silently
                logger.error(
                    "relay: connection loop crashed: %r", exc, exc_info=True,
                )
                self._log_event("loop_exit", reason=repr(exc))
            if self._closed or self._fatal:
                break
            if returned:
                logger.warning(
                    "relay: connection loop returned unexpectedly; restarting",
                )
                self._log_event("loop_exit", reason="returned")
            logger.info(
                "relay: restarting connection loop in %.0fs",
                SUPERVISOR_RESTART_DELAY_S,
            )
            self._log_event(
                "supervisor_restart", delay=SUPERVISOR_RESTART_DELAY_S,
            )
            await asyncio.sleep(SUPERVISOR_RESTART_DELAY_S)

    async def _run(self) -> None:
        while not self._closed and not self._fatal:
            ws = None
            try:
                ws = await self._connect()
                self._close_code = None
                self._ws = ws
                self._connected = True
                self._backoff = BACKOFF_INITIAL_S
                # A new connection starts a new heartbeat conversation: the
                # old ids mean nothing to this socket, and stale misses would
                # kill the phase before the first beat.
                self._hb_counter = 0
                self._hb_missed = 0
                self._hb_outstanding = None
                self._hb_ack.clear()
                logger.info(
                    "relay: connected %s as agent=%s",
                    self.relay_url,
                    self.agent_id,
                )
                self._log_event(
                    "connect",
                    url=self.relay_url,
                    session=self.session,
                    started=self.started_us,
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
                self._log_event(
                    "hello", session=self.session, agent=self.agent_id,
                )
                phase = (
                    (
                        "reader",
                        asyncio.create_task(
                            self._reader(ws), name="webchannel-relay-reader",
                        ),
                    ),
                    (
                        "writer",
                        asyncio.create_task(
                            self._writer(ws), name="webchannel-relay-writer",
                        ),
                    ),
                    (
                        "heartbeat",
                        asyncio.create_task(
                            self._heartbeat(ws), name="webchannel-relay-heartbeat",
                        ),
                    ),
                )
                try:
                    done, _pending = await asyncio.wait(
                        {task for _name, task in phase},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                except asyncio.CancelledError:
                    await self._cancel_phase_tasks(
                        [task for _name, task in phase],
                    )
                    raise
                ended_name, ended_task = next(
                    (name, task) for name, task in phase if task in done
                )
                detail = _task_detail(ended_task)
                logger.info(
                    "relay: connection phase ended by %s%s",
                    ended_name,
                    (": " + detail) if detail else "",
                )
                self._log_event(
                    "phase_end", task=ended_name, detail=detail,
                )
                # Whichever task ended the phase, the whole connection is
                # dead: nothing may keep running against this socket.
                await self._cancel_phase_tasks(
                    [task for _name, task in phase if task is not ended_task],
                )
                self._log_event("close", code=self._close_code)
                if self._close_code == REPLACED_CLOSE_CODE and not self._closed:
                    self._fatal = True
                    logger.error(
                        "relay: superseded by a newer instance (close 4000); "
                        "not reconnecting"
                    )
                    self._log_event("fatal", reason="close 4000")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect on any failure
                if self._is_auth_error(exc):
                    self._fatal = True
                    logger.error(
                        "relay: authentication rejected (%s); not reconnecting",
                        exc,
                    )
                    self._log_event("fatal", reason=repr(exc))
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
            self._log_event("reconnect", delay=delay)
            await asyncio.sleep(delay)

    async def _cancel_phase_tasks(self, tasks) -> None:
        """Cancel and drain *tasks*; cleanup must never hang the loop."""
        pending = [task for task in tasks if not task.done()]
        for task in pending:
            task.cancel()
        if not pending:
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(*pending, return_exceptions=True),
                timeout=PHASE_CLEANUP_TIMEOUT_S,
            )
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:  # pragma: no cover - stuck task
            logger.warning("relay: phase cleanup timed out")
        except Exception:  # pragma: no cover - cleanup is best effort
            logger.debug("relay: phase cleanup failed", exc_info=True)

    def _log_event(self, event: str, **fields) -> None:
        """Mirror one lifecycle event to the file log; never raises."""
        flog = self._flog
        if flog is None:
            return
        try:
            flog.write(event, **fields)
        except Exception:  # noqa: BLE001 - logging must never raise
            pass

    async def _connect(self):
        headers = {"Authorization": f"Bearer {self.token}"}
        kwargs = {
            "additional_headers": headers,
            "max_size": MAX_FRAME_BYTES,
            "open_timeout": 10,
            "close_timeout": 5,
            # Transport-level keepalive: notices a half-open tunnel even when
            # the app-level reader is parked inside a frame callback.
            "ping_interval": self.ws_ping_interval,
            "ping_timeout": self.ws_ping_timeout,
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
            if kind == "hb_ack":
                # M7.3: consumed here, never dispatched. Only the ack of the
                # currently outstanding beat counts; a late/duplicate ack for
                # an older id must not mask a dead tunnel.
                if isinstance(frame.get("id"), str) and frame.get("id") == self._hb_outstanding:
                    self._hb_ack.set()
                continue
            if kind == "error" and frame.get("code") == "E_AUTH":
                self._fatal = True
                logger.error("relay: E_AUTH received; stopping reconnect loop")
                self._log_event("fatal", reason="E_AUTH")
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
            except Exception as exc:
                # The close may land in ``ws.send()`` before the reader sees
                # it; without recording the code here a superseded socket
                # would be mistaken for a transient failure.
                self._note_close_code(exc)
                self._requeue(frame)
                raise
            finally:
                self._queue.task_done()

    async def _heartbeat(self, ws) -> None:
        """End-to-end beat (M7.3): ``hb`` out, matching ``hb_ack`` back.

        An ack can only be produced by the relay process itself, so a silent
        tunnel (edge-answered pings, no RST) fails here in bounded time. Two
        consecutive misses close the socket, which ends the phase exactly like
        any other phase end and lets the run loop reconnect with backoff.
        """
        if self.ping_interval is None or self.ping_interval <= 0:
            # Disabled (tests / control runs): park until the phase ends.
            await asyncio.Event().wait()
            return
        # Delay before the next beat: a full interval after a success, but
        # only the short retry delay after a miss (a `continue` to the loop
        # top would otherwise re-impose the full interval on every retry).
        delay = self.ping_interval
        while True:
            await asyncio.sleep(delay)
            delay = self.ping_interval
            self._hb_counter += 1
            hb_id = "hb-%d" % self._hb_counter
            self._hb_outstanding = hb_id
            self._hb_ack.clear()
            try:
                await self._send_direct(ws, {"t": "hb", "id": hb_id})
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - socket died; reader may follow
                logger.debug("relay: hb send failed", exc_info=True)
                self._note_close_code(exc)
                await ws.close()
                return
            try:
                await asyncio.wait_for(
                    self._hb_ack.wait(),
                    timeout=self.pong_timeout,
                )
            except asyncio.TimeoutError:
                self._hb_missed += 1
                logger.warning(
                    "relay: hb %s not acked (%d/%d missed)",
                    hb_id,
                    self._hb_missed,
                    self.hb_max_missed,
                )
                self._log_event(
                    "hb_miss", id=hb_id, missed=self._hb_missed,
                )
                if self._hb_missed >= self.hb_max_missed:
                    logger.warning(
                        "relay: tunnel is dead after %d missed heartbeats; "
                        "reconnecting",
                        self._hb_missed,
                    )
                    await ws.close()
                    return
                await asyncio.sleep(HB_RETRY_DELAY_S)
                continue
            except asyncio.CancelledError:
                raise
            self._hb_missed = 0
            self._hb_outstanding = None

    async def _send_direct(self, ws, frame: dict) -> None:
        """Send one frame, time-bounded (a stuck socket is a dead socket)."""
        text = _encode(frame)
        async with self._tx_lock:
            await asyncio.wait_for(ws.send(text), timeout=self.send_timeout)

    def _note_close_code(self, exc: BaseException) -> None:
        """Best-effort close-code capture for a sender that saw the socket die.

        Only ``_reader`` used to record it, so a 4000 that first surfaced in
        ``ws.send()`` looked transient and the superseded client reconnected.
        """
        if self._close_code is not None:
            return
        if isinstance(exc, websockets.ConnectionClosed):
            self._close_code = exc.code
            return
        code = getattr(exc, "code", None)
        if code is not None:
            self._close_code = code

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
