import { describe, expect, it } from 'vitest';
import {
  DRAFTS_KEY,
  draftOf,
  loadDrafts,
  parseDrafts,
  saveDrafts,
  setDraft,
} from '../src/lib/drafts';
import type { ReadonlyStorage, WritableStorage } from '../src/lib/drafts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    getItem(key: string) {
      return key in data ? data[key] : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    dump: () => data,
  };
}

const brokenRead: ReadonlyStorage = {
  getItem() {
    throw new Error('blocked');
  },
};

const brokenWrite: WritableStorage = {
  setItem() {
    throw new Error('quota');
  },
};

describe('parseDrafts', () => {
  it('keeps non-empty string drafts keyed by chat', () => {
    expect(
      parseDrafts(JSON.stringify({ 'chat-a': 'hello', 'chat-b': 'line\nline', 'chat-c': '' })),
    ).toEqual({ 'chat-a': 'hello', 'chat-b': 'line\nline' });
  });

  it('drops non-object, array, malformed and non-string values', () => {
    expect(parseDrafts(null)).toEqual({});
    expect(parseDrafts('not json')).toEqual({});
    expect(parseDrafts('null')).toEqual({});
    expect(parseDrafts('["chat-a"]')).toEqual({});
    expect(parseDrafts(JSON.stringify({ a: 1, b: null, c: {}, '': 'x', d: 'ok' }))).toEqual({
      d: 'ok',
    });
  });

  it('drops whitespace-only drafts, matching setDraft', () => {
    expect(parseDrafts(JSON.stringify({ a: '   ', b: '\n\t', c: ' x ' }))).toEqual({
      c: ' x ',
    });
  });
});

describe('loadDrafts / saveDrafts', () => {
  it('round-trips a map through storage', () => {
    const storage = memoryStorage();
    const drafts = { 'chat-a': 'alpha', 'chat-b': 'beta' };
    saveDrafts(drafts, storage);
    expect(JSON.parse(storage.dump()[DRAFTS_KEY])).toEqual(drafts);
    expect(loadDrafts(storage)).toEqual(drafts);
  });

  it('treats missing, corrupt and throwing storage as empty', () => {
    expect(loadDrafts(memoryStorage())).toEqual({});
    expect(loadDrafts(memoryStorage({ [DRAFTS_KEY]: 'not json' }))).toEqual({});
    expect(loadDrafts(brokenRead)).toEqual({});
    expect(loadDrafts(null)).toEqual({});
  });

  it('never throws when storage rejects the write', () => {
    expect(() => saveDrafts({ a: 'x' }, brokenWrite)).not.toThrow();
    expect(() => saveDrafts({ a: 'x' }, null)).not.toThrow();
  });
});

describe('draftOf', () => {
  it('returns the chat draft or an empty string', () => {
    const drafts = { 'chat-a': 'alpha' };
    expect(draftOf(drafts, 'chat-a')).toBe('alpha');
    expect(draftOf(drafts, 'chat-b')).toBe('');
    expect(draftOf(drafts, '')).toBe('');
  });
});

describe('setDraft', () => {
  it('adds a draft without mutating the input map', () => {
    const before = { 'chat-a': 'alpha' };
    const after = setDraft(before, 'chat-b', 'beta');
    expect(after).toEqual({ 'chat-a': 'alpha', 'chat-b': 'beta' });
    expect(before).toEqual({ 'chat-a': 'alpha' });
    expect(after).not.toBe(before);
  });

  it('never leaks text between chats', () => {
    const drafts = setDraft(setDraft({}, 'chat-a', 'alpha only'), 'chat-b', 'beta only');
    expect(draftOf(drafts, 'chat-a')).toBe('alpha only');
    expect(draftOf(drafts, 'chat-b')).toBe('beta only');
    expect(Object.keys(drafts)).toHaveLength(2);
  });

  it('updates one chat and leaves the other draft untouched', () => {
    const drafts = setDraft({ 'chat-a': 'old', 'chat-b': 'keep' }, 'chat-a', 'new');
    expect(drafts).toEqual({ 'chat-a': 'new', 'chat-b': 'keep' });
  });

  it('clears the entry on an empty or whitespace-only value', () => {
    expect(setDraft({ 'chat-a': 'alpha', 'chat-b': 'beta' }, 'chat-a', '')).toEqual({
      'chat-b': 'beta',
    });
    expect(setDraft({ 'chat-a': 'alpha' }, 'chat-a', '   ')).toEqual({});
  });

  it('returns the same map when nothing changes', () => {
    const drafts = { 'chat-a': 'alpha' };
    expect(setDraft(drafts, 'chat-a', 'alpha')).toBe(drafts);
    expect(setDraft(drafts, 'chat-b', '')).toBe(drafts);
    expect(setDraft(drafts, '', 'ignored')).toBe(drafts);
  });
});
