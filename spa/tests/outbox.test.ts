import { describe, expect, it } from 'vitest';
import {
  MAX_QUEUE_PER_CHAT,
  MAX_QUEUE_TOTAL,
  MAX_SEND_ATTEMPTS,
  OUTBOX_KEY,
  canRetry,
  enqueueOutbox,
  failOutboxEntry,
  hasQueuedWork,
  loadOutbox,
  markOutboxSent,
  markOutboxUnconfirmed,
  newOutboxId,
  outboxFor,
  parseOutbox,
  persistableOutbox,
  pruneSentOutbox,
  reconcileOutbox,
  removeOutboxEntry,
  retryOutboxEntry,
  saveOutbox,
  visibleOutbox,
} from '../src/lib/outbox';
import type { OutboxEntry, ReadonlyStorage, WritableStorage } from '../src/lib/outbox';

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

function queued(chat: string, text: string, id = text): OutboxEntry {
  const result = enqueueOutbox([], { chat, text, id, ts: 1 });
  return result.entry as OutboxEntry;
}

describe('parseOutbox / persistence', () => {
  it('round-trips the queue in order', () => {
    const storage = memoryStorage();
    const entries = [
      queued('chat-a', 'first'),
      queued('chat-b', 'second'),
      queued('chat-a', 'third'),
    ];
    saveOutbox(entries, storage);
    expect(loadOutbox(storage)).toEqual(entries);
    expect(JSON.parse(storage.dump()[OUTBOX_KEY])).toHaveLength(3);
  });

  it('never persists a plain sent entry, but keeps an unconfirmed one', () => {
    const entries = [
      queued('c', 'still queued', 'a'),
      queued('c', 'handed over', 'b'),
      queued('c', 'handed over, then lost', 'c'),
    ];
    const sent = markOutboxSent(entries, ['b', 'c']);
    const mixed = sent.map((item) => (item.id === 'c' ? { ...item, unconfirmed: true } : item));
    expect(persistableOutbox(mixed).map((item) => item.id)).toEqual(['a', 'c']);
    const storage = memoryStorage();
    saveOutbox(mixed, storage);
    const restored = loadOutbox(storage);
    expect(restored.map((item) => item.id)).toEqual(['a', 'c']);
    expect(restored[1].status).toBe('sent');
    expect(restored[1].unconfirmed).toBe(true);
  });

  it('prunes only the sent entries of the chat it is asked about', () => {
    const sent = markOutboxSent(
      [queued('a', 'a1', 'a1'), queued('b', 'b1', 'b1'), queued('a', 'a2', 'a2')],
      ['a1', 'b1', 'a2'],
    );
    expect(pruneSentOutbox(sent, 'a').map((item) => item.id)).toEqual(['b1']);
    const lost = markOutboxUnconfirmed(sent);
    expect(pruneSentOutbox(lost, 'a')).toBe(lost);
  });

  it('drops malformed entries but keeps the valid ones and their order', () => {
    const raw = JSON.stringify([
      { id: 'a', chat: 'c', text: 'keep', status: 'queued', attempts: 0, ts: 5 },
      null,
      { chat: 'c', text: '   ' },
      { id: 'b', chat: '', text: 'no chat' },
      'nonsense',
      { id: 'c', chat: 'c', text: 'keep too', status: 'weird' },
      { id: 'a', chat: 'c', text: 'duplicate id' },
    ]);
    const parsed = parseOutbox(raw);
    expect(parsed.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(parsed[1].status).toBe('queued');
    expect(parsed[1].display).toBe('keep too');
  });

  it('drops a stored sent entry that nothing marks unconfirmed', () => {
    const raw = JSON.stringify([
      { id: 'a', chat: 'c', text: 'queued', status: 'queued' },
      { id: 'b', chat: 'c', text: 'sent', status: 'sent', echo: true },
      { id: 'c', chat: 'c', text: 'lost', status: 'sent', unconfirmed: true, echo: true },
    ]);
    expect(parseOutbox(raw).map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('treats missing, corrupt and throwing storage as empty', () => {
    expect(parseOutbox(null)).toEqual([]);
    expect(parseOutbox('not json')).toEqual([]);
    expect(parseOutbox('{"a":1}')).toEqual([]);
    expect(loadOutbox(memoryStorage())).toEqual([]);
    expect(loadOutbox(brokenRead)).toEqual([]);
    expect(loadOutbox(null)).toEqual([]);
  });

  it('never throws when storage rejects the write', () => {
    expect(() => saveOutbox([queued('c', 'x')], brokenWrite)).not.toThrow();
    expect(() => saveOutbox([queued('c', 'x')], null)).not.toThrow();
  });

  it('restores a sent entry as unconfirmed only when flagged', () => {
    const raw = JSON.stringify([
      { id: 'a', chat: 'c', text: 'a', status: 'queued', unconfirmed: true },
      { id: 'b', chat: 'c', text: 'b', status: 'sent', unconfirmed: true, echo: true },
      { id: 'c', chat: 'c', text: 'c', status: 'failed', unconfirmed: true, echo: true },
    ]);
    const [a, b, c] = parseOutbox(raw);
    expect(a.unconfirmed).toBe(false);
    expect(b.unconfirmed).toBe(true);
    expect(c.unconfirmed).toBe(true);
    // A queued entry has no bubble on screen; restored ones keep theirs.
    expect(a.echo).toBe(false);
    expect(b.echo).toBe(true);
    expect(c.echo).toBe(true);
  });
});

describe('enqueueOutbox', () => {
  it('appends per chat, preserving FIFO order across chats', () => {
    let entries: OutboxEntry[] = [];
    for (const [chat, text] of [
      ['chat-a', 'a1'],
      ['chat-b', 'b1'],
      ['chat-a', 'a2'],
    ]) {
      entries = enqueueOutbox(entries, { chat, text }).entries;
    }
    expect(outboxFor(entries, 'chat-a').map((item) => item.text)).toEqual(['a1', 'a2']);
    expect(outboxFor(entries, 'chat-b').map((item) => item.text)).toEqual(['b1']);
    expect(entries.map((item) => item.text)).toEqual(['a1', 'b1', 'a2']);
  });

  it('keeps wire and display text apart and defaults raw to display', () => {
    const result = enqueueOutbox([], {
      chat: 'c',
      text: 'INSTRUCTION\n\nraw text',
      display: '@skill raw text',
    });
    const entry = result.entry as OutboxEntry;
    expect(entry.status).toBe('queued');
    expect(entry.attempts).toBe(0);
    expect(entry.text).toBe('INSTRUCTION\n\nraw text');
    expect(entry.display).toBe('@skill raw text');
    expect(entry.raw).toBe('@skill raw text');
  });

  it('refuses a blank chat or blank text', () => {
    expect(enqueueOutbox([], { chat: '', text: 'x' }).entry).toBeNull();
    expect(enqueueOutbox([], { chat: 'c', text: '   ' }).entry).toBeNull();
  });

  it('refuses the 21st entry of one chat instead of dropping the oldest', () => {
    let entries: OutboxEntry[] = [];
    for (let i = 0; i < MAX_QUEUE_PER_CHAT; i += 1) {
      entries = enqueueOutbox(entries, { chat: 'c', text: `m${i}` }).entries;
    }
    const overflow = enqueueOutbox(entries, { chat: 'c', text: 'too many' });
    expect(overflow.refused).toBe('full-chat');
    expect(overflow.entry).toBeNull();
    expect(overflow.entries).toBe(entries);
    expect(overflow.entries).toHaveLength(MAX_QUEUE_PER_CHAT);
    expect(overflow.entries[0].text).toBe('m0');
    // Another chat is unaffected by the per-chat cap.
    expect(enqueueOutbox(entries, { chat: 'other', text: 'ok' }).entry).not.toBeNull();
  });

  it('refuses past the whole-store cap', () => {
    let entries: OutboxEntry[] = [];
    for (let i = 0; i < MAX_QUEUE_TOTAL; i += 1) {
      entries = enqueueOutbox(entries, { chat: `c${i}`, text: `m${i}` }).entries;
    }
    const overflow = enqueueOutbox(entries, { chat: 'fresh', text: 'nope' });
    expect(overflow.refused).toBe('full-total');
    expect(overflow.entries).toHaveLength(MAX_QUEUE_TOTAL);
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newOutboxId()));
    expect(ids.size).toBe(50);
  });
});

describe('cancel / retry / fail', () => {
  const entries = [queued('c', 'one', '1'), queued('c', 'two', '2'), queued('c', 'three', '3')];

  it('removes exactly one entry and keeps the others in order', () => {
    expect(removeOutboxEntry(entries, '2').map((item) => item.id)).toEqual(['1', '3']);
    expect(removeOutboxEntry(entries, 'missing')).toEqual(entries);
  });

  it('marks only the listed ids as sent and counts the attempt', () => {
    const sent = markOutboxSent(entries, ['1', '3']);
    expect(sent.map((item) => item.status)).toEqual(['sent', 'queued', 'sent']);
    expect(sent.map((item) => item.attempts)).toEqual([1, 0, 1]);
    // A handed-over entry has an ordinary bubble on screen from then on.
    expect(sent.map((item) => item.echo)).toEqual([true, false, true]);
    expect(markOutboxSent(entries, [])).toBe(entries);
  });

  it('flags every sent entry when the connection dies, and nothing else', () => {
    const sent = markOutboxSent(entries, ['1', '2']);
    const lost = markOutboxUnconfirmed(sent);
    expect(lost.map((item) => item.unconfirmed)).toEqual([true, true, false]);
    expect(markOutboxUnconfirmed(entries)).toBe(entries);
  });

  it('retries while attempts remain and stops at the cap', () => {
    const first = markOutboxSent(entries, ['1']);
    expect(first[0].attempts).toBe(1);
    let loop = first;
    for (let attempt = 2; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      loop = markOutboxSent(retryOutboxEntry(failOutboxEntry(loop, '1'), '1'), ['1']);
    }
    expect(loop[0].attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(loop[0].status).toBe('sent');
    expect(canRetry(loop[0])).toBe(false);

    const capped = failOutboxEntry(loop, '1');
    // At the cap the row can only be cancelled: 重试 is a no-op.
    expect(retryOutboxEntry(capped, '1')[0].status).toBe('failed');
    expect(retryOutboxEntry(capped, '1')[0].attempts).toBe(MAX_SEND_ATTEMPTS);

    const once = markOutboxSent(entries, ['2']);
    const retried = retryOutboxEntry(failOutboxEntry(once, '2'), '2');
    expect(retried[1].status).toBe('queued');
    expect(retried[1].attempts).toBe(1);
  });
});

describe('reconcileOutbox', () => {
  it('confirms the matching prefix and removes it', () => {
    const all = markOutboxSent([queued('c', 'one'), queued('c', 'two')], ['one', 'two']);
    const complete = reconcileOutbox(all, 'c', ['ancient', 'one', 'two']);
    expect(complete.confirmed.sort()).toEqual(['one', 'two']);
    expect(complete.entries).toEqual([]);

    // Only the first of three frames made it before the socket died.
    const partial = markOutboxSent(
      [queued('c', 'one'), queued('c', 'two'), queued('c', 'three')],
      ['one', 'two', 'three'],
    );
    const result = reconcileOutbox(partial, 'c', ['ancient', 'one', 'two']);
    expect(result.confirmed.sort()).toEqual(['one', 'two']);
    expect(result.unknown).toEqual(['three']);
    expect(result.entries.map((item) => item.text)).toEqual(['three']);
    expect(result.entries[0].status).toBe('failed');
    expect(result.entries[0].unconfirmed).toBe(true);
  });

  it('leaves everything untouched when the tail does not match', () => {
    const sent = markOutboxSent([queued('c', 'one'), queued('c', 'two')], ['one', 'two']);
    const result = reconcileOutbox(sent, 'c', ['unrelated']);
    expect(result.confirmed).toEqual([]);
    expect(result.unknown.sort()).toEqual(['one', 'two']);
    expect(result.entries.every((item) => item.status === 'failed' && item.unconfirmed)).toBe(true);
  });

  it('never confirms queued or failed entries', () => {
    const entries = [queued('c', 'queued one'), queued('c', 'queued two')];
    const result = reconcileOutbox(entries, 'c', ['queued one', 'queued two']);
    expect(result.confirmed).toEqual([]);
    expect(result.entries).toEqual(entries);
  });

  it('is at-most-once for repeated identical texts', () => {
    const sent = markOutboxSent([queued('c', 'ok', 'x'), queued('c', 'ok', 'y')], ['x', 'y']);
    // One "ok" is in history; it can only be one of the two. Confirming the
    // first and keeping the second as unconfirmed never duplicates the text.
    const result = reconcileOutbox(sent, 'c', ['ok']);
    expect(result.confirmed).toEqual(['x']);
    expect(result.unknown).toEqual(['y']);
    expect(result.entries.map((item) => item.id)).toEqual(['y']);
  });

  it('only looks at the chat it was asked about', () => {
    const sent = markOutboxSent(
      [queued('a', 'x'), queued('b', 'y')],
      ['x', 'y'],
    );
    const result = reconcileOutbox(sent, 'a', ['x']);
    expect(result.confirmed).toEqual(['x']);
    expect(result.entries.map((item) => item.text)).toEqual(['y']);
    expect(result.entries[0].status).toBe('sent');
  });

  it('ignores whitespace differences and empty history rows', () => {
    const sent = markOutboxSent([queued('c', 'hello   world', 'x')], ['x']);
    expect(reconcileOutbox(sent, 'c', ['', '  ', 'hello world']).confirmed).toEqual(['x']);
  });
});

describe('view helpers', () => {
  it('shows queued, failed and unconfirmed rows but hides plain sent ones', () => {
    const entries = markOutboxSent(
      [queued('c', 'a'), queued('c', 'b'), queued('c', 'c'), queued('c', 'd')],
      ['a', 'b', 'c', 'd'],
    );
    const mixed = markOutboxUnconfirmed(entries).map((item) =>
      item.id === 'a' ? { ...item, status: 'failed' as const } : item.id === 'b' ? { ...item, status: 'queued' as const, unconfirmed: false } : { ...item, status: 'sent' as const, unconfirmed: false },
    );
    expect(visibleOutbox(mixed, 'c').map((item) => item.id)).toEqual(['a', 'b']);
    expect(visibleOutbox(mixed, 'other')).toEqual([]);
  });

  it('reports queued work only', () => {
    expect(hasQueuedWork([])).toBe(false);
    expect(hasQueuedWork([queued('c', 'x')])).toBe(true);
    expect(hasQueuedWork(markOutboxSent([queued('c', 'x')], ['x']))).toBe(false);
  });
});
