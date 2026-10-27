# M5 report — protocol v2 chunked file transfer (10 MB attachments)

Status: **M5 COMPLETE locally + SPA deployed publicly.** The hosted plugin
reinstall (parent, via the console) is the only step left; the public SPA
already speaks v2, and against a v1 container it degrades exactly as designed
(chunked picks time out after 60 s with the "plugin may not support chunked
transfer" message; small files keep the v1 inline path).

Coding split (per the standing rule): all product code by **CodeBuddy CLI**
pinned `--model deepseek-v4.1-flash` — plugin session `01a179b9` (120 model
entries, all deepseek-v4.1-flash), SPA session `01a179bd` (127 entries, all
deepseek-v4.1-flash). Specs: `tasks/m5-plugin-task.md`, `tasks/m5-spa-task.md`
(written by Muse from `tasks/m5-brief.md`). Every claim below was verified
by Muse on disk / by re-running, not from session self-reports. **The relay
(node + CF) is unchanged**, as designed.

## Design as implemented

Wire format = protocol §8 (added to `protocol/frames.md`, with §2.3/§2.4 table
rows, the §5 file-size row, and a §7 additive-versioning note incl. the
v1-timeout warning):

- Client → agent: `file_begin{chat,id,name,mime,size,chunks,sha256}` →
  `file_chunk{chat,id,i,data}` ×N (96 KB raw per chunk, base64 in the frame,
  ~128 KB on the wire — well inside the 256 KB frame rule) → `file_end{chat,id}`.
- Agent → client: `file_ready{chat,id}` once the assembled bytes match the
  declared size **and** sha256, else `file_error{chat,id,code,msg}` with
  `code` ∈ `E_CHECKSUM` / `E_TOOBIG` / `E_STATE`.
- `msg.files[]` gains `{"ref": "<id>"}`: one-shot, 10-minute TTL.

Plugin (`plugin/util.py`, `frames.py`, `channel.py`):

- `FileTransfers` (pure, in `util.py`; every method takes an explicit `now`):
  begin validates metadata (size > 10 MB → `E_TOOBIG`; malformed
  size/chunks/sha256 → `E_STATE`; begin on an existing id restarts it — that is
  what makes the client's whole-file retry work); chunks assemble by index,
  duplicates overwrite (last wins), bad index/base64 → `E_STATE` + drop,
  accumulated bytes > 10 MB → `E_TOOBIG` + drop; end → missing chunk /
  length ≠ size / sha mismatch all → `E_CHECKSUM` + drop, success stages the
  file; `take` is one-shot with TTL; `purge` drops expired in-progress ids
  (returned for logging) and staged ids (silently). Lazy expiry in every
  method, so nothing depends on a timer.
- `channel.py`: routes the three new frame types, purges (with a WARNING log
  per dropped transfer) in each file handler and in `_handle_msg`, replies via
  `_emit` (so `file_ready`/`file_error` carry `seq` and are ring-buffer
  replayable), drops frames with a missing/non-string `id` after logging.
  `_store_file(chat, name, mime, data)` was factored out of `_upload_file`, so
  a verified chunked file goes through the exact v1 path
  (`POST /api/console/upload` → `FileContent`); `_resolve_file_entry` consumes
  `ref` entries and logs + skips unknown/expired/consumed refs.

SPA (`spa/src/App.tsx` + a progress-bar block in `App.css`; `relay.ts`
untouched):

- Pick-time path selection: raw size ≤ ~180 KB → build the exact v1 probe
  frame and go inline iff it fits 256 KB; size > 10 MB → error
  「附件太大：单个附件上限 10MB，当前约 <size>」 and no attachment; otherwise
  chunked automatically. Message **text** keeps the v1 256 KB rule, with the
  M4-unified wording.
- Chunked uploads start at pick time: id `file-<base36>-<counter>`, sha256 via
  `crypto.subtle`, chunks paced one per ~40 ms (the CF relay caps 30 fps per
  tenant), base64 built in 32 KB sub-slices. The chip shows `sent/chunks` +
  a progress bar; Send is disabled until `file_ready` (then the message sends
  `files:[{ref:id}]`).
- `file_error` with `E_CHECKSUM` retries the whole file **once** with the same
  id; any other code (or a second failure) → composer error + failed chip,
  Send blocked until the attachment is removed/re-picked. 60 s without a reply
  to `file_end` → 「文件传输超时：插件未确认收到（可能插件版本不支持分片传输）」.
  Removing the chip, switching/new chat, or picking another file cancels the
  transfer (pacing loop stops, watchdog cleared, late frames ignored by id).

## Test evidence (all run by Muse)

Plugin unit tests (plain-python assert scripts):

- `plugin/tests/test_m5.py` — **28/28 ALL PASS**: out-of-order reassembly,
  duplicate tolerance, `E_CHECKSUM` (sha mismatch, missing chunk, declared
  size mismatch), `E_TOOBIG` at begin, `E_STATE` (chunk/end without begin,
  bad index, bad base64), one-shot `take`, staged TTL, in-progress purge,
  begin-restarts-id, case-insensitive sha256, name/mime defaults, v1 inline
  decode regression, exact `file_ready`/`file_error` builder shapes, and a
  check that a max-size chunk frame stays inside the wire limit.
- Regressions: `test_diff.py` ALL PASS, `test_m2.py` ALL PASS;
  `py_compile` clean on all plugin modules.

Local e2e (`tests/e2e_m5.mjs`, relay-node :8787 + local QwenPaw :8088 with the
M5 plugin hot-installed; deterministic seeded 614,400-byte file = 7 chunks,
sha256 computed by the harness):

- N1 chunk without begin → `file_error E_STATE` ✅
- N2 begin with size = 10 MB + 1 → `E_TOOBIG` ✅
- N3 chunks + end with a wrong sha256 → `E_CHECKSUM` ✅
- M1 good transfer → `file_ready` ✅
- M1b `msg` with `files:[{ref}]` → the real (Kilo) agent replied ✅
- M2 **sha256 assertion route**: the harness snapshots the local console media
  dir (`~/workspace/qwenpaw-local/home/workspaces/default/media`) before/after,
  finds the single new file of exactly 614,400 bytes, and compares its sha256
  to the source file's — **match** (`28184ff6837b44dab8c5e4674ee67c35_m5.bin`)
  ✅. This proves the assembled bytes reached the agent byte-identical without
  trusting any "agent saw the file" self-report.
- Verdict line: `E2E_M5 PASS (mandatory assertions)`; frames in
  `tests/e2e_m5.frames.log`.

Regression e2e (`tests/e2e_m2.mjs`) against the M5 plugin: **E2E_M2 PASS** —
trailing msg equality (62 evt frames), hist round-trip, v1 inline file attach,
mid-stream resume (81 frames redelivered, assembled == trailing), bogus
approve rejected `E_AUTH`. The approval stretch goal remains untriggered (no
guard config — unchanged since M3, user declined tool_guard on 2026-10-27).

## Packaging & deploy

- Plugin ZIP rebuilt: `dist/webchannel.zip`, **29,894 bytes** (M3: 24,939),
  allowlist unchanged (7 files, tests never packaged).
- SPA built with the production env (`VITE_RELAY_WS`/`VITE_RELAY_HTTP` → the
  CF relay): JS 235.40 kB / gzip 77.67 kB. Bundle greps: `file_begin`,
  `file_chunk`, `file_end`, `file_ready`, `file_error`, `E_CHECKSUM`,
  「单个附件上限 10MB」, 「文件传输超时」, and the production wss URL all present.
- Pages deploy via wrangler through the Cloudflare connector (surrogate in a
  shell variable only): deployment
  https://af378334.qwenpaw-webchannel-spa.pages.dev. Production root verified
  after propagation: HTTP 200, serves `assets/index-DmR6jk0O.js` — the same
  hash as the local build — containing the v2 strings and the production wss
  URL.

## Hosted completion (2026-10-27, by Muse)

- The M5 plugin ZIP (29,894 B) was installed on the hosted `work` agent via the
  console (uninstall old → install new; direct reinstall is refused with
  "already loaded"). After the channel off/on toggle the agent showed online
  and the relay health agreed, but it **never replied to messages** — the
  channel was wedged (WS connected, frames in, nothing processed). A full
  platform **Restart** fixed it: plugin + channel config persisted, the agent
  reconnected, chat replies resumed. Lesson: after a hosted plugin
  uninstall/reinstall, restart the instance instead of trusting the toggle.
- Public end-to-end (browser → CF relay → hosted container) then PASSED:
  connectivity reply ok; a 614,400-byte file sent from the public SPA arrived
  byte-identical — the agent's own `sha256sum` returned
  751a00fcda127f2f8485b0c86608da30ed97d2fe6f1392f87aa906c20747e4ad, matching the
  source file, size 614,400. M5 is fully closed.

## Deviations / notes

- `file_ready`/`file_error` go through the plugin's `_emit`, so they carry a
  `seq` (the protocol marks `seq?` optional on both). Harmless for the client
  (relay.ts dedupes by seq) and makes the replies replayable after a resume.
- The SPA paces **every** chunk with a ~40 ms sleep, including the first one
  right after `file_begin` (spec: "pacing between chunks"). The transfer is
  marginally more conservative than required; ordering and fps compliance are
  unaffected.
- The SPA chunked flow is verified by code inspection + bundle greps + the
  protocol-level e2e above; like the M4 restore fix, it was **not**
  click-tested in a live browser (no browser automation in this environment).
  The wire behavior the SPA must produce is exactly what `tests/e2e_m5.mjs`
  drives against the real plugin.
- One wrangler-route correction vs the connector doc: the current
  `dynamic_credentials.dynamic_credential_entry()` returns the entry dict
  directly (use `entry["surrogate"]`), not a nested `response` payload. The
  doc snippet should be updated.
- Public end-to-end (browser → CF relay → hosted container) can only be
  exercised after the parent reinstalls the M5 plugin ZIP on the hosted
  `work` agent; until then the hosted side is still v1 and chunked picks from
  the public SPA will hit the designed 60 s timeout path.
