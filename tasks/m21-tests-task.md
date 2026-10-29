# M21 — Test hardening (CodeBuddy task; tests + CI only, no behaviour change)

1. SPA unit tests: set up vitest in spa/ and cover the pure logic you can
   isolate WITHOUT changing behaviour (candidates: usage/token formatting,
   search snippet highlight offsets, export chunk reassembly + sha256
   verification, pin/restore helpers from M19 if present). Extracting a
   pure helper into its own module is allowed only if the import swap is
   mechanical and the build + your unit tests prove equivalence.
   Add an `npm test` script and wire it into the CI spa job in
   .github/workflows/ci.yml (keep the paths gating from 02d513b intact).
2. Relay tests in CI: probe whether tests/e2e_cf.mjs (wrangler-dev based)
   can run reliably in GitHub Actions. If it needs heavy/flaky setup, do
   NOT force it: instead add the lightest meaningful automated check you
   can (e.g. relay-node smoke test against the mock agent, node-only) wired
   into CI under the relay paths gate, and write the reasoning + the e2e_cf
   verdict into docs/m21-test-notes.md.
3. Plugin coverage gaps: list plugin modules and their existing suites;
   add plain-python assert suites (repo style, ALL PASS runner, no pytest)
   for the biggest uncovered pure logic (likely candidates: turso_search
   LIKE escaping / snippet offsets, filelog rotation, effort adaptation).
   Skip anything that needs live Turso or the hosted instance; use fakes
   in the established style.

Everything you add must pass locally: plugin suites, spa build + npm test,
relay check you chose. YAML-parse ci.yml after editing. Do NOT commit.
Report: tests added per area with counts, CI wiring, the e2e_cf verdict,
anything you deliberately left out and why.
