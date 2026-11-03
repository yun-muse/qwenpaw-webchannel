/**
 * M41 — composer key semantics.
 *
 * The composer has exactly two explicit sends: the 发送 button and a real
 * Enter key. Every other way a keydown can arrive must be excluded *before*
 * the send branch, because a phone turns several non-send gestures into key
 * events:
 *
 *  - `Shift+Enter` is a newline (unchanged from M22).
 *  - An IME session reports its own Enter (candidate confirm, and the commit
 *    key a Chinese keyboard uses around a clipboard paste) as a plain
 *    `keydown`. Sending on it is the classic Chinese-input bug: the user
 *    pastes, the keyboard confirms, and the composer content leaves before
 *    it can be edited. Browsers disagree on how to flag it, so both signals
 *    are checked:
 *      * `KeyboardEvent.isComposing` — Chrome, Firefox, Safari 15+;
 *      * legacy `keyCode === 229` — Android WebView and older Safari report
 *        the key as `Unidentified`/`Process` while it still belongs to the
 *        IME (the deprecated `keyCode` is the one field that stays 229).
 *
 * Paste text itself never reaches these helpers: `onPaste` only stages
 * clipboard *files* and otherwise leaves the browser's default insertion
 * alone, so pasted text lands in the composer for further editing.
 *
 * Pure and DOM-free, so `spa/tests/keys.test.ts` can decide every branch.
 */

/** `keyCode` Android/WebView assign to every key the IME is handling. */
export const IME_PROCESS_KEY_CODE = 229;

/** The part of a KeyboardEvent this module needs (real events satisfy it). */
export interface ComposerKeyLike {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** True while the key belongs to an IME session, on either platform signal. */
export function isImeKey(event: ComposerKeyLike): boolean {
  return Boolean(event.isComposing) || event.keyCode === IME_PROCESS_KEY_CODE;
}

/**
 * Enter is an explicit send only when it is a real key: no Shift, and not the
 * IME's own Enter (composition in progress, or a 229 keydown).
 */
export function shouldSendOnEnter(event: ComposerKeyLike): boolean {
  return event.key === 'Enter' && !event.shiftKey && !isImeKey(event);
}
