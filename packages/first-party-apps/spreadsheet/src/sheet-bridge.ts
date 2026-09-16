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
  | { type: "reconnected" }
  | { type: "patch_applied"; envelope: DocumentEnvelope }
  | { type: "changed"; reloadRequired?: boolean }
  | { type: "renamed" | "deleted"; path?: string };
export interface SheetsBridge {
  document: {
    read(opts?: { fresh?: boolean }): Promise<DocumentEnvelope>;
    write(content: string, base: Pick<DocumentEnvelope, "baseSha256" | "baseRevision"> & { conflictPolicy?: "strict" }): Promise<WriteResult>;
    downloadCopy(content: string): Promise<void>;
    onChange?(handler: (event: DocumentChange) => void): () => void;
  };
  context: { set(summary: Record<string, unknown>): void };
  humanEdit?: { set(update: { state: "clean" | "dirty" | "saving" | "conflict" }): void };
}
export function getSheetsBridge(): SheetsBridge {
  const bridge = (window as unknown as { nautiloApp?: SheetsBridge }).nautiloApp;
  if (!bridge) throw new Error("Open Sheets from Nautilo to connect this document.");
  return bridge;
}
