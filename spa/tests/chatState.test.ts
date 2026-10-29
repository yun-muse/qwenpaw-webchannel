import { describe, expect, it } from 'vitest';
import {
  ACTIVE_KEY,
  CHATS_KEY,
  PINS_KEY,
  newestServerChat,
  persistedChats,
  prunePins,
  restoreSession,
  togglePin,
} from '../src/lib/chatState';
import type { ReadonlyStorage } from '../src/lib/chatState';

function storageOf(entries: Record<string, string>): ReadonlyStorage {
  return {
    getItem: (key: string) => (key in entries ? entries[key] : null),
  };
}

describe('persistedChats', () => {
  it('returns the stored id list and drops unusable entries', () => {
    const storage = storageOf({
      [CHATS_KEY]: JSON.stringify(['a', '', 3, null, 'b']),
    });
    expect(persistedChats(CHATS_KEY, storage)).toEqual(['a', 'b']);
  });

  it('treats a missing, non-array or corrupt value as empty', () => {
    expect(persistedChats(CHATS_KEY, storageOf({}))).toEqual([]);
    expect(persistedChats(CHATS_KEY, storageOf({ [CHATS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(persistedChats(CHATS_KEY, storageOf({ [CHATS_KEY]: 'not json' }))).toEqual([]);
    expect(persistedChats(CHATS_KEY, storageOf({ [CHATS_KEY]: 'null' }))).toEqual([]);
  });

  it('reads the pins key independently from the chat key', () => {
    const storage = storageOf({
      [CHATS_KEY]: '["chat-a"]',
      [PINS_KEY]: '["chat-b","chat-a"]',
    });
    expect(persistedChats(PINS_KEY, storage)).toEqual(['chat-b', 'chat-a']);
  });

  it('survives a storage that throws', () => {
    const broken: ReadonlyStorage = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(persistedChats(CHATS_KEY, broken)).toEqual([]);
  });
});

describe('restoreSession', () => {
  it('restores the saved active chat when it is still listed', () => {
    const storage = storageOf({
      [CHATS_KEY]: '["a","b"]',
      [ACTIVE_KEY]: 'b',
    });
    expect(restoreSession(storage, () => 'new')).toEqual({
      chats: ['a', 'b'],
      active: 'b',
      restored: true,
    });
  });

  it('falls back to the first chat when the saved one is gone', () => {
    const storage = storageOf({
      [CHATS_KEY]: '["a","b"]',
      [ACTIVE_KEY]: 'deleted-elsewhere',
    });
    expect(restoreSession(storage, () => 'new')).toEqual({
      chats: ['a', 'b'],
      active: 'a',
      restored: true,
    });
    expect(restoreSession(storageOf({ [CHATS_KEY]: '["a","b"]' }), () => 'new').active).toBe(
      'a',
    );
  });

  it('creates a fresh chat when nothing was stored', () => {
    expect(restoreSession(storageOf({}), () => 'fresh')).toEqual({
      chats: ['fresh'],
      active: 'fresh',
      restored: false,
    });
  });

  it('treats an empty stored list as "nothing stored"', () => {
    const storage = storageOf({ [CHATS_KEY]: '[]', [ACTIVE_KEY]: 'a' });
    expect(restoreSession(storage, () => 'fresh')).toEqual({
      chats: ['fresh'],
      active: 'fresh',
      restored: false,
    });
  });
});

describe('newestServerChat', () => {
  it('picks the largest numeric updated_at', () => {
    expect(
      newestServerChat([
        { chat: 'old', updated_at: 10 },
        { chat: 'new', updated_at: 30 },
        { chat: 'mid', updated_at: 20 },
      ]),
    ).toBe('new');
  });

  it('parses string timestamps', () => {
    expect(
      newestServerChat([
        { chat: 'old', updated_at: '2026-01-01T00:00:00Z' },
        { chat: 'new', updated_at: '2026-03-01T00:00:00Z' },
      ]),
    ).toBe('new');
  });

  it('ignores unparseable timestamps but still returns a first id', () => {
    expect(newestServerChat([{ chat: 'a', updated_at: 'nope' }, { chat: 'b' }])).toBe(
      'a',
    );
    expect(newestServerChat([{ chat: 'a', updated_at: 10 }, { chat: 'b', updated_at: 'nope' }])).toBe(
      'a',
    );
  });

  it('skips malformed rows and returns null for an empty list', () => {
    expect(newestServerChat([])).toBeNull();
    expect(newestServerChat([null, 3, {}, { chat: '' }])).toBeNull();
    expect(newestServerChat([{ chat: 'only' }])).toBe('only');
  });

  it('keeps the first id on equal timestamps', () => {
    expect(
      newestServerChat([
        { chat: 'first', updated_at: 10 },
        { chat: 'second', updated_at: 10 },
      ]),
    ).toBe('first');
  });
});

describe('togglePin', () => {
  it('puts a new pin first and removes an existing one', () => {
    expect(togglePin([], 'a')).toEqual(['a']);
    expect(togglePin(['a'], 'b')).toEqual(['b', 'a']);
    expect(togglePin(['b', 'a'], 'a')).toEqual(['b']);
    expect(togglePin(['b', 'a'], 'b')).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const pins = ['a'];
    const next = togglePin(pins, 'b');
    expect(pins).toEqual(['a']);
    expect(next).not.toBe(pins);
  });
});

describe('prunePins', () => {
  it('keeps pin order and drops chats the server no longer lists', () => {
    expect(prunePins(['c', 'a', 'b'], ['a', 'b', 'd'])).toEqual(['a', 'b']);
  });

  it('returns the same array when every pin is still present', () => {
    const pins = ['a', 'b'];
    expect(prunePins(pins, ['a', 'b', 'c'])).toBe(pins);
  });

  it('drops everything for an empty server list — callers must not pass one', () => {
    // The handler only calls this inside `if (incomingIds.length > 0)`; an
    // empty list can also mean "the plugin's own API call failed".
    expect(prunePins(['a'], [])).toEqual([]);
  });
});
