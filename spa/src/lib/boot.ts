/**
 * Bridge to the inline boot watchdog in index.html (M29).
 *
 * The watchdog is plain HTML/CSS/JS so it can paint and heal before (or
 * without) this bundle. Its only contract with the app is a global function:
 * calling it means React committed a first render and the splash can go.
 */

declare global {
  interface Window {
    __webchannelBootReady?: () => void;
  }
}

export function notifyAppMounted(): void {
  try {
    window.__webchannelBootReady?.();
  } catch {
    /* the splash is cosmetic; never break mount because of it */
  }
}
