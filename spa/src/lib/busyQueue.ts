/**
 * M43 — per-chat backlog for messages sent while a turn is running.
 *
 * Two ways to send into a busy chat, mirroring the two modes the composer
 * offers:
 *
 *   排队 (queue) — the message waits here until the chat is idle again, then
 *                  it is handed to the socket one entry at a time (send one,
 *                  wait for its turn to end, send the next). This is the only
 *                  way to keep the replies in order and un-merged.
 *   立即发送 (now) — not stored here at all: the normal send path writes the
 *                  frame immediately. QwenPaw's per-session queue runs it
 *                  after the current turn (probe §1.2), so it must never be
 *                  described as interrupting.
 *
 * This is *not* the M37 outbox. The outbox owns "the user pressed send but
 * no socket/agent could take it"; it is restored on reload and retried on
 * reconnect. The busy queue owns "the socket is fine, the chat is busy". The
 * two meet at exactly one place: when a flush cannot write to the socket, the
 * entry is *moved* into the outbox (removed here first), never copied, so the
 * same sentence can never be sent twice.
 *
 * Entries carry text only. A chunked attachment is staged on the plugin with a
 * 10-minute TTL, so a queued message could outlive its own files; the composer
 * refuses attachments in 排队 mode with an explicit notice instead of queueing
 * a message that would silently lose them.
 */

export const BUSY_QUEUE_KEY = 'webchannel.busyQueue';
/** The last mode the user picked; preselected the next time the chat is busy. */
export const BUSY_MODE_KEY = 'webchannel.busyMode';
/** Same ceilings as the outbox: a full queue refuses, it never drops. */
export const MAX_BUSY_PER_CHAT = 20;
export const MAX_BUSY_TOTAL = 100;

export type BusyMode = 'queue' | 'now';

export interface BusyQueueEntry {
  /** Local id (unique within this browser), never sent to the plugin. */
  id: string;
  chat: string;
  /** Exactly what goes on the wire (a skill's instruction already prepended). */
  text: string;
  /** What the queue strip and the eventual bubble show. */
  display: string;
  /** The raw composer text, restored by 撤销. */
  raw: string;
  ts: number;
}

export interface ReadonlyStorage {
  getItem(key: string): string | null;
}

export interface WritableStorage {
  setItem(key: string, value: string): void;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function newBusyId(now = Date.now(), random = Math.random): string {
  return `b${now.toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
}

function cleanEntry(raw: unknown): BusyQueueEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const chat = typeof record.chat === 'string' ? record.chat : '';
  const text = typeof record.text === 'string' ? record.text : '';
  if (!chat || !text.trim()) return null;
  const id = typeof record.id === 'string' && record.id ? record.id : newBusyId();
  const display = typeof record.display === 'string' && record.display ? record.display : text;
  const rawText = typeof record.raw === 'string' ? record.raw : display;
  const ts = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : Date.now();
  return { id, chat, text, display, raw: rawText, ts };
}

/** Parse a stored array; malformed entries are dropped, order is kept. */
export function parseBusyQueue(raw: string | null): BusyQueueEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: BusyQueueEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const entry = cleanEntry(item);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

export function loadBusyQueue(storage: ReadonlyStorage | null = defaultStorage()): BusyQueueEntry[] {
  if (!storage) return [];
  try {
    return parseBusyQueue(storage.getItem(BUSY_QUEUE_KEY));
  } catch {
    return [];
  }
}

/** Persist the whole queue; a blocked quota must never reach the caller. */
export function saveBusyQueue(
  entries: BusyQueueEntry[],
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(BUSY_QUEUE_KEY, JSON.stringify(entries));
  } catch {
    /* not persisted — the session still works, it just won't be restored */
  }
}

export type BusyRefusal = 'full-chat' | 'full-total';

export interface BusyEnqueueResult {
  entries: BusyQueueEntry[];
  entry: BusyQueueEntry | null;
  refused?: BusyRefusal;
}

/**
 * Append one entry (per-chat FIFO: array order *is* the send order). A full
 * queue refuses the entry instead of dropping the oldest — losing a message
 * the user believes was accepted is what this feature exists to prevent.
 */
export function enqueueBusy(
  entries: BusyQueueEntry[],
  draft: { chat: string; text: string; display?: string; raw?: string; id?: string; ts?: number },
): BusyEnqueueResult {
  const { chat, text } = draft;
  if (!chat || !text.trim()) return { entries, entry: null };
  if (entries.filter((item) => item.chat === chat).length >= MAX_BUSY_PER_CHAT) {
    return { entries, entry: null, refused: 'full-chat' };
  }
  if (entries.length >= MAX_BUSY_TOTAL) {
    return { entries, entry: null, refused: 'full-total' };
  }
  const entry: BusyQueueEntry = {
    id: draft.id ?? newBusyId(),
    chat,
    text,
    display: draft.display ?? text,
    raw: draft.raw ?? draft.display ?? text,
    ts: draft.ts ?? Date.now(),
  };
  return { entries: [...entries, entry], entry };
}

/** Put one entry back at the front of its chat's queue (a refused handoff). */
export function prependBusy(entries: BusyQueueEntry[], entry: BusyQueueEntry): BusyQueueEntry[] {
  const first = entries.findIndex((item) => item.chat === entry.chat);
  if (first < 0) return [entry, ...entries];
  const next = [...entries];
  next.splice(first, 0, entry);
  return next;
}

/** Drop one entry by local id (single-item cancel). */
export function removeBusyEntry(entries: BusyQueueEntry[], id: string): BusyQueueEntry[] {
  return entries.filter((item) => item.id !== id);
}

/** Entries of one chat, in send order. */
export function busyFor(entries: BusyQueueEntry[], chat: string): BusyQueueEntry[] {
  return entries.filter((item) => item.chat === chat);
}

/** True when this chat has something to flush. */
export function hasBusyWork(entries: BusyQueueEntry[], chat: string): boolean {
  return entries.some((item) => item.chat === chat);
}

/** Chats with at least one queued message (the reconnect flush iterates these). */
export function busyChatsWithWork(entries: BusyQueueEntry[]): string[] {
  return [...new Set(entries.map((item) => item.chat))];
}

/**
 * Take the head of one chat's queue, atomically. The caller sends it
 * immediately; nothing is left in this store that could be flushed twice.
 */
export function takeBusyHead(
  entries: BusyQueueEntry[],
  chat: string,
): { entry: BusyQueueEntry | null; entries: BusyQueueEntry[] } {
  const index = entries.findIndex((item) => item.chat === chat);
  if (index < 0) return { entry: null, entries };
  return { entry: entries[index], entries: entries.filter((_, i) => i !== index) };
}

/** Drop a deleted chat's backlog (the chat no longer exists to be idle). */
export function removeBusyChat(entries: BusyQueueEntry[], chat: string): BusyQueueEntry[] {
  const next = entries.filter((item) => item.chat !== chat);
  return next.length === entries.length ? entries : next;
}

/** The remembered mode; anything unreadable falls back to 排队. */
export function loadBusyMode(storage: ReadonlyStorage | null = defaultStorage()): BusyMode {
  try {
    return storage?.getItem(BUSY_MODE_KEY) === 'now' ? 'now' : 'queue';
  } catch {
    return 'queue';
  }
}

export function saveBusyMode(
  mode: BusyMode,
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(BUSY_MODE_KEY, mode);
  } catch {
    /* the choice just won't be remembered */
  }
}
