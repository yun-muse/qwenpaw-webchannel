/**
 * Minimal, dependency-free ZIP writer (M34).
 *
 * Store-only ("method 0"): the payloads are already UTF-8 text, the browser
 * exposes no synchronous deflate, and storing keeps the writer small enough to
 * read end to end. Every desktop and mobile unzip implementation understands
 * a stored archive.
 *
 * The archive is built **incrementally**: each entry is appended as a local
 * header plus a Blob, while only the central-directory records (≈100 ×
 * (46 + name) bytes for a full backup) stay in JS memory. `finish()` returns
 * one composite Blob, so the browser — not this module — owns the payload
 * storage and may spill it to disk.
 *
 * ZIP32 ceilings are enforced rather than silently wrapped: < 4294967296
 * bytes and ≤ 65535 entries. A full backup is capped at 100 chats × 10 MB by
 * the export protocol, so neither limit is reachable in practice.
 */

/** 0xFFFFFFFF — the largest offset/size a version-20 archive can express. */
export const ZIP_MAX_BYTES = 0xffffffff;
/** 0xFFFF — the largest entry count the end-of-central-directory record holds. */
export const ZIP_MAX_ENTRIES = 0xffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
/** Bit 11: the file name is UTF-8 (APPNOTE 4.4.4). */
const FLAG_UTF8 = 0x0800;
const VERSION = 20; // 2.0 — store/deflate
const METHOD_STORE = 0;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

let crcTable: Uint32Array | null = null;

/** The standard reflected CRC-32 table (polynomial 0xEDB88320), built once. */
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const next = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    next[i] = value >>> 0;
  }
  crcTable = next;
  return next;
}

/** CRC-32 of `data` as an unsigned 32-bit integer (the ZIP checksum field). */
export function crc32(data: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ lookup[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** UTF-8 bytes of a string (independent of the platform's TextEncoder usage). */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * MS-DOS date/time pair for the entry timestamp. ZIP has no time zone field,
 * so the caller's local wall clock is stored — the same convention as the
 * backup file name.
 */
export function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, when.getFullYear()));
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | (Math.floor(when.getSeconds() / 2) & 0x1f);
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

export interface ZipEntryMeta {
  name: string;
  /** Uncompressed bytes; identical to the stored bytes (method 0). */
  size: number;
  crc: number;
  /** Offset of this entry's local header inside the archive. */
  offset: number;
  /** MS-DOS time/date, as written to both the local and central headers. */
  time: number;
  date: number;
}

export interface ZipWriterOptions {
  /** Timestamp for every entry; defaults to `new Date()` at add time. */
  now?: () => Date;
}

/**
 * Append-only store-only ZIP writer.
 *
 * `add` takes a full in-memory buffer on purpose: one chat at a time is
 * decoded, handed over, and dropped — callers must never assemble all chats
 * into one string first (that is the M34 memory rule).
 */
export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly metas: ZipEntryMeta[] = [];
  private readonly names = new Set<string>();
  private readonly now: () => Date;
  private offset = 0;
  private payloadBytes = 0;
  private blob: Blob | null = null;

  constructor(options: ZipWriterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Entries added so far, in archive order. */
  get entries(): readonly ZipEntryMeta[] {
    return this.metas;
  }

  /** Total stored payload bytes (headers excluded). */
  get byteLength(): number {
    return this.payloadBytes;
  }

  /** Append one file. The writer copies `data` into a Blob immediately. */
  add(name: string, data: Uint8Array): void {
    if (this.blob) throw new Error('zip: archive already finished');
    if (!name) throw new Error('zip: entry name is empty');
    if (this.names.has(name)) throw new Error(`zip: duplicate entry ${name}`);
    if (this.metas.length >= ZIP_MAX_ENTRIES) throw new Error('zip: too many entries');

    const nameBytes = utf8Encode(name);
    const crc = crc32(data);
    const stamp = dosDateTime(this.now());
    const offset = this.offset;

    const local = new Uint8Array(LOCAL_HEADER_BYTES + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, LOCAL_SIG, true);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, METHOD_STORE, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, LOCAL_HEADER_BYTES);

    // A Blob owns its bytes from here on: the caller's buffer can be released
    // while the archive stays memory-cheap for the browser to spill to disk.
    // (`BlobPart` wants a non-shared backing buffer; zip payloads never are.)
    const nextOffset = offset + local.length + data.length;
    if (nextOffset > ZIP_MAX_BYTES) throw new Error('zip: archive exceeds 4 GB');
    this.parts.push(local, new Blob([data as BlobPart]));

    this.offset = nextOffset;
    this.payloadBytes += data.length;
    this.metas.push({ name, size: data.length, crc, offset, time: stamp.time, date: stamp.date });
    this.names.add(name);
  }

  /** Write the central directory + EOCD and return the archive. */
  finish(): Blob {
    if (this.blob) return this.blob;
    if (this.metas.length > ZIP_MAX_ENTRIES) throw new Error('zip: too many entries');

    const directoryOffset = this.offset;
    let directoryBytes = 0;
    for (const meta of this.metas) {
      const nameBytes = utf8Encode(meta.name);
      const record = new Uint8Array(CENTRAL_HEADER_BYTES + nameBytes.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, CENTRAL_SIG, true);
      view.setUint16(4, VERSION, true); // version made by (MS-DOS, 2.0)
      view.setUint16(6, VERSION, true);
      view.setUint16(8, FLAG_UTF8, true);
      view.setUint16(10, METHOD_STORE, true);
      view.setUint16(12, meta.time, true);
      view.setUint16(14, meta.date, true);
      view.setUint32(16, meta.crc, true);
      view.setUint32(20, meta.size, true);
      view.setUint32(24, meta.size, true);
      view.setUint16(28, nameBytes.length, true);
      view.setUint16(30, 0, true); // extra
      view.setUint16(32, 0, true); // comment
      view.setUint16(34, 0, true); // disk number
      view.setUint16(36, 0, true); // internal attributes
      view.setUint32(38, 0, true); // external attributes
      view.setUint32(42, meta.offset, true);
      record.set(nameBytes, CENTRAL_HEADER_BYTES);
      this.parts.push(record);
      directoryBytes += record.length;
    }

    const end = new Uint8Array(END_RECORD_BYTES);
    const view = new DataView(end.buffer);
    view.setUint32(0, END_SIG, true);
    view.setUint16(4, 0, true); // this disk
    view.setUint16(6, 0, true); // disk with the central directory
    view.setUint16(8, this.metas.length, true);
    view.setUint16(10, this.metas.length, true);
    view.setUint32(12, directoryBytes, true);
    view.setUint32(16, directoryOffset, true);
    view.setUint16(20, 0, true); // comment length
    this.parts.push(end);

    this.offset = directoryOffset + directoryBytes + END_RECORD_BYTES;
    this.blob = new Blob(this.parts, { type: 'application/zip' });
    return this.blob;
  }
}
