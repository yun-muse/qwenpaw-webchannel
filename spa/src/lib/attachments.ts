/**
 * History-attachment plumbing (M31).
 *
 * The plugin's `hist` frames carry `files[]` metadata only: a bare name, an
 * optional MIME/size, a `kind` and -- for files that live on the container
 * -- an opaque `ref`. This module turns that metadata into a safe view model
 * and fetches bytes through the `att_get` / `att_begin` / `att_chunk` /
 * `att_end` control frames, verifying the declared byte length and SHA-256
 * before anything is rendered or saved.
 *
 * The browser never sends a path: `request()` only ever forwards `ref`.
 */

import type { Frame } from '../relay';
import { verifyExport } from './export';

export type AttachmentKind = 'image' | 'file';

export interface HistoryFile {
  name: string;
  mime?: string;
  size?: number;
  kind: AttachmentKind;
  /** Opaque plugin-issued handle; absent for optimistic/local-only entries. */
  ref?: string;
}

/** Mirrors the plugin's hard ceiling (protocol §15). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 10 MB at 96 KB per chunk is ~107; the cap only guards a broken sender. */
export const MAX_ATTACHMENT_CHUNKS = 2048;
const ATTACHMENT_TIMEOUT_MS = 30_000;

/**
 * M35: one message carries at most this many attachments (mirrors
 * `plugin/util.MAX_MESSAGE_ATTACHMENTS`). Ten covers a screenshot sweep, a
 * log set or a few documents; it keeps one turn's upload work and one
 * optimistic bubble bounded.
 */
export const MAX_MESSAGE_ATTACHMENTS = 10;
/**
 * M35: the 10 MB rule is per **message**, not per file -- ten 9 MB files must
 * not become one 90 MB turn. Mirrors `MAX_MESSAGE_ATTACHMENT_BYTES`.
 */
export const MAX_MESSAGE_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;

export type AttachRejectReason = 'single' | 'count' | 'total';

export interface AttachRejection {
  name: string;
  reason: AttachRejectReason;
}

export interface AttachPlan<T> {
  accepted: T[];
  rejected: AttachRejection[];
}

interface SizedFile {
  name: string;
  size: number;
}

/**
 * Decide which files fit in the composer's pending list (M35).
 *
 * Files are taken in order and the first one that breaks a limit stops the
 * batch, so the outcome matches what the user sees ("the last two were
 * skipped"). Unknown sizes (0) count as 0 -- the plugin still enforces its
 * own per-file ceiling on the wire.
 */
export function planAttachments<T extends SizedFile>(
  pending: SizedFile[],
  incoming: T[],
): AttachPlan<T> {
  const accepted: T[] = [];
  const rejected: AttachRejection[] = [];
  let count = pending.length;
  let total = pending.reduce((sum, file) => sum + (file.size || 0), 0);
  let closed = false;
  for (const file of incoming) {
    if (closed) {
      rejected.push({ name: file.name, reason: 'count' });
      continue;
    }
    if ((file.size || 0) > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, reason: 'single' });
      continue;
    }
    if (count + 1 > MAX_MESSAGE_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: 'count' });
      closed = true;
      continue;
    }
    if (total + (file.size || 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, reason: 'total' });
      closed = true;
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size || 0;
  }
  return { accepted, rejected };
}

/** One short sentence for the composer's error line. */
export function describeRejections(rejected: AttachRejection[]): string {
  if (!rejected.length) return '';
  const first = rejected[0];
  if (first.reason === 'single') {
    return `附件太大：单个附件上限 10MB（${first.name}）`;
  }
  if (first.reason === 'count') {
    return `一条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个附件，其余已忽略`;
  }
  return `附件总大小上限 10MB，其余已忽略（${first.name}）`;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function attachmentKindOf(name: string, mime: string): AttachmentKind {
  if (mime.toLowerCase().startsWith('image/')) return 'image';
  if (!mime && /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name)) return 'image';
  return 'file';
}

/**
 * Parse one `hist.messages[].files` value.
 *
 * Malformed entries are dropped, never guessed into existence. Duplicates are
 * collapsed by `ref` (or by name/mime/size when there is no ref), so a
 * replayed frame cannot render the same attachment twice.
 */
export function historyFilesOf(raw: unknown): HistoryFile[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      name?: unknown;
      mime?: unknown;
      size?: unknown;
      kind?: unknown;
      ref?: unknown;
    };
    const name = textOf(record.name);
    if (!name) continue;
    const mime = textOf(record.mime);
    const kind: AttachmentKind =
      record.kind === 'image' || (record.kind !== 'file' && attachmentKindOf(name, mime) === 'image')
        ? 'image'
        : 'file';
    const key = textOf(record.ref) || `${name}\u0000${mime}\u0000${String(record.size ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file: HistoryFile = { name, kind };
    if (mime) file.mime = mime;
    const size = sizeOf(record.size);
    if (size !== undefined) file.size = size;
    const ref = textOf(record.ref);
    if (ref) file.ref = ref;
    out.push(file);
  }
  return out;
}

export type AttachmentFailure =
  | 'ref'
  | 'offline'
  | 'timeout'
  | 'refused'
  | 'meta'
  | 'missing'
  | 'decode'
  | 'size'
  | 'crypto'
  | 'digest'
  | 'closed';

export type AttachmentResult =
  | { ok: true; name: string; mime: string; buffer: ArrayBuffer }
  | { ok: false; reason: AttachmentFailure };

interface AttachmentJob {
  id: string;
  key: string;
  chat: string;
  ref: string;
  name: string;
  mime: string;
  bytes: number;
  chunks: number;
  sha256: string;
  parts: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  settle: (result: AttachmentResult) => void;
}

/**
 * One in-flight `att_get` per (chat, ref); concurrent chips share the bytes.
 *
 * `handle()` is fed the raw inbound frames. Unknown ids are ignored, which is
 * what makes a late reply from an abandoned component harmless. Every job is
 * settled exactly once: completion, `E_ATT`, timeout, a failed send and
 * `dispose()` all race for the same slot.
 */
export class AttachmentFetcher {
  private readonly pendingByKey = new Map<string, AttachmentJob>();
  private readonly pendingById = new Map<string, AttachmentJob>();
  private counter = 1;
  private closed = false;

  constructor(
    private readonly send: (frame: Frame) => boolean,
    private readonly digest: (buffer: ArrayBuffer) => Promise<string>,
    private readonly timeoutMs = ATTACHMENT_TIMEOUT_MS,
  ) {}

  request(chat: string, file: HistoryFile): Promise<AttachmentResult> {
    if (!file.ref) return Promise.resolve({ ok: false, reason: 'ref' });
    if (this.closed) return Promise.resolve({ ok: false, reason: 'closed' });

    const key = `${chat}\u0000${file.ref}`;
    const existing = this.pendingByKey.get(key);
    if (existing) return new Promise((resolve) => {
      const previous = existing.settle;
      existing.settle = (result) => {
        previous(result);
        resolve(result);
      };
    });

    const id = `att-${Date.now().toString(36)}-${this.counter++}`;
    return new Promise((resolve) => {
      const job: AttachmentJob = {
        id,
        key,
        chat,
        ref: file.ref as string,
        name: file.name,
        mime: file.mime ?? '',
        bytes: 0,
        chunks: 0,
        sha256: '',
        parts: new Map(),
        timer: null,
        settled: false,
        settle: resolve,
      };
      this.pendingByKey.set(key, job);
      this.pendingById.set(id, job);
      let accepted = false;
      try {
        accepted = this.send({ t: 'att_get', chat, id, ref: job.ref });
      } catch {
        accepted = false;
      }
      if (!accepted) {
        this.fail(job, 'offline');
        return;
      }
      job.timer = setTimeout(() => this.fail(job, 'timeout'), this.timeoutMs);
    });
  }

  /** Feed one inbound frame; returns True when it belonged to an attachment. */
  handle(frame: Frame): boolean {
    const id = textOf(frame.id);
    if (!id) return false;
    const job = this.pendingById.get(id);
    if (!job) return false;
    switch (frame.t) {
      case 'att_begin': {
        const bytes = typeof frame.bytes === 'number' ? frame.bytes : -1;
        const chunks = typeof frame.chunks === 'number' ? frame.chunks : -1;
        const sha256 = textOf(frame.sha256);
        if (
          !Number.isInteger(bytes) ||
          !Number.isInteger(chunks) ||
          bytes < 0 ||
          chunks < 0 ||
          bytes > MAX_ATTACHMENT_BYTES ||
          chunks > MAX_ATTACHMENT_CHUNKS ||
          (bytes === 0) !== (chunks === 0) ||
          !sha256
        ) {
          this.fail(job, 'meta');
          return true;
        }
        job.bytes = bytes;
        job.chunks = chunks;
        job.sha256 = sha256.toLowerCase();
        job.parts.clear();
        const name = textOf(frame.name);
        if (name) job.name = name;
        const mime = textOf(frame.mime);
        if (mime) job.mime = mime;
        return true;
      }
      case 'att_chunk': {
        const index = typeof frame.i === 'number' ? frame.i : -1;
        const data = typeof frame.data === 'string' ? frame.data : '';
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= job.chunks ||
          !data ||
          job.parts.has(index)
        ) {
          return true; // ignore; verification decides at att_end
        }
        job.parts.set(index, data);
        return true;
      }
      case 'att_end': {
        void this.finish(job);
        return true;
      }
      default:
        return false;
    }
  }

  /** Settle a request-scoped `E_ATT`; False when the id belongs to nobody. */
  handleError(frame: Frame): boolean {
    if (textOf(frame.code) !== 'E_ATT') return false;
    const job = this.pendingById.get(textOf(frame.id));
    if (!job) return false;
    this.fail(job, 'refused');
    return true;
  }

  dispose(): void {
    this.closed = true;
    for (const job of [...this.pendingById.values()]) this.fail(job, 'closed');
  }

  private async finish(job: AttachmentJob): Promise<void> {
    if (job.settled) return;
    let result: AttachmentResult;
    if (job.bytes === 0) {
      try {
        const digest = await this.digest(new ArrayBuffer(0));
        result = digest.toLowerCase() === job.sha256
          ? { ok: true, name: job.name, mime: job.mime, buffer: new ArrayBuffer(0) }
          : { ok: false, reason: 'digest' };
      } catch {
        result = { ok: false, reason: 'crypto' };
      }
    } else {
      const verified = await verifyExport(
        job.parts,
        job.chunks,
        job.bytes,
        job.sha256,
        this.digest,
      );
      result = verified.ok
        ? { ok: true, name: job.name, mime: job.mime, buffer: verified.buffer }
        : { ok: false, reason: verified.reason };
    }
    this.settle(job, result);
  }

  private fail(job: AttachmentJob, reason: AttachmentFailure): void {
    this.settle(job, { ok: false, reason });
  }

  private settle(job: AttachmentJob, result: AttachmentResult): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    if (this.pendingById.get(job.id) === job) this.pendingById.delete(job.id);
    if (this.pendingByKey.get(job.key) === job) this.pendingByKey.delete(job.key);
    job.parts.clear();
    job.settle(result);
  }
}
