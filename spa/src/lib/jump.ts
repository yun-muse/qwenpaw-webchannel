/**
 * Best-effort anchor for "jump to this archive search hit" (M23).
 *
 * What the `hist` payload actually carries (probed):
 *   `{role, text, turn?}` — no message id, no timestamp, no index.
 * The search hit carries `{chat, title, role, snippet, match_start,
 * match_len, ts}` — no message id either, and `ts` (the archive row's
 * `created_at`) has no counterpart in `hist`. `turn.id` is the persisted
 * `Msg.id` (original_id), but the archive search projection never returns it
 * and only assistant segments with a usage receipt carry it; it cannot be
 * used as a join key.
 *
 * The only shared identity is the message text: the plugin's snippet is a
 * contiguous slice of the archived content (40 code points around the hit,
 * no ellipses), so a full-snippet match is exact. When the snippet cannot be
 * found, progressively weaker text matches land at the nearest message and
 * are reported as inexact, never as an exact anchor.
 */

import { snippetParts } from './search';
import type { SearchHit } from './search';

export interface JumpMessage {
  role: string;
  text: string;
}

export type JumpMethod = 'snippet' | 'context' | 'normalized' | 'prefix';

export interface MessageAnchor {
  index: number;
  /** True only when one message contains the whole snippet unambiguously. */
  exact: boolean;
  method: JumpMethod;
}

export type JumpHit = Pick<SearchHit, 'role' | 'snippet' | 'matchStart' | 'matchLen'>;

function roleAllowed(hit: JumpHit, message: JumpMessage): boolean {
  if (hit.role !== 'user' && hit.role !== 'assistant') return true;
  return message.role === hit.role;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The widest context that also matches on both sides of one occurrence. */
function contextScore(
  text: string,
  at: number,
  matchLength: number,
  before: string,
  after: string,
): number {
  let beforeScore = 0;
  const beforeMax = Math.min(before.length, at);
  for (let size = beforeMax; size > 0; size -= 1) {
    if (text.slice(at - size, at) === before.slice(before.length - size)) {
      beforeScore = size;
      break;
    }
  }
  let afterScore = 0;
  const from = at + matchLength;
  const afterMax = Math.min(after.length, Math.max(0, text.length - from));
  for (let size = afterMax; size > 0; size -= 1) {
    if (text.slice(from, from + size) === after.slice(0, size)) {
      afterScore = size;
      break;
    }
  }
  return beforeScore + afterScore;
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let at = text.indexOf(needle);
  while (at >= 0) {
    out.push(at);
    at = text.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * Pick the message a hit most likely refers to, or `null` when no text
 * evidence exists. Ties are broken toward the newest message (the greatest
 * index), which is the best available guess but explicitly not exact.
 */
export function findMessageAnchor(
  messages: readonly JumpMessage[],
  hit: JumpHit,
): MessageAnchor | null {
  const { before, match, after } = snippetParts({
    chat: '',
    title: '',
    role: hit.role,
    snippet: hit.snippet,
    matchStart: hit.matchStart,
    matchLen: hit.matchLen,
    ts: null,
  });
  if (!hit.snippet.trim() && !match.trim()) return null;

  const eligible: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (roleAllowed(hit, messages[index])) eligible.push(index);
  }

  // 1. The whole snippet appears: the strongest possible match.
  if (hit.snippet.trim()) {
    const hits = eligible.filter((index) => messages[index].text.includes(hit.snippet));
    if (hits.length > 0) {
      return {
        index: hits[hits.length - 1],
        exact: hits.length === 1,
        method: 'snippet',
      };
    }
  }

  // 2. Only the matched text appears; score the surviving context.
  if (match.trim()) {
    let best: { index: number; score: number } | null = null;
    for (const index of eligible) {
      const text = messages[index].text;
      for (const at of occurrences(text, match)) {
        const score = contextScore(text, at, match.length, before, after);
        if (!best || score >= best.score) best = { index, score };
      }
    }
    if (best) return { index: best.index, exact: false, method: 'context' };
  }

  // 3. Whitespace/case difference between archive content and hist text.
  const needle = normalize(hit.snippet);
  if (needle) {
    const hits = eligible.filter((index) => normalize(messages[index].text).includes(needle));
    if (hits.length > 0) {
      return {
        index: hits[hits.length - 1],
        exact: false,
        method: 'normalized',
      };
    }
  }

  // 4. Last resort: a long prefix, enough to land near the message.
  const prefix = hit.snippet.trim().slice(0, 32);
  if (prefix.length >= 8) {
    const hits = eligible.filter((index) => messages[index].text.includes(prefix));
    if (hits.length > 0) {
      return { index: hits[hits.length - 1], exact: false, method: 'prefix' };
    }
  }

  return null;
}
