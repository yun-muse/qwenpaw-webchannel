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
/** Free-text tags per chat id (M23). */
export const TAGS_KEY = 'webchannel.chatTags';

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

/** Tags keyed by chat id; a chat with no tags has no entry. */
export type ChatTags = Record<string, string[]>;

/** Split free-form tag input on commas (both widths), semicolons or spaces. */
export function parseTagInput(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\s]+/)) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Normalise a stored tag list; non-arrays and blank entries are dropped. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Parse a persisted `webchannel.chatTags` document, dropping malformed rows. */
export function parseChatTags(raw: string | null): ChatTags {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ChatTags = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const tags = normalizeTags(value);
      if (id && tags.length > 0) out[id] = tags;
    }
    return out;
  } catch {
    return {};
  }
}

/** Tags from the previous visit. */
export function persistedChatTags(
  storage: ReadonlyStorage | null = defaultStorage(),
): ChatTags {
  return parseChatTags(readKey(storage, TAGS_KEY));
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * Replace one chat's tags. Removing the last tag deletes the entry, and the
 * same map is returned when nothing changed so `setState` can skip a render.
 */
export function setChatTags(tags: ChatTags, id: string, next: readonly string[]): ChatTags {
  const normalized = normalizeTags(next);
  const current = tags[id] ?? [];
  if (sameTags(current, normalized)) return tags;
  const out = { ...tags };
  if (normalized.length > 0) out[id] = normalized;
  else delete out[id];
  return out;
}

/**
 * Drop tags for chats the server no longer lists. Like `prunePins`, the caller
 * must only pass a non-empty server list: the plugin also answers `chats: []`
 * when its own API call fails, which is not evidence of mass deletion.
 */
export function pruneChatTags(tags: ChatTags, serverIds: readonly string[]): ChatTags {
  const ids = Object.keys(tags);
  const kept = ids.filter((id) => serverIds.includes(id));
  if (kept.length === ids.length) return tags;
  const out: ChatTags = {};
  for (const id of kept) out[id] = tags[id];
  return out;
}

/** Every distinct tag, in chat order then tag order (the 全部 + chips row). */
export function allChatTags(tags: ChatTags, chatIds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of chatIds) {
    for (const tag of tags[id] ?? []) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** A null tag means 全部; otherwise the chat must carry that exact tag (M23). */
export function chatMatchesTag(tags: ChatTags, id: string, tag: string | null): boolean {
  if (tag == null) return true;
  return (tags[id] ?? []).includes(tag);
}
