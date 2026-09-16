export type AttachmentSource =
  | "workbench-chat"
  | "workspace-file"
  | "current-folder-file"
  | "future-ingest";

export type AttachmentZone = "workspace" | "current" | "absolute";

export type AttachmentEnvelope = {
  id: string;
  source: AttachmentSource;
  filename: string;
  claimedMime?: string;
  sizeBytes: number;
  bytes?: Uint8Array;
  path?: string;
  zone?: AttachmentZone;
  originMessageId?: string;
  /**
   * Explicit opt-in for script-like files that should be treated as inert
   * source text for reading/review only. This is never an execution path.
   */
  declaredTreatment?: "source-text";
};

export type AttachmentClassification =
  | {
      decision: "accept";
      kind: "text" | "audio" | "image" | "document";
      normalizedMime: string;
      warnings: string[];
    }
  | {
      decision: "stub";
      kind: "image" | "document" | "unsupported";
      reason: string;
      normalizedMime?: string;
    }
  | {
      decision: "reject";
      reason: string;
      code: string;
      normalizedMime?: string;
    };

export type AttachmentBatchClassification = {
  envelope: AttachmentEnvelope;
  classification: AttachmentClassification;
};
