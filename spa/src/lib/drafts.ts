/**
 * Per-chat composer drafts (M22).
 *
 * The composer text belongs to one chat, never to the app: switching chats
 * restores that chat's unsent text and a successful send clears it. Storage
 * is best-effort, exactly like the other localStorage helpers — a blocked or
 * throwing store behaves like an empty one.
 */

/** One JSON object keyed by chat id (the composer's own text). */
export const DRAFTS_KEY = 'webchannel.drafts';

export interface ReadonlyStorage {
  getItem(key: string): string | null;
}

export interface WritableStorage {
  setItem(key: string, value: string): void;
}

export type Drafts = Record<string, string>;

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Parse a stored drafts object; malformed chats/values are dropped. */
export function parseDrafts(raw: string | null): Drafts {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Drafts = {};
    for (const [chat, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (!chat || typeof text !== 'string' || !text.trim()) continue;
      out[chat] = text;
    }
    return out;
  } catch {
    return {};
  }
}

/** Drafts from the last visit, or {} when the store is empty/unusable. */
export function loadDrafts(storage: ReadonlyStorage | null = defaultStorage()): Drafts {
  if (!storage) return {};
  try {
    return parseDrafts(storage.getItem(DRAFTS_KEY));
  } catch {
    return {};
  }
}

/** Persist the whole map; a blocked quota must never reach the caller. */
export function saveDrafts(
  drafts: Drafts,
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* not persisted — the session still works */
  }
}

/** The composer text for one chat ('' when it has no draft). */
export function draftOf(drafts: Drafts, chat: string): string {
  return chat ? drafts[chat] ?? '' : '';
}

/**
 * Set or clear one chat's draft, returning a new map. The same map is
 * returned when nothing changes so React can skip the re-render. A blank
 * value removes the entry instead of storing an empty draft.
 */
export function setDraft(drafts: Drafts, chat: string, text: string): Drafts {
  if (!chat) return drafts;
  if (!text.trim()) {
    if (!(chat in drafts)) return drafts;
    const next = { ...drafts };
    delete next[chat];
    return next;
  }
  if (drafts[chat] === text) return drafts;
  return { ...drafts, [chat]: text };
}
