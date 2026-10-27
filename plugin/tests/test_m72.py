#!/usr/bin/env python3
"""Standalone tests for M7.2: RelayClient self-healing + the plugin file log.

A half-open relay tunnel used to park the plugin forever: the reader awaited
the frame callback inline, so the reconnect branch was unreachable, and a dead
writer or a stuck ``ws.send()`` were equally invisible. These scenarios pin
the fixes: a destroyed transport, a silent peer (WebSocket-level keepalive), a
parked frame callback (app-level heartbeat), a crashed run loop (supervisor)
and the new ``FileLog``.

The relay is an in-process ``websockets`` server bound to 127.0.0.1 on an
ephemeral port, so the real connect / hello / reader / backoff path is
exercised without any qwenpaw imports.

Run either way (no pytest required; needs websockets):

    cd plugin && python3 tests/test_m72.py
    cd plugin && python3 -m pytest tests/test_m72.py -q
"""

import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import websockets  # noqa: E402  (path setup must run first)
from websockets.exceptions import ConnectionClosed  # noqa: E402

from filelog import FileLog  # noqa: E402
from relay_client import REPLACED_CLOSE_CODE, RelayClient  # noqa: E402

_PING_S = 30.0  # the app-level heartbeat must not fire unless a test wants it
_HALF_OPEN_S = 0.3  # app-level heartbeat cadence for scenario C
_DESTROY_DEADLINE_S = 8.0
_SILENCE_DEADLINE_S = 8.0
_PARKED_DEADLINE_S = 10.0
_SUPERVISOR_DEADLINE_S = 8.0
_FILELOG_DEADLINE_S = 8.0
_WRITER_CLOSE_DEADLINE_S = 8.0
_GRACE_AFTER_FATAL_S = 2.5  # > one 1 s backoff cycle
_BACKLOG_FRAMES = 12
_BACKLOG_TEXT = "x" * 200000  # per-frame payload, still under MAX_FRAME_BYTES
_SILENCE_HOLD_S = 4.0  # how long the paused server socket is kept open


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

async def _wait_until(predicate, timeout, interval=0.05):
    """Poll ``predicate`` until true or ``timeout`` elapsed; return the result."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return bool(predicate())


def _url_of(server):
    port = server.sockets[0].getsockname()[1]
    return "ws://127.0.0.1:%d/agent" % port


async def _drain(ws):
    """Read and ignore inbound frames until the peer goes away."""
    try:
        async for _message in ws:
            pass
    except ConnectionClosed:
        pass


def _events_of(path):
    """Event names found in a FileLog file (third space-separated column)."""
    events = set()
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return events
    for line in text.splitlines():
        parts = line.split(" ")
        if len(parts) >= 3:
            events.add(parts[2])
    return events


# --------------------------------------------------------------------------
# A: destroyed transport (no close frame) -> reconnect
# --------------------------------------------------------------------------

async def _scenario_destroy():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        hellos.append(json.loads(await ws.recv()))
        if connections == 1:
            # Hard drop: the peer never sees a close frame, like a tunnel
            # that died half-open.
            ws.transport.abort()
            return
        await _drain(ws)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_PING_S,
        )
        await client.start()
        try:
            assert await _wait_until(
                lambda: len(hellos) >= 2, _DESTROY_DEADLINE_S,
            ), "client did not reconnect after the transport was destroyed"
            assert await _wait_until(lambda: client.connected, 2.0), (
                "client reconnected but does not report connected"
            )
            assert connections >= 2, connections
            assert hellos[0]["session"] == hellos[1]["session"], hellos
        finally:
            await client.stop()

    assert client.connected is False


# --------------------------------------------------------------------------
# B: silent peer (reading paused) -> WebSocket keepalive fails the socket
# --------------------------------------------------------------------------

async def _scenario_silence():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        order = connections
        hellos.append(json.loads(await ws.recv()))
        if order == 1:
            # Stop reading: pongs (and everything else) pile up unread, so the
            # client's keepalive must notice the dead tunnel by itself.
            ws.transport.pause_reading()
            await asyncio.sleep(_SILENCE_HOLD_S)
            # Returning would wait out the close handshake unread; abort.
            ws.transport.abort()
            return
        await _drain(ws)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_PING_S,
            ws_ping_interval=_HALF_OPEN_S,
            ws_ping_timeout=_HALF_OPEN_S,
        )
        await client.start()
        try:
            assert await _wait_until(
                lambda: len(hellos) >= 2, _SILENCE_DEADLINE_S,
            ), "client did not reconnect from a silent socket"
            assert hellos[0]["session"] == hellos[1]["session"], hellos
        finally:
            await client.stop()


# --------------------------------------------------------------------------
# C: parked frame callback -> the heartbeat ends the phase and cancels it
# --------------------------------------------------------------------------

async def _scenario_parked_dispatch():
    connections = 0
    hellos = []
    cancelled = asyncio.Event()

    async def on_frame(frame):
        if frame.get("t") != "msg":
            return
        # The M7.2 bug: this callback never returns, and the old reader
        # awaited it inline, so no reconnect could ever happen.
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        hellos.append(json.loads(await ws.recv()))
        if connections == 1:
            await ws.send(json.dumps({"t": "msg", "chat": "c1", "text": "hi"}))
        # Answer nothing: the app-level ping must time out.
        await _drain(ws)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_HALF_OPEN_S,
            pong_timeout=_HALF_OPEN_S,
            on_frame=on_frame,
        )
        await client.start()
        try:
            assert await _wait_until(
                lambda: len(hellos) >= 2, _PARKED_DEADLINE_S,
            ), "heartbeat did not recover from a parked frame callback"
            assert cancelled.is_set(), "parked callback coroutine was not cancelled"
            assert await _wait_until(lambda: client.connected, 2.0), (
                "client did not report connected after the parked callback"
            )
            assert hellos[0]["session"] == hellos[1]["session"], hellos
        finally:
            await client.stop()


# --------------------------------------------------------------------------
# D: crashed run loop -> the supervisor restarts it
# --------------------------------------------------------------------------

class _Boom(BaseException):
    """A failure ``_run`` itself cannot catch (it only catches Exception)."""


class _FlakyClient(RelayClient):
    """Explode on the first ``_connect``, behave afterwards."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.connect_calls = 0

    async def _connect(self):
        self.connect_calls += 1
        if self.connect_calls == 1:
            raise _Boom("first connect explodes")
        return await super()._connect()


async def _scenario_supervisor():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        hellos.append(json.loads(await ws.recv()))
        await _drain(ws)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = _FlakyClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_PING_S,
        )
        await client.start()
        try:
            assert await _wait_until(
                lambda: len(hellos) >= 1, _SUPERVISOR_DEADLINE_S,
            ), "supervisor did not restart the run loop after it crashed"
            assert client.connect_calls >= 2, client.connect_calls
            assert await _wait_until(lambda: client.connected, 2.0), (
                "supervisor restarted the loop but the client is not connected"
            )
        finally:
            await client.stop()


# --------------------------------------------------------------------------
# E: file log events + FileLog rotation / hostile paths
# --------------------------------------------------------------------------

async def _scenario_file_log():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        order = connections
        hellos.append(json.loads(await ws.recv()))
        if order == 1:
            await ws.close(code=1011, reason="transient failure")
            return
        await _drain(ws)

    with tempfile.TemporaryDirectory(prefix="wc-m72-") as tmp:
        path = Path(tmp) / "webchannel.log"

        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            client = RelayClient(
                _url_of(server),
                "tok",
                agent_id="default",
                ping_interval=_PING_S,
                file_log=FileLog(path),
            )
            await client.start()
            try:
                assert await _wait_until(
                    lambda: len(hellos) >= 2, _FILELOG_DEADLINE_S,
                ), "client did not reconnect after close 1011"
            finally:
                await client.stop()

        assert path.is_file(), "no file log was written at %s" % path
        events = _events_of(path)
        for name in ("connect", "hello", "close", "reconnect", "stopped"):
            assert name in events, (name, sorted(events))


def _check_rotation():
    """A tiny ``max_bytes`` keeps the whole file set bounded."""
    with tempfile.TemporaryDirectory(prefix="wc-m72-rot-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path, max_bytes=2048, backups=2)
        for index in range(200):
            flog.write("tick", i=index, pad="x" * 64)
        files = sorted(Path(tmp).iterdir())
        assert len(files) >= 2, "nothing was rotated: %r" % (files,)
        total = sum(item.stat().st_size for item in files)
        assert total <= 2048 * 3 + 4096, total


def _check_directory_path():
    """A FileLog pointed at a directory must never raise."""
    with tempfile.TemporaryDirectory(prefix="wc-m72-dir-") as tmp:
        flog = FileLog(Path(tmp), max_bytes=1024, backups=2)
        flog.write("tick", value="x")


# --------------------------------------------------------------------------
# G: a 4000 noticed by the writer first is still fatal
# --------------------------------------------------------------------------

async def _scenario_writer_close():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        hellos.append(json.loads(await ws.recv()))
        # Let the writer get deep into the backlog, then supersede the agent
        # socket while ws.send() is still in flight.
        await asyncio.sleep(0.1)
        await ws.close(code=REPLACED_CLOSE_CODE, reason="replaced by new agent")

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_PING_S,
        )
        # Queued before start(): the writer is mid-flush when the close lands,
        # so the close may be noticed by the writer before the reader.
        for _ in range(_BACKLOG_FRAMES):
            await client.send({"t": "msg", "chat": "g", "text": _BACKLOG_TEXT})
        await client.start()
        task = client._task
        try:
            finished = await _wait_until(task.done, _WRITER_CLOSE_DEADLINE_S)
            assert finished, "run task still alive after close 4000 (would reconnect)"
            assert client.connected is False
            assert client._close_code == REPLACED_CLOSE_CODE, client._close_code

            assert connections == 1, connections
            assert len(hellos) == 1, hellos
            # Longer than the first backoff: a wrongful reconnect would show.
            await asyncio.sleep(_GRACE_AFTER_FATAL_S)
            assert connections == 1, "client reconnected after being superseded"
            assert len(hellos) == 1, hellos
        finally:
            await client.stop()

    assert client.connected is False


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------

async def main_async():
    """Run every scenario in one event loop, in order."""
    print("  A: destroyed transport must be reconnected")
    await _scenario_destroy()
    print("  B: silent socket must fail the WebSocket keepalive")
    await _scenario_silence()
    print("  C: parked frame callback must not park the reconnect loop")
    await _scenario_parked_dispatch()
    print("  D: a crashed run loop must be restarted by the supervisor")
    await _scenario_supervisor()
    print("  E: lifecycle events must reach the plugin file log")
    await _scenario_file_log()
    print("  F: FileLog must rotate and never raise")
    _check_rotation()
    _check_directory_path()
    print("  G: a 4000 noticed by the writer first is still fatal")
    await _scenario_writer_close()


def test_self_healing():
    asyncio.run(main_async())


def main():
    tests = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    failures = 0
    for name, test in tests:
        try:
            test()
        except Exception as exc:  # noqa: BLE001 - report and continue
            failures += 1
            print("FAIL %s: %s: %s" % (name, type(exc).__name__, exc))
        else:
            print("ok   %s" % name)
    if failures:
        print("%d test(s) failed" % failures)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
