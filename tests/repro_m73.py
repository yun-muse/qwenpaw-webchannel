#!/usr/bin/env python3
"""M7.3 repro harness: can a RelayClient survive a SILENT blackhole relay?

The hosted failure this pins down: the tunnel behind the relay died without a
RST, ``/health`` still said ``agentOnline: true``, the app-level ``ping`` was
answered (Cloudflare ``setWebSocketAutoResponse``) and WebSocket-level pings
were answered at the edge. Nothing the client could observe ever changed, so
the pre-M7.3 client sat there forever.

The in-process relay here reproduces exactly that shape:

  * it answers ``{"t":"ping"}`` with ``pong`` (the edge auto-answer),
  * it answers WebSocket-level pings (the ``websockets`` protocol does this),
  * it reads and holds the socket open (never closes, never aborts),
  * it never acks ``hb`` and never forwards a business frame.

Three clients are pointed at it:

  old            ``git show <rev>:plugin/relay_client.py`` (pre-M7.3)
  fixed-control  the working-tree client with the heartbeat disabled
  fixed          the working-tree client with a fast ``hb`` beat

The old client and the control are expected to stay NOT RECOVERED; the fixed
client is expected to notice the missing acks and re-establish the connection.

    python3 tests/repro_m73.py [--rev HEAD] [--deadline 20] [--keep]

Run it *before* committing M7.3, or pass ``--rev <pre-M7.3-commit>``: with
``--rev HEAD`` after the commit the "old" client already has ``hb`` (the
harness says so).

Only stdlib + ``websockets`` are used; the exit status is 0 unless the harness
itself fails (a NOT RECOVERED row is evidence, not an error).
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time

import websockets
from websockets.exceptions import ConnectionClosed

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_DIR = os.path.join(REPO_ROOT, "plugin")
HOST = "127.0.0.1"
CLIENT_FILES = ("relay_client.py", "frames.py", "util.py", "filelog.py")
BEAT_S = 0.5
ACK_TIMEOUT_S = 0.5
STOP_TIMEOUT_S = 10.0


# ---------------------------------------------------------------------------
# Loading the clients under test
# ---------------------------------------------------------------------------

def _purge_modules():
    for name in ("relay_client", "frames", "util", "filelog"):
        sys.modules.pop(name, None)


def extract_old_client(rev, target_dir):
    """Write ``git show <rev>:plugin/relay_client.py`` plus its siblings."""
    source = subprocess.run(
        ["git", "-C", REPO_ROOT, "show", "%s:plugin/relay_client.py" % rev],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if source.returncode != 0:
        raise SystemExit(
            "repro_m73: cannot extract %s:plugin/relay_client.py: %s"
            % (rev, source.stderr.decode("utf-8", "replace").strip())
        )
    text = source.stdout.decode("utf-8")
    with open(os.path.join(target_dir, "relay_client.py"), "w", encoding="utf-8") as fh:
        fh.write(text)
    for name in CLIENT_FILES[1:]:
        shutil.copyfile(
            os.path.join(PLUGIN_DIR, name),
            os.path.join(target_dir, name),
        )
    return text


def load_client(client_dir):
    """Import ``RelayClient`` from *client_dir* (inserted first on sys.path)."""
    directory = os.path.abspath(client_dir)
    missing = [
        name for name in ("relay_client.py", "frames.py", "util.py")
        if not os.path.isfile(os.path.join(directory, name))
    ]
    if missing:
        raise SystemExit(
            "repro_m73: %s is missing %s" % (directory, ", ".join(missing))
        )

    _purge_modules()
    sys.path.insert(0, directory)
    try:
        import relay_client
        return relay_client.RelayClient
    finally:
        sys.path.remove(directory)


def supports_heartbeat(cls):
    return "hb_max_missed" in inspect.signature(cls.__init__).parameters


# ---------------------------------------------------------------------------
# The blackhole relay
# ---------------------------------------------------------------------------

class _State:
    def __init__(self):
        self.connections = 0
        self.hellos = 0
        self.second_hello = asyncio.Event()
        self.beats = 0
        self.pings = 0

    def note_hello(self):
        self.hellos += 1
        if self.hellos >= 2:
            self.second_hello.set()


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
                    state.note_hello()
                elif kind == "ping":
                    # Edge-style answer: alive as far as the old client knows.
                    state.pings += 1
                    await ws.send(json.dumps({"t": "pong"}))
                elif kind == "hb":
                    # The relay process is "gone": no ack, ever.
                    state.beats += 1
                # business frames vanish
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001 - a dead peer ends the handler
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
# One client against one blackhole
# ---------------------------------------------------------------------------

async def run_case(client_cls, kwargs, deadline):
    """Return ``(recovered, elapsed, state)`` for one client."""
    state = _State()
    client = None
    server = None
    started = time.monotonic()

    try:
        server = await websockets.serve(
            _handler(state), HOST, 0, ping_interval=None,
        )
        url = "ws://%s:%d/agent" % (HOST, _server_port(server))
        client = client_cls(url, "tok", agent_id="repro", **kwargs)
        await client.start()
        try:
            await asyncio.wait_for(state.second_hello.wait(), timeout=deadline)
        except asyncio.TimeoutError:
            return False, time.monotonic() - started, state
        return True, time.monotonic() - started, state
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.stop(), timeout=STOP_TIMEOUT_S)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - teardown is best effort
                pass
        if server is not None:
            try:
                server.close()
                await asyncio.wait_for(server.wait_closed(), timeout=STOP_TIMEOUT_S)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - teardown is best effort
                pass


async def _run_all(cases, deadline):
    rows = []
    for label, client_cls, kwargs in cases:
        recovered, elapsed, state = await run_case(client_cls, kwargs, deadline)
        rows.append((label, recovered, elapsed, state))
        print(
            "  %-30s %s (beats=%d pings=%d hellos=%d)"
            % (
                label,
                "RECOVERED" if recovered else "NOT RECOVERED",
                state.beats,
                state.pings,
                state.hellos,
            ),
            flush=True,
        )
    return rows


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="RelayClient silent-blackhole repro (M7.3).",
    )
    parser.add_argument(
        "--rev",
        default="HEAD",
        help="git revision whose plugin/relay_client.py is the 'old' client "
             "(default: HEAD; use a pre-M7.3 commit after this one lands)",
    )
    parser.add_argument(
        "--deadline",
        type=float,
        default=20.0,
        help="seconds to wait for a 2nd hello per client (default: 20)",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="keep the extracted old client and print its path",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="show client logs",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.CRITICAL,
        format="%(levelname)s %(name)s: %(message)s",
    )

    tmp_dir = tempfile.mkdtemp(prefix="wc-m73-old-")
    try:
        extract_old_client(args.rev, tmp_dir)
        old_client = load_client(tmp_dir)
        fixed_client = load_client(PLUGIN_DIR)

        if supports_heartbeat(old_client):
            print(
                "NOTE: %s:plugin/relay_client.py already speaks hb -- this row "
                "is not a pre-M7.3 baseline (pass --rev <older commit>)." % args.rev,
                flush=True,
            )

        # Same beat timings for both real clients; only the frame differs.
        old_kwargs = {"ping_interval": BEAT_S, "pong_timeout": ACK_TIMEOUT_S}
        fixed_kwargs = dict(old_kwargs)
        if supports_heartbeat(fixed_client):
            fixed_kwargs["hb_max_missed"] = 2

        cases = [
            ("old (%s:relay_client.py)" % args.rev, old_client, old_kwargs),
            ("fixed, heartbeat disabled (control)", fixed_client,
             {"ping_interval": None, "ws_ping_interval": None,
              "ws_ping_timeout": None}),
            ("fixed (hb beat)", fixed_client, fixed_kwargs),
        ]

        print(
            "M7.3 repro -- silent blackhole relay (ping answered, hb never "
            "acked, socket held open)",
            flush=True,
        )
        rows = asyncio.run(_run_all(cases, args.deadline))

        print("", flush=True)
        print("%-38s %s" % ("client", "result"), flush=True)
        print("%-38s %s" % ("-" * 38, "-" * 38), flush=True)
        for label, recovered, elapsed, _state in rows:
            print(
                "%-38s %s"
                % (
                    label,
                    "RECOVERED in %.1fs" % elapsed
                    if recovered
                    else "NOT RECOVERED (%.1fs)" % elapsed,
                ),
                flush=True,
            )
    finally:
        if args.keep:
            print("kept extracted client at %s" % tmp_dir, flush=True)
        else:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    print("REPRO_M73 DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
