# mock — mock container agent (M0)

Simulates the container-side WebChannel plugin so the SPA can be exercised without QwenPaw.
It connects to `relay-node` as an agent and streams a canned reply for every `msg` it receives.

Node.js **>= 20** required.

## Run

Terminal 1 — relay:

```bash
cd relay-node
npm install
npm start
# relay-node listening on :8787 (agent token: dev default)
```

Terminal 2 — mock agent:

```bash
cd mock
npm install
npm start
# [mock] connected ...
```

Terminal 3 — SPA:

```bash
cd spa
npm install
npm run dev
# open http://localhost:5173
```

Environment overrides for the mock:

| variable | default | meaning |
|---|---|---|
| `RELAY_URL` | `ws://127.0.0.1:8787/ws/agent` | relay agent endpoint |
| `AGENT_TOKEN` | `dev-agent-token` | value for `Authorization: Bearer <token>` |

## Behaviour

- `{t:"msg", chat, text}` → `start`, then one `evt` per 1–3 characters of the canned reply
  every 30 ms, then `end`, then a final `msg` with the full text. `seq` is monotonic per chat.
- The canned reply echoes the received text (truncated to 40 chars), includes `**bold**` and a
  `` `code` `` word, and is ~150 chars.
- `{t:"stop", chat}` → cancels the in-flight stream for that chat (and emits `end`).
- A new `msg` for a chat while it is streaming replaces the in-flight reply.
- Unknown / M2 frames (`resume`, `hist`, `approve`, `deny`) are ignored.
- Every frame sent is logged as `→ {...}`.
- If the relay goes away the mock reconnects after 1 s and continues the per-chat `seq` counters.
