/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOOK_URL: string
  readonly VITE_BEE_API_URL: string
  readonly VITE_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
