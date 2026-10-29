# M18 — CI + repo hygiene (CodeBuddy task)

Scope: .github/, .gitignore, docs notes. No product-code changes (if a test
fails because of a real bug, report it — do not fix product code in this task).

1. GitHub Actions workflow `.github/workflows/ci.yml`, on push + PR:
   - plugin tests: run every plain-python suite under plugin/tests/
     (they are assert scripts with main() printing ALL PASS; no pytest).
   - spa: npm ci + npm run build.
   - relay-cf: npm ci + typecheck/build if its package.json defines one;
     otherwise `npx tsc --noEmit` if tsconfig supports it — check first.
   Use current action versions and reasonable Node/Python versions matching
   the projects' own config files.
2. Hygiene audit (read-only checks, report findings):
   - `git ls-files` scan: no .secrets/, no .env with real values, no tokens
     in tracked files (note: docs/m1-report.md contains a RETIRED local-dev
     token, already accepted by the owner — flag it, do not rewrite history).
   - .gitignore covers .secrets/, node_modules, dist artifacts that should
     not be tracked; add only clearly-missing entries.
3. After CI exists, append the CI badge line to the root README.md
   (workflow name must match) — if root README does not exist yet, skip
   and say so (M16 may not have landed).

Validate the workflow YAML by parsing it locally. Do NOT commit.
Report: workflow jobs, audit findings, any failing suite with output.
