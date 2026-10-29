import { describe, expect, it } from 'vitest';
import {
  formatExact,
  formatTokens,
  turnTitle,
  turnUsageOf,
  usageOf,
} from '../src/lib/usage';

describe('formatTokens', () => {
  it('keeps small counts exact and rounded', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(999.6)).toBe('1000');
  });

  it('uses one decimal for thousands and strips a trailing .0', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1250)).toBe('1.3k');
    expect(formatTokens(9999)).toBe('10k');
    expect(formatTokens(999_999)).toBe('1000k');
  });

  it('switches to millions at 1e6', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });
});

describe('formatExact', () => {
  it('rounds and groups with separators', () => {
    expect(formatExact(0)).toBe('0');
    expect(formatExact(1234)).toBe('1,234');
    expect(formatExact(1234567)).toBe('1,234,567');
    expect(formatExact(12.4)).toBe('12');
    expect(formatExact(12.6)).toBe('13');
  });
});

describe('turnUsageOf', () => {
  it('accepts a receipt with at least one token side', () => {
    expect(turnUsageOf({ id: 't1', input: 10, output: 4, total: 14 })).toEqual({
      id: 't1',
      input: 10,
      output: 4,
      total: 14,
    });
    expect(turnUsageOf({ id: 't1', input: 10 })).toEqual({ id: 't1', input: 10 });
    expect(turnUsageOf({ id: 't1', output: 0 })).toEqual({ id: 't1', output: 0 });
  });

  it('rounds fractional values', () => {
    expect(turnUsageOf({ id: 't', input: 10.4, output: 4.6 })).toEqual({
      id: 't',
      input: 10,
      output: 5,
    });
  });

  it('drops the whole receipt when the id is missing', () => {
    expect(turnUsageOf(null)).toBeUndefined();
    expect(turnUsageOf('t1')).toBeUndefined();
    expect(turnUsageOf({ input: 1, output: 1 })).toBeUndefined();
    expect(turnUsageOf({ id: '', input: 1 })).toBeUndefined();
    expect(turnUsageOf({ id: 7, input: 1 })).toBeUndefined();
  });

  it('drops a receipt with a present-but-invalid numeric field', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10', true]) {
      expect(turnUsageOf({ id: 't', input: 1, output: bad })).toBeUndefined();
    }
    expect(turnUsageOf({ id: 't', input: null, output: undefined })).toBeUndefined();
  });

  it('needs an input or an output, not just a total', () => {
    expect(turnUsageOf({ id: 't', total: 9 })).toBeUndefined();
  });

  it('keeps estimated only when it is exactly true', () => {
    expect(turnUsageOf({ id: 't', input: 1, estimated: true })).toEqual({
      id: 't',
      input: 1,
      estimated: true,
    });
    expect(turnUsageOf({ id: 't', input: 1, estimated: 'yes' })).toEqual({
      id: 't',
      input: 1,
    });
  });
});

describe('turnTitle', () => {
  it('lists every present number and marks estimates', () => {
    expect(turnTitle({ id: 't', input: 10, output: 4, total: 14 })).toBe(
      '本轮用量：输入 10 · 输出 4 · 合计 14',
    );
    expect(turnTitle({ id: 't', input: 10, estimated: true })).toBe(
      '本轮用量（估算）：输入 10 · 该轮 token 数为估算值',
    );
  });
});

describe('usageOf', () => {
  it('copies usable numbers and omits the rest', () => {
    expect(
      usageOf({
        t: 'usage',
        input_total: 120,
        output_total: 30,
        context_tokens: 45.6,
        context_limit: 8000,
      }),
    ).toEqual({
      inputTotal: 120,
      outputTotal: 30,
      contextTokens: 46,
      contextLimit: 8000,
    });
  });

  it('never fabricates a zero for missing, negative or non-numeric fields', () => {
    expect(usageOf({ t: 'usage' })).toEqual({});
    expect(
      usageOf({
        t: 'usage',
        input_total: -1,
        output_total: '30',
        context_tokens: Number.NaN,
        context_limit: 0,
      }),
    ).toEqual({});
    expect(usageOf({ t: 'usage', context_limit: 0 })).toEqual({});
  });
});
