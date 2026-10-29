import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/relay';
import { dayLabel, statsBars, statsOf } from '../src/lib/stats';

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
});

describe('dayLabel', () => {
  it('formats ISO dates and passes other strings through', () => {
    expect(dayLabel('2026-10-26')).toBe('10/26');
    expect(dayLabel('2026-01-02')).toBe('01/02');
    expect(dayLabel('weird')).toBe('weird');
  });
});
