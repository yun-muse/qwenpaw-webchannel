IMPORTANT: A previous session claimed to create these files but wrote NOTHING to disk — the plugin/ directory is empty right now. You MUST use your file-writing tool to actually create each file, then verify with `ls -la` via your shell tool and paste the real listing. Do not finish with a prose summary of code; the files themselves are the deliverable.

Workdir: /home/hatch/workspace/qwenpaw-webchannel

Read first: tasks/m1-plugin.md (full M1 spec) and docs/source-notes.md and protocol/frames.md.

THIS CHUNK ONLY — create exactly these 3 files:

1. plugin/util.py — pure stdlib, no third-party imports, no QwenPaw imports:
   - class StreamDiffer: `diff(key, accumulated) -> str`. Per key it stores the previous accumulated text; returns only the new suffix (`accumulated[len(prev):]`); returns "" when nothing new; if accumulated does not start with the stored prev (segment replaced), returns the whole accumulated. `reset(key)` clears one key; `clear()` clears all.
   - class SeqCounter: `next(chat) -> int` per-chat monotonic starting at 1; `peek(chat)`.
   - class RingBuffer(maxlen=400): `append(chat, seq, frame)` stores per chat (collections.deque); `since(chat, last_seq) -> list | None`: returns frames with seq > last_seq in order; returns [] if last_seq >= newest seq; returns None if last_seq is older than the oldest buffered seq minus one (miss); per-chat total byte estimate is not needed here.

2. plugin/frames.py — pure stdlib, imports from util (use a package-relative-safe import pattern that also works when loaded as top-level module by the plugin loader: try `from .util import ...` except ImportError `from util import ...`):
   - MAX_FRAME_BYTES = 256*1024; `check_size(frame: dict) -> bool` via json.dumps utf-8 length.
   - `evt_frame(chat, seq, text)`, `start_frame(chat, seq)`, `end_frame(chat, seq)`, `msg_frame(chat, seq, parts)`, `approval_frame(chat, seq, req_id, **kw)`, `resync_frame(chat)`, `error_frame(code, detail="")` — each returns the dict exactly per protocol/frames.md envelope.
   - `parse_inbound(raw: str|bytes) -> dict|None`: json parse; None unless dict with string "t".

3. plugin/tests/test_diff.py — plain-python test script (no pytest dependency; runnable as `python3 tests/test_diff.py` from plugin/ and also under pytest): sys.path inserts the plugin dir; tests StreamDiffer (basic diff, empty chunk, coalesced jump, segment reset via reset(), non-prefix replacement), SeqCounter monotonic per chat independent, RingBuffer hit/empty/miss cases. Prints "ALL PASS" and exits 0 on success, raises/exits 1 otherwise.

After writing, run via shell tool: `cd /home/hatch/workspace/qwenpaw-webchannel/plugin && python3 tests/test_diff.py` and `ls -la . tests/` — paste real outputs. Fix failures until the test script prints ALL PASS.
