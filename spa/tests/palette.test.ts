import { describe, expect, it } from 'vitest';
import {
  PALETTE_ACTIONS,
  movePaletteCursor,
  paletteEntries,
} from '../src/lib/palette';

const CHATS = [
  { id: 'chat-alpha', title: 'Alpha 会话' },
  { id: 'chat-beta', title: 'Beta 会话' },
  { id: 'chat-gamma', title: '读书笔记' },
];

describe('PALETTE_ACTIONS', () => {
  it('lists the required existing actions exactly once', () => {
    const ids = PALETTE_ACTIONS.map((action) => action.id);
    expect(ids).toEqual(['new', 'export', 'search', 'theme', 'model', 'usage', 'help']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of [
      '新建会话',
      '导出当前会话',
      '全文搜索',
      '切换主题',
      '切换模型',
      '打开用量',
      '帮助',
    ]) {
      expect(PALETTE_ACTIONS.some((action) => action.label === label)).toBe(true);
    }
  });
});

describe('paletteEntries', () => {
  it('shows every action then every chat for an empty query', () => {
    const rows = paletteEntries('   ', CHATS);
    expect(rows).toHaveLength(PALETTE_ACTIONS.length + CHATS.length);
    expect(rows.slice(0, PALETTE_ACTIONS.length).every((row) => row.kind === 'action')).toBe(true);
    expect(rows.slice(PALETTE_ACTIONS.length).map((row) => row.id)).toEqual([
      'chat-alpha',
      'chat-beta',
      'chat-gamma',
    ]);
  });

  it('filters both decks with one case-insensitive query', () => {
    const rows = paletteEntries('会话', CHATS);
    expect(rows.filter((row) => row.kind === 'action').map((row) => row.label)).toEqual([
      '新建会话',
      '导出当前会话',
      '打开用量',
    ]);
    expect(rows.filter((row) => row.kind === 'chat').map((row) => row.id)).toEqual([
      'chat-alpha',
      'chat-beta',
    ]);
    expect(paletteEntries('BETA', CHATS).map((row) => row.id)).toContain('chat-beta');
    expect(paletteEntries('笔记', CHATS).map((row) => row.id)).toContain('chat-gamma');
  });

  it('matches hints, keywords and chat ids, not just labels', () => {
    expect(paletteEntries('markdown', CHATS).map((row) => row.id)).toEqual(['export']);
    expect(paletteEntries('token', CHATS).map((row) => row.id)).toEqual(['usage']);
    expect(paletteEntries('chat-gamma', CHATS).map((row) => row.id)).toEqual(['chat-gamma']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(paletteEntries('zzz-no-such-thing', CHATS)).toEqual([]);
  });

  it('keeps actions before chats even when both match the query', () => {
    const rows = paletteEntries('主题', [
      { id: 'chat-topic', title: '主题讨论' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['action', 'chat']);
  });
});

describe('movePaletteCursor', () => {
  it('moves and wraps in both directions', () => {
    expect(movePaletteCursor(0, 1, 3)).toBe(1);
    expect(movePaletteCursor(2, 1, 3)).toBe(0);
    expect(movePaletteCursor(0, -1, 3)).toBe(2);
    expect(movePaletteCursor(1, -1, 3)).toBe(0);
  });

  it('stays at zero when there is nothing to select', () => {
    expect(movePaletteCursor(4, 1, 0)).toBe(0);
    expect(movePaletteCursor(0, -1, 0)).toBe(0);
  });
});
