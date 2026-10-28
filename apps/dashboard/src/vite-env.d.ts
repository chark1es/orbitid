/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ORBITID_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
