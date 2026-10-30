import { describe, expect, it } from 'vitest';
import { ZipWriter, crc32, dosDateTime, utf8Encode } from '../src/lib/zip';

/**
 * Independent reader — deliberately *not* sharing code with the writer.
 * It walks the end-of-central-directory record, then each central record,
 * then each local header, and checks the payload with a bit-at-a-time CRC
 * (the writer uses a 256-entry table). A bug in either side shows up here.
 */
interface ParsedEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  method: number;
  flags: number;
  localOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function crcBitwise(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unzip(raw: Uint8Array): ParsedEntry[] {
  let end = -1;
  for (let at = raw.length - 22; at >= 0; at -= 1) {
    if (u32(raw, at) === SIG_END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('no end-of-central-directory record');

  const entries = u16(raw, end + 10);
  const directorySize = u32(raw, end + 12);
  const directoryOffset = u32(raw, end + 16);
  if (end !== directoryOffset + directorySize) {
    throw new Error('central directory does not end where the EOCD starts');
  }
  if (u16(raw, end + 20) !== 0) throw new Error('unexpected archive comment');

  const out: ParsedEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < entries; i += 1) {
    if (u32(raw, at) !== SIG_CENTRAL) throw new Error(`entry ${i}: bad central signature`);
    const flags = u16(raw, at + 8);
    const method = u16(raw, at + 10);
    const crc = u32(raw, at + 16);
    const compressed = u32(raw, at + 20);
    const size = u32(raw, at + 24);
    const nameLength = u16(raw, at + 28);
    const extraLength = u16(raw, at + 30);
    const commentLength = u16(raw, at + 32);
    const localOffset = u32(raw, at + 42);
    const name = new TextDecoder().decode(raw.subarray(at + 46, at + 46 + nameLength));

    if (u32(raw, localOffset) !== SIG_LOCAL) throw new Error(`entry ${name}: bad local signature`);
    const localNameLength = u16(raw, localOffset + 26);
    const localExtraLength = u16(raw, localOffset + 28);
    const localName = new TextDecoder().decode(
      raw.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (localName !== name) throw new Error(`entry ${name}: local name is ${localName}`);
    if (u16(raw, localOffset + 8) !== method) throw new Error(`entry ${name}: method mismatch`);
    if (u32(raw, localOffset + 14) !== crc) throw new Error(`entry ${name}: CRC mismatch`);
    if (compressed !== size) throw new Error(`entry ${name}: not stored`);

    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = raw.subarray(start, start + size);
    if (crcBitwise(data) !== crc) throw new Error(`entry ${name}: payload does not match its CRC`);

    out.push({ name, data, crc, method, flags, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const encoder = new TextEncoder();
const asText = (data: Uint8Array) => new TextDecoder().decode(data);

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });

  it('leaves the empty payload at zero', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('agrees with a bit-at-a-time implementation on awkward bytes', () => {
    const sample = new Uint8Array(4096);
    for (let i = 0; i < sample.length; i += 1) sample[i] = (i * 37 + 11) & 0xff;
    expect(crc32(sample)).toBe(crcBitwise(sample));
  });
});

describe('dosDateTime', () => {
  it('encodes a local wall clock the way the ZIP spec expects', () => {
    const stamp = dosDateTime(new Date(2026, 9, 30, 15, 42, 36));
    expect(stamp.time).toBe((15 << 11) | (42 << 5) | 18);
    expect(stamp.date).toBe(((2026 - 1980) << 9) | (10 << 5) | 30);
  });

  it('clamps the year into the representable range', () => {
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe('ZipWriter', () => {
  it('produces an archive an independent reader can walk', async () => {
    const writer = new ZipWriter({ now: () => new Date(2026, 9, 30, 15, 42, 0) });
    writer.add('Alpha 会话-2026-10-30.md', encoder.encode('# Alpha\n\n你好\n'));
    writer.add('Beta 会话-2026-10-30.md', encoder.encode('# Beta\n\nsecond file\n'));
    writer.add('empty.md', new Uint8Array(0));

    const bytes = new Uint8Array(await writer.finish().arrayBuffer());
    const entries = unzip(bytes);

    expect(entries.map((entry) => entry.name)).toEqual([
      'Alpha 会话-2026-10-30.md',
      'Beta 会话-2026-10-30.md',
      'empty.md',
    ]);
    expect(asText(entries[0].data)).toBe('# Alpha\n\n你好\n');
    expect(asText(entries[1].data)).toBe('# Beta\n\nsecond file\n');
    expect(entries[2].data).toHaveLength(0);
    expect(entries.every((entry) => entry.method === 0)).toBe(true);
  });

  it('marks every name as UTF-8 and keeps the CRC/size in both headers', async () => {
    const payload = encoder.encode('内容 containing ASCII and 中文');
    const writer = new ZipWriter();
    writer.add('笔记.md', payload);
    const bytes = new Uint8Array(await writer.finish().arrayBuffer());

    const [entry] = unzip(bytes);
    expect(entry.flags & 0x0800).toBe(0x0800);
    expect(entry.crc).toBe(crc32(payload));
    expect(u32(bytes, entry.localOffset + 18)).toBe(payload.length); // local compressed
    expect(u32(bytes, entry.localOffset + 22)).toBe(payload.length); // local raw
  });

  it('records the local header offsets it wrote', async () => {
    const writer = new ZipWriter();
    writer.add('a.txt', encoder.encode('aaa'));
    writer.add('b.txt', encoder.encode('bbbb'));
    const bytes = new Uint8Array(await writer.finish().arrayBuffer());
    const entries = unzip(bytes);

    expect(writer.entries.map((meta) => meta.offset)).toEqual(
      entries.map((entry) => entry.localOffset),
    );
    expect(writer.entries.map((meta) => meta.crc)).toEqual(entries.map((entry) => entry.crc));
  });

  it('keeps every entry byte-exact for a long list and a 1 MB payload', async () => {
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7 + 3) & 0xff;

    const writer = new ZipWriter();
    for (let i = 0; i < 100; i += 1) writer.add(`chat-${i}.md`, encoder.encode(`# ${i}\n`));
    writer.add('big.bin', big);

    const entries = unzip(new Uint8Array(await writer.finish().arrayBuffer()));
    expect(entries).toHaveLength(101);
    expect(asText(entries[99].data)).toBe('# 99\n');
    expect(entries[100].data.length).toBe(big.length);
    expect(Buffer.from(entries[100].data).equals(Buffer.from(big))).toBe(true);
    expect(writer.byteLength).toBe(
      Array.from({ length: 100 }, (_, i) => `# ${i}\n`.length).reduce((a, b) => a + b, 0) +
        big.length,
    );
  });

  it('returns the same archive if finish() is called twice', async () => {
    const writer = new ZipWriter();
    writer.add('a.txt', encoder.encode('a'));
    const first = writer.finish();
    const second = writer.finish();
    expect(second.size).toBe(first.size);
  });

  it('rejects duplicate names, empty names and writes after finish', () => {
    const writer = new ZipWriter();
    writer.add('a.txt', encoder.encode('a'));
    expect(() => writer.add('a.txt', encoder.encode('b'))).toThrow(/duplicate/);
    expect(() => writer.add('', encoder.encode('b'))).toThrow(/empty/);
    writer.finish();
    expect(() => writer.add('b.txt', encoder.encode('b'))).toThrow(/finished/);
  });

  it('labels the blob as a zip', () => {
    const writer = new ZipWriter();
    writer.add('a.txt', utf8Encode('a'));
    expect(writer.finish().type).toBe('application/zip');
  });
});
