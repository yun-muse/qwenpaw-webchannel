/**
 * M37 — offline send queue (outbox), without the DOM.
 *
 * A draft is text the user has *not sent* (M22, `lib/drafts.ts`). An outbox
 * entry is the opposite: the user pressed send, and the frame could not be
 * handed to a relay yet. The two stores stay separate on purpose — clearing
 * the draft is what turns composer text into a queue entry.
 *
 * The protocol has no per-message acknowledgement (`msg` is fire-and-forget,
 * see `docs/m37-report.md`), so delivery can only be *proven* by the chat's
 * history. That shapes the states:
 *
 *   queued  — never handed to a socket. Rendered as 待发送, retried on every
 *             `live + agent online` transition.
 *   sent    — handed to the socket. Hidden from the UI (the normal bubble is
 *             already on screen); only a disconnect makes it interesting.
 *   failed  — attempts exhausted, or `sent` with a dead connection that the
 *             history could neither confirm nor deny. Rendered red, kept in
 *             the queue until the user retries or cancels it.
 *
 * `unconfirmed` marks a `sent` entry whose connection died before history
 * could prove delivery. It is never auto-resent — that is the one way to
 * guarantee the queue can never produce a duplicate.
 */

export const OUTBOX_KEY = 'webchannel.outbox';
/** One chat may not grow past this; enqueueing beyond it is refused, not dropped. */
export const MAX_QUEUE_PER_CHAT = 20;
/** Whole-store cap (all chats). */
export const MAX_QUEUE_TOTAL = 100;
/** Hands to a socket before an entry gives up and turns red. */
export const MAX_SEND_ATTEMPTS = 3;

export type OutboxStatus = 'queued' | 'sent' | 'failed';

export interface OutboxEntry {
  /** Local id (unique within this browser), never sent to the plugin. */
  id: string;
  chat: string;
  /** Exactly what goes on the wire (a skill's instruction already prepended). */
  text: string;
  /** What the bubble shows (the `@skill` form the user typed). */
  display: string;
  /** The raw composer text, restored by 撤销. */
  raw: string;
  status: OutboxStatus;
  /** `sent` with a lost connection: delivery is unknown until history answers. */
  unconfirmed: boolean;
  /**
   * A normal bubble for this text is on screen (true once the flush handed it
   * over). Such an entry renders as a status strip, never as a second bubble,
   * so the same sentence can never appear twice.
   */
  echo: boolean;
  /** Times this entry was handed to a socket. */
  attempts: number;
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

/** A new local id: time-ordered enough to be readable in a debugger. */
export function newOutboxId(now = Date.now(), random = Math.random): string {
  return `o${now.toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
}

function isStatus(value: unknown): value is OutboxStatus {
  return value === 'queued' || value === 'sent' || value === 'failed';
}

function cleanEntry(raw: unknown): OutboxEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const chat = typeof record.chat === 'string' ? record.chat : '';
  const text = typeof record.text === 'string' ? record.text : '';
  if (!chat || !text.trim()) return null;
  const id = typeof record.id === 'string' && record.id ? record.id : newOutboxId();
  const display = typeof record.display === 'string' && record.display ? record.display : text;
  const rawText = typeof record.raw === 'string' ? record.raw : display;
  const status = isStatus(record.status) ? record.status : 'queued';
  const attempts =
    typeof record.attempts === 'number' && Number.isFinite(record.attempts) && record.attempts >= 0
      ? Math.floor(record.attempts)
      : 0;
  const ts = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : Date.now();
  return {
    id,
    chat,
    text,
    display,
    raw: rawText,
    status,
    // A `queued` entry was never handed over, so "sent but unconfirmed"
    // cannot apply to it; `failed` keeps the flag when it came from one.
    unconfirmed: record.unconfirmed === true && status !== 'queued',
    // No bubble exists until a flush returns it to the message list.
    echo: record.echo === true && status !== 'queued',
    attempts,
    ts,
  };
}

/** Parse a stored outbox array; malformed entries are dropped, order is kept. */
export function parseOutbox(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: OutboxEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const entry = cleanEntry(item);
      if (!entry || seen.has(entry.id)) continue;
      // A `sent` entry with nothing uncertain about it is only meaningful
      // while the connection that carried it is open; it must never be
      // restored as a hidden ghost that a later disconnect could revive.
      if (entry.status === 'sent' && !entry.unconfirmed) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/** Entries from the last visit, or [] when the store is empty/unusable. */
export function loadOutbox(storage: ReadonlyStorage | null = defaultStorage()): OutboxEntry[] {
  if (!storage) return [];
  try {
    return parseOutbox(storage.getItem(OUTBOX_KEY));
  } catch {
    return [];
  }
}

/**
 * What the next visit must remember: queued and failed rows, plus a `sent`
 * entry whose connection died. A plain `sent` entry is already on screen and
 * only matters if *this* connection fails, so it is not written to storage.
 */
export function persistableOutbox(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter((item) => item.status !== 'sent' || item.unconfirmed);
}

/** Persist the whole queue; a blocked quota must never reach the caller. */
export function saveOutbox(
  entries: OutboxEntry[],
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(OUTBOX_KEY, JSON.stringify(persistableOutbox(entries)));
  } catch {
    /* not persisted — the session still works, it just won't be restored */
  }
}

export type EnqueueRefusal = 'full-chat' | 'full-total';

export interface EnqueueResult {
  entries: OutboxEntry[];
  entry: OutboxEntry | null;
  refused?: EnqueueRefusal;
}

/**
 * Append one entry to the queue (per-chat FIFO: the array order *is* the
 * send order). A full queue refuses the entry instead of dropping the oldest:
 * losing a message the user thought they sent is exactly what this feature
 * exists to prevent.
 */
export function enqueueOutbox(
  entries: OutboxEntry[],
  draft: { chat: string; text: string; display?: string; raw?: string; id?: string; ts?: number },
): EnqueueResult {
  const chat = draft.chat;
  const text = draft.text;
  if (!chat || !text.trim()) return { entries, entry: null };
  if (entries.filter((item) => item.chat === chat).length >= MAX_QUEUE_PER_CHAT) {
    return { entries, entry: null, refused: 'full-chat' };
  }
  if (entries.length >= MAX_QUEUE_TOTAL) {
    return { entries, entry: null, refused: 'full-total' };
  }
  const entry: OutboxEntry = {
    id: draft.id ?? newOutboxId(),
    chat,
    text,
    display: draft.display ?? text,
    raw: draft.raw ?? draft.display ?? text,
    status: 'queued',
    unconfirmed: false,
    echo: false,
    attempts: 0,
    ts: draft.ts ?? Date.now(),
  };
  return { entries: [...entries, entry], entry };
}

/** Drop one entry by local id (single-item cancel). */
export function removeOutboxEntry(entries: OutboxEntry[], id: string): OutboxEntry[] {
  return entries.filter((item) => item.id !== id);
}

/** Entries of one chat, in send order. */
export function outboxFor(entries: OutboxEntry[], chat: string): OutboxEntry[] {
  return entries.filter((item) => item.chat === chat);
}

/** Rows the message list must render: queued, unconfirmed, and failed. */
export function visibleOutbox(entries: OutboxEntry[], chat: string): OutboxEntry[] {
  return entries.filter(
    (item) => item.chat === chat && (item.status === 'queued' || item.status === 'failed' || item.unconfirmed),
  );
}

/** True when some entry still needs the wire (a flush is worth attempting). */
export function hasQueuedWork(entries: OutboxEntry[]): boolean {
  return entries.some((item) => item.status === 'queued');
}

/** Mark the entries a flush just handed to the socket (bubble is on screen). */
export function markOutboxSent(entries: OutboxEntry[], ids: string[]): OutboxEntry[] {
  if (ids.length === 0) return entries;
  const set = new Set(ids);
  return entries.map((item) =>
    set.has(item.id) && item.status === 'queued'
      ? { ...item, status: 'sent', attempts: item.attempts + 1, unconfirmed: false, echo: true }
      : item,
  );
}

/**
 * The connection died: every `sent` entry becomes unconfirmed. Called when the
 * relay leaves `live`, *before* the reconnect, so a message that may or may
 * not have reached the plugin is never silently resent.
 */
export function markOutboxUnconfirmed(entries: OutboxEntry[]): OutboxEntry[] {
  let changed = false;
  const next = entries.map((item) => {
    if (item.status !== 'sent') return item;
    changed = true;
    return { ...item, unconfirmed: true };
  });
  return changed ? next : entries;
}

/**
 * Drop the `sent` entries of one chat that nothing flags as unconfirmed.
 *
 * Called a grace period after a flush: a `sent` entry only exists so that a
 * connection failure can turn it into 未确认. Keeping it forever would make a
 * disconnect an hour later claim every past message is unconfirmed.
 */
export function pruneSentOutbox(entries: OutboxEntry[], chat: string): OutboxEntry[] {
  const next = entries.filter((item) => item.chat !== chat || item.status !== 'sent' || item.unconfirmed);
  return next.length === entries.length ? entries : next;
}

/** Explicit failure (frame too large, connection refused the write, cap hit). */
export function failOutboxEntry(entries: OutboxEntry[], id: string): OutboxEntry[] {
  return entries.map((item) =>
    item.id === id ? { ...item, status: 'failed', unconfirmed: false } : item,
  );
}

/** True while the entry still has automatic/manual attempts left. */
export function canRetry(entry: OutboxEntry): boolean {
  return entry.attempts < MAX_SEND_ATTEMPTS;
}

/**
 * User-initiated retry: back into its chat's queue. The attempt counter is
 * *not* reset — the cap is what stops a message that keeps failing from being
 * retried forever; past it the row only offers 撤销.
 */
export function retryOutboxEntry(entries: OutboxEntry[], id: string): OutboxEntry[] {
  return entries.map((item) =>
    item.id === id && canRetry(item)
      ? { ...item, status: 'queued', unconfirmed: false }
      : item,
  );
}

export interface ReconcileResult {
  entries: OutboxEntry[];
  /** Ids that history proves were delivered (now removed). */
  confirmed: string[];
  /** Ids left unconfirmed because history neither proved nor disproved them. */
  unknown: string[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Resolve one chat's `sent` entries against the chat's history.
 *
 * `userTexts` are the `role: "user"` texts of the chat in order. The frames
 * were written to one socket in queue order, so what can have arrived is a
 * *prefix* of the sent list -- find the longest one that matches the tail of
 * the history. Everything after it is kept as unconfirmed: the protocol cannot
 * say "that exact message arrived", and resending on a guess would show the
 * same sentence twice. With repeated identical texts this is deliberately
 * at-most-once -- a duplicate is worse than a lost repeat, and the entry stays
 * on screen for the user to retry.
 */
export function reconcileOutbox(
  entries: OutboxEntry[],
  chat: string,
  userTexts: string[],
): ReconcileResult {
  const sent = entries.filter((item) => item.chat === chat && item.status === 'sent');
  if (sent.length === 0) return { entries, confirmed: [], unknown: [] };

  const history = userTexts.map(normalize).filter((text) => text.length > 0);
  let matched = 0;
  for (let size = Math.min(sent.length, history.length); size > 0; size -= 1) {
    let ok = true;
    for (let i = 0; i < size; i += 1) {
      if (normalize(sent[i].text) !== history[history.length - size + i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matched = size;
      break;
    }
  }

  const confirmedIds = new Set(sent.slice(0, matched).map((item) => item.id));
  const unknown = new Set(sent.slice(matched).map((item) => item.id));
  const next = entries
    .filter((item) => !confirmedIds.has(item.id))
    .map((item) =>
      unknown.has(item.id) ? { ...item, status: 'failed' as OutboxStatus, unconfirmed: true } : item,
    );
  return { entries: next, confirmed: [...confirmedIds], unknown: [...unknown] };
}
