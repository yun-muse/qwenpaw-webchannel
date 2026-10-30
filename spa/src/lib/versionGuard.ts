/**
 * Pure update decision (M29). Kept separate from `version.ts` so the
 * anti-loop rules are unit-testable without a browser.
 *
 * The markers live in localStorage, not sessionStorage: killing a PWA
 * destroys the tab and its sessionStorage, which is exactly the cold start
 * this guard has to survive.
 */

/** Any reload (not just this build) needs a minute before we try again. */
export const RELOAD_COOLDOWN_MS = 60_000;

/** After reloading for a build once, wait this long before trying it again. */
export const RETRY_AFTER_MS = 10 * 60_000;

export type UpdateDecision = 'ignore' | 'banner' | 'update';

export interface UpdateState {
  /** Build id served by /version.json. */
  remoteBuild: string;
  /** Build id compiled into this page. */
  localBuild: string;
  /** Build id we last reloaded for, if any. */
  reloadedFor: string | null;
  /** Timestamp of the last update reload; 0 when unknown. */
  lastReloadAt: number;
  now: number;
  cooldownMs?: number;
  retryAfterMs?: number;
}

/**
 * - `ignore`: nothing to do (same build or no probe answer).
 * - `banner`: we already tried recently; offer the manual refresh instead of
 *   looping.
 * - `update`: run the takeover handshake, then reload.
 */
export function decideUpdate(state: UpdateState): UpdateDecision {
  const remote = state.remoteBuild.trim();
  if (!remote || remote === state.localBuild) return 'ignore';

  const cooldown = state.cooldownMs ?? RELOAD_COOLDOWN_MS;
  const retryAfter = state.retryAfterMs ?? RETRY_AFTER_MS;
  const last = Number.isFinite(state.lastReloadAt) && state.lastReloadAt > 0 ? state.lastReloadAt : 0;
  const since = last ? state.now - last : Number.POSITIVE_INFINITY;

  // Reloaded for this exact build already and it did not take effect: a
  // second automatic reload would just loop. A future clock makes `since`
  // negative, which counts as recent.
  if (state.reloadedFor === remote && since < retryAfter) return 'banner';

  // Two builds in quick succession (or a reload that did not stick): back off.
  if (last && since < cooldown) return 'banner';

  return 'update';
}
