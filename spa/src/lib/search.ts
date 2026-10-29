/**
 * Full-text search payload parsing and snippet slicing (M13/M21).
 *
 * Match offsets are UTF-16 code units, exactly like the strings the browser
 * slices and the offsets the plugin computes.
 */

/** One archived message that matched a search (M13). */
export interface SearchHit {
  chat: string;
  title: string;
  role: string;
  snippet: string;
  /** Match offset/length inside `snippet`, in UTF-16 code units (JS slices). */
  matchStart: number;
  matchLen: number;
  ts: number | null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Parse one `search_results` payload; malformed rows are dropped (M13). */
export function searchHitsOf(raw: unknown): SearchHit[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchHit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      chat?: unknown;
      title?: unknown;
      role?: unknown;
      snippet?: unknown;
      match_start?: unknown;
      match_len?: unknown;
      ts?: unknown;
    };
    const chat = asString(record.chat);
    if (!chat) continue;
    const matchStart =
      typeof record.match_start === 'number' && Number.isInteger(record.match_start)
        ? record.match_start
        : -1;
    const matchLen =
      typeof record.match_len === 'number' && Number.isInteger(record.match_len)
        ? record.match_len
        : 0;
    out.push({
      chat,
      title: asString(record.title),
      role: asString(record.role),
      snippet: asString(record.snippet),
      matchStart,
      matchLen,
      ts: typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : null,
    });
  }
  return out;
}

/** Split a hit snippet on its match; slices are UTF-16 units, like the plugin. */
export function snippetParts(hit: SearchHit): { before: string; match: string; after: string } {
  const { snippet, matchStart, matchLen } = hit;
  if (matchStart < 0 || matchLen <= 0 || matchStart + matchLen > snippet.length) {
    return { before: snippet, match: '', after: '' };
  }
  return {
    before: snippet.slice(0, matchStart),
    match: snippet.slice(matchStart, matchStart + matchLen),
    after: snippet.slice(matchStart + matchLen),
  };
}
