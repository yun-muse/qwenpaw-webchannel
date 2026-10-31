/**
 * M40 test-artifact policy — one place that decides where a suite writes.
 *
 * Default: every run writes under the gitignored `tests/out/`, so a suite
 * never dirties the work tree. The tracked `tests/*-shots/` images and
 * `tests/e2e_*.frames.log` files are frozen curated evidence: only an
 * explicit evidence run (`EVIDENCE=1`) writes back to those paths. An
 * explicit per-suite override (OUT_DIR / LOG_FILE / M32_OUT / M37_OUT)
 * always wins, which is what the historical M26 `before/after` commands use.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const OUT_ROOT = join(TESTS_DIR, 'out');
export const EVIDENCE = process.env.EVIDENCE === '1';

function pick(rel, explicit) {
  if (explicit) return resolve(TESTS_DIR, explicit);
  return EVIDENCE ? join(TESTS_DIR, rel) : join(OUT_ROOT, rel);
}

/** Directory for screenshots; created if missing. */
export function artifactDir(rel, explicit) {
  const dir = pick(rel, explicit);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Single file (frames log, JSON report, screenshot); parent created. */
export function artifactFile(rel, explicit) {
  const file = pick(rel, explicit);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}
