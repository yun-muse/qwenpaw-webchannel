#!/usr/bin/env python3
"""M7.2 repro harness: does a RelayClient recover from each failure mode?

Runs one ``RelayClient`` implementation against a scripted in-process relay
(``websockets.serve`` on an ephemeral 127.0.0.1 port) and reports, per
scenario, whether a second ``hello`` (i.e. a fresh connection) arrives within
the deadline.  It is meant to be pointed twice at the same scenarios: once at
an extracted pre-M7.2 copy of the client ("before") and once at the fixed
tree ("after").

    python3 tests/repro_m72.py --client-dir <dir> [--scenario all|parked|destroy|silence]
                               [--deadline 20]

``--client-dir`` must contain ``relay_client.py``, ``frames.py`` and
``util.py``.  The directory is put first on ``sys.path`` and the client is
imported top-level, which matches its own
``try: from .frames ... except ImportError: from frames ...`` fallback.

Scenarios
---------
destroy  server reads hello #1, then aborts the TCP transport (no close
         frame).  RECOVERED = hello #2 arrives within the deadline.
silence  server reads hello #1, then pauses reading and holds.  The client
         must notice on its own (app-level pong / WebSocket keepalive).
parked   the client's ``on_frame`` awaits a never-set Event on the first
         business frame; the server stays healthy and keeps reading (so
         protocol pings are still answered).  The connection must still be
         torn down and re-established.

Output is one line per scenario plus ``REPRO_M72 DONE``; the exit status is 0
unless the harness itself crashes (a NOT RECOVERED scenario is evidence, not
an error).

Only stdlib + ``websockets`` are used.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
import types

import websockets

HOST = "127.0.0.1"
SCENARIOS = ("parked", "destroy", "silence")
STOP_TIMEOUT_S = 10.0
PING_S = 0.5
PONG_TIMEOUT_S = 0.5


# ---------------------------------------------------------------------------
# Loading the client under test
# ---------------------------------------------------------------------------

def load_client(client_dir):
    """Import ``RelayClient`` from *client_dir* (inserted first on sys.path)."""
    directory = os.path.abspath(client_dir)
    required = ("relay_client.py", "frames.py", "util.py")
    missing = [name for name in required
               if not os.path.isfile(os.path.join(directory, name))]
    if missing:
        raise SystemExit(
            "repro_m72: --client-dir %s is missing %s"
            % (directory, ", ".join(missing))
        )

    # The client's ``from .frames`` / ``from frames`` fallback only resolves
    # when its own directory wins the top-level import.
    sys.path.insert(0, directory)
    for name in ("relay_client", "frames", "util", "filelog"):
        sys.modules.pop(name, None)

    try:
        import relay_client
    except ModuleNotFoundError as exc:
        # The pre-M7.2 client has no FileLog; its fixed sibling imports one.
        if getattr(exc, "name", None) != "filelog":
            raise
        stub = types.ModuleType("filelog")

        class FileLog:  # minimal stand-in: one implementation, two trees
            def __init__(self, *args, **kwargs):
                pass

            def write(self, *args, **kwargs):
                pass

        stub.FileLog = FileLog
        sys.modules["filelog"] = stub
        import relay_client

    return relay_client.RelayClient


# ---------------------------------------------------------------------------
# Scripted relay
# ---------------------------------------------------------------------------

def _parse(raw):
    if isinstance(raw, (bytes, bytearray)):
        return None
    try:
        frame = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return frame if isinstance(frame, dict) else None


class _State:
    """Per-scenario bookkeeping shared by the handler and the client."""

    def __init__(self):
        self.connections = 0
        self.hellos = 0
        self.second_hello = asyncio.Event()
        self.release = asyncio.Event()
        self.parked_entered = False
        self.parked_cancelled = False

    def note_hello(self):
        self.hellos += 1
        if self.hellos >= 2:
            self.second_hello.set()


async def _consume_hello(ws, state):
    """Read until the client's ``hello`` (the only frame it sends first)."""
    while True:
        frame = _parse(await ws.recv())
        if frame is not None and frame.get("t") == "hello":
            state.note_hello()
            return frame


async def _hold_reading(ws):
    async for _message in ws:
        pass


async def _abort(ws):
    """Destroy the TCP transport without a close frame (half-open tunnel)."""
    transport = getattr(ws, "transport", None)
    abort = getattr(transport, "abort", None)
    if callable(abort):
        abort()
        return
    await ws.close()


def _pause_reading(ws):
    """Stop reading from the socket; the peer sees silence, not a close."""
    transport = getattr(ws, "transport", None)
    pause = getattr(transport, "pause_reading", None)
    if callable(pause):
        pause()


def _make_handler(name, state):
    async def handler(ws, *_ignored):
        state.connections += 1
        order = state.connections
        try:
            if name == "parked":
                await _consume_hello(ws, state)
                if order == 1:
                    await ws.send(
                        json.dumps({"t": "msg", "chat": "c1", "text": "hi"})
                    )
                # Stay healthy: answer protocol pings so only the parked
                # callback can be the reason the connection dies.
                while True:
                    frame = _parse(await ws.recv())
                    if frame is not None and frame.get("t") == "ping":
                        await ws.send(json.dumps({"t": "pong"}))
            elif name == "destroy":
                await _consume_hello(ws, state)
                if order == 1:
                    await _abort(ws)
                    return
                await _hold_reading(ws)
            else:  # silence
                await _consume_hello(ws, state)
                if order == 1:
                    _pause_reading(ws)
                    await state.release.wait()
                    return
                await _hold_reading(ws)
        except asyncio.CancelledError:
            raise
        except Exception:  # a dead peer is the normal end of a handler
            pass

    return handler


def _server_port(server):
    socks = getattr(server, "sockets", None)
    if not socks:
        socks = getattr(getattr(server, "server", None), "sockets", None)
    if not socks:
        raise RuntimeError("cannot determine the in-process relay's port")
    return socks[0].getsockname()[1]


# ---------------------------------------------------------------------------
# Client callbacks
# ---------------------------------------------------------------------------

async def _ignore_frame(_frame):
    return None


def _parked_callback(state):
    async def on_frame(frame):
        if frame.get("t") != "msg":
            return
        state.parked_entered = True
        try:
            await asyncio.Event().wait()  # never set: the callback is parked
        finally:
            state.parked_cancelled = True

    return on_frame


# ---------------------------------------------------------------------------
# Scenario driver
# ---------------------------------------------------------------------------

async def _teardown(client, server, state, baseline_tasks):
    """Stop the client and the server; nothing wedged may outlive a scenario."""
    state.release.set()

    if client is not None:
        try:
            await asyncio.wait_for(client.stop(), timeout=STOP_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    if server is not None:
        try:
            server.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(server.wait_closed(), timeout=STOP_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    current = asyncio.current_task()
    leftovers = [
        task for task in asyncio.all_tasks()
        if task is not current and task not in baseline_tasks and not task.done()
    ]
    for task in leftovers:
        task.cancel()
    if leftovers:
        await asyncio.gather(*leftovers, return_exceptions=True)


async def run_scenario(name, deadline, relay_client_cls, verbose=False):
    """Run one scenario; True when a second hello arrived in time."""
    baseline_tasks = set(asyncio.all_tasks())
    state = _State()
    server = None
    client = None
    on_frame = (
        _parked_callback(state) if name == "parked" else _ignore_frame
    )

    try:
        server = await websockets.serve(
            _make_handler(name, state), HOST, 0, ping_interval=None,
        )
        url = "ws://%s:%d/agent" % (HOST, _server_port(server))
        # The pre-M7.2 client accepts the same ping/pong kwargs; do not pass
        # M7.2-only ones (ws_ping_*, send_timeout, file_log).
        client = relay_client_cls(
            url,
            "tok",
            agent_id="repro",
            ping_interval=PING_S,
            pong_timeout=PONG_TIMEOUT_S,
            on_frame=on_frame,
        )

        started = time.monotonic()
        await client.start()
        try:
            await asyncio.wait_for(state.second_hello.wait(), timeout=deadline)
        except asyncio.TimeoutError:
            print(
                "SCENARIO %s: NOT RECOVERED (no 2nd hello within %gs)"
                % (name, deadline),
                flush=True,
            )
            if verbose:
                print(
                    "NOTE %s: hellos=%d parked_entered=%s parked_cancelled=%s"
                    % (
                        name,
                        state.hellos,
                        state.parked_entered,
                        state.parked_cancelled,
                    ),
                    flush=True,
                )
            return False

        print(
            "SCENARIO %s: RECOVERED in %.1fs"
            % (name, time.monotonic() - started),
            flush=True,
        )
        return True
    finally:
        await _teardown(client, server, state, baseline_tasks)


async def _run_all(names, deadline, relay_client_cls, verbose):
    for name in names:
        await run_scenario(name, deadline, relay_client_cls, verbose=verbose)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="RelayClient kill-and-recover repro (M7.2).",
    )
    parser.add_argument(
        "--client-dir",
        required=True,
        help="directory holding relay_client.py, frames.py and util.py",
    )
    parser.add_argument(
        "--scenario",
        choices=("all",) + SCENARIOS,
        default="all",
        help="scenario to run (default: all)",
    )
    parser.add_argument(
        "--deadline",
        type=float,
        default=20.0,
        help="seconds to wait for the 2nd hello per scenario (default: 20)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="show client logs and per-scenario diagnostics",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.CRITICAL,
        format="%(levelname)s %(name)s: %(message)s",
    )

    relay_client_cls = load_client(args.client_dir)
    names = SCENARIOS if args.scenario == "all" else (args.scenario,)

    try:
        asyncio.run(_run_all(names, args.deadline, relay_client_cls, args.verbose))
    except KeyboardInterrupt:  # pragma: no cover - operator interrupt
        raise SystemExit(130)

    print("REPRO_M72 DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
