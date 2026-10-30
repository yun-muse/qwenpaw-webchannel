import { describe, expect, it } from 'vitest';
import {
  BACKUP_INDEX_NAME,
  BACKUP_MANIFEST_NAME,
  BACKUP_SIZE_WARN_BYTES,
  BackupSizeGuard,
  backupFileName,
  backupSummaryText,
  buildBackupIndex,
  buildBackupManifest,
  buildBackupRecords,
  formatBackupSize,
  messageCountOf,
  serializeBackupManifest,
  uniqueChatFileNames,
} from '../src/lib/backup';
import type { BackupProduced } from '../src/lib/backup';
import type { BulkRunResult, BulkTarget } from '../src/lib/bulkExport';

const WHEN = new Date(2026, 9, 30, 15, 42, 9);

function resultOf(patch: Partial<BulkRunResult>): BulkRunResult {
  return {
    total: 0,
    planned: 0,
    attempted: 0,
    succeeded: 0,
    failed: [],
    cancelled: false,
    skipped: 0,
    ...patch,
  };
}

function docOf(messages: number | null, body = '正文'): Uint8Array {
  const header = [
    '# 会话',
    '',
    '- 导出时间：2026-10-30 15:42:00',
    ...(messages == null ? [] : [`- 消息条数：${messages}`]),
    '- 导出口径：当前 QwenPaw 历史',
    '',
    body,
    '',
  ];
  return new TextEncoder().encode(header.join('\n'));
}

describe('backupFileName', () => {
  it('is webchannel-backup-YYYYMMDD-HHmm.zip in local time', () => {
    expect(backupFileName(WHEN)).toBe('webchannel-backup-20261030-1542.zip');
    expect(backupFileName(new Date(2026, 0, 2, 3, 4))).toBe('webchannel-backup-20260102-0304.zip');
  });
});

describe('uniqueChatFileNames', () => {
  it('reuses the single-export name for a unique title', () => {
    const names = uniqueChatFileNames([{ chat: 'a', title: 'Alpha 会话' }], WHEN);
    expect(names.get('a')).toBe('Alpha 会话-2026-10-30.md');
  });

  it('suffixes duplicate titles before the extension', () => {
    const names = uniqueChatFileNames(
      [
        { chat: 'a', title: '同名' },
        { chat: 'b', title: '同名' },
        { chat: 'c', title: '同名' },
      ],
      WHEN,
    );
    expect(names.get('a')).toBe('同名-2026-10-30.md');
    expect(names.get('b')).toBe('同名-2026-10-30 (2).md');
    expect(names.get('c')).toBe('同名-2026-10-30 (3).md');
  });

  it('treats names case-insensitively (a Windows/macOS unzip target)', () => {
    const names = uniqueChatFileNames(
      [
        { chat: 'a', title: 'Alpha' },
        { chat: 'b', title: 'alpha' },
      ],
      WHEN,
    );
    expect(names.get('a')).toBe('Alpha-2026-10-30.md');
    expect(names.get('b')).toBe('alpha-2026-10-30 (2).md');
  });

  it('applies the single-export cleaning rule before deduping', () => {
    const names = uniqueChatFileNames(
      [
        { chat: 'a', title: 'a/b:c*?' },
        { chat: 'b', title: 'a_b_c__' },
      ],
      WHEN,
    );
    expect(names.get('a')).toBe('a_b_c__-2026-10-30.md');
    expect(names.get('b')).toBe('a_b_c__-2026-10-30 (2).md');
  });

  it('never hands out the manifest names', () => {
    const names = uniqueChatFileNames([{ chat: 'a', title: 'index' }], WHEN);
    expect(names.get('a')).not.toBe(BACKUP_INDEX_NAME);
    expect(names.get('a')).not.toBe(BACKUP_MANIFEST_NAME);
  });
});

describe('messageCountOf', () => {
  it('reads the M20 header line', () => {
    expect(messageCountOf(docOf(12))).toBe(12);
    expect(messageCountOf(docOf(0))).toBe(0);
  });

  it('returns null when the document has no such line', () => {
    expect(messageCountOf(docOf(null))).toBeNull();
    expect(messageCountOf(new TextEncoder().encode('# nothing here'))).toBeNull();
    expect(messageCountOf(new Uint8Array(0))).toBeNull();
  });

  it('only scans the head of the document', () => {
    const late = new TextEncoder().encode(`${'x'.repeat(9000)}\n- 消息条数：7\n`);
    expect(messageCountOf(late)).toBeNull();
  });
});

describe('buildBackupRecords', () => {
  const planned: BulkTarget[] = [
    { chat: 'a', title: '甲' },
    { chat: 'b', title: '乙' },
    { chat: 'c', title: '丙' },
  ];
  const names = new Map([
    ['a', '甲-2026-10-30.md'],
    ['b', '乙-2026-10-30.md'],
    ['c', '丙-2026-10-30.md'],
  ]);

  it('lists successes and failures in run order', () => {
    const produced = new Map<string, BackupProduced>([
      ['a', { bytes: 120, messages: 4 }],
      ['c', { bytes: 90, messages: null }],
    ]);
    const result = resultOf({
      total: 3,
      planned: 3,
      attempted: 3,
      succeeded: 2,
      failed: [{ chat: 'b', title: '乙', reason: '导出失败：分块缺失，请重试' }],
    });
    expect(buildBackupRecords(planned, result, produced, names)).toEqual([
      {
        id: 'a',
        title: '甲',
        filename: '甲-2026-10-30.md',
        messages: 4,
        status: 'ok',
        bytes: 120,
      },
      {
        id: 'b',
        title: '乙',
        filename: null,
        messages: null,
        status: 'failed',
        reason: '导出失败：分块缺失，请重试',
      },
      { id: 'c', title: '丙', filename: '丙-2026-10-30.md', messages: null, status: 'ok', bytes: 90 },
    ]);
  });

  it('never drops a failure that produced no bytes', () => {
    const result = resultOf({
      total: 1,
      planned: 1,
      attempted: 1,
      failed: [{ chat: 'a', title: '甲', reason: '未连接 — 无法导出' }],
    });
    const records = buildBackupRecords(planned.slice(0, 1), result, new Map(), names);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].reason).toBe('未连接 — 无法导出');
  });

  it('omits chats the cancel left untouched', () => {
    const produced = new Map<string, BackupProduced>([['a', { bytes: 10, messages: 1 }]]);
    const result = resultOf({
      total: 3,
      planned: 3,
      attempted: 1,
      succeeded: 1,
      cancelled: true,
    });
    expect(buildBackupRecords(planned, result, produced, names).map((r) => r.id)).toEqual(['a']);
  });
});

describe('buildBackupIndex', () => {
  const records = [
    {
      id: 'a',
      title: '甲 | 报表',
      filename: '甲-2026-10-30.md',
      messages: 12,
      status: 'ok' as const,
      bytes: 500,
    },
    {
      id: 'b',
      title: '乙',
      filename: null,
      messages: null,
      status: 'failed' as const,
      reason: '导出失败：文档超过 10MB',
    },
  ];
  const result = resultOf({
    total: 5,
    planned: 4,
    attempted: 2,
    succeeded: 1,
    failed: [{ chat: 'b', title: '乙', reason: '导出失败：文档超过 10MB' }],
    skipped: 1,
  });

  it('states when, how many and by which build', () => {
    const text = buildBackupIndex({
      generatedAt: WHEN,
      buildId: '2026-10-30-abcd123',
      records,
      result,
    });
    expect(text.startsWith('# WebChannel 会话备份')).toBe(true);
    expect(text).toContain('- 备份时间：2026-10-30 15:42:09');
    expect(text).toContain('- 生成工具：QwenPaw WebChannel（构建 2026-10-30-abcd123）');
    expect(text).toContain('- 会话：成功 1 · 失败 1');
    expect(text).toContain('其余 1 个未备份');
  });

  it('lists every chat with its count, status and an in-archive link', () => {
    const text = buildBackupIndex({ generatedAt: WHEN, buildId: 'b', records, result });
    expect(text).toContain('| 1 | 甲 \\| 报表 | 12 | 成功 | [甲-2026-10-30.md](<甲-2026-10-30.md>) |');
    expect(text).toContain('| 2 | 乙 | — | 失败 | — |');
  });

  it('names every failure with its reason', () => {
    const text = buildBackupIndex({ generatedAt: WHEN, buildId: 'b', records, result });
    expect(text).toContain('## 失败');
    expect(text).toContain('- **乙**（`b`）：导出失败：文档超过 10MB');
  });

  it('says so when nothing was backed up', () => {
    const text = buildBackupIndex({
      generatedAt: WHEN,
      buildId: 'b',
      records: [],
      result: resultOf({ total: 0 }),
    });
    expect(text).toContain('（本次没有任何会话被备份）');
    expect(text).not.toContain('## 失败');
  });
});

describe('buildBackupManifest', () => {
  const records = [
    {
      id: 'a',
      title: '甲',
      filename: '甲-2026-10-30.md',
      messages: 12,
      status: 'ok' as const,
      bytes: 500,
    },
    {
      id: 'b',
      title: '乙',
      filename: null,
      messages: null,
      status: 'failed' as const,
      reason: '导出失败：分块缺失，请重试',
    },
  ];
  const result = resultOf({
    total: 3,
    planned: 3,
    attempted: 3,
    succeeded: 1,
    failed: [{ chat: 'b', title: '乙', reason: '导出失败：分块缺失，请重试' }],
  });

  it('is machine-readable and carries every field the brief asks for', () => {
    const manifest = buildBackupManifest({ generatedAt: WHEN, buildId: 'build-7', records, result });
    const parsed = JSON.parse(serializeBackupManifest(manifest));

    expect(parsed.generator).toBe('qwenpaw-webchannel');
    expect(parsed.format).toBe(1);
    expect(parsed.generated_at).toBe(WHEN.toISOString());
    expect(parsed.build_id).toBe('build-7');
    expect(parsed.limit).toBe(100);
    expect(parsed.index).toBe(BACKUP_INDEX_NAME);
    expect(parsed.chats).toEqual([
      {
        id: 'a',
        title: '甲',
        filename: '甲-2026-10-30.md',
        messages: 12,
        status: 'ok',
        bytes: 500,
      },
      {
        id: 'b',
        title: '乙',
        filename: null,
        messages: null,
        status: 'failed',
        reason: '导出失败：分块缺失，请重试',
      },
    ]);
    expect(parsed.failures).toEqual([
      { id: 'b', title: '乙', reason: '导出失败：分块缺失，请重试' },
    ]);
  });

  it('counts a cancelled run honestly', () => {
    const manifest = buildBackupManifest({
      generatedAt: WHEN,
      buildId: 'b',
      records: records.slice(0, 1),
      result: resultOf({
        total: 10,
        planned: 10,
        attempted: 3,
        succeeded: 3,
        cancelled: true,
      }),
    });
    expect(manifest.cancelled).toBe(true);
    expect(manifest.unprocessed).toBe(7);
  });

  it('serialises with a trailing newline', () => {
    const text = serializeBackupManifest(
      buildBackupManifest({ generatedAt: WHEN, buildId: 'b', records: [], result: resultOf({}) }),
    );
    expect(text.endsWith('}\n')).toBe(true);
  });
});

describe('BackupSizeGuard', () => {
  it('fires exactly once, only above 200 MB', () => {
    expect(BACKUP_SIZE_WARN_BYTES).toBe(200 * 1024 * 1024);
    const guard = new BackupSizeGuard();
    expect(guard.check(BACKUP_SIZE_WARN_BYTES)).toBe(false);
    expect(guard.check(BACKUP_SIZE_WARN_BYTES + 1)).toBe(true);
    expect(guard.check(BACKUP_SIZE_WARN_BYTES * 2)).toBe(false);
  });

  it('honours a smaller limit in tests', () => {
    const guard = new BackupSizeGuard(10);
    expect(guard.check(9)).toBe(false);
    expect(guard.check(11)).toBe(true);
  });
});

describe('backupSummaryText', () => {
  it('reports a clean archive with its size', () => {
    expect(
      backupSummaryText(resultOf({ total: 2, planned: 2, attempted: 2, succeeded: 2 }), 1_258_291),
    ).toBe('备份完成：成功 2 · 失败 0 · 1.2 MB');
  });

  it('names failed chats and points at index.md', () => {
    const text = backupSummaryText(
      resultOf({
        total: 2,
        planned: 2,
        attempted: 2,
        succeeded: 1,
        failed: [
          { chat: 'a', title: '甲', reason: 'E_EXPORT' },
          { chat: 'b', title: '乙', reason: 'E_EXPORT' },
        ],
      }),
      2048,
    );
    expect(text).toBe('备份完成：成功 1 · 失败 2 · 2 KB — 失败：甲、乙（详见 index.md）');
  });

  it('states completed and remaining counts after a cancel', () => {
    expect(
      backupSummaryText(
        resultOf({
          total: 10,
          planned: 10,
          attempted: 3,
          succeeded: 2,
          failed: [{ chat: 'c', title: '丙', reason: 'E_EXPORT' }],
          cancelled: true,
        }),
        100,
      ),
    ).toBe('备份已取消：已完成 3 个（成功 2 · 失败 1）· 剩余 7 个未备份');
  });

  it('states the cap and the empty case', () => {
    expect(
      backupSummaryText(resultOf({ total: 140, planned: 100, attempted: 100, succeeded: 100, skipped: 40 }), 0),
    ).toBe('备份完成：成功 100 · 失败 0 · 0 B · 仅前 100 个（共 140 个）');
    expect(backupSummaryText(resultOf({}), 0)).toBe('没有可备份的会话');
  });
});

describe('formatBackupSize', () => {
  it('switches units at the expected thresholds', () => {
    expect(formatBackupSize(12)).toBe('12 B');
    expect(formatBackupSize(2048)).toBe('2 KB');
    expect(formatBackupSize(1_572_864)).toBe('1.5 MB');
  });
});
