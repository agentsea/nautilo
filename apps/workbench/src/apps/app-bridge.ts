import type { AppImageAsset } from "./app-image-assets";
import type { AppSlideTemplateLibrary } from "./app-slide-templates";
import { downloadDocumentCopy } from "./document-recovery-copy";
import { isAppRecoveryDraft, type AppDraftRecoveryPort, type AppRecoveryWrite } from "./app-draft-recovery";
/**
 * M185 — parent-side postMessage bridge for sandboxed mini-app iframes.
 *
 * Mirrors `viewers/html/state-bridge.ts` invariants:
 *   1. `event.source === iframe.contentWindow` — NOT origin equality.
 *   2. Host-owned top-level envelope keys are rejected from iframe messages.
 *   3. Strict message-shape validation.
 */

import { DocumentPatchConflictError } from "@nautilo/api-client/browser";
import { parseVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import {
  applyAnchoredTextPatch,
  anchoredTextPatchSchema,
  deriveAnchoredTextPatch,
  type AnchoredTextPatch,
  type DocumentPatchAuthor,
  type DocumentPatchEvent,
} from "@nautilo/types";
import type {
  ApplyAcceptedLiveProposalResponse,
  LiveDocumentVersion,
} from "@nautilo/types";
import {
  liveDocumentVersionEquals,
  parseLiveDocumentVersion,
} from "@nautilo/types";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { saveEditableText, sha256HexForText } from "../editors/editor-io";
import { registerLocalFsSaveSha } from "../editors/local-fs-save-shas";
import { apiClient } from "../lib/api";
import * as desktop from "../lib/desktop";
import {
  DESIGN_RECEIPTS_PREFERENCE_KEY,
  getAppPreference,
  setAppPreference,
  subscribeAppPreferences,
  validateAppPreference,
  VIDEO_RECEIPTS_PREFERENCE_KEY,
  VIDEO_FRAME_RATE_PREFERENCE_KEY,
  WRITER_SPELL_PREFERENCE_KEY,
  type AppPreferenceKey,
  type AppPreferenceValue,
} from "../lib/app-preferences";
import { loadBinaryPreview } from "../lib/binary-preview-source";
import {
  fsBoundDisplayPath,
} from "./live-app-session-target";
import {
  failPendingAcceptMutation,
  markPendingAcceptMutationSucceeded,
  registerPendingAcceptMutation,
} from "./local-fs-accept-mutations";
import type { LiveAppSessionClosedReason } from "./live-app-session-close-bus";
/**
 * Cap for reading a mini-app's BOUND DOCUMENT through the bridge. Distinct from
 * the reader-preview cap (`MAX_TEXT_PREVIEW_BYTES`, 200 KB): office/Writer
 * documents embed inline base64 images and can be far larger, so the document
 * bridge is sized to the officecli `.docx` ceiling and kept in lock-step with
 * the Writer container cap + the server artifact save/patch cap. Previews are
 * unaffected — they keep the small preview cap.
 */
const MAX_APP_DOCUMENT_BYTES = 50 * 1024 * 1024;
import {
  registerLocalArtifactSaveMutation,
  settleLocalArtifactSaveMutation,
} from "../editors/local-artifact-save-mutations";

type ArtifactTarget = Extract<OpenFileTarget, { kind: "artifact" }>;

/** Resolved host presentation mode passed into sandboxed mini-apps. */
export type AppTheme = "light" | "dark";

/**
 * D342 Phase 2 — "warm-up" draft seed for a freshly-launched app with no bound
 * document. The app runs against an in-memory blank (seeded from a create-action
 * template) and NO workspace artifact is created until the first persistence
 * (document write or state set). If the user never edits, nothing is saved — no
 * Untitled clutter. `suggestedName` is the path the artifact materializes under
 * (deduped at create time); the surface lets the user rename it before/after.
 */
export type MiniAppDraftSeed = {
  appId: string;
  /** Create-action whose template seeds the blank doc; null → empty content. */
  createActionId: string | null;
  /** Initial filename for the materialized artifact (e.g. "Untitled spreadsheet.html"). */
  suggestedName: string;
  roomId?: string;
};

export type AppDocumentEnvelope = {
  content: string;
  mimeType: string;
  path: string;
  baseSha256: string | null;
  baseRevision: number | null;
  localIdentity?: {
    kind: "local_file";
    relayId: string;
    canonicalPath: string;
  };
};

/** Read-only projection of retained canonical history, never an iframe-supplied inverse. */
export type AppAuthoredChange =
  | { kind: "none" }
  | { kind: "unavailable"; code: string }
  | { kind: "ready"; operationId: string; author: { kind: "agent"; displayName: string };
      before: { content: string; sha256: string }; after: { content: string; sha256: string }; currentSha256: string };

export async function validateAuthoredChange(value: unknown, currentSha256: string): Promise<AppAuthoredChange> {
  const invalid: AppAuthoredChange = { kind: "unavailable", code: "history_unavailable" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const row = value as Record<string, unknown>;
  if (row["kind"] === "none" && Object.keys(row).length === 1) return { kind: "none" };
  if (row["kind"] === "unavailable") return invalid;
  if (row["kind"] !== "ready" || Object.keys(row).some((key) => !["kind", "operationId", "author", "before", "after", "currentSha256"].includes(key)) ||
      typeof row["operationId"] !== "string" || !row["operationId"] || row["currentSha256"] !== currentSha256) return invalid;
  const author = row["author"] as Record<string, unknown> | null;
  if (!author || Array.isArray(author) || Object.getPrototypeOf(author) !== Object.prototype || author["kind"] !== "agent" || typeof author["displayName"] !== "string" ||
      Object.keys(author).some((key) => key !== "kind" && key !== "displayName")) return invalid;
  const snapshots: Array<{ content: string; sha256: string }> = [];
  for (const key of ["before", "after"]) {
    const snapshot = row[key] as Record<string, unknown> | null;
    if (!snapshot || Array.isArray(snapshot) || Object.getPrototypeOf(snapshot) !== Object.prototype || typeof snapshot["content"] !== "string" || typeof snapshot["sha256"] !== "string" ||
        Object.keys(snapshot).some((field) => field !== "content" && field !== "sha256") ||
        new TextEncoder().encode(snapshot["content"]).length > MAX_APP_DOCUMENT_BYTES ||
        await sha256HexForText(snapshot["content"]) !== snapshot["sha256"]) return invalid;
    snapshots.push({ content: snapshot["content"], sha256: snapshot["sha256"] });
  }
  return { kind: "ready", operationId: row["operationId"], author: { kind: "agent", displayName: "Genie" },
    before: snapshots[0], after: snapshots[1], currentSha256 };
}

export type AppDocumentStat = {
  kind: "artifact" | "fs";
  path: string;
  mimeType: string | null;
  sha256: string | null;
  revision: number | null;
  size: number | null;
};

export type AppDocumentPatchAppliedEvent = {
  type: "patch_applied";
  path?: string;
  patchId: string;
  revision: number | null;
  sha256: string;
  previousRevision: number | null;
  previousSha256: string;
  patch: AnchoredTextPatch;
  author?: DocumentPatchAuthor;
  rebased?: boolean;
  envelope: {
    content: string;
    mimeType: string;
    path: string;
    baseSha256: string;
    baseRevision: number | null;
  };
};

/**
 * Both legacy patch projections and durable editor-save commits carry these
 * exact fields. Durable events do not invent a display name for their actor,
 * so `author` remains optional at this UI boundary.
 */
export type ExternalDocumentPatchEvent = Pick<
  DocumentPatchEvent,
  "patchId" | "sha256" | "previousSha256" | "patch" | "rebased"
> & {
  readonly revision: number | null;
  readonly previousRevision: number | null;
  readonly author?: DocumentPatchAuthor;
};

export type AppDocumentChangedEvent =
  | { type: "changed"; path?: string; reloadRequired?: boolean }
  | { type: "renamed"; path?: string }
  | { type: "deleted" }
  | { type: "reconnected" }
  | AppDocumentPatchAppliedEvent;

export type AppLiveSessionCapability = {
  sessionToken: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
};

export type AppLiveProposal = {
  proposalId: string;
  appId: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
  operations: unknown[];
};

export type AppLiveSessionClosedMessage = {
  sessionId: string;
  reason: LiveAppSessionClosedReason;
};

export type AppContextSummary = {
  title?: string;
  description?: string;
  documentPath?: string;
  selection?: unknown;
  summary?: unknown;
};

export type AppHumanEditUpdate = {
  state: "clean" | "dirty" | "saving" | "conflict";
  draftPatch?: AnchoredTextPatch;
};

export type ActiveMiniAppContext = {
  appId: string;
  target?: OpenFileTarget;
  summary: AppContextSummary;
  updatedAt: number;
};

export type AppBridgeOptions = {
  iframe: HTMLIFrameElement;
  appId: string;
  /** Host-owned authority; preview frames may only read their bound document. */
  mode?: "edit" | "preview";
  assets?: { pick(): Promise<AppImageAsset | null>; read(ref: string): Promise<AppImageAsset> };
  viewerKey?: string | null;
  recovery?: AppDraftRecoveryPort;
  templates?: AppSlideTemplateLibrary;
  target?: OpenFileTarget;
  onContextUpdate?: (context: ActiveMiniAppContext) => void;
  /** Targetless draft truth. The surface binds it to its host-owned target. */
  onHumanEditUpdate?: (update: AppHumanEditUpdate) => void;
  /** Reports whether this exact frame installed an awaited close handler. */
  onLifecycleRegistrationChange?: (registered: boolean) => void;
  /** D342 Phase 2 — when `target` is absent, the app runs against this draft
   *  (template seed for read/stat). The first write/state-set triggers
   *  `materialize`. */
  draft?: MiniAppDraftSeed;
  /** D342 Phase 2 — create the workspace artifact this draft has been deferring
   *  and return the bound target. Owned by the surface (it knows the live,
   *  user-typed name). Called at most once per draft (single-flight here). */
  materialize?: (content: string, mimeType: string) => Promise<ArtifactTarget>;
  /** User-invoked recovery copy; never overwrites the bound document. */
  saveCopy?: (content: string) => Promise<{ path: string }>;
  /** Shared host document session for patch writes and inbound patch delivery. */
  documentSession?: AppDocumentWriteSession;
  /** Host-owned version observation used to refresh a live capability. */
  onDocumentVersion?: (documentVersion: LiveDocumentVersion) => void | Promise<void>;
  /** Current Folder live-review acceptance uses host-injected session authority. */
  getLiveSession?: () => {
    sessionToken: string;
    sessionId: string;
    documentVersion: LiveDocumentVersion;
  } | null;
  onLiveProposalAccepted?: (result: ApplyAcceptedLiveProposalResponse) => void;
  /** UI-only acknowledgement: this exact proposal is visibly reviewable. */
  onLiveProposalAcknowledged?: (input: {
    proposalId: string;
    documentVersion: LiveDocumentVersion;
  }) => void;
  /** Trusted server-issued grant, never derived from app id or manifest. */
  assetReadRaster?: true;
  /** Trusted server-issued Desktop-local bounded proxy grant. */
  mediaProxy?: true;
  /** Trusted server-issued grant for the parent-mediated Video review flow. */
  videoGeneration?: true;
  /** Parent-only durable Workspace transport for the exact Video project. */
  onVideoWorkspaceMediaOpenPreview?: (input: ({ mediaId: string } | { referenceId: string }) & { signal: AbortSignal }) => Promise<
    | { kind: "ready"; url: string; blob?: Blob; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } }
    | { kind: "unavailable"; code: string }
  > | { kind: "ready"; url: string; blob?: Blob; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } | { kind: "unavailable"; code: string };
  onVideoWorkspaceMediaClosePreview?: (input: { revokeToken: string }) => Promise<void> | void;
  /** Parent-only native pick + Workspace artifact admission for bound Video. */
  onVideoWorkspaceMediaImport?: () => Promise<VideoWorkspaceMediaImportBridgeResult> | VideoWorkspaceMediaImportBridgeResult;
  onVideoMediaPick?: (input: VideoMediaPickInput) => Promise<VideoMediaPickResult>;
  /** Parent owns the canonical project and all Workspace source resolution. */
  onVideoWorkspaceMediaExport?: (input: VideoWorkspaceMediaExportInput) => Promise<VideoWorkspaceMediaExportResult>;
  onVideoProjectPromotion?: (input: { requestId: string; sha256: string; signal: AbortSignal; onProgress: (progress: unknown) => void }) => Promise<unknown>;
  onOpenPromotedVideoProject?: () => Promise<{ opened: boolean; code?: string }> | { opened: boolean; code?: string };
  workspaceCopyRoomLabel?: string;
  /** Exact first-party Video request for the host-owned Genie rail only. */
  onVideoHostLayout?: (input: { enabled: boolean }) => Promise<void> | void;
  /**
   * The iframe can request review, but this parent-only callback owns the
   * attestation, project binding and API call. It must never return a receipt,
   * provider identifier, review handle, or artifact transport to the iframe.
   */
  onVideoGenerationRequest?: (
    request: VideoGenerationBridgeRequest,
  ) => Promise<VideoGenerationBridgeResult> | VideoGenerationBridgeResult;
  /** Parent-only status and promotion hooks for the exact attested Video project. */
  onVideoGenerationListTakes?: () => Promise<VideoGenerationTakeListBridgeResult> | VideoGenerationTakeListBridgeResult;
  onVideoGenerationGetTakeStatus?: (input: { takeId: string }) => Promise<VideoGenerationTakeStatusBridgeResult> | VideoGenerationTakeStatusBridgeResult;
  /** Opens host UI only; its result carries no transport authority. */
  onVideoGenerationPreviewTake?: (input: { takeId: string }) => Promise<VideoGenerationPreviewBridgeResult> | VideoGenerationPreviewBridgeResult;
  /** Fresh parent-owned artifact revalidation for explicit canonical promotion. */
  onVideoGenerationRevalidateTake?: (input: { takeId: string }) => Promise<VideoGenerationRevalidationBridgeResult> | VideoGenerationRevalidationBridgeResult;
  /** Parent-owned native picker and Workspace admission for one Video reference. */
  onVideoGenerationImportReferences?: (input: { mediaKind: "image" }) => Promise<VideoGenerationReferencesImportBridgeResult> | VideoGenerationReferencesImportBridgeResult;
  onVideoGenerationImportReference?: (input: { mediaKind: "image" | "video" | "audio" }) => Promise<VideoGenerationReferenceImportBridgeResult> | VideoGenerationReferenceImportBridgeResult;
};

export type VideoWorkspaceMediaExportInput = {
  exportSettings?: import("@nautilo/types").VideoExportSettings;
  requestId: string;
  sha256: string;
  revision: number | null;
  publishToWorkspace: boolean;
  signal: AbortSignal;
  onProgress: (progress: unknown) => void;
};
export type VideoWorkspaceMediaExportResult =
  | { kind: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[]; workspace?: { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string } }
  | { kind: "cancelled" }
  | { kind: "unavailable"; code: string };

export type AppDocumentWriteResult =
  | {
      kind: "saved";
      sha256: string;
      revision?: number | null;
      persistedContent?: string;
      size?: number;
      path?: string;
    }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

/** Host-owned document session for patch writes and initial read coalescing. */
export type AppDocumentWriteSession = {
  envelope: AppDocumentEnvelope | null;
  documentTargetKey?: string;
  documentReadGeneration?: number;
  documentReadPromise?: Promise<AppDocumentEnvelope>;
};

export type WriteBoundDocumentOpts = {
  baseSha256?: string | null;
  baseRevision?: number | null;
  session?: AppDocumentWriteSession;
  /** Allow full-snapshot save only for empty-base / first materialization paths. */
  allowSnapshotFallback?: boolean;
  /** Structured editors can require exact CAS rather than anchored-text rebasing. */
  conflictPolicy?: "strict";
};

const STATE_KEY_MAX_LEN = 128;

const CONTEXT_STRING_LIMITS = {
  title: 256,
  description: 2_000,
  documentPath: 512,
} satisfies Record<"title" | "description" | "documentPath", number>;

const CONTEXT_JSON_FIELD_LIMIT = 10_000;

const HOST_OWNED_TOP_LEVEL_KEYS = [
  "appId",
  "artifactId",
  "artifact_id",
  "id",
  "path",
  "rootPath",
  "roomId",
  "namespaceId",
  "sessionToken",
] as const;

type AppAssetRequest = { type: "nautilo.app.assets.req"; requestId: string; op: "pick" } | { type: "nautilo.app.assets.req"; requestId: string; op: "read"; ref: string };

type AppDocumentReadRequest = {
  type: "nautilo.app.document.req";
  requestId: string;
  op: "read" | "stat" | "authoredChange";
  fresh?: boolean;
};

type AppDocumentWriteRequest = {
  type: "nautilo.app.document.req";
  requestId: string;
  op: "write" | "downloadCopy";
  conflictPolicy?: "strict";
  value: unknown;
  baseSha256?: string | null;
  baseRevision?: number | null;
};

type AppDocumentSaveCopyRequest = {
  type: "nautilo.app.document.req";
  requestId: string;
  op: "saveCopy";
  value: unknown;
};

type AppStateGetRequest = {
  type: "nautilo.app.state.req";
  requestId: string;
  op: "get";
  key: string;
};
type AppRecoveryRequest =
  | { type: "nautilo.app.recovery.req"; requestId: string; op: "read" }
  | { type: "nautilo.app.recovery.req"; requestId: string; op: "write"; input: AppRecoveryWrite };

type AppTemplateRequest =
  | { type: "nautilo.app.templates.req"; requestId: string; op: "list" }
  | { type: "nautilo.app.templates.req"; requestId: string; op: "read" | "remove"; templateId: string }
  | { type: "nautilo.app.templates.req"; requestId: string; op: "save"; name: string; content: string };

type AppStateSetRequest = {
  type: "nautilo.app.state.req";
  requestId: string;
  op: "set";
  key: string;
  value: unknown;
};
type AppPreferenceGetRequest = { type: "nautilo.app.preferences.req"; requestId: string; op: "get"; key: AppPreferenceKey };
type AppPreferenceSetRequest = { type: "nautilo.app.preferences.req"; requestId: string; op: "set"; key: AppPreferenceKey; value: unknown };
type AppPreferenceSubscribeMessage = { type: "nautilo.app.preferences.subscribe"; key: AppPreferenceKey };

type AppContextUpdateMessage = {
  type: "nautilo.app.context.update";
  summary: unknown;
};

type AppHumanEditUpdateMessage = {
  type: "nautilo.app.human-edit.update";
  update: AppHumanEditUpdate;
};

type AppLifecycleRegistrationMessage = {
  type: "nautilo.app.lifecycle.register";
} | {
  type: "nautilo.app.lifecycle.unregister";
};

type AppSessionAcceptProposalRequest = {
  type: "nautilo.app.session.req";
  requestId: string;
  op: "acceptProposal";
  proposalId: string;
  documentVersion: unknown;
  acceptedOperationIndexes: unknown;
  acceptedContent: string;
};

type AppSessionResolveProposalRequest = {
  type: "nautilo.app.session.req";
  requestId: string;
  op: "resolveProposal";
  proposalId: string;
  documentVersion: unknown;
  outcome: "accepted" | "rejected";
};

type AppSessionInvalidateProposalRequest = {
  type: "nautilo.app.session.req";
  requestId: string;
  op: "invalidateProposal";
  proposalSessionToken: string;
  proposalId: string;
  documentVersion: unknown;
  reason: "human_changed" | "stale_version" | "remote_changed" | "session_closed" | "no_effective_change";
};

type AppLiveProposalAcknowledgement = {
  type: "nautilo.app.live-proposal.ack";
  proposalId: string;
  documentVersion: unknown;
};

type AppAssetReadRequest = {
  type: "nautilo.app.asset.req";
  requestId: string;
  op: "read";
  ref: string;
};

type AppAssetCancelMessage = {
  type: "nautilo.app.asset.cancel";
  requestId: string;
};

type AppMediaOpenPreviewRequest = {
  type: "nautilo.app.media.req";
  requestId: string;
  op: "openPreview";
} & ({ ref: string } | { mediaId: string } | { referenceId: string });

type AppMediaPickRequest = { type: "nautilo.app.media.req"; requestId: string; op: "pick" } & VideoMediaPickInput;

type AppMediaImportVideoRequest = {
  type: "nautilo.app.media.req";
  requestId: string;
  op: "importVideo";
};

type AppMediaClosePreviewRequest = {
  type: "nautilo.app.media.req";
  requestId: string;
  op: "closePreview";
  revokeToken: string;
};

type AppMediaCancelMessage = {
  type: "nautilo.app.media.cancel";
  requestId: string;
};
type AppMediaExportRequest = { type: "nautilo.app.media.req"; requestId: string; op: "exportVideo"; sha256: string; revision: number | null; publishToWorkspace?: boolean; exportSettings?: import("@nautilo/types").VideoExportSettings };
type AppMediaExportCapabilitiesRequest = { type: "nautilo.app.media.req"; requestId: string; op: "exportCapabilities" };
type AppMediaPromotionRequest = { type: "nautilo.app.media.req"; requestId: string; op: "saveWorkspaceCopy"; sha256: string };
type AppMediaOpenPromotionRequest = { type: "nautilo.app.media.req"; requestId: string; op: "openWorkspaceCopy" };
type AppMediaPromotionCapabilitiesRequest = { type: "nautilo.app.media.req"; requestId: string; op: "workspaceCopyCapabilities" };

export type VideoGenerationBridgeRequest = Readonly<{
  requestId: string;
  document: Readonly<{ sha256: string; revision: number | null }>;
  sourceFingerprint: string;
  job: Readonly<{
    source: Readonly<{ kind: "quick-brief" }> | Readonly<{ kind: "shot"; shotId: string }>;
    shotLabel?: string;
    /** Ephemeral compiler output; the parent forwards it only to prepare. */
    prompt: string;
    modelId: "venice:seedance-2-5-text-to-video-basic" | "venice:seedance-2-5-reference-to-video-basic" | "venice:minimax-h3-enhanced-text-to-video";
    continuationTakeId?: string;
    requestedSettings?: Readonly<{
      durationSeconds?: number;
      aspectRatio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
      resolution?: "480p" | "720p" | "1080p" | "768P" | "2K";
      audio?: boolean;
    }>;
  }>;
}>;

export type VideoGenerationBridgeResult =
  | Readonly<{ kind: "queued"; takeId?: string }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "submission-unknown"; takeId: string }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "unavailable"; code: string; message?: string }>;

type VideoGenerationSafeArtifact = Readonly<{ artifactId: string; path: string; zone: "workspace"; mime: string; bytes: number }>;
type VideoGenerationSafeTake = Readonly<{
  id: string; briefRevision: number; shotId?: string; shotLabel?: string; mediaKind: "video" | "audio"; modelId: string;
  settings: Readonly<{ durationSeconds?: number; resolution?: string; aspectRatio?: string; audioEnabled?: boolean; instrumental?: boolean }>;
  artifact: VideoGenerationSafeArtifact;
}>;
type VideoGenerationSafeStatus = Readonly<{
  takeId: string; revision: number; mediaKind: "video" | "audio"; state: string; modelId: string;
  settings: VideoGenerationSafeTake["settings"]; progress?: unknown; artifact?: VideoGenerationSafeArtifact; failure?: unknown; recoveryActions: unknown[];
}>;
export type VideoGenerationTakeListBridgeResult =
  | Readonly<{ kind: "ready"; takes: ReadonlyArray<Readonly<{ takeId: string; shotId: string; shotLabel: string; documentRevision: number }>> }>
  | Readonly<{ kind: "unavailable"; code: string }>;
export type VideoGenerationTakeStatusBridgeResult =
  | Readonly<{ kind: "ready"; status: VideoGenerationSafeStatus }>
  | Readonly<{ kind: "unavailable"; code: string }>;
export type VideoGenerationPreviewBridgeResult =
  | Readonly<{ kind: "opened" }>
  | Readonly<{ kind: "unavailable"; code: string }>;
export type VideoGenerationRevalidationBridgeResult =
  | Readonly<{ status: "ready"; take: VideoGenerationSafeTake; durationSec: number }>
  | Readonly<{ status: "stale" | "deleted" | "unavailable" | "malformed"; takeId: string }>;
export type VideoGenerationReferencesImportBridgeResult =
  | Readonly<{ kind: "ready"; assets: readonly Extract<VideoGenerationReferenceImportBridgeResult, { kind: "ready" }>["asset"][]; failures: readonly Readonly<{ label: string; code: string }>[] }>
  | Readonly<{ kind: "unavailable"; code: string }>;

export type VideoGenerationReferenceImportBridgeResult =
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
  | Readonly<{ kind: "unavailable"; code: string }>;

export type VideoWorkspaceMediaImportBridgeResult =
  | ({ kind: "ready"; mediaRef: string; label: string; source: { kind: "workspace-artifact"; artifactId: string; path: string } } & (
    | { mediaKind?: "video"; durationSec: number; frameRate: { numerator: number; denominator: number } }
    | { mediaKind: "audio"; durationSec: number; frameRate?: never }
    | { mediaKind: "image"; durationSec?: never; frameRate?: never }
  ))
  | Readonly<{ kind: "unavailable"; code: string }>;

export type VideoMediaPickInput = { purpose: "media" | "references"; multiple: boolean };
export type VideoMediaPickResult =
  | { kind: "ready"; imports: Extract<VideoWorkspaceMediaImportBridgeResult, { kind: "ready" }>[]; references: Extract<VideoGenerationReferenceImportBridgeResult, { kind: "ready" }>["asset"][]; mediaIds: string[]; failures: { label: string; code: string }[] }
  | { kind: "unavailable"; code: string };

type AppVideoGenerationRequest = VideoGenerationBridgeRequest & {
  type: "nautilo.app.video-generation.request";
};

type AppVideoGenerationReadRequest = {
  type: "nautilo.app.video-generation.req";
  requestId: string;
  op: "listTakes" | "getTakeStatus" | "previewTake" | "revalidateTake";
  takeId?: string;
};

type AppVideoGenerationImportReferenceRequest = {
  type: "nautilo.app.video-generation.req";
  requestId: string;
} & ({ op: "importReference"; mediaKind: "image" | "video" | "audio" } | { op: "importReferences"; mediaKind: "image" });

type AppVideoHostLayoutRequest = {
  type: "nautilo.app.video-host-layout.req";
  requestId: string;
  op: "setFullWidth";
  enabled: boolean;
};

export type AppBridgeRequest =
  | AppAssetRequest
  | AppDocumentReadRequest
  | AppDocumentWriteRequest
  | AppDocumentSaveCopyRequest
  | AppRecoveryRequest
  | AppTemplateRequest
  | AppStateGetRequest
  | AppStateSetRequest
  | AppPreferenceGetRequest
  | AppPreferenceSetRequest
  | AppPreferenceSubscribeMessage
  | AppContextUpdateMessage
  | AppHumanEditUpdateMessage
  | AppLifecycleRegistrationMessage
  | AppSessionAcceptProposalRequest
  | AppLiveProposalAcknowledgement
  | AppSessionInvalidateProposalRequest
  | AppSessionResolveProposalRequest
  | AppAssetReadRequest
  | AppAssetCancelMessage
  | AppMediaOpenPreviewRequest
  | AppMediaPickRequest
  | AppMediaImportVideoRequest
  | AppMediaExportRequest
  | AppMediaExportCapabilitiesRequest
  | AppMediaPromotionRequest
  | AppMediaOpenPromotionRequest
  | AppMediaPromotionCapabilitiesRequest
  | AppMediaClosePreviewRequest
  | AppMediaCancelMessage
  | AppVideoGenerationRequest
  | AppVideoGenerationReadRequest
  | AppVideoGenerationImportReferenceRequest
  | AppVideoHostLayoutRequest;

class BridgeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

/** Stable codes forwarded to iframe acceptProposal without leaking host details. */
export const ACCEPT_PROPOSAL_SAFE_ERROR_CODES = [
  "acceptance_conflict",
  "proposal_closed",
  "stale_version",
  "session_closed",
  "relay_unavailable",
  "local_target_forbidden",
  "invalid_request",
  "payload_too_large",
] as const;

export type AcceptProposalSafeErrorCode = (typeof ACCEPT_PROPOSAL_SAFE_ERROR_CODES)[number];

export type AcceptProposalBridgeFailure = {
  ok: false;
  code: AcceptProposalSafeErrorCode;
  message: string;
  status?: number;
};

export type AcceptProposalBridgeSuccess = {
  ok: true;
  value: {
    ok: true;
    documentVersion: LiveDocumentVersion;
    contentSha256: string;
    localRevisionRef?: string;
  };
};

const ACCEPT_PROPOSAL_SAFE_ERROR_CODE_SET = new Set<string>(ACCEPT_PROPOSAL_SAFE_ERROR_CODES);

function isAcceptProposalSafeErrorCode(code: unknown): code is AcceptProposalSafeErrorCode {
  return typeof code === "string" && ACCEPT_PROPOSAL_SAFE_ERROR_CODE_SET.has(code);
}

function acceptProposalFailure(
  code: AcceptProposalSafeErrorCode,
  status?: number,
): AcceptProposalBridgeFailure {
  return {
    ok: false,
    code,
    message: code,
    ...(typeof status === "number" ? { status } : {}),
  };
}

function readAcceptProposalApiError(err: unknown): { code: string; status: number } | null {
  if (!err || typeof err !== "object") return null;
  const record = err as Record<string, unknown>;
  if (record["name"] !== "LiveProposalAcceptanceError") return null;
  const code = record["code"];
  const status = record["status"];
  if (typeof code !== "string" || typeof status !== "number") return null;
  return { code, status };
}

/** Map host/API failures to the iframe-safe acceptProposal envelope. */
export function mapAcceptProposalBridgeFailure(err: unknown): AcceptProposalBridgeFailure {
  const apiErr = readAcceptProposalApiError(err);
  if (apiErr && isAcceptProposalSafeErrorCode(apiErr.code)) {
    return acceptProposalFailure(apiErr.code, apiErr.status);
  }

  if (err instanceof BridgeError) {
    if (err.status === 409 && err.message.includes("stale")) {
      return acceptProposalFailure("stale_version", 409);
    }
    if (err.message.includes("No live review session is active.")) {
      return acceptProposalFailure("session_closed");
    }
    if (err.message.includes("Live proposal acceptance is unavailable for this document.")) {
      return acceptProposalFailure("local_target_forbidden");
    }
    if (err.message.includes("acceptedOperationIndexes")) {
      return acceptProposalFailure("invalid_request");
    }
    return acceptProposalFailure(
      "invalid_request",
      typeof err.status === "number" ? err.status : undefined,
    );
  }

  const status = (err as { status?: number } | null)?.status;
  return acceptProposalFailure(
    "invalid_request",
    typeof status === "number" ? status : undefined,
  );
}

export function rejectsHostOwnedKeys(x: Record<string, unknown>): boolean {
  for (const key of HOST_OWNED_TOP_LEVEL_KEYS) {
    if (key in x) return true;
  }
  return false;
}

/**
 * Video generation is deliberately more restrictive than ordinary bridge
 * requests. The host—not the iframe—owns sessions, project context, receipts,
 * approval and every byte/path transport. Scan recursively so a hostile app
 * cannot smuggle one under an otherwise valid-looking `job` object.
 */
const VIDEO_GENERATION_HOST_OWNED_KEYS = new Set([
  "token", "sessiontoken", "sessionid", "roomid", "namespaceid",
  "projectid", "projectartifactid", "artifactid", "artifact_id",
  "path", "rootpath", "url", "receipt", "receiptid", "approval",
  "approvalid", "reviewhandle", "provider", "providerid", "providerjobid",
]);

export function rejectsVideoGenerationHostOwnedKeys(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): boolean => {
    if (!current || typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) return current.some(visit);
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (VIDEO_GENERATION_HOST_OWNED_KEYS.has(key.toLowerCase())) return true;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isValidStateKey(key: string): boolean {
  return key.length > 0 && key.length <= STATE_KEY_MAX_LEN && !key.includes(":");
}

function truncateString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

export function normalizeAppContextSummary(input: unknown): AppContextSummary {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: AppContextSummary = {};
  for (const field of Object.keys(CONTEXT_STRING_LIMITS) as Array<keyof typeof CONTEXT_STRING_LIMITS>) {
    const raw = src[field];
    if (typeof raw === "string") {
      out[field] = truncateString(raw, CONTEXT_STRING_LIMITS[field]);
    }
  }
  for (const field of ["selection", "summary"] as const) {
    const raw = src[field];
    if (raw === undefined) continue;
    try {
      const encoded = JSON.stringify(raw);
      if (encoded === undefined || encoded.length > CONTEXT_JSON_FIELD_LIMIT) continue;
      // Keep the exact JSON representation we validated. This prevents optional
      // properties omitted by JSON.stringify from leaking into later consumers.
      out[field] = JSON.parse(encoded);
    } catch {
      /* Drop non-serializable context payloads before they can reach UI state. */
    }
  }
  return out;
}

export function appStateKey(appId: string, key: string): string {
  return `app:${appId}:${key}`;
}

function isAssetRequest(x: Record<string, unknown>): x is AppAssetRequest {
  return x["type"] === "nautilo.app.assets.req" && isNonEmptyString(x["requestId"]) &&
    ((x["op"] === "pick" && Object.keys(x).every((key) => ["type", "requestId", "op"].includes(key))) ||
     (x["op"] === "read" && typeof x["ref"] === "string" && Object.keys(x).every((key) => ["type", "requestId", "op", "ref"].includes(key))));
}

function isDocumentReadRequest(x: Record<string, unknown>): x is AppDocumentReadRequest {
  return (
    x["type"] === "nautilo.app.document.req" &&
    isNonEmptyString(x["requestId"]) &&
    (((x["op"] === "read" || x["op"] === "stat") && (x["fresh"] === undefined || typeof x["fresh"] === "boolean")) ||
      (x["op"] === "authoredChange" && Object.keys(x).every((key) => ["type", "requestId", "op"].includes(key))))
  );
}

function isDocumentWriteRequest(x: Record<string, unknown>): x is AppDocumentWriteRequest {
  if (x["type"] !== "nautilo.app.document.req") return false;
  if (!isNonEmptyString(x["requestId"])) return false;
  if (x["op"] !== "write" && x["op"] !== "downloadCopy") return false;
  if (!("value" in x)) return false;
  if (x["conflictPolicy"] !== undefined && x["conflictPolicy"] !== "strict") return false;
  if ("baseSha256" in x && x["baseSha256"] != null && typeof x["baseSha256"] !== "string") {
    return false;
  }
  if ("baseRevision" in x && x["baseRevision"] != null && typeof x["baseRevision"] !== "number") {
    return false;
  }
  return true;
}

function isDocumentSaveCopyRequest(x: Record<string, unknown>): x is AppDocumentSaveCopyRequest {
  return x["type"] === "nautilo.app.document.req" &&
    isNonEmptyString(x["requestId"]) && x["op"] === "saveCopy" && "value" in x;
}

function isStateGetRequest(x: Record<string, unknown>): x is AppStateGetRequest {
  return (
    x["type"] === "nautilo.app.state.req" &&
    isNonEmptyString(x["requestId"]) &&
    x["op"] === "get" &&
    typeof x["key"] === "string" &&
    isValidStateKey(x["key"])
  );
}
function isRecoveryRequest(x: Record<string, unknown>): x is AppRecoveryRequest {
  if (x["type"] !== "nautilo.app.recovery.req" || !isNonEmptyString(x["requestId"])) return false;
  if (x["op"] === "read") return Object.keys(x).every(key => ["type", "requestId", "op"].includes(key));
  if (x["op"] !== "write" || Object.keys(x).some(key => !["type", "requestId", "op", "input"].includes(key))) return false;
  const input = x["input"];
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return Object.keys(record).every(key => key === "expectedRevision" || key === "draft")
    && (record.expectedRevision === null || typeof record.expectedRevision === "string")
    && (record.draft === null || isAppRecoveryDraft(record.draft));
}

function isStateSetRequest(x: Record<string, unknown>): x is AppStateSetRequest {
  return (
    x["type"] === "nautilo.app.state.req" &&
    isNonEmptyString(x["requestId"]) &&
    x["op"] === "set" &&
    typeof x["key"] === "string" &&
    isValidStateKey(x["key"]) &&
    "value" in x
  );
}
function isAppPreferenceKey(value: unknown): value is AppPreferenceKey {
  return (
    value === WRITER_SPELL_PREFERENCE_KEY ||
    value === DESIGN_RECEIPTS_PREFERENCE_KEY ||
    value === VIDEO_RECEIPTS_PREFERENCE_KEY || value === VIDEO_FRAME_RATE_PREFERENCE_KEY
  );
}
function canAccessAppPreference(appId: string, key: AppPreferenceKey): boolean {
  return (
    (appId === "nautilo-writer" && key === WRITER_SPELL_PREFERENCE_KEY) ||
    (appId === "nautilo-design" && key === DESIGN_RECEIPTS_PREFERENCE_KEY) ||
    (appId === "nautilo-video" && (key === VIDEO_RECEIPTS_PREFERENCE_KEY || key === VIDEO_FRAME_RATE_PREFERENCE_KEY))
  );
}
function isAppPreferenceGetRequest(x: Record<string, unknown>): x is AppPreferenceGetRequest {
  return x["type"] === "nautilo.app.preferences.req" && isNonEmptyString(x["requestId"]) && x["op"] === "get" && isAppPreferenceKey(x["key"]);
}
function isAppPreferenceSetRequest(x: Record<string, unknown>): x is AppPreferenceSetRequest {
  return x["type"] === "nautilo.app.preferences.req" && isNonEmptyString(x["requestId"]) && x["op"] === "set" && isAppPreferenceKey(x["key"]) && "value" in x;
}
function isAppPreferenceSubscribeMessage(x: Record<string, unknown>): x is AppPreferenceSubscribeMessage {
  return x["type"] === "nautilo.app.preferences.subscribe" && Object.keys(x).every((key) => key === "type" || key === "key") && isAppPreferenceKey(x["key"]);
}

function isContextUpdateMessage(x: Record<string, unknown>): x is AppContextUpdateMessage {
  return x["type"] === "nautilo.app.context.update" && "summary" in x;
}

function isHumanEditUpdateMessage(
  x: Record<string, unknown>,
): x is AppHumanEditUpdateMessage {
  if (x["type"] !== "nautilo.app.human-edit.update") return false;
  if (Object.keys(x).some((key) => key !== "type" && key !== "update")) return false;
  const raw = x["update"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const update = raw as Record<string, unknown>;
  if (Object.keys(update).some((key) => key !== "state" && key !== "draftPatch")) return false;
  if (!["clean", "dirty", "saving", "conflict"].includes(String(update["state"]))) return false;
  if (update["state"] === "clean" && update["draftPatch"] !== undefined) return false;
  if (update["draftPatch"] === undefined) return true;
  if (!update["draftPatch"] || typeof update["draftPatch"] !== "object") return false;
  const patch = update["draftPatch"] as Record<string, unknown>;
  if (
    Object.keys(patch).some(
      (key) => !["kind", "oldString", "newString", "replaceAll", "scope"].includes(key),
    )
  ) return false;
  if (patch["scope"] !== undefined) {
    if (!patch["scope"] || typeof patch["scope"] !== "object" || Array.isArray(patch["scope"])) {
      return false;
    }
    if (
      Object.keys(patch["scope"] as Record<string, unknown>)
        .some((key) => key !== "from" && key !== "to")
    ) return false;
  }
  return anchoredTextPatchSchema.safeParse(update["draftPatch"]).success;
}

function isSessionAcceptProposalRequest(
  x: Record<string, unknown>,
): x is AppSessionAcceptProposalRequest {
  return (
    x["type"] === "nautilo.app.session.req" &&
    isNonEmptyString(x["requestId"]) &&
    x["op"] === "acceptProposal" &&
    isNonEmptyString(x["proposalId"]) &&
    "documentVersion" in x &&
    "acceptedOperationIndexes" in x &&
    typeof x["acceptedContent"] === "string"
  );
}

function isSessionResolveProposalRequest(
  x: Record<string, unknown>,
): x is AppSessionResolveProposalRequest {
  return (
    x["type"] === "nautilo.app.session.req" &&
    isNonEmptyString(x["requestId"]) &&
    x["op"] === "resolveProposal" &&
    isNonEmptyString(x["proposalId"]) &&
    "documentVersion" in x &&
    (x["outcome"] === "accepted" || x["outcome"] === "rejected")
  );
}

function isLiveProposalAcknowledgement(
  x: Record<string, unknown>,
): x is AppLiveProposalAcknowledgement {
  return (
    x["type"] === "nautilo.app.live-proposal.ack" &&
    isNonEmptyString(x["proposalId"]) &&
    "documentVersion" in x &&
    Object.keys(x).every((key) => key === "type" || key === "proposalId" || key === "documentVersion")
  );
}

function isSessionInvalidateProposalRequest(
  x: Record<string, unknown>,
): x is AppSessionInvalidateProposalRequest {
  return (
    x["type"] === "nautilo.app.session.req" &&
    isNonEmptyString(x["requestId"]) &&
    x["op"] === "invalidateProposal" &&
    isNonEmptyString(x["proposalSessionToken"]) &&
    isNonEmptyString(x["proposalId"]) &&
    "documentVersion" in x &&
    (x["reason"] === "human_changed" || x["reason"] === "stale_version" ||
      x["reason"] === "remote_changed" || x["reason"] === "session_closed" ||
      x["reason"] === "no_effective_change")
  );
}

function isAssetReadRequest(x: Record<string, unknown>): x is AppAssetReadRequest {
  return (
    Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "ref") &&
    x["type"] === "nautilo.app.asset.req" &&
    isNonEmptyString(x["requestId"]) &&
    x["op"] === "read" &&
    typeof x["ref"] === "string"
  );
}

function isAssetCancelMessage(x: Record<string, unknown>): x is AppAssetCancelMessage {
  return (
    Object.keys(x).every((key) => key === "type" || key === "requestId") &&
    x["type"] === "nautilo.app.asset.cancel" &&
    isNonEmptyString(x["requestId"])
  );
}

function isMediaOpenPreviewRequest(x: Record<string, unknown>): x is AppMediaOpenPreviewRequest {
  const hasRef = typeof x["ref"] === "string";
  const hasMediaId = typeof x["mediaId"] === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(x["mediaId"]);
  const hasReferenceId = typeof x["referenceId"] === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(x["referenceId"]);
  return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "ref" || key === "mediaId" || key === "referenceId")
    && x["type"] === "nautilo.app.media.req"
    && isNonEmptyString(x["requestId"])
    && x["op"] === "openPreview"
    && Number(hasRef) + Number(hasMediaId) + Number(hasReferenceId) === 1
    && ["ref", "mediaId", "referenceId"].filter((key) => key in x).length === 1;
}

function isMediaPickRequest(x: Record<string, unknown>): x is AppMediaPickRequest {
  return isClosedRecord(x, ["type", "requestId", "op", "purpose", "multiple"]) && x.type === "nautilo.app.media.req" && isNonEmptyString(x.requestId) && x.op === "pick" && (x.purpose === "media" || x.purpose === "references") && typeof x.multiple === "boolean";
}

function isMediaImportVideoRequest(x: Record<string, unknown>): x is AppMediaImportVideoRequest {
  return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op")
    && x["type"] === "nautilo.app.media.req"
    && isNonEmptyString(x["requestId"])
    && x["op"] === "importVideo";
}
function isMediaExportRequest(x: Record<string, unknown>): x is AppMediaExportRequest {
  return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "sha256" || key === "revision" || key === "publishToWorkspace" || key === "exportSettings") && normalizeVideoExportSettings(x["exportSettings"]) !== null &&
    x["type"] === "nautilo.app.media.req" && isNonEmptyString(x["requestId"]) && x["op"] === "exportVideo" &&
    typeof x["sha256"] === "string" && /^[a-f0-9]{64}$/u.test(x["sha256"]) && (x["revision"] === null || Number.isSafeInteger(x["revision"])) &&
    (x["publishToWorkspace"] === undefined || typeof x["publishToWorkspace"] === "boolean");
}
function isMediaExportCapabilitiesRequest(x: Record<string, unknown>): x is AppMediaExportCapabilitiesRequest {
  return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op") &&
    x["type"] === "nautilo.app.media.req" && isNonEmptyString(x["requestId"]) && x["op"] === "exportCapabilities";
}
function isMediaPromotionRequest(x: Record<string, unknown>): x is AppMediaPromotionRequest {
  return Object.keys(x).every((key) => ["type", "requestId", "op", "sha256"].includes(key)) && x["type"] === "nautilo.app.media.req" &&
    isNonEmptyString(x["requestId"]) && x["op"] === "saveWorkspaceCopy" && typeof x["sha256"] === "string" && /^[a-f0-9]{64}$/u.test(x["sha256"]);
}
function isMediaOpenPromotionRequest(x: Record<string, unknown>): x is AppMediaOpenPromotionRequest {
  return Object.keys(x).every((key) => ["type", "requestId", "op"].includes(key)) && x["type"] === "nautilo.app.media.req" &&
    isNonEmptyString(x["requestId"]) && x["op"] === "openWorkspaceCopy";
}
function isMediaPromotionCapabilitiesRequest(x: Record<string, unknown>): x is AppMediaPromotionCapabilitiesRequest {
  return Object.keys(x).every((key) => ["type", "requestId", "op"].includes(key)) && x["type"] === "nautilo.app.media.req" && isNonEmptyString(x["requestId"]) && x["op"] === "workspaceCopyCapabilities";
}

function isMediaClosePreviewRequest(x: Record<string, unknown>): x is AppMediaClosePreviewRequest {
  return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "revokeToken")
    && x["type"] === "nautilo.app.media.req"
    && isNonEmptyString(x["requestId"])
    && x["op"] === "closePreview"
    && isNonEmptyString(x["revokeToken"]);
}

function isMediaCancelMessage(x: Record<string, unknown>): x is AppMediaCancelMessage {
  return Object.keys(x).every((key) => key === "type" || key === "requestId")
    && x["type"] === "nautilo.app.media.cancel"
    && isNonEmptyString(x["requestId"]);
}

function isVideoHostLayoutRequest(x: Record<string, unknown>): x is AppVideoHostLayoutRequest {
  return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "enabled") &&
    x["type"] === "nautilo.app.video-host-layout.req" &&
    isNonEmptyString(x["requestId"]) && x["op"] === "setFullWidth" && typeof x["enabled"] === "boolean";
}

function isVideoGenerationSource(value: unknown): value is VideoGenerationBridgeRequest["job"]["source"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source["kind"] === "quick-brief") return Object.keys(source).every((key) => key === "kind");
  return source["kind"] === "shot" && typeof source["shotId"] === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(source["shotId"]) &&
    Object.keys(source).every((key) => key === "kind" || key === "shotId");
}

function isVideoGenerationSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some((key) => !["durationSeconds", "aspectRatio", "resolution", "audio"].includes(key))) return false;
  return (settings["durationSeconds"] === undefined || (Number.isSafeInteger(settings["durationSeconds"]) && (settings["durationSeconds"] as number) > 0 && (settings["durationSeconds"] as number) <= 600)) &&
    (settings["aspectRatio"] === undefined || ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(settings["aspectRatio"] as string)) &&
    (settings["resolution"] === undefined || ["480p", "720p", "1080p", "768P", "2K"].includes(settings["resolution"] as string)) &&
    (settings["audio"] === undefined || typeof settings["audio"] === "boolean");
}

function isVideoGenerationRequest(x: Record<string, unknown>): x is AppVideoGenerationRequest {
  if (x["type"] !== "nautilo.app.video-generation.request" || rejectsVideoGenerationHostOwnedKeys(x)) return false;
  if (Object.keys(x).some((key) => !["type", "requestId", "document", "sourceFingerprint", "job"].includes(key))) return false;
  if (!isNonEmptyString(x["requestId"]) || x["requestId"].length > 128 ||
      typeof x["sourceFingerprint"] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(x["sourceFingerprint"])) return false;
  const document = x["document"];
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  const doc = document as Record<string, unknown>;
  if (Object.keys(doc).some((key) => key !== "sha256" && key !== "revision") ||
      typeof doc["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(doc["sha256"]) ||
      (doc["revision"] !== null && (!Number.isSafeInteger(doc["revision"]) || (doc["revision"] as number) < 0))) return false;
  const job = x["job"];
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  const record = job as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["source", "shotLabel", "prompt", "modelId", "requestedSettings", "continuationTakeId"].includes(key)) ||
      !isVideoGenerationSource(record["source"]) ||
      (record["continuationTakeId"] !== undefined && (typeof record["continuationTakeId"] !== "string" || !/^take_[A-Za-z0-9_-]{16,128}$/u.test(record["continuationTakeId"]))) ||
      (record["shotLabel"] !== undefined && (typeof record["shotLabel"] !== "string" || record["shotLabel"].length === 0)) ||
      (typeof record["prompt"] !== "string" || record["prompt"].trim().length === 0) ||
      (record["modelId"] !== "venice:seedance-2-5-text-to-video-basic" && record["modelId"] !== "venice:seedance-2-5-reference-to-video-basic" && record["modelId"] !== "venice:minimax-h3-enhanced-text-to-video") ||
      (record["requestedSettings"] !== undefined && !isVideoGenerationSettings(record["requestedSettings"]))) return false;
  return true;
}

function isVideoGenerationReadRequest(x: Record<string, unknown>): x is AppVideoGenerationReadRequest {
  if (x["type"] !== "nautilo.app.video-generation.req" || rejectsVideoGenerationHostOwnedKeys(x)) return false;
  if (!isNonEmptyString(x["requestId"]) || x["requestId"].length > 128) return false;
  const op = x["op"];
  if (op === "listTakes") return Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op");
  return (op === "getTakeStatus" || op === "previewTake" || op === "revalidateTake") &&
    typeof x["takeId"] === "string" && /^take_[A-Za-z0-9_-]{16,128}$/u.test(x["takeId"]) &&
    Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "takeId");
}

function isVideoGenerationImportReferenceRequest(x: Record<string, unknown>): x is AppVideoGenerationImportReferenceRequest {
  return x["type"] === "nautilo.app.video-generation.req" && rejectsVideoGenerationHostOwnedKeys(x) === false &&
    isNonEmptyString(x["requestId"]) && x["requestId"].length <= 128 && (x["op"] === "importReference" || (x["op"] === "importReferences" && x["mediaKind"] === "image")) &&
    (x["mediaKind"] === "image" || x["mediaKind"] === "video" || x["mediaKind"] === "audio") &&
    Object.keys(x).every((key) => key === "type" || key === "requestId" || key === "op" || key === "mediaKind");
}

function isClosedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key));
}

function isSafeVideoText(value: unknown, max?: number): value is string {
  return typeof value === "string" && value.length > 0 && (max === undefined || new TextEncoder().encode(value).byteLength <= max) &&
    !/[\r\n\0]/u.test(value) && !/(?:https?:|data:|blob:|file:)/iu.test(value);
}

function isSafeVideoGenerationArtifact(value: unknown): value is VideoGenerationSafeArtifact {
  if (!isClosedRecord(value, ["artifactId", "path", "zone", "mime", "bytes"])) return false;
  return typeof value["artifactId"] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value["artifactId"]) &&
    typeof value["path"] === "string" && value["path"].length > 0 && !value["path"].startsWith("/") && !value["path"].includes("\\") &&
    !/(?:https?:|data:|blob:|file:)/iu.test(value["path"]) && !value["path"].split("/").some((part) => !part || part === "." || part === "..") &&
    value["zone"] === "workspace" && typeof value["mime"] === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value["mime"]) &&
    Number.isSafeInteger(value["bytes"]) && (value["bytes"] as number) > 0;
}

function isSafeVideoWorkspaceImportResult(value: unknown): value is Extract<VideoWorkspaceMediaImportBridgeResult, { kind: "ready" }> {
  if (!isClosedRecord(value, ["kind", "mediaKind", "mediaRef", "label", "durationSec", "frameRate", "source"]) || value["kind"] !== "ready") return false;
  const source = value["source"];
  const frameRate = value["frameRate"];
  const mediaKind = value["mediaKind"] ?? "video";
  if (mediaKind !== "video" && mediaKind !== "audio" && mediaKind !== "image") return false;
  if (mediaKind === "image" ? value["durationSec"] !== undefined :
    typeof value["durationSec"] !== "number" || !Number.isFinite(value["durationSec"]) || value["durationSec"] <= 0) return false;
  if (mediaKind !== "video" ? frameRate !== undefined :
    !isClosedRecord(frameRate, ["numerator", "denominator"]) ||
    !Number.isSafeInteger(frameRate["numerator"]) || !Number.isSafeInteger(frameRate["denominator"]) ||
    Number(frameRate["numerator"]) <= 0 ||
    Number(frameRate["denominator"]) <= 0) return false;
  if (!isClosedRecord(source, ["kind", "artifactId", "path"]) || source["kind"] !== "workspace-artifact" ||
      typeof source["artifactId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(source["artifactId"]) ||
      typeof source["path"] !== "string") return false;
  const path = source["path"];
  return typeof value["mediaRef"] === "string" && value["mediaRef"] === path && path.length > 0 &&
    !path.startsWith("/") && !path.includes("\\") && !/(?:https?:|data:|blob:|file:)/iu.test(path) && !path.split("/").some((part) => !part || part === "." || part === "..") &&
    isSafeVideoText(value["label"]);
}

function isSafeVideoWorkspaceExportResult(value: unknown): value is VideoWorkspaceMediaExportResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "cancelled") return isClosedRecord(record, ["kind"]);
  if (record["kind"] === "unavailable") return isClosedRecord(record, ["kind", "code"]) && typeof record["code"] === "string" && record["code"].length > 0 && !/[\r\n\0]/u.test(record["code"]);
  if (!isClosedRecord(record, ["kind", "label", "sizeBytes", "warnings", "workspace"]) || record["kind"] !== "succeeded" || typeof record["label"] !== "string" || record["label"].length === 0 || !Number.isSafeInteger(record["sizeBytes"]) || (record["sizeBytes"] as number) < 0 || !Array.isArray(record["warnings"])) return false;
  const workspace = record["workspace"];
  return workspace === undefined || (isClosedRecord(workspace, ["status", "path", "artifactId"]) &&
    (workspace["status"] === "published" || workspace["status"] === "not_published" || workspace["status"] === "unknown") &&
    typeof workspace["path"] === "string" && workspace["path"].length > 0 && !/[\r\n\0]/u.test(workspace["path"]) && !workspace["path"].startsWith("/") && !workspace["path"].includes("\\") && !/(?:https?:|data:|blob:|file:)/iu.test(workspace["path"]) && !workspace["path"].split("/").some((part) => !part || part === "." || part === "..") &&
    (workspace["status"] === "published" ? typeof workspace["artifactId"] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(workspace["artifactId"]) : workspace["artifactId"] === undefined));
}

function isSafeVideoGenerationReferenceImportResult(value: unknown): value is VideoGenerationReferenceImportBridgeResult {
  if (isClosedRecord(value, ["kind", "code"]) && value["kind"] === "unavailable") {
    return typeof value["code"] === "string" && ["unavailable", "unsupported_environment", "cancelled", "unsupported_type", "too_large", "changed_during_read", "processing_unavailable", "invalid_response", "stale_project", "upload_unavailable"].includes(value["code"]);
  }
  if (!isClosedRecord(value, ["kind", "asset"]) || value["kind"] !== "ready" || !isClosedRecord(value["asset"], ["artifactId", "path", "label", "mediaKind", "mimeType", "sizeBytes"])) return false;
  const asset = value["asset"];
  return typeof asset["artifactId"] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(asset["artifactId"]) &&
    typeof asset["path"] === "string" && asset["path"].length > 0 && asset["path"].length <= 1024 && !asset["path"].startsWith("/") && !asset["path"].includes("\\") &&
    !/(?:https?:|data:|blob:|file:)/iu.test(asset["path"]) && !asset["path"].split("/").some((part) => !part || part === "." || part === "..") &&
    isSafeVideoText(asset["label"]) && (asset["mediaKind"] === "image" || asset["mediaKind"] === "video" || asset["mediaKind"] === "audio") &&
    typeof asset["mimeType"] === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(asset["mimeType"]) &&
    ((asset["mediaKind"] === "image" && asset["mimeType"].startsWith("image/")) ||
      (asset["mediaKind"] === "video" && asset["mimeType"].startsWith("video/")) ||
      (asset["mediaKind"] === "audio" && asset["mimeType"].startsWith("audio/"))) &&
    Number.isSafeInteger(asset["sizeBytes"]) && (asset["sizeBytes"] as number) > 0 && (asset["sizeBytes"] as number) <= 100 * 1024 * 1024;
}

function isSafeVideoGenerationSettings(value: unknown): boolean {
  if (!isClosedRecord(value, ["durationSeconds", "resolution", "aspectRatio", "audioEnabled", "instrumental"])) return false;
  return (value["durationSeconds"] === undefined || (Number.isSafeInteger(value["durationSeconds"]) && (value["durationSeconds"] as number) > 0)) &&
    (value["resolution"] === undefined || (typeof value["resolution"] === "string" && /^[A-Za-z0-9._:+-]{1,64}$/u.test(value["resolution"]))) &&
    (value["aspectRatio"] === undefined || (typeof value["aspectRatio"] === "string" && /^[A-Za-z0-9._:+-]{1,64}$/u.test(value["aspectRatio"]))) &&
    (value["audioEnabled"] === undefined || typeof value["audioEnabled"] === "boolean") &&
    (value["instrumental"] === undefined || typeof value["instrumental"] === "boolean");
}

function isSafeVideoGenerationTake(value: unknown): value is VideoGenerationSafeTake {
  if (!isClosedRecord(value, ["id", "briefRevision", "shotId", "shotLabel", "mediaKind", "modelId", "settings", "artifact"])) return false;
  const kind = value["mediaKind"];
  return typeof value["id"] === "string" && /^take_[A-Za-z0-9_-]{16,128}$/u.test(value["id"]) &&
    Number.isSafeInteger(value["briefRevision"]) && (value["briefRevision"] as number) >= 0 &&
    (value["shotId"] === undefined || (typeof value["shotId"] === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value["shotId"]))) &&
    (value["shotLabel"] === undefined || isSafeVideoText(value["shotLabel"])) && (kind === "video" || kind === "audio") &&
    typeof value["modelId"] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value["modelId"]) &&
    isSafeVideoGenerationSettings(value["settings"]) && isSafeVideoGenerationArtifact(value["artifact"]) &&
    (kind === "video" ? value["artifact"].mime.startsWith("video/") : value["artifact"].mime.startsWith("audio/"));
}

function isSafeVideoGenerationTakeListResult(value: unknown): value is VideoGenerationTakeListBridgeResult {
  if (!isClosedRecord(value, ["kind", "takes"]) || value["kind"] !== "ready" || !Array.isArray(value["takes"])) return false;
  return value["takes"].every((take) => isClosedRecord(take, ["takeId", "shotId", "shotLabel", "documentRevision"]) &&
    typeof take["takeId"] === "string" && /^take_[A-Za-z0-9_-]{16,128}$/u.test(take["takeId"]) &&
    typeof take["shotId"] === "string" && /^(?:quick-brief|[A-Za-z][A-Za-z0-9_-]{0,63})$/u.test(take["shotId"]) &&
    isSafeVideoText(take["shotLabel"]) && Number.isSafeInteger(take["documentRevision"]) && (take["documentRevision"] as number) >= 0);
}

function isSafeVideoGenerationTakeStatusResult(value: unknown): value is VideoGenerationTakeStatusBridgeResult {
  if (!isClosedRecord(value, ["kind", "status"]) || value["kind"] !== "ready" || !isClosedRecord(value["status"], ["takeId", "revision", "mediaKind", "state", "modelId", "settings", "progress", "artifact", "failure", "recoveryActions"])) return false;
  const status = value["status"];
  const validStates = new Set(["preparing", "submitting", "queued", "generating", "downloading", "saving", "ready", "cleanup-pending", "needs-action", "failed", "unknown"]);
  const artifact = status["artifact"];
  return typeof status["takeId"] === "string" && /^take_[A-Za-z0-9_-]{16,128}$/u.test(status["takeId"]) &&
    Number.isSafeInteger(status["revision"]) && (status["revision"] as number) >= 0 && (status["mediaKind"] === "video" || status["mediaKind"] === "audio") &&
    typeof status["state"] === "string" && validStates.has(status["state"]) && typeof status["modelId"] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(status["modelId"]) &&
    isSafeVideoGenerationSettings(status["settings"]) && (artifact === undefined || isSafeVideoGenerationArtifact(artifact)) &&
    Array.isArray(status["recoveryActions"]) && status["recoveryActions"].length <= 16;
}

/** Copy the only nested status fields that Video is allowed to render. */
export function canonicalVideoGenerationTakeStatus(value: unknown, requestedTakeId: string): VideoGenerationTakeStatusBridgeResult | null {
  if (!isSafeVideoGenerationTakeStatusResult(value)) return null;
  const status = (value as { status: Record<string, unknown> }).status;
  if (status["takeId"] !== requestedTakeId) return null;
  const rawSettings = status["settings"] as Record<string, unknown>;
  const settings: VideoGenerationSafeTake["settings"] = {
    ...(rawSettings["durationSeconds"] === undefined ? {} : { durationSeconds: rawSettings["durationSeconds"] as number }),
    ...(rawSettings["resolution"] === undefined ? {} : { resolution: rawSettings["resolution"] as string }),
    ...(rawSettings["aspectRatio"] === undefined ? {} : { aspectRatio: rawSettings["aspectRatio"] as string }),
    ...(rawSettings["audioEnabled"] === undefined ? {} : { audioEnabled: rawSettings["audioEnabled"] as boolean }),
    ...(rawSettings["instrumental"] === undefined ? {} : { instrumental: rawSettings["instrumental"] as boolean }),
  };
  const progress = status["progress"];
  if (progress !== undefined && (!isClosedRecord(progress, ["phase", "elapsedSeconds", "estimatedSeconds", "message"]) ||
      typeof progress["phase"] !== "string" || !isSafeVideoText(progress["phase"], 64) ||
      (progress["elapsedSeconds"] !== undefined && (!Number.isSafeInteger(progress["elapsedSeconds"]) || (progress["elapsedSeconds"] as number) < 0)) ||
      (progress["estimatedSeconds"] !== undefined && (!Number.isSafeInteger(progress["estimatedSeconds"]) || (progress["estimatedSeconds"] as number) < 0)) ||
      (progress["message"] !== undefined && !isSafeVideoText(progress["message"], 512)))) return null;
  const copiedProgress = progress === undefined ? undefined : {
    phase: progress["phase"] as string,
    ...(progress["elapsedSeconds"] === undefined ? {} : { elapsedSeconds: progress["elapsedSeconds"] as number }),
    ...(progress["estimatedSeconds"] === undefined ? {} : { estimatedSeconds: progress["estimatedSeconds"] as number }),
    ...(progress["message"] === undefined ? {} : { message: progress["message"] as string }),
  };
  const failure = status["failure"];
  const phases = new Set(["quote", "queue", "retrieve", "download", "save", "cleanup", "reconcile"]);
  const completionCertainty = new Set(["not_started", "accepted", "unknown", "complete"]);
  const chargeCertainty = new Set(["not_charged", "unknown", "charged", "refunded"]);
  if (failure !== undefined && (!isClosedRecord(failure, ["code", "message", "phase", "retrySafe", "stateChanged", "completionCertainty", "chargeCertainty", "creditsRefunded"]) ||
      typeof failure["code"] !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(failure["code"]) || !isSafeVideoText(failure["message"], 512) ||
      typeof failure["phase"] !== "string" || !phases.has(failure["phase"]) || typeof failure["retrySafe"] !== "boolean" || typeof failure["stateChanged"] !== "boolean" ||
      typeof failure["completionCertainty"] !== "string" || !completionCertainty.has(failure["completionCertainty"]) || typeof failure["chargeCertainty"] !== "string" || !chargeCertainty.has(failure["chargeCertainty"]) ||
      (failure["creditsRefunded"] !== undefined && typeof failure["creditsRefunded"] !== "boolean"))) return null;
  const copiedFailure = failure === undefined ? undefined : {
    code: failure["code"] as string, message: failure["message"] as string, phase: failure["phase"] as string,
    retrySafe: failure["retrySafe"] as boolean, stateChanged: failure["stateChanged"] as boolean,
    completionCertainty: failure["completionCertainty"] as string, chargeCertainty: failure["chargeCertainty"] as string,
    ...(failure["creditsRefunded"] === undefined ? {} : { creditsRefunded: failure["creditsRefunded"] as boolean }),
  };
  const actions = status["recoveryActions"];
  if (!Array.isArray(actions) || !actions.every((action) => isClosedRecord(action, ["kind", "label", "newSpend"]) &&
      typeof action["kind"] === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(action["kind"]) && isSafeVideoText(action["label"], 160) && typeof action["newSpend"] === "boolean")) return null;
  const artifact = status["artifact"];
  const copiedArtifact = artifact === undefined ? undefined : {
    artifactId: (artifact as VideoGenerationSafeArtifact)["artifactId"], path: (artifact as VideoGenerationSafeArtifact)["path"], zone: "workspace" as const,
    mime: (artifact as VideoGenerationSafeArtifact)["mime"], bytes: (artifact as VideoGenerationSafeArtifact)["bytes"],
  };
  return { kind: "ready", status: {
    takeId: requestedTakeId, revision: status["revision"] as number, mediaKind: status["mediaKind"] as "video" | "audio", state: status["state"] as string,
    modelId: status["modelId"] as string, settings,
    ...(copiedProgress === undefined ? {} : { progress: copiedProgress }),
    ...(copiedArtifact === undefined ? {} : { artifact: copiedArtifact }),
    ...(copiedFailure === undefined ? {} : { failure: copiedFailure }),
    recoveryActions: actions.map((action) => {
      const safeAction = action as Record<string, unknown>;
      return { kind: safeAction["kind"] as string, label: safeAction["label"] as string, newSpend: safeAction["newSpend"] as boolean };
    }),
  } };
}

function isSafeVideoGenerationPreviewResult(value: unknown): value is VideoGenerationPreviewBridgeResult {
  return isClosedRecord(value, ["kind"]) && value["kind"] === "opened";
}

function isSafeVideoGenerationRevalidationResult(value: unknown): value is VideoGenerationRevalidationBridgeResult {
  if (!isClosedRecord(value, ["status", "take", "durationSec"]) || value["status"] !== "ready") return false;
  return isSafeVideoGenerationTake(value["take"]) && typeof value["durationSec"] === "number" && Number.isFinite(value["durationSec"]) && value["durationSec"] > 0;
}

export function isAppBridgeRequest(x: unknown): x is AppBridgeRequest {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return (
    isAssetRequest(obj) ||
    isDocumentReadRequest(obj) ||
    isDocumentWriteRequest(obj) ||
    isDocumentSaveCopyRequest(obj) ||
    isRecoveryRequest(obj) ||
    isTemplateRequest(obj) ||
    isStateGetRequest(obj) ||
    isStateSetRequest(obj) ||
    isAppPreferenceGetRequest(obj) || isAppPreferenceSetRequest(obj) || isAppPreferenceSubscribeMessage(obj) ||
    isContextUpdateMessage(obj) ||
    isHumanEditUpdateMessage(obj) ||
    ((obj["type"] === "nautilo.app.lifecycle.register" ||
      obj["type"] === "nautilo.app.lifecycle.unregister") && Object.keys(obj).length === 1) ||
    isLiveProposalAcknowledgement(obj) ||
    isSessionAcceptProposalRequest(obj) ||
    isSessionInvalidateProposalRequest(obj) ||
    isSessionResolveProposalRequest(obj) ||
    isAssetReadRequest(obj) ||
    isAssetCancelMessage(obj) ||
    isMediaPickRequest(obj) ||
    isMediaImportVideoRequest(obj) ||
    isMediaExportRequest(obj) ||
    isMediaExportCapabilitiesRequest(obj) ||
    isMediaPromotionRequest(obj) ||
    isMediaOpenPromotionRequest(obj) ||
    isMediaPromotionCapabilitiesRequest(obj) ||
    isMediaOpenPreviewRequest(obj) ||
    isMediaClosePreviewRequest(obj) ||
    isMediaCancelMessage(obj) ||
    isVideoHostLayoutRequest(obj) ||
    isVideoGenerationRequest(obj) ||
    isVideoGenerationReadRequest(obj) ||
    isVideoGenerationImportReferenceRequest(obj)
  );
}

function isTemplateRequest(obj: Record<string, unknown>): obj is AppTemplateRequest {
  if (obj["type"] !== "nautilo.app.templates.req" || !isNonEmptyString(obj["requestId"])) return false;
  const common = ["type", "requestId", "op"];
  switch (obj["op"]) {
    case "list": return Object.keys(obj).every(key => common.includes(key));
    case "read": case "remove":
      return isNonEmptyString(obj["templateId"]) && Object.keys(obj).every(key => [...common, "templateId"].includes(key));
    case "save":
      return isNonEmptyString(obj["name"]) && isNonEmptyString(obj["content"]) &&
        Object.keys(obj).every(key => [...common, "name", "content"].includes(key));
    default: return false;
  }
}

function parseAcceptedOperationIndexes(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const indexes: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) return null;
    indexes.push(item);
  }
  return indexes;
}

function scopedRoomOpts(target: OpenFileTarget | undefined): { roomId?: string } | undefined {
  if (target?.kind === "artifact" && target.roomId !== undefined && target.roomId.length > 0) {
    return { roomId: target.roomId };
  }
  return undefined;
}

function requireBoundTarget(target: OpenFileTarget | undefined): OpenFileTarget {
  if (!target) {
    throw new BridgeError("No document is bound to this app.");
  }
  return target;
}

function requireArtifactTarget(target: OpenFileTarget | undefined): Extract<OpenFileTarget, { kind: "artifact" }> {
  const bound = requireBoundTarget(target);
  if (bound.kind !== "artifact") {
    throw new BridgeError("App state is only supported for workspace artifact documents.");
  }
  return bound;
}

function parseWriteContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const content = (value as Record<string, unknown>)["content"];
    if (typeof content === "string") return content;
  }
  throw new BridgeError("Write value must be a string or { content: string }.");
}

function newClientMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mutation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newPatchRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `patch-req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function broaderRetryPatch(
  baseContent: string,
  nextContent: string,
  firstPatch: { oldString: string; newString: string; scope?: AnchoredTextPatch["scope"] },
): ReturnType<typeof deriveAnchoredTextPatch> {
  const lineCount = baseContent.length === 0 ? 0 : baseContent.split("\n").length;
  if (lineCount === 0) return null;
  const broad = deriveAnchoredTextPatch(baseContent, nextContent, { from: 1, to: lineCount });
  if (!broad) return null;
  if (broad.oldString !== firstPatch.oldString || broad.newString !== firstPatch.newString) {
    return broad;
  }
  // Same anchor text — retry once with explicit whole-document scope when the first
  // attempt used an unscoped patch.
  if (!firstPatch.scope && broad.scope) {
    return broad;
  }
  return null;
}

function rememberEnvelope(
  session: AppDocumentWriteSession | undefined,
  envelope: AppDocumentEnvelope,
  target?: OpenFileTarget,
): void {
  if (!session) return;
  session.envelope = envelope;
  if (target) session.documentTargetKey = boundDocumentTargetKey(target);
  session.documentReadGeneration = (session.documentReadGeneration ?? 0) + 1;
  session.documentReadPromise = undefined;
}

export function resetDocumentReadSession(session: AppDocumentWriteSession): void {
  session.envelope = null;
  session.documentTargetKey = undefined;
  session.documentReadGeneration = (session.documentReadGeneration ?? 0) + 1;
  session.documentReadPromise = undefined;
}

function boundDocumentTargetKey(target: OpenFileTarget | undefined): string {
  const bound = requireBoundTarget(target);
  if (bound.kind === "artifact") {
    return `artifact:${bound.roomId ?? ""}:${bound.id}:${bound.path}:${bound.reloadToken ?? ""}`;
  }
  return `fs:${bound.rootPath}:${bound.path}:${bound.reloadToken ?? ""}`;
}

/**
 * Return the session's initial document envelope. Concurrent reads of the same
 * bound target share the underlying metadata/bytes request; a failed read is
 * deliberately not retained so a later caller can retry.
 */
export function readDocumentSession(
  session: AppDocumentWriteSession,
  target: OpenFileTarget | undefined,
): Promise<AppDocumentEnvelope> {
  const targetKey = boundDocumentTargetKey(target);
  if (session.documentTargetKey !== targetKey) {
    resetDocumentReadSession(session);
    session.documentTargetKey = targetKey;
  }
  if (session.envelope) return Promise.resolve(session.envelope);
  if (session.documentReadPromise) return session.documentReadPromise;

  const generation = session.documentReadGeneration ?? 0;
  const promise = readBoundDocument(target)
    .then((envelope) => {
      if (
        session.documentTargetKey === targetKey &&
        session.documentReadGeneration === generation
      ) {
        session.envelope = envelope;
      }
      return envelope;
    })
    .finally(() => {
      if (session.documentReadPromise === promise) {
        session.documentReadPromise = undefined;
      }
    });
  session.documentReadPromise = promise;
  return promise;
}

/**
 * Apply an external editor patch to a host-held bridge session and return a
 * sanitized iframe payload, or null when the patch cannot apply. The input can
 * be either a legacy patch projection or a durable committed editor save.
 */
export function applyDocumentPatchToWriteSession(
  session: AppDocumentWriteSession,
  event: ExternalDocumentPatchEvent,
  opts?: { path?: string; mimeType?: string },
): AppDocumentPatchAppliedEvent | null {
  const remembered = session.envelope;
  if (!remembered) return null;

  const applied = applyAnchoredTextPatch(remembered.content, event.patch);
  if (!applied.ok) return null;
  return commitDocumentPatchToWriteSession(session, event, remembered, applied.text, opts);
}

function commitDocumentPatchToWriteSession(
  session: AppDocumentWriteSession,
  event: ExternalDocumentPatchEvent,
  remembered: AppDocumentEnvelope,
  content: string,
  opts?: { path?: string; mimeType?: string },
): AppDocumentPatchAppliedEvent {
  const path = opts?.path ?? remembered.path;
  const mimeType = opts?.mimeType ?? remembered.mimeType;

  const envelope: AppDocumentEnvelope = {
    content,
    mimeType,
    path,
    baseSha256: event.sha256,
    baseRevision: event.revision,
    ...(remembered.localIdentity ? { localIdentity: remembered.localIdentity } : {}),
  };
  rememberEnvelope(session, envelope);

  return {
    type: "patch_applied",
    path,
    patchId: event.patchId,
    revision: event.revision,
    sha256: event.sha256,
    previousRevision: event.previousRevision,
    previousSha256: event.previousSha256,
    patch: event.patch,
    ...(event.author ? { author: event.author } : {}),
    ...(event.rebased !== undefined ? { rebased: event.rebased } : {}),
    envelope: {
      content,
      mimeType,
      path,
      baseSha256: event.sha256,
      baseRevision: event.revision,
    },
  };
}

/** Apply only when the retained predecessor and derived postimage are exact. */
export async function applyVerifiedDocumentPatchToWriteSession(
  session: AppDocumentWriteSession,
  event: ExternalDocumentPatchEvent,
  opts?: { path?: string; mimeType?: string },
): Promise<AppDocumentPatchAppliedEvent | null> {
  const remembered = session.envelope;
  if (!remembered) return null;
  const rememberedContent = remembered.content;
  const rememberedSha = remembered.baseSha256;
  const rememberedRevision = remembered.baseRevision;
  if (
    rememberedSha !== event.previousSha256 ||
    (event.previousRevision !== null &&
      rememberedRevision !== event.previousRevision)
  ) return null;
  const generation = session.documentReadGeneration ?? 0;
  const applied = applyAnchoredTextPatch(rememberedContent, event.patch);
  if (!applied.ok || await sha256HexForText(applied.text) !== event.sha256) return null;
  if (
    session.envelope !== remembered ||
    session.envelope.content !== rememberedContent ||
    session.envelope.baseSha256 !== rememberedSha ||
    session.envelope.baseRevision !== rememberedRevision ||
    (session.documentReadGeneration ?? 0) !== generation
  ) return null;
  return commitDocumentPatchToWriteSession(session, event, remembered, applied.text, opts);
}

async function writeArtifactSnapshot(
  bound: ArtifactTarget,
  content: string,
  base: { sha256: string | null; revision: number | null },
  session: AppDocumentWriteSession | undefined,
): Promise<AppDocumentWriteResult> {
  const clientMutationId = newClientMutationId();
  registerLocalArtifactSaveMutation(clientMutationId);
  const result = await saveEditableText(
    bound,
    content,
    { sha256: base.sha256, revision: base.revision },
    true,
    { clientMutationId },
  );
  settleLocalArtifactSaveMutation(clientMutationId, result.kind === "saved");

  if (result.kind === "saved") {
    rememberEnvelope(session, {
      content,
      mimeType: bound.mimeType,
      path: bound.path,
      baseSha256: result.newSha256,
      baseRevision: result.revision ?? null,
    }, bound);
    return {
      kind: "saved",
      sha256: result.newSha256,
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
      path: bound.path,
    };
  }
  if (result.kind === "conflict") {
    return { kind: "conflict", currentSha256: result.currentSha256 };
  }
  return { kind: "error", message: result.message };
}

async function writeArtifactWithPatch(
  bound: ArtifactTarget,
  content: string,
  opts: WriteBoundDocumentOpts,
): Promise<AppDocumentWriteResult> {
  const session = opts.session;
  let remembered = session?.envelope;

  if (remembered && remembered.path !== bound.path) {
    remembered = null;
  }

  let baseContent: string;
  let baseSha256: string | null;
  let baseRevision: number | null;

  if (remembered) {
    baseContent = remembered.content;
    baseSha256 = remembered.baseSha256;
    baseRevision = remembered.baseRevision;
  } else {
    const current = session
      ? await readDocumentSession(session, bound)
      : await readBoundDocument(bound);
    if (opts.baseSha256 && opts.baseSha256 !== current.baseSha256) {
      return { kind: "conflict", currentSha256: current.baseSha256 };
    }
    baseContent = current.content;
    baseSha256 = current.baseSha256;
    baseRevision = current.baseRevision;
    rememberEnvelope(session, current, bound);
  }

  if (baseContent === content) {
    if (baseSha256) {
      return {
        kind: "saved",
        sha256: baseSha256,
        ...(baseRevision !== null ? { revision: baseRevision } : {}),
        path: bound.path,
      };
    }
    const sha = await sha256HexForText(content);
    rememberEnvelope(session, {
      content,
      mimeType: bound.mimeType,
      path: bound.path,
      baseSha256: sha,
      baseRevision: baseRevision,
    }, bound);
    return { kind: "saved", sha256: sha, ...(baseRevision !== null ? { revision: baseRevision } : {}), path: bound.path };
  }

  const patch = deriveAnchoredTextPatch(baseContent, content);
  if (!patch) {
    if (opts.allowSnapshotFallback && baseContent.length === 0) {
      return writeArtifactSnapshot(bound, content, {
        sha256: baseSha256,
        revision: baseRevision,
      }, session);
    }
    return { kind: "error", message: "Could not derive a patch for this edit." };
  }

  if (!baseSha256) {
    if (opts.allowSnapshotFallback && baseContent.length === 0) {
      return writeArtifactSnapshot(bound, content, {
        sha256: baseSha256,
        revision: baseRevision,
      }, session);
    }
    return { kind: "error", message: "Missing base SHA for patch write." };
  }

  const clientMutationId = newClientMutationId();
  registerLocalArtifactSaveMutation(clientMutationId);

  const roomOpts = scopedRoomOpts(bound);
  const patchBody = {
    requestId: newPatchRequestId(),
    target: {
      kind: "artifact" as const,
      artifactInternalId: bound.id,
      path: bound.path,
      ...(bound.roomId !== undefined ? { roomId: bound.roomId } : {}),
      mimeType: bound.mimeType,
    },
    baseRevision: baseRevision,
    baseSha256,
    patch,
    clientMutationId,
    checkpoint: true,
    mimeType: bound.mimeType,
  };

  const applyPatch = async (body: typeof patchBody) =>
    roomOpts !== undefined
      ? apiClient.applyWorkspaceArtifactPatch(bound.id, body, roomOpts)
      : apiClient.applyWorkspaceArtifactPatch(bound.id, body);

  try {
    const applied = await applyPatch(patchBody);
    settleLocalArtifactSaveMutation(clientMutationId, true);
    const canonicalContent = applied.content ?? content;
    return finishArtifactPatchWrite(
      bound,
      content,
      canonicalContent,
      applied.sha256,
      applied.revision,
      session,
      applied.content !== undefined,
    );
  } catch (err) {
    if (err instanceof DocumentPatchConflictError) {
      const rejection = err.rejection;
      if (
        rejection.kind === "anchor_not_found" ||
        rejection.kind === "anchor_ambiguous" ||
        rejection.kind === "stale_base_unrebaseable"
      ) {
        const retryPatch = broaderRetryPatch(baseContent, content, patch);
        if (retryPatch) {
          settleLocalArtifactSaveMutation(clientMutationId, false);
          const retryClientMutationId = newClientMutationId();
          registerLocalArtifactSaveMutation(retryClientMutationId);
          try {
            const applied = await applyPatch({
              ...patchBody,
              requestId: newPatchRequestId(),
              clientMutationId: retryClientMutationId,
              patch: retryPatch,
            });
            settleLocalArtifactSaveMutation(retryClientMutationId, true);
            const canonicalContent = applied.content ?? content;
            return finishArtifactPatchWrite(
              bound,
              content,
              canonicalContent,
              applied.sha256,
              applied.revision,
              session,
              applied.content !== undefined,
            );
          } catch (retryErr) {
            settleLocalArtifactSaveMutation(retryClientMutationId, false);
            if (retryErr instanceof DocumentPatchConflictError) {
              return mapPatchConflict(retryErr);
            }
            return {
              kind: "error",
              message: retryErr instanceof Error ? retryErr.message : String(retryErr),
            };
          }
        }
      }
      settleLocalArtifactSaveMutation(clientMutationId, false);
      return mapPatchConflict(err);
    }
    settleLocalArtifactSaveMutation(clientMutationId, false);
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function mapPatchConflict(err: DocumentPatchConflictError): AppDocumentWriteResult {
  const rejection = err.rejection;
  if (
    rejection.kind === "unsupported" ||
    rejection.kind === "forbidden" ||
    rejection.kind === "too_large"
  ) {
    const message =
      rejection.kind === "too_large" ||
      rejection.kind === "forbidden" ||
      rejection.kind === "unsupported"
        ? rejection.reason
        : "Document patch rejected.";
    return { kind: "error", message };
  }
  return { kind: "conflict", currentSha256: rejection.latestSha256 };
}

function finishArtifactPatchWrite(
  bound: ArtifactTarget,
  submittedContent: string,
  canonicalContent: string,
  sha256: string,
  revision: number | null,
  session: AppDocumentWriteSession | undefined,
  canonicalFromServer: boolean,
): AppDocumentWriteResult {
  rememberEnvelope(session, {
    content: canonicalContent,
    mimeType: bound.mimeType,
    path: bound.path,
    baseSha256: sha256,
    baseRevision: revision,
  }, bound);
  const includePersistedContent =
    canonicalFromServer || canonicalContent !== submittedContent;
  return {
    kind: "saved",
    sha256,
    ...(revision !== null ? { revision } : {}),
    ...(includePersistedContent ? { persistedContent: canonicalContent } : {}),
    path: bound.path,
  };
}

export async function readBoundDocument(
  target: OpenFileTarget | undefined,
): Promise<AppDocumentEnvelope> {
  const bound = requireBoundTarget(target);

  if (bound.kind === "artifact") {
    const roomOpts = scopedRoomOpts(bound);
    const [dto, blob] = await Promise.all([
      roomOpts !== undefined
        ? apiClient.getWorkspaceArtifact(bound.id, roomOpts)
        : apiClient.getWorkspaceArtifact(bound.id),
      roomOpts !== undefined
        ? apiClient.getWorkspaceArtifactBytes(bound.id, roomOpts)
        : apiClient.getWorkspaceArtifactBytes(bound.id),
    ]);
    if (blob.size > MAX_APP_DOCUMENT_BYTES) {
      throw new BridgeError("Document is too large to read.");
    }
    const content = await blob.text();
    return {
      content,
      mimeType: bound.mimeType,
      path: dto?.path ?? bound.path,
      baseSha256: await sha256HexForText(content),
      baseRevision: dto?.revision ?? null,
    };
  }

  if (!desktop.desktopAPI) {
    throw new BridgeError("Desktop file bridge unavailable.");
  }

  const stat = await desktop.desktopAPI.fs.stat(bound.path);
  if (!stat.exists) {
    throw new BridgeError("File no longer exists.");
  }
  if (stat.size > MAX_APP_DOCUMENT_BYTES) {
    throw new BridgeError("Document is too large to read.");
  }

  const content = await desktop.desktopAPI.fs.readFile(bound.path);
  return {
    content,
    mimeType: "",
    path: fsBoundDisplayPath(bound),
    baseSha256: await sha256HexForText(content),
    baseRevision: null,
    ...(stat.documentIdentity ? { localIdentity: stat.documentIdentity } : {}),
  };
}

export async function statBoundDocument(
  target: OpenFileTarget | undefined,
): Promise<AppDocumentStat> {
  const bound = requireBoundTarget(target);

  if (bound.kind === "artifact") {
    const roomOpts = scopedRoomOpts(bound);
    const [dto, blob] = await Promise.all([
      roomOpts !== undefined
        ? apiClient.getWorkspaceArtifact(bound.id, roomOpts)
        : apiClient.getWorkspaceArtifact(bound.id),
      roomOpts !== undefined
        ? apiClient.getWorkspaceArtifactBytes(bound.id, roomOpts)
        : apiClient.getWorkspaceArtifactBytes(bound.id),
    ]);

    let sha256: string | null = null;
    if (blob.size <= MAX_APP_DOCUMENT_BYTES) {
      const content = await blob.text();
      sha256 = await sha256HexForText(content);
    }

    return {
      kind: "artifact",
      path: bound.path,
      mimeType: bound.mimeType,
      sha256,
      revision: dto?.revision ?? null,
      size: blob.size,
    };
  }

  if (!desktop.desktopAPI) {
    throw new BridgeError("Desktop file bridge unavailable.");
  }

  const stat = await desktop.desktopAPI.fs.stat(bound.path);
  if (!stat.exists) {
    return {
      kind: "fs",
      path: fsBoundDisplayPath(bound),
      mimeType: null,
      sha256: null,
      revision: null,
      size: stat.size,
    };
  }

  let sha256: string | null = null;
  if (stat.isFile && stat.size <= MAX_APP_DOCUMENT_BYTES) {
    const content = await desktop.desktopAPI.fs.readFile(bound.path);
    sha256 = await sha256HexForText(content);
  }

  return {
    kind: "fs",
    path: fsBoundDisplayPath(bound),
    mimeType: null,
    sha256,
    revision: null,
    size: stat.size,
  };
}

export async function writeBoundDocument(
  target: OpenFileTarget | undefined,
  value: unknown,
  opts: WriteBoundDocumentOpts = {},
): Promise<AppDocumentWriteResult> {
  const bound = requireBoundTarget(target);
  const content = parseWriteContent(value);
  if (bound.kind === "artifact") {
    if (opts.conflictPolicy === "strict") {
      if (!opts.baseSha256 || !Number.isSafeInteger(opts.baseRevision)) {
        return { kind: "error", message: "An exact document revision is required for this save." };
      }
      // Keep the caller's revision through to storage CAS, even if an event
      // advanced the host cache while this write waited in the bridge lane.
      return writeArtifactSnapshot(bound, content, { sha256: opts.baseSha256, revision: opts.baseRevision ?? null }, opts.session);
    }
    return writeArtifactWithPatch(bound, content, opts);
  }

  const clientMutationId = newClientMutationId();
  registerLocalArtifactSaveMutation(clientMutationId);
  const result = await saveEditableText(
    bound,
    content,
    {
      sha256: opts.baseSha256 ?? null,
      revision: opts.baseRevision ?? null,
    },
    true,
    { clientMutationId },
  );
  settleLocalArtifactSaveMutation(clientMutationId, result.kind === "saved");

  if (result.kind === "saved") {
    registerLocalFsSaveSha(bound.path, result.newSha256);
    rememberEnvelope(opts.session, {
      content,
      mimeType: "",
      path: fsBoundDisplayPath(bound),
      baseSha256: result.newSha256,
      baseRevision: null,
    }, bound);
    return {
      kind: "saved",
      sha256: result.newSha256,
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
      path: fsBoundDisplayPath(bound),
    };
  }
  if (result.kind === "conflict") {
    return { kind: "conflict", currentSha256: result.currentSha256 };
  }
  return { kind: "error", message: result.message };
}

/** D342 Phase 2 — load the blank-document seed for a draft (create-action
 *  template, or empty when the app exposes no template). */
async function loadDraftTemplate(
  draft: MiniAppDraftSeed,
): Promise<{ content: string; mimeType: string }> {
  if (draft.createActionId == null) {
    return { content: "", mimeType: "text/plain" };
  }
  const tpl = await apiClient.getMiniAppCreateTemplate(draft.appId, draft.createActionId);
  return { content: tpl.content, mimeType: tpl.mimeType };
}

function draftDocumentEnvelope(
  draft: MiniAppDraftSeed,
  tpl: { content: string; mimeType: string },
): AppDocumentEnvelope {
  // A draft has no server-side base yet — null sha/revision marks it fresh.
  return {
    content: tpl.content,
    mimeType: tpl.mimeType,
    path: draft.suggestedName,
    baseSha256: null,
    baseRevision: null,
  };
}

function draftDocumentStat(
  draft: MiniAppDraftSeed,
  tpl: { content: string; mimeType: string },
): AppDocumentStat {
  return {
    kind: "artifact",
    path: draft.suggestedName,
    mimeType: tpl.mimeType,
    sha256: null,
    revision: null,
    size: tpl.content.length,
  };
}

export function postAppDocumentChanged(
  iframe: HTMLIFrameElement,
  event: AppDocumentChangedEvent,
  session?: AppDocumentWriteSession,
): void {
  // Snapshot commits (including Genie saves) carry no patch to advance the
  // host cache. Invalidate before notifying: the iframe's immediate read must
  // fetch canonical bytes, not the envelope from before the commit. Reset also
  // fences any pre-commit read still in flight. Applied patches already updated
  // the cache and must retain their verified envelope.
  if (session && event.type === "changed") resetDocumentReadSession(session);
  iframe.contentWindow?.postMessage({ type: "nautilo.app.document.changed", event }, "*");
}

/**
 * Propagate host presentation into a sandbox without exposing host storage or
 * DOM. The iframe client additionally verifies the parent source before it
 * applies this finite, non-sensitive value.
 */
export function postAppTheme(iframe: HTMLIFrameElement, theme: AppTheme): void {
  iframe.contentWindow?.postMessage({ type: "nautilo.app.presentation.theme", theme }, "*");
}

/** Sends only the opaque capability needed by a hydrated iframe. */
export function postAppLiveSession(
  iframe: HTMLIFrameElement,
  capability: AppLiveSessionCapability,
): void {
  iframe.contentWindow?.postMessage({ type: "nautilo.app.live-session", capability }, "*");
}

/**
 * Sends a validated live-review proposal directly to the mounted iframe.
 * Artifact identity and namespace binding remain host-only.
 */
export function postAppLiveProposal(
  iframe: HTMLIFrameElement,
  proposal: AppLiveProposal,
): void {
  iframe.contentWindow?.postMessage({ type: "nautilo.app.live-proposal", proposal }, "*");
}

export function postAppLiveSessionClosed(
  iframe: HTMLIFrameElement,
  event: AppLiveSessionClosedMessage,
): void {
  iframe.contentWindow?.postMessage({ type: "nautilo.app.live-session.closed", ...event }, "*");
}

export async function getAppState(
  appId: string,
  target: OpenFileTarget | undefined,
  key: string,
): Promise<unknown> {
  const artifact = requireArtifactTarget(target);
  const scopedOpts = scopedRoomOpts(artifact);
  try {
    const res = await apiClient.getArtifactState(
      artifact.id,
      appStateKey(appId, key),
      scopedOpts,
    );
    return res.value;
  } catch (err: unknown) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) return undefined;
    throw err;
  }
}

export async function setAppState(
  appId: string,
  target: OpenFileTarget | undefined,
  key: string,
  value: unknown,
): Promise<void> {
  const artifact = requireArtifactTarget(target);
  const scopedOpts = scopedRoomOpts(artifact);
  await apiClient.setArtifactState(
    artifact.id,
    appStateKey(appId, key),
    value,
    scopedOpts,
  );
}

function isNautiloAppMessageType(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("nautilo.app.");
}

/** Response traffic belongs to the dedicated host export requester. */
function isMiniAppExportResultEnvelope(obj: Record<string, unknown>): boolean {
  if (
    obj["type"] !== "nautilo.app.export.prepare.result" ||
    typeof obj["requestId"] !== "string" ||
    obj["requestId"].length === 0 ||
    typeof obj["ok"] !== "boolean"
  ) return false;
  const allowed = obj["ok"] === true
    ? new Set(["type", "requestId", "ok", "result"])
    : new Set(["type", "requestId", "ok", "error"]);
  if (!Object.keys(obj).every((key) => allowed.has(key))) return false;
  return obj["ok"] === true
    ? Object.prototype.hasOwnProperty.call(obj, "result")
    : typeof obj["error"] === "string";
}

function bridgeMessageLogSummary(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    type: typeof obj["type"] === "string" ? obj["type"] : typeof obj["type"],
    requestId:
      typeof obj["requestId"] === "string" ? obj["requestId"] : typeof obj["requestId"],
    op: typeof obj["op"] === "string" ? obj["op"] : typeof obj["op"],
    keys: Object.keys(obj).sort(),
    ...(typeof obj["acceptedContent"] === "string"
      ? { acceptedContent: `[redacted:${obj["acceptedContent"].length} chars]` }
      : {}),
  };
}

function postBridgeResponse(
  iframe: HTMLIFrameElement,
  requestId: string,
  payload: { ok: true; value: unknown } | { ok: false; error: string; status?: number },
): void {
  const target = iframe.contentWindow;
  if (!target) return;
  target.postMessage({ type: "nautilo.app.res", requestId, ...payload }, "*");
}

const MAX_RASTER_ASSET_BYTES = 10 * 1024 * 1024;

export function resolveBoundRasterPath(target: Extract<OpenFileTarget, { kind: "fs" }>, ref: string): string | null {
  if (new TextEncoder().encode(ref).byteLength > 512 || ref.length === 0) return null;
  if (ref.startsWith("/") || ref.includes("\\") || ref.includes(":")) return null;
  if ([...ref].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) return null;
  const segments = ref.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  const slash = target.path.lastIndexOf("/");
  if (slash < 0) return null;
  return `${target.path.slice(0, slash + 1)}${segments.join("/")}`;
}

export function rasterMimeType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

function postAssetReady(
  iframe: HTMLIFrameElement,
  requestId: string,
  mimeType: string,
  source: ArrayBuffer,
): void {
  const target = iframe.contentWindow;
  if (!target) return;
  const bytes = new Uint8Array(source.slice(0));
  target.postMessage(
    { type: "nautilo.app.res", requestId, ok: true, value: { kind: "ready", mimeType, sizeBytes: bytes.byteLength, bytes } },
    "*",
    [bytes.buffer],
  );
}
function postAppPreferenceChanged(iframe: HTMLIFrameElement, key: AppPreferenceKey, value: AppPreferenceValue): void {
  iframe.contentWindow?.postMessage({ type: "nautilo.app.preferences.changed", key, value }, "*");
}

function postAcceptProposalBridgeResponse(
  iframe: HTMLIFrameElement,
  requestId: string,
  payload: AcceptProposalBridgeSuccess | AcceptProposalBridgeFailure,
): void {
  const target = iframe.contentWindow;
  if (!target) return;
  target.postMessage({ type: "nautilo.app.res", requestId, ...payload }, "*");
}

/**
 * Install the postMessage handler on the parent window. Returns a teardown
 * function the caller invokes on unmount.
 */
export function installAppBridge(opts: AppBridgeOptions): () => void {
  const {
    iframe,
    appId,
    viewerKey,
    target,
    onContextUpdate,
    onHumanEditUpdate,
    onLifecycleRegistrationChange,
    draft,
    materialize,
    saveCopy,
    documentSession: sharedDocumentSession,
    onDocumentVersion,
    getLiveSession,
    onLiveProposalAccepted,
    onLiveProposalAcknowledged,
    assetReadRaster,
    mediaProxy,
    videoGeneration,
    onVideoWorkspaceMediaImport,
    onVideoMediaPick,
    onVideoWorkspaceMediaExport,
    onVideoProjectPromotion,
    onOpenPromotedVideoProject,
    workspaceCopyRoomLabel,
    onVideoWorkspaceMediaOpenPreview,
    onVideoWorkspaceMediaClosePreview,
    onVideoHostLayout,
    onVideoGenerationRequest,
    onVideoGenerationListTakes,
    onVideoGenerationGetTakeStatus,
    onVideoGenerationPreviewTake,
    onVideoGenerationRevalidateTake,
    onVideoGenerationImportReference,
    onVideoGenerationImportReferences,
  } = opts;

  // D342 Phase 2 — draft state. `activeTarget` starts unbound for a draft and
  // is set the moment the draft materializes; single-flight promises ensure the
  // template is fetched once and the artifact is created exactly once even under
  // concurrent writes.
  let activeTarget: OpenFileTarget | undefined = target;
  let templatePromise: Promise<{ content: string; mimeType: string }> | null = null;
  let materializePromise: Promise<ArtifactTarget> | null = null;
  const documentSession: AppDocumentWriteSession = sharedDocumentSession ?? { envelope: null };
  const subscribedPreferenceKeys = new Set<AppPreferenceKey>();
  const assetReadControllers = new Map<string, AbortController>();
  const mediaProxyRequests = new Set<string>();
  const mediaProxyTokens = new Set<string>();
  const workspaceMediaPreviewTokens = new Set<string>();
  const workspaceMediaPreviewRequests = new Map<string, AbortController>();
  const workspaceMediaExportRequests = new Map<string, AbortController>();
  let bridgeDisposed = false;
  const unsubscribePreferences = subscribeAppPreferences(viewerKey, appId, (key, value) => {
    if (subscribedPreferenceKeys.has(key)) postAppPreferenceChanged(iframe, key, value);
  });

  type PendingWriteEntry = {
    requestId: string;
    respond: (
      payload: { ok: true; value: unknown } | { ok: false; error: string; status?: number },
    ) => void;
  };

  type PendingWriteBatch = {
    content: string;
    baseSha256?: string | null;
    baseRevision?: number | null;
    conflictPolicy?: "strict";
    entries: PendingWriteEntry[];
  };

  let writeProcessing = false;
  let pendingWriteBatch: PendingWriteBatch | null = null;

  const flushPendingWrites = async (): Promise<void> => {
    if (writeProcessing) return;
    writeProcessing = true;
    try {
      while (pendingWriteBatch) {
        const batch = pendingWriteBatch;
        pendingWriteBatch = null;
        try {
          const result = await writeBoundDocument(activeTarget, batch.content, {
            baseSha256: batch.baseSha256,
            baseRevision: batch.baseRevision,
            conflictPolicy: batch.conflictPolicy,
            session: documentSession,
          });
          if (result.kind === "saved") {
            if (typeof result.revision === "number") {
              await onDocumentVersion?.({ kind: "artifact_revision", revision: result.revision });
            } else if (activeTarget?.kind === "fs" && typeof result.sha256 === "string") {
              await onDocumentVersion?.({ kind: "local_sha", sha256: result.sha256 });
            }
          }
          for (const entry of batch.entries) {
            entry.respond({ ok: true, value: result });
          }
        } catch (err: unknown) {
          const status = err instanceof BridgeError ? err.status : (err as { status?: number })?.status;
          const message = err instanceof Error ? err.message : String(err);
          for (const entry of batch.entries) {
            entry.respond({
              ok: false,
              error: message,
              ...(typeof status === "number" ? { status } : {}),
            });
          }
        }
      }
    } finally {
      writeProcessing = false;
      if (pendingWriteBatch) {
        void flushPendingWrites();
      }
    }
  };

  const enqueueBoundWrite = (
    content: string,
    entry: PendingWriteEntry,
    opts: { baseSha256?: string | null; baseRevision?: number | null; conflictPolicy?: "strict" },
  ): void => {
    if (pendingWriteBatch) {
      pendingWriteBatch.content = content;
      pendingWriteBatch.baseSha256 = opts.baseSha256;
      pendingWriteBatch.baseRevision = opts.baseRevision;
      pendingWriteBatch.conflictPolicy = opts.conflictPolicy;
      pendingWriteBatch.entries.push(entry);
    } else {
      pendingWriteBatch = {
        content,
        baseSha256: opts.baseSha256,
        baseRevision: opts.baseRevision,
        conflictPolicy: opts.conflictPolicy,
        entries: [entry],
      };
    }
    void flushPendingWrites();
  };

  const getTemplate = (): Promise<{ content: string; mimeType: string }> => {
    if (!draft) throw new BridgeError("No document is bound to this app.");
    if (!templatePromise) templatePromise = loadDraftTemplate(draft);
    return templatePromise;
  };

  const ensureMaterialized = (content: string, mimeType: string): Promise<ArtifactTarget> => {
    if (!materialize) throw new BridgeError("No document is bound to this app.");
    if (!materializePromise) {
      const pending = materialize(content, mimeType).then((t) => {
        activeTarget = t;
        resetDocumentReadSession(documentSession);
        return t;
      });
      materializePromise = pending;
      // A failed create has no canonical target and may be retried. Once create
      // succeeds, retain the fulfilled target even if a later canonical read
      // fails, so retrying the read can never create a duplicate document.
      void pending.catch(() => {
        if (materializePromise === pending) materializePromise = null;
      });
    }
    return materializePromise;
  };

  const handler = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;

    const data: unknown = event.data;
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;
    const msgType = obj["type"];
    if (!isNautiloAppMessageType(msgType)) return;

    // requestMiniAppExport owns this parent-bound response. Its listener binds
    // request id, source window, mounted frame, and validates the byte payload.
    if (isMiniAppExportResultEnvelope(obj)) return;

    const requestId = typeof obj["requestId"] === "string" ? obj["requestId"] : undefined;

    if (rejectsHostOwnedKeys(obj)) {
      console.error(
        "[app-bridge] rejected message with host-owned top-level key",
        bridgeMessageLogSummary(obj),
      );
      if (requestId) {
        postBridgeResponse(iframe, requestId, {
          ok: false,
          error: "Message must not include host-owned fields.",
        });
      }
      return;
    }

    if (!isAppBridgeRequest(obj)) {
      console.error("[app-bridge] rejected malformed message", bridgeMessageLogSummary(obj));
      if (requestId) {
        postBridgeResponse(iframe, requestId, {
          ok: false,
          error: "Malformed app bridge message.",
        });
      }
      return;
    }

    void handleMessage(obj).catch((err: unknown) => {
      console.error("[app-bridge] handler threw", err);
      if ("requestId" in obj && typeof obj["requestId"] === "string") {
        const status = err instanceof BridgeError ? err.status : (err as { status?: number })?.status;
        postBridgeResponse(iframe, obj["requestId"], {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...(typeof status === "number" ? { status } : {}),
        });
      }
    });
  };

  async function handleMessage(msg: AppBridgeRequest): Promise<void> {
    // Use an allow-list so new bridge operations cannot silently grant a
    // preview write authority. This gate runs after source and shape validation
    // and before any filesystem, API, lifecycle, or proposal side effect.
    if (opts.mode === "preview") {
      const readable =
        (msg.type === "nautilo.app.document.req" && (msg.op === "read" || msg.op === "stat")) ||
        (msg.type === "nautilo.app.state.req" && msg.op === "get") ||
        (msg.type === "nautilo.app.preferences.req" && msg.op === "get") ||
        (msg.type === "nautilo.app.assets.req" && msg.op === "read") ||
        msg.type === "nautilo.app.asset.cancel" ||
        (msg.type === "nautilo.app.media.req" && (msg.op === "openPreview" || msg.op === "closePreview")) ||
        msg.type === "nautilo.app.media.cancel" ||
        msg.type === "nautilo.app.preferences.subscribe" ||
        msg.type === "nautilo.app.context.update";
      if (!readable) {
        if (msg.type === "nautilo.app.session.req" && msg.op === "acceptProposal") {
          postAcceptProposalBridgeResponse(iframe, msg.requestId, {
            ok: false, code: "invalid_request", message: "Preview is read-only. Open the editor to make changes.",
          });
        } else if ("requestId" in msg) {
          postBridgeResponse(iframe, msg.requestId, {
            ok: false, status: 403, error: "Preview is read-only. Open the editor to make changes.",
          });
        }
        return;
      }
    }
    if (msg.type === "nautilo.app.lifecycle.register" || msg.type === "nautilo.app.lifecycle.unregister") {
      onLifecycleRegistrationChange?.(msg.type === "nautilo.app.lifecycle.register");
      return;
    }
    if (msg.type === "nautilo.app.asset.cancel") {
      assetReadControllers.get(msg.requestId)?.abort();
      return;
    }
    if (msg.type === "nautilo.app.media.cancel") {
      workspaceMediaExportRequests.get(msg.requestId)?.abort();
      if (mediaProxyRequests.delete(msg.requestId)) {
        void desktop.desktopAPI?.mediaProxy?.cancel(msg.requestId);
        void desktop.desktopAPI?.mediaExport?.cancel(msg.requestId);
      }
      const workspaceRequest = workspaceMediaPreviewRequests.get(msg.requestId);
      if (workspaceRequest) {
        workspaceMediaPreviewRequests.delete(msg.requestId);
        workspaceRequest.abort();
      }
      return;
    }
    if (msg.type === "nautilo.app.video-host-layout.req") {
      // This is not a generic iframe layout API. Only the byte-verified
      // first-party Video runtime may ask the parent to hide or restore its
      // Genie rail. `videoGeneration` is the existing server-issued proof of
      // that exact runtime, not spend authority; layout is valid for both
      // Current Folder and Workspace documents.
      const eligible = appId === "nautilo-video" && videoGeneration === true &&
        activeTarget !== undefined &&
        onVideoHostLayout;
      if (!eligible) {
        postBridgeResponse(iframe, msg.requestId, { ok: false, error: "Host layout is unavailable.", status: 403 });
        return;
      }
      await onVideoHostLayout({ enabled: msg.enabled });
      postBridgeResponse(iframe, msg.requestId, { ok: true, value: undefined });
      return;
    }
    if (msg.type === "nautilo.app.video-generation.request") {
      // A grant is useful only to the exact attested Video runtime, bound to a
      // saved Workspace project. Current Folder never gains this capability.
      if (appId !== "nautilo-video" || videoGeneration !== true ||
          !activeTarget || activeTarget.kind !== "artifact" || !activeTarget.path.endsWith(".video.html") ||
          !onVideoGenerationRequest) {
        postBridgeResponse(iframe, msg.requestId, { ok: true, value: { kind: "unavailable", code: "unavailable" } });
        return;
      }
      const result = await onVideoGenerationRequest(msg);
      // Keep this response intentionally finite. If a parent implementation
      // violates its contract, fail closed rather than serialize authority.
      const safe = result && typeof result === "object" &&
        (result.kind === "queued" || result.kind === "cancelled" || result.kind === "expired" ||
          (result.kind === "submission-unknown" && /^take_[A-Za-z0-9_-]{16,128}$/u.test(result.takeId)) ||
          (result.kind === "unavailable" && typeof result.code === "string" && result.code.length <= 64))
        ? result
        : { kind: "unavailable" as const, code: "unavailable" };
      postBridgeResponse(iframe, msg.requestId, { ok: true, value: safe });
      return;
    }

    if (msg.type === "nautilo.app.video-generation.req") {
      // Same strict eligibility as the spend request. These operations are
      // read/preview/revalidation only, yet must not become a generic
      // Workspace artifact browser for an untrusted mini-app.
      const eligible = appId === "nautilo-video" && videoGeneration === true &&
        activeTarget?.kind === "artifact" && activeTarget.path.endsWith(".video.html");
      if (!eligible) {
        postBridgeResponse(iframe, msg.requestId, { ok: true, value: { kind: "unavailable", code: "unavailable" } });
        return;
      }
      if (msg.op === "importReferences") {
        const result = await onVideoGenerationImportReferences?.({ mediaKind: "image" });
        const safe = result?.kind === "ready" && isClosedRecord(result, ["kind", "assets", "failures"]) &&
          Array.isArray(result.assets) && result.assets.every((asset: unknown) => isClosedRecord(asset, ["artifactId", "path", "label", "mediaKind", "mimeType", "sizeBytes"]) && asset["mediaKind"] === "image" && isSafeVideoGenerationReferenceImportResult({ kind: "ready", asset })) &&
          Array.isArray(result.failures) && result.failures.every((failure: unknown) => isClosedRecord(failure, ["label", "code"]) && isSafeVideoText(failure.label) && typeof failure.code === "string" && /^[a-z_]+$/u.test(failure.code))
          ? result : { kind: "unavailable" as const, code: result?.kind === "unavailable" && isSafeVideoGenerationReferenceImportResult(result) ? result.code : "unavailable" };
        postBridgeResponse(iframe, msg.requestId, { ok: true, value: safe });
        return;
      }
      if (msg.op === "importReference") {
        const result = await onVideoGenerationImportReference?.({ mediaKind: msg.mediaKind });
        const safe = isSafeVideoGenerationReferenceImportResult(result)
          ? result
          : { kind: "unavailable" as const, code: "unavailable" };
        postBridgeResponse(iframe, msg.requestId, { ok: true, value: safe });
        return;
      }
      const takeInput = msg.takeId ? { takeId: msg.takeId } : undefined;
      const result = msg.op === "listTakes"
        ? await onVideoGenerationListTakes?.()
        : msg.op === "getTakeStatus"
          ? await onVideoGenerationGetTakeStatus?.(takeInput!)
          : msg.op === "previewTake"
            ? await onVideoGenerationPreviewTake?.(takeInput!)
            : await onVideoGenerationRevalidateTake?.(takeInput!);
      // The iframe client performs a second closed parser. Keep the bridge
      // response finite here so a parent callback cannot accidentally expose
      // receipt/provider/URL/byte authority.
      const safe = msg.op === "listTakes"
        ? isSafeVideoGenerationTakeListResult(result) ? result : { kind: "unavailable" as const, code: "unavailable" }
        : msg.op === "getTakeStatus"
          ? canonicalVideoGenerationTakeStatus(result, msg.takeId!) ?? { kind: "unavailable" as const, code: "unavailable" }
          : msg.op === "previewTake"
            ? isSafeVideoGenerationPreviewResult(result) ? result : { kind: "unavailable" as const, code: "unavailable" }
            : isSafeVideoGenerationRevalidationResult(result) ? result : { status: "unavailable" as const, takeId: msg.takeId! };
      postBridgeResponse(iframe, msg.requestId, { ok: true, value: safe });
      return;
    }

    if (msg.type === "nautilo.app.context.update") {
      onContextUpdate?.({
        appId,
        target: activeTarget,
        summary: normalizeAppContextSummary(msg.summary),
        updatedAt: Date.now(),
      });
      return;
    }

    if (msg.type === "nautilo.app.human-edit.update") {
      onHumanEditUpdate?.(msg.update);
      return;
    }
    if (msg.type === "nautilo.app.live-proposal.ack") {
      const documentVersion = parseLiveDocumentVersion(msg.documentVersion);
      if (!documentVersion) return;
      onLiveProposalAcknowledged?.({ proposalId: msg.proposalId, documentVersion });
      return;
    }
    if (msg.type === "nautilo.app.session.req" && msg.op === "invalidateProposal") {
      try {
        const documentVersion = parseLiveDocumentVersion(msg.documentVersion);
        if (!documentVersion) {
          throw new BridgeError("Writer review version is invalid.", 409);
        }
        const result = await apiClient.invalidateLiveProposalReview(appId, {
          sessionToken: msg.proposalSessionToken,
          proposalId: msg.proposalId,
          documentVersion,
          reason: msg.reason,
        });
        postBridgeResponse(iframe, msg.requestId, { ok: true, value: result });
      } catch (err: unknown) {
        const status = err instanceof BridgeError ? err.status : (err as { status?: number })?.status;
        postBridgeResponse(iframe, msg.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : "Writer review invalidation failed.",
          ...(typeof status === "number" ? { status } : {}),
        });
      }
      return;
    }
    if (msg.type === "nautilo.app.session.req" && msg.op === "resolveProposal") {
      try {
        const bound = activeTarget;
        const liveSession = getLiveSession?.();
        const documentVersion = parseLiveDocumentVersion(msg.documentVersion);
        if (!bound || !liveSession || !documentVersion) {
          throw new BridgeError("No live review session is active.", 409);
        }
        let resultDocumentVersion: LiveDocumentVersion | undefined;
        if (msg.outcome === "accepted") {
          if (bound.kind === "artifact") {
            const revision = documentSession.envelope?.baseRevision;
            if (typeof revision !== "number") {
              throw new BridgeError("Accepted Writer revision is unavailable.", 409);
            }
            resultDocumentVersion = { kind: "artifact_revision", revision };
          } else {
            resultDocumentVersion = liveSession.documentVersion;
          }
          if (liveDocumentVersionEquals(resultDocumentVersion, documentVersion)) {
            throw new BridgeError("Writer acceptance did not advance the document version.", 409);
          }
        } else if (!liveDocumentVersionEquals(liveSession.documentVersion, documentVersion)) {
          throw new BridgeError("Writer review version is stale.", 409);
        }
        const result = await apiClient.resolveLiveProposalReview(appId, {
          sessionToken: liveSession.sessionToken,
          proposalId: msg.proposalId,
          documentVersion,
          outcome: msg.outcome,
          ...(resultDocumentVersion ? { resultDocumentVersion } : {}),
        });
        postBridgeResponse(iframe, msg.requestId, { ok: true, value: result });
      } catch (err: unknown) {
        const status = err instanceof BridgeError ? err.status : (err as { status?: number })?.status;
        postBridgeResponse(iframe, msg.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : "Writer review resolution failed.",
          ...(typeof status === "number" ? { status } : {}),
        });
      }
      return;
    }
    if (msg.type === "nautilo.app.preferences.subscribe") {
      if (canAccessAppPreference(appId, msg.key)) subscribedPreferenceKeys.add(msg.key);
      return;
    }

    if (msg.type === "nautilo.app.session.req" && msg.op === "acceptProposal") {
      const respondFailure = (err: unknown): void => {
        postAcceptProposalBridgeResponse(iframe, msg.requestId, mapAcceptProposalBridgeFailure(err));
      };
      try {
        const bound = activeTarget;
        if (!bound || (bound.kind !== "fs" && bound.kind !== "artifact")) {
          throw new BridgeError("Live proposal acceptance is unavailable for this document.");
        }
        const liveSession = getLiveSession?.();
        if (!liveSession) {
          throw new BridgeError("No live review session is active.");
        }
        const documentVersion = parseLiveDocumentVersion(msg.documentVersion);
        if (!documentVersion || !liveDocumentVersionEquals(documentVersion, liveSession.documentVersion)) {
          throw new BridgeError("Live review session version is stale.", 409);
        }
        const acceptedOperationIndexes = parseAcceptedOperationIndexes(msg.acceptedOperationIndexes);
        if (!acceptedOperationIndexes) {
          throw new BridgeError("acceptedOperationIndexes must be a non-empty array of indexes.");
        }
        const acceptedContent = msg.acceptedContent;
        registerPendingAcceptMutation(msg.requestId);
        let result: ApplyAcceptedLiveProposalResponse;
        try {
          result = await apiClient.applyAcceptedLiveProposal(appId, {
            requestId: msg.requestId,
            sessionToken: liveSession.sessionToken,
            proposalId: msg.proposalId,
            documentVersion,
            acceptedContent,
            acceptedOperationIndexes,
          });
        } catch (err) {
          failPendingAcceptMutation(msg.requestId);
          respondFailure(err);
          return;
        }
        rememberEnvelope(documentSession, {
          content: acceptedContent,
          mimeType: "",
          path: bound.kind === "fs" ? fsBoundDisplayPath(bound) : bound.path,
          baseSha256: result.contentSha256,
          baseRevision: result.documentVersion.kind === "artifact_revision"
            ? result.documentVersion.revision
            : null,
        }, bound);
        markPendingAcceptMutationSucceeded(msg.requestId);
        onLiveProposalAccepted?.(result);
        postAcceptProposalBridgeResponse(iframe, msg.requestId, {
          ok: true,
          value: {
            ok: true,
            documentVersion: result.documentVersion,
            contentSha256: result.contentSha256,
            localRevisionRef: result.localRevisionRef,
          },
        });
      } catch (err: unknown) {
        respondFailure(err);
      }
      return;
    }

    const respond = (
      payload: { ok: true; value: unknown } | { ok: false; error: string; status?: number },
    ): void => {
      postBridgeResponse(iframe, msg.requestId, payload);
    };

    // D342 Phase 2 — a draft (no bound target yet) reads/stats off the template
    // and materializes a workspace artifact on the first write/state-set.
    // `unboundDraft` narrows to the seed only while still unmaterialized.
    const unboundDraft = activeTarget === undefined ? draft : undefined;

    try {
      if (msg.type === "nautilo.app.templates.req") {
        if (appId !== "nautilo-presentation" || !opts.templates) throw new BridgeError("Slide templates are unavailable for this app.", 403);
        let value: unknown;
        switch (msg.op) {
          case "list": value = await opts.templates.list(); break;
          case "read": value = await opts.templates.read(msg.templateId); break;
          case "save": value = await opts.templates.save({ name: msg.name, content: msg.content }); break;
          case "remove": value = await opts.templates.remove(msg.templateId); break;
        }
        respond({ ok: true, value });
        return;
      }
      if (msg.type === "nautilo.app.recovery.req") {
        if ((appId !== "nautilo-presentation" && appId !== "nautilo-board") || !opts.recovery) throw new BridgeError("Crash recovery is unavailable for this app.");
        if (unboundDraft && (msg.op === "read" || msg.input.draft === null)) {
          respond({ ok: true, value: msg.op === "read" ? { revision: null, draft: null } : { revision: null } });
          return;
        }
        if (unboundDraft) {
          throw new BridgeError("Save this new document once to enable crash recovery.");
        }
        if (!activeTarget) throw new BridgeError("No document is bound for recovery.");
        respond({ ok: true, value: msg.op === "read"
          ? await opts.recovery.read(activeTarget)
          : await opts.recovery.write(activeTarget, msg.input) });
        return;
      }
      if (msg.type === "nautilo.app.assets.req") {
        if (!opts.assets) throw new BridgeError("Image access is unavailable for this app version.");
        respond({ ok: true, value: msg.op === "pick" ? await opts.assets.pick() : await opts.assets.read(msg.ref) });
        return;
      }
      if (msg.type === "nautilo.app.asset.req") {
        if (assetReadRaster !== true) throw new BridgeError("Asset access is unavailable.", 403);
        if (!activeTarget) throw new BridgeError("No document is bound to this app.");
        if (activeTarget.kind !== "fs") {
          respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
          return;
        }
        const path = resolveBoundRasterPath(activeTarget, msg.ref);
        if (!path) {
          respond({ ok: true, value: { kind: "unavailable", code: "invalid_ref" } });
          return;
        }
        const controller = new AbortController();
        assetReadControllers.set(msg.requestId, controller);
        try {
          const result = await loadBinaryPreview(
            { kind: "fs", path, rootPath: activeTarget.rootPath },
            {
              getWorkspaceArtifactBytesArrayBuffer: (id, options) =>
                apiClient.getWorkspaceArtifactBytesArrayBuffer(id, options),
              desktopAPI: desktop.desktopAPI,
            },
            { maxBytes: MAX_RASTER_ASSET_BYTES, signal: controller.signal, timeoutMs: 15_000 },
          );
          if (result.kind === "too_large") {
            respond({ ok: true, value: { kind: "unavailable", code: "too_large" } });
            return;
          }
          if (result.kind === "error") {
            const code = controller.signal.aborted
              ? "cancelled"
              : result.message.includes("changed")
                ? "changed_during_read"
                : result.message.includes("no longer exists")
                  ? "not_found"
                  : "unsupported_environment";
            respond({ ok: true, value: { kind: "unavailable", code } });
            return;
          }
          const mimeType = rasterMimeType(new Uint8Array(result.bytes));
          if (!mimeType) {
            respond({ ok: true, value: { kind: "unavailable", code: "unsupported_type" } });
            return;
          }
          postAssetReady(iframe, msg.requestId, mimeType, result.bytes);
        } finally {
          assetReadControllers.delete(msg.requestId);
        }
        return;
      }
      if (msg.type === "nautilo.app.media.req") {
        if (msg.op === "workspaceCopyCapabilities") {
          const available = appId === "nautilo-video" && mediaProxy === true && activeTarget?.kind === "fs" && Boolean(onVideoProjectPromotion) && Boolean(workspaceCopyRoomLabel);
          respond({ ok: true, value: { available, ...(available ? { roomLabel: workspaceCopyRoomLabel } : {}) } }); return;
        }
        if (msg.op === "saveWorkspaceCopy") {
          if (appId !== "nautilo-video" || mediaProxy !== true || activeTarget?.kind !== "fs" || !onVideoProjectPromotion || workspaceMediaExportRequests.has(msg.requestId) || mediaProxyRequests.has(msg.requestId)) {
            respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } }); return;
          }
          const admittedTarget = activeTarget; const controller = new AbortController();
          workspaceMediaExportRequests.set(msg.requestId, controller);
          try {
            const result = await onVideoProjectPromotion({ requestId: msg.requestId, sha256: msg.sha256, signal: controller.signal,
              onProgress: (progress) => { if (!bridgeDisposed && !controller.signal.aborted) iframe.contentWindow?.postMessage({ type: "nautilo.app.media.promotion-progress", requestId: msg.requestId, progress }, "*"); } });
            if (!bridgeDisposed && activeTarget === admittedTarget) respond({ ok: true, value: result });
          } finally { workspaceMediaExportRequests.delete(msg.requestId); }
          return;
        }
        if (msg.op === "openWorkspaceCopy") {
          const value = appId === "nautilo-video" && mediaProxy === true && activeTarget?.kind === "fs" && onOpenPromotedVideoProject
            ? await onOpenPromotedVideoProject() : { opened: false, code: "unavailable" };
          respond({ ok: true, value }); return;
        }
        if (msg.op === "exportCapabilities") {
          respond({ ok: true, value: { workspace: appId === "nautilo-video" && mediaProxy === true &&
            activeTarget?.kind === "artifact" && Boolean(activeTarget.roomId) && Boolean(onVideoWorkspaceMediaExport) &&
            desktop.desktopAPI?.mediaExport?.supportsWorkspacePublication === true && Boolean(desktop.desktopAPI.mediaExport.startWorkspace) } });
          return;
        }
        if (msg.op === "exportVideo") {
          if (workspaceMediaExportRequests.has(msg.requestId) || mediaProxyRequests.has(msg.requestId)) {
            // Preserve the original request's one terminal response. Replying
            // to a replay would settle the client while native work continues.
            return;
          }
          if (activeTarget?.kind === "artifact") {
            if (appId !== "nautilo-video" || mediaProxy !== true || !onVideoWorkspaceMediaExport) {
              respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } }); return;
            }
            const controller = new AbortController();
            workspaceMediaExportRequests.set(msg.requestId, controller);
            try {
              const result = await onVideoWorkspaceMediaExport({
                requestId: msg.requestId, sha256: msg.sha256, revision: msg.revision, publishToWorkspace: msg.publishToWorkspace === true, signal: controller.signal,
                ...(msg.exportSettings ? { exportSettings: normalizeVideoExportSettings(msg.exportSettings)! } : {}),
                onProgress: (progress) => {
                  if (!bridgeDisposed && !controller.signal.aborted) iframe.contentWindow?.postMessage({ type: "nautilo.app.media.export-progress", requestId: msg.requestId, progress }, "*");
                },
              });
              if (!bridgeDisposed) respond({ ok: true, value: isSafeVideoWorkspaceExportResult(result) ? result : { kind: "unavailable", code: "unavailable" } });
            } finally { workspaceMediaExportRequests.delete(msg.requestId); }
            return;
          }
          if (msg.publishToWorkspace === true) {
            respond({ ok: true, value: { kind: "unavailable", code: "workspace_publication_unsupported" } }); return;
          }
          const exporter = desktop.desktopAPI?.mediaExport;
          const exportTarget = activeTarget;
          const eligible = appId === "nautilo-video" && mediaProxy === true && exportTarget?.kind === "fs" && exporter;
          if (!eligible) { respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } }); return; }
          if (msg.exportSettings && exporter.supportsExportSettings !== true) { respond({ ok: true, value: { kind: "unavailable", code: "export_settings_unsupported" } }); return; }
          mediaProxyRequests.add(msg.requestId);
          const admittedTarget = exportTarget;
          // The iframe's SHA is only a freshness claim. Require it to match the
          // parent-owned last canonical read; Desktop then rereads the file and
          // performs the same SHA check before resolving any media.
          resetDocumentReadSession(documentSession);
          const envelope = await readDocumentSession(documentSession, exportTarget);
          if (!mediaProxyRequests.has(msg.requestId) || bridgeDisposed || activeTarget !== admittedTarget) {
            if (!bridgeDisposed) respond({ ok: true, value: { kind: "cancelled" } });
            return;
          }
          if (envelope.baseSha256 !== msg.sha256 || envelope.baseRevision !== msg.revision) {
            mediaProxyRequests.delete(msg.requestId);
            respond({ ok: true, value: { kind: "unavailable", code: "document_changed" } }); return;
          }
          const unsubscribe = exporter.onProgress((event) => {
            if (event.requestId === msg.requestId && mediaProxyRequests.has(msg.requestId) && !bridgeDisposed) iframe.contentWindow?.postMessage({ type: "nautilo.app.media.export-progress", requestId: msg.requestId, progress: event.progress }, "*");
          });
          try {
            const result = await exporter.start({ requestId: msg.requestId, documentPath: exportTarget.path, expectedSha256: msg.sha256, ...(msg.exportSettings ? { exportSettings: normalizeVideoExportSettings(msg.exportSettings)! } : {}) });
            if (!result.ok) respond({ ok: true, value: { kind: "unavailable", code: result.error.code } });
            else if (result.data.status === "cancelled") respond({ ok: true, value: { kind: "cancelled" } });
            else respond({ ok: true, value: { kind: "succeeded", label: result.data.label, sizeBytes: result.data.sizeBytes, warnings: result.data.warnings } });
          } finally { unsubscribe(); mediaProxyRequests.delete(msg.requestId); }
          return;
        }
        if (msg.op === "closePreview") {
          if (workspaceMediaPreviewTokens.delete(msg.revokeToken)) {
            await onVideoWorkspaceMediaClosePreview?.({ revokeToken: msg.revokeToken });
            respond({ ok: true, value: undefined });
            return;
          }
          if (!mediaProxyTokens.delete(msg.revokeToken)) {
            respond({ ok: true, value: undefined });
            return;
          }
          await desktop.desktopAPI?.mediaProxy?.close(msg.revokeToken);
          respond({ ok: true, value: undefined });
          return;
        }

        if (msg.op === "openPreview" && ("mediaId" in msg || "referenceId" in msg)) {
          const eligible = appId === "nautilo-video" && mediaProxy === true &&
            activeTarget?.kind === "artifact" &&
            onVideoWorkspaceMediaOpenPreview;
          if (!eligible) {
            respond({ ok: true, value: { kind: "unavailable", code: "unavailable" } });
            return;
          }
          const controller = new AbortController();
          workspaceMediaPreviewRequests.set(msg.requestId, controller);
          let result: Awaited<ReturnType<NonNullable<typeof onVideoWorkspaceMediaOpenPreview>>>;
          try {
            result = await onVideoWorkspaceMediaOpenPreview({ ...("mediaId" in msg ? { mediaId: msg.mediaId } : { referenceId: msg.referenceId }), signal: controller.signal });
          } finally {
            workspaceMediaPreviewRequests.delete(msg.requestId);
          }
          if (controller.signal.aborted || bridgeDisposed) {
            if (result.kind === "ready") void onVideoWorkspaceMediaClosePreview?.({ revokeToken: result.revokeToken });
            return;
          }
          if (
            result.kind !== "ready" || !["video/mp4", "audio/mp4", "audio/wav", "audio/mpeg", "image/png", "image/jpeg", "image/webp"].includes(result.mimeType) ||
            typeof result.url !== "string" || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes <= 0 ||
            typeof result.revokeToken !== "string" || result.revokeToken.length === 0
            || (result.blob !== undefined && (!(result.blob instanceof Blob) || result.blob.size !== result.sizeBytes || result.blob.type !== result.mimeType))
          ) {
            respond({ ok: true, value: { kind: "unavailable", code: "unavailable" } });
            return;
          }
          workspaceMediaPreviewTokens.add(result.revokeToken);
          respond({ ok: true, value: {
            kind: "ready",
            url: result.url,
            ...(result.blob ? { blob: result.blob } : {}),
            ...(result.waveform ? { waveform: result.waveform } : {}),
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
            revokeToken: result.revokeToken,
          } });
          return;
        }

        if (msg.op === "pick") {
          if (appId !== "nautilo-video" || mediaProxy !== true || !onVideoMediaPick || activeTarget?.kind !== "artifact" || (msg.purpose === "references" && videoGeneration !== true)) {
            respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } }); return;
          }
          const admittedTarget = activeTarget;
          resetDocumentReadSession(documentSession);
          const envelope = await readDocumentSession(documentSession, admittedTarget);
          if (bridgeDisposed || activeTarget !== admittedTarget || !parseVideoHtml(envelope.content).ok) {
            respond({ ok: true, value: { kind: "unavailable", code: "invalid_document" } }); return;
          }
          const result = await onVideoMediaPick({ purpose: msg.purpose, multiple: msg.multiple });
          if (bridgeDisposed || activeTarget !== admittedTarget) return;
          const valid = result.kind === "ready" && isClosedRecord(result, ["kind", "imports", "references", "mediaIds", "failures"]) &&
            Array.isArray(result.imports) && result.imports.every(isSafeVideoWorkspaceImportResult) &&
            Array.isArray(result.references) && result.references.every(asset => asset.mediaKind !== "audio" && isSafeVideoGenerationReferenceImportResult({ kind: "ready", asset })) &&
            Array.isArray(result.mediaIds) && result.mediaIds.every(id => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(id)) &&
            Array.isArray(result.failures) && result.failures.every(f => isClosedRecord(f, ["label", "code"]) && isSafeVideoText(f.label) && typeof f.code === "string" && /^[a-z_]+$/u.test(f.code)) &&
            (msg.purpose === "media" ? result.references.length === 0 && result.mediaIds.length === 0 : result.imports.length === 0) &&
            (msg.multiple || result.imports.length + result.references.length + result.mediaIds.length <= 1);
          respond({ ok: true, value: valid ? result : { kind: "unavailable", code: result.kind === "unavailable" && /^[a-z_]+$/u.test(result.code) ? result.code : "invalid_response" } });
          return;
        }

        if (msg.op === "importVideo" && activeTarget?.kind === "artifact") {
          const eligible = appId === "nautilo-video" && mediaProxy === true && onVideoWorkspaceMediaImport;
          if (!eligible) {
            respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
            return;
          }
          const admittedTarget = activeTarget;
          resetDocumentReadSession(documentSession);
          const envelope = await readDocumentSession(documentSession, admittedTarget);
          if (bridgeDisposed || activeTarget !== admittedTarget || !parseVideoHtml(envelope.content).ok) {
            respond({ ok: true, value: { kind: "unavailable", code: "invalid_document" } }); return;
          }
          const result = await onVideoWorkspaceMediaImport();
          if (bridgeDisposed || activeTarget !== admittedTarget) return;
          if (result.kind === "unavailable") {
            respond({ ok: true, value: { kind: "unavailable", code: result.code } });
            return;
          }
          if (!isSafeVideoWorkspaceImportResult(result)) {
            respond({ ok: true, value: { kind: "unavailable", code: "unavailable" } });
            return;
          }
          respond({ ok: true, value: result });
          return;
        }

        if (mediaProxy !== true || !activeTarget || activeTarget.kind !== "fs") {
          respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
          return;
        }
        const proxy = desktop.desktopAPI?.mediaProxy;
        if (!proxy) {
          respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
          return;
        }
        if (msg.op === "importVideo") {
          if (appId !== "nautilo-video") {
            respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } }); return;
          }
          const admittedTarget = activeTarget;
          resetDocumentReadSession(documentSession);
          const envelope = await readDocumentSession(documentSession, admittedTarget);
          if (bridgeDisposed || activeTarget !== admittedTarget) return;
          if (!parseVideoHtml(envelope.content).ok) {
            respond({ ok: true, value: { kind: "unavailable", code: "invalid_document" } }); return;
          }
          const result = await proxy.importVideo(admittedTarget.path);
          if (bridgeDisposed || activeTarget !== admittedTarget) return;
          if (!result.ok) {
            respond({ ok: true, value: { kind: "unavailable", code: result.error.code } });
            return;
          }
          respond({ ok: true, value: { kind: "ready", ...result.data } });
          return;
        }
        // Reuse the already-settled relative-ref grammar; this prevents URL,
        // raw-path and traversal input from reaching Desktop IPC.
        if (!resolveBoundRasterPath(activeTarget, msg.ref)) {
          respond({ ok: true, value: { kind: "unavailable", code: "invalid_ref" } });
          return;
        }
        mediaProxyRequests.add(msg.requestId);
        try {
          const result = await proxy.open({
            requestId: msg.requestId,
            documentPath: activeTarget.path,
            ref: msg.ref,
          });
          if (!result.ok) {
            respond({ ok: true, value: { kind: "unavailable", code: result.error.code } });
            return;
          }
          mediaProxyTokens.add(result.data.revokeToken);
          respond({
            ok: true,
            value: {
              kind: "ready",
              url: result.data.url,
              mimeType: result.data.mimeType,
              sizeBytes: result.data.sizeBytes,
              revokeToken: result.data.revokeToken,
              ...(result.data.waveform ? { waveform: result.data.waveform } : {}),
            },
          });
        } finally {
          mediaProxyRequests.delete(msg.requestId);
        }
        return;
      }
      if (msg.type === "nautilo.app.preferences.req") {
        if (!canAccessAppPreference(appId, msg.key)) {
          throw new BridgeError("This app does not have preference access.");
        }
        if (msg.op === "get") { respond({ ok: true, value: getAppPreference(viewerKey, appId, msg.key) }); return; }
        const normalized = validateAppPreference(appId, msg.key, msg.value);
        if (!normalized) throw new BridgeError("Invalid app preference value.");
        const saved = setAppPreference(viewerKey, appId, msg.key, normalized);
        respond({ ok: true, value: saved ?? getAppPreference(null, appId, msg.key) });
        return;
      }
      if (msg.type === "nautilo.app.document.req") {
        if (msg.op === "saveCopy") {
          if (!saveCopy) throw new BridgeError("Save Copy is unavailable for this app.");
          const content = parseWriteContent(msg.value);
          respond({ ok: true, value: await saveCopy(content) });
          return;
        }
        if (msg.op === "downloadCopy") {
          if (!activeTarget && !unboundDraft) throw new BridgeError("No document is bound.");
          const content = parseWriteContent(msg.value);
          const path = documentSession.envelope?.path ?? "document.html";
          downloadDocumentCopy(content, path);
          respond({ ok: true, value: undefined });
          return;
        }
        if (msg.op === "authoredChange") {
          const mutations = desktop.desktopAPI?.documentMutations;
          const bound = activeTarget;
          if (appId !== "nautilo-video" || !bound || unboundDraft) {
            respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
            return;
          }
          const envelope = await readDocumentSession(documentSession, bound);
          if (!envelope.baseSha256) { respond({ ok: true, value: { kind: "none" } }); return; }
          let value: unknown;
          if (bound.kind === "fs") {
            if (!mutations?.readAuthoredChange) {
              respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
              return;
            }
            value = await mutations.readAuthoredChange({
              path: bound.path,
              expectedSha256: envelope.baseSha256,
            });
          } else {
            if (!bound.roomId || envelope.baseRevision === null) {
              respond({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
              return;
            }
            value = await apiClient.getWorkspaceArtifactAuthoredChange(bound.id, {
              roomId: bound.roomId,
              expectedSha256: envelope.baseSha256,
              expectedRevision: envelope.baseRevision,
            });
          }
          const validated = await validateAuthoredChange(value, envelope.baseSha256);
          respond({ ok: true, value: !bridgeDisposed && activeTarget === bound &&
            documentSession.envelope?.baseSha256 === envelope.baseSha256 &&
            documentSession.envelope?.baseRevision === envelope.baseRevision
            ? validated : { kind: "unavailable", code: "document_changed" } });
        } else if (msg.op === "read") {
          if (unboundDraft) {
            const tpl = await getTemplate();
            if ((appId === "nautilo-presentation" || appId === "nautilo-board") && opts.mode === "edit") {
              const materializedTarget = await ensureMaterialized(tpl.content, tpl.mimeType);
              const envelope = await readDocumentSession(documentSession, materializedTarget);
              if (typeof envelope.baseRevision === "number") {
                await onDocumentVersion?.({ kind: "artifact_revision", revision: envelope.baseRevision });
              }
              respond({ ok: true, value: envelope });
            } else {
              const envelope = draftDocumentEnvelope(unboundDraft, tpl);
              documentSession.envelope = envelope;
              respond({ ok: true, value: envelope });
            }
          } else {
            if (msg.fresh) resetDocumentReadSession(documentSession);
            const envelope = await readDocumentSession(documentSession, activeTarget);
            if (typeof envelope.baseRevision === "number") {
              await onDocumentVersion?.({ kind: "artifact_revision", revision: envelope.baseRevision });
            } else if (
              activeTarget?.kind === "fs" &&
              typeof envelope.baseSha256 === "string" &&
              envelope.baseSha256.length > 0
            ) {
              await onDocumentVersion?.({ kind: "local_sha", sha256: envelope.baseSha256 });
            }
            respond({ ok: true, value: envelope });
          }
        } else if (msg.op === "stat") {
          if (unboundDraft) {
            respond({ ok: true, value: draftDocumentStat(unboundDraft, await getTemplate()) });
          } else {
            respond({ ok: true, value: await statBoundDocument(activeTarget) });
          }
        } else if (msg.op === "write") {
          if (unboundDraft) {
            const tpl = await getTemplate();
            const content = parseWriteContent(msg.value);
            const materializedTarget = await ensureMaterialized(content, tpl.mimeType);
            const sha256 = await sha256HexForText(content);
            const persistedEnvelope = msg.conflictPolicy === "strict" ? await readBoundDocument(materializedTarget) : {
              content, mimeType: materializedTarget.mimeType, path: materializedTarget.path,
              baseSha256: sha256, baseRevision: null,
            };
            rememberEnvelope(documentSession, persistedEnvelope, materializedTarget);
            respond({
              ok: true,
              value: {
                kind: "saved",
                sha256: persistedEnvelope.baseSha256 ?? sha256,
                revision: persistedEnvelope.baseRevision,
                persistedContent: persistedEnvelope.content,
                path: materializedTarget.path,
              },
            });
            return;
          }
          const content = parseWriteContent(msg.value);
          await new Promise<void>((resolve) => {
            enqueueBoundWrite(
              content,
              {
                requestId: msg.requestId,
                respond: (payload) => {
                  respond(payload);
                  resolve();
                },
              },
              {
                baseSha256: msg.baseSha256,
                baseRevision: msg.baseRevision,
                conflictPolicy: msg.conflictPolicy,
              },
            );
          });
        }
        return;
      }

      if (msg.op === "get") {
        // No state exists for an un-materialized draft.
        if (unboundDraft) {
          respond({ ok: true, value: undefined });
        } else {
          respond({ ok: true, value: await getAppState(appId, activeTarget, msg.key) });
        }
      } else {
        if (unboundDraft) {
          const tpl = await getTemplate();
          await ensureMaterialized(tpl.content, tpl.mimeType);
        }
        await setAppState(appId, activeTarget, msg.key, msg.value);
        respond({ ok: true, value: undefined });
      }
    } catch (err: unknown) {
      const status = err instanceof BridgeError ? err.status : (err as { status?: number })?.status;
      respond({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(typeof status === "number" ? { status } : {}),
      });
    }
  }

  window.addEventListener("message", handler);
  return () => {
    onLifecycleRegistrationChange?.(false);
    bridgeDisposed = true;
    for (const controller of assetReadControllers.values()) controller.abort();
    assetReadControllers.clear();
    const proxy = desktop.desktopAPI?.mediaProxy;
    for (const requestId of mediaProxyRequests) {
      void proxy?.cancel(requestId);
      void desktop.desktopAPI?.mediaExport?.cancel(requestId);
    }
    mediaProxyRequests.clear();
    for (const controller of workspaceMediaPreviewRequests.values()) controller.abort();
    workspaceMediaPreviewRequests.clear();
    for (const controller of workspaceMediaExportRequests.values()) controller.abort();
    workspaceMediaExportRequests.clear();
    for (const revokeToken of mediaProxyTokens) void proxy?.close(revokeToken);
    mediaProxyTokens.clear();
    for (const revokeToken of workspaceMediaPreviewTokens) {
      void onVideoWorkspaceMediaClosePreview?.({ revokeToken });
    }
    workspaceMediaPreviewTokens.clear();
    unsubscribePreferences();
    window.removeEventListener("message", handler);
  };
}
import { normalizeVideoExportSettings } from "@nautilo/types";
