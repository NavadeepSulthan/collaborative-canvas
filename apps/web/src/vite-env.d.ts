/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Comma-separated list of collaboration server base URLs (http/https). */
  readonly VITE_COLLAB_SERVERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
