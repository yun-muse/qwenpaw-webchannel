# M7.2 relay-cf task — expose agent last-seen in /health

Repo AGENTS.md applies. Files: `relay-cf/src/index.ts` only (plus, if
trivial, one added assertion group in `tests/e2e_cf.mjs`). Do not touch
anything else.

## Change

The RelayDO should track when it last heard from the current agent
socket, so a silent-but-"online" agent is observable from outside
(the hosted M7.2 incident: `/health` said `agentOnline: true` for
~10 minutes while the agent said nothing).

1. Add `private agentLastSeenAt = 0;` (epoch ms) to `RelayDO`.
2. Stamp it with `Date.now()`:
   - in `webSocketMessage`, whenever the sender is the current agent
     socket (role `agent` and the socket is `this.agent`) — any
     business frame counts, including `hello`;
   - when an agent wins the slot at hello time (same thing if the
     message handler covers it — do not double-stamp needlessly);
   - reset it to `0` when the current agent socket closes/errors and
     the slot becomes empty.
   Note: the app-level `{"t":"ping"}` heartbeat is answered by
   `setWebSocketAutoResponse` and never reaches `webSocketMessage`,
   so it deliberately does NOT stamp — the field means "last agent
   business frame", which is exactly the incident's tell. Add a short
   code comment saying so.
   After a hibernation rebuild the in-memory value starts at 0 again;
   that is acceptable — do not persist it to storage or attachments.
3. `GET /health` response gains the field, keeping the existing
   fields: `{ ok, agentOnline, clients, agentLastSeen }` where
   `agentLastSeen` is the epoch-ms number, or `null` when it is 0 /
   no agent is connected.

## e2e (only if trivial)

In `tests/e2e_cf.mjs`, if there is an existing HEALTH assertion
group, extend it: after the agent connects and says hello,
`GET /health` shows `agentLastSeen` as a number > 0; after the agent
sends another business frame, a later `/health` shows a value >= the
first. If the harness makes this awkward, skip it and say so in your
summary — the coordinator will verify /health manually.

## Out of scope

No behaviour changes to routing, generations, outbox, or rate
limiting. No relay-node changes (its /health stays as-is). Deploy is
the coordinator's job, not yours.
