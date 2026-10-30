/**
 * All-chats usage dashboard data (M24, extended in M28 with cache + models).
 *
 * The plugin sends a `stats` control frame; everything here is a pure
 * projection of that frame. Numbers that the source did not record stay
 * `undefined` — never 0 — so the view can distinguish "no data" from a real
 * zero. The only exception is `coveredChats`, whose 0 is the documented
 * "nothing covered yet" value the plugin always sends.
 *
 * Cache figures follow protocol §14.5: a turn without a provider-reported
 * cache reading contributes nothing, so a row either carries a complete
 * `cache_hit / cache_miss / cache_eligible` triple or none at all. The hit
 * rate is recomputed from the integer sums on this side too, so a per-turn
 * average can never be displayed even if a foreign frame sent one.
 */

import type { Frame } from '../relay';

/** One complete cache reading: `hit + miss === eligible > 0`. */
export interface StatsCache {
  hit: number;
  miss: number;
  eligible: number;
  /** `hit / eligible * 100`, rounded to 2 decimals (same as the plugin). */
  rate: number;
}

export interface StatsTotals {
  turns: number;
  input?: number;
  output?: number;
  cache?: StatsCache;
}

export interface StatsDay {
  /** ISO `YYYY-MM-DD`, in the container's local calendar day. */
  date: string;
  turns: number;
  input?: number;
  output?: number;
  cache?: StatsCache;
}

/** One `by_model` row: the turn's own provider/model attribution (M28). */
export interface StatsModel {
  model: string;
  provider?: string;
  turns: number;
  input?: number;
  output?: number;
  cache?: StatsCache;
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
  /** Per-model rows, `input` descending; empty when nothing is covered. */
  byModel: StatsModel[];
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
  /** Day cache hit rate (0-100); absent when no turn reported cache. */
  hitRate?: number;
}

type Row = Record<string, unknown>;

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

function rateOf(hit: number, eligible: number): number {
  if (eligible <= 0) return 0;
  return Math.round((hit / eligible) * 10_000) / 100;
}

/**
 * One complete cache reading, or `undefined` when the row has none.
 *
 * Incomplete or contradictory triples (a missing side, `eligible <= 0`,
 * `hit + miss !== eligible`) are treated as "not reported": showing part of
 * one would invent a denominator or a hit rate the provider never sent. The
 * sent `cache_hit_rate` is ignored — the rate is always `Σhit / Σeligible`.
 */
function cacheOf(record: Row): StatsCache | undefined {
  const hit = countOf(record.cache_hit);
  const miss = countOf(record.cache_miss);
  const eligible = countOf(record.cache_eligible);
  if (hit == null || miss == null || eligible == null) return undefined;
  if (eligible <= 0 || hit + miss !== eligible) return undefined;
  return { hit, miss, eligible, rate: rateOf(hit, eligible) };
}

/** Fold one more cache reading into an existing one (duplicate day rows). */
function addCache(into: StatsCache, from: StatsCache): void {
  into.hit += from.hit;
  into.miss += from.miss;
  into.eligible += from.eligible;
  into.rate = rateOf(into.hit, into.eligible);
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
  const record = raw && typeof raw === 'object' ? (raw as Row) : {};
  const totals: StatsTotals = { turns: countOf(record.turns) ?? 0 };
  const input = countOf(record.input);
  const output = countOf(record.output);
  const cache = cacheOf(record);
  if (input != null) totals.input = input;
  if (output != null) totals.output = output;
  if (cache) totals.cache = cache;
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
    const record = item as Row;
    const date = dayOf(record.date);
    const turns = countOf(record.turns);
    if (!date || turns == null) continue;
    const input = countOf(record.input);
    const output = countOf(record.output);
    const cache = cacheOf(record);
    const existing = byDate.get(date);
    if (!existing) {
      const day: StatsDay = { date, turns };
      if (input != null) day.input = input;
      if (output != null) day.output = output;
      if (cache) day.cache = cache;
      byDate.set(date, day);
      continue;
    }
    existing.turns += turns;
    if (input != null) existing.input = (existing.input ?? 0) + input;
    if (output != null) existing.output = (existing.output ?? 0) + output;
    if (cache) {
      if (existing.cache) addCache(existing.cache, cache);
      else existing.cache = { ...cache };
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function chatsOf(raw: unknown): StatsChat[] {
  if (!Array.isArray(raw)) return [];
  const out: StatsChat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Row;
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
 * Per-model rows. A row without a model name or a turn count is dropped; the
 * plugin's `未知模型` bucket is an ordinary row here (its name says the model
 * is unknown, which is the truth). Rows are re-sorted by input descending so
 * the view is deterministic even if a foreign frame is unordered.
 */
function modelsOf(raw: unknown): StatsModel[] {
  if (!Array.isArray(raw)) return [];
  const out: StatsModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Row;
    const model = textOf(record.model);
    const turns = countOf(record.turns);
    if (!model || turns == null) continue;
    const entry: StatsModel = { model, turns };
    const provider = textOf(record.provider);
    const input = countOf(record.input);
    const output = countOf(record.output);
    const cache = cacheOf(record);
    if (provider) entry.provider = provider;
    if (input != null) entry.input = input;
    if (output != null) entry.output = output;
    if (cache) entry.cache = cache;
    out.push(entry);
  }
  return out.sort((a, b) =>
    (b.input ?? 0) - (a.input ?? 0) ||
    b.turns - a.turns ||
    a.model.localeCompare(b.model) ||
    (a.provider ?? '').localeCompare(b.provider ?? ''),
  );
}

/**
 * Project one `stats` frame. A bare frame (`{"t":"stats"}`) is the plugin's
 * "nothing to report" reply and becomes an empty dashboard, not an error.
 */
export function statsOf(frame: Frame): UsageStats {
  return {
    totals: totalsOf(frame.totals),
    byModel: modelsOf(frame.by_model),
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

/** `20.69` -> `20.7%`; a missing rate is `—`, never `0%`. */
export function formatRate(rate: number | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${rate.toFixed(1)}%`;
}

/**
 * Shape the day series for the bar chart: ascending days, token totals and a
 * relative height. A day whose receipt carried no token side still renders
 * with a 0 ratio, so the turn count is never hidden. `hitRate` is carried
 * only when that day had at least one cache-reporting turn.
 */
export function statsBars(days: readonly StatsDay[]): StatsBar[] {
  const bars = days.map((day) => {
    const bar: StatsBar = {
      ...day,
      total: (day.input ?? 0) + (day.output ?? 0),
      ratio: 0,
      label: dayLabel(day.date),
    };
    if (day.cache) bar.hitRate = day.cache.rate;
    return bar;
  });
  const max = bars.reduce((top, bar) => Math.max(top, bar.total), 0);
  for (const bar of bars) bar.ratio = max > 0 ? bar.total / max : 0;
  return bars;
}
