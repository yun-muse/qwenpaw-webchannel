import { describe, expect, it } from 'vitest';
import { findMessageAnchor } from '../src/lib/jump';
import type { JumpHit, JumpMessage } from '../src/lib/jump';

/** Build a hit whose snippet is exactly `snippet` (whole message slice). */
function hitOf(snippet: string, role = 'assistant', match?: string): JumpHit {
  const index = match ? snippet.indexOf(match) : 0;
  return {
    role,
    snippet,
    matchStart: index,
    matchLen: match ? match.length : snippet.length,
  };
}

const MESSAGES: JumpMessage[] = [
  { role: 'user', text: '开场问题' },
  { role: 'assistant', text: '第一段回答，讲的是别的事情。' },
  { role: 'user', text: '第二问：唯一锚点句在哪里？' },
  { role: 'assistant', text: '这里包含唯一锚点句，并且后面还有说明。' },
];

describe('findMessageAnchor', () => {
  it('anchors a whole-snippet match to the exact message', () => {
    const anchor = findMessageAnchor(MESSAGES, hitOf('唯一锚点句', 'user'));
    expect(anchor).toEqual({ index: 2, exact: true, method: 'snippet' });
  });

  it('finds the snippet with surrounding archive context', () => {
    const snippet = '这里包含唯一锚点句，并且后面';
    const anchor = findMessageAnchor(MESSAGES, hitOf(snippet, 'assistant', '唯一锚点句'));
    expect(anchor).toEqual({ index: 3, exact: true, method: 'snippet' });
  });

  it('ignores messages whose role does not match the hit', () => {
    // The same text exists on a user message, but the hit is an assistant row.
    const messages: JumpMessage[] = [
      { role: 'user', text: '目标文字' },
      { role: 'assistant', text: '目标文字' },
    ];
    expect(findMessageAnchor(messages, hitOf('目标文字', 'assistant'))).toEqual({
      index: 1,
      exact: true,
      method: 'snippet',
    });
  });

  it('marks repeated snippets ambiguous and takes the newest match', () => {
    const messages: JumpMessage[] = [
      { role: 'assistant', text: '重复的话' },
      { role: 'assistant', text: '重复的话' },
    ];
    expect(findMessageAnchor(messages, hitOf('重复的话', 'assistant'))).toEqual({
      index: 1,
      exact: false,
      method: 'snippet',
    });
  });

  it('falls back to the matched text plus partial context', () => {
    const messages: JumpMessage[] = [
      { role: 'assistant', text: '前面很长。目标短语出现在这里' },
      { role: 'assistant', text: '不相干' },
    ];
    const hit: JumpHit = {
      role: 'assistant',
      snippet: 'ARCHIVE-CONTEXT 目标短语 后缀不一样',
      matchStart: 'ARCHIVE-CONTEXT '.length,
      matchLen: '目标短语'.length,
    };
    expect(findMessageAnchor(messages, hit)).toEqual({
      index: 0,
      exact: false,
      method: 'context',
    });
  });

  it('normalises whitespace and ASCII case before giving up', () => {
    const messages: JumpMessage[] = [
      { role: 'assistant', text: 'hello\n\nWORLD   again' },
    ];
    expect(findMessageAnchor(messages, hitOf('hello world again'))).toEqual({
      index: 0,
      exact: false,
      method: 'normalized',
    });
  });

  it('uses a long prefix as the final nearest-position fallback', () => {
    const messages: JumpMessage[] = [
      { role: 'assistant', text: 'prefix-abcdefghijklmnopqrstuvwxyz-tail' },
    ];
    expect(findMessageAnchor(messages, hitOf('prefix-abcdefghijklmnopqrstuvwxyz-OTHER'))).toEqual({
      index: 0,
      exact: false,
      method: 'prefix',
    });
  });

  it('returns null when there is no usable text evidence', () => {
    expect(findMessageAnchor([], hitOf('目标'))).toBeNull();
    expect(findMessageAnchor(MESSAGES, hitOf('完全不存在的句子'))).toBeNull();
    expect(findMessageAnchor(MESSAGES, hitOf(''))).toBeNull();
  });

  it('uses the snippet when match offsets are invalid', () => {
    const hit: JumpHit = {
      role: 'assistant',
      snippet: '这里包含唯一锚点句',
      matchStart: -1,
      matchLen: 0,
    };
    expect(findMessageAnchor(MESSAGES, hit)).toEqual({
      index: 3,
      exact: true,
      method: 'snippet',
    });
  });
});
