/**
 * All-chats usage dashboard data (M24), isolated from React.
 *
 * The plugin sends a `stats` control frame; everything here is a pure
 * projection of that frame. Numbers that the source did not record stay
 * `undefined` — never 0 — so the view can distinguish "no data" from a real
 * zero. The only exception is `coveredChats`, whose 0 is the documented
 * "nothing covered yet" value the plugin always sends.
 */

import type { Frame } from '../relay';

export interface StatsTotals {
  turns: number;
  input?: number;
  output?: number;
}

export interface StatsDay {
  /** ISO `YYYY-MM-DD`, in the container's local calendar day. */
  date: string;
  turns: number;
  input?: number;
  output?: number;
}

export interface StatsChat {
  chat: string;
  title?: string;
  turns: number;
  input?: number;
  output?: number;
}

export interface UsageStats {
  totals: StatsTotals;
  days: StatsDay[];
  chats: StatsChat[];
  /** Chats that contributed to the numbers (the plugin always sends it). */
  coveredChats: number;
  /** Known chats with no usable data; absent when the chat list was unknown. */
  uncoveredChats?: number;
  /** Turns counted in the totals but absent from `days` (no timestamp). */
  undatedTurns?: number;
  /** Container time-zone name for the day buckets, when known. */
  dayTz?: string;
  /** Always `container-local`; kept on the wire for forward compatibility. */
  dayBasis: string;
}

/** One rendered bar: the day plus its token total and relative height. */
export interface StatsBar extends StatsDay {
  total: number;
  /** `total / maxTotal`, 0 when the series has no tokens at all. */
  ratio: number;
  /** Short axis label (`10/26`). */
  label: string;
}

function countOf(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw)
    : undefined;
}

function textOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text || undefined;
}

/** Validate a real calendar date (`2026-02-30` is rejected). */
function dayOf(raw: unknown): string | undefined {
  const text = textOf(raw);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const [year, month, day] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return text;
}

function totalsOf(raw: unknown): StatsTotals {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const totals: StatsTotals = { turns: countOf(record.turns) ?? 0 };
  const input = countOf(record.input);
  const output = countOf(record.output);
  if (input != null) totals.input = input;
  if (output != null) totals.output = output;
  return totals;
}

/**
 * Parse and sanitize the frame's day series. Invalid dates and entries
 * without a turn count are dropped; two entries for the same date are merged
 * (the plugin never sends duplicates, but a merge cannot double-count a
 * missing field the way "last wins" could).
 */
function daysOf(raw: unknown): StatsDay[] {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map<string, StatsDay>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const date = dayOf(record.date);
    const turns = countOf(record.turns);
    if (!date || turns == null) continue;
    const input = countOf(record.input);
    const output = countOf(record.output);
    const existing = byDate.get(date);
    if (!existing) {
      const day: StatsDay = { date, turns };
      if (input != null) day.input = input;
      if (output != null) day.output = output;
      byDate.set(date, day);
      continue;
    }
    existing.turns += turns;
    if (input != null) existing.input = (existing.input ?? 0) + input;
    if (output != null) existing.output = (existing.output ?? 0) + output;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function chatsOf(raw: unknown): StatsChat[] {
  if (!Array.isArray(raw)) return [];
  const out: StatsChat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const chat = textOf(record.chat);
    if (!chat) continue;
    const turns = countOf(record.turns);
    if (turns == null) continue;
    const entry: StatsChat = { chat, turns };
    const title = textOf(record.title);
    const input = countOf(record.input);
    const output = countOf(record.output);
    if (title) entry.title = title;
    if (input != null) entry.input = input;
    if (output != null) entry.output = output;
    out.push(entry);
  }
  return out;
}

/**
 * Project one `stats` frame. A bare frame (`{"t":"stats"}`) is the plugin's
 * "nothing to report" reply and becomes an empty dashboard, not an error.
 */
export function statsOf(frame: Frame): UsageStats {
  return {
    totals: totalsOf(frame.totals),
    days: daysOf(frame.days),
    chats: chatsOf(frame.chats),
    coveredChats: countOf(frame.covered_chats) ?? 0,
    uncoveredChats: countOf(frame.uncovered_chats),
    undatedTurns: countOf(frame.undated_turns),
    dayTz: textOf(frame.day_tz),
    dayBasis: textOf(frame.day_basis) ?? 'container-local',
  };
}

/** `2026-10-26` -> `10/26` (short axis label; the full date stays in a title). */
export function dayLabel(date: string): string {
  return date.length === 10 ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : date;
}

/**
 * Shape the day series for the bar chart: ascending days, token totals and a
 * relative height. A day whose receipt carried no token side still renders
 * with a 0 ratio, so the turn count is never hidden.
 */
export function statsBars(days: readonly StatsDay[]): StatsBar[] {
  const bars = days.map((day) => ({
    ...day,
    total: (day.input ?? 0) + (day.output ?? 0),
    ratio: 0,
    label: dayLabel(day.date),
  }));
  const max = bars.reduce((top, bar) => Math.max(top, bar.total), 0);
  for (const bar of bars) bar.ratio = max > 0 ? bar.total / max : 0;
  return bars;
}
