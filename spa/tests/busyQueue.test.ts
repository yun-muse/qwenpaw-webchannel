import { describe, expect, it } from 'vitest';
import {
  BUSY_MODE_KEY,
  BUSY_QUEUE_KEY,
  MAX_BUSY_PER_CHAT,
  MAX_BUSY_TOTAL,
  busyChatsWithWork,
  busyFor,
  enqueueBusy,
  hasBusyWork,
  loadBusyMode,
  loadBusyQueue,
  parseBusyQueue,
  prependBusy,
  removeBusyChat,
  removeBusyEntry,
  saveBusyMode,
  saveBusyQueue,
  takeBusyHead,
} from '../src/lib/busyQueue';
import type { BusyQueueEntry, ReadonlyStorage, WritableStorage } from '../src/lib/busyQueue';

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

function entry(chat: string, text: string, id = text): BusyQueueEntry {
  return enqueueBusy([], { chat, text, id, ts: 1 }).entry as BusyQueueEntry;
}

describe('enqueueBusy — per-chat FIFO', () => {
  it('keeps send order inside one chat', () => {
    let queue: BusyQueueEntry[] = [];
    for (const text of ['first', 'second', 'third']) {
      const result = enqueueBusy(queue, { chat: 'a', text, ts: 1 });
      expect(result.refused).toBeUndefined();
      queue = result.entries;
    }
    expect(busyFor(queue, 'a').map((item) => item.text)).toEqual(['first', 'second', 'third']);
  });

  it('refuses an empty message and a message with no chat', () => {
    expect(enqueueBusy([], { chat: 'a', text: '   ' }).entry).toBeNull();
    expect(enqueueBusy([], { chat: '', text: 'hi' }).entry).toBeNull();
  });

  it('refuses (never drops) at the per-chat cap', () => {
    let queue: BusyQueueEntry[] = [];
    for (let i = 0; i < MAX_BUSY_PER_CHAT; i += 1) {
      queue = enqueueBusy(queue, { chat: 'a', text: `m${i}` }).entries;
    }
    const refused = enqueueBusy(queue, { chat: 'a', text: 'overflow' });
    expect(refused.refused).toBe('full-chat');
    expect(refused.entries).toBe(queue);
    expect(busyFor(queue, 'a')).toHaveLength(MAX_BUSY_PER_CHAT);
    // Another chat is unaffected by the first chat's cap.
    expect(enqueueBusy(queue, { chat: 'b', text: 'ok' }).refused).toBeUndefined();
  });

  it('refuses at the global cap', () => {
    let queue: BusyQueueEntry[] = [];
    for (let i = 0; i < MAX_BUSY_TOTAL; i += 1) {
      queue = enqueueBusy(queue, { chat: `c${i}`, text: `m${i}` }).entries;
    }
    expect(enqueueBusy(queue, { chat: 'new', text: 'overflow' }).refused).toBe('full-total');
  });
});

describe('cancel and head extraction', () => {
  it('removes exactly one entry by id', () => {
    const queue = [entry('a', 'one'), entry('a', 'two'), entry('a', 'three')];
    const next = removeBusyEntry(queue, 'two');
    expect(next.map((item) => item.text)).toEqual(['one', 'three']);
  });

  it('removeBusyEntry is a no-op for an unknown id', () => {
    const queue = [entry('a', 'one')];
    expect(removeBusyEntry(queue, 'nope')).toEqual(queue);
  });

  it('takes the oldest entry of that chat and leaves the rest', () => {
    const queue = [entry('a', 'one'), entry('b', 'other'), entry('a', 'two')];
    const { entry: head, entries } = takeBusyHead(queue, 'a');
    expect(head?.text).toBe('one');
    expect(entries.map((item) => `${item.chat}:${item.text}`)).toEqual(['b:other', 'a:two']);
  });

  it('returns an empty head when the chat has nothing queued', () => {
    const queue = [entry('a', 'one')];
    const { entry: head, entries } = takeBusyHead(queue, 'b');
    expect(head).toBeNull();
    expect(entries).toBe(queue);
  });

  it('prependBusy restores a refused handoff at the front', () => {
    const one = entry('a', 'one');
    const two = entry('a', 'two');
    expect(prependBusy([two], one).map((item) => item.text)).toEqual(['one', 'two']);
    // A chat with nothing left still gets its head back.
    expect(prependBusy([entry('b', 'x')], one).map((item) => item.text)).toEqual(['one', 'x']);
  });
});

describe('per-chat isolation', () => {
  it('filters by chat and lists every chat with work', () => {
    const queue = [entry('a', 'a1'), entry('b', 'b1'), entry('a', 'a2')];
    expect(busyFor(queue, 'a').map((item) => item.text)).toEqual(['a1', 'a2']);
    expect(busyFor(queue, 'b').map((item) => item.text)).toEqual(['b1']);
    expect(busyFor(queue, 'c')).toEqual([]);
    expect(hasBusyWork(queue, 'a')).toBe(true);
    expect(hasBusyWork(queue, 'c')).toBe(false);
    expect(busyChatsWithWork(queue)).toEqual(['a', 'b']);
  });

  it('removeBusyChat drops one chat only', () => {
    const queue = [entry('a', 'a1'), entry('b', 'b1')];
    const next = removeBusyChat(queue, 'a');
    expect(next.map((item) => item.chat)).toEqual(['b']);
    expect(removeBusyChat(next, 'zzz')).toBe(next);
  });
});

describe('persistence', () => {
  it('round-trips the queue in order through storage', () => {
    const storage = memoryStorage();
    const queue = [entry('a', 'one'), entry('b', 'two')];
    saveBusyQueue(queue, storage);
    expect(storage.dump()[BUSY_QUEUE_KEY]).toBeTruthy();
    expect(loadBusyQueue(storage).map((item) => `${item.chat}:${item.text}`)).toEqual([
      'a:one',
      'b:two',
    ]);
  });

  it('drops malformed entries and duplicate ids, keeps order', () => {
    const raw = JSON.stringify([
      { id: 'x', chat: 'a', text: 'one' },
      null,
      { id: 'x', chat: 'a', text: 'dup' },
      { chat: 'a', text: '   ' },
      { id: 'y', chat: 'b', text: 'two' },
      'nonsense',
    ]);
    expect(parseBusyQueue(raw).map((item) => item.text)).toEqual(['one', 'two']);
  });

  it('survives unreadable JSON and blocked storage', () => {
    expect(parseBusyQueue('{not json')).toEqual([]);
    expect(parseBusyQueue(null)).toEqual([]);
    expect(loadBusyQueue(brokenRead)).toEqual([]);
    expect(() => saveBusyQueue([entry('a', 'x')], brokenWrite)).not.toThrow();
  });
});

describe('mode memory', () => {
  it('defaults to 排队 when nothing was stored', () => {
    expect(loadBusyMode(memoryStorage())).toBe('queue');
    expect(loadBusyMode(null)).toBe('queue');
  });

  it('remembers 立即发送 across a reload', () => {
    const storage = memoryStorage();
    saveBusyMode('now', storage);
    expect(storage.dump()[BUSY_MODE_KEY]).toBe('now');
    expect(loadBusyMode(storage)).toBe('now');
  });

  it('remembers 排队 too, and falls back for an unknown value', () => {
    const storage = memoryStorage({ [BUSY_MODE_KEY]: 'queue' });
    expect(loadBusyMode(storage)).toBe('queue');
    expect(loadBusyMode(memoryStorage({ [BUSY_MODE_KEY]: 'jump' }))).toBe('queue');
  });

  it('never throws on a blocked read and ignores a blocked write', () => {
    expect(loadBusyMode(brokenRead)).toBe('queue');
    expect(() => saveBusyMode('now', brokenWrite)).not.toThrow();
  });
});
