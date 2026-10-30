import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/relay';
import { dayLabel, formatRate, statsBars, statsOf } from '../src/lib/stats';

function frame(extra: Record<string, unknown> = {}): Frame {
  return { t: 'stats', ...extra };
}

describe('statsOf', () => {
  it('parses the full stats frame', () => {
    const stats = statsOf(frame({
      totals: { turns: 95, input: 1_648_974, output: 12_314 },
      covered_chats: 37,
      uncovered_chats: 2,
      undated_turns: 1,
      day_basis: 'container-local',
      day_tz: 'UTC',
      days: [
        { date: '2026-10-27', turns: 75, input: 1_242_778, output: 7_758 },
        { date: '2026-10-26', turns: 20, input: 406_196, output: 4_556 },
      ],
      chats: [
        { chat: 'chat-a', title: 'A', turns: 10, input: 900, output: 90 },
        { chat: 'chat-b', turns: 1, input: 5, output: 1 },
      ],
    }));

    expect(stats.totals).toEqual({ turns: 95, input: 1_648_974, output: 12_314 });
    expect(stats.coveredChats).toBe(37);
    expect(stats.uncoveredChats).toBe(2);
    expect(stats.undatedTurns).toBe(1);
    expect(stats.dayTz).toBe('UTC');
    expect(stats.dayBasis).toBe('container-local');
    // The helper sorts the series even when the plugin sent it newest-first.
    expect(stats.days.map((day) => day.date)).toEqual(['2026-10-26', '2026-10-27']);
    expect(stats.chats[0]).toEqual({
      chat: 'chat-a', title: 'A', turns: 10, input: 900, output: 90,
    });
    // A missing title stays absent, never an empty string.
    expect('title' in stats.chats[1]).toBe(false);
  });

  it('treats a bare frame as an empty dashboard', () => {
    expect(statsOf(frame())).toEqual({
      totals: { turns: 0 },
      byModel: [],
      days: [],
      chats: [],
      coveredChats: 0,
      uncoveredChats: undefined,
      undatedTurns: undefined,
      dayTz: undefined,
      dayBasis: 'container-local',
    });
  });

  it('does not substitute 0 for unknown numbers', () => {
    const stats = statsOf(frame({
      totals: { turns: 3, input: null, output: '12' },
      covered_chats: -1,
      uncovered_chats: '4',
      days: [{ date: '2026-10-26', turns: 3, input: null, output: true }],
      chats: [{ chat: 'c', turns: 3, input: -5 }],
    }));
    expect(stats.totals).toEqual({ turns: 3 });
    expect(stats.coveredChats).toBe(0);
    expect(stats.uncoveredChats).toBeUndefined();
    expect(stats.days[0]).toEqual({ date: '2026-10-26', turns: 3 });
    expect(stats.chats[0]).toEqual({ chat: 'c', turns: 3 });
  });

  it('drops invalid dates and entries without turns', () => {
    const stats = statsOf(frame({
      days: [
        { date: '2026-02-30', turns: 9 },
        { date: '2026-10-26' },
        { date: 'nope', turns: 9 },
        { turns: 9 },
        null,
        { date: '2026-10-25', turns: 2 },
      ],
    }));
    expect(stats.days).toEqual([{ date: '2026-10-25', turns: 2 }]);
  });

  it('merges duplicate days instead of double-counting a missing field', () => {
    const stats = statsOf(frame({
      days: [
        { date: '2026-10-26', turns: 1, input: 10 },
        { date: '2026-10-26', turns: 2, output: 4 },
      ],
    }));
    expect(stats.days).toEqual([
      { date: '2026-10-26', turns: 3, input: 10, output: 4 },
    ]);
  });

  it('filters malformed chat rows', () => {
    const stats = statsOf(frame({
      chats: [
        { chat: '', turns: 1 },
        { chat: '  ', turns: 1 },
        { chat: 'ok', turns: 2, title: '  ' },
        { chat: 'no-turns', input: 5 },
        'junk',
      ],
    }));
    expect(stats.chats).toEqual([{ chat: 'ok', turns: 2 }]);
  });

  it('ignores non-array payloads and keeps the default basis', () => {
    const stats = statsOf(frame({ days: 'nope', chats: {}, totals: 4 }));
    expect(stats.days).toEqual([]);
    expect(stats.chats).toEqual([]);
    expect(stats.totals).toEqual({ turns: 0 });
    expect(stats.dayBasis).toBe('container-local');
  });
});

describe('M28 cache + models', () => {
  it('parses the cache group and recomputes the rate from the integer sums', () => {
    const stats = statsOf(frame({
      totals: {
        turns: 2, input: 1100, output: 2,
        cache_hit: 901, cache_miss: 199, cache_eligible: 1100,
        // A per-turn average would be 45.5; the sums are what count.
        cache_hit_rate: 45.5,
      },
      days: [{
        date: '2026-10-26', turns: 2, input: 1100, output: 2,
        cache_hit: 901, cache_miss: 199, cache_eligible: 1100,
      }],
      by_model: [{
        provider: 'kilo', model: 'openrouter/free', turns: 2,
        input: 1100, output: 2, cache_hit: 901, cache_miss: 199,
        cache_eligible: 1100, cache_hit_rate: 45.5,
      }],
    }));
    expect(stats.totals.cache).toEqual({
      hit: 901, miss: 199, eligible: 1100, rate: 81.91,
    });
    expect(stats.days[0].cache?.rate).toBe(81.91);
    expect(stats.byModel[0].cache).toEqual({
      hit: 901, miss: 199, eligible: 1100, rate: 81.91,
    });
  });

  it('drops an incomplete or contradictory cache triple instead of faking 0', () => {
    const incomplete = statsOf(frame({
      totals: { turns: 1, input: 100, cache_hit: 10 },
      days: [{ date: '2026-10-26', turns: 1, cache_hit: 10, cache_miss: 90 }],
      by_model: [{ model: 'm', turns: 1, cache_hit: 10, cache_miss: 5, cache_eligible: 20 }],
    }));
    expect('cache' in incomplete.totals).toBe(false);
    expect('cache' in incomplete.days[0]).toBe(false);
    expect('cache' in incomplete.byModel[0]).toBe(false);
  });

  it('keeps a reported 0 hit as a real 0% rate', () => {
    const stats = statsOf(frame({
      totals: {
        turns: 1, input: 100, output: 1,
        cache_hit: 0, cache_miss: 100, cache_eligible: 100,
      },
    }));
    expect(stats.totals.cache).toEqual({
      hit: 0, miss: 100, eligible: 100, rate: 0,
    });
    expect(formatRate(stats.totals.cache?.rate)).toBe('0.0%');
  });

  it('parses model rows, keeps the unknown bucket and sorts by input', () => {
    const stats = statsOf(frame({
      by_model: [
        { model: '未知模型', turns: 3, input: 60_000, output: 400 },
        { provider: 'kilo', model: 'small', turns: 1, input: 10 },
        {
          provider: 'kilo', model: 'openrouter/free', turns: 52,
          input: 892_049, output: 6_330, cache_hit: 26_038,
          cache_miss: 866_011, cache_eligible: 892_049, cache_hit_rate: 2.92,
        },
        { model: '  ', turns: 9, input: 999 },
        { model: 'no-turns', input: 999 },
        'junk',
      ],
    }));
    expect(stats.byModel.map((row) => row.model)).toEqual([
      'openrouter/free', '未知模型', 'small',
    ]);
    expect(stats.byModel[0].provider).toBe('kilo');
    expect(stats.byModel[0].cache?.rate).toBe(2.92);
    // The unknown bucket has no cache data: absent, never 0%.
    expect('cache' in stats.byModel[1]).toBe(false);
    expect('provider' in stats.byModel[1]).toBe(false);
    expect('input' in stats.byModel[2]).toBe(true);
  });

  it('merges duplicate day rows and combines their cache sums', () => {
    const stats = statsOf(frame({
      days: [
        { date: '2026-10-26', turns: 1, input: 100, cache_hit: 10, cache_miss: 90, cache_eligible: 100 },
        { date: '2026-10-26', turns: 1, input: 300, cache_hit: 90, cache_miss: 210, cache_eligible: 300 },
      ],
    }));
    expect(stats.days).toEqual([{
      date: '2026-10-26', turns: 2, input: 400,
      cache: { hit: 100, miss: 300, eligible: 400, rate: 25 },
    }]);
  });
});

describe('formatRate', () => {
  it('renders one decimal and a dash for unknown rates', () => {
    expect(formatRate(20.69)).toBe('20.7%');
    expect(formatRate(0)).toBe('0.0%');
    expect(formatRate(100)).toBe('100.0%');
    expect(formatRate(undefined)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
  });
});

describe('statsBars', () => {
  it('computes token totals, ratios and short labels', () => {
    const bars = statsBars([
      { date: '2026-10-26', turns: 20, input: 300, output: 100 },
      { date: '2026-10-27', turns: 5, input: 50, output: 50 },
      { date: '2026-10-28', turns: 1 },
    ]);
    expect(bars.map((bar) => bar.total)).toEqual([400, 100, 0]);
    expect(bars.map((bar) => bar.ratio)).toEqual([1, 0.25, 0]);
    expect(bars.map((bar) => bar.label)).toEqual(['10/26', '10/27', '10/28']);
    // The original fields survive the projection.
    expect(bars[0]).toMatchObject({ date: '2026-10-26', turns: 20, input: 300, output: 100 });
  });

  it('keeps every bar at ratio 0 when the series has no tokens', () => {
    const bars = statsBars([
      { date: '2026-10-26', turns: 2 },
      { date: '2026-10-27', turns: 1 },
    ]);
    expect(bars.map((bar) => bar.ratio)).toEqual([0, 0]);
    expect(bars.map((bar) => bar.total)).toEqual([0, 0]);
  });

  it('handles an empty series', () => {
    expect(statsBars([])).toEqual([]);
  });

  it('carries a hit rate only for days that reported cache', () => {
    const bars = statsBars([
      {
        date: '2026-10-26', turns: 1, input: 100,
        cache: { hit: 40, miss: 60, eligible: 100, rate: 40 },
      },
      { date: '2026-10-27', turns: 1, input: 200 },
    ]);
    expect(bars[0].hitRate).toBe(40);
    expect(bars[1].hitRate).toBeUndefined();
    expect(bars.map((bar) => bar.ratio)).toEqual([0.5, 1]);
  });
});

describe('dayLabel', () => {
  it('formats ISO dates and passes other strings through', () => {
    expect(dayLabel('2026-10-26')).toBe('10/26');
    expect(dayLabel('2026-01-02')).toBe('01/02');
    expect(dayLabel('weird')).toBe('weird');
  });
});
