# Implementation brief — QwenPaw WebChannel

Source of truth for design: `docs/design.md` (v0.1, 2026-10-26). Read it before coding.
Approach (user decision 2026-10-26): **hybrid — develop locally, test-deploy to the hosted container.**
Coding engine: local OpenCode server (tools/oc_prompt.py) with free models
`deepseek-v4.1-flash-free` (primary) / `glm-5.3-flash-free` (alternate), in small chunks.
Muse orchestrates, reviews every chunk, runs tests. Hosted QwenPaw (v2.2.2.post1) is
only a rollback-able test target (dedicated `work` agent later, M3); never edit code inside it.

Reference source: `~/workspace/qwenpaw-ref/` = github.com/agentscope-ai/QwenPaw tag `v2.2.2.post1`
(clone in progress). Plugin code must match this version's BaseChannel / plugin API.

## Open questions to resolve from reference source BEFORE writing the plugin (M1)
1. Delta semantics of `on_streaming_delta`: incremental chunk or cumulative text?
   Check `src/qwenpaw/app/channels/base.py` + `console/channel.py`.
2. Multi-agent dimension: frames need `agent_id`? How does a channel request carry agent id
   (`X-Agent-Id` / session meta)? Check chat manager / console channel.
3. 256KB frame limit vs base64 files in `msg` frames (design §6.1 vs §5.3): v1 rule =
   files >~180KB raw go as separate chunked `file` frames or reject with E_TOOBIG (decide in protocol).
Record findings in `docs/source-notes.md`.

## Milestones
- M0 (now): protocol/frames.md + relay-node (local Node relay) + mock agent client + SPA skeleton.
  Acceptance: a test client connected as browser receives **per-delta** streaming from the mock
  agent through the relay; automated e2e script proves it (counts distinct evt frames > 10 for one reply).
- M1: real plugin against qwenpaw-ref source, run against a locally source-installed QwenPaw if feasible.
- M2: approval frames, file upload, history, ring-buffer resume.
- M3: relay-cf (Worker + Durable Object port of relay-node), ZIP hot-install to hosted instance on `work` agent.
- M4: polish (session list, theme, mobile).

## Frame protocol (design §6, summary)
Envelope JSON `{t, id?, ...}`, UTF-8, max 256KB/frame.
agent→client: hello/ready, evt{chat,seq,data}, msg{chat,seq,parts[]}, approval{chat,req_id,...},
resync{chat}, pong. client→agent: msg{chat,text,files[]}, stop{chat}, approve/deny{chat,req_id},
resume{chat,last_seq}, hist{chat,...}, ping (25s).
Errors: E_AUTH, E_BUSY, E_TOOBIG, E_RESYNC.

## Repo layout
- `protocol/` shared frame schema (frames.md + frames.schema.json if produced)
- `relay-node/` local/dev relay (Node + ws) — M0
- `relay-cf/` Cloudflare Worker + DO port — M3
- `mock/` mock agent client (simulates container plugin) — M0
- `spa/` Vite + React + TS frontend — M0 skeleton, M4 polish
- `plugin/` QwenPaw WebChannel plugin (Python) — M1
- `tools/oc_prompt.py` OpenCode driver (password read from serve.log at runtime; never hardcode it)
