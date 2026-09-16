/**
 * Platform-neutral D515 export-probe contract. Keep this file browser-free so
 * the native facade can share types and format labels without resolving any
 * Web-only dynamic loader.
 */
export const SHARED_BROWSER_VIEWER_PROBE_FORMATS = ["pdf", "docx", "xlsx", "pptx"] as const;

export type SharedBrowserViewerProbeFormat =
  (typeof SHARED_BROWSER_VIEWER_PROBE_FORMATS)[number];

export interface SharedBrowserViewerExportProbe {
  readonly format: SharedBrowserViewerProbeFormat;
  readonly identity: string;
  /** A truthfully observable emitted asset URL, when the runtime exposes one. */
  readonly assetUrl?: string;
  /** Present only for direct OOXML parser assets. */
  readonly wasmUrl?: string;
  cleanup(): void;
}
