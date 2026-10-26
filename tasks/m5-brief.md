# M5 brief — chunked file transfer (protocol v2), files up to 10MB

Engine: CodeBuddy CLI pinned `--model deepseek-v4.1-flash` (fallback glm-5.3-flash).
Repo AGENTS.md applies. Design the wire format into protocol/frames.md as a v2
section; v1 behaviour (small files inline in msg files[]) must keep working.

## Wire design (fixed choices — implement these, don't redesign)
- Chunk payload: 96KB of raw bytes per chunk, base64 in the frame (frame stays
  well under 256KB). Max file size: 10MB (both ends enforce).
- Client → agent frames:
  - {t:"file_begin", chat, id, name, mime, size, chunks, sha256} — opens a transfer.
  - {t:"file_chunk", chat, id, i, data} — i is 0-based; frames arrive in order
    over one WS but the plugin must assemble by index, tolerating duplicates.
  - {t:"file_end", chat, id} — client finished sending.
- Agent → client frames:
  - {t:"file_ready", chat, id} — plugin verified sha256 + size, file staged.
  - {t:"file_error", chat, id, code, msg} — code E_CHECKSUM (hash/size mismatch),
    E_TOOBIG (>10MB), E_STATE (chunk/end without begin, expired transfer).
- The msg frame then references the staged file: files[] entries may be
  {ref:"<id>"} instead of inline {name,mime,data}. Plugin resolves refs from
  its staged-files table (TTL 10 min, one-shot: consumed on use).
- Plugin staging: assemble in memory if ≤10MB is fine, or temp file in the
  workspace; on file_end verify byte count + sha256 hex; then treat exactly
  like an inline file from M2 (POST /api/console/upload → FileContent).
  A transfer that never ends is dropped after 10 min (log it).
- Relay (node + cf): NO changes required — chunks are ordinary ≤256KB frames.
  Respect the CF relay's 30 fps tenant limit: the SPA must pace chunk sends
  (e.g. await a 40ms tick between chunks, or send in small batches) and MUST
  retry the whole file once on file_error E_CHECKSUM. State this in frames.md.
- SPA: files ≤ the v1 inline threshold keep the old path; larger files (up to
  10MB) go chunked automatically with a progress indicator on the attachment
  chip; the composer waits for file_ready before enabling Send for that file;
  error text updated: single message TEXT still ≤256KB, attachments now
  ≤10MB via chunking.

## Tests (coordinator-run)
- Plugin unit tests (plain python, ALL PASS style): reassembly by index,
  duplicate chunk tolerated, sha256 mismatch → E_CHECKSUM, >10MB begin →
  E_TOOBIG, chunk without begin → E_STATE, ref resolution + one-shot consume,
  inline v1 files still pass.
- Local e2e (tests/e2e_m5.mjs) against the local stack (restart it as usual):
  generate a deterministic ~600KB random file, send file_begin/chunks/end
  through relay-node to the real local plugin, await file_ready, send a msg
  with files:[{ref}], assert the agent's reply arrives AND the staged/uploaded
  artifact on the plugin side matches the source sha256 (check via the local
  workspace upload path the plugin used; if that is not directly observable,
  assert via the plugin's own log/state hook you add for the test — document
  which).
- SPA build passes; bundle contains file_begin/file_ready strings.

## Ship
- Rebuild plugin ZIP (tools/package_plugin.sh), rebuild SPA with production
  env, redeploy SPA to Pages (connector wrangler route, --branch main).
- Relay: no redeploy (document why). Hosted plugin reinstall is done by the
  parent via the console afterwards — your job ends at: code + tests + ZIP +
  SPA deployed + docs/m5-report.md + git commit
  "M5: chunked file transfer v2".
