import type React from "react";
import type { ReaderFile } from "../components/work-surface/reader-surface";

export type ViewerKind =
  | "markdown"
  | "html"
  | "text"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "fallback";

export type ViewerLoadResult =
  | { kind: "ready"; data: unknown }
  | { kind: "unsupported"; ext: string | null }
  /**
   * The file type IS viewable, but the file exceeds the viewer's size cap.
   * Distinct from `unsupported` so the reader can say "too large" (with the
   * actual size + cap) instead of the misleading "preview not available".
   */
  | { kind: "too_large"; sizeBytes: number; maxBytes: number }
  | { kind: "error"; message: string };

export interface ViewerLoadContext {
  maxTextBytes: number;
  /** ReaderSurface owns this controller for the complete selected-file lifecycle. */
  signal?: AbortSignal;
  /** One absolute deadline shared by byte ingress and any parser handoff. */
  deadlineAt?: number;
  /**
   * Dormant protected-Artifact byte ingress. The ordinary Workbench does not
   * provide this callback; hermetic protected compositions may provide an
   * authorized, locally decrypting source without registering a global
   * plaintext endpoint.
   */
  artifactBytes?: ArtifactViewerByteSource;
}

export type ArtifactViewerByteSource = (input: Readonly<{
  artifactId: string;
  maxBytes: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}>) => Promise<ArrayBuffer>;

export interface ViewerProps {
  file: ReaderFile;
  data: unknown;
}

export interface ViewerAdapter {
  kind: ViewerKind;
  canView(file: ReaderFile): boolean;
  load(file: ReaderFile, ctx: ViewerLoadContext): Promise<ViewerLoadResult>;
  Component: (props: ViewerProps) => React.ReactElement;
}
