import { describe, expect, it } from 'vitest';
import { searchHitsOf, snippetParts } from '../src/lib/search';
import type { SearchHit } from '../src/lib/search';

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    chat: 'c1',
    title: 'T',
    role: 'user',
    snippet: 'aaaTARGETbbb',
    matchStart: 3,
    matchLen: 6,
    ts: 1,
    ...overrides,
  };
}

describe('searchHitsOf', () => {
  it('parses a complete row verbatim', () => {
    expect(
      searchHitsOf([
        {
          chat: 'c1',
          title: '标题',
          role: 'assistant',
          snippet: 'a needle b',
          match_start: 2,
          match_len: 6,
          ts: 1700000000,
        },
      ]),
    ).toEqual([
      {
        chat: 'c1',
        title: '标题',
        role: 'assistant',
        snippet: 'a needle b',
        matchStart: 2,
        matchLen: 6,
        ts: 1700000000,
      },
    ]);
  });

  it('drops non-object rows and rows without a chat id', () => {
    expect(searchHitsOf(null)).toEqual([]);
    expect(searchHitsOf('nope')).toEqual([]);
    expect(
      searchHitsOf([null, 7, 'x', [], {}, { chat: '' }, { chat: 9 }, { chat: 'ok' }]),
    ).toEqual([
      {
        chat: 'ok',
        title: '',
        role: '',
        snippet: '',
        matchStart: -1,
        matchLen: 0,
        ts: null,
      },
    ]);
  });

  it('treats non-integer offsets as "not located"', () => {
    const [row] = searchHitsOf([
      { chat: 'c', match_start: 1.5, match_len: '3' },
    ]);
    expect(row.matchStart).toBe(-1);
    expect(row.matchLen).toBe(0);

    const [negative] = searchHitsOf([{ chat: 'c', match_start: -1, match_len: -2 }]);
    expect(negative.matchStart).toBe(-1);
    expect(negative.matchLen).toBe(-2);
  });

  it('keeps finite timestamps only and stringifies nothing implicitly', () => {
    const rows = searchHitsOf([
      { chat: 'a', ts: 0 },
      { chat: 'b', ts: Number.POSITIVE_INFINITY },
      { chat: 'c', ts: '1700' },
      { chat: 'd', title: 3, role: null, snippet: {} },
    ]);
    expect(rows.map((row) => row.ts)).toEqual([0, null, null, null]);
    expect(rows[3]).toMatchObject({ title: '', role: '', snippet: '' });
  });
});

describe('snippetParts', () => {
  it('splits before/match/after', () => {
    expect(snippetParts(hit())).toEqual({
      before: 'aaa',
      match: 'TARGET',
      after: 'bbb',
    });
  });

  it('slices by UTF-16 code units so astral characters stay whole', () => {
    // "😀" is one code point but two UTF-16 units.
    const parts = snippetParts(hit({ snippet: '😀abc😀', matchStart: 2, matchLen: 3 }));
    expect(parts).toEqual({ before: '😀', match: 'abc', after: '😀' });
  });

  it('returns the whole snippet as context when no match is located', () => {
    const whole = { before: 'abc', match: '', after: '' };
    expect(snippetParts(hit({ snippet: 'abc', matchStart: -1, matchLen: 3 }))).toEqual(whole);
    expect(snippetParts(hit({ snippet: 'abc', matchStart: 1, matchLen: 0 }))).toEqual(whole);
    expect(snippetParts(hit({ snippet: 'abc', matchStart: 1, matchLen: -2 }))).toEqual(whole);
  });

  it('rejects a match that runs past the end', () => {
    expect(snippetParts(hit({ snippet: 'abc', matchStart: 2, matchLen: 2 }))).toEqual({
      before: 'abc',
      match: '',
      after: '',
    });
  });

  it('handles an empty snippet and a zero-length hit boundary', () => {
    expect(snippetParts(hit({ snippet: '', matchStart: -1, matchLen: 0 }))).toEqual({
      before: '',
      match: '',
      after: '',
    });
    expect(snippetParts(hit({ snippet: 'abc', matchStart: 3, matchLen: 0 }))).toEqual({
      before: 'abc',
      match: '',
      after: '',
    });
  });
});
