import { describe, expect, it } from 'vitest';
import {
  PROMPTS_KEY,
  addPrompt,
  loadPrompts,
  newPromptId,
  parsePrompts,
  promptNameOf,
  removePrompt,
  renamePrompt,
  savePrompts,
} from '../src/lib/promptLibrary';
import type { ReadonlyStorage, SavedPrompt, WritableStorage } from '../src/lib/promptLibrary';

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

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

describe('parsePrompts', () => {
  it('keeps well-formed entries in order and trims names', () => {
    const raw = JSON.stringify([
      { id: 'p1', name: '  费曼  ', text: '请用费曼法解释' },
      { id: 'p2', name: '对比', text: '输出对比表' },
    ]);
    expect(parsePrompts(raw)).toEqual([
      { id: 'p1', name: '费曼', text: '请用费曼法解释' },
      { id: 'p2', name: '对比', text: '输出对比表' },
    ]);
  });

  it('drops malformed rows, blank fields and duplicate ids', () => {
    const raw = JSON.stringify([
      null,
      'x',
      { id: '', name: 'a', text: 'b' },
      { id: 'p1', name: '', text: 'b' },
      { id: 'p2', name: 'a', text: '   ' },
      { id: 'p3', name: 'ok', text: 'yes' },
      { id: 'p3', name: 'dup', text: 'dup' },
      { id: 4, name: 'n', text: 't' },
    ]);
    expect(parsePrompts(raw)).toEqual([{ id: 'p3', name: 'ok', text: 'yes' }]);
  });

  it('treats a missing, non-array or corrupt value as empty', () => {
    expect(parsePrompts(null)).toEqual([]);
    expect(parsePrompts('not json')).toEqual([]);
    expect(parsePrompts('{"p1":1}')).toEqual([]);
    expect(parsePrompts('null')).toEqual([]);
  });
});

describe('loadPrompts / savePrompts', () => {
  it('round-trips the list through storage', () => {
    const storage = memoryStorage();
    const list: SavedPrompt[] = [{ id: 'p1', name: '费曼', text: '解释一下' }];
    savePrompts(list, storage);
    expect(JSON.parse(storage.dump()[PROMPTS_KEY])).toEqual(list);
    expect(loadPrompts(storage)).toEqual(list);
  });

  it('treats missing, corrupt and throwing storage as empty', () => {
    expect(loadPrompts(memoryStorage())).toEqual([]);
    expect(loadPrompts(memoryStorage({ [PROMPTS_KEY]: '[]' }))).toEqual([]);
    expect(loadPrompts(memoryStorage({ [PROMPTS_KEY]: '{' }))).toEqual([]);
    expect(loadPrompts(brokenRead)).toEqual([]);
    expect(loadPrompts(null)).toEqual([]);
  });

  it('never throws when storage rejects the write', () => {
    expect(() => savePrompts([], brokenWrite)).not.toThrow();
    expect(() => savePrompts([], null)).not.toThrow();
  });
});

describe('addPrompt', () => {
  it('prepends a trimmed name and keeps the prompt text verbatim', () => {
    const before: SavedPrompt[] = [{ id: 'old', name: '旧', text: '旧内容' }];
    const after = addPrompt(before, '  新名字 ', '  新内容  ', ids('new'));
    expect(after).toEqual([
      { id: 'new', name: '新名字', text: '  新内容  ' },
      { id: 'old', name: '旧', text: '旧内容' },
    ]);
    expect(before).toHaveLength(1);
  });

  it('rejects a blank name or blank text', () => {
    expect(addPrompt([], '   ', 'text', ids('x'))).toBeNull();
    expect(addPrompt([], 'name', '   ', ids('x'))).toBeNull();
    expect(addPrompt([], '', '', ids('x'))).toBeNull();
  });

  it('generates distinct ids by default', () => {
    const first = newPromptId();
    const second = newPromptId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^prompt-/);
  });
});

describe('renamePrompt', () => {
  const list: SavedPrompt[] = [
    { id: 'p1', name: '一', text: 'first' },
    { id: 'p2', name: '二', text: 'second' },
  ];

  it('renames one entry and keeps the rest in place', () => {
    const after = renamePrompt(list, 'p2', '  新二  ');
    expect(after).toEqual([
      { id: 'p1', name: '一', text: 'first' },
      { id: 'p2', name: '新二', text: 'second' },
    ]);
    expect(list[1].name).toBe('二');
  });

  it('ignores a blank name, an unknown id and an unchanged name', () => {
    expect(renamePrompt(list, 'p1', '   ')).toBe(list);
    expect(renamePrompt(list, 'missing', 'x')).toBe(list);
    expect(renamePrompt(list, 'p1', '一')).toBe(list);
  });
});

describe('removePrompt', () => {
  it('removes the entry by id', () => {
    const list: SavedPrompt[] = [
      { id: 'p1', name: '一', text: 'first' },
      { id: 'p2', name: '二', text: 'second' },
    ];
    expect(removePrompt(list, 'p1')).toEqual([{ id: 'p2', name: '二', text: 'second' }]);
  });

  it('returns the same list when the id is unknown', () => {
    const list: SavedPrompt[] = [{ id: 'p1', name: '一', text: 'first' }];
    expect(removePrompt(list, 'missing')).toBe(list);
  });
});

describe('promptNameOf', () => {
  it('uses the first non-empty line with collapsed whitespace', () => {
    expect(promptNameOf('\n\n  请用   费曼法\n解释一下  ')).toBe('请用 费曼法');
  });

  it('shortens by code points and adds an ellipsis', () => {
    expect(promptNameOf('😀'.repeat(30), 4)).toBe('😀😀😀😀…');
    expect(Array.from(promptNameOf('abcdef', 10))).toHaveLength(6);
  });

  it('returns an empty string for blank input', () => {
    expect(promptNameOf('')).toBe('');
    expect(promptNameOf('  \n\t\n')).toBe('');
  });
});
