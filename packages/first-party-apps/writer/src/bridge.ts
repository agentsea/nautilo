import type { LiveDocumentVersion } from "@nautilo/types";
import type { ProposalOperation } from "./proposal-contract";

export type NautiloDocumentEnvelope = {
  content: string;
  mimeType?: string;
  path?: string;
  baseSha256: string | null;
  /** M193 artifact revision; null for Current Folder local documents. */
  baseRevision: number | null;
};

export type NautiloDocumentWriteResult =
  | {
      kind: "saved";
      sha256?: string;
      revision?: number | null;
      persistedContent?: string;
      path?: string;
    }
  | { kind: "conflict"; currentSha256?: string | null }
  | { kind: "error"; message: string };

export type NautiloAnchoredTextPatch = {
  kind: "anchored_text";
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  scope?: { from: number; to: number };
};

export type NautiloDocumentPatchAuthor = {
  kind: "human" | "agent" | "app_tool";
  displayName: string;
};

export type NautiloDocumentPatchAppliedEvent = {
  type: "patch_applied";
  path?: string;
  patchId: string;
  revision: number | null;
  sha256: string;
  previousRevision: number | null;
  previousSha256: string;
  patch: NautiloAnchoredTextPatch;
  author?: NautiloDocumentPatchAuthor;
  rebased?: boolean;
  envelope: NautiloDocumentEnvelope;
};

export type NautiloDocumentChangedEvent = {
  type: "changed";
  path?: string;
  reloadRequired?: boolean;
};

export type NautiloDocumentRenamedEvent = {
  type: "renamed";
  path?: string;
};

export type NautiloDocumentDeletedEvent = {
  type: "deleted";
  path?: string;
};

export type NautiloDocumentChangeEvent =
  | NautiloDocumentPatchAppliedEvent
  | NautiloDocumentChangedEvent
  | NautiloDocumentRenamedEvent
  | NautiloDocumentDeletedEvent;

export type NautiloLiveSessionCapability = {
  sessionToken: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
};

export type NautiloWriterProposal = {
  proposalId: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
  operations: ProposalOperation[];
};

export type NautiloAcceptProposalRequest = {
  requestId: string;
  proposalId: string;
  documentVersion: LiveDocumentVersion;
  acceptedOperationIndexes: number[];
  acceptedContent: string;
};

export type NautiloAcceptProposalResult =
  | {
      ok: true;
      documentVersion: LiveDocumentVersion;
      contentSha256: string;
      localRevisionRef?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type NautiloLiveSessionClosedEvent = {
  sessionId: string;
  reason: "relay_disconnected" | "session_closed";
};

export type WriterSpellPreference = {
  enabled: boolean;
  language: "en-US";
  personalWords: string[];
};

export interface NautiloAppBridge {
  document: {
    read(): Promise<NautiloDocumentEnvelope>;
    write(
      next: string | { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<NautiloDocumentWriteResult>;
    onChange?(
      handler: (event: NautiloDocumentChangeEvent) => void,
    ): () => void;
  };

  context: {
    set(summary: Record<string, unknown>): void;
  };
  humanEdit?: {
    set(update: {
      state: "clean" | "dirty" | "saving" | "conflict";
      draftPatch?: NautiloAnchoredTextPatch;
    }): void;
  };
  preferences?: {
    get<T = WriterSpellPreference>(key: "writer.spellcheck"): Promise<T>;
    set<T = WriterSpellPreference>(key: "writer.spellcheck", value: T): Promise<T>;
    subscribe<T = WriterSpellPreference>(key: "writer.spellcheck", handler: (value: T) => void): () => void;
  };
  session?: {
    onChange(handler: (capability: NautiloLiveSessionCapability) => void): () => void;
    /** Parent-origin messages are source-validated by the host bridge client. */
    onProposal(handler: (proposal: NautiloWriterProposal) => void): () => void;
    /** Proposal delivery remains retryable until Writer has entered visible review. */
    acknowledgeProposal(input: {
      proposalId: string;
      documentVersion: LiveDocumentVersion;
    }): void;
    onClosed(handler: (event: NautiloLiveSessionClosedEvent) => void): () => void;
    acceptProposal(request: NautiloAcceptProposalRequest): Promise<NautiloAcceptProposalResult>;
    resolveProposal(request: {
      proposalId: string;
      documentVersion: LiveDocumentVersion;
      outcome: "accepted" | "rejected";
    }): Promise<{ ok: true; taskStatus: string }>;
    invalidateProposal(request: {
      /** Captured proposal capability; may differ from a refreshed live session. */
      proposalSessionToken: string;
      proposalId: string;
      documentVersion: LiveDocumentVersion;
      reason: "human_changed" | "stale_version" | "remote_changed" | "session_closed" | "no_effective_change";
    }): Promise<{ ok: true; taskStatus: string }>;
  };
}

declare global {
  interface Window {
    nautiloApp?: NautiloAppBridge;
  }
}

export function getNautiloApp(): NautiloAppBridge | null {
  if (typeof globalThis !== "object" || globalThis === null) return null;
  const browserWindow = (globalThis as { window?: Window }).window;
  return browserWindow?.nautiloApp ?? null;
}

export function isNoDocumentError(err: unknown): boolean {
  return err instanceof Error && /no document is bound/i.test(err.message);
}

export function isPatchAppliedDocumentChange(
  event: NautiloDocumentChangeEvent,
): event is NautiloDocumentPatchAppliedEvent {
  return event.type === "patch_applied";
}

export function isReloadRequiredDocumentChange(
  event: NautiloDocumentChangeEvent,
): event is NautiloDocumentChangedEvent {
  return event.type === "changed" && event.reloadRequired === true;
}
