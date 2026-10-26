# Task M3-2 — SPA production wiring (spa/)

Make the relay endpoint configurable and add the login flow for the hosted
relay. Local dev behaviour must stay byte-for-byte the same when no build-time
config is given. Only touch `spa/` (`src/relay.ts`, `src/App.tsx`,
`src/App.css`, new small modules if needed, and `spa/.env.example`).

## Config (build-time, Vite env)

- `VITE_RELAY_WS` — full WS URL for the client leg, e.g.
  `wss://qwenpaw-webchannel-relay.<account>.workers.dev/ws/client`.
- `VITE_RELAY_HTTP` — HTTP base of the same relay, e.g.
  `https://qwenpaw-webchannel-relay.<account>.workers.dev` (used for
  `POST /api/login`).
- Read them in a small new module `spa/src/config.ts`:
  ```ts
  export const RELAY_WS_URL = import.meta.env.VITE_RELAY_WS ?? 'ws://127.0.0.1:8787/ws/client';
  export const RELAY_HTTP_URL = import.meta.env.VITE_RELAY_HTTP ?? '';
  export const LOGIN_REQUIRED = RELAY_HTTP_URL !== '';
  ```
  Add the `ImportMetaEnv` typing if the project lacks it (check
  `src/vite-env.d.ts`; create it with `/// <reference types="vite/client" />`
  if missing).
- `spa/.env.example` documenting both vars (with the workers.dev example).
- `RelayClient` keeps `ws://127.0.0.1:8787/ws/client` as its built-in default;
  App passes the configured URL explicitly (see token below).

## Client token + login flow

The hosted relay requires a client token: the browser WS upgrade cannot set
headers, so the token travels as a query parameter:
`new WebSocket(url)` becomes `url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)`.

- In `relay.ts`, add an optional `getToken?: () => string | null` to
  `RelayOptions`. In `connect()`, when `getToken` returns a non-empty string,
  append it as the `token` query param as above. When it returns null/empty,
  connect without a param (local dev). Token must be fetched fresh on every
  (re)connect (it can expire while the page is open).
- In `App.tsx`:
  - Token storage: `sessionStorage` key `webchannel.token`.
  - When `LOGIN_REQUIRED` is false (local dev): behave exactly as today —
    create the client, connect immediately, no login UI, `getToken` returns null.
  - When `LOGIN_REQUIRED` is true and no token is stored: render a login gate
    INSTEAD of the chat UI — a centered form (app title, password input,
    submit button, error line). On submit: `POST ${RELAY_HTTP_URL}/api/login`
    with JSON `{password}`; on 200 store `token` from the JSON body in
    sessionStorage and proceed to mount/connect the chat UI; on non-200 show
    the server's `error` value (or a generic message) and stay on the form.
    Disable the button while the request is in flight.
  - Pass `getToken: () => sessionStorage.getItem('webchannel.token')` to
    RelayClient.
  - A stored-but-expired token will make the WS upgrade fail (401 → close →
    reconnect loop). Guard: in the RelayClient `onState`/close path — simpler
    and acceptable: when `LOGIN_REQUIRED` and the client has failed to reach
    `live` after several attempts is over-engineering; instead handle the
    connection-level `E_AUTH` frame / fatal close by clearing the stored
    token and returning to the login gate. The existing RelayClient already
    treats connection-level `E_AUTH` (no chat/req_id) as fatal and goes
    `idle`; App should react to that state (when LOGIN_REQUIRED and state
    becomes `idle` after having been connecting, clear the token and show
    the login gate again). Implement the simplest version of this that works:
    a `needsLogin` React state, set true initially when LOGIN_REQUIRED &&
    no token, set false on successful login, and set true again (+ clear
    token) when the client reports the fatal-E_AUTH path. You may add a
    small optional `onAuthFailure?: () => void` callback to RelayOptions,
    invoked from the existing connection-level E_AUTH branch in relay.ts.
- Style the login gate in App.css, consistent with the existing light theme
  (centered card, same fonts/colours). Keep it compact.

## Acceptance

- `npm run build` in spa/ passes (tsc + vite).
- With NO env vars set, the built SPA still targets
  `ws://127.0.0.1:8787/ws/client` and shows no login (local dev unchanged).
- Do not change frame handling, chat logic, or styles beyond the login gate.
