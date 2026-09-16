import type { SlidesTemplateLibrary } from "./slide-template-library";

export type DocumentEnvelope = {
  content: string;
  path?: string;
  baseSha256: string | null;
  baseRevision: number | null;
};
export type WriteResult =
  | { kind: "saved"; sha256?: string; revision?: number | null; persistedContent?: string; path?: string }
  | { kind: "conflict"; currentSha256?: string | null }
  | { kind: "error"; message: string };
export type DocumentChange =
  | { type: "reconnected" | "changed" }
  | { type: "patch_applied"; envelope?: DocumentEnvelope }
  | { type: "renamed" | "deleted"; path?: string };
export type PrepareCloseResult = {
  noLocalChanges?: boolean;
  documentSaved: boolean;
  recoveryPersisted: boolean;
  recoverableDraftExact: boolean;
  errorMessage?: string | null;
};
export type PreparedSlidesExport = {
  content: string; encoding: "base64"; mimeType: string; byteLength: number;
  sourceSha256: string; warnings: string[];
};
/** Secondary recovery copy. The host binds its account, app and document scope. */
export type SlidesRecoveryDraft = {
  version: 1;
  content: string;
  exact: boolean;
  baseSha256: string | null;
  baseRevision: number | null;
};
export type SlidesRecoveryBridge = {
  read(): Promise<{ revision: string | null; draft: SlidesRecoveryDraft | null }>;
  write(input: { expectedRevision: string | null; draft: SlidesRecoveryDraft | null }): Promise<{ revision: string | null }>;
};
export interface SlidesBridge {
  templates?: SlidesTemplateLibrary;
  recovery?: SlidesRecoveryBridge;
  exports?: {
    onPrepare(handler: (request: { actionId: string; mimeType: string }) => Promise<PreparedSlidesExport>): () => void;
  };
  document: {
    read(opts?: { fresh?: boolean }): Promise<DocumentEnvelope>;
    write(content: string, base: Pick<DocumentEnvelope, "baseSha256" | "baseRevision"> & { conflictPolicy?: "strict" }): Promise<WriteResult>;
    downloadCopy(content: string): Promise<void>;
    saveCopy?(content: string): Promise<{ path: string }>;
    onChange?(handler: (event: DocumentChange) => void): () => void;
  };
  context: { readonly mode?: "edit" | "preview"; set(summary: Record<string, unknown>): void };
  humanEdit?: { set(update: { state: "clean" | "dirty" | "saving" | "conflict" }): void };
  lifecycle?: {
    onPrepareClose(handler: (request: {
      reason: "close" | "replace" | "navigate" | "suspend" | "quit";
      action: "prepare-close" | "save-copy";
    }) => Promise<PrepareCloseResult>): () => void;
  };
}
export function getSlidesBridge(): SlidesBridge {
  const bridge = (window as unknown as { nautiloApp?: SlidesBridge }).nautiloApp;
  if (!bridge) throw new Error("Open Slides from Nautilo to connect this presentation.");
  return bridge;
}
