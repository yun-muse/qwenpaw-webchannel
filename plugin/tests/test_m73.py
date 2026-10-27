#!/usr/bin/env python3
"""Standalone tests for M7.3: the end-to-end ``hb`` / ``hb_ack`` heartbeat.

The hosted incident this pins down: the relay's ``/health`` kept saying
``agentOnline: true`` and both the app-level ``ping`` and WebSocket-level pings
kept being answered, yet no business frame could pass in either direction and
the plugin never noticed. Pings are answered *at the edge* (Cloudflare's
``setWebSocketAutoResponse`` and its WebSocket front end), so only a frame the
relay process itself must answer can prove the agent <-> relay path is alive.

Scenarios:

  A  silent blackhole: relay answers ``ping`` with ``pong`` and answers WS
     pings, but never acks ``hb`` and never forwards. The fixed client must
     reconnect; the same client with the heartbeat disabled must not.
  B  healthy: ``hb_ack`` echoes the id and business frames round-trip in both
     directions; the client stays on its first connection.
  C  close 4000 after hello is still fatal: no reconnect, ever.
  D  an ``hb_ack`` with the wrong id does not count: the misses accumulate and
     the client reconnects anyway (and logs ``hb_miss``).

The relay is an in-process ``websockets`` server on an ephemeral 127.0.0.1
port, mirroring ``test_m72.py``: the real connect / hello / reader / heartbeat
/ backoff path runs without any qwenpaw imports.

Run either way (no pytest required; needs websockets):

    cd plugin && python3 tests/test_m73.py
    cd plugin && python3 -m pytest tests/test_m73.py -q
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

_SLOW_HB_S = 30.0  # the beat must not fire unless a test wants it
_FAST_HB_S = 0.3  # beat cadence for the blackhole / wrong-id scenarios
_HB_TIMEOUT_S = 0.3  # ack window for the blackhole / wrong-id scenarios
_RECOVER_DEADLINE_S = 8.0  # 2 misses + retry + backoff is ~4 s
_HEALTHY_HOLD_S = 2.5  # several healthy beats must not churn the connection
_FATAL_DEADLINE_S = 6.0
_GRACE_AFTER_FATAL_S = 2.5  # > one 1 s backoff cycle
_DEAD_ACK_WAIT_S = 0.6


# --------------------------------------------------------------------------
# Fake relay
# --------------------------------------------------------------------------

class _State:
    """Behaviour knobs plus counters for one in-process relay."""

    def __init__(self, ack_hb=True, ack_id="echo", forward=True, close_code=None):
        self.ack_hb = ack_hb
        self.ack_id = ack_id  # "echo" or a fixed (wrong) id
        self.forward = forward
        self.close_code = close_code
        self.connections = 0
        self.hellos = []
        self.hb_seen = []
        self.business_seen = []

    @property
    def beats(self):
        return len(self.hb_seen)


def _parse(raw):
    if isinstance(raw, (bytes, bytearray)):
        return None
    try:
        frame = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return frame if isinstance(frame, dict) else None


def _handler(state):
    async def handler(ws, *_ignored):
        state.connections += 1
        try:
            async for raw in ws:
                frame = _parse(raw)
                if frame is None:
                    continue
                kind = frame.get("t")
                if kind == "hello":
                    state.hellos.append(frame)
                    if state.close_code is not None:
                        await ws.close(code=state.close_code, reason="test")
                        return
                    continue
                if kind == "ping":
                    # The masking that started all this: answered forever,
                    # even when nothing else can pass.
                    await ws.send(json.dumps({"t": "pong"}))
                    continue
                if kind == "hb":
                    state.hb_seen.append(frame.get("id"))
                    if state.ack_hb:
                        ack = frame.get("id") if state.ack_id == "echo" else state.ack_id
                        await ws.send(json.dumps({"t": "hb_ack", "id": ack}))
                    continue
                state.business_seen.append(frame)
                if state.forward:
                    await ws.send(
                        json.dumps({"t": "msg", "chat": "c1", "text": "echo"}),
                    )
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001 - a dead peer ends the handler
            pass

    return handler


def _url_of(server):
    port = server.sockets[0].getsockname()[1]
    return "ws://127.0.0.1:%d/agent" % port


async def _wait_until(predicate, timeout, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return bool(predicate())


def _events_of(path):
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


def _fast_client(url, **kwargs):
    """A client whose beat is fast enough to fit a test, with WS pings off.

    WS-level keepalive is disabled on purpose: in the blackhole scenario the
    *only* thing that can notice the death is ``hb``.
    """
    kwargs.setdefault("ping_interval", _FAST_HB_S)
    kwargs.setdefault("pong_timeout", _HB_TIMEOUT_S)
    kwargs.setdefault("hb_max_missed", 2)
    kwargs.setdefault("ws_ping_interval", None)
    kwargs.setdefault("ws_ping_timeout", None)
    return RelayClient(url, "tok", agent_id="default", **kwargs)


# --------------------------------------------------------------------------
# A: silent blackhole -> hb misses force a reconnect; disabled beat -> never
# --------------------------------------------------------------------------

async def _scenario_blackhole_recovers():
    state = _State(ack_hb=False, forward=False)

    async with websockets.serve(_handler(state), "127.0.0.1", 0) as server:
        client = _fast_client(_url_of(server))
        await client.start()
        try:
            assert await _wait_until(
                lambda: len(state.hellos) >= 2, _RECOVER_DEADLINE_S,
            ), "client did not reconnect from a relay that never acks hb"
            assert state.beats >= 2, (
                "client reconnected without sending two beats: %r" % (state.hb_seen,)
            )
            assert await _wait_until(lambda: client.connected, 2.0), (
                "client reconnected but does not report connected"
            )
            assert state.hellos[0]["session"] == state.hellos[1]["session"], state.hellos
        finally:
            await client.stop()


async def _scenario_blackhole_control():
    """Heartbeat disabled: pings are answered, so nothing notices the death."""
    state = _State(ack_hb=False, forward=False)

    async with websockets.serve(_handler(state), "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=None,
            ws_ping_interval=None,
            ws_ping_timeout=None,
        )
        await client.start()
        try:
            # As long as the fixed client is given to notice, the disabled one
            # must notice nothing (the relay is alive and pings are answered).
            await asyncio.sleep(_RECOVER_DEADLINE_S)
            assert state.connections == 1, (
                "heartbeat-disabled client reconnected (%d connections)" % state.connections
            )
            assert len(state.hellos) == 1, state.hellos
            assert state.beats == 0, state.hb_seen
            assert client.connected is True
        finally:
            await client.stop()


async def _check_ping_is_masked():
    """Prove the mechanism: a ping is answered, an hb is not."""
    state = _State(ack_hb=False, forward=False)

    async with websockets.serve(_handler(state), "127.0.0.1", 0) as server:
        async with websockets.connect(
            _url_of(server), ping_interval=None,
        ) as probe:
            await probe.send(json.dumps({"t": "ping"}))
            reply = json.loads(await asyncio.wait_for(probe.recv(), 2.0))
            assert reply.get("t") == "pong", reply

            await probe.send(json.dumps({"t": "hb", "id": "probe-1"}))
            try:
                await asyncio.wait_for(probe.recv(), _DEAD_ACK_WAIT_S)
            except asyncio.TimeoutError:
                pass
            else:
                raise AssertionError("blackhole relay acked hb; scenario is wrong")


# --------------------------------------------------------------------------
# B: healthy relay -> acks + forwarding, no reconnect churn
# --------------------------------------------------------------------------

async def _scenario_healthy():
    state = _State()
    delivered = asyncio.Event()
    frames = []

    async def on_frame(frame):
        frames.append(frame)
        if frame.get("t") == "msg":
            delivered.set()

    async with websockets.serve(_handler(state), "127.0.0.1", 0) as server:
        client = _fast_client(
            _url_of(server),
            ping_interval=0.2,
            pong_timeout=1.0,
            on_frame=on_frame,
        )
        await client.start()
        try:
            assert await _wait_until(lambda: len(state.hellos) == 1, 5.0), "no hello"
            assert await _wait_until(lambda: state.beats >= 3, 5.0), (
                "relay never saw three hb beats: %r" % (state.hb_seen,)
            )

            await client.send({"t": "msg", "chat": "c1", "text": "hi"})
            assert await _wait_until(
                lambda: state.business_seen, 5.0,
            ), "client frame never reached the relay"
            assert await _wait_until(delivered.is_set, 5.0), (
                "relay frame never reached on_frame"
            )

            await asyncio.sleep(_HEALTHY_HOLD_S)
            assert state.connections == 1, (
                "healthy relay caused a reconnect (%d connections)" % state.connections
            )
            assert len(state.hellos) == 1, state.hellos
            assert not [f for f in frames if f.get("t") == "hb_ack"], (
                "hb_ack leaked into on_frame: %r" % (frames,)
            )
            assert client.connected is True
        finally:
            await client.stop()


# --------------------------------------------------------------------------
# C: close 4000 is still fatal
# --------------------------------------------------------------------------

async def _scenario_4000_fatal():
    state = _State(close_code=REPLACED_CLOSE_CODE)

    async with websockets.serve(_handler(state), "127.0.0.1", 0) as server:
        client = RelayClient(
            _url_of(server),
            "tok",
            agent_id="default",
            ping_interval=_SLOW_HB_S,
            ws_ping_interval=None,
            ws_ping_timeout=None,
        )
        await client.start()
        task = client._task
        try:
            assert await _wait_until(task.done, _FATAL_DEADLINE_S), (
                "run task still alive after close 4000 (it would reconnect)"
            )
            assert client._close_code == REPLACED_CLOSE_CODE, client._close_code
            await asyncio.sleep(_GRACE_AFTER_FATAL_S)
            assert state.connections == 1, (
                "client reconnected after being superseded (%d connections)"
                % state.connections
            )
            assert len(state.hellos) == 1, state.hellos
            assert client.connected is False
        finally:
            await client.stop()


# --------------------------------------------------------------------------
# D: a wrong-id hb_ack does not count
# --------------------------------------------------------------------------

async def _scenario_wrong_id_ack():
    state = _State(ack_hb=True, ack_id="hb-wrong", forward=False)

    with tempfile.TemporaryDirectory(prefix="wc-m73-") as tmp:
        path = Path(tmp) / "webchannel.log"

        async with websockets.serve(_handler(state), "127.0.0.1", 0) as server:
            client = _fast_client(_url_of(server), file_log=FileLog(path))
            await client.start()
            try:
                assert await _wait_until(
                    lambda: len(state.hellos) >= 2, _RECOVER_DEADLINE_S,
                ), "a wrong-id hb_ack masked the dead tunnel"
                assert state.beats >= 2, state.hb_seen
            finally:
                await client.stop()

        events = _events_of(path)
        assert "hb_miss" in events, sorted(events)
        assert "phase_end" in events, sorted(events)


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------

async def main_async():
    print("  A: silent blackhole must be reconnected by hb misses")
    await _scenario_blackhole_recovers()
    print("  A': heartbeat disabled must stay on its first connection")
    await _scenario_blackhole_control()
    print("  A'': a ping is answered where an hb is not (the masking itself)")
    await _check_ping_is_masked()
    print("  B: a healthy relay must not cause reconnects")
    await _scenario_healthy()
    print("  C: close 4000 must still be fatal")
    await _scenario_4000_fatal()
    print("  D: a wrong-id hb_ack must not count")
    await _scenario_wrong_id_ack()


def test_end_to_end_heartbeat():
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
