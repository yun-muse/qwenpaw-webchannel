# M5 SPA task — chunked file upload client (protocol v2)

You are writing product code in this repo (QwenPaw WebChannel). Read
`AGENTS.md` and `protocol/frames.md` (including its new v2 section)
first. Everything you need is inside this workspace — do not try to read
files outside it. Do NOT run shell commands; the coordinator builds and
verifies. Scope: `spa/src/App.tsx` and, only for the progress styling,
`spa/src/App.css`. Do NOT edit `spa/src/relay.ts` — inbound frames
already reach the app through its `onFrame` callback, and outbound
frames go through `client.send(frame)`.

## Background

Today the composer supports ONE attachment: it is read with FileReader
as base64 and inlined into the `msg` frame's `files[]`, and the whole
frame must fit 256 KB (`MAX_FRAME_BYTES`, checked at pick time and at
send time via `byteSize`/`oversizeError`). Protocol v2 (see frames.md)
adds chunked transfer for files up to 10 MB:

- `{t:"file_begin", chat, id, name, mime, size, chunks, sha256}` —
  sha256 = lowercase hex of the raw file bytes.
- `{t:"file_chunk", chat, id, i, data}` — 96 KB raw per chunk, base64.
- `{t:"file_end", chat, id}`
- Plugin replies `{t:"file_ready", chat, id}` or
  `{t:"file_error", chat, id, code, msg}` (codes E_CHECKSUM / E_TOOBIG /
  E_STATE).
- The `msg` then carries `files:[{ref:"<id>"}]` (one-shot ref).

## Required behaviour

1. **Path selection at pick time.** Read the picked file as an
   ArrayBuffer.
   - If the file can go inline under the CURRENT v1 rule (build the same
     probe frame as today — text + inline base64 — and `byteSize` ≤
     `MAX_FRAME_BYTES`), keep the existing inline behaviour exactly.
     To avoid base64-encoding a huge file just to probe, only attempt
     the inline probe when `file.size` is small enough that it could
     possibly fit (raw size ≲ 180 KB); larger files go straight to the
     chunked decision.
   - Else if `file.size > MAX_FILE_BYTES` (10 MB) → composer error, no
     attachment: `附件太大：单个附件上限 10MB，当前约 <fmtKb(size)>`.
   - Else → chunked upload (below), started immediately at pick time.
2. **Chunked upload.** Generate a unique transfer id per pick
   (e.g. `file-<base36 time>-<counter>`). Compute the sha256 hex with
   `crypto.subtle.digest`. Send `file_begin`, then the chunks **paced**:
   `await` a ~40 ms sleep between chunk sends (the hosted relay enforces
   30 frames/s per tenant), then `file_end`. Base64-encode each 96 KB
   slice without spreading huge arrays into `String.fromCharCode`
   (encode in small sub-slices and join).
   - The attachment chip shows progress `sent/total` chunks or a
     percent while uploading (small CSS addition allowed).
   - **Send stays disabled for that attachment until `file_ready`.**
3. **`file_ready` / `file_error` handling** (in the app's frame
   dispatch): match by transfer `id` against the pending upload;
   unknown/stale ids are ignored.
   - `file_ready` → attachment becomes ready with `ref = id`; the
     composer error (if any from this upload) clears.
   - `file_error` with `code === "E_CHECKSUM"` → **retry the whole file
     once automatically** (same id, progress restarts). A second
     failure, or any other code → composer error showing the code/msg,
     attachment marked failed; Send blocked until the user removes or
     re-picks the file.
   - **Timeout:** if neither `file_ready` nor `file_error` arrives
     within 60 s of `file_end` being sent → composer error
     `文件传输超时：插件未确认收到（可能插件版本不支持分片传输）`,
     attachment failed as above. Clear the timer on ready/error/remove.
4. **Cancellation.** Removing the attachment chip, switching chats, or
   starting a new chat cancels a pending upload: stop the pacing loop
   (a cancelled flag the loop checks), clear the timer, and ignore late
   `file_ready`/`file_error` for that id. (The existing code already
   clears the attachment on chat switch/new chat — hook the cancel in.)
5. **Sending.** `send()`:
   - inline attachment → `files:[{name, mime, data}]` (unchanged);
   - chunked + ready attachment → `files:[{ref: id}]`;
   - the `msg` frame itself still goes through the existing
     `byteSize` ≤ `MAX_FRAME_BYTES` check with the existing
     `oversizeError` text (message TEXT rule unchanged);
   - `canSend` must be false while a chunked upload is in flight or
     failed, true once ready (plus the existing text/attachment rule).
   The optimistic user bubble keeps showing the attachment name as today.
6. **Wording.** Attach button title becomes
   `Attach a file (≤ 10 MB via chunked upload; message ≤ 256 KB)`.
   Keep the v1 `oversizeError` text for oversize message frames.

Keep the diff focused: one attachment at a time (as today), no relay.ts
changes, no new dependencies. TypeScript must stay clean (the
coordinator runs `npm run build`).
