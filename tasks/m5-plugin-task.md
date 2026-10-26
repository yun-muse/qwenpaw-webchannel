# M5 plugin task — chunked file transfer (protocol v2), plugin side + protocol doc

You are writing product code in this repo (QwenPaw WebChannel). Read
`AGENTS.md` first and obey it (pure helpers live ONLY in `plugin/util.py`;
`plugin/frames.py` re-exports; tests are plain-python assert scripts that
print `ALL PASS`). Everything you need is inside this workspace — do not
try to read files outside it. Do NOT run shell commands; the coordinator
runs all tests.

## 1. protocol/frames.md — document protocol v2

Add a v2 section (and the small table updates) describing chunked file
transfer exactly as specified in §2–§4 below:

- New rows in §2.4 (browser → container): `file_begin`, `file_chunk`,
  `file_end`. New rows in §2.3 (container → browser): `file_ready`,
  `file_error`.
- §5 limits: add a file-size row — inline `msg.files[]` data stays bound by
  the 256 KB frame rule; chunked transfer allows one file up to **10 MB**.
- §7: v2 frames are additive new `t` values (no negotiation); an endpoint
  that does not know them ignores them, so a client waiting for
  `file_ready` from a v1 plugin must time out instead of hanging forever.

## 2. Wire format (fixed — implement exactly this)

- Chunk payload: **96 KB of raw bytes** per chunk, base64 in the frame.
  Max file size **10 MB**, enforced by both ends.
- Client → agent:
  - `{t:"file_begin", chat, id, name, mime, size, chunks, sha256}` —
    `sha256` is the lowercase hex digest of the raw file bytes; `chunks`
    is the number of `file_chunk` frames that will follow.
  - `{t:"file_chunk", chat, id, i, data}` — `i` is 0-based; `data` is
    base64 of that chunk's raw bytes.
  - `{t:"file_end", chat, id}` — client finished sending.
- Agent → client:
  - `{t:"file_ready", chat, id}` — sha256 + size verified, file staged.
  - `{t:"file_error", chat, id, code, msg}` — `code` ∈ `E_CHECKSUM`
    (hash/size mismatch, incl. missing chunks at `file_end`),
    `E_TOOBIG` (declared or accumulated size > 10 MB), `E_STATE`
    (chunk/end without begin, expired transfer, malformed frame).
- After `file_ready`, the `msg` frame references the staged file:
  `files[]` entries may be `{ref:"<id>"}` instead of inline
  `{name, mime, data}`. Refs are **one-shot** (consumed on use) and staged
  files expire after **10 minutes**.
- The relay needs no changes (chunks are ordinary ≤256 KB frames), but the
  hosted relay enforces 30 frames/s per tenant, so clients pace chunk
  sends (~40 ms tick between chunks) and retry the whole file **once** on
  `E_CHECKSUM`. State this in frames.md.

## 3. plugin/util.py — pure transfer state machine

Add (stdlib only — `hashlib`, `base64`, `binascii`; NO new third-party or
QwenPaw imports):

- Constants: `MAX_FILE_BYTES = 10 * 1024 * 1024`,
  `CHUNK_RAW_BYTES = 96 * 1024`, `TRANSFER_TTL_S = 600`.
- `class FileTransfers` — in-progress assemblies + the staged store. Every
  method takes an explicit `now` (float seconds) so tests control time.
  Internal state must bound memory: never hold more than
  `MAX_FILE_BYTES` of chunk bytes per transfer.
  - `begin(tid, meta, now) -> (ok: bool, code: str | None)`
    `meta` is the raw frame dict. Validate: `size` is an int with
    `0 < size <= MAX_FILE_BYTES` (`size > MAX_FILE_BYTES` →
    `(False, "E_TOOBIG")`; missing/non-int/non-positive size, bad
    `chunks` (not an int ≥ 1) or a `sha256` that is not 64 lowercase/any-case
    hex chars → `(False, "E_STATE")`). `name`/`mime` default exactly like
    `decode_file_entry` (name `"file"`, mime
    `"application/octet-stream"`). A `begin` for an id that already exists
    (in-progress OR staged) restarts that transfer from scratch — this is
    what makes the client's whole-file retry work with the same id.
  - `chunk(tid, index, data_b64, now) -> (ok, code)`
    Unknown/expired id → `E_STATE`. `index` not an int or outside
    `[0, chunks)` → `E_STATE` **and drop the transfer**. `data_b64` not
    valid base64 → `E_STATE` and drop. A repeated index overwrites (last
    wins; retransmits are the normal duplicate case) — the final sha256
    check is the arbiter. If the sum of stored chunk bytes exceeds
    `MAX_FILE_BYTES` → `E_TOOBIG` and drop.
  - `end(tid, now) -> (ok, code, info)`
    Unknown id → `(False, "E_STATE", None)`. Otherwise assemble by index:
    any missing index, assembled length ≠ declared `size`, or sha256 of
    the assembled bytes ≠ declared digest → `(False, "E_CHECKSUM", None)`
    and drop. On success move the bytes to the staged store with the
    begin-time `name`/`mime`, stamp the staged time, and return
    `(True, None, {"name": ..., "mime": ..., "size": ...})`.
  - `take(tid, now) -> (name, mime, data) | None`
    One-shot: pop a staged entry; missing or staged longer ago than
    `TRANSFER_TTL_S` → `None`.
  - `purge(now) -> list[str]`
    Drop in-progress transfers whose begin is older than the TTL and
    staged entries older than the TTL; return the dropped in-progress
    ids (the channel logs them). `begin`/`chunk`/`end`/`take` must also
    treat expired entries as absent (lazy expiry is fine).

## 4. plugin/frames.py — frame builders

- `file_ready_frame(chat, transfer_id, seq=None)` →
  `{"t":"file_ready","chat":chat,"id":transfer_id}` (+`seq` when given).
- `file_error_frame(chat, transfer_id, code, msg="", seq=None)` →
  `{"t":"file_error","chat":chat,"id":transfer_id,"code":code}` (+`msg`
  when non-empty, +`seq` when given).
- Re-export `FileTransfers`, `MAX_FILE_BYTES`, `CHUNK_RAW_BYTES`,
  `TRANSFER_TTL_S` from `util` the same way `RingBuffer` etc. are
  re-exported, and add everything new to `__all__`.

## 5. plugin/channel.py — wire it in

- Import the new names (both import branches), instantiate
  `self._files = FileTransfers()` in `__init__`, use `time.monotonic()`
  as `now`.
- Route `file_begin` / `file_chunk` / `file_end` in `_on_relay_frame` to
  three new thin handlers. Common behaviour:
  - Extract `chat` (`str(frame.get("chat") or "default")`) and `id`.
    If `id` is missing or not a non-empty string, log a warning and drop
    the frame (there is nothing to address a reply to).
  - Call `self._files.purge(now)` first in each handler (and in
    `_handle_msg`); log purged in-progress ids at WARNING
    (`webchannel: dropped expired file transfer id=%s`).
  - On a `(False, code)` result, reply via `self._emit(chat, ...)` with
    `file_error_frame(chat, tid, code, <short human msg>, seq=seq)`.
    On `end` success, reply via `_emit` with `file_ready_frame`.
    Successful begin/chunk send NO reply.
- Refactor `_upload_file`: extract the POST + `FileContent` construction
  into `async def _store_file(self, chat, name, mime, data)` returning
  `Optional[FileContent]` (same logging style, same timeout/headers).
  `_upload_file(chat, entry)` keeps its exact current contract: decode
  via `decode_file_entry`, then delegate to `_store_file`.
- In `_handle_msg`, each `files[]` entry goes through a new
  `async def _resolve_file_entry(self, chat, entry)`:
  - dict with a string `ref` and no `data` → `self._files.take(ref, now)`;
    `None` → log a warning (unknown/expired/consumed ref) and skip the
    entry; otherwise `_store_file(chat, name, mime, data)`.
  - anything else → `_upload_file(chat, entry)` (v1 inline, unchanged).
- Update the module docstring's first paragraph to mention v2 chunked
  transfers briefly. Also add a short "File transfer (protocol v2)"
  section to `plugin/README.md` (check its current structure first).

## 6. plugin/tests/test_m5.py — unit tests

Plain-python, same runner style as `plugin/tests/test_m2.py` (functions
named `test_*`, a `main()` that prints `ok`/`FAIL` lines and `ALL PASS`).
Drive `FileTransfers` directly with synthetic `now` values and small
payloads (build chunk base64 from a deterministic byte string; compute
the expected sha256 with hashlib in the test). Cover at least:

- reassembly by index with chunks arriving OUT OF ORDER → `end` ok,
  `take` returns the exact original bytes/name/mime;
- duplicate chunk (identical retransmit) tolerated → `end` ok;
- sha256 mismatch → `end` gives `E_CHECKSUM`;
- declared size ≠ assembled length → `E_CHECKSUM`;
- a missing chunk at `file_end` → `E_CHECKSUM`;
- `begin` with size > 10 MB → `E_TOOBIG`;
- `chunk` without `begin` → `E_STATE`; `file_end` without `begin` →
  `E_STATE`;
- chunk index out of range → `E_STATE`;
- one-shot refs: `take` returns the entry once, second `take` → None;
  `take` of an unknown id → None;
- TTL: staged entry taken after TTL → None; in-progress transfer purged
  after TTL (`purge` returns its id; a later chunk → `E_STATE`);
- v1 inline path untouched: `decode_file_entry` still decodes a normal
  inline entry;
- frame builders: exact dict shapes of `file_ready_frame` /
  `file_error_frame` (with and without `seq`/`msg`).

Deliverables: edited `protocol/frames.md`, `plugin/util.py`,
`plugin/frames.py`, `plugin/channel.py`, `plugin/README.md`, and new
`plugin/tests/test_m5.py`. Nothing else. Do not edit the SPA or relays.
