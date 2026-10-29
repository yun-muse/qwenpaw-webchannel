import { describe, expect, it } from 'vitest';
import {
  BULK_EXPORT_LIMIT,
  BULK_FAILURE_LIST_MAX,
  bulkSummaryText,
  planBulk,
  runBulkExport,
} from '../src/lib/bulkExport';
import type { BulkOutcome, BulkProgress, BulkRunResult, BulkTarget } from '../src/lib/bulkExport';

function targetsOf(count: number, prefix = 'chat'): BulkTarget[] {
  return Array.from({ length: count }, (_, i) => ({
    chat: `${prefix}-${i + 1}`,
    title: `会话 ${i + 1}`,
  }));
}

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

describe('planBulk', () => {
  it('keeps server order, drops blanks/duplicates and fills a missing title', () => {
    const plan = planBulk([
      { chat: 'b', title: '第二个' },
      { chat: '', title: '空 id' },
      { chat: 'a', title: '  ' },
      { chat: 'b', title: '重复' },
      { chat: 'c', title: ' 第三个 ' },
    ]);
    expect(plan.planned).toEqual([
      { chat: 'b', title: '第二个' },
      { chat: 'a', title: 'a' },
      { chat: 'c', title: '第三个' },
    ]);
    expect(plan.total).toBe(3);
    expect(plan.skipped).toBe(0);
  });

  it('caps the batch at 100 chats and reports what was left out', () => {
    expect(BULK_EXPORT_LIMIT).toBe(100);
    const plan = planBulk(targetsOf(128));
    expect(plan.planned).toHaveLength(100);
    expect(plan.planned[0].chat).toBe('chat-1');
    expect(plan.planned[99].chat).toBe('chat-100');
    expect(plan.total).toBe(128);
    expect(plan.skipped).toBe(28);
  });

  it('honours a smaller custom limit and never goes negative', () => {
    expect(planBulk(targetsOf(5), 2).skipped).toBe(3);
    expect(planBulk(targetsOf(5), 0).planned).toEqual([]);
    expect(planBulk(targetsOf(5), 0).skipped).toBe(5);
    expect(planBulk([], 10).planned).toEqual([]);
  });
});

describe('runBulkExport', () => {
  it('exports strictly one at a time, in server order', async () => {
    const targets = targetsOf(4);
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await runBulkExport(targets, async (target) => {
      calls.push(target.chat);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true } as BulkOutcome;
    });
    expect(calls).toEqual(['chat-1', 'chat-2', 'chat-3', 'chat-4']);
    expect(maxActive).toBe(1);
    expect(result).toEqual({
      total: 4,
      planned: 4,
      attempted: 4,
      succeeded: 4,
      failed: [],
      cancelled: false,
      skipped: 0,
    });
  });

  it('reports 1-based progress with the current title before each export', async () => {
    const progress: BulkProgress[] = [];
    await runBulkExport(targetsOf(3), async () => ({ ok: true }), {
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(progress).toEqual([
      { total: 3, index: 1, title: '会话 1' },
      { total: 3, index: 2, title: '会话 2' },
      { total: 3, index: 3, title: '会话 3' },
    ]);
  });

  it('records every failure with its chat id, title and reason', async () => {
    const targets: BulkTarget[] = [
      { chat: 'a', title: '甲' },
      { chat: 'b', title: '乙' },
      { chat: 'c', title: '丙' },
    ];
    const result = await runBulkExport(targets, async (target) => {
      if (target.chat === 'b') return { ok: false, reason: '导出失败：分块缺失，请重试' };
      return { ok: true };
    });
    expect(result.succeeded).toBe(2);
    expect(result.attempted).toBe(3);
    expect(result.failed).toEqual([
      { chat: 'b', title: '乙', reason: '导出失败：分块缺失，请重试' },
    ]);
  });

  it('stops before the first export when already cancelled', async () => {
    let calls = 0;
    const result = await runBulkExport(
      targetsOf(3),
      async () => {
        calls += 1;
        return { ok: true };
      },
      { shouldCancel: () => true },
    );
    expect(calls).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(result.attempted).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('does not start the next chat and does not blame the aborted one', async () => {
    const calls: string[] = [];
    let cancel = false;
    const result = await runBulkExport(
      targetsOf(3),
      async (target) => {
        calls.push(target.chat);
        if (target.chat === 'chat-2') {
          cancel = true;
          return { ok: false, reason: '已取消' };
        }
        return { ok: true };
      },
      { shouldCancel: () => cancel },
    );
    expect(calls).toEqual(['chat-1', 'chat-2']);
    expect(result.cancelled).toBe(true);
    expect(result.succeeded).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('stops after a normal failure only when the user asked to', async () => {
    const result = await runBulkExport(targetsOf(3), async () => ({
      ok: false,
      reason: '导出失败：文档超过 10MB',
    }));
    expect(result.attempted).toBe(3);
    expect(result.failed).toHaveLength(3);
    expect(result.cancelled).toBe(false);
  });

  it('only touches the first 100 chats of a longer server list', async () => {
    const calls: string[] = [];
    const result = await runBulkExport(targetsOf(105), async (target) => {
      calls.push(target.chat);
      return { ok: true };
    });
    expect(calls).toHaveLength(100);
    expect(calls[99]).toBe('chat-100');
    expect(result.planned).toBe(100);
    expect(result.skipped).toBe(5);
    expect(result.total).toBe(105);
    expect(result.succeeded).toBe(100);
  });

  it('returns an empty, honest result for an empty list', async () => {
    const result = await runBulkExport([], async () => ({ ok: true }));
    expect(result).toEqual(resultOf({}));
    expect(bulkSummaryText(result)).toBe('没有可导出的会话');
  });
});

describe('bulkSummaryText', () => {
  it('reports a clean success', () => {
    const result = resultOf({
      total: 4,
      planned: 4,
      attempted: 4,
      succeeded: 4,
    });
    expect(bulkSummaryText(result)).toBe('批量导出完成：成功 4 · 失败 0');
  });

  it('names each failed title and points at the console', () => {
    const result = resultOf({
      total: 2,
      planned: 2,
      attempted: 2,
      succeeded: 0,
      failed: [
        { chat: 'a', title: '甲', reason: 'E_EXPORT' },
        { chat: 'b', title: '乙', reason: 'E_TOOBIG' },
      ],
    });
    expect(bulkSummaryText(result)).toBe(
      '批量导出完成：成功 0 · 失败 2 — 失败：甲、乙（详见控制台）',
    );
  });

  it('truncates the toast list but says how many failures there are', () => {
    const failed = Array.from({ length: BULK_FAILURE_LIST_MAX + 2 }, (_, i) => ({
      chat: `c${i}`,
      title: `会话${i + 1}`,
      reason: 'E_EXPORT',
    }));
    const result = resultOf({
      total: 5,
      planned: 5,
      attempted: 5,
      failed,
    });
    const text = bulkSummaryText(result);
    expect(text).toContain('失败：会话1、会话2、会话3 等 5 个（详见控制台）');
    expect(text).not.toContain('会话4');
  });

  it('counts the un-attempted chats of a cancelled run', () => {
    const result = resultOf({
      total: 10,
      planned: 10,
      attempted: 3,
      succeeded: 3,
      cancelled: true,
    });
    expect(bulkSummaryText(result)).toBe(
      '批量导出已取消：成功 3 · 失败 0 · 剩余 7 个未导出',
    );
  });

  it('states the 100-chat cap when the list is longer', () => {
    const result = resultOf({
      total: 140,
      planned: 100,
      attempted: 100,
      succeeded: 100,
      skipped: 40,
    });
    expect(bulkSummaryText(result)).toBe(
      '批量导出完成：成功 100 · 失败 0 · 仅前 100 个（共 140 个）',
    );
  });
});
