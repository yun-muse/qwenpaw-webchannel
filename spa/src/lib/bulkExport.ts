/**
 * Bulk export orchestration (M25).
 *
 * The transport stays outside: `exportOne` is whatever performs one chat's
 * `export` round-trip (in the app, the existing M12 chunk frames plus the
 * save dialog). This module only decides the order, enforces the 100-chat
 * cap, reports progress and accounts for every failure. It never drops a
 * failed title silently — `bulkSummaryText` always names them.
 */

/** The server list can be long; a batch is honest about its first 100. */
export const BULK_EXPORT_LIMIT = 100;
/** How many failed titles still fit in a one-line toast. */
export const BULK_FAILURE_LIST_MAX = 3;

export interface BulkTarget {
  chat: string;
  title: string;
}

export type BulkOutcome = { ok: true } | { ok: false; reason: string };

/** `index` is 1-based and counts the chat currently being exported. */
export interface BulkProgress {
  total: number;
  index: number;
  title: string;
}

export interface BulkFailure {
  chat: string;
  title: string;
  reason: string;
}

export interface BulkRunResult {
  /** Distinct, valid targets on the server list. */
  total: number;
  /** How many of them this run will try (at most the cap). */
  planned: number;
  /** Chats whose export actually finished (success or failure). */
  attempted: number;
  succeeded: number;
  /** Every failed chat, with its reason, in run order. */
  failed: BulkFailure[];
  cancelled: boolean;
  /** Targets beyond the cap; 0 when the whole list fits. */
  skipped: number;
}

export interface BulkRunOptions {
  shouldCancel?: () => boolean;
  onProgress?: (progress: BulkProgress) => void;
  limit?: number;
}

/**
 * Normalise the server list for a batch: drop blank/duplicate ids, give a
 * missing title the chat id, and take only the first `limit` entries.
 */
export function planBulk(
  targets: readonly BulkTarget[],
  limit: number = BULK_EXPORT_LIMIT,
): { planned: BulkTarget[]; skipped: number; total: number } {
  const seen = new Set<string>();
  const valid: BulkTarget[] = [];
  for (const target of targets) {
    const chat = typeof target?.chat === 'string' ? target.chat.trim() : '';
    if (!chat || seen.has(chat)) continue;
    seen.add(chat);
    const title = typeof target.title === 'string' ? target.title.trim() : '';
    valid.push({ chat, title: title || chat });
  }
  const capped = Math.max(0, Math.floor(limit));
  return {
    planned: valid.slice(0, capped),
    skipped: Math.max(0, valid.length - capped),
    total: valid.length,
  };
}

/**
 * Export one chat at a time, in server-list order.
 *
 * Cancellation is cooperative: the caller's `shouldCancel` is checked before
 * each request and again once it resolves. A chat aborted by the cancel is
 * not counted as a failure — it simply stays un-attempted, so the summary can
 * say how many were left. The in-flight request itself must be settled by the
 * caller (the app drops the job); this loop never races a second export.
 */
export async function runBulkExport(
  targets: readonly BulkTarget[],
  exportOne: (target: BulkTarget) => Promise<BulkOutcome>,
  options: BulkRunOptions = {},
): Promise<BulkRunResult> {
  const { planned, skipped, total } = planBulk(
    targets,
    options.limit ?? BULK_EXPORT_LIMIT,
  );
  const result: BulkRunResult = {
    total,
    planned: planned.length,
    attempted: 0,
    succeeded: 0,
    failed: [],
    cancelled: false,
    skipped,
  };
  const cancelled = () => options.shouldCancel?.() === true;

  for (let i = 0; i < planned.length; i += 1) {
    if (cancelled()) {
      result.cancelled = true;
      break;
    }
    const target = planned[i];
    options.onProgress?.({ total: planned.length, index: i + 1, title: target.title });
    const outcome = await exportOne(target);
    // A cancel during the request wins over its outcome: the user asked for
    // the batch to stop, so the aborted chat is not a failed chat.
    if (cancelled()) {
      result.cancelled = true;
      break;
    }
    result.attempted += 1;
    if (outcome.ok) {
      result.succeeded += 1;
    } else {
      result.failed.push({
        chat: target.chat,
        title: target.title,
        reason: outcome.reason,
      });
    }
  }
  return result;
}

/** One-line summary for the toast; failed titles are always named. */
export function bulkSummaryText(result: BulkRunResult): string {
  if (result.total === 0) return '没有可导出的会话';
  const head = result.cancelled ? '批量导出已取消' : '批量导出完成';
  const parts = [`成功 ${result.succeeded}`, `失败 ${result.failed.length}`];
  if (result.cancelled) {
    parts.push(`剩余 ${Math.max(0, result.planned - result.attempted)} 个未导出`);
  }
  if (result.skipped > 0) {
    parts.push(`仅前 ${result.planned} 个（共 ${result.total} 个）`);
  }
  let text = `${head}：${parts.join(' · ')}`;
  const titles = result.failed.map((failure) => failure.title);
  if (titles.length > 0) {
    const shown = titles.slice(0, BULK_FAILURE_LIST_MAX).join('、');
    const more =
      titles.length > BULK_FAILURE_LIST_MAX ? ` 等 ${titles.length} 个` : '';
    text += ` — 失败：${shown}${more}（详见控制台）`;
  }
  return text;
}
