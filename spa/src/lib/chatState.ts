/**
 * Chat list / pin persistence helpers (M19/M21).
 *
 * `localStorage` is best-effort everywhere: private mode or blocked storage
 * must behave like an empty store instead of taking the app down. The storage
 * argument exists so the helpers can be tested without a DOM.
 */

/** Chat list + visible chat from the previous visit (survives a reload). */
export const CHATS_KEY = 'webchannel.chats';
export const ACTIVE_KEY = 'webchannel.activeChat';
/** Pinned chat ids, most recently pinned first (M19). */
export const PINS_KEY = 'webchannel.pinnedChats';

export interface ReadonlyStorage {
  getItem(key: string): string | null;
}

function defaultStorage(): ReadonlyStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readKey(storage: ReadonlyStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function newChatId(): string {
  return `chat-${Date.now().toString(36)}`;
}

export function persistedChats(
  key: string = CHATS_KEY,
  storage: ReadonlyStorage | null = defaultStorage(),
): string[] {
  const raw = readKey(storage, key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * The chat list and the visible chat from the last visit. `restored` says the
 * pair came from localStorage (as opposed to a brand-new chat), which is what
 * tells the `chats` reply whether a missing active chat means "deleted on
 * another device" (M19).
 */
export function restoreSession(
  storage: ReadonlyStorage | null = defaultStorage(),
  makeId: () => string = newChatId,
): { chats: string[]; active: string; restored: boolean } {
  const chats = persistedChats(CHATS_KEY, storage);
  if (chats.length > 0) {
    const saved = readKey(storage, ACTIVE_KEY);
    const active = saved && chats.includes(saved) ? saved : chats[0];
    return { chats, active, restored: true };
  }
  const id = makeId();
  return { chats: [id], active: id, restored: false };
}

/**
 * Newest chat id carried by a `chats` frame: the largest parseable
 * `updated_at`, else the first id in server order (M19).
 */
export function newestServerChat(items: unknown[]): string | null {
  let first: string | null = null;
  let newest: string | null = null;
  let newestAt = -Infinity;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { chat?: unknown; updated_at?: unknown };
    const id = asString(record.chat);
    if (!id) continue;
    if (first == null) first = id;
    const at =
      typeof record.updated_at === 'number'
        ? record.updated_at
        : Date.parse(asString(record.updated_at));
    if (Number.isFinite(at) && at > newestAt) {
      newestAt = at;
      newest = id;
    }
  }
  return newest ?? first;
}

/** Pin or unpin one chat; the newest pin sits first in the 置顶 group. */
export function togglePin(pins: readonly string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((pin) => pin !== id) : [id, ...pins];
}

/**
 * Drop pins the server no longer lists, preserving pin order. The same array
 * is returned when nothing changed so `setState` can skip a re-render. The
 * caller must only invoke this for a non-empty server list: the plugin also
 * answers `chats: []` when its own API call fails, and that is not evidence
 * that every chat was deleted.
 */
export function prunePins(pins: string[], serverIds: readonly string[]): string[] {
  const kept = pins.filter((id) => serverIds.includes(id));
  return kept.length === pins.length ? pins : kept;
}
