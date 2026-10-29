/**
 * Conversation-export plumbing extracted from App.tsx (M12/M21).
 *
 * The browser side of an export is: chunk frames arrive out of order into a
 * Map, `export_end` closes the stream, then the map is put back together,
 * length-checked and SHA-256-verified before anything is handed to the
 * download machinery.
 */

export type ExportFailure = 'meta' | 'missing' | 'decode' | 'size' | 'crypto' | 'digest';

/** User-facing text for each verification failure (M12/M17 wording). */
export const EXPORT_ERROR_TEXT: Record<ExportFailure, string> = {
  meta: '导出失败：插件返回的文档信息不完整',
  missing: '导出失败：分块缺失，请重试',
  decode: '导出失败：分块无法解码，请重试',
  size: '导出校验失败：字节数不符，已丢弃',
  crypto: '导出失败：无法计算校验值',
  digest: '导出校验失败：内容不完整，已丢弃',
};

export type ExportVerification =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; reason: ExportFailure };

export function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function base64Of(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

/** Decode one `export_chunk` payload; null when it is not valid base64. */
export function bytesOfBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * `<title>-<YYYY-MM-DD>.md` — illegal file-name characters are replaced and
 * the title is truncated by code point (never in the middle of a surrogate
 * pair), per M12.
 */
export function exportFileName(title: string, date: Date): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base =
    Array.from(cleaned).slice(0, 50).join('').replace(/[. ]+$/, '') || 'chat';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

/**
 * Reassemble the chunks of one `export` request and verify them end to end.
 *
 * Chunk indexes are 0-based and every index in `[0, chunks)` must be present;
 * insertion order in `parts` is irrelevant. `digestHex` computes the SHA-256
 * of the assembled buffer (WebCrypto in the app, node:crypto in tests) and
 * may reject — that is reported as `crypto`, never as a digest mismatch.
 */
export async function verifyExport(
  parts: ReadonlyMap<number, string>,
  chunks: number,
  bytes: number,
  sha256: string,
  digestHex: (buffer: ArrayBuffer) => Promise<string>,
): Promise<ExportVerification> {
  if (!(chunks > 0) || !(bytes > 0) || !sha256) {
    return { ok: false, reason: 'meta' };
  }
  const ordered: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < chunks; i += 1) {
    const raw = parts.get(i);
    if (raw == null) {
      return { ok: false, reason: 'missing' };
    }
    const chunk = bytesOfBase64(raw);
    if (!chunk) {
      return { ok: false, reason: 'decode' };
    }
    ordered.push(chunk);
    total += chunk.length;
  }
  if (total !== bytes) {
    return { ok: false, reason: 'size' };
  }
  const buffer = new ArrayBuffer(total);
  const merged = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of ordered) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  let digest = '';
  try {
    digest = await digestHex(buffer);
  } catch {
    return { ok: false, reason: 'crypto' };
  }
  if (digest !== sha256.toLowerCase()) {
    return { ok: false, reason: 'digest' };
  }
  return { ok: true, buffer };
}
