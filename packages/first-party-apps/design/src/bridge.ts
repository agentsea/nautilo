import type { DesignImageAsset } from "./image-assets";
/**
 * Typed wrapper around the host-injected `window.nautiloApp` bridge for the
 * Nautilo Design mini-app. The host
 * (apps/workbench app-bridge.ts + app-bridge-client.ts) injects the real
 * bridge into the sandboxed iframe; this module only declares the contract,
 * exposes `getNautiloApp()`, and provides narrowing helpers.
 *
 * The bridge messages are source-checked (`event.source === window.parent`)
 * inside the injected client — this wrapper never re-implements postMessage.
 */

export type NautiloDocumentEnvelope = {
  content: string;
  mimeType?: string;
  path?: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type NautiloDocumentWriteResult = {
  kind: "saved" | "conflict";
  sha256?: string;
  revision?: number | null;
  persistedContent?: string;
  path?: string;
  currentSha256?: string | null;
};

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
  envelope: {
    content: string;
    mimeType?: string;
    path?: string;
    baseSha256: string;
    baseRevision: number | null;
  };
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

export interface NautiloAppBridge {
  assets?: { pick(): Promise<DesignImageAsset | null>; read(ref: string): Promise<DesignImageAsset> };
  document: {
    read(): Promise<NautiloDocumentEnvelope>;
    write(
      next: string | { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<NautiloDocumentWriteResult>;
    saveCopy?(next: string | { content: string }): Promise<{ path: string }>;
    onChange?(handler: (event: NautiloDocumentChangeEvent) => void): () => void;
  };
  context: {
    set(summary: Record<string, unknown>): void;
  };
  humanEdit?: {
    set(update: { state: "clean" | "dirty" | "saving" | "conflict" }): void;
  };
  lifecycle?: {
    onPrepareClose(handler: (request: {
      reason: "close" | "replace" | "navigate" | "suspend" | "quit";
      action: "prepare-close" | "save-copy";
    }) => Promise<{
      noLocalChanges?: boolean;
      documentSaved: boolean;
      recoveryPersisted: boolean;
      recoverableDraftExact: boolean;
      errorMessage?: string | null;
    }> | {
      noLocalChanges?: boolean;
      documentSaved: boolean;
      recoveryPersisted: boolean;
      recoverableDraftExact: boolean;
      errorMessage?: string | null;
    }): () => void;
  };
  preferences?: {
    get<T = unknown>(key: "design.agentReceipts"): Promise<T>;
    set<T = unknown>(key: "design.agentReceipts", value: T): Promise<T>;
    subscribe<T = unknown>(key: "design.agentReceipts", handler: (value: T) => void): () => void;
  };
  /**
   * Host-owned presentation state. It is optional because older bridge mocks
   * and unbound documents do not expose it; callers must fall back locally.
   */
  state?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
}

declare global {
  interface Window {
    nautiloApp?: NautiloAppBridge;
  }
}

export function getNautiloApp(): NautiloAppBridge | null {
  if (typeof window === "undefined") return null;
  return window.nautiloApp ?? null;
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

/**
 * Coerce an unknown host response into a `NautiloDocumentEnvelope`, or null
 * when the shape is unexpected.
 */
export function parseDocumentEnvelope(value: unknown): NautiloDocumentEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["content"] !== "string") return null;
  return {
    content: record["content"],
    ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
    ...(typeof record["mimeType"] === "string" ? { mimeType: record["mimeType"] } : {}),
    baseSha256: typeof record["baseSha256"] === "string" ? record["baseSha256"] : null,
    baseRevision:
      typeof record["baseRevision"] === "number" ? record["baseRevision"] : null,
  };
}
