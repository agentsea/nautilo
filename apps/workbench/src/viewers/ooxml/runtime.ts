import type { LoadOptions as DocxLoadOptions, DocxScrollViewerOptions } from "@silurus/ooxml/docx";
import type { LoadOptions as PptxLoadOptions, PptxViewerOptions } from "@silurus/ooxml/pptx";
import type { LoadOptions as XlsxLoadOptions, XlsxViewerOptions } from "@silurus/ooxml/xlsx";
import {
  OOXML_SAFE_LOAD_OPTIONS,
  OOXML_SAFE_VIEWER_OPTIONS,
  OOXML_TOTAL_LOAD_TIMEOUT_MS,
  OOXML_WORKER_TIMEOUT_MS,
  PPTX_SAFE_VIEWER_OPTIONS,
  type OoxmlFormat,
} from "./contract";

const OOXML_SAME_ORIGIN_WASM_STRATEGY =
  "direct-subpath-relative" as const;

/**
 * Omit wasmUrl deliberately: the installed direct entry points resolve their
 * matching Vite-emitted WASM beside their own module URL, preserving same-origin
 * delivery in dev, server, Docker, and Electron.
 */
export function buildOoxmlLoadOptions(): DocxLoadOptions & XlsxLoadOptions & PptxLoadOptions {
  return { ...OOXML_SAFE_LOAD_OPTIONS, mode: "main" };
}

export function buildOoxmlViewerOptions(format: OoxmlFormat):
  | DocxScrollViewerOptions
  | XlsxViewerOptions
  | PptxViewerOptions {
  const base = { ...buildOoxmlLoadOptions(), ...OOXML_SAFE_VIEWER_OPTIONS };
  return format === "pptx" ? { ...base, ...PPTX_SAFE_VIEWER_OPTIONS } : base;
}

export function sanitizeOoxmlError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "encrypted" || code === "invalid-password" || code === "unsupported-encryption") {
    return "This document is encrypted and cannot be previewed.";
  }
  if (
    code === "ooxml-resource-limit" ||
    code === "zip-bomb" ||
    code === "zip-entry-too-large"
  ) {
    return "This document exceeds the preview safety limit.";
  }
  return "Unable to preview this document.";
}

export const OOXML_RUNTIME_LIMITS = {
  workerTimeoutMs: OOXML_WORKER_TIMEOUT_MS,
  totalLoadTimeoutMs: OOXML_TOTAL_LOAD_TIMEOUT_MS,
  wasmStrategy: OOXML_SAME_ORIGIN_WASM_STRATEGY,
} as const;
