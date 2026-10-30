import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Frame } from '../src/relay';
import {
  AttachmentFetcher,
  MAX_ATTACHMENT_BYTES,
  attachmentKindOf,
  historyFilesOf,
} from '../src/lib/attachments';
import type { HistoryFile } from '../src/lib/attachments';

const sha256Hex = async (buffer: ArrayBuffer): Promise<string> =>
  createHash('sha256').update(Buffer.from(buffer)).digest('hex');

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function streamFrames(id: string, payload: Uint8Array): Array<Frame> {
  const half = Math.ceil(payload.length / 2);
  return [
    {
      t: 'att_begin',
      chat: 'c1',
      id,
      bytes: payload.length,
      chunks: 2,
      sha256: createHash('sha256').update(payload).digest('hex'),
      name: '图.png',
      mime: 'image/png',
    },
    { t: 'att_chunk', chat: 'c1', id, i: 0, data: b64(payload.subarray(0, half)) },
    { t: 'att_chunk', chat: 'c1', id, i: 1, data: b64(payload.subarray(half)) },
    { t: 'att_end', chat: 'c1', id },
  ];
}

/** A fetcher plus a helper that starts one request and returns its wire id. */
function harness(digest = sha256Hex, timeoutMs?: number) {
  const sent: Frame[] = [];
  const client = new AttachmentFetcher(
    (frame) => {
      sent.push(frame);
      return true;
    },
    digest,
    timeoutMs,
  );
  const begin = (file: HistoryFile = FILE, chat = 'c1') => {
    const promise = client.request(chat, file);
    const id = String(sent[sent.length - 1]?.id ?? '');
    return { promise, id, chat };
  };
  return { client, sent, begin };
}

const FILE: HistoryFile = { name: '图.png', mime: 'image/png', kind: 'image', ref: 'r1' };

describe('historyFilesOf', () => {
  it('parses the plugin shape and keeps only known fields', () => {
    expect(
      historyFilesOf([
        { name: '图.png', mime: 'image/png', size: 12, kind: 'image', ref: 'r1', path: '/x' },
        { name: 'a.pdf', size: 3, kind: 'file' },
      ]),
    ).toEqual([
      { name: '图.png', mime: 'image/png', size: 12, kind: 'image', ref: 'r1' },
      { name: 'a.pdf', kind: 'file', size: 3 },
    ]);
  });

  it('drops malformed entries and dedupes by ref', () => {
    expect(
      historyFilesOf([
        null,
        {},
        { name: '' },
        { name: 'a.png', ref: 'same', kind: 'image' },
        { name: 'a.png', ref: 'same', kind: 'image' },
        { name: 'b.bin' },
      ]),
    ).toEqual([
      { name: 'a.png', kind: 'image', ref: 'same' },
      { name: 'b.bin', kind: 'file' },
    ]);
  });

  it('infers an image from the MIME or the extension', () => {
    expect(attachmentKindOf('x', 'image/webp')).toBe('image');
    expect(attachmentKindOf('screenshot.PNG', '')).toBe('image');
    expect(attachmentKindOf('report.pdf', 'application/pdf')).toBe('file');
    expect(attachmentKindOf('noext', '')).toBe('file');
  });

  it('rejects negative and fractional sizes', () => {
    expect(historyFilesOf([{ name: 'a', size: -1, kind: 'file' }])[0].size).toBeUndefined();
    expect(historyFilesOf([{ name: 'a', size: 1.5, kind: 'file' }])[0].size).toBeUndefined();
  });
});

describe('AttachmentFetcher', () => {
  it('requests by ref and verifies the assembled bytes', async () => {
    const { client, sent, begin } = harness();
    const payload = Uint8Array.from({ length: 500 }, (_, i) => i % 251);
    const { promise, id } = begin();
    expect(sent).toHaveLength(1);
    expect(sent[0].t).toBe('att_get');
    expect(sent[0].ref).toBe('r1');
    expect(sent[0].chat).toBe('c1');
    for (const frame of streamFrames(id, payload)) client.handle(frame);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Uint8Array(result.buffer)).toEqual(payload);
      expect(result.name).toBe('图.png');
      expect(result.mime).toBe('image/png');
    }
  });

  it('shares one request between concurrent consumers', async () => {
    const { client, sent, begin } = harness();
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const first = client.request('c1', FILE);
    const id = String(sent[sent.length - 1].id);
    const second = client.request('c1', FILE);
    expect(sent).toHaveLength(1);
    for (const frame of streamFrames(id, payload)) client.handle(frame);
    expect(await first).toEqual(await second);
    expect(await first).toMatchObject({ ok: true });
  });

  it('rejects a digest mismatch', async () => {
    const { client, begin } = harness();
    const { promise, id } = begin();
    const payload = Uint8Array.from([9, 9, 9, 9]);
    const frames = streamFrames(id, payload);
    frames[0] = { ...frames[0], sha256: 'f'.repeat(64) };
    for (const frame of frames) client.handle(frame);
    expect(await promise).toEqual({ ok: false, reason: 'digest' });
  });

  it('rejects missing chunks and oversized metadata', async () => {
    const missing = harness();
    const one = missing.begin();
    const frames = streamFrames(one.id, Uint8Array.from([1, 2, 3, 4]));
    missing.client.handle(frames[0]);
    missing.client.handle(frames[1]);
    missing.client.handle(frames[3]);
    expect(await one.promise).toEqual({ ok: false, reason: 'missing' });

    const oversized = harness();
    const two = oversized.begin();
    oversized.client.handle({
      t: 'att_begin',
      chat: 'c1',
      id: two.id,
      bytes: MAX_ATTACHMENT_BYTES + 1,
      chunks: 1,
      sha256: 'a'.repeat(64),
      name: 'x',
    });
    expect(await two.promise).toEqual({ ok: false, reason: 'meta' });
  });

  it('settles E_ATT and ignores other error codes', async () => {
    const { client, begin } = harness();
    const { promise, id } = begin();
    expect(
      client.handleError({ t: 'error', code: 'E_AUTH', id }),
    ).toBe(false);
    expect(
      client.handleError({ t: 'error', code: 'E_ATT', chat: 'c1', id }),
    ).toBe(true);
    expect(await promise).toEqual({ ok: false, reason: 'refused' });
  });

  it('fails offline, on timeout and on dispose', async () => {
    const offline = new AttachmentFetcher(() => false, sha256Hex);
    expect(await offline.request('c1', FILE)).toEqual({ ok: false, reason: 'offline' });

    vi.useFakeTimers();
    try {
      const slow = harness(sha256Hex, 5000);
      const { promise } = slow.begin();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await promise).toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }

    const closing = harness();
    const { promise } = closing.begin();
    closing.client.dispose();
    expect(await promise).toEqual({ ok: false, reason: 'closed' });
  });

  it('handles a zero-byte attachment', async () => {
    const { client, begin } = harness();
    const { promise, id } = begin();
    client.handle({
      t: 'att_begin',
      chat: 'c1',
      id,
      bytes: 0,
      chunks: 0,
      sha256: createHash('sha256').update('').digest('hex'),
      name: 'empty.txt',
      mime: 'text/plain',
    });
    client.handle({ t: 'att_end', chat: 'c1', id });
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer.byteLength).toBe(0);
  });

  it('refuses an entry without a ref', async () => {
    const { client } = harness();
    expect(await client.request('c1', { name: 'x', kind: 'file' })).toEqual({
      ok: false,
      reason: 'ref',
    });
  });
});
