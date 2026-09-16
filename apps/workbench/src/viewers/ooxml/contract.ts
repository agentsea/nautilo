import {
  DocxDocument,
  type LoadOptions as DocxLoadOptions,
  type DocxScrollViewerOptions,
} from "@silurus/ooxml/docx";
import {
  XlsxWorkbook,
  type LoadOptions as XlsxLoadOptions,
  type XlsxViewerOptions,
} from "@silurus/ooxml/xlsx";
import {
  PptxPresentation,
  type LoadOptions as PptxLoadOptions,
  type PptxViewerOptions,
} from "@silurus/ooxml/pptx";
import type { OoxmlArchivePreflightLimits } from "./archive-preflight";

/**
 * The 0.75.0 parser assets shipped with the three direct entry points.
 *
 * These are package inventory, not a public URL contract: Vite's eventual
 * emitted names are established by the Phase 0 build/packaging gate.
 */
export const OOXML_PARSER_WASM_FILES = {
  docx: "docx_parser_bg.wasm",
  xlsx: "xlsx_parser_bg.wasm",
  pptx: "pptx_parser_bg.wasm",
} as const;

/**
 * Installed-package evidence captured for Task 0.1 (not a production adapter).
 * The 0.75.0 direct format chunks embed their parser Worker JavaScript as Blob/
 * data-URL source; no standalone worker file is shipped. In the default `main`
 * mode, parsing runs in that Worker and Canvas rendering stays on the main
 * thread. `worker` mode is a separate OffscreenCanvas path and is not selected
 * here. Vite 6 must exclude these direct subpaths from dependency optimization:
 * its prebundle otherwise resolves their relative WASM request under `.vite/deps`
 * and receives the SPA HTML fallback instead of the parser binary.
 */
export const OOXML_0750_RUNTIME_INVENTORY = {
  packageVersion: "0.75.0",
  parserWorkers:
    "embedded Blob/data-URL JavaScript in each direct format chunk",
  workerModeRenderHosts: {
    docx: "render-worker-host-DZ4u0RFs.js",
    xlsx: "render-worker-host-CLdOlxFu.js",
    pptx: "render-worker-host-s3J-mWBP.js",
  },
  defaultMode: "main: parser Worker + main-thread Canvas rendering",
  optionalMathEntry: "@silurus/ooxml/math (omitted; roughly 3 MiB)",
  defaults: {
    useGoogleFonts: false,
    resourceLimits: {
      maxArchiveEntryBytes: 128 * 1024 * 1024,
      maxTotalInflatedBytes: 256 * 1024 * 1024,
    },
    workerTimeoutMs: "unlimited (initial parser request only)",
    enableHyperlinks: true,
    enableMediaPlayback: false,
  },
  configured: {
    resourceLimits: {
      maxArchiveEntryBytes: 64 * 1024 * 1024,
      maxTotalInflatedBytes: 512 * 1024 * 1024,
    },
    workerTimeoutMs: 30_000,
    useGoogleFonts: false,
    enableHyperlinks: false,
    enableMediaPlayback: false,
  },
  parserWasm: OOXML_PARSER_WASM_FILES,
} as const;

export const OOXML_SAFE_LOAD_OPTIONS = {
  // Upstream defaults to false, but keep the privacy boundary explicit.
  useGoogleFonts: false,
  resourceLimits: {
    maxArchiveEntryBytes: 64 * 1024 * 1024,
    maxTotalInflatedBytes: 512 * 1024 * 1024,
  },
  // Upstream defaults to unlimited; this bounds the initial parser-worker request.
  workerTimeoutMs: 30_000,
} satisfies DocxLoadOptions &
  XlsxLoadOptions &
  PptxLoadOptions;

/** Every current 0.75.x viewer supports this shared containment switch. */
export const OOXML_SAFE_VIEWER_OPTIONS = {
  // Upstream defaults to true and may otherwise open external links itself.
  enableHyperlinks: false,
} satisfies Pick<DocxScrollViewerOptions, "enableHyperlinks"> &
  Pick<XlsxViewerOptions, "enableHyperlinks"> &
  Pick<PptxViewerOptions, "enableHyperlinks">;

/** PPTX alone exposes media playback; it defaults false and stays explicit. */
export const PPTX_SAFE_VIEWER_OPTIONS = {
  enableMediaPlayback: false,
} satisfies Pick<PptxViewerOptions, "enableMediaPlayback">;

/**
 * Direct subpath exports used by the Task 0.1 probe. This is deliberately not
 * an aggregate `@silurus/ooxml` import, and does not mount/render a viewer.
 */
export const OOXML_PARSER_CONTRACT = {
  docx: DocxDocument,
  xlsx: XlsxWorkbook,
  pptx: PptxPresentation,
} as const;

export type OoxmlFormat = keyof typeof OOXML_PARSER_CONTRACT;

/** The compressed input budget shared by all three OOXML reader formats. */
export const OOXML_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

/**
 * Declared-ZIP-metadata limits checked before any Silurus parser
 * receives an OOXML archive. The 100 MiB source envelope remains the launch
 * contract; 64 MiB matches the parser's current per-entry ceiling. The
 * 512 MiB total permits at most eight full-size declared entries
 * and bounds declared amplification to 5.12x the compressed-source envelope.
 * The 20k-entry cap leaves room for asset-heavy Office packages
 * while bounding the validator's central-directory walk, name set, and range
 * sort. Silurus independently enforces actual distinct-entry inflation and its
 * own non-configurable 20k archive-entry hard ceiling.
 */
export const OOXML_MAX_ARCHIVE_ENTRIES = 20_000;
export const OOXML_MAX_DECLARED_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const OOXML_MAX_DECLARED_PER_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export const OOXML_ARCHIVE_PREFLIGHT_LIMITS = {
  maxEntries: OOXML_MAX_ARCHIVE_ENTRIES,
  maxDeclaredTotalUncompressedBytes: BigInt(
    OOXML_MAX_DECLARED_TOTAL_UNCOMPRESSED_BYTES,
  ),
  maxDeclaredPerEntryUncompressedBytes: BigInt(
    OOXML_MAX_DECLARED_PER_ENTRY_UNCOMPRESSED_BYTES,
  ),
} satisfies OoxmlArchivePreflightLimits;

/** The parser-worker request budget supported by the installed 0.75.x API. */
export const OOXML_WORKER_TIMEOUT_MS = 30_000;

/**
 * The host owns more than the parser request (mounting, rendering, and cleanup),
 * so it has a slightly wider total bound than the parser worker itself.
 */
export const OOXML_TOTAL_LOAD_TIMEOUT_MS = 35_000;
