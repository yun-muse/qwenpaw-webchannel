# AGENTS.md — qwenpaw-webchannel

Conventions and durable lessons for this repo. Short entries only.

- Chunked M1 work may run as parallel sessions; disk state can contradict what the task brief claims (a brief said `plugin/` was empty while files existed). Always `ls`/read before overwriting, and verify with a real `ls -la` after writing.
- `plugin/util.py` is the only home for the pure helpers (StreamDiffer, SeqCounter, RingBuffer); `plugin/frames.py` re-exports them via the `try: from .util import ... / except ImportError: from util import ...` pattern so both package and top-level plugin-loader imports work. Do not duplicate the logic in frames.py or channel.py.
- `RingBuffer.since(chat, last_seq)` contract: populated buffer → hit list / `[]` when caught up / `None` when `last_seq < oldest-1`; empty buffer → `[]` only when `last_seq == 0`, otherwise `None` (miss → resync; e.g. container restart).
- `approval_frame(chat, req_id, **kw)` — no positional `seq`; pass `seq=...` as a keyword. Reserved keys `t`/`chat`/`req_id` cannot be overridden via `**kw`.
- Plugin tests must not depend on pytest: keep them plain-python assert scripts with a `main()` runner printing `ALL PASS` (pytest optionally collects the `test_*` functions; pytest is not installed in this environment).
