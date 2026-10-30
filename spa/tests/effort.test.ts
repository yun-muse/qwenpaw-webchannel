import { describe, expect, it } from 'vitest';
import {
  effortErrorAction,
  effortNeedsApply,
  pendingEffortLevel,
  shouldAdoptEffortLevel,
} from '../src/lib/effort';

describe('effortErrorAction', () => {
  it('treats a 404 as the expected "chat not created yet" state', () => {
    expect(effortErrorAction('effort-set', 404)).toBe('not-created');
    expect(effortErrorAction('effort-get', 404)).toBe('not-created');
  });

  it('keeps every other get_effort failure silent', () => {
    expect(effortErrorAction('effort-get', undefined)).toBe('get-unavailable');
    expect(effortErrorAction('effort-get', 0)).toBe('get-unavailable');
    expect(effortErrorAction('effort-get', 500)).toBe('get-unavailable');
  });

  it('makes a failed set_effort a real rejection', () => {
    expect(effortErrorAction('effort-set', 422)).toBe('rejected');
    expect(effortErrorAction('effort-set', 500)).toBe('rejected');
    expect(effortErrorAction('effort-set', undefined)).toBe('rejected');
    expect(effortErrorAction(undefined, undefined)).toBe('rejected');
  });

  it('does not silence a malformed status', () => {
    expect(effortErrorAction('effort-set', '404')).toBe('rejected');
  });
});

describe('effortNeedsApply', () => {
  it('never pushes the default level', () => {
    expect(effortNeedsApply('default', null)).toBe(false);
    expect(effortNeedsApply(undefined, 'high')).toBe(false);
  });

  it('counts an unknown server value as unconfirmed', () => {
    expect(effortNeedsApply('high', null)).toBe(true);
    expect(effortNeedsApply('high', undefined)).toBe(true);
  });

  it('is satisfied by the matching confirmed level', () => {
    expect(effortNeedsApply('high', 'high')).toBe(false);
    expect(effortNeedsApply('high', 'low')).toBe(true);
  });
});

describe('pendingEffortLevel', () => {
  it('returns the local level only while it is pending', () => {
    expect(pendingEffortLevel('high', { confirmed: null, pending: true })).toBe('high');
    expect(pendingEffortLevel('high', { confirmed: null, pending: false })).toBeNull();
    expect(pendingEffortLevel('high', undefined)).toBeNull();
  });

  it('has nothing to send for default or an already-confirmed level', () => {
    expect(pendingEffortLevel('default', { confirmed: null, pending: true })).toBeNull();
    expect(pendingEffortLevel(undefined, { confirmed: null, pending: true })).toBeNull();
    expect(pendingEffortLevel('high', { confirmed: 'high', pending: true })).toBeNull();
  });
});

describe('shouldAdoptEffortLevel', () => {
  it('adopts a server value when nothing local is pending', () => {
    expect(shouldAdoptEffortLevel('high', { pending: false }, 'default')).toBe(true);
    expect(shouldAdoptEffortLevel(undefined, undefined, 'low')).toBe(true);
  });

  it('protects a pending choice from a differing get_effort reply', () => {
    expect(shouldAdoptEffortLevel('high', { pending: true }, 'default')).toBe(false);
    expect(shouldAdoptEffortLevel('high', { pending: true }, 'low')).toBe(false);
  });

  it('adopts the confirming set_effort reply', () => {
    expect(shouldAdoptEffortLevel('high', { pending: true }, 'high')).toBe(true);
  });
});

describe('pre-creation flow', () => {
  it('keeps the choice on 404, survives a get reply, applies after the turn', () => {
    // 1. set_effort for a brand-new chat answers 404.
    const action = effortErrorAction('effort-set', 404);
    expect(action).toBe('not-created');

    // 2. The handler keeps the local level and arms the trigger.
    const pending = effortNeedsApply('high', undefined);
    expect(pending).toBe(true);
    const meta = { confirmed: null as string | null, pending };

    // 3. A later get_effort (200, server default) must not overwrite it.
    expect(shouldAdoptEffortLevel('high', meta, 'default')).toBe(false);
    expect(meta.confirmed).toBeNull();

    // 4. The completed first turn releases the deferred level.
    expect(pendingEffortLevel('high', meta)).toBe('high');

    // 5. The set reply echoes it: adopt, confirm, nothing left to send.
    expect(shouldAdoptEffortLevel('high', meta, 'high')).toBe(true);
    const confirmed = { confirmed: 'high', pending: false };
    expect(pendingEffortLevel('high', confirmed)).toBeNull();
  });

  it('a real rejection is not the expected state', () => {
    // An existing chat that refuses "max" (422) must reach the toast path.
    expect(effortErrorAction('effort-set', 422)).toBe('rejected');
    expect(effortErrorAction('effort-set', 500)).toBe('rejected');
  });
});
