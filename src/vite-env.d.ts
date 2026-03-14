/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_SERVER_KEY?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
