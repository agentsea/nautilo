import { classifyArtifactKind } from "@/lib/artifact-bytes";

import {
  MAX_NATIVE_SOURCE_EDIT_BYTES,
  nativeSourceByteLength,
} from "./artifact-edit-limits";

export type ArtifactEditReason =
  | "not_writable"
  | "invalid_metadata_size"
  | "metadata_too_large"
  | "unsupported_kind"
  | "content_too_large";
export type ArtifactEditMetadata = {
  path: string;
  mimeType: string;
  size: number;
  writable: boolean;
};
export type ArtifactEditViewOnly = { kind: "view-only"; reason: ArtifactEditReason };
export type ArtifactEditSourceCandidate = { kind: "source-candidate"; format: "markdown" | "text" };
export type ArtifactEditPreflight = ArtifactEditViewOnly | ArtifactEditSourceCandidate;
export type ArtifactEditSource = { kind: "source"; format: "markdown" | "text"; content: string };
export type ArtifactEditContentAdmission = ArtifactEditViewOnly | ArtifactEditSource;

function normalizedMime(mimeType: string): string { return mimeType.trim().toLowerCase(); }
function isHtmlLikePath(path: string): boolean { return /\.html?$/iu.test(path); }
function validMetadataSize(size: number): boolean { return Number.isFinite(size) && Number.isInteger(size) && size >= 0; }

/** Stage 1: metadata-only gate. This never reads source content or invokes an editor. */
export function preflightArtifactEdit(metadata: ArtifactEditMetadata): ArtifactEditPreflight {
  if (!metadata.writable) return { kind: "view-only", reason: "not_writable" };
  if (!validMetadataSize(metadata.size)) return { kind: "view-only", reason: "invalid_metadata_size" };
  if (metadata.size > MAX_NATIVE_SOURCE_EDIT_BYTES) return { kind: "view-only", reason: "metadata_too_large" };
  if (normalizedMime(metadata.mimeType) === "text/html") {
    return { kind: "view-only", reason: "unsupported_kind" };
  }
  if (isHtmlLikePath(metadata.path)) return { kind: "view-only", reason: "unsupported_kind" };
  const viewerKind = classifyArtifactKind(metadata.path, metadata.mimeType);
  if (viewerKind === "markdown") return { kind: "source-candidate", format: "markdown" };
  if (viewerKind === "text") return { kind: "source-candidate", format: "text" };
  return { kind: "view-only", reason: "unsupported_kind" };
}

/** Stage 2: content gate. It repeats byte enforcement after transport and is lossless. */
export function admitArtifactEditContent(
  metadata: ArtifactEditMetadata,
  content: string,
): ArtifactEditContentAdmission {
  const preflight = preflightArtifactEdit(metadata);
  if (preflight.kind === "view-only") return preflight;
  if (nativeSourceByteLength(content) > MAX_NATIVE_SOURCE_EDIT_BYTES) {
    return { kind: "view-only", reason: "content_too_large" };
  }
  return { kind: "source", format: preflight.format, content };
}
