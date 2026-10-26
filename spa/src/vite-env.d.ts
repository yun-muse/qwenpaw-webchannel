/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Full WS URL of the relay's client leg (hosted deployments only). */
  readonly VITE_RELAY_WS?: string;
  /** HTTP base of the same relay, used for `POST /api/login`. */
  readonly VITE_RELAY_HTTP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
