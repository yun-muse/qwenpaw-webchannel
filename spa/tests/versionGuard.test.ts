import { describe, expect, it } from 'vitest';
import {
  RELOAD_COOLDOWN_MS,
  RETRY_AFTER_MS,
  decideUpdate,
} from '../src/lib/versionGuard';

const NOW = 1_800_000_000_000;

function state(extra: Partial<Parameters<typeof decideUpdate>[0]> = {}) {
  return {
    remoteBuild: 'build-b',
    localBuild: 'build-a',
    reloadedFor: null,
    lastReloadAt: 0,
    now: NOW,
    ...extra,
  };
}

describe('decideUpdate', () => {
  it('ignores an empty probe answer and the current build', () => {
    expect(decideUpdate(state({ remoteBuild: '' }))).toBe('ignore');
    expect(decideUpdate(state({ remoteBuild: '  ' }))).toBe('ignore');
    expect(decideUpdate(state({ remoteBuild: 'build-a' }))).toBe('ignore');
  });

  it('updates on the first mismatch', () => {
    expect(decideUpdate(state())).toBe('update');
  });

  it('banners instead of reloading twice for the same build', () => {
    expect(
      decideUpdate(state({ reloadedFor: 'build-b', lastReloadAt: NOW - 1_000 })),
    ).toBe('banner');
  });

  it('retries the same build after the retry window', () => {
    expect(
      decideUpdate(state({ reloadedFor: 'build-b', lastReloadAt: NOW - RETRY_AFTER_MS - 1 })),
    ).toBe('update');
  });

  it('backs off any reload inside the 60s cooldown', () => {
    expect(
      decideUpdate(state({ reloadedFor: 'build-old', lastReloadAt: NOW - 1_000 })),
    ).toBe('banner');
    expect(
      decideUpdate(state({ reloadedFor: 'build-old', lastReloadAt: NOW - RELOAD_COOLDOWN_MS + 1 })),
    ).toBe('banner');
    expect(
      decideUpdate(state({ reloadedFor: 'build-old', lastReloadAt: NOW - RELOAD_COOLDOWN_MS - 1 })),
    ).toBe('update');
  });

  it('treats a future timestamp as recent (clock rollback)', () => {
    expect(decideUpdate(state({ lastReloadAt: NOW + 60_000 }))).toBe('banner');
  });

  it('ignores an unusable timestamp', () => {
    expect(decideUpdate(state({ lastReloadAt: Number.NaN }))).toBe('update');
    expect(decideUpdate(state({ lastReloadAt: -5 }))).toBe('update');
  });

  it('honours test overrides for both windows', () => {
    expect(
      decideUpdate(
        state({ reloadedFor: 'build-b', lastReloadAt: NOW - 500, cooldownMs: 1, retryAfterMs: 1 }),
      ),
    ).toBe('update');
  });
});
