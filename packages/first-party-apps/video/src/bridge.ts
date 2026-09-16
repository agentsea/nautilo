import type { GeneratedTakeArtifact, GeneratedTakeSettings } from "./generation-takes";
import type { GeneratedTakeRevalidation } from "./commands";

export type NautiloDocumentEnvelope = {
  content: string;
  mimeType?: string;
  path?: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type NautiloAuthoredChange =
  | { kind: "none" }
  | { kind: "unavailable"; code: string }
  | { kind: "ready"; operationId: string; author: { kind: "agent"; displayName: string };
      before: { content: string; sha256: string }; after: { content: string; sha256: string }; currentSha256: string };

export type NautiloDocumentWriteResult = {
  kind: "saved" | "conflict";
  sha256?: string;
  revision?: number | null;
  persistedContent?: string;
  path?: string;
  currentSha256?: string | null;
};

export type NautiloDocumentChangedEvent = {
  type: "changed";
  path?: string;
  reloadRequired?: boolean;
  envelope?: NautiloDocumentEnvelope;
};

export type NautiloDocumentRenamedEvent = {
  type: "renamed";
  path?: string;
};

export type NautiloDocumentDeletedEvent = {
  type: "deleted";
  path?: string;
};

export type NautiloDocumentPatchAppliedEvent = {
  type: "patch_applied";
  path?: string;
  patchId?: string;
  author?: { kind: "human" | "agent" | "app_tool"; displayName: string };
  rebased?: boolean;
  revision: number | null;
  sha256: string;
  previousRevision: number | null;
  previousSha256: string;
  envelope: NautiloDocumentEnvelope;
};

export type NautiloDocumentChangeEvent =
  | NautiloDocumentChangedEvent
  | NautiloDocumentRenamedEvent
  | NautiloDocumentDeletedEvent
  | NautiloDocumentPatchAppliedEvent;

/**
 * A host-issued media reference.  It is deliberately opaque to the iframe:
 * callers may persist it as a project-relative ref, but they never receive a
 * native path, bytes, File, or arbitrary URL for the original source.
 */
type NautiloMediaImportReadyBase = {
  kind: "ready";
  mediaRef: string;
  label: string;
  /** Only Desktop Workspace import returns durable public artifact lineage. */
  source?: Readonly<{ kind: "workspace-artifact"; artifactId: string; path: string }>;
};

export type NautiloVideoImportReady = NautiloMediaImportReadyBase & (
  | { /** Legacy hosts omit this and are interpreted as video. */ mediaKind?: "video"; durationSec: number; frameRate: { numerator: number; denominator: number } }
  | { mediaKind: "audio"; durationSec: number; frameRate?: never }
  | { mediaKind: "image"; durationSec?: never; frameRate?: never }
);

export type NautiloMediaUnavailable = {
  kind: "unavailable";
  code: string;
};

/**
 * A closed request union for a host-owned video preview. Current Folder media
 * is resolved by its project-relative ref. Durable Workspace media is resolved
 * only by the opaque project media id, so the iframe never sends an artifact
 * id or logical Workspace path back as authority.
 */
export type NautiloVideoPreviewRequest =
  | { ref: string; mediaId?: never; referenceId?: never }
  | { mediaId: string; ref?: never; referenceId?: never }
  | { referenceId: string; ref?: never; mediaId?: never };

/** A bounded host preview such as a proxy or range-capable local endpoint. */
export type NautiloVideoPreviewReady = {
  kind: "ready";
  url: string;
  mimeType: "video/mp4" | "audio/mp4" | "audio/wav" | "audio/mpeg" | "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  revokeToken: string;
  waveform?: { peaks: number[]; samplesPerSecond: number };
};
export type NautiloVideoExportProgress = Readonly<{ stage: "preparing" | "rendering" | "saving" | "publishing"; processedTimeUs?: number }>;
export type NautiloVideoExportWorkspace = Readonly<{
  status: "published" | "not_published" | "unknown";
  path: string;
  artifactId?: string;
}>;
export type NautiloVideoExportResult =
  | Readonly<{ kind: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[]; workspace?: NautiloVideoExportWorkspace }>
  | Readonly<{ kind: "cancelled" }>
  | NautiloMediaUnavailable;

/**
 * Text-only handoff into the parent-owned quote and
 * approval flow. The reviewed compiler prompt is ephemeral here and is never
 * persisted; no file reference, URL, receipt, token, or project state crosses
 * beyond the already-saved document binding.
 */
export type NautiloVideoGenerationRequest = Readonly<{
  document: Readonly<{ sha256: string; revision: number | null }>;
  sourceFingerprint: string;
  job: Readonly<{
    source: Readonly<{ kind: "quick-brief" }> | Readonly<{ kind: "shot"; shotId: string }>;
    shotLabel?: string;
    modelId: "venice:seedance-2-5-text-to-video-basic" | "venice:seedance-2-5-reference-to-video-basic" | "venice:minimax-h3-enhanced-text-to-video";
    continuationTakeId?: string;
    /** Compiler-produced text only; the parent revalidates before D525 use. */
    prompt: string;
    requestedSettings?: Readonly<{
      durationSeconds?: number;
      aspectRatio?: string;
      resolution?: string;
      audio?: boolean;
    }>;
  }>;
}>;

/** The iframe reflects a parent flow; it never receives approval authority. */
export type NautiloVideoGenerationRequestResult =
  | Readonly<{ kind: "queued"; takeId?: string }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "submission-unknown"; takeId: string }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "unavailable"; code: string }>;

/**
 * Closed reference-import result. The logical Workspace path and public
 * artifact identity are lineage only; they never authorize byte reads or a
 * provider request from the iframe.
 */
export type NautiloVideoGenerationReferencesImportResult =
  | Readonly<{ kind: "ready"; assets: readonly Extract<NautiloVideoGenerationReferenceImportResult, { kind: "ready" }>["asset"][]; failures: readonly Readonly<{ label: string; code: string }>[] }>
  | Readonly<{ kind: "unavailable"; code: string }>;

export type NautiloVideoGenerationReferenceImportResult =
  | Readonly<{
      kind: "ready";
      asset: Readonly<{
        artifactId: string;
        path: string;
        label: string;
        mediaKind: "image" | "video" | "audio";
        mimeType: string;
        sizeBytes: number;
      }>;
    }>
  | NautiloMediaUnavailable;

/** A safe, project-scoped index entry. It is not a job, receipt, or artifact capability. */
export type NautiloVideoGenerationTakeSummary = Readonly<{
  takeId: string;
  shotId: string;
  shotLabel: string;
  documentRevision: number;
}>;

/** Display-only progress and recovery context. No action handle crosses into the iframe. */
export type NautiloVideoGenerationTakeStatus = Readonly<{
  takeId: string;
  revision: number;
  mediaKind: "video" | "audio";
  state: "preparing" | "queued" | "submitting" | "generating" | "downloading" | "saving" | "ready" | "needs-action" | "failed" | "unknown" | "cleanup-pending";
  modelId: string;
  settings: GeneratedTakeSettings;
  progress?: Readonly<{ phase: string; elapsedSeconds?: number; estimatedSeconds?: number; message?: string }>;
  artifact?: GeneratedTakeArtifact;
  failure?: Readonly<{ code: string; message: string; creditsRefunded?: boolean }>;
  recoveryActions?: readonly unknown[];
}>;

export type NautiloVideoGenerationTakeListResult =
  | Readonly<{ kind: "ready"; takes: readonly NautiloVideoGenerationTakeSummary[] }>
  | NautiloMediaUnavailable;

export type NautiloVideoGenerationTakeStatusResult =
  | Readonly<{ kind: "ready"; status: NautiloVideoGenerationTakeStatus }>
  | NautiloMediaUnavailable;

export type NautiloVideoGenerationTakePreviewResult =
  | Readonly<{ kind: "opened" }>
  | NautiloMediaUnavailable;

export type NautiloVideoGenerationTakeRevalidationResult =
  | GeneratedTakeRevalidation
  | NautiloMediaUnavailable;

export interface NautiloAppBridge {
  session?: {
    onCommand(handler: (command: unknown, version: { kind: "artifact_revision"; revision: number } | { kind: "local_sha"; sha256: string }) => unknown): () => void;
  };
  preferences?: {
    get<T = unknown>(key: "video.agentReceipts" | "video.firstSourceRate"): Promise<T>;
    set<T = unknown>(key: "video.agentReceipts" | "video.firstSourceRate", value: T): Promise<T>;
    subscribe<T = unknown>(key: "video.agentReceipts" | "video.firstSourceRate", handler: (value: T) => void): () => void;
  };
  document: {
    read(): Promise<NautiloDocumentEnvelope>;
    authoredChange?(): Promise<NautiloAuthoredChange>;
    write(
      next: string | { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<NautiloDocumentWriteResult>;
    onChange?(handler: (event: NautiloDocumentChangeEvent) => void): () => void;
};

  context: {
    set(summary: Record<string, unknown>): void;
  };
  /** Optional first-party Video-only request; the parent owns Genie rail state. */
  hostLayout?: {
    setFullWidth(input: Readonly<{ enabled: boolean }>): Promise<void> | void;
  };
  asset?: {
    read(
      input: { ref: string },
      options?: { signal?: AbortSignal },
    ): Promise<
      | { kind: "ready"; mimeType: "image/png" | "image/jpeg" | "image/webp"; sizeBytes: number; bytes: Uint8Array }
      | { kind: "unavailable"; code: string }
    >;
  };
  /**
   * First-party, host-owned video transport. This mirror is intentionally
   * optional: a Video package build must stay honest in web, Workspace, and
   * older Desktop hosts where D385 has not granted the capability.
   */
  media?: {
    getExportCapabilities?(): Promise<{ workspace: boolean }>;
    importVideo(): Promise<NautiloVideoImportReady | NautiloMediaUnavailable>;
    openPreview(
      input: NautiloVideoPreviewRequest,
      options?: { signal?: AbortSignal },
    ): Promise<NautiloVideoPreviewReady | NautiloMediaUnavailable>;
    closePreview(revokeToken: string): Promise<void> | void;
    exportVideo(
      input: Readonly<{ document: Readonly<{ sha256: string; revision: number | null }>; publishToWorkspace?: boolean; exportSettings?: import("@nautilo/types").VideoExportSettings }>,
      options?: Readonly<{ signal?: AbortSignal; onProgress?: (progress: NautiloVideoExportProgress) => void }>,
    ): Promise<NautiloVideoExportResult>;
    saveWorkspaceCopy?(
      input: Readonly<{ sha256: string }>,
      options?: Readonly<{ signal?: AbortSignal; onProgress?: (progress: { stage: string; completed?: number; total?: number }) => void }>,
    ): Promise<
      | { kind: "succeeded"; path: string; roomLabel: string; mediaCount: number }
      | { kind: "cancelled" | "unknown" | "unavailable"; code?: string; retainedPaths: string[] }
    >;
    getWorkspaceCopyCapabilities?(): Promise<{ available: boolean; roomLabel?: string }>;
    openWorkspaceCopy?(): Promise<{ opened: boolean; code?: string }>;
  };
  /** Optional until the host has granted the D525 coordinator capability. */
  videoGeneration?: {
    request(input: NautiloVideoGenerationRequest): Promise<NautiloVideoGenerationRequestResult>;
    /** Optional host-owned picker/import. Older hosts remain visibly unavailable. */
    importReferences?(input: Readonly<{ mediaKind: "image" }>): Promise<NautiloVideoGenerationReferencesImportResult>;
    importReference?(input: Readonly<{ mediaKind: "image" | "video" | "audio" }>): Promise<NautiloVideoGenerationReferenceImportResult>;
    /** Parent-only list/status/readiness flow; none of these return media bytes or URLs. */
    listTakes(): Promise<NautiloVideoGenerationTakeListResult>;
    getTakeStatus(input: { takeId: string }): Promise<NautiloVideoGenerationTakeStatusResult>;
    previewTake(input: { takeId: string }): Promise<NautiloVideoGenerationTakePreviewResult>;
    revalidateTake(input: { takeId: string }): Promise<NautiloVideoGenerationTakeRevalidationResult>;
  };
}

export function isSafeVideoGenerationRequestPrompt(value: unknown): value is string {
  // The chosen model's canonical request schema owns prompt limits. A bridge
  // byte quota would reject valid non-ASCII prompts before that validation.
  return typeof value === "string" && value.trim().length > 0;
}

declare global {
  interface Window {
    nautiloApp?: NautiloAppBridge;
  }
}

export function getNautiloApp(): NautiloAppBridge | null {
  return window.nautiloApp ?? null;
}

export function isNoDocumentError(err: unknown): boolean {
  return err instanceof Error && /no document is bound/i.test(err.message);
}

export function isReloadRequiredDocumentChange(
  event: NautiloDocumentChangeEvent,
): event is NautiloDocumentChangedEvent {
  return event.type === "changed" && event.reloadRequired === true;
}

export function isDocumentPatchAppliedEvent(
  event: NautiloDocumentChangeEvent,
): event is NautiloDocumentPatchAppliedEvent {
  return event.type === "patch_applied";
}
