# M7.2 plugin task — RelayClient self-healing + plugin file log

Repo AGENTS.md applies. Files: `plugin/relay_client.py` (rework),
`plugin/filelog.py` (new), `plugin/channel.py` (small wiring),
`tools/package_plugin.sh` (allowlist), `plugin/tests/test_m72.py` (new),
`AGENTS.md` (one convention line). Do not touch anything else.

## Background (the bug you are fixing)

Hosted incident: the relay tunnel died half-open (peer FIN sat in
CLOSE_WAIT) and the plugin never recovered — no reconnect, no error,
relay kept reporting the agent online; only an app restart helped.
Audit of the current `relay_client.py` found these structural holes:

- H1: `_run` reaches its reconnect branch only after `_reader()`
  returns, but `_reader` awaits the frame callback inline — a callback
  that never returns parks the loop forever. The heartbeat's remedy
  (`ws.close()`) does not cancel the reader.
- H2: writer/heartbeat tasks are awaited only in the `finally` after
  the reader returns; a dead writer is invisible while the reader
  lives (outbound frames silently queue forever).
- H3: `_send_direct` is unbounded and serialized by `_tx_lock`: one
  stuck `ws.send()` wedges every sender, including the heartbeat ping.
- H4: `websockets.connect` is called with `ping_interval: None`; the
  app-level pong is consumed by the possibly-parked reader, so the
  heartbeat measures the reader, not the tunnel.
- H5: `_run` is a single fire-and-forget task; if it ever exits
  outside `stop()` / the fatal paths, nothing restarts it.

## relay_client.py changes

1. Constructor: add keyword-only params `ws_ping_interval: float =
   20.0`, `ws_ping_timeout: float = 20.0`, `send_timeout: float =
   10.0`, `file_log: Optional["FileLog"] = None`. Import `FileLog`
   with the same dual try/except ImportError pattern the module
   already uses for `frames` (package-relative, then top-level).
2. `_connect`: pass `ping_interval=self.ws_ping_interval` and
   `ping_timeout=self.ws_ping_timeout` to `websockets.connect`
   (replacing `ping_interval: None`).
3. `_send_direct`: wrap the send:
   `await asyncio.wait_for(ws.send(text), timeout=self.send_timeout)`
   inside the existing `_tx_lock`. Let `asyncio.TimeoutError`
   propagate (callers already treat send exceptions as connection
   death).
4. Connection phase supervision (in `_run`, after `hello` is sent):
   create the reader, writer, heartbeat tasks, then
   `await asyncio.wait({reader, writer, heartbeat},
   return_when=asyncio.FIRST_COMPLETED)`. Whichever task finishes
   first ends the connection phase:
   - Record an info log + file-log event `phase_end` with which task
     ended it and, if it raised, the exception repr.
   - Cancel the remaining tasks and await them via
     `asyncio.wait_for(asyncio.gather(*pending,
     return_exceptions=True), timeout=5)` inside try/except — cleanup
     must never hang the loop.
   - If the phase wait itself is cancelled (stop()), cancel all three
     tasks and re-raise, preserving current stop() semantics.
   The reader ending keeps today's semantics (`self._close_code`
   drives the 4000-fatal rule). Writer/heartbeat ending is treated as
   a dead connection: fall through to the existing close/backoff/
   reconnect flow.
5. Supervisor: `start()` now creates the task running
   `_supervise()` (stored in `self._task`, so existing callers/tests
   that inspect `client._task` keep working). `_supervise`:
   ```
   while not self._closed:
       try:
           await self._run()
       except asyncio.CancelledError:
           raise
       except BaseException as exc:            # _run must never die silently
           log error + file-log `loop_exit` (reason=repr(exc))
       if self._closed or self._fatal:
           break
       log + file-log `supervisor_restart`
       await asyncio.sleep(1.0)
   ```
   A normal return of `_run()` without `_closed`/`_fatal` takes the
   same restart path (log it as unexpected). `stop()` keeps its
   external behaviour (sets `_closed`, cancels `self._task`, closes
   the socket). After a 4000 close, `_run` sets `_fatal` and returns,
   so the supervisor exits and `client._task.done()` is True — the
   M7.1 tests depend on this.
6. File-log events via a helper `_log_event(event, **fields)` that
   no-ops when `self._flog is None` and never raises. Emit at least:
   `connect` (url, session, started), `hello`, `close` (code),
   `phase_end` (task, detail), `reconnect` (delay), `loop_exit`
   (reason), `supervisor_restart`, `fatal` (reason), `stopped`.
   Keep the existing `logger.*` calls as they are.

## filelog.py (new module)

`class FileLog`:
- `__init__(self, path, max_bytes: int = 262144, backups: int = 2)`.
  Store the path as a `pathlib.Path`; create nothing at construction.
- `write(self, event: str, **fields) -> None`: append one line
  `YYYY-MM-DD HH:MM:SS.mmm event k=v k=v` (local time). Values are
  `str()`-ed with spaces and newlines replaced by `_`. Before
  writing, if the file exists and `size + len(line) > max_bytes`,
  rotate: `path.1 -> path.2`, `path -> path.1` (drop the oldest
  beyond `backups`). Guard with a `threading.Lock`. The whole method
  is wrapped in try/except Exception: pass — **logging must never
  raise**.

## channel.py wiring (small)

- Import `FileLog` with the same dual import pattern used for
  `RelayClient`.
- In `WebChannel.start()`: build the log path —
  `ws_dir = getattr(self._workspace, "workspace_dir", None)`;
  base = `Path(ws_dir)` if set else `Path(__file__).resolve().parent`;
  `flog = FileLog(base / "webchannel.log")`; store `self._flog =
  flog`; pass `file_log=flog` to `RelayClient`; after start, write
  `channel_start` (agent id) to it. In `stop()`, write `channel_stop`
  before/while stopping. Construction of FileLog must not be able to
  break `start()` (it can't per its contract, but keep the wiring
  minimal anyway).

## tools/package_plugin.sh

Add `filelog.py` to the `FILES` allowlist (now 9 files).

## plugin/tests/test_m72.py (new)

Plain-python assert script in the exact style of
`plugin/tests/test_m71.py` (in-process `websockets` server, `_wait_until`
helper, `main()` printing `ALL PASS`, pytest-collectable `test_*`
wrapper). Scenarios:

- A **destroy**: server reads `hello`, then aborts the TCP transport
  without a close frame (`ws.transport.abort()`). Client must
  reconnect (2nd hello) within 8 s and report `connected`.
- B **silence**: server reads `hello` on connection #1, then calls
  `ws.transport.pause_reading()` and holds the socket. Client built
  with `ws_ping_interval=0.3, ws_ping_timeout=0.3`. Client must
  reconnect within 8 s.
- C **parked dispatch**: client's `on_frame` blocks forever (awaits
  an `asyncio.Event` that is never set) on the first business frame;
  the server sends `{"t":"msg","chat":"c1","text":"hi"}` after hello
  and otherwise stays healthy. Client `ping_interval=0.3,
  pong_timeout=0.3`. The heartbeat must declare the connection dead
  and the client must reconnect (2nd hello) within 10 s despite the
  parked callback. Assert the parked callback coroutine was cancelled
  (flag set in its `finally`).
- D **supervisor**: subclass `RelayClient` overriding `_connect` to
  raise a custom `BaseException` subclass on the first call and
  delegate afterwards. Client must still connect (hello observed)
  within 8 s — proof the supervisor restarted the run loop.
- E **file log**: client with `file_log=FileLog(tmpdir /
  "webchannel.log")`; connect → server closes 1011 → reconnect →
  `stop()`. Assert the log file exists and contains the event names
  `connect`, `hello`, `close`, `reconnect`, `stopped`. Plus direct
  FileLog checks: tiny `max_bytes` with 200 writes keeps total size
  bounded (≤ max_bytes * (backups + 1) + slack); a FileLog whose path
  is an existing directory never raises on write.

Keep total runtime < 60 s. Use short ping/timeout values only where a
scenario needs them; scenario A/C/D defaults must not let the
app-level heartbeat interfere unexpectedly (follow test_m71's
`_PING_S` pattern where appropriate — note scenario C NEEDS the
app-level heartbeat active).

## AGENTS.md

Append one convention line, M7.2: the RelayClient connection phase is
supervised (FIRST_COMPLETED over reader/writer/heartbeat), sends are
time-bounded, websockets ping/pong is on, a supervisor restarts the
run loop after any non-fatal exit, and only close 4000 / E_AUTH /
HTTP 401-403 / explicit stop() are fatal. One or two sentences, in the
file's existing terse style.

## Out of scope

No protocol changes; no relay changes; no SPA changes; do not alter
the M7.1 generation semantics (hello still carries session/started;
4000 stays fatal; same-session reconnects).
