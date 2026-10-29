/**
 * Token/usage formatting and parsing, isolated from React (M21).
 *
 * Everything here is a pure function over frames or stored values; the
 * component tree only decides where the formatted text is rendered.
 */

import type { Frame } from '../relay';

/** Compact token count for the meter/receipt: 950, 12.3k, 1.2M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Full grouped number for the meter's expanded panel. */
export function formatExact(count: number): string {
  return Math.round(count).toLocaleString('zh-CN');
}

/** Per-chat usage as reported by the plugin's `usage` control frame (M11). */
export interface ChatUsage {
  inputTotal?: number;
  outputTotal?: number;
  contextTokens?: number;
  contextLimit?: number;
}

/**
 * One turn's token receipt (`hist.messages[].turn` / `usage.last_turn`, M15).
 *
 * No duration is modelled. The plugin stopped emitting `duration_ms` in M20:
 * QwenPaw's `finished_at` is stamped at the first REPLY_END, so the span was
 * always ~0 and never the turn's real duration. The SPA stopped showing one
 * in M17; an old plugin's extra field is simply ignored.
 */
export interface TurnUsage {
  id: string;
  input?: number;
  output?: number;
  total?: number;
  estimated?: boolean;
}

function usageCount(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw)
    : undefined;
}

/**
 * Parse one `turn` receipt. A receipt whose id is not a non-empty string, or
 * that carries any present-but-invalid numeric field, is dropped whole: a
 * half-parsed receipt would show numbers the server never sent.
 */
export function turnUsageOf(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || !id) return undefined;

  const turn: TurnUsage = { id };
  for (const key of ['input', 'output', 'total'] as const) {
    const value = record[key];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    turn[key] = Math.round(value);
  }
  // The plugin only emits a receipt when at least one token side is known.
  if (turn.input == null && turn.output == null) return undefined;
  if (record.estimated === true) turn.estimated = true;
  return turn;
}

/** Tooltip for one receipt: exact numbers, total and the ≈ note. */
export function turnTitle(turn: TurnUsage): string {
  const parts: string[] = [];
  if (turn.input != null) parts.push(`输入 ${turn.input}`);
  if (turn.output != null) parts.push(`输出 ${turn.output}`);
  if (turn.total != null) parts.push(`合计 ${turn.total}`);
  let text = `本轮用量${turn.estimated ? '（估算）' : ''}：${parts.join(' · ')}`;
  if (turn.estimated) text += ' · 该轮 token 数为估算值';
  return text;
}

/** Parse one `usage` frame; absent/invalid fields stay absent. */
export function usageOf(frame: Frame): ChatUsage {
  const usage: ChatUsage = {};
  const input = usageCount(frame.input_total);
  const output = usageCount(frame.output_total);
  const context = usageCount(frame.context_tokens);
  const limit = usageCount(frame.context_limit);
  if (input != null) usage.inputTotal = input;
  if (output != null) usage.outputTotal = output;
  if (context != null) usage.contextTokens = context;
  if (limit != null && limit > 0) usage.contextLimit = limit;
  return usage;
}
