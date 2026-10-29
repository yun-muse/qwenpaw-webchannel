import { describe, expect, it } from 'vitest';
import {
  ACTIVE_KEY,
  CHATS_KEY,
  PINS_KEY,
  TAGS_KEY,
  allChatTags,
  chatMatchesTag,
  newestServerChat,
  normalizeTags,
  parseChatTags,
  parseTagInput,
  persistedChatTags,
  persistedChats,
  pruneChatTags,
  prunePins,
  restoreSession,
  setChatTags,
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

describe('parseTagInput / normalizeTags', () => {
  it('splits on commas, full-width commas, enumeration and semicolons', () => {
    expect(parseTagInput('工作, 重要，待办、读书；灵感')).toEqual([
      '工作',
      '重要',
      '待办',
      '读书',
      '灵感',
    ]);
  });

  it('splits on whitespace, trims and removes duplicates in order', () => {
    expect(parseTagInput('  work   work\tstudy\nwork ')).toEqual(['work', 'study']);
    expect(parseTagInput('   ,，、; ')).toEqual([]);
  });

  it('normalises stored values and drops non-strings', () => {
    expect(normalizeTags([' a ', 'a', '', 3, null, 'b'])).toEqual(['a', 'b']);
    expect(normalizeTags('a')).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe('chat tags persistence', () => {
  it('parses a per-chat map and drops malformed rows', () => {
    expect(
      parseChatTags(
        JSON.stringify({
          a: ['work', ''],
          b: 'not-an-array',
          c: [],
          '': ['ignored'],
          d: ['x', 'x', ' y '],
        }),
      ),
    ).toEqual({ a: ['work'], d: ['x', 'y'] });
    expect(parseChatTags(null)).toEqual({});
    expect(parseChatTags('not json')).toEqual({});
    expect(parseChatTags('[]')).toEqual({});
  });

  it('reads the tags key and survives blocked storage', () => {
    const storage = storageOf({ [TAGS_KEY]: '{"chat-a":["工作"]}' });
    expect(persistedChatTags(storage)).toEqual({ 'chat-a': ['工作'] });
    const broken: ReadonlyStorage = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(persistedChatTags(broken)).toEqual({});
  });

  it('sets, replaces and clears one chat without mutating the input', () => {
    const empty: Record<string, never> = {};
    const first = setChatTags(empty, 'a', ['work', '重要']);
    expect(first).toEqual({ a: ['work', '重要'] });
    expect(empty).toEqual({});
    expect(setChatTags(first, 'a', ['读书'])).toEqual({ a: ['读书'] });
    expect(setChatTags(first, 'a', [])).toEqual({});
    expect(setChatTags(first, 'b', ['  ', ''])).toBe(first);
  });

  it('returns the same map when the tag list is unchanged', () => {
    const tags = { a: ['work'] };
    expect(setChatTags(tags, 'a', [' work ', 'work'])).toBe(tags);
  });

  it('prunes chats the server no longer lists, preserving order', () => {
    const tags = { b: ['work'], a: ['读书'], c: ['work'] };
    expect(pruneChatTags(tags, ['a', 'c'])).toEqual({ a: ['读书'], c: ['work'] });
    expect(pruneChatTags(tags, ['a', 'b', 'c'])).toBe(tags);
    expect(pruneChatTags(tags, [])).toEqual({});
  });

  it('collects distinct tags in chat order and filters by exact tag', () => {
    const tags = { a: ['work', '重要'], b: ['重要', '读书'] };
    expect(allChatTags(tags, ['b', 'a'])).toEqual(['重要', '读书', 'work']);
    expect(allChatTags(tags, ['a', 'b'])).toEqual(['work', '重要', '读书']);
    expect(chatMatchesTag(tags, 'a', null)).toBe(true);
    expect(chatMatchesTag(tags, 'a', 'work')).toBe(true);
    expect(chatMatchesTag(tags, 'a', '读书')).toBe(false);
    expect(chatMatchesTag(tags, 'missing', 'work')).toBe(false);
  });
});
