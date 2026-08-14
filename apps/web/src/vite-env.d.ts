/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute origin of the SCANFORGE API when it is not the page's own origin. */
  readonly VITE_API_BASE?: string;
  /** '1' for builds published as a static site with no API on the origin. */
  readonly VITE_STATIC_BUILD?: string;
  /** Base URL of the bundled example model directory (trailing slash). */
  readonly VITE_DEMO_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
