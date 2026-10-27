# M7.2 e2e/repro task — kill-and-recover evidence tooling

Repo AGENTS.md applies. Files: `tests/repro_m72.py` (new),
`tests/e2e_m72.mjs` (new). Do not touch product code or other tests.

## tests/repro_m72.py — before/after harness for the RelayClient

Standalone python script (stdlib + `websockets` only). Purpose: run
one `RelayClient` implementation against a scripted in-process
server and report whether the client recovers from each failure
mode. Used twice by the coordinator: once against an extracted
pre-M7.2 copy of the client (the "before" evidence) and once against
the fixed tree.

CLI:
```
python3 tests/repro_m72.py --client-dir <dir> [--scenario all|parked|destroy|silence] [--deadline 20]
```
`--client-dir` is a directory containing `relay_client.py`,
`frames.py`, `util.py`; load `RelayClient` from there (insert the
dir at `sys.path[0]` in a subprocess-safe way — simplest: the script
re-execs itself with the dir prepended, or imports via
importlib.util.spec_from_file_location for relay_client while
ensuring its `from frames import ...` fallback resolves — note
relay_client first tries a package-relative import and falls back to
top-level, so putting `--client-dir` first on `sys.path` and
importing `relay_client` top-level works).

Server: in-process `websockets.serve` on 127.0.0.1 ephemeral port,
one handler per scenario, counting hellos. Client under test:
`RelayClient(url, "tok", agent_id="repro", ping_interval=0.5,
pong_timeout=0.5, on_frame=<per scenario>)`. (The pre-M7.2 client
accepts the same constructor kwargs for ping/pong; it ignores
unknown ones — do NOT pass M7.2-only kwargs.)

Scenarios:
- `destroy`: server reads hello #1, then `ws.transport.abort()`.
  RECOVERED = hello #2 arrives within the deadline.
- `silence`: server reads hello #1, then
  `ws.transport.pause_reading()` and holds. RECOVERED = hello #2
  within the deadline.
- `parked`: client's `on_frame` blocks forever (awaits a never-set
  `asyncio.Event`, with a `finally` that records cancellation) on
  the first business frame. Server reads hello, sends
  `{"t":"msg","chat":"c1","text":"hi"}`, stays healthy and keeps
  reading (so protocol-level replies still work). RECOVERED =
  hello #2 within the deadline (the connection must be torn down
  and re-established despite the parked callback).

Output: one line per scenario —
`SCENARIO parked: NOT RECOVERED (no 2nd hello within 20s)` /
`SCENARIO destroy: RECOVERED in 1.2s` — then a summary line
`REPRO_M72 DONE`. Exit 0 unless the harness itself crashes.
Clean up the client (`stop()`) and server at the end of each
scenario; a wedged client task must not hang the script — cancel
leftover tasks.

## tests/e2e_m72.mjs — full-stack kill-and-recover

Mirror `tests/e2e_m71.mjs`'s client machinery (frame log, waiters,
single-shot probes with hard timeouts, `ASSERT` lines, `E2E_M72 PASS`
at the end) with these differences:

- The script OWNS the relay: spawn `node relay-node/server.js` as a
  child process with `PORT=8787` (read `relay-node/server.js` for
  its env/defaults and mirror whatever token setup e2e_m71's stack
  used — the local app on :8088 must be able to connect to this
  relay; if server.js takes `AGENT_TOKEN` from env, pass the same
  value the local app's web channel is configured with, which the
  coordinator will state when running it; default to not setting it
  if the server has a built-in default that matches e2e_m71).
  Wait for `GET http://127.0.0.1:8787/health` to answer before
  proceeding. The local QwenPaw app on :8088 is started by the
  coordinator, NOT by this script.
- The script's own client WebSocket must auto-reconnect (the relay
  bounces kill it too): on close, retry every 500 ms until a
  `ready` frame with `agentOnline: true` arrives.
- Flow: baseline `models` probe + baseline chat probe (same
  single-shot style as e2e_m71, chat asserts the trailing `msg`
  contains the probe word). Then 3 kill cycles:
  `child.kill('SIGKILL')` → wait 1000 ms → respawn the relay →
  wait for client `ready` with `agentOnline: true` (timeout 60 s;
  this is the plugin's RelayClient reconnecting on its own — the
  app is never restarted) → `models` probe + chat probe, each
  single-shot with a 30 s timeout.
- Print `E2E_M72 PASS` only if baseline and all 3 cycles pass.
  Kill the relay child in a finally/exit path so no stray process
  remains.
