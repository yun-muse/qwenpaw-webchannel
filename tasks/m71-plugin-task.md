# M7.1 plugin task — RelayClient: superseded-instance semantics

Repo: ~/workspace/qwenpaw-webchannel. Read AGENTS.md first. Work ONLY on
`plugin/relay_client.py` and a NEW file `plugin/tests/test_m71.py`.
Do not run any tests or builds yourself (the coordinator runs them);
just write the code carefully.

## Background (the bug)

The relay has exactly ONE agent slot. When QwenPaw hot-reloads an agent
workspace (e.g. after a model switch), a NEW WebChannel/RelayClient
connects and the relay closes the previous socket with close code 4000
("replaced by new agent connection"). The OLD workspace's stop() can
arrive seconds later, so the old RelayClient — still in its reconnect
loop — reconnects after its 1 s backoff and the relay evicts the NEW
instance in turn: a ~1 Hz replacement war. Fix direction: a client
whose socket was closed with 4000 has been *superseded by a newer
instance* and must never reconnect; the relay (separate task) will
additionally refuse to evict the current agent for an older-generation
hello, so the war cannot start.

## Changes to plugin/relay_client.py

1. Imports: add `time` and `uuid` to the stdlib imports.
2. Add a module constant near the other constants:
   `REPLACED_CLOSE_CODE = 4000` with a comment that the relay closes a
   superseded agent socket with this code (see protocol/frames.md).
3. In `RelayClient.__init__`, after `self.agent_id = ...`, add:
   - `self.session = uuid.uuid4().hex` — unique per RelayClient instance.
   - `self.started_us = time.time_ns() // 1000` — construction time in
     wall-clock microseconds (fits exactly in a JS double, so the relay
     can compare generations without precision loss).
   - `self._close_code: Optional[int] = None` near the other private
     connection state (`self._ws` etc.).
4. In `_run`, the `hello` frame gains two fields (keep existing fields
   unchanged): `"session": self.session, "started": self.started_us`.
5. In `_run`, immediately after `ws = await self._connect()` succeeds
   (before `self._ws = ws`), reset `self._close_code = None`.
6. In `_reader`, the `except websockets.ConnectionClosed:` branch must
   record the code before returning:
   `self._close_code = getattr(exc, "code", None)` (bind the exception
   with `as exc`).
7. In `_run`, after the inner `try: await self._reader(ws) / finally:
   (writer/heartbeat cleanup)` block completes normally, add a check:
   if `self._close_code == REPLACED_CLOSE_CODE and not self._closed`,
   set `self._fatal = True` and log at error level:
   "relay: superseded by a newer instance (close 4000); not reconnecting".
   The existing post-loop `if self._closed or self._fatal: break` then
   terminates the loop. Do not change any other behaviour: normal
   closes (1000/1001/1011, network errors) must keep reconnecting with
   the existing backoff; E_AUTH handling stays as is.
8. Update the module docstring's first paragraph list of behaviours to
   mention: reconnect stops permanently when the relay closes the
   socket with code 4000 (superseded by a newer instance).

## New test file plugin/tests/test_m71.py

Follow the repo test conventions (see plugin/tests/test_m7.py header):
plain-python assert script, `main()` runner printing `ALL PASS`,
sys.path shim inserting the plugin dir, import `RelayClient` from
`relay_client`. Use `websockets` (already a dependency) to run an
in-process server on an ephemeral port (`websockets.serve(handler,
"127.0.0.1", 0)`; get the port from `server.sockets[0].getsockname()`).

Scenarios (drive everything from one `asyncio.run(main_async())`):

- A (superseded → no reconnect): server handler records each
  connection and each parsed hello frame, then closes the socket with
  `code=4000, reason="replaced by new agent connection"` right after
  the hello. Start `RelayClient(url, "tok", agent_id="default")` via
  `await client.start()`. Wait until the client's run task is done
  (poll `client._task` — acceptable in a unit test — or wait for the
  server-side close + a grace sleep) with a ~5 s deadline. Assert:
  the run task finished; `client.connected` is False; after a further
  2.5 s the server still saw EXACTLY 1 connection; the recorded hello
  has a non-empty string `session` and an int `started` > 0.
- B (transient close → reconnect): fresh client + fresh server whose
  handler closes the FIRST connection with code 1011 after hello and
  keeps the second one open (just await messages/close). Assert the
  server sees a 2nd connection within ~6 s and both hellos carry the
  SAME `session` (same RelayClient instance) — then
  `await client.stop()` and assert the task is done.
- Use short ping_interval (e.g. pass `ping_interval=30`) so heartbeats
  do not interfere, and set the client's backoff expectations from the
  defaults (initial 1 s): scenario A waits must comfortably exceed one
  backoff cycle so a wrongful reconnect would be observed.

Keep the tests deterministic and self-contained; no network beyond
127.0.0.1, no qwenpaw imports.
