/**
 * M27 — per-chat thinking-effort state, without the DOM.
 *
 * A chat only gets a QwenPaw `ChatSpec` when its first message is processed,
 * so `get_effort` / `set_effort` answer `E_EFFORT` with `status: 404` for a
 * brand-new chat. That is an expected state, not a failure: the selector keeps
 * the local choice and the plugin is told again once the chat exists.
 *
 * These helpers encode that split so the frame handler stays readable:
 *
 *  - `effortErrorAction` classifies an `E_EFFORT` frame (404 = expected,
 *    a get failure = silent, anything else on a set = a real rejection);
 *  - `effortNeedsApply` answers "does the server still owe this chat a level?";
 *  - `pendingEffortLevel` returns the level the re-apply trigger must send;
 *  - `shouldAdoptEffortLevel` keeps a `get_effort` reply from overwriting an
 *    unconfirmed local choice (the set reply, which carries the same level,
 *    is still adopted and confirms it).
 */

export type EffortErrorAction = 'not-created' | 'get-unavailable' | 'rejected';

/**
 * What an `E_EFFORT` frame means for the selector.
 *
 * The plugin reserves `status: 404` for "the chat list was readable and this
 * chat has no record yet"; a failed lookup reports 0/HTTP instead (M27), so a
 * 404 never hides an outage.
 */
export function effortErrorAction(
  id: unknown,
  status: unknown,
): EffortErrorAction {
  if (status === 404) return 'not-created';
  if (id === 'effort-get') return 'get-unavailable';
  return 'rejected';
}

/**
 * True when this chat's server record does not hold *level* yet.
 *
 * `confirmed` is `null`/`undefined` until an `effort` frame told us the
 * server's value, so a restored local choice counts as unconfirmed.
 */
export function effortNeedsApply(
  level: string | undefined,
  confirmed: string | null | undefined,
): boolean {
  const chosen = level || 'default';
  return chosen !== 'default' && chosen !== (confirmed ?? null);
}

/** The level the re-apply trigger must send, or null when nothing is owed. */
export function pendingEffortLevel(
  level: string | undefined,
  meta: { confirmed: string | null; pending: boolean } | undefined,
): string | null {
  if (!meta?.pending) return null;
  if (!effortNeedsApply(level, meta.confirmed)) return null;
  return level || null;
}

/**
 * Whether an `effort` frame's `level` may replace the local selector value.
 *
 * While a local choice is pending, a differing `level` can only come from a
 * `get_effort` reply (a `set_effort` reply always echoes what we sent); it
 * must not silently overwrite the user's choice. Everything else -- including
 * the confirming set reply -- is adopted.
 */
export function shouldAdoptEffortLevel(
  local: string | undefined,
  meta: { pending: boolean } | undefined,
  frameLevel: string,
): boolean {
  if (meta?.pending && frameLevel !== (local || 'default')) return false;
  return true;
}
