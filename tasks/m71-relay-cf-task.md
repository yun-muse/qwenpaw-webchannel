# M7.1 relay-cf task — hello-generation gating + hibernation-safe agent slot

Repo: ~/workspace/qwenpaw-webchannel. Read AGENTS.md first. Work ONLY on
`relay-cf/src/index.ts` and `tests/e2e_cf.mjs`. Do not run tests or
deploys yourself (the coordinator verifies and deploys); write the
code carefully. TypeScript must stay type-clean (`tsc --noEmit` is run
by the coordinator).

## Background (the bug)

The tenant DO holds ONE agent slot. After a QwenPaw agent hot-reload,
the OLD plugin instance's RelayClient can reconnect (its stop arrives
late) and evict the NEW instance's socket, then vice versa — a
replacement war. It is worse here than in relay-node: after a
hibernation wake the slot is rebuilt from `getWebSockets()` and can
hand client frames to a stale socket whose reader is gone. Protocol
fix: the slot is won at `hello` time by generation. The plugin's
`hello` carries `started` (construction time, wall-clock microseconds,
int) and `session` (per-client uuid hex). An incoming hello whose
`started` is OLDER than the current agent's is superseded: close that
socket with code 4000 and do NOT disturb the current agent. Legacy
hellos without `started` count as 0.

## index.ts changes (keep everything else — login, tokens, rate limit,
offline buffer, auto-response ping/pong — behaviourally identical)

1. Add a field: `private agentMeta: { started: number; session: string } | null = null;`
   and a reason constant `SUPERSEDED_REASON = 'superseded by newer agent connection'`
   (reuse the existing `REPLACED_CODE`/`REPLACED_REASON` for eviction).
2. Attachment shape becomes `{ role, won?, started?, session? }`.
   `accept()` keeps storing just `{ role }` (metadata is added when a
   hello wins).
3. Constructor rebuild: among sockets whose attachment role is
   'agent', pick the winner as follows: candidates are sockets whose
   attachment `won !== false` (legacy attachments without `won` count
   as won, with started = attachment.started ?? 0); the winner has the
   greatest `started`; ties go to the LAST such socket in iteration
   order (preserving today's "last one wins" for equal generations).
   Set `this.agent` and `this.agentMeta` from the winner's attachment
   (session ?? ''). Do not close any socket in the constructor.
4. `upgradeAgent`: auth as today, then ONLY accept + return the 101
   response. No eviction, no `peer`, no outbox flush here anymore —
   the slot changes hands at hello time.
5. `webSocketMessage`, agent role:
   - Before the branch, if `this.agent === null`, try re-adopting the
     sender: if its attachment role is 'agent' and `won !== false`,
     set `this.agent = ws` and `this.agentMeta` from the attachment.
     (Post-hibernation safety net, replacing today's unconditional
     re-adopt line inside the agent branch — remove that line.)
   - `frame.t === 'hello'` → `await this.handleAgentHello(ws, frame)`
     and return.
   - Any other frame: forward via `broadcast(message)` ONLY when
     `ws === this.agent`; otherwise ignore the frame entirely (parked
     or superseded sockets must not reach clients).
6. New private async `handleAgentHello(ws, frame)`:
   - `started` = frame.started if a finite number > 0 else 0;
     `session` = frame.session if a string else ''.
   - If `this.agent && this.agent !== ws && started < (this.agentMeta?.started ?? 0)`:
     close `ws` with (REPLACED_CODE, SUPERSEDED_REASON); return
     (no ready, no state change).
   - Else if `ws === this.agent`: refresh `agentMeta` and the socket
     attachment, reply `{ t: 'ready', agentOnline: true }`, return.
   - Else (win): if `this.agent` close it with
     (REPLACED_CODE, REPLACED_REASON). Set `this.agent = ws`,
     `this.agentMeta = { started, session }`,
     `ws.serializeAttachment({ role: 'agent', won: true, started, session })`.
     Then `sendJson(ws, { t: 'peer', clients: this.clients.size })`,
     `await this.flushOutbox()`, and reply
     `{ t: 'ready', agentOnline: true }`.
7. `forget(ws)`: when clearing the agent also clear `agentMeta`.
8. Update the file header comment: replace the "Socket state is
   rebuilt..." note with a short paragraph documenting generation
   gating (slot won at hello by `started`; older generations closed
   with 4000 and never evict; winner metadata kept in the socket
   attachment so a hibernation rebuild restores the same winner).
9. `/health` + client `ready` keep using `this.agent !== null` (now:
   an agent that has won the slot, or a rebuilt winner).

## tests/e2e_cf.mjs changes

This harness runs against `wrangler dev --local`. Keep every existing
assertion id and meaning; adapt agent connections to the gated
protocol and add one new assertion group:

1. Warm-up agent (before section 3): after connecting, send
   `{ t: 'hello', instance: 'e2e-cf', agent: 'default', started: 1, session: 'warm' }`
   and wait for the `ready` frame (it currently waits for `peer` —
   replace that wait with ready; the outbox flush happens at the win).
2. Section 6: `agent2` must send
   `{ t: 'hello', instance: 'e2e-cf', agent: 'default', started: 2, session: 'e2e-cf-2' }`
   right after connecting, before the flush assertions.
   (Section 3's agent hello stays legacy — no started field — on
   purpose: it pins the legacy path. Note that in a comment.)
3. New section 9 `GENERATION` (after section 8, before the teardown):
   - Connect `stale` agent with the agent headers, send hello
     `{ started: 1, session: 'stale', instance: 'e2e-cf', agent: 'default' }`;
     expect its socket to be closed by the relay with code 4000
     (capture via a close listener/promise).
   - Assert `GET /health` still reports `agentOnline === true`.
   - Connect a client-visible probe: send `{ t: 'msg', chat: 'c9', text: 'gen-probe' }`
     from the existing client; assert the CURRENT agent (`agent2`)
     receives it (the stale hello did not disturb the slot).
   - Verdict name: `GENERATION`; add it to the `mandatory` list.
   Respect the rate bucket: reuse the existing sleeps pattern (sleep
   ~1200 ms before the probe if needed).
