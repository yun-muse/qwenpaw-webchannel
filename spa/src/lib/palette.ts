/**
 * Ctrl/⌘+K command palette model (M23).
 *
 * One query filters two decks: the app's existing actions and the chat list.
 * Kept pure so the matching rules can be tested without a DOM; App.tsx owns
 * what each action actually does.
 */

export interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  /** Extra search terms that are not shown (English words, aliases). */
  keywords?: string;
}

/**
 * Every action is backed by a feature that already exists elsewhere in the
 * app; the palette is a second entry point, not a new capability.
 */
export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'new',
    label: '新建会话',
    hint: '开启一个全新的独立对话',
    keywords: 'new chat 新对话',
  },
  {
    id: 'export',
    label: '导出当前会话',
    hint: '导出为 Markdown（含思考过程与工具调用）',
    keywords: 'export markdown 导出 下载',
  },
  {
    id: 'search',
    label: '全文搜索',
    hint: '搜索已归档的历史正文',
    keywords: 'search 搜索 归档 archive',
  },
  {
    id: 'theme',
    label: '切换主题',
    hint: '浅色 ↔ 暗黑主题',
    keywords: 'theme dark light 深浅色 暗黑 浅色',
  },
  {
    id: 'model',
    label: '切换模型',
    hint: '在输入框上方选择对话模型',
    keywords: 'model 模型 provider',
  },
  {
    id: 'usage',
    label: '打开用量',
    hint: '查看上下文占用与会话累计 token',
    keywords: 'usage token 用量 上下文 context',
  },
  {
    id: 'help',
    label: '帮助',
    hint: '快捷键与技能指南',
    keywords: 'help 帮助 快捷键 shortcut',
  },
];

export interface PaletteChat {
  id: string;
  title: string;
}

export interface PaletteEntry {
  /** Stable React key: an action id or `chat:<id>`. */
  key: string;
  kind: 'action' | 'chat';
  /** Action id for `kind: 'action'`, chat id for `kind: 'chat'`. */
  id: string;
  label: string;
  hint: string;
}

function actionMatches(action: PaletteAction, query: string): boolean {
  if (!query) return true;
  const haystack = `${action.label}\n${action.hint}\n${action.keywords ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

function chatMatches(chat: PaletteChat, query: string): boolean {
  if (!query) return true;
  return (
    chat.title.toLowerCase().includes(query) || chat.id.toLowerCase().includes(query)
  );
}

/**
 * Build the visible rows: matching actions first, then matching chats, both
 * in their original order. A blank query shows everything.
 */
export function paletteEntries(
  query: string,
  chats: readonly PaletteChat[],
  actions: readonly PaletteAction[] = PALETTE_ACTIONS,
): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  const out: PaletteEntry[] = [];
  for (const action of actions) {
    if (!actionMatches(action, q)) continue;
    out.push({
      key: `action:${action.id}`,
      kind: 'action',
      id: action.id,
      label: action.label,
      hint: action.hint,
    });
  }
  for (const chat of chats) {
    if (!chatMatches(chat, q)) continue;
    out.push({
      key: `chat:${chat.id}`,
      kind: 'chat',
      id: chat.id,
      label: chat.title,
      hint: chat.id,
    });
  }
  return out;
}

/** Arrow-key movement with wrap-around; an empty list stays at zero. */
export function movePaletteCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (cursor + delta + length) % length;
}
