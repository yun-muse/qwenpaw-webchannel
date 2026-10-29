# M21 — test hardening notes

Scope: tests and CI only, no behaviour change. This document records what was
added, how it is wired, the `e2e_cf` verdict, and what was deliberately left
out.

## SPA unit tests (vitest)

`spa/` now has vitest (`vitest run` behind `npm test`) and four suites over the
pure helpers in `spa/src/lib/`. Tests live in `spa/tests/` (outside the
`tsconfig.json` `include: ["src"]` used by `npm run build`, so the production
type-check stays unchanged).

| Suite | Tests | Covers |
|---|---:|---|
| `spa/tests/usage.test.ts` | 13 | `formatTokens` / `formatExact`, `turnUsageOf` (all-or-nothing receipts), `turnTitle`, `usageOf` (absent fields stay absent, no invented zeros) |
| `spa/tests/search.test.ts` | 9 | `searchHitsOf` row validation, `snippetParts` UTF-16 offsets with astral characters, not-located/out-of-range fallbacks |
| `spa/tests/export.test.ts` | 19 | `hexOf`, base64 encode/decode (including the 32 KB slice loop), `exportFileName` (illegal characters, 50-code-point truncation, surrogate safety), `verifyExport` reassembly + byte count + SHA-256 (success, missing/decode/size/crypto/digest failures, upper-case digest) |
| `spa/tests/chatState.test.ts` | 18 | `persistedChats` malformed storage, `restoreSession` active-chat fallback, `newestServerChat`, pin toggle order and prune identity |

Total: **59 tests in 4 files**.

The helpers were moved out of `App.tsx` into `spa/src/lib/{usage,search,export,
chatState}.ts` with a mechanical import swap; the component code now imports
them. `export.ts` also owns the reassembly/verification core that used to be
inline in `finishExport`, so the tests exercise the shipped path rather than a
copy. `npm run build` (`tsc --noEmit && vite build`) still passes.

## Plugin suites

Existing coverage by module (before M21):

| Module | Existing suites |
|---|---|
| `frames.py` | `test_diff.py` (StreamDiffer, SeqCounter, RingBuffer, frame builders) |
| `util.py` (history/approval/usage/export/effort) | `test_diff.py`, `test_m2.py`, `test_m11.py`, `test_m12.py`, `test_m15.py`, `test_m9.py` |
| `channel.py` (handlers) | `test_m2.py`, `test_m5.py`, `test_m7.py`, `test_m8.py`, `test_m9.py`, `test_m11.py`, `test_m12.py`, `test_m13.py`, `test_m15.py` |
| `relay_client.py` | `test_m71.py`, `test_m72.py`, `test_m73.py` |
| `filelog.py` | `test_m72.py` (lifecycle events + one aggregate rotation check) |
| `turso_archive.py` | `test_turso.py` |
| `turso_search.py` | `test_m13.py` (LIKE escaping, snippet offsets, happy-path searcher) |
| `plugin.py` | none (host registration only) |

Added, in the repo style (plain asserts, `ALL PASS` runner, no pytest):

| Suite | Tests | Why this gap |
|---|---:|---|
| `plugin/tests/test_filelog.py` | 20 | `test_m72` only asserted "some file rotated". This pins the log line format, sanitising, exact backup chain (`.log.1`/`.log.2`), `backups=0/1`, disabled rotation (`max_bytes <= 0`), an oversized first record, hostile paths (directory / parent-is-file), a value whose `str()` raises, Unicode and lone surrogates, and threaded writes |
| `plugin/tests/test_search_edges.py` | 22 | adds the uncovered `turso_search` edges: empty/non-string queries, radius 0, whitespace mismatch, astral characters inside the match, ASCII-only folding (Turkish `İ`), and the full malformed-pipeline taxonomy (`_result_rows` shapes, broken count vs page half, transport failures, non-integer totals, short rows, title/role/content fallbacks, combined backslash+wildcard escaping) |
| `plugin/tests/test_relay_pure.py` | 22 | relay_client's decision helpers: compact UTF-8-safe `_encode`, `_task_detail`, `_is_auth_error` (401/403 from either attribute), `_note_close_code` (4000 first wins, `ConnectionClosed` and generic exceptions), `_requeue` order, oversize/non-dict/queue-full `send`, and the `session`/`started_us` generation invariants |

Total: **64 tests in 3 files**; the full plugin loop now runs **17 suites**.

### Deliberately not added

- **Effort adaptation**: already covered end to end by `test_m9.py` (budget
  ladder, reverse mapping, `effort_supported`, `effort_view_fields`, both
  handlers, error shapes, control-frame classification). A new suite would
  duplicate it.
- **`turso_search` LIKE escaping**: already covered by `test_m13.py`; the new
  suite only adds the backslash+wildcard combination and the malformed
  responses.
- **Live Turso / hosted relay**: skipped by design; all transports are fakes,
  matching the existing suites.
- **`turso_search._httpx_transport`**: the real `httpx.AsyncClient` call stays
  uncovered; testing it would need a local HTTP server and would only re-test
  httpx.

## CI wiring

`.github/workflows/ci.yml` changes (paths gating from 02d513b untouched):

- `spa` job renamed `spa (build + unit tests)`; after `npm run build` it runs
  `npm test` (vitest).
- New `relay-node` job under the existing `relay` paths filter: `npm ci` and
  `npm test` (`relay-node/test/smoke.mjs`). This is the lightest meaningful
  relay check: it spawns the real `relay-node/server.js`, uses real WebSocket
  peers, and asserts routing, in-order evt frames, offline buffering,
  generation gating (4000 for stale hellos) and health.
- `plugin` job unchanged: its `for suite in tests/test_*.py` loop picks up the
  three new suites automatically.
- `relay-cf` typecheck unchanged.

`tests/e2e.mjs` (relay-node + `mock/mock_agent.mjs` + a browser-style client)
also passes locally, but it lives under `tests/**`, which belongs to the plugin
gate. Wiring it into the relay job would require moving/altering the paths
filters, and the brief asked to keep that gating intact; the relay-node smoke
suite covers the same relay semantics and lives under `relay-node/**`.

The workflow was YAML-parsed after editing (`yaml.safe_load`): jobs are
`changes`, `plugin`, `spa`, `relay-node`, `relay-cf`, with `plugin` gated on
`changes.outputs.plugin`, `spa` on `.spa`, and both relay jobs on `.relay`.

## `tests/e2e_cf.mjs` verdict

**Not wired into CI.** It is a real, working local harness — probing it with
wrangler 4.153.0 (`wrangler dev --local --port 8788`) passed 3/3 times from a
clean `relay-cf/.wrangler/state`, ~9 s per run, all 10 assertions including
`AGENT-LAST-SEEN` and `GENERATION`. The reasons not to promote it to CI:

1. **Gitignored inputs.** It reads `relay-cf/.dev.vars` unconditionally. CI
   would have to synthesize the file from `.dev.vars.example` first; a plain
   checkout fails before the first assertion.
2. **Wall-clock assertions.** The harness is built from fixed sleeps
   (400–1200 ms), a 40-frame burst that must overflow the per-tenant rate
   bucket (`RATE-LIMIT` asserts both "some delivered" and ">= 1 E_BUSY"), and a
   warm-up phase whose only job is to flush durable storage left by earlier
   sections. On a loaded or shared runner those windows can flip; local green
   runs do not prove CI stability.
3. **Long-lived workerd child + fixed port.** It needs a background `wrangler
   dev` on `:8788` and kills it afterwards. Workerd teardown is the classic
   zombie/port-race source, and unlike `tests/e2e_m19.mjs` the harness has no
   "port already taken" pre-check, so a stray process would fake the result.
4. **Cost vs. signal.** The relay-node smoke test already covers routing,
   order, buffering and generations deterministically with one small `ws`
   dependency. Adding workerd startup to every relay-gated PR buys Cloudflare
   emulation, not new relay-node coverage.

Manual recipe (unchanged, for release checks):

```sh
cp relay-cf/.dev.vars.example relay-cf/.dev.vars   # if missing
rm -rf relay-cf/.wrangler/state                    # start from an empty DO
(cd relay-cf && ./node_modules/.bin/wrangler dev --local --port 8788)
node tests/e2e_cf.mjs                              # expects :8788
```

## Verification

All run locally on 2026-10-29:

- `cd spa && npm run build` — pass (`tsc --noEmit` + vite build).
- `cd spa && npm test` — 4 files, **59 passed**.
- Plugin loop over `plugin/tests/test_*.py` — **17/17 ALL PASS** (using the
  venv with `httpx`/`websockets`/QwenPaw, as the repo suites require).
- `cd relay-node && npm test` — `PASS`.
- `python -c "yaml.safe_load(open('.github/workflows/ci.yml'))"` — parses; job
  list and gates verified.

## Left out overall

- **DOM/component tests** (`App.tsx`, `ContextMeter`, search panel): would
  require adding jsdom and asserting markup instead of logic; the brief asked
  for pure logic without behaviour change, so only extracted helpers are
  tested.
- **Browser E2E** (`tests/e2e_m19.mjs`, `tests/mobile_e2e.mjs`): still manual
  suites; they need a built SPA, relay-node and a real browser.
- **Live integrations** (Turso, hosted relay, QwenPaw HTTP API): fakes only,
  consistent with every existing plugin suite.
