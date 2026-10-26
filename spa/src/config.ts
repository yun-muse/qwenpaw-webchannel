/**
 * Build-time configuration (Vite env). With neither variable set the SPA is
 * byte-for-byte the local-dev build: 127.0.0.1 relay, no login gate.
 */

export const RELAY_WS_URL = import.meta.env.VITE_RELAY_WS ?? 'ws://127.0.0.1:8787/ws/client';

/** HTTP base of the hosted relay (`POST /api/login`); '' in local dev. */
export const RELAY_HTTP_URL = import.meta.env.VITE_RELAY_HTTP ?? '';

/** Hosted relay → the browser must authenticate before opening the socket. */
export const LOGIN_REQUIRED = RELAY_HTTP_URL !== '';
