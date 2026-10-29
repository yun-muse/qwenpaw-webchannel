/**
 * Named prompts the user saves for reuse (M22).
 *
 * The library is a small ordered list (newest first) in localStorage. Every
 * mutation is a pure list operation so the React layer only owns the panel;
 * ids are supplied by `newPromptId` (tests inject a deterministic factory).
 */

export const PROMPTS_KEY = 'webchannel.promptLibrary';

export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
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

/** A unique-enough id; the timestamp keeps entries sorted in devtools. */
export function newPromptId(): string {
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse a stored list; malformed rows and duplicate ids are dropped. */
export function parsePrompts(raw: string | null): SavedPrompt[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: SavedPrompt[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { id?: unknown; name?: unknown; text?: unknown };
      const id = typeof record.id === 'string' ? record.id : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const text = typeof record.text === 'string' ? record.text : '';
      if (!id || !name || !text.trim() || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name, text });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadPrompts(storage: ReadonlyStorage | null = defaultStorage()): SavedPrompt[] {
  if (!storage) return [];
  try {
    return parsePrompts(storage.getItem(PROMPTS_KEY));
  } catch {
    return [];
  }
}

export function savePrompts(
  prompts: readonly SavedPrompt[],
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
  } catch {
    /* not persisted — the in-memory list still works */
  }
}

/** Add a named prompt at the top; null when either field is blank. */
export function addPrompt(
  prompts: readonly SavedPrompt[],
  name: string,
  text: string,
  makeId: () => string = newPromptId,
): SavedPrompt[] | null {
  const trimmedName = name.trim();
  if (!trimmedName || !text.trim()) return null;
  return [{ id: makeId(), name: trimmedName, text }, ...prompts];
}

/** Rename one entry; a blank name is rejected and the same list is returned. */
export function renamePrompt(
  prompts: SavedPrompt[],
  id: string,
  name: string,
): SavedPrompt[] {
  const trimmed = name.trim();
  if (!trimmed) return prompts;
  const index = prompts.findIndex((entry) => entry.id === id);
  if (index < 0 || prompts[index].name === trimmed) return prompts;
  const next = [...prompts];
  next[index] = { ...next[index], name: trimmed };
  return next;
}

/** Remove one entry (the same list when the id is unknown). */
export function removePrompt(prompts: SavedPrompt[], id: string): SavedPrompt[] {
  const next = prompts.filter((entry) => entry.id !== id);
  return next.length === prompts.length ? prompts : next;
}

/**
 * A usable default name for a draft: the first non-empty line, whitespace
 * collapsed, shortened by code points so a surrogate pair is never split.
 */
export function promptNameOf(text: string, max = 24): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return '';
  const chars = Array.from(line.replace(/\s+/g, ' '));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
