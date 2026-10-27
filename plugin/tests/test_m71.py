#!/usr/bin/env python3
"""Standalone tests for M7.1: RelayClient superseded-instance semantics.

When QwenPaw hot-reloads an agent workspace, the relay closes the previous
agent socket with close code 4000 ("replaced by new agent connection"). The
superseded ``RelayClient`` must treat that as fatal and never reconnect,
while a transient close (1011) must keep reconnecting with the usual backoff
and reuse the same ``session`` id.

The relay is an in-process ``websockets`` server bound to 127.0.0.1 on an
ephemeral port, so the real connect / hello / reader / backoff path is
exercised without any qwenpaw imports.

Run either way (no pytest required; needs websockets):

    cd plugin && python3 tests/test_m71.py
    cd plugin && python3 -m pytest tests/test_m71.py -q
"""

import asyncio
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import websockets  # noqa: E402  (path setup must run first)
from websockets.exceptions import ConnectionClosed  # noqa: E402

from relay_client import REPLACED_CLOSE_CODE, RelayClient  # noqa: E402

_REPLACED_REASON = "replaced by new agent connection"
_TRANSIENT_CODE = 1011
_SUPERSEDED_DEADLINE_S = 5.0
_RECONNECT_DEADLINE_S = 6.0
_GRACE_AFTER_FATAL_S = 2.5  # > one 1 s backoff cycle
_PING_S = 30.0  # the app-level heartbeat must not fire during these tests


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


# --------------------------------------------------------------------------
# A: close 4000 (superseded) -> no reconnect
# --------------------------------------------------------------------------

async def _scenario_superseded():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        raw = await ws.recv()
        hellos.append(json.loads(raw))
        # Exactly what the relay does to the old agent socket.
        await ws.close(code=REPLACED_CLOSE_CODE, reason=_REPLACED_REASON)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_PING_S,
        )
        await client.start()
        task = client._task

        finished = await _wait_until(task.done, _SUPERSEDED_DEADLINE_S)
        assert finished, "run task still alive after close 4000 (would reconnect)"
        assert client.connected is False
        assert client._close_code == REPLACED_CLOSE_CODE

        assert connections == 1, connections
        assert len(hellos) == 1, hellos
        hello = hellos[0]
        assert hello.get("t") == "hello", hello
        assert hello.get("agent") == "default", hello
        assert isinstance(hello.get("session"), str) and hello["session"], hello
        assert isinstance(hello.get("started"), int) and hello["started"] > 0, hello

        # Longer than the first backoff: a wrongful reconnect would be visible.
        await asyncio.sleep(_GRACE_AFTER_FATAL_S)
        assert connections == 1, "client reconnected after being superseded"
        assert len(hellos) == 1, hellos

        await client.stop()
        assert task.done()


# --------------------------------------------------------------------------
# B: close 1011 (transient) -> reconnect with the same session
# --------------------------------------------------------------------------

async def _scenario_transient():
    connections = 0
    hellos = []

    async def handler(ws, *_ignored):
        nonlocal connections
        connections += 1
        order = connections
        hellos.append(json.loads(await ws.recv()))
        if order == 1:
            await ws.close(code=_TRANSIENT_CODE, reason="transient failure")
            return
        try:
            async for _message in ws:
                pass
        except ConnectionClosed:
            pass

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_PING_S,
        )
        await client.start()
        task = client._task

        reconnected = await _wait_until(
            lambda: len(hellos) >= 2,
            _RECONNECT_DEADLINE_S,
        )
        assert reconnected, "client did not reconnect after close 1011"
        assert connections == 2, connections
        assert client.connected is True

        first, second = hellos[0], hellos[1]
        assert isinstance(second.get("session"), str) and second["session"], second
        # Same RelayClient instance -> same session/generation across reconnects.
        assert first["session"] == second["session"], (first, second)
        assert first["started"] == second["started"], (first, second)

        await client.stop()
        assert task.done()
        assert client.connected is False


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------

async def main_async():
    """Run both scenarios in one event loop, in order."""
    print("  A: close 4000 (superseded) must not reconnect")
    await _scenario_superseded()
    print("  B: close 1011 (transient) must reconnect with the same session")
    await _scenario_transient()


def test_superseded_instance_semantics():
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
