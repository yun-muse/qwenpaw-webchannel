# M7.1 relay-node task — hello-generation gating for the agent slot

Repo: ~/workspace/qwenpaw-webchannel. Read AGENTS.md first. Work ONLY on
`relay-node/server.js` and `relay-node/test/smoke.mjs`. Do not run any
tests yourself (the coordinator runs them); write the code carefully.

## Background (the bug)

The relay has ONE agent slot. After a QwenPaw agent hot-reload, the OLD
plugin instance's RelayClient can reconnect (its stop arrives late) and
evict the NEW instance's socket, then vice versa — a replacement war.
The protocol fix: the agent slot is now won at `hello` time by
generation. The plugin's `hello` carries `started` (construction time,
wall-clock microseconds, int) and `session` (per-client uuid hex). An
incoming hello whose `started` is OLDER than the current agent's is
superseded: its socket is closed with code 4000 and the current agent
is NOT disturbed. Legacy hellos without `started` count as 0.

## server.js changes

Keep all limits, framing, buffering and client behaviour identical.
Change only the agent-slot ownership flow:

1. Add module state next to `let agent`: `let agentMeta = null;`
   (shape `{ started: number, session: string }`).
2. Add constants near REPLACED usage (there is a literal close call
   today): `const REPLACED_CODE = 4000;` with reasons
   `'replaced by new agent connection'` (evicting the old holder when
   a newer/equal generation wins) and `'superseded by newer agent
   connection'` (refusing an older generation).
3. Restructure `handleAgent(ws)`:
   - On connection: do NOT close the previous agent, do NOT assign
     `agent`, do NOT send `peer`, do NOT flush the outbox. The socket
     is "parked" until its hello wins the slot.
   - Message handler:
     - `readFrame` errors behave exactly as today.
     - `ping` → pong, as today (any parked/current agent socket).
     - `hello` → slot decision:
       - `started` = `frame.started` if it is a finite number > 0,
         else 0. `session` = `frame.session` if a string, else `''`.
       - If `agent` is set, `agent !== ws`, and
         `started < agentMeta.started`: the newcomer is superseded —
         `ws.close(REPLACED_CODE, 'superseded by newer agent connection')`
         and return. Send nothing else (no ready, no peer).
       - Otherwise the newcomer wins: if `agent && agent !== ws`,
         `agent.close(REPLACED_CODE, 'replaced by new agent connection')`.
         Set `agent = ws`, `agentMeta = { started, session }`.
         Then, in this order: `sendJson(ws, { t: 'peer', clients: clientCount() })`,
         `flushOutbox()`, `sendJson(ws, { t: 'ready', agentOnline: true })`.
       - If `ws` IS already the current agent and sends hello again:
         update `agentMeta`, reply `{ t: 'ready', agentOnline: true }`
         only (no peer, no flush, no close).
     - Any other frame: forward to all open clients ONLY if
       `ws === agent`; frames from parked/superseded sockets are
       silently ignored.
   - Close handler: `if (agent === ws) { agent = null; agentMeta = null; }`.
4. `/health`: unchanged shape; `agentOnline` is `isOpen(agent)` as
   today (agent is only set after a winning hello now).
5. `flushOutbox` already targets the module-level `agent` — unchanged.

## smoke.mjs changes

The existing scenarios still must pass with the tightened protocol:

1. Add a helper `hello(ws, started, session)` that sends
   `{ t: 'hello', token: 'dev-agent-token', instance: 'smoke', agent: 'default', started, session }`.
2. Scenario 1: after the agent connects, call
   `hello(agent, 1000, 'smoke-a')` BEFORE waiting for the `peer` frame.
3. Scenario 5 (offline buffering): the reconnected agent must call
   `hello(agent, 2000, 'smoke-a2')` right after connecting, before the
   buffered msg replay is awaited. (A different session and a LATER
   started: it is a new client instance.)
4. Append a new scenario 6 (generation gating) before the final PASS:
   - Connect `stale` agent socket, `hello(stale, 500, 'stale')` (older
     than the current holder's 2000): await its `close` event and
     assert the close code is 4000. Assert health still reports
     `agentOnline === true`.
   - The current agent sends `{ t: 'evt', chat: 'c1', seq: 99, data: 'y' }`;
     assert the connected client receives it (the slot was undisturbed).
   - Connect `newer` agent socket, `hello(newer, 3000, 'newer')`:
     assert the previous current agent's socket closes with code 4000,
     and a client msg sent afterwards is delivered to `newer`, not to
     the previous agent. Reassign the outer `agent` variable to
     `newer` so the existing teardown closes the right sockets, and
     close `stale` leftovers defensively.
   Use the file's existing helpers (`connect`, `waitFor`, `waitHealth`,
   `check`). For close-code assertions attach
   `ws.once('close', (code) => ...)` promise wrappers.
