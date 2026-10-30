/**
 * Single-file backup of every chat (M34). Pure helpers only — the transport,
 * the confirmation dialog and the download live in App.tsx.
 *
 * The archive is assembled by `ZipWriter` (lib/zip.ts) one chat at a time.
 * This module owns everything around it: the backup file name, per-chat
 * archive names with duplicate-title dedupe (reusing the single-export
 * cleaning rule), the two manifest documents inside the archive, and the
 * size guard. The run itself reuses M25's `runBulkExport`, so the 100-chat
 * cap, the progress shape and the failure accounting are literally the ones
 * 导出全部 already uses.
 */

import { BULK_EXPORT_LIMIT } from './bulkExport';
import type { BulkRunResult, BulkTarget } from './bulkExport';
import { exportFileName } from './export';

/** Recommendation shown in the UI before a very large archive is continued. */
export const BACKUP_SIZE_WARN_BYTES = 200 * 1024 * 1024;
export const BACKUP_INDEX_NAME = 'index.md';
export const BACKUP_MANIFEST_NAME = 'backup.json';
export const BACKUP_FORMAT_VERSION = 1;
/** How much of a document is scanned for the M20 `消息条数` header line. */
const HEADER_SCAN_BYTES = 8 * 1024;

export type BackupStatus = 'ok' | 'failed';

export interface BackupChatRecord {
  id: string;
  title: string;
  /** Archive name of the .md; null when this chat produced no file. */
  filename: string | null;
  /** `- 消息条数：N` from the exported document; null when unreadable. */
  messages: number | null;
  status: BackupStatus;
  /** Present on failures only; never empty. */
  reason?: string;
  /** Stored Markdown size in bytes (failures have none). */
  bytes?: number;
}

export interface BackupProduced {
  bytes: number;
  messages: number | null;
}

/** `webchannel-backup-YYYYMMDD-HHmm.zip`, local wall clock. */
export function backupFileName(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `webchannel-backup-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}.zip`
  );
}

/**
 * Archive name per chat: the single-export name (`<title>-<date>.md`), with
 * ` (2)`, ` (3)`… appended before the extension when two chats clean down to
 * the same title. Comparison is case-insensitive because a Windows or macOS
 * unzip target is: `Alpha.md` and `alpha.md` cannot both exist there.
 */
export function uniqueChatFileNames(
  targets: readonly BulkTarget[],
  when: Date,
): Map<string, string> {
  const taken = new Set<string>([BACKUP_INDEX_NAME.toLowerCase(), BACKUP_MANIFEST_NAME]);
  const names = new Map<string, string>();
  for (const target of targets) {
    const base = exportFileName(target.title, when);
    const stem = base.replace(/\.md$/i, '');
    let name = base;
    let suffix = 2;
    while (taken.has(name.toLowerCase())) {
      name = `${stem} (${suffix}).md`;
      suffix += 1;
    }
    taken.add(name.toLowerCase());
    names.set(target.chat, name);
  }
  return names;
}

/**
 * Message count from the exported document's own header (M20):
 * `- 消息条数：12`. Only the head of the file is decoded — a 10 MB document
 * does not need a full pass to read its first lines. A document without the
 * line (older plugin, or a failed export) reports null, never 0.
 */
export function messageCountOf(markdown: Uint8Array): number | null {
  let head = '';
  try {
    head = new TextDecoder('utf-8').decode(markdown.subarray(0, HEADER_SCAN_BYTES));
  } catch {
    return null;
  }
  const match = /^[-*] 消息条数：(\d+)\s*$/m.exec(head);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * One record per chat that was actually attempted, in run order.
 *
 * Failures are taken from `result.failed` (not from the caller's bookkeeping),
 * so a chat that failed can never be missing from the manifests. Chats the
 * cancel left untouched are simply absent — they are neither backed up nor
 * failed, and the summary states their number separately.
 */
export function buildBackupRecords(
  planned: readonly BulkTarget[],
  result: BulkRunResult,
  produced: ReadonlyMap<string, BackupProduced>,
  names: ReadonlyMap<string, string>,
): BackupChatRecord[] {
  const failures = new Map(result.failed.map((failure) => [failure.chat, failure.reason]));
  const records: BackupChatRecord[] = [];
  for (const target of planned) {
    const file = produced.get(target.chat);
    if (file) {
      records.push({
        id: target.chat,
        title: target.title,
        filename: names.get(target.chat) ?? null,
        messages: file.messages,
        status: 'ok',
        bytes: file.bytes,
      });
      continue;
    }
    const reason = failures.get(target.chat);
    if (reason != null) {
      records.push({
        id: target.chat,
        title: target.title,
        filename: null,
        messages: null,
        status: 'failed',
        reason,
      });
    }
  }
  return records;
}

export interface BackupDocumentInput {
  generatedAt: Date;
  buildId: string;
  records: readonly BackupChatRecord[];
  result: BulkRunResult;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm:ss` in local time (matches the backup file name). */
export function formatBackupTime(when: Date): string {
  return (
    `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} ` +
    `${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}`
  );
}

/** `1.2 MB` / `340 KB` / `12 B` for toasts and the index header. */
export function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Escape a cell for a Markdown table: pipes and newlines would break it. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * A link target that survives spaces and parentheses: CommonMark accepts
 * `<...>` destinations, which is what ` (2)` suffixes need.
 */
function link(filename: string): string {
  return `[${filename}](<${filename}>)`;
}

/**
 * `index.md` — the human half of the archive: when it was taken, what each
 * chat looks like, and every failure with its reason.
 */
export function buildBackupIndex(input: BackupDocumentInput): string {
  const { generatedAt, buildId, records, result } = input;
  const lines: string[] = [
    '# WebChannel 会话备份',
    '',
    `- 备份时间：${formatBackupTime(generatedAt)}`,
    `- 生成工具：QwenPaw WebChannel（构建 ${buildId || '未知'}）`,
    `- 会话：成功 ${result.succeeded} · 失败 ${result.failed.length}`,
    '- 导出口径：每个 .md 与「导出当前会话」的内容完全一致（插件导出，未做改写）',
  ];
  if (result.skipped > 0) {
    lines.push(
      `- 上限：仅备份前 ${result.planned} 个会话（共 ${result.total} 个），其余 ${result.skipped} 个未备份`,
    );
  }
  lines.push('', '## 会话', '');
  if (records.length === 0) {
    lines.push('（本次没有任何会话被备份）', '');
  } else {
    lines.push('| # | 标题 | 消息数 | 状态 | 文件 |', '| --- | --- | --- | --- | --- |');
    records.forEach((record, index) => {
      const messages = record.messages == null ? '—' : String(record.messages);
      const status = record.status === 'ok' ? '成功' : '失败';
      const file = record.filename ? link(record.filename) : '—';
      lines.push(`| ${index + 1} | ${cell(record.title)} | ${messages} | ${status} | ${file} |`);
    });
    lines.push('');
  }

  const failures = records.filter((record) => record.status === 'failed');
  if (failures.length > 0) {
    lines.push('## 失败', '');
    for (const failure of failures) {
      lines.push(`- **${cell(failure.title)}**（\`${failure.id}\`）：${cell(failure.reason ?? '未知原因')}`);
    }
    lines.push('');
  }

  lines.push(
    '---',
    '',
    `机器可读清单见 \`${BACKUP_MANIFEST_NAME}\`。解压后每个会话一个 Markdown 文件，可直接用任意编辑器打开。`,
    '',
  );
  return lines.join('\n');
}

export interface BackupManifestChat {
  id: string;
  title: string;
  filename: string | null;
  messages: number | null;
  status: BackupStatus;
  bytes?: number;
  reason?: string;
}

export interface BackupManifest {
  generator: string;
  format: number;
  generated_at: string;
  build_id: string;
  limit: number;
  total: number;
  planned: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
  skipped: number;
  unprocessed: number;
  index: string;
  chats: BackupManifestChat[];
  failures: Array<{ id: string; title: string; reason: string }>;
}

export function buildBackupManifest(input: BackupDocumentInput): BackupManifest {
  const { generatedAt, buildId, records, result } = input;
  return {
    generator: 'qwenpaw-webchannel',
    format: BACKUP_FORMAT_VERSION,
    generated_at: generatedAt.toISOString(),
    build_id: buildId || '',
    limit: BULK_EXPORT_LIMIT,
    total: result.total,
    planned: result.planned,
    succeeded: result.succeeded,
    failed: result.failed.length,
    cancelled: result.cancelled,
    skipped: result.skipped,
    unprocessed: Math.max(0, result.planned - result.attempted),
    index: BACKUP_INDEX_NAME,
    chats: records.map((record) => {
      const entry: BackupManifestChat = {
        id: record.id,
        title: record.title,
        filename: record.filename,
        messages: record.messages,
        status: record.status,
      };
      if (record.status === 'ok' && record.bytes != null) entry.bytes = record.bytes;
      if (record.status === 'failed') entry.reason = record.reason ?? '未知原因';
      return entry;
    }),
    failures: records
      .filter((record) => record.status === 'failed')
      .map((record) => ({
        id: record.id,
        title: record.title,
        reason: record.reason ?? '未知原因',
      })),
  };
}

/** Pretty JSON + trailing newline (a manifest a human may also open). */
export function serializeBackupManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Fires once when the archive grows past the warning size. The caller asks
 * the user before the next chat is fetched; the run may still continue.
 */
export class BackupSizeGuard {
  private warned = false;

  constructor(private readonly limit: number = BACKUP_SIZE_WARN_BYTES) {}

  /** True exactly on the first call whose running total exceeds the limit. */
  check(totalBytes: number): boolean {
    if (this.warned || totalBytes <= this.limit) return false;
    this.warned = true;
    return true;
  }
}

/** Toast line for a finished or cancelled backup. */
export function backupSummaryText(result: BulkRunResult, bytes: number): string {
  if (result.total === 0) return '没有可备份的会话';
  if (result.cancelled) {
    const left = Math.max(0, result.planned - result.attempted);
    return (
      `备份已取消：已完成 ${result.attempted} 个` +
      `（成功 ${result.succeeded} · 失败 ${result.failed.length}）· 剩余 ${left} 个未备份`
    );
  }
  const parts = [
    `成功 ${result.succeeded}`,
    `失败 ${result.failed.length}`,
    `${formatBackupSize(bytes)}`,
  ];
  if (result.skipped > 0) {
    parts.push(`仅前 ${result.planned} 个（共 ${result.total} 个）`);
  }
  let text = `备份完成：${parts.join(' · ')}`;
  const titles = result.failed.map((failure) => failure.title);
  if (titles.length > 0) {
    const shown = titles.slice(0, 3).join('、');
    const more = titles.length > 3 ? ` 等 ${titles.length} 个` : '';
    text += ` — 失败：${shown}${more}（详见 index.md）`;
  }
  return text;
}
