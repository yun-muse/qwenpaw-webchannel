import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_ERROR_TEXT,
  base64Of,
  bytesOfBase64,
  exportFileName,
  hexOf,
  verifyExport,
} from '../src/lib/export';

const sha256Hex = async (buffer: ArrayBuffer): Promise<string> =>
  createHash('sha256').update(Buffer.from(buffer)).digest('hex');

function bufferOf(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

describe('hexOf', () => {
  it('formats every byte as two lower-case hex digits', () => {
    expect(hexOf(bufferOf([]))).toBe('');
    expect(hexOf(bufferOf([0, 15, 255]))).toBe('000fff');
    expect(hexOf(bufferOf([0x12, 0xab, 0x00]))).toBe('12ab00');
  });
});

describe('base64Of / bytesOfBase64', () => {
  it('round-trips the empty payload', () => {
    expect(base64Of(new Uint8Array(0))).toBe('');
    expect(bytesOfBase64('')).toEqual(new Uint8Array(0));
  });

  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const encoded = base64Of(bytes);
    expect(bytesOfBase64(encoded)).toEqual(bytes);
  });

  it('chunks large inputs instead of overflowing the argument list', () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    expect(bytesOfBase64(base64Of(bytes))).toEqual(bytes);
  });

  it('returns null for text that is not valid base64', () => {
    expect(bytesOfBase64('%%%')).toBeNull();
    expect(bytesOfBase64('a')).toBeNull();
  });
});

describe('exportFileName', () => {
  it('replaces path/illegal characters and appends a padded date', () => {
    expect(exportFileName('a/b:c*d?"e"<f>|g\\h', new Date(2026, 2, 5))).toBe(
      'a_b_c_d__e__f__g_h-2026-03-05.md',
    );
  });

  it('turns control characters into single spaces', () => {
    expect(exportFileName('a\nb\tc\u0000d\u007fe', new Date(2026, 10, 9))).toBe(
      'a b c d e-2026-11-09.md',
    );
  });

  it('collapses whitespace and trims trailing dots/spaces', () => {
    expect(exportFileName('  hello   world ...  ', new Date(2026, 0, 1))).toBe(
      'hello world-2026-01-01.md',
    );
  });

  it('falls back to "chat" when nothing usable remains', () => {
    expect(exportFileName('', new Date(2026, 0, 1))).toBe('chat-2026-01-01.md');
    expect(exportFileName('   ', new Date(2026, 0, 1))).toBe('chat-2026-01-01.md');
    expect(exportFileName('...', new Date(2026, 0, 1))).toBe('chat-2026-01-01.md');
  });

  it('truncates to 50 code points without splitting a surrogate pair', () => {
    expect(exportFileName('😀'.repeat(60), new Date(2026, 0, 1))).toBe(
      `${'😀'.repeat(50)}-2026-01-01.md`,
    );
    expect(exportFileName('a'.repeat(60), new Date(2026, 0, 1))).toBe(
      `${'a'.repeat(50)}-2026-01-01.md`,
    );
    expect(exportFileName('a😀b', new Date(2026, 0, 1))).toBe('a😀b-2026-01-01.md');
  });
});

describe('verifyExport', () => {
  const payload = new TextEncoder().encode('# 标题\n\nhello 世界\n');
  const split = (size: number): { chunks: string[]; bytes: number } => {
    const chunks: string[] = [];
    for (let offset = 0; offset < payload.length; offset += size) {
      chunks.push(base64Of(payload.subarray(offset, offset + size)));
    }
    return { chunks, bytes: payload.length };
  };

  it('reassembles chunks in index order regardless of arrival order', async () => {
    const { chunks, bytes } = split(5);
    expect(chunks.length).toBeGreaterThan(1);
    const parts = new Map<number, string>();
    for (let i = chunks.length - 1; i >= 0; i -= 1) parts.set(i, chunks[i]);
    const expected = await sha256Hex(payload.buffer as ArrayBuffer);

    const result = await verifyExport(parts, chunks.length, bytes, expected, sha256Hex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Uint8Array(result.buffer)).toEqual(payload);
    }
  });

  it('accepts an upper-case expected hash (the relay never promises case)', async () => {
    const { chunks, bytes } = split(64);
    const expected = (await sha256Hex(payload.buffer as ArrayBuffer)).toUpperCase();
    const parts = new Map(chunks.map((chunk, index) => [index, chunk]));
    expect((await verifyExport(parts, chunks.length, bytes, expected, sha256Hex)).ok).toBe(
      true,
    );
  });

  it('rejects incomplete document metadata before touching the chunks', async () => {
    const parts = new Map([[0, 'YQ==']]);
    for (const [chunks, bytes, sha] of [
      [0, 1, 'aa'],
      [1, 0, 'aa'],
      [1, 1, ''],
    ] as const) {
      expect(await verifyExport(parts, chunks, bytes, sha, sha256Hex)).toEqual({
        ok: false,
        reason: 'meta',
      });
    }
  });

  it('reports a missing chunk index', async () => {
    const parts = new Map<number, string>([
      [0, 'YQ=='],
      [2, 'Yg=='],
    ]);
    expect(await verifyExport(parts, 3, 3, 'aa', sha256Hex)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('reports a chunk that is not valid base64', async () => {
    const parts = new Map<number, string>([
      [0, 'YQ=='],
      [1, '%%%'],
    ]);
    expect(await verifyExport(parts, 2, 2, 'aa', sha256Hex)).toEqual({
      ok: false,
      reason: 'decode',
    });
  });

  it('reports a byte-count mismatch before hashing', async () => {
    const parts = new Map([[0, 'YQ==']]);
    let digestCalls = 0;
    const result = await verifyExport(parts, 1, 2, 'aa', async () => {
      digestCalls += 1;
      return 'aa';
    });
    expect(result).toEqual({ ok: false, reason: 'size' });
    expect(digestCalls).toBe(0);
  });

  it('reports a digest implementation failure as crypto, not digest', async () => {
    const parts = new Map([[0, 'YQ==']]);
    expect(
      await verifyExport(parts, 1, 1, 'aa', async () => {
        throw new Error('no webcrypto');
      }),
    ).toEqual({ ok: false, reason: 'crypto' });
  });

  it('reports a content digest mismatch', async () => {
    const parts = new Map([[0, 'YQ==']]);
    expect(await verifyExport(parts, 1, 1, 'bb', sha256Hex)).toEqual({
      ok: false,
      reason: 'digest',
    });
  });

  it('has user-facing text for every failure reason', async () => {
    for (const reason of [
      'meta',
      'missing',
      'decode',
      'size',
      'crypto',
      'digest',
    ] as const) {
      expect(EXPORT_ERROR_TEXT[reason]).toBeTruthy();
    }
  });
});
