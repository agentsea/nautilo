
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
/** Secondary recovery copy. The host binds its account, app and document scope. */
export type BoardRecoveryDraft = {
  version: 1;
  content: string;
  exact: boolean;
  baseSha256: string | null;
  baseRevision: number | null;
};
export type BoardRecoveryBridge = {
  read(): Promise<{ revision: string | null; draft: BoardRecoveryDraft | null }>;
  write(input: { expectedRevision: string | null; draft: BoardRecoveryDraft | null }): Promise<{ revision: string | null }>;
};
export interface BoardBridge {
  recovery?: BoardRecoveryBridge;
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
export function getBoardBridge(): BoardBridge {
  const bridge = (window as unknown as { nautiloApp?: BoardBridge }).nautiloApp;
  if (!bridge) throw new Error("Open Board from Nautilo to connect this board.");
  return bridge;
}
