import type { ReaderFile } from "../../components/work-surface/reader-surface";
import {
  createOoxmlByteSource,
  type OoxmlByteSource,
} from "@nautilo/browser-document-viewer";
import {
  loadBinaryPreview,
  type BinaryPreviewDependencies,
} from "../../lib/binary-preview-source";
import type { ViewerLoadContext } from "../types";
import {
  OOXML_ARCHIVE_PREFLIGHT_LIMITS,
  OOXML_MAX_SOURCE_BYTES,
} from "./contract";

export type { OoxmlByteSource };

export type OoxmlSourceResult =
  | { kind: "ready"; source: OoxmlByteSource }
  | { kind: "too_large"; sizeBytes: number; maxBytes: number }
  | { kind: "error"; message: string };

export type OoxmlSourceDependencies = BinaryPreviewDependencies;

/** Never expose archive-controlled parser/preflight details to the reader UI. */
const ARCHIVE_PREFLIGHT_FAILURE_MESSAGE =
  "This document cannot be safely previewed.";

/** Acquires already-authorized bytes and preserves the Reader lifecycle owner. */
export async function loadOoxmlByteSource(
  file: ReaderFile,
  dependencies: OoxmlSourceDependencies,
  ctx: ViewerLoadContext = { maxTextBytes: 0 },
): Promise<OoxmlSourceResult> {
  const lifecycle: ViewerLoadContext & {
    signal: AbortSignal;
    deadlineAt: number;
  } = {
    ...ctx,
    signal: ctx.signal ?? new AbortController().signal,
    deadlineAt: ctx.deadlineAt ?? Date.now() + 35_000,
  };
  const result = await loadBinaryPreview(file, dependencies, {
    maxBytes: OOXML_MAX_SOURCE_BYTES,
    signal: lifecycle.signal,
    timeoutMs: Math.max(1, lifecycle.deadlineAt - Date.now()),
    deadlineAt: lifecycle.deadlineAt,
  });
  if (result.kind !== "ready") return result;

  const source = createOoxmlByteSource({
    bytes: result.bytes,
    signal: lifecycle.signal,
    deadlineAt: lifecycle.deadlineAt,
    archivePreflight: OOXML_ARCHIVE_PREFLIGHT_LIMITS,
  });
  if (source.kind !== "ready")
    return { kind: "error", message: ARCHIVE_PREFLIGHT_FAILURE_MESSAGE };

  return { kind: "ready", source: source.source };
}

export const _test = { ARCHIVE_PREFLIGHT_FAILURE_MESSAGE };
