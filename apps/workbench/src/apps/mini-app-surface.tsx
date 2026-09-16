import { createVideoHostSessionManager, type VideoHostBinding, type VideoHostSession } from "./video-host-session";
import { requestMiniAppExport } from "./mini-app-export";
import { createAppImageAssets } from "./app-image-assets";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workspaceMediaMimeMatchesKind, type ActiveMiniAppMode, type WorkspaceMediaArtifact } from "@nautilo/types";
import { Maximize2, MessageSquare, X, Pencil } from "lucide-react";
import { ApiError, VideoGenerationPreparationError } from "@nautilo/api-client/browser";
import { sendLiveAppCommand } from "./live-app-command";
import type { MiniAppRuntimeResponse } from "@nautilo/api-client/browser";
import type { ApplyAcceptedLiveProposalResponse, LiveDocumentVersion, MediaGenerationApproval } from "@nautilo/types";
import { liveDocumentVersionEquals, validateWorkspaceLogicalPath } from "@nautilo/types";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { isLocalArtifactSaveMutation } from "../editors/local-artifact-save-mutations";
import { isLocalFsSaveSha, registerLocalFsSaveSha } from "../editors/local-fs-save-shas";
import { sha256HexForText } from "../editors/editor-io";
import { saveConflictCopy } from "../editors/editor-conflict-copy";
import { apiClient } from "../lib/api";
import { desktopAPI, getDesktopRelayId, isDesktop } from "../lib/desktop";
import { useSetupStatus } from "../contexts/setup-status-context";
import { createAppDraftRecovery, type AppDraftRecoveryPort } from "./app-draft-recovery";
import { createSlidesTemplateLibrary } from "./app-slide-templates";
import { addAuthTransitionListener } from "../lib/auth-transition";
import {
  fsDirectoryChangeAffectsFile,
  type FsDirectoryChangedEvent,
} from "../lib/fs-directory-changed";
import { buildExportRequest, type DesignExportScope } from "./export-conversions";
import { openExportedResult, type ExportToolResult } from "./run-conversion";
import { useConversionRunner } from "./use-conversion-runner";
import { openVerifiedVideoProjectCopy } from "./open-video-project-copy";
import {
  applyVerifiedDocumentPatchToWriteSession,
  installAppBridge,
  postAppDocumentChanged,
  postAppLiveProposal,
  postAppLiveSession,
  postAppLiveSessionClosed,
  postAppTheme,
  readDocumentSession,
  resetDocumentReadSession,
  type ActiveMiniAppContext,
  type AppDocumentEnvelope,
  type AppHumanEditUpdate,
  type AppDocumentWriteSession,
  type AppTheme,
  type MiniAppDraftSeed,
  type VideoMediaPickInput,
  type VideoMediaPickResult,
  type VideoGenerationBridgeRequest,
  type VideoGenerationReferenceImportBridgeResult,
  type VideoGenerationReferencesImportBridgeResult,
  type VideoWorkspaceMediaExportInput,
  type VideoWorkspaceMediaExportResult,
} from "./app-bridge";
import { VideoGenerationReviewOverlay } from "../components/video-generation-review-overlay";
import { usePublishedHumanEditLease } from "../editors/use-human-edit-lease";
import {
  buildNautiloAppBridgeClientScript,
  type NautiloAppBridgeClientCapabilities,
} from "./app-bridge-client";
import {
  requestMiniAppLifecycle,
  type MiniAppCloseReason,
  type MiniAppLifecycleAction,
} from "./mini-app-lifecycle";
import {
  replayLiveAppProposals,
  subscribeLiveAppProposalReconciliation,
  subscribeLiveAppProposal,
  type LiveAppProposal,
} from "./live-app-proposal-bus";
import { subscribeLiveAppMutationCommitted } from "./live-app-mutation-bus";
import { subscribeLiveAppSessionClosed } from "./live-app-session-close-bus";
import {
  buildIssueLiveSessionRequest,
  fsBoundDisplayPath,
  liveReviewBoundTargetKey,
  type LiveReviewBoundTarget,
} from "./live-app-session-target";
import {
  observePendingAcceptMutationEvent,
  releasePendingAcceptMutationObserver,
} from "./local-fs-accept-mutations";
import { loadMiniAppRuntime } from "./app-runtime";
import { useAppEvents } from "./use-app-events";
import { useWorkspaceArtifactEventHub } from "../artifacts/workspace-artifacts-provider";
import { useAuth } from "../hooks/use-auth";
import { parseVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import { compileBoundVideoGenerationRequest } from "./video-generation-review";
import { effectiveGenerationDirectionBlocks, type GenerationReference } from "../../../../packages/first-party-apps/video/src/generation-brief";
import { buildSequenceRenderPlan } from "../../../../packages/first-party-apps/video/src/render-plan";
import {
  workspaceArtifactEventClientMutationId,
  workspaceArtifactEventId,
  workspaceArtifactEventPath,
  workspaceEditorSavePatchEvent,
  localFileEditorSavePatchEvent,
} from "../artifacts/workspace-document-mutation-events";
import { VideoHostSupportNotice } from "./video-host-support-notice";
import { VideoWorkspaceMediaPicker, type VideoWorkspaceMediaPickerProps, type VideoPickerSelection, workspaceMediaPickerName } from "../components/video-workspace-media-picker";

type ArtifactTarget = Extract<OpenFileTarget, { kind: "artifact" }>;

function makeArtifactTarget(input: {
  id: string;
  path: string;
  mimeType: string;
  roomId?: string;
}): ArtifactTarget {
  return {
    kind: "artifact",
    id: input.id,
    path: input.path,
    mimeType: input.mimeType,
    ...(input.roomId !== undefined && input.roomId.length > 0 ? { roomId: input.roomId } : {}),
  };
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function exportTargetIdentity(target: OpenFileTarget | undefined): string | null {
  if (!target) return null;
  return target.kind === "artifact"
    ? JSON.stringify(["artifact", target.id, target.roomId ?? null])
    : JSON.stringify(["fs", target.rootPath, target.path]);
}

/**
 * A stream reconnect is transport state, not document mutation. Compare the
 * canonical envelope reread across the disconnected interval before telling a
 * running mini-app that its document changed. Artifact reads normally carry a
 * SHA; the content fallback keeps the no-op check safe for legacy/null hashes.
 */
function canonicalDocumentUnchanged(
  previous: AppDocumentEnvelope | null,
  next: AppDocumentEnvelope,
): boolean {
  if (
    previous === null ||
    previous.path !== next.path ||
    previous.mimeType !== next.mimeType ||
    previous.baseRevision !== next.baseRevision
  ) {
    return false;
  }
  if (previous.baseSha256 !== null || next.baseSha256 !== null) {
    return previous.baseSha256 !== null && previous.baseSha256 === next.baseSha256;
  }
  return previous.content === next.content;
}

function miniAppDiagnosticsEnabled(): boolean {
  // Bun's test runtime does not define Vite's DEV flag; test is still a
  // non-production environment and lets the opt-in diagnostic contract run.
  if ((!import.meta.env.DEV && import.meta.env.NODE_ENV !== "test") || typeof window === "undefined") {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get("miniAppDiagnostics");
  return value === "1" || value === "true";
}

/**
 * Transport debugging is deliberately opt-in and metadata-only: a reconnect
 * must not expose document contents, hashes, paths, or artifact identifiers.
 */
function logArtifactReconnectOutcome(
  outcome: "canonical_unchanged" | "canonical_changed" | "canonical_read_failed",
): void {
  if (!miniAppDiagnosticsEnabled()) return;
  console.info("[mini-app][artifact-reconnect]", JSON.stringify({
    event: "stream_reconnected",
    outcome,
  }));
}

type ExportNotice = { kind: "success" | "error"; message: string };

type ExportResult = ExportToolResult;

type DesignScopeChoice = { label: string; scope: DesignExportScope };

export function designExportScopeChoices(context: ActiveMiniAppContext | null): DesignScopeChoice[] {
  const summary = context?.summary.summary;
  if (!summary || typeof summary !== "object") return [];
  const design = (summary as Record<string, unknown>)["design"];
  if (!design || typeof design !== "object") return [];
  const pageHandle = (design as Record<string, unknown>)["pageHandle"];
  if (typeof pageHandle !== "string" || pageHandle.length === 0) return [];
  const choices: DesignScopeChoice[] = [{ label: "Current page", scope: { pageHandle } }];
  const selection = context?.summary.selection;
  const selectionRecord = selection && typeof selection === "object"
    ? selection as Record<string, unknown>
    : null;
  const selectionHandles = selectionRecord?.["nodeHandles"];
  const selectedHandles = Array.isArray(selectionHandles)
    ? selectionHandles.filter((handle): handle is string => typeof handle === "string")
    : [];
  if (selectedHandles.length > 0) {
    choices.push({ label: "Selection", scope: { pageHandle, nodeHandles: selectedHandles } });
  }
  const frames = (design as Record<string, unknown>)["topLevelFrames"];
  const frameList: unknown[] = Array.isArray(frames) ? frames : [];
  const selectedFrame = frameList.find((frame) => {
      if (!frame || typeof frame !== "object") return false;
      const handle = (frame as Record<string, unknown>)["handle"];
      return typeof handle === "string" && selectedHandles.includes(handle);
    });
  const selectedFrameHandle = selectedFrame && typeof selectedFrame === "object"
    ? (selectedFrame as Record<string, unknown>)["handle"]
    : undefined;
  if (typeof selectedFrameHandle === "string") {
    choices.push({ label: "Selected frame", scope: { pageHandle, nodeHandles: [selectedFrameHandle] } });
  }
  return choices;
}

function exportFailureMessage(result: ExportResult): string {
  return result.message ?? result.error ?? "Export failed.";
}

export interface MiniAppSurfaceProps {
  appId: string;
  /** Preview retains canonical document reads and change notifications without edit authority. */
  mode?: ActiveMiniAppMode;
  /** Optional shell-owned transition from the read-only preview into an editor route. */
  onEdit?: () => void;
  /** Resolved Workbench presentation mode; omitted mini-apps retain OS fallback. */
  theme?: AppTheme;
  target?: OpenFileTarget;
  /** D342 Phase 2 — launch with no bound doc: the app warms up against this
   *  draft and only materializes a workspace artifact on first edit. */
  draft?: MiniAppDraftSeed;
  sourceHash?: string;
  onContextUpdate?: (context: ActiveMiniAppContext, mode: ActiveMiniAppMode) => void;
  onLiveMiniAppSessionChange?: (session: {
    sessionToken: string;
    sessionId: string;
    documentVersion: LiveDocumentVersion;
  } | null) => void;
  /** D342 Phase 2 — notify the shell when a draft becomes a real artifact, so
   *  the work surface re-binds (survives panel toggles / reloads). */
  onMaterialized?: (artifact: ArtifactTarget) => void;
  workspaceCopyDestination?: { roomId: string; label: string };
  /** Host-owned chat sidecar toggle. Width is preserved by the shell. */
  onToggleChat?: () => void;
  chatVisible?: boolean;
  /** Register the shell's synchronous gate for leaving this running app. */
  registerBeforeLeave?: (guard: ((leave: () => void, stay?: () => void) => void) | null) => void;
  /** Host-owned Workspace/Files browser toggle. */
  onToggleBrowser?: () => void;
  browserVisible?: boolean;
  onClose: () => void;
  onRegisterTransitionGuard?: (
    guard: ((reason: MiniAppCloseReason) => Promise<boolean>) | null,
  ) => void;
  onLifecycleRetryReady?: () => void;
  onLifecycleCancel?: () => void;
  /** Test seam for the source-fenced host requester. */
  lifecycleRequester?: typeof requestMiniAppLifecycle;
  exportRequester?: typeof requestMiniAppExport;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; runtime: MiniAppRuntimeResponse }
  | { kind: "error"; message: string };

const DOCUMENT_CHANGED_DEBOUNCE_MS = 175;
const LIVE_SESSION_REFRESH_LEAD_MAX_MS = 60_000;
const LIVE_SESSION_REFRESH_LEAD_MIN_MS = 1_000;

type LiveAppSession = {
  token: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
  expiresAt: number;
  targetKey: string;
};

type BoundHumanEditUpdate = {
  targetKey: string;
  update: AppHumanEditUpdate;
};

type VideoGenerationReview = Readonly<{
  approval: MediaGenerationApproval;
  presentation: import("../components/media-generation-visual-review").GenerationReviewPresentation;
  roomId: string;
}>;

type PrivateVideoGenerationReview = {
  takeId: string;
  reviewHandle: string;
  submissionAttempted: boolean;
  submissionUncertain: boolean;
  submitting: boolean;
  resolve: (result: { kind: "queued"; takeId: string } | { kind: "cancelled" } | { kind: "submission-unknown"; takeId: string } | { kind: "expired" } | { kind: "unavailable"; code: string }) => void;
};

type VideoGenerationPreview = Readonly<{
  mediaKind: "video" | "audio";
  src: string;
  label: string;
}>;

const VIDEO_MEDIA_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const WORKSPACE_ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOGICAL_WORKSPACE_PATH = /^(?!\/)(?!.*\\\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/@+-]+$/u;

type DurableWorkspaceVideoMedia = Readonly<{ artifactId: string; path: string; mediaKind: "video" | "audio" | "image" }>;



/** Keep the pre-upload admission rule identical to the bridge's closed result. */
function isSafeWorkspaceVideoImportLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !/[\r\n\0]/u.test(value) && !/(?:https?:|data:|blob:|file:)/iu.test(value);
}

function isSafeWorkspaceReferenceMimeType(mediaKind: "image" | "video" | "audio", mimeType: unknown): mimeType is string {
  return workspaceMediaMimeMatchesKind(mediaKind, mimeType);
}

function isSeedanceAudioReferenceMimeType(mimeType: unknown): mimeType is "audio/mpeg" | "audio/wav" | "audio/x-wav" {
  return mimeType === "audio/mpeg" || mimeType === "audio/wav" || mimeType === "audio/x-wav";
}



/**
 * Read just enough of the already-bound Video document to prove that the
 * opaque media id names a durable Workspace source. The iframe never submits
 * source identity: it receives only a host-created preview URL after this
 * parent-side re-read and exact inventory match.
 */
export function durableWorkspaceVideoMediaFromDocument(
  content: string,
  mediaId: string,
): DurableWorkspaceVideoMedia | null {
  // The parent document read already enforces the host transport boundary.
  // A smaller Video-only cap would make valid saved projects lose their media.
  if (!VIDEO_MEDIA_ID.test(mediaId)) return null;
  const parsed = parseVideoHtml(content);
  if (!parsed.ok) return null;
  const matches = parsed.document.project.media.filter((candidate) => candidate.id === mediaId);
  if (matches.length !== 1) return null;
  const media = matches[0];
  if (!media) return null;
  if (media.lifecycle !== "durable" || !LOGICAL_WORKSPACE_PATH.test(media.ref)) return null;
  if (media.kind === "audio" && (!media.durationSec || media.frameRate !== undefined)) return null;
  if (media.kind === "image" && (media.durationSec !== undefined || media.frameRate !== undefined)) return null;
  const record = media.source;
  if (!record) return null;
  if (
    !WORKSPACE_ARTIFACT_ID.test(record.artifactId) || !LOGICAL_WORKSPACE_PATH.test(record.path) || record.path !== media.ref
  ) return null;
  return { artifactId: record.artifactId, path: record.path, mediaKind: media.kind };
}

/** Resolve only a reference present in the saved project; no iframe source locator is accepted. */
function workspaceVideoReferenceFromDocument(content: string, referenceId: string): DurableWorkspaceVideoMedia | null {
  const parsed = parseVideoHtml(content);
  if (!parsed.ok) return null;
  const brief = parsed.document.project.generationBrief;
  if (!brief) return null;
  const shared = effectiveGenerationDirectionBlocks(brief).flatMap((block) => block.kind === "references" ? block.references ?? [] : []);
  const matches = [...shared, ...brief.shots.flatMap((shot) => shot.references)].filter((reference) => reference.id === referenceId);
  // Duplicate identities are ambiguous even when their display names agree.
  if (matches.length !== 1) return null;
  const reference = matches[0];
  if (!reference) return null;
  if (reference.source?.kind === "project-media") return durableWorkspaceVideoMediaFromDocument(content, reference.source.mediaId);
  const source = reference.source;
  if (source?.kind !== "workspace-artifact" || !WORKSPACE_ARTIFACT_ID.test(source.artifactId) || !validateWorkspaceLogicalPath(source.path).ok || source.path.includes("\\") || /(?:https?:|data:|blob:|file:)/iu.test(source.path)) return null;
  return { artifactId: source.artifactId, path: source.path, mediaKind: reference.mediaKind ?? "image" };
}

/** The host, never the iframe, learns a generated artifact's real duration. */

function coordinatorVideoJob(request: VideoGenerationBridgeRequest): {
  modelId: "venice:seedance-2-5-text-to-video-basic" | "venice:seedance-2-5-reference-to-video-basic" | "venice:minimax-h3-enhanced-text-to-video";
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  resolution?: "480p" | "720p" | "1080p" | "768P" | "2K";
  audio?: boolean;
} {
  const requested = request.job.requestedSettings;
  return {
    modelId: request.job.modelId,
    prompt: request.job.prompt,
    ...(requested?.durationSeconds !== undefined ? { durationSeconds: requested.durationSeconds } : {}),
    ...(requested?.aspectRatio !== undefined ? { aspectRatio: requested.aspectRatio } : {}),
    ...(requested?.resolution !== undefined ? { resolution: requested.resolution } : {}),
    ...(requested?.audio !== undefined ? { audio: requested.audio } : {}),
  };
}

export function liveSessionRefreshDelay(expiresAt: number, now = Date.now()): number | null {
  const remaining = expiresAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const lead = Math.min(
    LIVE_SESSION_REFRESH_LEAD_MAX_MS,
    Math.max(LIVE_SESSION_REFRESH_LEAD_MIN_MS, Math.floor(remaining / 5)),
  );
  return Math.max(0, remaining - lead);
}

function splitNameAndExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

export function buildUniqueDraftPath(input: {
  desiredName: string;
  existingNames: readonly string[];
}): string {
  const desired = input.desiredName.trim() || "Untitled";
  const existing = new Set(input.existingNames.map((name) => name.toLowerCase()));
  if (!existing.has(desired.toLowerCase())) return desired;

  const { stem, extension } = splitNameAndExtension(desired);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} ${index}${extension}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} ${Date.now()}${extension}`;
}

function sanitizeRuntimeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "Failed to load app runtime.";
}

function isClosedLiveSessionError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.message === "session_closed";
}

export function srcDocWithAppBridgeClient(
  srcDoc: string,
  initialTheme?: AppTheme,
  hostCapabilities?: MiniAppRuntimeResponse["hostCapabilities"],
  mode: "edit" | "preview" = "edit",
  capabilities?: NautiloAppBridgeClientCapabilities,
): string {
  const hasPrivilegedGrant = hostCapabilities?.assetReadRaster === true || hostCapabilities?.mediaProxy === true || (mode === "edit" && hostCapabilities?.videoGeneration === true);
  const bootstrap = hasPrivilegedGrant
    ? {
        ...(initialTheme ? { initialTheme } : {}),
        ...(hostCapabilities?.assetReadRaster === true ? { assetReadRaster: true as const } : {}),
        ...(hostCapabilities?.mediaProxy === true ? { mediaProxy: true as const } : {}),
        ...(mode === "edit" && hostCapabilities?.videoGeneration === true ? { videoGeneration: true as const } : {}),
        ...(mode === "edit" && hostCapabilities?.videoGeneration === true ? { videoHostLayout: true as const } : {}),
      }
    : initialTheme;
  const script = `<script>${buildNautiloAppBridgeClientScript(bootstrap, mode, capabilities)}</script>`;
  if (/<script\s+type=["']module["'][^>]*>/i.test(srcDoc)) {
    return srcDoc.replace(/<script\s+type=["']module["'][^>]*>/i, (match) => `${script}${match}`);
  }
  if (/<\/head>/i.test(srcDoc)) {
    return srcDoc.replace(/<\/head>/i, `${script}</head>`);
  }
  return `${script}${srcDoc}`;
}

export function MiniAppSurface({
  appId,
  mode = "edit",
  onEdit,
  theme,
  target,
  draft,
  sourceHash,
  onContextUpdate,
  onLiveMiniAppSessionChange,
  onMaterialized,
  workspaceCopyDestination,
  onToggleChat,
  chatVisible = true,
  registerBeforeLeave,
  onToggleBrowser,
  browserVisible = true,
  onClose,
  onRegisterTransitionGuard,
  onLifecycleRetryReady,
  onLifecycleCancel,
  lifecycleRequester = requestMiniAppLifecycle,
  exportRequester = requestMiniAppExport,
}: MiniAppSurfaceProps) {
  const workspaceCopyRoomId = workspaceCopyDestination?.roomId;
  const workspaceCopyRoomLabel = workspaceCopyDestination?.label;
  const auth = useAuth();
  const setupStatus = useSetupStatus();
  const supportsVideoWorkspaceMedia = Boolean(
    desktopAPI?.mediaProxy?.importWorkspace && desktopAPI.mediaProxy.openWorkspace,
  );
  const subscribeWorkspaceArtifactEvents = useWorkspaceArtifactEventHub();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingSourceHash, setPendingSourceHash] = useState<string | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [reloadInFlight, setReloadInFlight] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const promotedVideoProjectRef = useRef<{ target: ArtifactTarget; artifactId: string; sourceSha256: string; sourceKey: string; viewerKey: string | null; epoch: number } | null>(null);
  const promotionEpochRef = useRef(0);
  const [bridgeReadyIframeKey, setBridgeReadyIframeKey] = useState<string | null>(null);
  const [iframeBootstrap, setIframeBootstrap] = useState<{
    key: string;
    theme: AppTheme | undefined;
  } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The parent owns only the Genie rail. A first-party Video iframe owns its
  // internal columns and asks us for this one reversible counterpart.
  const videoHostFullWidthSnapshotRef = useRef<{ chatVisible: boolean; browserVisible: boolean } | null>(null);
  const chatVisibleRef = useRef(Boolean(chatVisible));
  const onToggleChatRef = useRef(onToggleChat);
  const browserVisibleRef = useRef(Boolean(browserVisible));
  const onToggleBrowserRef = useRef(onToggleBrowser);
  const themeRef = useRef<AppTheme | undefined>(theme);
  const runtimeSourceHashRef = useRef<string | null>(null);
  const reloadInFlightRef = useRef(false);
  const lastDocumentChangeKeyRef = useRef<string | null>(null);
  const documentSessionRef = useRef<AppDocumentWriteSession>({ envelope: null });
  const documentChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSessionRef = useRef<LiveAppSession | null>(null);
  const issueLiveSessionRef = useRef<(() => Promise<void>) | null>(null);
  const [commandSession, setCommandSession] = useState<{ iframe: HTMLIFrameElement; token: string; sessionId: string; documentVersion: LiveDocumentVersion } | null>(null);
  const liveSessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSessionRequestSequenceRef = useRef(0);
  const liveSessionTargetRef = useRef<LiveReviewBoundTarget | null>(null);
  const scheduleLiveSessionRefreshRef = useRef<(session: LiveAppSession) => void>(() => {});
  /** A postMessage is only attempted delivery; Writer acknowledges visible review. */
  const liveProposalsAwaitingAckRef = useRef(new Map<string, LiveAppProposal>());
  const deliveredLiveProposalIdsRef = useRef(new Set<string>());
  // This token and review handle remain parent-only refs: neither state nor
  // props can serialize them into the iframe or overlay DOM.
  const videoGenerationSessionRef = useRef<VideoHostSession | null>(null);
  const videoHostBindingRef = useRef<VideoHostBinding | null>(null);
  const videoHostManager = useMemo(() => createVideoHostSessionManager({
    async readProject(binding) {
      const target = boundTargetRef.current;
      if (target?.kind !== "artifact" || liveReviewBoundTargetKey(target) !== binding.targetKey) return null;
      const artifact = await apiClient.getWorkspaceArtifact(target.id, { roomId: binding.roomId });
      if (boundTargetRef.current !== target || !artifact || artifact.path !== target.path || !artifact.path.endsWith(".video.html")) return null;
      const { rooms } = await apiClient.listArtifactDiscussionRooms(artifact.id);
      if (boundTargetRef.current !== target) return null;
      // The open chat can differ from the saved project's attached room. Use
      // an authorized project room; never guess among multiple attachments.
      const roomId = rooms.find(room => room.id === binding.roomId)?.id ?? (rooms.length === 1 ? rooms[0]?.id : undefined);
      if (!roomId) return null;
      return { projectArtifactId: artifact.artifactId, projectRevision: artifact.revision, roomId };
    },
    issue: (binding, project) => apiClient.issueVideoHostAttestation({
      roomId: project.roomId ?? binding.roomId, projectArtifactId: project.projectArtifactId, sourceHash: binding.sourceHash,
    }),
    revoke: (token) => apiClient.revokeVideoHostAttestation(token),
  }), []);
  const privateVideoGenerationReviewRef = useRef<PrivateVideoGenerationReview | null>(null);
  const [videoGenerationReview, setVideoGenerationReview] = useState<VideoGenerationReview | null>(null);
  const [videoGenerationSubmitting, setVideoGenerationSubmitting] = useState(false);
  const [videoGenerationReviewError, setVideoGenerationReviewError] = useState<string | null>(null);
  const [videoGenerationSessionEpoch, setVideoGenerationSessionEpoch] = useState(0);
  const [videoGenerationPreview, setVideoGenerationPreview] = useState<VideoGenerationPreview | null>(null);
  const videoGenerationPreviewUrlRef = useRef<string | null>(null);
  const workspaceMediaPreviewUrlsRef = useRef(new Map<string, string>());
  const workspaceMediaRequestsRef = useRef(new Set<string>());
  const [workspaceMediaPicker, setWorkspaceMediaPicker] = useState<{ artifacts: WorkspaceMediaArtifact[]; labels: Record<string, string>; loading: boolean; error: string | null; purpose?: "media" | "references"; multiple?: boolean; projectMedia?: VideoWorkspaceMediaPickerProps["projectMedia"]; onConfirm?: VideoWorkspaceMediaPickerProps["onConfirm"] } | null>(null);
  const videoMediaPickResolveRef = useRef<((selection: VideoPickerSelection | "upload" | null) => void) | null>(null);
  const workspaceMediaPickerResolveRef = useRef<((selection: WorkspaceMediaArtifact | "upload" | null) => void) | null>(null);
  const workspaceMediaPickerAbortRef = useRef<AbortController | null>(null);
  const workspaceMediaImportEpochRef = useRef(0);
  const workspaceMediaImportCancelRef = useRef<(() => void) | null>(null);
  const videoGenerationPreviewCloseRef = useRef<HTMLButtonElement | null>(null);
  /** One native take validation at a time; no original media bytes enter this renderer. */
  const videoGenerationMediaLoadInFlightRef = useRef(false);
  /** Passive invalidation: revoke parent media without stealing keyboard focus. */
  const clearVideoGenerationPreview = useCallback(() => {
    const src = videoGenerationPreviewUrlRef.current;
    videoGenerationPreviewUrlRef.current = null;
    if (src) void desktopAPI?.mediaProxy?.close(src);
    setVideoGenerationPreview(null);
    return Boolean(src);
  }, []);

  const closeWorkspaceMediaPreview = useCallback((input: { revokeToken: string }) => {
    const src = workspaceMediaPreviewUrlsRef.current.get(input.revokeToken);
    if (!src) return;
    workspaceMediaPreviewUrlsRef.current.delete(input.revokeToken);
    void desktopAPI?.mediaProxy?.close(input.revokeToken);
  }, []);

  const clearWorkspaceMediaPreviews = useCallback(() => {
    for (const token of workspaceMediaPreviewUrlsRef.current.keys()) void desktopAPI?.mediaProxy?.close(token);
    workspaceMediaPreviewUrlsRef.current.clear();
    for (const requestId of workspaceMediaRequestsRef.current) void desktopAPI?.mediaProxy?.cancel(requestId);
    workspaceMediaRequestsRef.current.clear();
  }, []);

  const closeWorkspaceMediaPicker = useCallback((selection: WorkspaceMediaArtifact | "upload" | null, restoreFocus = false) => {
    const resolve = workspaceMediaPickerResolveRef.current;
    workspaceMediaPickerResolveRef.current = null;
    workspaceMediaPickerAbortRef.current?.abort();
    workspaceMediaPickerAbortRef.current = null;
    setWorkspaceMediaPicker(null);
    resolve?.(selection);
    const pickResolve = videoMediaPickResolveRef.current;
    videoMediaPickResolveRef.current = null;
    pickResolve?.(selection === "upload" ? "upload" : null);
    if (restoreFocus) queueMicrotask(() => iframeRef.current?.focus());
  }, []);

  useEffect(() => () => { workspaceMediaImportEpochRef.current += 1; workspaceMediaImportCancelRef.current?.(); closeWorkspaceMediaPicker(null); }, [closeWorkspaceMediaPicker]);

  /** User-initiated dismissal returns focus to the untrusted app that invoked it. */
  const closeVideoGenerationPreview = useCallback(() => {
    if (clearVideoGenerationPreview()) queueMicrotask(() => iframeRef.current?.focus());
  }, [clearVideoGenerationPreview]);

  useEffect(() => {
    if (videoGenerationPreview) videoGenerationPreviewCloseRef.current?.focus();
  }, [videoGenerationPreview]);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const activeContextRef = useRef<ActiveMiniAppContext | null>(null);

  // D342 Phase 2 — the bound document. Starts at `target` (open-existing) or
  // undefined for a fresh draft launch; set when a draft materializes.
  const [boundTarget, setBoundTarget] = useState<OpenFileTarget | undefined>(target);
  useEffect(() => { workspaceMediaImportEpochRef.current += 1; workspaceMediaImportCancelRef.current?.(); closeWorkspaceMediaPicker(null); }, [appId, boundTarget, auth.viewer.isVerified, auth.viewer.sessionUserId, closeWorkspaceMediaPicker]);
  const boundAppIdRef = useRef(appId);
  const boundModeRef = useRef(mode);
  const boundTargetRef = useRef<OpenFileTarget | undefined>(boundTarget);
  const [boundHumanEditUpdate, setBoundHumanEditUpdate] =
    useState<BoundHumanEditUpdate | null>(null);
  const [miniAppHumanEditState, setMiniAppHumanEditState] =
    useState<AppHumanEditUpdate["state"]>("clean");
  const [closeConfirming, setCloseConfirming] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const pendingStayRef = useRef<(() => void) | null>(null);
  const boundTargetKey =
    boundTarget?.kind === "artifact" || boundTarget?.kind === "fs"
      ? liveReviewBoundTargetKey(boundTarget)
      : null;
  const boundExportTargetIdentity = exportTargetIdentity(boundTarget);
  const draftPublisherId = useMemo(() => `${appId}:${draft?.createActionId ?? "launch"}:${crypto.randomUUID()}`, [appId, draft]);
  const humanEditPublisherKey = `${appId}:${boundTargetKey ?? draftPublisherId}`;
  const publishedHumanEditUpdate =
    humanEditPublisherKey !== null && boundHumanEditUpdate?.targetKey === humanEditPublisherKey
      ? boundHumanEditUpdate.update
      : { state: "clean" as const };
  const promotionStateRef = useRef({ sourceKey: boundTargetKey, roomId: workspaceCopyRoomId, viewerKey: auth.viewer.isVerified ? auth.viewer.sessionUserId : null, humanState: publishedHumanEditUpdate.state });
  promotionStateRef.current = { sourceKey: boundTargetKey, roomId: workspaceCopyRoomId, viewerKey: auth.viewer.isVerified ? auth.viewer.sessionUserId : null, humanState: publishedHumanEditUpdate.state };
  useEffect(() => desktopAPI?.servers?.onChanged?.(() => {
    promotionEpochRef.current += 1;
    promotedVideoProjectRef.current = null;
  }), []);
  usePublishedHumanEditLease({
    file:
      mode === "edit" && humanEditPublisherKey !== null && boundHumanEditUpdate?.targetKey === humanEditPublisherKey
        ? boundTarget
        : undefined,
    update: mode === "edit" ? publishedHumanEditUpdate : { state: "clean" },
  });
  useEffect(() => {
    if (mode !== "edit" || miniAppHumanEditState === "clean") return;
    const protectDirtyUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDirtyUnload);
    return () => window.removeEventListener("beforeunload", protectDirtyUnload);
  }, [miniAppHumanEditState, mode]);

  const prepareTransition = useCallback((
    reason: MiniAppCloseReason,
    action: MiniAppLifecycleAction = "prepare-close",
  ): Promise<boolean> => {
    lastLifecycleReasonRef.current = reason;
    if (lifecyclePreparedRef.current) {
      lifecyclePreparedRef.current = false;
      return Promise.resolve(true);
    }
    if (!lifecycleRegisteredRef.current) return Promise.resolve(true);
    if (lifecycleInFlightRef.current) return lifecycleInFlightRef.current;
    const iframe = iframeRef.current;
    if (!iframe) return Promise.resolve(false);
    const abort = new AbortController();
    lifecycleAbortRef.current = abort;
    lastLifecycleResultRef.current = null;
    setLifecycleNotice({
      kind: "saving",
      message: action === "save-copy"
        ? "Saving a recovery copy…"
        : reason === "suspend"
          ? "Saving before export…"
          : reason === "quit"
            ? "Saving before quitting…"
            : "Saving before closing…",
    });
    const attempt = lifecycleRequester({ iframe, reason, action, signal: abort.signal })
      .then((outcome) => {
        if (outcome.status === "ready") {
          lastLifecycleResultRef.current = outcome.result;
          setLifecycleNotice(null);
          return true;
        }
        if (outcome.status === "blocked") {
          setLifecycleNotice({ kind: "blocked", message: outcome.message });
        } else {
          setLifecycleNotice(null);
        }
        return false;
      })
      .finally(() => {
        if (lifecycleInFlightRef.current === attempt) lifecycleInFlightRef.current = null;
        if (lifecycleAbortRef.current === abort) lifecycleAbortRef.current = null;
      });
    lifecycleInFlightRef.current = attempt;
    return attempt;
  }, [lifecycleRequester]);

  const retryLifecycleTransition = useCallback(async (
    action: MiniAppLifecycleAction = "prepare-close",
  ): Promise<void> => {
    if (!(await prepareTransition(lastLifecycleReasonRef.current, action))) return;
    if (lastLifecycleReasonRef.current === "suspend" || lastLifecycleReasonRef.current === "quit") {
      // Saving succeeded; keep the editor open so the user can retry the
      // original export or native quit through its own authority boundary.
      lifecyclePreparedRef.current = false;
      return;
    }
    // Work-surface retries re-enter the parent's guarded setter, so carry one
    // prepared result across that immediate second call. Route retries resume
    // their exact blocker directly and must not leave a token that could let a
    // later, unrelated transition skip persistence.
    lifecyclePreparedRef.current = lastLifecycleReasonRef.current !== "navigate";
    if (onLifecycleRetryReady) onLifecycleRetryReady();
    else onClose();
  }, [onClose, onLifecycleRetryReady, prepareTransition]);

  useEffect(() => {
    return () => {
      onRegisterTransitionGuard?.(null);
      lifecycleAbortRef.current?.abort();
    };
  }, [onRegisterTransitionGuard]);
  const hasUncleanHumanEdit = mode === "edit" && publishedHumanEditUpdate.state !== "clean";
  const hasUncleanHumanEditRef = useRef(hasUncleanHumanEdit);
  hasUncleanHumanEditRef.current = hasUncleanHumanEdit;

  useEffect(() => {
    if (hasUncleanHumanEdit) return;
    setCloseConfirming(false);
    const leave = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    pendingStayRef.current = null;
    leave?.();
  }, [hasUncleanHumanEdit]);

  const requestLeave = useCallback((leave: () => void, stay?: () => void) => {
    if (lifecycleRegisteredRef.current || !hasUncleanHumanEditRef.current) {
      leave();
      return;
    }
    pendingLeaveRef.current = leave;
    pendingStayRef.current = stay ?? null;
    setCloseConfirming(true);
  }, []);

  useEffect(() => {
    registerBeforeLeave?.(requestLeave);
    return () => registerBeforeLeave?.(null);
  }, [registerBeforeLeave, requestLeave]);

  useEffect(() => {
    if (mode !== "preview") return;
    lifecycleRegisteredRef.current = false;
    lifecycleAbortRef.current?.abort();
    onRegisterTransitionGuard?.(null);
    setMiniAppHumanEditState("clean");
    setBoundHumanEditUpdate(null);
  }, [mode, onRegisterTransitionGuard]);


  const requestClose = useCallback(() => {
    requestLeave(onClose);
  }, [onClose, requestLeave]);
  // The doc name shown in the header. For a draft it's the not-yet-saved
  // suggested name (editable, used at materialize); for an artifact it's the
  // basename (rename hits the API). Mirrored into a ref so the materialize
  // callback reads the latest typed name without re-installing the bridge.
  const initialName =
    target?.kind === "artifact"
      ? basename(target.path)
      : target?.kind === "fs"
        ? basename(target.path)
        : (draft?.suggestedName ?? "");
  const [docName, setDocName] = useState(initialName);
  const docNameRef = useRef(initialName);
  const [editingName, setEditingName] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportInFlight, setExportInFlight] = useState(false);
  const [exportPreparing, setExportPreparing] = useState(false);
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null);
  const exportSequenceRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportSurfaceMountedRef = useRef(true);
  const lifecycleRegisteredRef = useRef(false);
  const lifecyclePreparedRef = useRef(false);
  const lastLifecycleResultRef = useRef<{
    documentSaved: boolean;
    recoveryPersisted: boolean;
    recoverableDraftExact: boolean;
  } | null>(null);
  const lifecycleInFlightRef = useRef<Promise<boolean> | null>(null);
  const lifecycleAbortRef = useRef<AbortController | null>(null);
  const lastLifecycleReasonRef = useRef<MiniAppCloseReason>("close");
  const [lifecycleNotice, setLifecycleNotice] = useState<
    { kind: "saving" | "blocked"; message: string } | null
  >(null);
  const conversionRunner = useConversionRunner();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const focusRenameAfterMaterializeRef = useRef(false);
  // D342 Phase 2 — surface-owned single-flight for materialize. The bridge also
  // guards its own closure, but it can be re-installed mid-session (effect deps
  // change); this ref makes the create idempotent across re-installs so a draft
  // can never spawn two artifacts.
  const materializeOnceRef = useRef<Promise<ArtifactTarget> | null>(null);

  boundTargetRef.current = boundTarget;
  themeRef.current = theme;
  chatVisibleRef.current = Boolean(chatVisible);
  onToggleChatRef.current = onToggleChat;
  browserVisibleRef.current = Boolean(browserVisible);
  onToggleBrowserRef.current = onToggleBrowser;

  const setVideoHostFullWidth = useCallback((input: { enabled: boolean }): void => {
    if (input.enabled) {
      if (videoHostFullWidthSnapshotRef.current) return;
      videoHostFullWidthSnapshotRef.current = {
        chatVisible: chatVisibleRef.current,
        browserVisible: browserVisibleRef.current,
      };
      if (chatVisibleRef.current) {
        onToggleChatRef.current?.();
        chatVisibleRef.current = false;
      }
      if (browserVisibleRef.current) {
        onToggleBrowserRef.current?.();
        browserVisibleRef.current = false;
      }
      return;
    }
    const snapshot = videoHostFullWidthSnapshotRef.current;
    if (!snapshot) return;
    videoHostFullWidthSnapshotRef.current = null;
    if (chatVisibleRef.current !== snapshot.chatVisible) {
      onToggleChatRef.current?.();
      chatVisibleRef.current = snapshot.chatVisible;
    }
    if (browserVisibleRef.current !== snapshot.browserVisible) {
      onToggleBrowserRef.current?.();
      browserVisibleRef.current = snapshot.browserVisible;
    }
  }, []);

  useEffect(() => {
    exportSurfaceMountedRef.current = true;
    return () => {
      exportSurfaceMountedRef.current = false;
      exportSequenceRef.current += 1;
      exportAbortRef.current?.abort();
    };
  }, []);

  // An export result belongs only to the app/document it started from. This
  // prevents a late artifact lookup from opening a result into a newly-bound
  // app surface after navigation or a prop change.
  const exportRuntimeSourceHash = state.kind === "ready" ? state.runtime.sourceHash : null;
  useEffect(() => {
    exportSequenceRef.current += 1;
    exportAbortRef.current?.abort();
    setExportInFlight(false);
    setExportPreparing(false);
  }, [appId, boundExportTargetIdentity, iframeKey, exportRuntimeSourceHash, mode]);

  const setName = useCallback((next: string) => {
    docNameRef.current = next;
    setDocName(next);
  }, []);

  const invalidateVideoGenerationSession = useCallback((reissue = false) => {
    videoHostManager.clear();
    videoGenerationSessionRef.current = null;
    const pendingReview = privateVideoGenerationReviewRef.current;
    privateVideoGenerationReviewRef.current = null;
    if (pendingReview) pendingReview.resolve(pendingReview.submissionAttempted ? { kind: "submission-unknown", takeId: pendingReview.takeId } : { kind: "expired" });
    setVideoGenerationReview(null);
    setVideoGenerationReviewError(null);
    setVideoGenerationSubmitting(false);
    clearVideoGenerationPreview();
    // A saved-document revision expires the paid quote, not the native media
    // operation. Target/app/auth teardown owns Workspace import/preview cleanup.
    if (reissue) setVideoGenerationSessionEpoch((epoch) => epoch + 1);
  }, [clearVideoGenerationPreview, videoHostManager]);

  // Reset bound doc + name when the surface is pointed at a different app/doc.
  useEffect(() => {
    // Renaming the same artifact changes display metadata, not its write lane.
    // Keep the existing bridge and document session alive through in-flight saves.
    const sameBinding = boundAppIdRef.current === appId && boundModeRef.current === mode && (boundTargetRef.current === target || (
      boundTargetRef.current?.kind === "artifact" && target?.kind === "artifact" &&
      boundTargetRef.current.id === target.id &&
      (boundTargetRef.current.roomId ?? null) === (target.roomId ?? null)
    ));
    boundAppIdRef.current = appId;
    boundModeRef.current = mode;
    if (!sameBinding) {
      activeContextRef.current = null;
      setMiniAppHumanEditState("clean");
      setBoundTarget(target);
    }
    const name =
      target?.kind === "artifact" || target?.kind === "fs"
        ? basename(target.path)
        : (draft?.suggestedName ?? "");
    docNameRef.current = name;
    setDocName(name);
    setEditingName(false);
    setRenameError(null);
    setExportMenuOpen(false);
    setExportNotice(null);
    focusRenameAfterMaterializeRef.current = false;
    materializeOnceRef.current = null;
    if (!sameBinding) resetDocumentReadSession(documentSessionRef.current);
    if (documentChangedTimerRef.current) {
      clearTimeout(documentChangedTimerRef.current);
      documentChangedTimerRef.current = null;
    }
    // appId/target/draft identity drives a fresh binding.
  }, [appId, target, draft, mode]);

  // D342 Phase 2 — create the deferred artifact on first edit, using the live
  // (possibly user-typed) name. Idempotent: at most one artifact per draft,
  // even if the bridge re-installs and calls this again.
  const materialize = useCallback(
    (content: string, mimeType: string): Promise<ArtifactTarget> => {
      if (materializeOnceRef.current) return materializeOnceRef.current;
      const run = (async (): Promise<ArtifactTarget> => {
        const roomOpts = draft?.roomId ? { roomId: draft.roomId } : {};
        const desired = docNameRef.current.trim() || draft?.suggestedName || "Untitled";
        const listRootArtifactNames = async (): Promise<string[]> => {
          const { artifacts } = await apiClient.listWorkspaceArtifacts(roomOpts);
          return (artifacts ?? [])
            .filter((a) => !a.path.includes("/"))
            .map((a) => a.path);
        };
        const createArtifact = async (path: string) => {
          const blob = new Blob([content], { type: mimeType });
          return apiClient.createWorkspaceArtifact(blob, {
            path,
            mimeType,
            ...(draft?.roomId ? { roomId: draft.roomId } : {}),
          });
        };
        let existing: string[] = [];
        try {
          existing = await listRootArtifactNames();
        } catch {
          /* best-effort dedup */
        }
        let path = buildUniqueDraftPath({ desiredName: desired, existingNames: existing });
        let created;
        try {
          created = await createArtifact(path);
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          try {
            existing = await listRootArtifactNames();
          } catch {
            /* Retry still avoids the path that just collided. */
          }
          path = buildUniqueDraftPath({
            desiredName: desired,
            existingNames: [...existing, path],
          });
          created = await createArtifact(path);
        }
        const artifact = makeArtifactTarget({
          id: created.id,
          path: created.path,
          mimeType: created.mimeType,
          ...(draft?.roomId ? { roomId: draft.roomId } : {}),
        });
        setBoundTarget(artifact);
        setName(basename(created.path));
        focusRenameAfterMaterializeRef.current = true;
        onMaterialized?.(artifact);
        return artifact;
      })();
      // Cache the in-flight promise so a concurrent/re-installed caller reuses
      // it; on failure clear so a later edit can retry.
      materializeOnceRef.current = run;
      run.catch(() => {
        materializeOnceRef.current = null;
      });
      return run;
    },
    [draft, onMaterialized, setName],
  );

  const commitRename = useCallback(async () => {
    const next = docNameRef.current.trim();
    setEditingName(false);
    if (!boundTarget || boundTarget.kind !== "artifact") return;
    const current = basename(boundTarget.path);
    if (next.length === 0 || next === current) {
      setName(current);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const roomOpts =
        boundTarget.roomId !== undefined && boundTarget.roomId.length > 0
          ? { roomId: boundTarget.roomId }
          : undefined;
      const updated = await apiClient.renameWorkspaceArtifact(boundTarget.id, next, roomOpts);
      setBoundTarget(
        makeArtifactTarget({
          id: boundTarget.id,
          path: updated.path,
          mimeType: boundTarget.mimeType,
          ...(boundTarget.roomId ? { roomId: boundTarget.roomId } : {}),
        }),
      );
      setName(basename(updated.path));
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Could not rename.");
      setName(current);
    } finally {
      setRenaming(false);
    }
  }, [boundTarget, setName]);

  // Auto-focus the rename field the moment a draft materializes, so the user
  // can name the "Untitled …" doc right there.
  useEffect(() => {
    if (boundTarget?.kind === "artifact" && focusRenameAfterMaterializeRef.current) {
      focusRenameAfterMaterializeRef.current = false;
      setEditingName(true);
    }
  }, [boundTarget]);

  useEffect(() => {
    if (editingName) {
      const el = renameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [editingName]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setPendingSourceHash(null);
    setReloadNotice(null);
    setReloadInFlight(false);
    runtimeSourceHashRef.current = null;
    void (async () => {
      try {
        const runtime = await loadMiniAppRuntime(appId);
        if (cancelled) return;
        runtimeSourceHashRef.current = runtime.sourceHash;
        setState({ kind: "ready", runtime });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: "error", message: sanitizeRuntimeError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const reloadRuntime = useCallback(async () => {
    if (reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    setReloadInFlight(true);
    try {
      const runtime = await loadMiniAppRuntime(appId);
      if (runtimeSourceHashRef.current === runtime.sourceHash) {
        setPendingSourceHash(null);
        return;
      }
      runtimeSourceHashRef.current = runtime.sourceHash;
      setState({ kind: "ready", runtime });
      setIframeKey((key) => key + 1);
      setPendingSourceHash(null);
      setReloadNotice("App reloaded after source change.");
    } catch (err) {
      setState({ kind: "error", message: sanitizeRuntimeError(err) });
    } finally {
      reloadInFlightRef.current = false;
      setReloadInFlight(false);
    }
  }, [appId]);

  useAppEvents(
    useCallback(
      (event) => {
        if (event.type !== "changed") return;
        if (event.appId !== appId) return;
        if (runtimeSourceHashRef.current === event.sourceHash) return;
        setPendingSourceHash(event.sourceHash);
        setReloadNotice(null);
      },
      [appId],
    ),
  );

  const runtime = state.kind === "ready" ? state.runtime : null;
  const nativeRecovery = desktopAPI?.miniAppRecovery;
  const recoveryEnabled = mode === "edit" && (appId === "nautilo-presentation" || appId === "nautilo-board") && nativeRecovery !== undefined;
  const templatesEnabled = mode === "edit" && appId === "nautilo-presentation" && auth.viewer.isVerified;
  const templateAuthorityKey = JSON.stringify([templatesEnabled, auth.viewer.sessionUserId, auth.viewerGeneration]);
  const templateAuthorityRef = useRef(templateAuthorityKey);
  templateAuthorityRef.current = templateAuthorityKey;
  const templateBinding = useMemo(() => {
    if (!templatesEnabled) return undefined;
    const binding = { active: true, key: templateAuthorityKey };
    return {
      binding,
      library: createSlidesTemplateLibrary({
        isAuthorityCurrent: () => binding.active && templateAuthorityRef.current === binding.key,
      }),
    };
  }, [templateAuthorityKey, templatesEnabled]);
  useEffect(() => {
    if (!templateBinding) return;
    templateBinding.binding.active = true;
    const unsubscribe = addAuthTransitionListener((detail) => {
      if (detail.viewerGeneration !== auth.viewerGeneration || detail.reason === "signed-out" ||
        detail.reason === "user-switched" || detail.reason === "instance-switched") {
        templateBinding.binding.active = false;
      }
    });
    return () => { templateBinding.binding.active = false; unsubscribe(); };
  }, [templateBinding, auth.viewerGeneration]);
  const templates = templateBinding?.library;
  const exportActions = useMemo(() => {
    const actions = runtime?.manifest.conversions?.export ?? [];
    if (!boundTarget) return actions;
    const surface = boundTarget.kind === "artifact" ? "workspace" : "currentFolder";
    return actions.filter((action) => action.targetSurfaces.includes(surface));
  }, [runtime, boundTarget]);
  const iframeInstanceKey = runtime ? `${runtime.sourceHash}:${mode}:${iframeKey}` : null;
  const iframeSrcDoc = useMemo(() => {
    if (!runtime || iframeBootstrap?.key !== iframeInstanceKey) return "";
    return srcDocWithAppBridgeClient(
      runtime.srcDoc,
      iframeBootstrap.theme,
      runtime.hostCapabilities,
      mode,
      { recovery: recoveryEnabled, templates: templatesEnabled },
    );
  }, [iframeBootstrap, iframeInstanceKey, mode, recoveryEnabled, templatesEnabled, runtime]);

  // Header doc-name affordance: show a name whenever a doc (or pending draft)
  // exists; allow inline rename for artifacts (API) and pre-save drafts (local).
  const hasDoc = boundTarget !== undefined || draft !== undefined;
  const hasBoundDoc = boundTarget !== undefined;
  const canExport = mode === "edit" && hasBoundDoc && exportActions.length > 0 && !exportInFlight;
  const designScopeChoices = appId === "nautilo-design"
    ? designExportScopeChoices(activeContextRef.current)
    : [];
  const canRename = mode === "edit" &&
    (boundTarget?.kind === "artifact" || (boundTarget === undefined && draft !== undefined));
  // A prop target change renders before the binding-reset effect below. Do not
  // let an old in-flight refresh revive that previous artifact in this gap.
  liveSessionTargetRef.current =
    mode === "edit" && runtime?.manifest.liveReview?.enabled === true &&
    (boundTarget?.kind === "artifact" || boundTarget?.kind === "fs") &&
    (target === undefined || target === boundTarget || (target.kind === "artifact" && boundTarget.kind === "artifact" && target.id === boundTarget.id))
      ? boundTarget
      : null;

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const targetNode = event.target;
      if (!(targetNode instanceof Node)) return;
      if (!exportMenuRef.current?.contains(targetNode)) setExportMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [exportMenuOpen]);

  const handleExport = useCallback(
    async (action: (typeof exportActions)[number], scope?: DesignExportScope) => {
      if (mode !== "edit" || !boundTarget || exportInFlight) return;

      const startingIdentity = exportTargetIdentity(boundTarget);
      if (!(await prepareTransition("suspend"))) return;
      if (!exportSurfaceMountedRef.current || exportTargetIdentity(boundTargetRef.current) !== startingIdentity) return;
      if (lifecycleRegisteredRef.current && lastLifecycleResultRef.current?.documentSaved !== true) {
        setLifecycleNotice({
          kind: "blocked",
          message: "Export requires the current document to be saved to its original location.",
        });
        return;
      }

      const request = buildExportRequest(boundTarget, action, scope);
      const sourceTarget = boundTarget;
      const sourceTargetIdentity = exportTargetIdentity(sourceTarget);
      const exportSequence = ++exportSequenceRef.current;
      const isCurrentExport = () =>
        exportSurfaceMountedRef.current &&
        exportSequenceRef.current === exportSequence &&
        exportTargetIdentity(boundTargetRef.current) === sourceTargetIdentity;
      const abort = new AbortController();
      exportAbortRef.current = abort;
      setExportMenuOpen(false);
      setExportInFlight(true);
      setExportNotice(null);
      try {
        if (action.prepareInApp) {
          const iframe = iframeRef.current;
          if (!iframe) throw new Error("The app must be open to prepare this export.");
          setExportPreparing(true);
          request.preparedExport = await exportRequester({
            iframe, actionId: action.id, mimeType: action.to.mimeType, signal: abort.signal,
          });
          if (!isCurrentExport()) return;
          setExportPreparing(false);
        }
        // The shared runner owns the overwrite / rename / cancel loop so export
        // matches import behavior for both artifacts and current-folder files.
        const outcome = await conversionRunner.run(appId, request, {
          signal: abort.signal,
          ...(action.selectWorkspaceDestination === true && boundTarget.kind === "artifact"
            ? { selectWorkspaceDestination: true }
            : {}),
        });
        if (!isCurrentExport()) return;
        if (outcome.status === "cancelled") return;
        if (outcome.status === "error") {
          setExportNotice({ kind: "error", message: outcome.message });
          return;
        }
        const result = outcome.result as ExportResult;
        if (result.status === "exported") {
          const opened = await openExportedResult(
            sourceTarget,
            result,
            request.target.path,
            isCurrentExport,
          );
          if (!isCurrentExport()) return;
          const displayPath = result.displayPath ?? result.artifactPath ?? request.target.path;
          setExportNotice({
            kind: "success",
            message: opened.opened
              ? `Exported to ${displayPath} and opened it.`
              : `Exported to ${displayPath}.`,
          });
          return;
        }
        setExportNotice({ kind: "error", message: exportFailureMessage(result) });
      } catch (err) {
        if (!isCurrentExport() || abort.signal.aborted) return;
        setExportNotice({
          kind: "error",
          message: err instanceof Error ? err.message : "Export failed.",
        });
      } finally {
        if (exportAbortRef.current === abort) exportAbortRef.current = null;
        if (isCurrentExport()) { setExportInFlight(false); setExportPreparing(false); }
      }
    },
    [appId, boundTarget, exportInFlight, conversionRunner, mode, prepareTransition, exportRequester],
  );

  const publishLiveCapability = useCallback(
    (
      iframe: HTMLIFrameElement,
      capability: {
        sessionToken: string;
        sessionId: string;
        documentVersion: LiveDocumentVersion;
      },
    ) => {
      postAppLiveSession(iframe, {
        sessionToken: capability.sessionToken,
        sessionId: capability.sessionId,
        documentVersion: capability.documentVersion,
      });
      setCommandSession((current) => current?.iframe === iframe && current.token === capability.sessionToken && current.sessionId === capability.sessionId
        ? current
        : { iframe, token: capability.sessionToken, sessionId: capability.sessionId, documentVersion: capability.documentVersion });
    },
    [],
  );

  useEffect(() => {
    if (!commandSession || bridgeReadyIframeKey !== iframeInstanceKey || iframeRef.current !== commandSession.iframe) return;
    const controller = new AbortController();
    const session = commandSession;
    void (async () => {
      while (!controller.signal.aborted) {
        const response = await apiClient.receiveLiveAppCommand(appId, session.token, controller.signal);
        if (controller.signal.aborted) return;
        if (!response.command) {
          if (response.renewed === true) continue;
          return;
        }
        const current = liveSessionRef.current;
        if (!current || current.token !== session.token || iframeRef.current !== session.iframe ||
            !liveDocumentVersionEquals(current.documentVersion, response.command.documentVersion)) return;
        const result = await sendLiveAppCommand(session.iframe, session.sessionId, response.command, controller.signal);
        if (controller.signal.aborted) return;
        await apiClient.completeLiveAppCommand(appId, session.token, response.command.requestId, result);
      }
    })().catch(() => {
      // Never replay an uncertain command. Reopening/renewing the session
      // establishes a fresh receiver; the tool reports unavailable meanwhile.
    });
    return () => controller.abort();
  }, [appId, commandSession, bridgeReadyIframeKey, iframeInstanceKey]);

  const deliverMatchingLiveProposal = useCallback(
    (proposal: LiveAppProposal, options?: { allowStaleVersion?: boolean }): void => {
      const session = liveSessionRef.current;
      const iframe = iframeRef.current;
      if (
        mode !== "edit" ||
        !session ||
        !iframe ||
        proposal.appId !== appId ||
        proposal.sessionId !== session.sessionId ||
        (!options?.allowStaleVersion &&
          !liveDocumentVersionEquals(proposal.documentVersion, session.documentVersion)) ||
        deliveredLiveProposalIdsRef.current.has(proposal.proposalId)
      ) {
        return;
      }
      postAppLiveProposal(iframe, proposal);
      liveProposalsAwaitingAckRef.current.set(proposal.proposalId, proposal);
    },
    [appId, mode],
  );

  const acknowledgeMatchingLiveProposal = useCallback(
    (acknowledgement: { proposalId: string; documentVersion: LiveDocumentVersion }): void => {
      const session = liveSessionRef.current;
      const sent = liveProposalsAwaitingAckRef.current.get(acknowledgement.proposalId);
      if (
        mode !== "edit" ||
        !session ||
        !sent ||
        sent.sessionId !== session.sessionId ||
        !liveDocumentVersionEquals(sent.documentVersion, acknowledgement.documentVersion) ||
        !liveDocumentVersionEquals(session.documentVersion, acknowledgement.documentVersion)
      ) return;
      liveProposalsAwaitingAckRef.current.delete(acknowledgement.proposalId);
      deliveredLiveProposalIdsRef.current.add(acknowledgement.proposalId);
      if (deliveredLiveProposalIdsRef.current.size > 256) {
        const oldest = deliveredLiveProposalIdsRef.current.values().next().value;
        if (oldest) deliveredLiveProposalIdsRef.current.delete(oldest);
      }
    },
    [mode],
  );

  const reconcileLiveProposals = useCallback(async (): Promise<void> => {
    if (mode !== "edit") return;
    replayLiveAppProposals(deliverMatchingLiveProposal);
    const session = liveSessionRef.current;
    const iframe = iframeRef.current;
    if (!session || !iframe) return;
    try {
      const response = await apiClient.listPendingLiveProposalReviews(appId, {
        sessionToken: session.token,
      });
      if (
        liveSessionRef.current?.token !== session.token ||
        iframeRef.current !== iframe
      ) return;
      // The server may return one exact unresolved proposal whose base is
      // older than the refreshed capability. Writer must see that replay to
      // close it through the captured-token invalidation path; ordinary bus
      // delivery remains version-gated above.
      for (const proposal of response.proposals) {
        deliverMatchingLiveProposal(proposal, { allowStaleVersion: true });
      }
    } catch {
      /* Session issue/refresh and the next Task event retry reconciliation. */
    }
  }, [appId, deliverMatchingLiveProposal, mode]);

  useEffect(() => {
    deliveredLiveProposalIdsRef.current.clear();
    liveProposalsAwaitingAckRef.current.clear();
  }, [iframeInstanceKey]);

  const refreshLiveSession = useCallback(
    async (documentVersion: LiveDocumentVersion, expectedToken?: string): Promise<void> => {
      const session = liveSessionRef.current;
      const iframe = iframeRef.current;
      const liveTarget = liveSessionTargetRef.current;
      if (
        mode !== "edit" ||
        runtime?.manifest.liveReview?.enabled !== true ||
        !liveTarget ||
        !iframe
      ) {
        return;
      }
      if (!session) {
        // A recovered document or relay may become available after initial
        // issuance failed. Retry from canonical authority without remounting.
        if (expectedToken === undefined) await issueLiveSessionRef.current?.();
        return;
      }
      if (
        session.targetKey !== liveReviewBoundTargetKey(liveTarget) ||
        (expectedToken !== undefined && session.token !== expectedToken)
      ) {
        return;
      }
      if (liveSessionTimerRef.current) {
        clearTimeout(liveSessionTimerRef.current);
        liveSessionTimerRef.current = null;
      }
      const requestSequence = ++liveSessionRequestSequenceRef.current;
      const relayIdHint = liveTarget.kind === "fs" ? await getDesktopRelayId() : null;
      const refreshBody = buildIssueLiveSessionRequest(liveTarget, documentVersion, relayIdHint);
      if (!refreshBody) return;
      try {
        const capability = await apiClient.refreshLiveMiniAppSession(appId, {
          sessionToken: session.token,
          ...refreshBody,
        });
        if (
          liveSessionRequestSequenceRef.current !== requestSequence ||
          liveSessionRef.current?.token !== session.token ||
          iframeRef.current !== iframe
        ) {
          return;
        }
        const renewed: LiveAppSession = {
          token: capability.sessionToken,
          sessionId: capability.sessionId,
          documentVersion: capability.documentVersion,
          expiresAt: capability.expiresAt,
          targetKey: liveReviewBoundTargetKey(liveTarget),
        };
        liveSessionRef.current = renewed;
        onLiveMiniAppSessionChange?.({
          sessionToken: renewed.token,
          sessionId: renewed.sessionId,
          documentVersion: renewed.documentVersion,
        });
        publishLiveCapability(iframe, capability);
        void reconcileLiveProposals();
        scheduleLiveSessionRefreshRef.current(renewed);
      } catch (err: unknown) {
        if (!isClosedLiveSessionError(err)) return;
        if (
          liveSessionRequestSequenceRef.current !== requestSequence ||
          liveSessionRef.current?.token !== session.token ||
          liveSessionRef.current?.targetKey !== liveReviewBoundTargetKey(liveTarget) ||
          iframeRef.current !== iframe ||
          liveSessionTargetRef.current !== liveTarget
        ) {
          return;
        }
        try {
          const envelope = await readDocumentSession(documentSessionRef.current, liveTarget);
          const nextVersion: LiveDocumentVersion | null =
            liveTarget.kind === "artifact" && typeof envelope.baseRevision === "number"
              ? { kind: "artifact_revision", revision: envelope.baseRevision }
              : liveTarget.kind === "fs" && typeof envelope.baseSha256 === "string"
                ? { kind: "local_sha", sha256: envelope.baseSha256 }
                : null;
          if (!nextVersion) return;
          if (
            liveSessionRequestSequenceRef.current !== requestSequence ||
            liveSessionRef.current?.token !== session.token ||
            iframeRef.current !== iframe ||
            liveSessionTargetRef.current !== liveTarget
          ) {
            return;
          }
          const replacementRelayIdHint = liveTarget.kind === "fs" ? await getDesktopRelayId() : null;
          const issueBody = buildIssueLiveSessionRequest(liveTarget, nextVersion, replacementRelayIdHint);
          if (!issueBody) return;
          const capability = await apiClient.issueLiveMiniAppSession(appId, issueBody);
          if (
            liveSessionRequestSequenceRef.current !== requestSequence ||
            liveSessionRef.current?.token !== session.token ||
            iframeRef.current !== iframe ||
            liveSessionTargetRef.current !== liveTarget
          ) {
            void apiClient.revokeLiveMiniAppSession(appId, {
              sessionToken: capability.sessionToken,
            });
            return;
          }
          const replacement: LiveAppSession = {
            token: capability.sessionToken,
            sessionId: capability.sessionId,
            documentVersion: capability.documentVersion,
            expiresAt: capability.expiresAt,
            targetKey: liveReviewBoundTargetKey(liveTarget),
          };
          liveSessionRequestSequenceRef.current += 1;
          liveSessionRef.current = replacement;
          onLiveMiniAppSessionChange?.({
            sessionToken: replacement.token,
            sessionId: replacement.sessionId,
            documentVersion: replacement.documentVersion,
          });
          publishLiveCapability(iframe, capability);
          void reconcileLiveProposals();
          scheduleLiveSessionRefreshRef.current(replacement);
        } catch {
          /* fail closed */
        }
      }
    },
    [
      appId,
      mode,
      publishLiveCapability,
      reconcileLiveProposals,
      runtime?.manifest.liveReview?.enabled,
      onLiveMiniAppSessionChange,
    ],
  );

  const scheduleLiveSessionRefresh = useCallback(
    (session: LiveAppSession) => {
      if (mode !== "edit") return;
      if (liveSessionTimerRef.current) clearTimeout(liveSessionTimerRef.current);
      liveSessionTimerRef.current = null;
      const delay = liveSessionRefreshDelay(session.expiresAt);
      if (delay === null) return;
      liveSessionTimerRef.current = setTimeout(() => {
        liveSessionTimerRef.current = null;
        if (liveSessionRef.current?.token !== session.token) return;
        void refreshLiveSession(liveSessionRef.current.documentVersion, session.token);
      }, delay);
    },
    [mode, refreshLiveSession],
  );
  scheduleLiveSessionRefreshRef.current = scheduleLiveSessionRefresh;

  const handleLiveProposalAccepted = useCallback(
    (result: ApplyAcceptedLiveProposalResponse) => {
      if (mode !== "edit") return;
      const session = liveSessionRef.current;
      const iframe = iframeRef.current;
      const liveTarget = liveSessionTargetRef.current;
      if (!session || !iframe || !liveTarget) return;
      if (liveTarget.kind === "fs" && result.documentVersion.kind === "local_sha") {
        registerLocalFsSaveSha(liveTarget.path, result.documentVersion.sha256);
      }
      const nextSession: LiveAppSession = {
        ...session,
        documentVersion: result.documentVersion,
      };
      liveSessionRef.current = nextSession;
      onLiveMiniAppSessionChange?.({
        sessionToken: nextSession.token,
        sessionId: nextSession.sessionId,
        documentVersion: nextSession.documentVersion,
      });
      publishLiveCapability(iframe, {
        sessionToken: nextSession.token,
        sessionId: nextSession.sessionId,
        documentVersion: nextSession.documentVersion,
      });
    },
    [mode, onLiveMiniAppSessionChange, publishLiveCapability],
  );

  const ensureVideoHostSession = useCallback(async () => {
    const binding = videoHostBindingRef.current;
    if (!binding) return null;
    try {
      const session = await videoHostManager.get(binding);
      if (videoHostBindingRef.current !== binding || !session) return null;
      if (videoGenerationSessionRef.current !== session && privateVideoGenerationReviewRef.current) {
        const review = privateVideoGenerationReviewRef.current;
        review.resolve(review.submissionAttempted ? { kind: "submission-unknown", takeId: review.takeId } : { kind: "expired" });
        privateVideoGenerationReviewRef.current = null;
        setVideoGenerationReview(null);
        setVideoGenerationReviewError(null);
        setVideoGenerationSubmitting(false);
      }
      videoGenerationSessionRef.current = session;
      return session;
    } catch { return null; }
  }, [videoHostManager]);

  useEffect(() => {
    const eligible = mode === "edit" && appId === "nautilo-video" && runtime?.hostCapabilities?.videoGeneration === true &&
      auth.viewer.isVerified && boundTarget?.kind === "artifact" && boundTarget.path.endsWith(".video.html") &&
      typeof boundTarget.roomId === "string" && boundTarget.roomId.length > 0;
    if (!eligible || !boundTarget || boundTarget.kind !== "artifact" || !auth.viewer.sessionUserId) return;
    videoHostBindingRef.current = {
      targetKey: liveReviewBoundTargetKey(boundTarget), userId: auth.viewer.sessionUserId,
      sourceHash: runtime.sourceHash, roomId: boundTarget.roomId!,
    };
    void ensureVideoHostSession();
    return () => {
      videoHostBindingRef.current = null;
      invalidateVideoGenerationSession();
    };
  }, [appId, mode, auth.viewer.isVerified, auth.viewer.sessionUserId, boundTarget,
    runtime?.sourceHash, runtime?.hostCapabilities?.videoGeneration, videoGenerationSessionEpoch,
    ensureVideoHostSession, invalidateVideoGenerationSession]);

  const requestVideoGenerationReview = useCallback(async (request: VideoGenerationBridgeRequest) => {
    if (!supportsVideoWorkspaceMedia) {
      return { kind: "unavailable" as const, code: "desktop_required" };
    }
    const target = boundTargetRef.current;
    const session = await ensureVideoHostSession();
    if (!target || target.kind !== "artifact" || !target.path.endsWith(".video.html") || !target.roomId ||
        !session || session.targetKey !== liveReviewBoundTargetKey(target) || privateVideoGenerationReviewRef.current) {
      return { kind: "unavailable" as const, code: "unavailable" };
    }
    // The saved document is the only thing that can authorize its own plan.
    // Re-read it so an iframe cannot replay a request from an older revision.
    const envelope = await readDocumentSession(documentSessionRef.current, target);
    if (videoGenerationSessionRef.current !== session || boundTargetRef.current !== target) return { kind: "expired" as const };
    if (envelope.baseSha256 !== request.document.sha256 || envelope.baseRevision !== request.document.revision ||
        request.document.revision === null || session.projectRevision !== request.document.revision) {
      invalidateVideoGenerationSession(true);
      return { kind: "expired" as const };
    }
    const shotId = request.job.source.kind === "shot" ? request.job.source.shotId : "quick-brief";
    const shotLabel = request.job.shotLabel ?? (request.job.source.kind === "shot" ? "Shot" : "Quick brief");
    try {
      const parsed = parseVideoHtml(envelope.content);
      if (!parsed.ok || !parsed.document.project.generationBrief) return { kind: "unavailable" as const, code: "invalid_direction" };
      const brief = parsed.document.project.generationBrief;
      const shot = brief.shots.find(shot => shot.id === shotId);
      let previousSceneVideo: GenerationReference | undefined;
      if (request.job.continuationTakeId) {
        const previous = brief.shots[brief.shots.findIndex(shot => shot.id === shotId) - 1];
        if (!shot?.continueFromPrevious || !previous) return { kind: "unavailable" as const, code: "invalid_continuation" };
        const list = await apiClient.listVideoGenerationTakes({ roomId: session.roomId, projectArtifactId: session.projectArtifactId, attestationToken: session.token });
        const take = list.takes.find(take => take.takeId === request.job.continuationTakeId && take.shotId === previous.id);
        if (!take) return { kind: "unavailable" as const, code: "invalid_continuation" };
        const status = await apiClient.getVideoGenerationTakeStatus(take.takeId, { roomId: session.roomId, projectArtifactId: session.projectArtifactId, attestationToken: session.token });
        if (!status.artifact || !["ready", "cleanup-pending"].includes(status.state) || status.artifact.mime !== "video/mp4") return { kind: "unavailable" as const, code: "continuation_not_ready" };
        previousSceneVideo = { id: "previous-scene", name: "Previous scene", mediaKind: "video",
          source: { kind: "workspace-artifact", artifactId: status.artifact.artifactId, path: status.artifact.path, mimeType: status.artifact.mime, sizeBytes: status.artifact.bytes } };
      }
      const job = await compileBoundVideoGenerationRequest(envelope.content, request, previousSceneVideo);
      const current = await readDocumentSession(documentSessionRef.current, target);
      if (current.baseSha256 !== envelope.baseSha256 || videoGenerationSessionRef.current !== session ||
          boundTargetRef.current !== target) return { kind: "expired" as const };

      const review = await apiClient.prepareVideoGeneration({
        roomId: session.roomId,
        projectArtifactId: session.projectArtifactId,
        requestId: request.requestId,
        shotId,
        shotLabel,
        briefDigest: request.sourceFingerprint,
        documentRevision: request.document.revision,
        job: { ...coordinatorVideoJob(request), ...(job.referenceImages ? { referenceImages: [...job.referenceImages] } : {}), ...(job.referenceVideos ? { referenceVideos: [...job.referenceVideos] } : {}), ...(job.referenceAudios ? { referenceAudios: [...job.referenceAudios] } : {}) },
      }, session.token);
      if (videoGenerationSessionRef.current !== session || boundTargetRef.current !== target) return { kind: "expired" as const };
      // The full prompt has already left the parent for D525; retain only the
      // safe approval projection in React state and its private handle in ref.
      return new Promise<
        { kind: "queued"; takeId: string } | { kind: "cancelled" } | { kind: "submission-unknown"; takeId: string } | { kind: "expired" } | { kind: "unavailable"; code: string }
      >((resolve) => {
        privateVideoGenerationReviewRef.current = { takeId: review.takeId, reviewHandle: review.reviewHandle, submissionAttempted: false, submissionUncertain: false, submitting: false, resolve };
        setVideoGenerationReview({ approval: review.approval, presentation: job.presentation, roomId: session.roomId });
        setVideoGenerationReviewError(null);
      });
    } catch (err) {
      if (videoGenerationSessionRef.current !== session || boundTargetRef.current !== target) return { kind: "expired" as const };
      if (err instanceof VideoGenerationPreparationError) return { kind: "unavailable" as const, code: err.code, message: err.message };
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 409 || err.status === 410)) {
        invalidateVideoGenerationSession(true);
        return { kind: "expired" as const };
      }
      return { kind: "unavailable" as const, code: "unavailable" };
    }
  }, [invalidateVideoGenerationSession, ensureVideoHostSession, supportsVideoWorkspaceMedia]);

  const listVideoGenerationTakes = useCallback(async () => {
    const session = await ensureVideoHostSession();
    if (!session) return { kind: "unavailable" as const, code: "unavailable" };
    try {
      const result = await apiClient.listVideoGenerationTakes({
        roomId: session.roomId,
        projectArtifactId: session.projectArtifactId,
        attestationToken: session.token,
      });
      if (videoGenerationSessionRef.current !== session) return { kind: "unavailable" as const, code: "unavailable" };
      return { kind: "ready" as const, takes: result.takes.map((take) => ({
        takeId: take.takeId,
        shotId: take.shotId,
        shotLabel: take.shotLabel,
        documentRevision: take.documentRevision,
      })) };
    } catch (err) {
      if (videoGenerationSessionRef.current === session && err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 409 || err.status === 410)) {
        invalidateVideoGenerationSession(true);
      }
      return { kind: "unavailable" as const, code: "unavailable" };
    }
  }, [invalidateVideoGenerationSession, ensureVideoHostSession]);

  const getVideoGenerationTakeStatus = useCallback(async (input: { takeId: string }) => {
    const session = await ensureVideoHostSession();
    if (!session) return { kind: "unavailable" as const, code: "unavailable" };
    try {
      const status = await apiClient.getVideoGenerationTakeStatus(input.takeId, {
        roomId: session.roomId,
        projectArtifactId: session.projectArtifactId,
        attestationToken: session.token,
      });
      if (videoGenerationSessionRef.current !== session) return { kind: "unavailable" as const, code: "unavailable" };
      // Copy only the closed server DTO: status must remain useful to Video
      // while never becoming a conduit for a receipt, provider id, or URL.
      return {
        kind: "ready" as const,
        status: {
          takeId: status.takeId,
          revision: status.revision,
          mediaKind: status.mediaKind,
          state: status.state,
          modelId: status.modelId,
          settings: { ...status.settings },
          ...(status.progress ? { progress: { ...status.progress } } : {}),
          ...(status.artifact ? { artifact: { ...status.artifact } } : {}),
          ...(status.failure ? { failure: { ...status.failure } } : {}),
          recoveryActions: status.recoveryActions.map((action) => ({ kind: action.kind, label: action.label, newSpend: action.newSpend })),
        },
      };
    } catch (err) {
      if (videoGenerationSessionRef.current === session && err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 409 || err.status === 410)) {
        invalidateVideoGenerationSession(true);
      }
      return { kind: "unavailable" as const, code: "unavailable" };
    }
  }, [invalidateVideoGenerationSession, ensureVideoHostSession]);

  const openNativeWorkspacePreview = useCallback(async (artifact: WorkspaceMediaArtifact, roomId: string, signal?: AbortSignal) => {
    const opener = desktopAPI?.mediaProxy?.openWorkspace;
    if (!opener || signal?.aborted) return null;
    const requestId = crypto.randomUUID();
    workspaceMediaRequestsRef.current.add(requestId);
    const cancel = () => { void desktopAPI?.mediaProxy?.cancel(requestId); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await opener({ requestId, roomId, artifact });
      if (!result.ok) return null;
      const data = result.data;
      if (signal?.aborted || !workspaceMediaRequestsRef.current.has(requestId) || data.mimeType !== artifact.mimeType || data.sizeBytes !== artifact.size ||
          data.url !== `nautilo-media://proxy/${data.revokeToken}` || !WORKSPACE_ARTIFACT_ID.test(data.revokeToken) ||
          (data.mediaKind !== "image" && (!Number.isFinite(data.durationSec) || data.durationSec! <= 0))) {
        void desktopAPI?.mediaProxy?.close(data.revokeToken);
        return null;
      }
      return data;
    } finally {
      workspaceMediaRequestsRef.current.delete(requestId);
      signal?.removeEventListener("abort", cancel);
    }
  }, []);

  const loadWorkspaceMediaPickerPreview = useCallback(async (artifact: WorkspaceMediaArtifact, signal: AbortSignal) => {
    const target = boundTargetRef.current;
    const picker = workspaceMediaPickerAbortRef.current;
    const epoch = workspaceMediaImportEpochRef.current;
    const viewerKey = promotionStateRef.current.viewerKey;
    if (appId !== "nautilo-video" || runtime?.hostCapabilities?.mediaProxy !== true || target?.kind !== "artifact" ||
        !target.roomId || !picker || !viewerKey || (!workspaceMediaPickerResolveRef.current && !videoMediaPickResolveRef.current) ||
        (!artifact.mimeType.startsWith("image/") && !artifact.mimeType.startsWith("video/") && !artifact.mimeType.startsWith("audio/"))) return null;
    const cancellation = AbortSignal.any([signal, picker.signal]);
    const isCurrent = () => !cancellation.aborted && workspaceMediaPickerAbortRef.current === picker &&
      workspaceMediaImportEpochRef.current === epoch && boundTargetRef.current === target &&
      boundAppIdRef.current === appId && promotionStateRef.current.viewerKey === viewerKey;
    if (!isCurrent()) return null;
    const preview = await openNativeWorkspacePreview(artifact, target.roomId, cancellation);
    if (!preview) return null;
    const transportCompatible: boolean = workspaceMediaMimeMatchesKind(preview.mediaKind, artifact.mimeType);
    if (!isCurrent() || (!transportCompatible && !(preview.mediaKind === "audio" && artifact.mimeType.startsWith("audio/")))) {
      void desktopAPI?.mediaProxy?.close(preview.revokeToken);
      return null;
    }
    workspaceMediaPreviewUrlsRef.current.set(preview.revokeToken, preview.url);
    return { url: preview.url, mediaKind: preview.mediaKind, ...(preview.waveform ? { waveform: preview.waveform } : {}), ...(preview.sha256 && /^[0-9a-f]{64}$/u.test(preview.sha256) ? { sha256: preview.sha256 } : {}), release: () => closeWorkspaceMediaPreview({ revokeToken: preview.revokeToken }) };
  }, [appId, runtime?.hostCapabilities?.mediaProxy, openNativeWorkspacePreview, closeWorkspaceMediaPreview]);

  const loadReadyVideoGenerationTake = useCallback(async (takeId: string) => {
    const session = await ensureVideoHostSession();
    if (!session || videoGenerationMediaLoadInFlightRef.current) return null;
    videoGenerationMediaLoadInFlightRef.current = true;
    try {
    const sessionIsCurrent = () => videoGenerationSessionRef.current === session &&
      boundTargetRef.current?.kind === "artifact" && liveReviewBoundTargetKey(boundTargetRef.current) === session.targetKey;
    const [listed, status] = await Promise.all([
      apiClient.listVideoGenerationTakes({ roomId: session.roomId, projectArtifactId: session.projectArtifactId, attestationToken: session.token }),
      apiClient.getVideoGenerationTakeStatus(takeId, { roomId: session.roomId, projectArtifactId: session.projectArtifactId, attestationToken: session.token }),
    ]);
    if (!sessionIsCurrent()) return null;
    const listedTake = listed.takes.find((candidate) => candidate.takeId === takeId);
    if (!listedTake || (status.state !== "ready" && status.state !== "cleanup-pending") || !status.artifact ||
        (status.mediaKind !== "video" && status.mediaKind !== "audio")) return null;
    const artifact = status.artifact;
    const inventory = await apiClient.listWorkspaceArtifacts({ roomId: session.roomId, pathPrefix: artifact.path });
    const workspaceArtifacts = inventory.artifacts.filter((candidate) => candidate.artifactId === artifact.artifactId && candidate.path === artifact.path);
    if (workspaceArtifacts.length !== 1) return null;
    const workspaceArtifact = workspaceArtifacts[0];
    if (workspaceArtifact.mimeType !== artifact.mime || workspaceArtifact.size !== artifact.bytes) return null;
    if ((status.mediaKind === "video" && !artifact.mime.startsWith("video/")) || (status.mediaKind === "audio" && !artifact.mime.startsWith("audio/"))) return null;
    const preview = await openNativeWorkspacePreview(workspaceArtifact, session.roomId);
    if (!preview) return null;
    if (!sessionIsCurrent() || preview.mediaKind !== status.mediaKind || preview.durationSec === undefined) {
      void desktopAPI?.mediaProxy?.close(preview.revokeToken);
      return null;
    }
    const durationSec = preview.durationSec;
    const take = {
      id: takeId,
      briefRevision: listedTake.documentRevision,
      shotId: listedTake.shotId,
      shotLabel: listedTake.shotLabel,
      mediaKind: status.mediaKind,
      modelId: status.modelId,
      settings: { ...status.settings },
      artifact: { ...artifact },
    } as const;
    return { take, durationSec, preview, label: listedTake.shotLabel };
    } finally {
      videoGenerationMediaLoadInFlightRef.current = false;
    }
  }, [openNativeWorkspacePreview, ensureVideoHostSession]);

  const previewVideoGenerationTake = useCallback(async (input: { takeId: string }) => {
    try {
      const ready = await loadReadyVideoGenerationTake(input.takeId);
      if (!ready) return { kind: "unavailable" as const, code: "unavailable" };
      if (videoGenerationPreviewUrlRef.current) void desktopAPI?.mediaProxy?.close(videoGenerationPreviewUrlRef.current);
      const src = ready.preview.url;
      videoGenerationPreviewUrlRef.current = ready.preview.revokeToken;
      setVideoGenerationPreview({ mediaKind: ready.take.mediaKind, src, label: ready.label });
      return { kind: "opened" as const };
    } catch {
      return { kind: "unavailable" as const, code: "unavailable" };
    }
  }, [loadReadyVideoGenerationTake]);

  const revalidateVideoGenerationTake = useCallback(async (input: { takeId: string }) => {
    try {
      const ready = await loadReadyVideoGenerationTake(input.takeId);
      if (ready) void desktopAPI?.mediaProxy?.close(ready.preview.revokeToken);
      return ready
        ? { status: "ready" as const, take: ready.take, durationSec: ready.durationSec }
        : { status: "unavailable" as const, takeId: input.takeId };
    } catch {
      return { status: "unavailable" as const, takeId: input.takeId };
    }
  }, [loadReadyVideoGenerationTake]);

  const runWorkspaceMediaImport = useCallback(async (mediaKind?: "image" | "video" | "audio") => {
    const target = boundTargetRef.current;
    const importer = desktopAPI?.mediaProxy?.importWorkspace;
    const unavailable = (code: string) => ({ kind: "unavailable" as const, code });
    if (appId !== "nautilo-video" || runtime?.hostCapabilities?.mediaProxy !== true || target?.kind !== "artifact" || !target.roomId || !importer) {
      return unavailable("unsupported_environment");
    }
    const roomId = target.roomId;
    const isCurrent = () => boundTargetRef.current === target;
    const requestId = crypto.randomUUID();
    workspaceMediaRequestsRef.current.add(requestId);
    let unattachedId: string | undefined;
    const discard = () => {
      if (unattachedId) void apiClient.deleteWorkspaceArtifact(unattachedId, { roomId }).catch(() => undefined);
      unattachedId = undefined;
    };
    try {
      const envelope = await readDocumentSession(documentSessionRef.current, target);
      if (!isCurrent() || !workspaceMediaRequestsRef.current.has(requestId) || !parseVideoHtml(envelope.content).ok) return unavailable("stale_project");
      const result = await importer({ requestId, roomId, ...(mediaKind ? { mediaKind } : {}) });
      if (!result.ok) return unavailable(result.error.code);
      const data = result.data;
      const artifact = data.artifact;
      unattachedId = artifact.id;
      if (!isCurrent() || !workspaceMediaRequestsRef.current.has(requestId)) {
        discard(); return unavailable("stale_project");
      }
      const durationValid = Number.isFinite(data.durationSec) && data.durationSec! > 0;
      const frameRateValid = data.frameRate !== undefined && Number.isSafeInteger(data.frameRate.numerator) && data.frameRate.numerator > 0 &&
        Number.isSafeInteger(data.frameRate.denominator) && data.frameRate.denominator > 0;
      if (!isSafeWorkspaceVideoImportLabel(data.label) || !WORKSPACE_ARTIFACT_ID.test(artifact.artifactId) ||
          !LOGICAL_WORKSPACE_PATH.test(artifact.path) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
          !isSafeWorkspaceReferenceMimeType(data.mediaKind, artifact.mimeType) || (mediaKind && data.mediaKind !== mediaKind) ||
          (data.mediaKind === "video" && (!durationValid || !frameRateValid)) ||
          (data.mediaKind === "audio" && (!durationValid || data.frameRate !== undefined)) ||
          (data.mediaKind === "image" && (data.durationSec !== undefined || data.frameRate !== undefined))) {
        discard(); return unavailable("invalid_response");
      }
      unattachedId = undefined;
      return { kind: "ready" as const, data };
    } catch {
      discard(); return unavailable("upload_unavailable");
    } finally { workspaceMediaRequestsRef.current.delete(requestId); }
  }, [appId, runtime?.hostCapabilities?.mediaProxy]);

  const importWorkspaceVideo = useCallback(async () => {
    const target = boundTargetRef.current;
    if (target?.kind !== "artifact" || !target.roomId) return { kind: "unavailable" as const, code: "unsupported_environment" };
    const operationEpoch = ++workspaceMediaImportEpochRef.current;
    workspaceMediaImportCancelRef.current?.();
    const viewerKey = auth.viewer.isVerified ? auth.viewer.sessionUserId : null;
    const operationCurrent = () => workspaceMediaImportEpochRef.current === operationEpoch && boundAppIdRef.current === appId && boundTargetRef.current === target && viewerKey !== null && viewerKey === promotionStateRef.current.viewerKey;
    const labels: Record<string, string> = {};
    const cachedContent = documentSessionRef.current.envelope?.content;
    const parsedProject = cachedContent ? parseVideoHtml(cachedContent) : null;
    if (parsedProject?.ok) {
      const projectMediaById = new Map(parsedProject.document.project.media.map((media) => [media.id, media]));
      for (const media of parsedProject.document.project.media) {
        if (media.source?.kind === "workspace-artifact" && media.label?.trim()) labels[`${media.source.artifactId}\0${media.source.path}`] = media.label.trim();
      }
      const brief = parsedProject.document.project.generationBrief;
      if (brief) {
        const references = [...effectiveGenerationDirectionBlocks(brief).flatMap((block) => block.kind === "references" ? block.references ?? [] : []), ...brief.shots.flatMap((shot) => shot.references)];
        for (const reference of references) {
          const source = reference.source?.kind === "project-media" ? projectMediaById.get(reference.source.mediaId)?.source : reference.source;
          if (source?.kind === "workspace-artifact" && reference.name.trim()) labels[`${source.artifactId}\0${source.path}`] = reference.name.trim();
        }
      }
    }
    const selection = await new Promise<WorkspaceMediaArtifact | "upload" | null>((resolve) => {
      workspaceMediaPickerResolveRef.current?.(null);
      workspaceMediaPickerResolveRef.current = resolve;
      const controller = new AbortController();
      workspaceMediaPickerAbortRef.current?.abort();
      workspaceMediaPickerAbortRef.current = controller;
      setWorkspaceMediaPicker({ artifacts: [], labels, loading: true, error: null });
      void apiClient.listAllWorkspaceArtifacts({ roomId: target.roomId, signal: controller.signal }).then(({ artifacts }) => {
        if (!operationCurrent() || workspaceMediaPickerResolveRef.current !== resolve) return;
        setWorkspaceMediaPicker({ artifacts: artifacts.filter((artifact) => {
          const kind = artifact.mimeType.split("/", 1)[0];
          return (kind === "video" || kind === "audio" || kind === "image") && isSafeWorkspaceReferenceMimeType(kind, artifact.mimeType);
        }), labels, loading: false, error: null });
      }).catch(() => {
        if (workspaceMediaPickerResolveRef.current === resolve) setWorkspaceMediaPicker({ artifacts: [], labels, loading: false, error: "Workspace media could not be loaded." });
      });
    });
    if (selection === null || !operationCurrent()) return { kind: "unavailable" as const, code: "cancelled" };
    if (selection !== "upload") {
      const postSelectionAbort = new AbortController();
      const cancelled = Symbol("workspace-media-import-cancelled");
      let cancelWait!: () => void;
      const cancelledWait = new Promise<typeof cancelled>((resolve) => { cancelWait = () => resolve(cancelled); });
      const cancelOperation = () => { postSelectionAbort.abort(); cancelWait(); };
      workspaceMediaImportCancelRef.current = cancelOperation;
      const exactResult = await Promise.race([apiClient.getWorkspaceArtifact(selection.id, { roomId: target.roomId }), cancelledWait]);
      if (exactResult === cancelled) return { kind: "unavailable" as const, code: "stale_project" };
      const exact = exactResult;
      const exactKind = exact?.mimeType.split("/", 1)[0];
      if (!operationCurrent() || !exact || exact.id !== selection.id || exact.revision !== selection.revision || exact.artifactId !== selection.artifactId || exact.path !== selection.path || exact.mimeType !== selection.mimeType || exact.size !== selection.size ||
          (exactKind !== "video" && exactKind !== "audio" && exactKind !== "image") || !isSafeWorkspaceReferenceMimeType(exactKind, exact.mimeType)) return { kind: "unavailable" as const, code: "stale_project" };
      const preview = await openNativeWorkspacePreview(exact, target.roomId, postSelectionAbort.signal);
      if (workspaceMediaImportCancelRef.current === cancelOperation) workspaceMediaImportCancelRef.current = null;
      if (!preview || !operationCurrent()) {
        if (preview) void desktopAPI?.mediaProxy?.close(preview.revokeToken);
        return { kind: "unavailable" as const, code: "invalid_response" };
      }
      try {
        if (!operationCurrent() || !workspaceMediaMimeMatchesKind(preview.mediaKind, exact.mimeType)) return { kind: "unavailable" as const, code: "stale_project" };
        const ready = { kind: "ready" as const, mediaRef: exact.path, label: workspaceMediaPickerName(exact, labels), source: { kind: "workspace-artifact" as const, artifactId: exact.artifactId, path: exact.path } };
        if (preview.mediaKind === "video") {
          if (!preview.durationSec || !preview.frameRate || !Number.isSafeInteger(preview.frameRate.numerator) || preview.frameRate.numerator <= 0 || !Number.isSafeInteger(preview.frameRate.denominator) || preview.frameRate.denominator <= 0) return { kind: "unavailable" as const, code: "invalid_response" };
          return { ...ready, durationSec: preview.durationSec, frameRate: { ...preview.frameRate } };
        }
        if (preview.mediaKind === "audio") {
          if (preview.durationSec === undefined) return { kind: "unavailable" as const, code: "invalid_response" };
          return { ...ready, mediaKind: "audio" as const, durationSec: preview.durationSec };
        }
        return { ...ready, mediaKind: "image" as const };
      } finally { void desktopAPI?.mediaProxy?.close(preview.revokeToken); }
    }
    const result = await runWorkspaceMediaImport();
    if (result.kind !== "ready") return result;
    const data = result.data;
    const ready = { kind: "ready" as const, mediaRef: data.artifact.path, label: data.label,
      source: { kind: "workspace-artifact" as const, artifactId: data.artifact.artifactId, path: data.artifact.path } };
    if (data.mediaKind === "video") return { ...ready, durationSec: data.durationSec!, frameRate: { ...data.frameRate! } };
    if (data.mediaKind === "audio") return { ...ready, mediaKind: "audio" as const, durationSec: data.durationSec! };
    return { ...ready, mediaKind: "image" as const };
  }, [appId, auth.viewer.isVerified, auth.viewer.sessionUserId, openNativeWorkspacePreview, runWorkspaceMediaImport]);

  const importVideoGenerationReference = useCallback(async (
    input: { mediaKind: "image" | "video" | "audio" },
  ): Promise<VideoGenerationReferenceImportBridgeResult> => {
    const result = await runWorkspaceMediaImport(input.mediaKind);
    if (result.kind !== "ready") return result;
    const data = result.data;
    return { kind: "ready", asset: { artifactId: data.artifact.artifactId, path: data.artifact.path,
      label: data.label, mediaKind: data.mediaKind, mimeType: data.artifact.mimeType, sizeBytes: data.artifact.size } };
  }, [runWorkspaceMediaImport]);

  const importVideoGenerationReferences = useCallback(async (): Promise<VideoGenerationReferencesImportBridgeResult> => {
    const target = boundTargetRef.current;
    const importer = desktopAPI?.mediaProxy?.importWorkspaceBatch;
    const unavailable = (code: string) => ({ kind: "unavailable" as const, code });
    if (appId !== "nautilo-video" || runtime?.hostCapabilities?.mediaProxy !== true || target?.kind !== "artifact" || !target.roomId || !importer) return unavailable("unsupported_environment");
    const roomId = target.roomId;
    const requestId = crypto.randomUUID();
    const current = () => boundTargetRef.current === target && workspaceMediaRequestsRef.current.has(requestId);
    const unattachedIds = new Set<string>();
    const discard = () => { for (const id of unattachedIds) void apiClient.deleteWorkspaceArtifact(id, { roomId }).catch(() => undefined); unattachedIds.clear(); };
    workspaceMediaRequestsRef.current.add(requestId);
    try {
      const envelope = await readDocumentSession(documentSessionRef.current, target);
      if (!current() || !parseVideoHtml(envelope.content).ok) return unavailable("stale_project");
      const result = await importer({ requestId, roomId, mediaKind: "image" });
      if (!result.ok) return unavailable(result.error.code);
      for (const item of result.data.results) if (item.ok) unattachedIds.add(item.data.artifact.id);
      if (!current() || result.data.results.some((item) => !item.ok && item.error.code === "cancelled")) { discard(); return unavailable("stale_project"); }
      const assets: Extract<VideoGenerationReferenceImportBridgeResult, { kind: "ready" }>["asset"][] = [];
      const failures: { label: string; code: string }[] = [];
      for (const item of result.data.results) {
        if (!item.ok) {
          failures.push({ label: isSafeWorkspaceVideoImportLabel(item.label) ? item.label : "Selected image", code: /^[a-z_]+$/u.test(item.error.code) ? item.error.code : "upload_unavailable" });
          continue;
        }
        const data = item.data, artifact = data.artifact;
        if (data.mediaKind !== "image" || !isSafeWorkspaceVideoImportLabel(data.label) || !WORKSPACE_ARTIFACT_ID.test(artifact.artifactId) ||
            !LOGICAL_WORKSPACE_PATH.test(artifact.path) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
            !isSafeWorkspaceReferenceMimeType("image", artifact.mimeType) || data.durationSec !== undefined || data.frameRate !== undefined) {
          discard(); return unavailable("invalid_response");
        }
        assets.push({ artifactId: artifact.artifactId, path: artifact.path, label: data.label, mediaKind: "image", mimeType: artifact.mimeType, sizeBytes: artifact.size });
      }
      // After handoff, the existing document autosave owns attachment. Retain these
      // Workspace artifacts: a concurrent save may already reference them.
      unattachedIds.clear();
      return { kind: "ready", assets, failures };
    } catch { discard(); return unavailable("upload_unavailable"); }
    finally { workspaceMediaRequestsRef.current.delete(requestId); }
  }, [appId, runtime?.hostCapabilities?.mediaProxy]);

  const pickVideoMedia = useCallback(async (input: VideoMediaPickInput): Promise<VideoMediaPickResult> => {
    const target = boundTargetRef.current;
    const viewerKey = promotionStateRef.current.viewerKey;
    const unavailable = (code: string) => ({ kind: "unavailable" as const, code });
    if (appId !== "nautilo-video" || runtime?.hostCapabilities?.mediaProxy !== true || target?.kind !== "artifact" || !target.roomId || !viewerKey) return unavailable("unsupported_environment");
    closeWorkspaceMediaPicker(null);
    const epoch = ++workspaceMediaImportEpochRef.current;
    workspaceMediaImportCancelRef.current?.();
    const current = () => workspaceMediaImportEpochRef.current === epoch && boundTargetRef.current === target && boundAppIdRef.current === appId && promotionStateRef.current.viewerKey === viewerKey;
    const envelope = await readDocumentSession(documentSessionRef.current, target);
    const parsed = parseVideoHtml(envelope.content);
    if (!current() || !parsed.ok) return unavailable("stale_project");
    const projectMedia = parsed.document.project.media.map(media => ({ id: media.id, label: media.label ?? media.id, kind: media.kind, path: media.source?.kind === "workspace-artifact" ? media.source.path : media.ref, ...(media.source?.kind === "workspace-artifact" ? { artifactId: media.source.artifactId } : {}) }));
    const labels: Record<string, string> = {};
    for (const media of projectMedia) if (media.artifactId) labels[`${media.artifactId}\0${media.path}`] = media.label;
    const brief = parsed.document.project.generationBrief;
    if (brief) for (const reference of [...effectiveGenerationDirectionBlocks(brief).flatMap(block => block.kind === "references" ? block.references ?? [] : []), ...brief.shots.flatMap(shot => shot.references)]) {
      const source = reference.source?.kind === "project-media" ? parsed.document.project.media.find(media => reference.source?.kind === "project-media" && media.id === reference.source.mediaId)?.source : reference.source;
      if (source?.kind === "workspace-artifact" && reference.name.trim()) labels[`${source.artifactId}\0${source.path}`] = reference.name.trim();
    }
    const selection = await new Promise<VideoPickerSelection | "upload" | null>(resolve => {
      videoMediaPickResolveRef.current = resolve;
      const controller = new AbortController();
      workspaceMediaPickerAbortRef.current = controller;
      const onConfirm = (picked: VideoPickerSelection) => {
        // Detach this resolver before closing; close cancels any remaining picker.
        videoMediaPickResolveRef.current = null;
        closeWorkspaceMediaPicker(null, true);
        resolve(picked);
      };
      const base = { labels, purpose: input.purpose, multiple: input.multiple, projectMedia, onConfirm };
      setWorkspaceMediaPicker({ ...base, artifacts: [], loading: true, error: null });
      void apiClient.listAllWorkspaceArtifacts({ roomId: target.roomId, signal: controller.signal }).then(({ artifacts }) => {
        if (!current() || videoMediaPickResolveRef.current !== resolve) return;
        setWorkspaceMediaPicker({ ...base, artifacts: artifacts.filter(a => {
          const kind = a.mimeType.split("/")[0];
          return (kind === "image" || kind === "video" || kind === "audio") &&
            (isSafeWorkspaceReferenceMimeType(kind, a.mimeType) || (input.purpose === "references" && kind === "audio"));
        }), loading: false, error: null });
      }).catch(() => { if (current() && videoMediaPickResolveRef.current === resolve) setWorkspaceMediaPicker({ ...base, artifacts: [], loading: false, error: "Media could not be loaded. Close this picker and try again." }); });
    });
    if (!selection || !current()) return unavailable("cancelled");
    const result: Extract<VideoMediaPickResult, { kind: "ready" }> = { kind: "ready", imports: [], references: [], mediaIds: [], failures: [] };
    const accept = (data: { artifact: Omit<WorkspaceMediaArtifact, "revision">; label: string; mediaKind: "image" | "video" | "audio"; durationSec?: number; frameRate?: { numerator: number; denominator: number } }) => {
      const a = data.artifact;
      const safeMime = isSafeWorkspaceReferenceMimeType(data.mediaKind, a.mimeType) ||
        (input.purpose === "references" && data.mediaKind === "audio" && isSeedanceAudioReferenceMimeType(a.mimeType));
      if (!isSafeWorkspaceVideoImportLabel(data.label) || !WORKSPACE_ARTIFACT_ID.test(a.artifactId) || !LOGICAL_WORKSPACE_PATH.test(a.path) || !Number.isSafeInteger(a.size) || a.size <= 0 || !safeMime) return false;
      if (input.purpose === "references") { result.references.push({ artifactId: a.artifactId, path: a.path, label: data.label, mediaKind: data.mediaKind, mimeType: a.mimeType, sizeBytes: a.size }); return true; }
      const common = { kind: "ready" as const, mediaRef: a.path, label: data.label, source: { kind: "workspace-artifact" as const, artifactId: a.artifactId, path: a.path } };
      if (data.mediaKind === "image") result.imports.push({ ...common, mediaKind: "image" });
      else if (!data.durationSec || !Number.isFinite(data.durationSec)) return false;
      else if (data.mediaKind === "audio") result.imports.push({ ...common, mediaKind: "audio", durationSec: data.durationSec });
      else if (!data.frameRate || !Number.isSafeInteger(data.frameRate.numerator) || data.frameRate.numerator <= 0 || !Number.isSafeInteger(data.frameRate.denominator) || data.frameRate.denominator <= 0) return false;
      else result.imports.push({ ...common, durationSec: data.durationSec, frameRate: { ...data.frameRate } });
      return true;
    };
    const unattachedIds = new Set<string>();
    try {
    if (selection === "upload" || selection.fromComputer) {
      const importer = input.multiple ? desktopAPI?.mediaProxy?.importWorkspaceBatch : desktopAPI?.mediaProxy?.importWorkspace;
      if (!importer) return unavailable("unsupported_environment");
      const requestId = crypto.randomUUID();
      workspaceMediaRequestsRef.current.add(requestId);
      try {
        const response = await importer({ requestId, roomId: target.roomId });
        if (!current()) {
          if (response.ok) {
            const receipts = "results" in response.data ? response.data.results : [{ ok: true as const, data: response.data }];
            for (const entry of receipts) if (entry.ok) void apiClient.deleteWorkspaceArtifact(entry.data.artifact.id, { roomId: target.roomId }).catch(() => undefined);
          }
          return unavailable("stale_project");
        }
        if (!response.ok) return unavailable(response.error.code);
        const entries = "results" in response.data ? response.data.results : [{ ok: true as const, data: response.data }];
        for (const entry of entries) {
          if (!entry.ok) { result.failures.push({ label: isSafeWorkspaceVideoImportLabel(entry.label) ? entry.label : "Selected file", code: /^[a-z_]+$/u.test(entry.error.code) ? entry.error.code : "upload_unavailable" }); continue; }
          unattachedIds.add(entry.data.artifact.id);
          if (!accept(entry.data)) {
            result.failures.push({ label: isSafeWorkspaceVideoImportLabel(entry.data.label) ? entry.data.label : "Selected file", code: "unsupported_type" });
            unattachedIds.delete(entry.data.artifact.id);
            void apiClient.deleteWorkspaceArtifact(entry.data.artifact.id, { roomId: target.roomId }).catch(() => undefined);
          }
        }
      } finally { workspaceMediaRequestsRef.current.delete(requestId); }
    }
    if (selection !== "upload") {
      if (!input.multiple && selection.artifacts.length + selection.mediaIds.length > 1) return unavailable("invalid_response");
      for (const selected of selection.artifacts) {
        if (!current()) return unavailable("stale_project");
        const exact = await apiClient.getWorkspaceArtifact(selected.id, { roomId: target.roomId }).catch(() => null);
        if (!current()) return unavailable("stale_project");
        if (!exact || exact.id !== selected.id || exact.artifactId !== selected.artifactId || exact.path !== selected.path || exact.revision !== selected.revision || exact.mimeType !== selected.mimeType || exact.size !== selected.size) { result.failures.push({ label: workspaceMediaPickerName(selected, labels), code: "changed_during_read" }); continue; }
        const kind = exact.mimeType.split("/")[0];
        if (kind !== "image" && kind !== "video" && kind !== "audio") continue;
        if (input.purpose === "references" && kind === "image") { if (!accept({ artifact: exact, label: workspaceMediaPickerName(exact, labels), mediaKind: kind })) result.failures.push({ label: workspaceMediaPickerName(exact, labels), code: "unsupported_type" }); continue; }
        if (input.purpose === "references" && kind === "audio") {
          if (!isSeedanceAudioReferenceMimeType(exact.mimeType)) result.failures.push({ label: workspaceMediaPickerName(exact, labels), code: "unsupported_type" });
          else if (!accept({ artifact: exact, label: workspaceMediaPickerName(exact, labels), mediaKind: "audio" })) result.failures.push({ label: workspaceMediaPickerName(exact, labels), code: "unsupported_type" });
          continue;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        workspaceMediaImportCancelRef.current = cancel;
        const preview = await openNativeWorkspacePreview(exact, target.roomId, controller.signal).catch(() => null);
        if (workspaceMediaImportCancelRef.current === cancel) workspaceMediaImportCancelRef.current = null;
        if (!preview) { result.failures.push({ label: workspaceMediaPickerName(exact, labels), code: "processing_unavailable" }); continue; }
        try { if (!current()) return unavailable("stale_project"); if (!accept({ artifact: exact, label: workspaceMediaPickerName(exact, labels), mediaKind: preview.mediaKind, ...(preview.durationSec === undefined ? {} : { durationSec: preview.durationSec }), ...(preview.frameRate ? { frameRate: preview.frameRate } : {}) })) result.failures.push({ label: workspaceMediaPickerName(exact, labels), code: "invalid_response" }); }
        finally { void desktopAPI?.mediaProxy?.close(preview.revokeToken); }
      }
      if (selection.mediaIds.length) {
        // Ordinary saves may advance revision while a chooser is open. Validate
        // exact project-media identities against the latest canonical document.
        resetDocumentReadSession(documentSessionRef.current);
        const latest = parseVideoHtml((await readDocumentSession(documentSessionRef.current, target)).content);
        if (!current() || !latest.ok) return unavailable("stale_project");
        for (const id of selection.mediaIds) {
          const old = parsed.document.project.media.find(m => m.id === id), now = latest.document.project.media.find(m => m.id === id);
          if (input.purpose === "references" && old && now && JSON.stringify(old.source) === JSON.stringify(now.source) && old.ref === now.ref && old.kind === now.kind) result.mediaIds.push(id);
          else result.failures.push({ label: old?.label ?? "Media Bin item", code: "stale_project" });
        }
      }
    }
    if (!current()) return unavailable("stale_project");
    unattachedIds.clear();
    return result;
    } finally {
      for (const id of unattachedIds) void apiClient.deleteWorkspaceArtifact(id, { roomId: target.roomId }).catch(() => undefined);
    }
  }, [appId, runtime?.hostCapabilities?.mediaProxy, closeWorkspaceMediaPicker, openNativeWorkspacePreview]);

  const exportVideoWorkspaceMedia = useCallback(async (input: VideoWorkspaceMediaExportInput): Promise<VideoWorkspaceMediaExportResult> => {
    const target = boundTargetRef.current;
    const exporter = desktopAPI?.mediaExport;
    if (appId !== "nautilo-video" || runtime?.hostCapabilities?.mediaProxy !== true || target?.kind !== "artifact" || !target.roomId || !exporter?.startWorkspace) {
      return { kind: "unavailable", code: "unsupported_environment" };
    }
    const isCurrent = () => !input.signal.aborted && boundTargetRef.current === target;
    if (input.exportSettings && exporter.supportsExportSettings !== true) return { kind: "unavailable", code: "export_settings_unsupported" };
    if (!isCurrent()) return { kind: "cancelled" };
    let unsubscribe: (() => void) | undefined;
    const cancelNative = () => { void exporter.cancel(input.requestId); };
    try {
      input.onProgress({ stage: "preparing" });
      resetDocumentReadSession(documentSessionRef.current);
      const envelope = await readDocumentSession(documentSessionRef.current, target);
      if (!isCurrent()) return { kind: "cancelled" };
      if (envelope.baseSha256 !== input.sha256 || envelope.baseRevision !== input.revision) return { kind: "unavailable", code: "document_changed" };
      const parsed = parseVideoHtml(envelope.content);
      if (!parsed.ok) return { kind: "unavailable", code: "invalid_document" };
      const lowered = buildSequenceRenderPlan(parsed.document.project, undefined, input.exportSettings ? { exportSettings: input.exportSettings } : {});
      if (!lowered.ok) return { kind: "unavailable", code: lowered.error.code };
      if (lowered.plan.durationSec <= 0) return { kind: "unavailable", code: "empty_sequence" };
      const sources: Parameters<NonNullable<typeof exporter.startWorkspace>>[0]["sources"] = [];
      const mediaIds = new Set(lowered.plan.layers.flatMap((layer) => layer.mediaId ? [layer.mediaId] : []));
      for (const mediaId of mediaIds) {
        const source = durableWorkspaceVideoMediaFromDocument(envelope.content, mediaId);
        if (!source) return { kind: "unavailable", code: "workspace_media_unsupported" };
        const inventory = await apiClient.listWorkspaceArtifacts({ roomId: target.roomId, pathPrefix: source.path });
        if (!isCurrent()) return { kind: "cancelled" };
        const exact = inventory.artifacts.filter((artifact) => artifact.artifactId === source.artifactId && artifact.path === source.path &&
          isSafeWorkspaceReferenceMimeType(source.mediaKind, artifact.mimeType) && Number.isSafeInteger(artifact.size) && artifact.size > 0);
        const artifact = exact.length === 1 ? exact[0] : undefined;
        if (!artifact) return { kind: "unavailable", code: "source_unavailable" };
        sources.push({ mediaId, artifactRowId: artifact.id, artifactId: source.artifactId, path: source.path, mimeType: artifact.mimeType, sizeBytes: artifact.size });
      }
      if (!isCurrent()) return { kind: "cancelled" };
      unsubscribe = exporter.onProgress((event) => {
        if (event.requestId === input.requestId && isCurrent()) input.onProgress(event.progress);
      });
      // Register before the IPC call, so an unmount cannot strand native work.
      input.signal.addEventListener("abort", cancelNative, { once: true });
      const result = await exporter.startWorkspace({ requestId: input.requestId, documentContent: envelope.content, expectedSha256: input.sha256, roomId: target.roomId, sources, publishToWorkspace: input.publishToWorkspace, ...(input.exportSettings ? { exportSettings: input.exportSettings } : {}) });
      if (!result.ok) return { kind: "unavailable", code: result.error.code };
      // Native publication is the commit point; a late cancellation must not
      // claim that a successfully saved MP4 was rolled back.
      return result.data.status === "cancelled" ? { kind: "cancelled" } : { kind: "succeeded", label: result.data.label, sizeBytes: result.data.sizeBytes, warnings: result.data.warnings, ...(result.data.workspace === undefined ? {} : { workspace: result.data.workspace }) };
    } catch {
      return input.signal.aborted ? { kind: "cancelled" } : { kind: "unavailable", code: "export_unavailable" };
    } finally {
      input.signal.removeEventListener("abort", cancelNative);
      unsubscribe?.();
    }
  }, [appId, runtime?.hostCapabilities?.mediaProxy]);

  const promoteCurrentFolderVideoProject = useCallback(async (input: { requestId: string; sha256: string; signal: AbortSignal; onProgress: (progress: unknown) => void }) => {
    const target = boundTargetRef.current;
    const promoter = desktopAPI?.mediaExport?.promoteVideoProject;
    if (input.signal.aborted || appId !== "nautilo-video" || target?.kind !== "fs" || !workspaceCopyRoomId || !workspaceCopyRoomLabel || !promoter) return { kind: "unavailable", code: "unsupported_environment" };
    const admitted = target; const sourceKey = liveReviewBoundTargetKey(admitted);
    const viewerKey = promotionStateRef.current.viewerKey; const epoch = promotionEpochRef.current;
    const stillBound = () => boundTargetRef.current === admitted && promotionStateRef.current.sourceKey === sourceKey &&
      promotionStateRef.current.roomId === workspaceCopyRoomId && promotionStateRef.current.viewerKey === viewerKey && promotionEpochRef.current === epoch;
    let unsubscribe: (() => void) | undefined;
    const cancel = () => { void desktopAPI?.mediaExport?.cancel(input.requestId); };
    try {
      unsubscribe = desktopAPI?.mediaExport?.onProgress((event) => { if (event.requestId === input.requestId && stillBound()) input.onProgress(event.progress); });
      input.signal.addEventListener("abort", cancel, { once: true });
      const response = await promoter({ requestId: input.requestId, documentPath: admitted.path, expectedSha256: input.sha256, roomId: workspaceCopyRoomId });
      if (!stillBound()) return { kind: "unknown", code: "authority_changed", retainedPaths: [] };
      if (!response || typeof response !== "object") return { kind: "unavailable", code: "invalid_response" };
      const envelope = response as Record<string, unknown>;
      if (envelope["ok"] !== true || !envelope["data"] || typeof envelope["data"] !== "object") {
        const error = envelope["error"] as Record<string, unknown> | undefined;
        return { kind: "unavailable", code: typeof error?.["code"] === "string" ? error["code"] : "unavailable" };
      }
      const result = envelope["data"] as Record<string, unknown>;
      if (result["status"] === "succeeded") {
        const document = result["document"] as Record<string, unknown> | undefined;
        if (!document || typeof document["id"] !== "string" || typeof document["artifactId"] !== "string" || typeof document["path"] !== "string" || document["mimeType"] !== "text/html" || !Number.isSafeInteger(result["mediaCount"])) return { kind: "unavailable", code: "invalid_response" };
        promotedVideoProjectRef.current = { sourceSha256: input.sha256, sourceKey, viewerKey, epoch, artifactId: document["artifactId"], target: makeArtifactTarget({ id: document["id"], path: document["path"], mimeType: "text/html", roomId: workspaceCopyRoomId }) };
        return { kind: "succeeded", path: document["path"], roomLabel: workspaceCopyRoomLabel, mediaCount: result["mediaCount"] };
      }
      const retainedPaths = Array.isArray(result["retainedPaths"]) && result["retainedPaths"].every((item) => typeof item === "string") ? result["retainedPaths"] : [];
      if (result["status"] === "cancelled") return { kind: "cancelled", retainedPaths };
      return { kind: result["status"] === "unknown" ? "unknown" : "unavailable", code: typeof result["code"] === "string" ? result["code"] : "unavailable", retainedPaths };
    } finally { input.signal.removeEventListener("abort", cancel); unsubscribe?.(); }
  }, [appId, workspaceCopyRoomId, workspaceCopyRoomLabel]);

  const openPromotedVideoProject = useCallback(async () => {
    const promotion = promotedVideoProjectRef.current; const current = boundTargetRef.current;
    if (!promotion || current?.kind !== "fs" || !onMaterialized) return { opened: false, code: "unavailable" };
    return openVerifiedVideoProjectCopy({
      expectedSha256: promotion.sourceSha256,
      isCurrent: () => promotedVideoProjectRef.current === promotion && boundTargetRef.current === current &&
        promotionStateRef.current.sourceKey === promotion.sourceKey && promotionStateRef.current.roomId === promotion.target.roomId &&
        promotionStateRef.current.viewerKey === promotion.viewerKey && promotionStateRef.current.humanState === "clean" &&
        promotionEpochRef.current === promotion.epoch && documentSessionRef.current.envelope?.baseSha256 === promotion.sourceSha256,
      readCurrentSha256: async () => (await readDocumentSession(documentSessionRef.current, current)).baseSha256,
      verifyCopy: async () => {
        const verified = await apiClient.getWorkspaceArtifact(promotion.target.id, { roomId: promotion.target.roomId });
        return verified !== null && verified.artifactId === promotion.artifactId && verified.path === promotion.target.path && verified.mimeType === "text/html";
      },
      open: () => { promotedVideoProjectRef.current = null; onMaterialized(promotion.target); },
    });
  }, [onMaterialized]);

  useEffect(() => { promotedVideoProjectRef.current = null; }, [boundTargetKey, workspaceCopyRoomId, auth.viewer.isVerified, auth.viewer.sessionUserId]);

  const openVideoWorkspaceMediaPreview = useCallback(async (input: ({ mediaId: string } | { referenceId: string }) & { signal: AbortSignal }) => {
    const target = boundTargetRef.current;
    if (appId !== "nautilo-video" || runtime?.hostCapabilities?.mediaProxy !== true || !target || target.kind !== "artifact" || !target.roomId || input.signal.aborted || ("mediaId" in input ? !VIDEO_MEDIA_ID.test(input.mediaId) : !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(input.referenceId))) {
      return { kind: "unavailable" as const, code: "unavailable" };
    }
    const boundProject = { id: target.id, path: target.path, roomId: target.roomId };
    const sessionIsCurrent = () => {
      const current = boundTargetRef.current;
      return current?.kind === "artifact" && current.id === boundProject.id && current.path === boundProject.path && current.roomId === boundProject.roomId;
    };
    try {
      // Do not trust the iframe's in-memory EDL. Re-read the exact bound
      // project before resolving its project-local selector.
      resetDocumentReadSession(documentSessionRef.current);
      const envelope = await readDocumentSession(documentSessionRef.current, target);
      if (!sessionIsCurrent() || input.signal.aborted) return { kind: "unavailable" as const, code: "unavailable" };
      const source = "mediaId" in input ? durableWorkspaceVideoMediaFromDocument(envelope.content, input.mediaId) : workspaceVideoReferenceFromDocument(envelope.content, input.referenceId);
      if (!source) return { kind: "unavailable" as const, code: "unavailable" };
      const inventory = await apiClient.listWorkspaceArtifacts({ roomId: boundProject.roomId, pathPrefix: source.path });
      if (!sessionIsCurrent() || input.signal.aborted) return { kind: "unavailable" as const, code: "unavailable" };
      const exact = inventory.artifacts.filter((artifact) =>
        artifact.artifactId === source.artifactId && artifact.path === source.path &&
        isSafeWorkspaceReferenceMimeType(source.mediaKind, artifact.mimeType) && Number.isSafeInteger(artifact.size) && artifact.size > 0,
      );
      if (exact.length !== 1) return { kind: "unavailable" as const, code: "unavailable" };
      const artifact = exact[0];
      if (!artifact) return { kind: "unavailable" as const, code: "unavailable" };
      const preview = await openNativeWorkspacePreview(artifact, boundProject.roomId, input.signal);
      if (!preview) return { kind: "unavailable" as const, code: "unavailable" };
      if (!sessionIsCurrent() || input.signal.aborted || preview.mediaKind !== source.mediaKind) {
        void desktopAPI?.mediaProxy?.close(preview.revokeToken);
        return { kind: "unavailable" as const, code: "unavailable" };
      }
      workspaceMediaPreviewUrlsRef.current.set(preview.revokeToken, preview.url);
      return { kind: "ready" as const, url: preview.url, mimeType: preview.mimeType, sizeBytes: preview.sizeBytes, revokeToken: preview.revokeToken,
        ...(preview.waveform ? { waveform: preview.waveform } : {}) };
    } catch {
      return { kind: "unavailable" as const, code: "unavailable" };
    }
  }, [appId, runtime?.hostCapabilities?.mediaProxy, openNativeWorkspacePreview]);

  useEffect(() => () => {
    clearVideoGenerationPreview();
    clearWorkspaceMediaPreviews();
  }, [clearVideoGenerationPreview, clearWorkspaceMediaPreviews, appId, boundTarget, auth.viewer.isVerified, auth.viewer.sessionUserId]);

  const cancelVideoGenerationReview = useCallback(() => {
    const pendingReview = privateVideoGenerationReviewRef.current;
    privateVideoGenerationReviewRef.current = null;
    if (pendingReview) pendingReview.resolve(pendingReview.submissionAttempted ? { kind: "submission-unknown", takeId: pendingReview.takeId } : { kind: "cancelled" });
    setVideoGenerationReview(null);
    setVideoGenerationReviewError(null);
  }, []);

  const submitVideoGenerationReview = useCallback(() => {
    const session = videoGenerationSessionRef.current;
    const review = privateVideoGenerationReviewRef.current;
    if (!session || !review) {
      setVideoGenerationReviewError("This review is no longer current. Request a fresh review.");
      return;
    }
    if (review.submitting) return;
    review.submitting = true;
    review.submissionAttempted = true;
    setVideoGenerationSubmitting(true);
    setVideoGenerationReviewError(null);
    void apiClient.submitVideoGenerationTake(review.takeId, {
      roomId: session.roomId,
      projectArtifactId: session.projectArtifactId,
      reviewHandle: review.reviewHandle,
      attestationToken: session.token,
    }).then(() => {
      if (videoGenerationSessionRef.current !== session || privateVideoGenerationReviewRef.current !== review) return;
      review.resolve({ kind: "queued", takeId: review.takeId });
      privateVideoGenerationReviewRef.current = null;
      setVideoGenerationReview(null);
    }).catch((err: unknown) => {
      if (videoGenerationSessionRef.current !== session || privateVideoGenerationReviewRef.current !== review) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 409 || err.status === 410)) {
        review.submissionAttempted = review.submissionUncertain;
        review.resolve(review.submissionUncertain ? { kind: "submission-unknown", takeId: review.takeId } : { kind: "expired" });
        invalidateVideoGenerationSession(true);
        setVideoGenerationReviewError(review.submissionUncertain ? "Submission could not be confirmed. Check this scene’s takes before generating again." : "This review expired. Request a fresh review.");
      } else {
        review.submissionUncertain = true;
        // A transient submit failure is still the same private reviewed quote:
        // leave the bridge promise pending so a successful retry reports the
        // truthful terminal outcome rather than a stale unavailable result.
        setVideoGenerationReviewError("Submission could not be confirmed. Retry this same approval, or close and check this scene’s takes before generating again.");
      }
    }).finally(() => {
      review.submitting = false;
      if (videoGenerationSessionRef.current === session) setVideoGenerationSubmitting(false);
    });
  }, [invalidateVideoGenerationSession]);

  // Keep recovery handles across routine bridge reinstalls (including an
  // artifact rename or first materialization). Only the frame/account lifetime
  // owns them; an unrelated render must not cancel an in-flight checkpoint.
  const recoveryRef = useRef<AppDraftRecoveryPort | undefined>(undefined);
  useEffect(() => {
    if (!recoveryEnabled || iframeInstanceKey === null || nativeRecovery === undefined) return;
    const recovery = createAppDraftRecovery({ appId,
      viewerKey: auth.viewer.isVerified ? auth.viewer.sessionUserId : null,
      native: nativeRecovery, getRelayId: getDesktopRelayId });
    recoveryRef.current = recovery;
    return () => {
      recovery.dispose();
      if (recoveryRef.current === recovery) recoveryRef.current = undefined;
    };
  }, [appId, auth.viewer.isVerified, auth.viewer.sessionUserId, iframeInstanceKey, nativeRecovery, recoveryEnabled]);

  useEffect(() => {
    if (!runtime) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const imageAssets = runtime.hostCapabilities?.assets === true
      ? createAppImageAssets({ roomId: boundTarget?.kind === "artifact" ? boundTarget.roomId : draft?.roomId })
      : undefined;
    const uninstallBridge = installAppBridge({
      recovery: recoveryRef.current,
      templates,
      ...(imageAssets ? { assets: imageAssets } : {}),
      iframe,
      appId,
      mode,
      viewerKey: auth.viewer.isVerified ? auth.viewer.sessionUserId : null,
      target: boundTarget,
      documentSession: documentSessionRef.current,
      ...(mode === "edit" && boundTarget === undefined && draft ? { draft, materialize } : {}),
      ...(mode === "edit" && (appId === "nautilo-design" || appId === "nautilo-presentation" || appId === "nautilo-board") ? {
        saveCopy: async (content: string) => {
          const copyTarget = boundTargetRef.current;
          if (!copyTarget) throw new Error("Save Copy requires a bound document.");
          const result = await saveConflictCopy(copyTarget, content);
          if (result.kind !== "saved") throw new Error(result.message);
          return { path: result.path };
        },
      } : {}),
      onContextUpdate: (context) => {
        activeContextRef.current = context;
        onContextUpdate?.(context, mode);
      },
      ...(runtime.hostCapabilities?.assetReadRaster === true ? { assetReadRaster: true } : {}),
      ...(runtime.hostCapabilities?.mediaProxy === true ? { mediaProxy: true } : {}),
      ...(appId === "nautilo-video" && runtime.hostCapabilities?.mediaProxy === true && mode === "preview"
        ? {
            onVideoWorkspaceMediaOpenPreview: openVideoWorkspaceMediaPreview,
            onVideoWorkspaceMediaClosePreview: closeWorkspaceMediaPreview,
          }
        : {}),
      ...(mode === "edit" ? {
        onHumanEditUpdate: (update: AppHumanEditUpdate) => {
          setMiniAppHumanEditState(update.state);
          if (humanEditPublisherKey === null) return;
          promotionStateRef.current.humanState = update.state;
          setBoundHumanEditUpdate({ targetKey: humanEditPublisherKey, update });
        },
        onLifecycleRegistrationChange: (registered: boolean) => {
          lifecycleRegisteredRef.current = registered;
          if (!registered) lifecycleAbortRef.current?.abort();
          onRegisterTransitionGuard?.(registered ? (reason) => prepareTransition(reason) : null);
        },
        onDocumentVersion: (version: LiveDocumentVersion) => {
          void refreshLiveSession(version);
          invalidateVideoGenerationSession(true);
        },
        getLiveSession: () => {
          const session = liveSessionRef.current;
          if (!session) return null;
          return {
            sessionToken: session.token,
            sessionId: session.sessionId,
            documentVersion: session.documentVersion,
          };
        },
        onLiveProposalAccepted: handleLiveProposalAccepted,
        onLiveProposalAcknowledged: acknowledgeMatchingLiveProposal,
        ...(appId === "nautilo-video" && runtime.hostCapabilities?.mediaProxy === true
        ? {
            onVideoWorkspaceMediaImport: importWorkspaceVideo,
            onVideoMediaPick: pickVideoMedia,
            onVideoWorkspaceMediaExport: exportVideoWorkspaceMedia,
            ...(desktopAPI?.mediaExport?.promoteVideoProject && auth.viewer.isVerified ? {
              onVideoProjectPromotion: promoteCurrentFolderVideoProject,
              onOpenPromotedVideoProject: openPromotedVideoProject,
              workspaceCopyRoomLabel,
            } : {}),
            onVideoWorkspaceMediaOpenPreview: openVideoWorkspaceMediaPreview,
            onVideoWorkspaceMediaClosePreview: closeWorkspaceMediaPreview,
          }
        : {}),
        ...(runtime.hostCapabilities?.videoGeneration === true
        ? {
            videoGeneration: true as const,
            onVideoHostLayout: setVideoHostFullWidth,
            onVideoGenerationRequest: requestVideoGenerationReview,
            onVideoGenerationListTakes: listVideoGenerationTakes,
            onVideoGenerationGetTakeStatus: getVideoGenerationTakeStatus,
            onVideoGenerationPreviewTake: previewVideoGenerationTake,
            onVideoGenerationRevalidateTake: revalidateVideoGenerationTake,
            onVideoGenerationImportReference: importVideoGenerationReference,
            onVideoGenerationImportReferences: importVideoGenerationReferences,
          }
        : {}),
      } : {}),
    });
    // The app can call the bridge as soon as its module evaluates. Keep its
    // srcDoc unset until this parent-side message handler is active.
    if (iframeInstanceKey !== null) {
      setIframeBootstrap((current) =>
        current?.key === iframeInstanceKey
          ? current
          : { key: iframeInstanceKey, theme: themeRef.current },
      );
    }
    setBridgeReadyIframeKey(iframeInstanceKey);
    return () => {
      uninstallBridge();
      imageAssets?.dispose();
      // A stale/unmounted iframe must not strand the parent Genie rail in a
      // Video-owned full-width state. This is idempotent and never focuses.
      setVideoHostFullWidth({ enabled: false });
    };
  }, [
    appId,
    workspaceCopyRoomLabel,
    mode,
    auth.viewer.isVerified,
    auth.viewer.sessionUserId,
    boundTarget,
    setVideoHostFullWidth,
    draft,
    materialize,
    runtime,
    runtime?.sourceHash,
    sourceHash,
    onContextUpdate,
    humanEditPublisherKey,
    refreshLiveSession,
    invalidateVideoGenerationSession,
    handleLiveProposalAccepted,
    acknowledgeMatchingLiveProposal,
    requestVideoGenerationReview,
    listVideoGenerationTakes,
    getVideoGenerationTakeStatus,
    previewVideoGenerationTake,
    revalidateVideoGenerationTake,
    importVideoGenerationReference,
    importVideoGenerationReferences,
    importWorkspaceVideo,
    pickVideoMedia,
    exportVideoWorkspaceMedia,
    promoteCurrentFolderVideoProject,
    openPromotedVideoProject,
    openVideoWorkspaceMediaPreview,
    closeWorkspaceMediaPreview,
    iframeInstanceKey,
    onRegisterTransitionGuard,
    prepareTransition,
    templates,
  ]);

  // The inline bootstrap handles first paint. This effect keeps a mounted
  // iframe synchronized with later rail toggles without reloading its app.
  useEffect(() => {
    if (!runtime || !theme || bridgeReadyIframeKey !== iframeInstanceKey) return;
    const iframe = iframeRef.current;
    if (iframe) postAppTheme(iframe, theme);
  }, [bridgeReadyIframeKey, iframeInstanceKey, runtime, theme]);

  useEffect(() => {
    if (mode !== "edit" || runtime?.manifest.liveReview?.enabled !== true) return;
    if (boundTarget?.kind !== "artifact" && boundTarget?.kind !== "fs") return;
    if (bridgeReadyIframeKey !== iframeInstanceKey) return;
    let cancelled = false;
    let issuedToken: string | null = null;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let pendingIssue: Promise<void> | null = null;
    const isCurrent = () => !cancelled && iframeRef.current === iframe &&
      liveSessionTargetRef.current === boundTarget;
    const issue = (): Promise<void> => {
      if (!isCurrent() || liveSessionRef.current) return Promise.resolve();
      if (pendingIssue) return pendingIssue;
      // Assign before reading: a canonical read can itself request refresh.
      pendingIssue = Promise.resolve()
      .then(() => readDocumentSession(documentSessionRef.current, boundTarget))
      .then(async (envelope) => {
        const documentVersion: LiveDocumentVersion | null =
          boundTarget.kind === "artifact" && typeof envelope.baseRevision === "number"
            ? { kind: "artifact_revision", revision: envelope.baseRevision }
            : boundTarget.kind === "fs" && typeof envelope.baseSha256 === "string"
              ? { kind: "local_sha", sha256: envelope.baseSha256 }
              : null;
        if (!isCurrent() || !documentVersion) return;
        const relayIdHint = boundTarget.kind === "fs" ? await getDesktopRelayId() : null;
        if (!isCurrent()) return;
        const issueBody = buildIssueLiveSessionRequest(boundTarget, documentVersion, relayIdHint);
        if (!issueBody) return;
        const capability = await apiClient.issueLiveMiniAppSession(appId, issueBody);
        if (!isCurrent()) {
          void apiClient.revokeLiveMiniAppSession(appId, { sessionToken: capability.sessionToken });
          return;
        }
        issuedToken = capability.sessionToken;
        const issuedSession: LiveAppSession = {
          token: capability.sessionToken,
          sessionId: capability.sessionId,
          documentVersion: capability.documentVersion,
          expiresAt: capability.expiresAt,
          targetKey: liveReviewBoundTargetKey(boundTarget),
        };
        liveSessionRequestSequenceRef.current += 1;
        liveSessionRef.current = issuedSession;
        onLiveMiniAppSessionChange?.({
          sessionToken: issuedSession.token,
          sessionId: issuedSession.sessionId,
          documentVersion: issuedSession.documentVersion,
        });
        scheduleLiveSessionRefreshRef.current(issuedSession);
        publishLiveCapability(iframe, capability);
        void reconcileLiveProposals();
      })
      .catch(() => {
        /* fail closed when desktop relay or canonical read is unavailable */
      })
      .finally(() => {
        pendingIssue = null;
      });
      return pendingIssue;
    };
    issueLiveSessionRef.current = issue;
    void issue();

    return () => {
      cancelled = true;
      if (issueLiveSessionRef.current === issue) issueLiveSessionRef.current = null;
      liveSessionRequestSequenceRef.current += 1;
      if (liveSessionTimerRef.current) {
        clearTimeout(liveSessionTimerRef.current);
        liveSessionTimerRef.current = null;
      }
      const token = liveSessionRef.current?.token ?? issuedToken;
      if (!token) return;
      if (liveSessionRef.current?.token === token) liveSessionRef.current = null;
      onLiveMiniAppSessionChange?.(null);
      void apiClient.revokeLiveMiniAppSession(appId, { sessionToken: token }).catch(() => {});
    };
  }, [
    appId,
    mode,
    boundTarget,
    runtime,
    iframeKey,
    bridgeReadyIframeKey,
    iframeInstanceKey,
    onLiveMiniAppSessionChange,
    publishLiveCapability,
    reconcileLiveProposals,
  ]);

  useEffect(() => {
    if (mode !== "edit" || runtime?.manifest.liveReview?.enabled !== true) return;
    return subscribeLiveAppProposal(deliverMatchingLiveProposal);
  }, [deliverMatchingLiveProposal, runtime, iframeKey, mode]);

  useEffect(() => {
    if (mode !== "edit" || runtime?.manifest.liveReview?.enabled !== true) return;
    return subscribeLiveAppProposalReconciliation(() => {
      void reconcileLiveProposals();
    });
  }, [reconcileLiveProposals, runtime, iframeKey, mode]);

  useEffect(() => {
    if (mode !== "edit" || runtime?.manifest.liveReview?.enabled !== true) return;
    return subscribeLiveAppSessionClosed((event) => {
      const session = liveSessionRef.current;
      const iframe = iframeRef.current;
      if (!session || session.sessionId !== event.sessionId || !iframe) return;
      liveSessionRef.current = null;
      onLiveMiniAppSessionChange?.(null);
      postAppLiveSessionClosed(iframe, event);
    });
  }, [onLiveMiniAppSessionChange, runtime, iframeKey, mode]);

  useEffect(() => {
    if (!runtime || (boundTarget?.kind !== "artifact" && boundTarget?.kind !== "fs")) return;
    let cancelled = false;
    void readDocumentSession(documentSessionRef.current, boundTarget)
      .then(() => {
        if (cancelled) return;
      })
      .catch(() => {
        /* A later iframe read or fallback changed event can still seed state. */
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, boundTarget]);

  useEffect(() => {
    const displayTarget = target ?? boundTarget;
    if (!runtime || !displayTarget) {
      lastDocumentChangeKeyRef.current = null;
      return;
    }
    const changeKey =
      displayTarget.kind === "artifact"
        ? `${displayTarget.id}:${displayTarget.reloadToken ?? 0}:${displayTarget.path}`
        : `${displayTarget.rootPath}:${displayTarget.path}:${displayTarget.reloadToken ?? 0}`;
    const previous = lastDocumentChangeKeyRef.current;
    lastDocumentChangeKeyRef.current = changeKey;
    if (previous === null || previous === changeKey) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const displayPath =
      displayTarget.kind === "fs" ? fsBoundDisplayPath(displayTarget) : displayTarget.path;
    postAppDocumentChanged(iframe, { type: "changed", path: displayPath });
  }, [runtime, boundTarget, target]);

  useEffect(() => {
    if (!runtime || !boundTarget) return;

    const artifactTarget = boundTarget;
    const displayPath =
      artifactTarget.kind === "fs" ? fsBoundDisplayPath(artifactTarget) : artifactTarget.path;
    let artifactReconnectPromise: Promise<void> | null = null;
    const cancelPendingChanged = () => {
      if (documentChangedTimerRef.current) {
        clearTimeout(documentChangedTimerRef.current);
        documentChangedTimerRef.current = null;
      }
    };
    const postChanged = (
      iframe: HTMLIFrameElement,
      event: { path: string; reloadRequired?: boolean },
      immediate: boolean,
    ) => {
      cancelPendingChanged();
      const send = () => {
        postAppDocumentChanged(iframe, {
          type: "changed",
          path: event.path,
          ...(event.reloadRequired !== undefined ? { reloadRequired: event.reloadRequired } : {}),
        }, documentSessionRef.current);
      };
      if (immediate) {
        send();
        return;
      }
      documentChangedTimerRef.current = setTimeout(() => {
        documentChangedTimerRef.current = null;
        send();
      }, DOCUMENT_CHANGED_DEBOUNCE_MS);
    };
    const reconcileCanonicalDocument = (logReconnect = false): Promise<void> => {
      if (artifactReconnectPromise) return artifactReconnectPromise;
      artifactReconnectPromise = (async () => {
        try {
          const previousEnvelope = documentSessionRef.current.envelope;
          resetDocumentReadSession(documentSessionRef.current);
          const nextEnvelope = await readDocumentSession(documentSessionRef.current, artifactTarget);
          if (canonicalDocumentUnchanged(previousEnvelope, nextEnvelope)) {
            if (logReconnect) logArtifactReconnectOutcome("canonical_unchanged");
            if (logReconnect) {
              const iframe = iframeRef.current;
              if (iframe) postAppDocumentChanged(iframe, { type: "reconnected" });
            }
            return;
          }
          if (logReconnect) logArtifactReconnectOutcome("canonical_changed");
          if (typeof nextEnvelope.baseRevision === "number") {
            await refreshLiveSession({
              kind: "artifact_revision",
              revision: nextEnvelope.baseRevision,
            });
          }
          const iframe = iframeRef.current;
          if (iframe) {
            postChanged(iframe, { path: displayPath, reloadRequired: true }, true);
          }
        } catch (error) {
          if (logReconnect) logArtifactReconnectOutcome("canonical_read_failed");
          throw error;
        }
      })().finally(() => {
        artifactReconnectPromise = null;
      });
      return artifactReconnectPromise;
    };
    const unsubscribeCommittedMutation = subscribeLiveAppMutationCommitted((event) => {
      if (event.appId !== appId) return;
      void reconcileCanonicalDocument().catch(() => {
        /* The artifact stream and visibility reconciliation remain available. */
      });
    });
    const unsub = subscribeWorkspaceArtifactEvents(async (event) => {
        if (artifactTarget.kind === "fs") {
          if (
            event.type !== "document.mutation.committed" ||
            event.mutation !== "update" ||
            event.after.identity.kind !== "local_file"
          ) return;
          if (isLocalArtifactSaveMutation(workspaceArtifactEventClientMutationId(event))) return;
          const iframe = iframeRef.current;
          if (!iframe) return;
          if (!documentSessionRef.current.envelope) {
            await readDocumentSession(documentSessionRef.current, artifactTarget);
          }
          const identity = documentSessionRef.current.envelope?.localIdentity;
          if (
            !identity ||
            identity.relayId !== event.after.identity.relayId ||
            identity.canonicalPath !== event.after.identity.canonicalPath
          ) {
            resetDocumentReadSession(documentSessionRef.current);
            await readDocumentSession(documentSessionRef.current, artifactTarget);
            postChanged(iframe, { path: displayPath, reloadRequired: true }, true);
            return;
          }
          const patch = localFileEditorSavePatchEvent(event);
          if (patch && documentSessionRef.current.envelope) {
            const applied = await applyVerifiedDocumentPatchToWriteSession(
              documentSessionRef.current,
              patch,
              { path: displayPath, mimeType: "" },
            );
            if (applied) {
              postAppDocumentChanged(iframe, applied);
              return;
            }
          }
          resetDocumentReadSession(documentSessionRef.current);
          await readDocumentSession(documentSessionRef.current, artifactTarget);
          postChanged(iframe, { path: displayPath, reloadRequired: true }, true);
          return;
        }
        const artifactId = workspaceArtifactEventId(event);
        if (artifactId !== artifactTarget.id) return;

        const iframe = iframeRef.current;
        if (!iframe) return;

        if (event.type === "changed") {
          if (isLocalArtifactSaveMutation(event.clientMutationId)) return;
          postChanged(
            iframe,
            {
              path: event.path,
              ...(event.reloadRequired !== undefined ? { reloadRequired: event.reloadRequired } : {}),
            },
            event.reloadRequired === true,
          );
          return;
        }

        const committedPatch = workspaceEditorSavePatchEvent(event);
        if (event.type === "document.mutation.committed" && !committedPatch) {
          if (isLocalArtifactSaveMutation(workspaceArtifactEventClientMutationId(event))) return;
          postChanged(
            iframe,
            {
              path: workspaceArtifactEventPath(event) ?? artifactTarget.path,
              reloadRequired: true,
            },
            true,
          );
          return;
        }

        // Legacy patch projections remain only for existing non-editor
        // producers. Workspace editor saves arrive as `committedPatch` above.
        const patchEvent =
          committedPatch ?? (event.type === "document.patch.applied" ? event : null);
        if (!patchEvent) return;

        if (isLocalArtifactSaveMutation(patchEvent.clientMutationId)) return;
        cancelPendingChanged();

        {
          if (!documentSessionRef.current.envelope) {
            try {
              await readDocumentSession(documentSessionRef.current, artifactTarget);
            } catch {
              postChanged(iframe, { path: artifactTarget.path, reloadRequired: true }, true);
              return;
            }
          }
          const patchApplied = await applyVerifiedDocumentPatchToWriteSession(
            documentSessionRef.current,
            patchEvent,
            { path: artifactTarget.path, mimeType: artifactTarget.mimeType },
          );
          if (patchApplied) {
            postAppDocumentChanged(iframe, patchApplied);
            if (typeof patchApplied.revision === "number") {
              await refreshLiveSession({ kind: "artifact_revision", revision: patchApplied.revision });
            }
            return;
          }

          resetDocumentReadSession(documentSessionRef.current);
          await readDocumentSession(documentSessionRef.current, artifactTarget);
          postChanged(iframe, { path: artifactTarget.path, reloadRequired: true }, true);
        }
      }, artifactTarget.kind === "artifact"
        ? {
            artifactId: artifactTarget.id,
            roomId: artifactTarget.roomId,
            onReconnect: () => reconcileCanonicalDocument(true),
          }
        : {
            onReconnect: async () => {
              resetDocumentReadSession(documentSessionRef.current);
              await readDocumentSession(documentSessionRef.current, artifactTarget);
              const iframe = iframeRef.current;
              if (iframe) postChanged(iframe, { path: displayPath, reloadRequired: true }, true);
            },
          });

    return () => {
      cancelPendingChanged();
      unsubscribeCommittedMutation();
      unsub();
    };
  }, [
    runtime,
    appId,
    boundTarget,
    iframeKey,
    refreshLiveSession,
    subscribeWorkspaceArtifactEvents,
  ]);

  useEffect(() => {
    if (!runtime || boundTarget?.kind !== "fs") return;
    const fsTarget = boundTarget;
    const displayPath = fsBoundDisplayPath(fsTarget);
    const api = desktopAPI;
    if (!api?.fs.onDirectoryChanged) return;

    void api.fs.watchRoot?.(fsTarget.rootPath).catch(() => {});

    const cancelPendingChanged = () => {
      if (documentChangedTimerRef.current) {
        clearTimeout(documentChangedTimerRef.current);
        documentChangedTimerRef.current = null;
      }
    };
    const postChanged = (iframe: HTMLIFrameElement, reloadRequired = true) => {
      cancelPendingChanged();
      postAppDocumentChanged(iframe, {
        type: "changed",
        path: displayPath,
        reloadRequired,
      });
    };

    const processExternalChange = async (
      evt: FsDirectoryChangedEvent,
      skipOwnShaSuppression = false,
    ): Promise<void> => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      let currentSha: string | null = evt.sha256 ?? evt.patchEvent?.sha256 ?? null;
      if (!currentSha) {
        try {
          const st = await api.fs.stat(fsTarget.path);
          if (st.exists && st.isFile) {
            const content = await api.fs.readFile(fsTarget.path);
            currentSha = await sha256HexForText(content);
          }
        } catch {
          /* Fall through to the canonical reset/read path. */
        }
      }
      if (!skipOwnShaSuppression && isLocalFsSaveSha(fsTarget.path, currentSha)) return;

      cancelPendingChanged();
      resetDocumentReadSession(documentSessionRef.current);
      try {
        const envelope = await readDocumentSession(documentSessionRef.current, fsTarget);
        const canonicalSha = envelope.baseSha256;
        if (
          evt.patchEvent &&
          evt.reloadRequired !== true &&
          evt.patchEvent.target.kind === "currentFile" &&
          typeof canonicalSha === "string" &&
          canonicalSha === evt.patchEvent.sha256
        ) {
          postAppDocumentChanged(iframe, {
            type: "patch_applied",
            path: displayPath,
            patchId: evt.patchEvent.patchId,
            revision: evt.patchEvent.revision,
            sha256: evt.patchEvent.sha256,
            previousRevision: evt.patchEvent.previousRevision,
            previousSha256: evt.patchEvent.previousSha256,
            patch: evt.patchEvent.patch,
            ...(evt.patchEvent.author ? { author: evt.patchEvent.author } : {}),
            ...(evt.patchEvent.rebased !== undefined
              ? { rebased: evt.patchEvent.rebased }
              : {}),
            envelope: {
              content: envelope.content,
              mimeType: envelope.mimeType,
              path: envelope.path,
              baseSha256: canonicalSha,
              baseRevision: evt.patchEvent.revision,
            },
          });
        } else {
          postChanged(iframe, true);
        }
        if (typeof canonicalSha === "string") {
          await refreshLiveSession({ kind: "local_sha", sha256: canonicalSha });
        }
      } catch {
        postChanged(iframe, true);
      }
    };
    const processDeferredExternalChange = (evt: FsDirectoryChangedEvent): void => {
      void processExternalChange(evt, true);
    };
    const unsub = api.fs.onDirectoryChanged((evt) => {
      if (!fsDirectoryChangeAffectsFile(evt, fsTarget.path)) return;
      const outcome = observePendingAcceptMutationEvent(
        evt.clientMutationId,
        evt,
        processDeferredExternalChange,
      );
      if (outcome !== "untracked") return;
      void processExternalChange(evt);
    });

    return () => {
      cancelPendingChanged();
      releasePendingAcceptMutationObserver(processDeferredExternalChange);
      unsub();
    };
  }, [boundTarget, refreshLiveSession, runtime, iframeKey]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          {hasDoc ? (
            editingName && canRename ? (
              <input
                ref={renameInputRef}
                value={docName}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingName(false);
                    setName(
                      boundTarget?.kind === "artifact"
                        ? basename(boundTarget.path)
                        : (draft?.suggestedName ?? docName),
                    );
                  }
                }}
                disabled={renaming}
                aria-label="Document name"
                data-testid="mini-app-doc-name-input"
                className="w-full max-w-[20rem] rounded border border-border bg-background px-1.5 py-0.5 text-sm font-medium text-foreground outline-none focus:border-accent"
              />
            ) : canRename ? (
              <button
                type="button"
                data-testid="mini-app-doc-name"
                onClick={() => setEditingName(true)}
                title="Rename"
                className="group flex max-w-full items-center gap-1 rounded text-sm font-medium text-foreground hover:text-foreground"
              >
                <span className="truncate">{docName || "Untitled"}</span>
                <Pencil
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
                />
              </button>
            ) : (
              <div className="truncate text-sm font-medium text-foreground">{docName}</div>
            )
          ) : (
            <div className="truncate text-sm font-medium text-foreground">
              {runtime?.manifest.name ?? appId}
            </div>
          )}
          {runtime ? (
            <div className="truncate text-xs text-foreground-muted">
              {hasDoc ? `${runtime.manifest.name} · ` : ""}v{runtime.manifest.version}
              {mode === "preview" ? " · Preview" : ""}
            </div>
          ) : null}
          {renameError ? (
            <div className="truncate text-[10px] text-[var(--error)]">{renameError}</div>
          ) : null}
          {exportPreparing ? <div role="status" className="flex items-center gap-2 text-xs text-foreground-muted">
            Preparing export…
            <button type="button" className="underline" onClick={() => exportAbortRef.current?.abort()}>Cancel export</button>
          </div> : null}
          {exportNotice ? (
            <div
              className={`truncate text-[10px] ${
                exportNotice.kind === "error" ? "text-[var(--error)]" : "text-[var(--success)]"
              }`}
            >
              {exportNotice.message}
            </div>
          ) : null}
        </div>
        {onToggleChat || onToggleBrowser ? (
          <button
            type="button"
            data-testid="mini-app-full-width-button"
            aria-pressed={videoHostFullWidthSnapshotRef.current !== null}
            aria-label={videoHostFullWidthSnapshotRef.current ? "Restore layout" : "Work full width"}
            title={videoHostFullWidthSnapshotRef.current ? "Restore the previous Workspace and Genie layout" : "Hide Workspace and Genie"}
            onClick={() => setVideoHostFullWidth({ enabled: videoHostFullWidthSnapshotRef.current === null })}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-element"
          >
            {videoHostFullWidthSnapshotRef.current ? <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{videoHostFullWidthSnapshotRef.current ? "Restore layout" : "Full width"}</span>
          </button>
        ) : null}
        {mode === "preview" && onEdit ? (
          <button
            type="button"
            data-testid="mini-app-edit-button"
            onClick={onEdit}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-element"
          >
            Edit
          </button>
        ) : null}
        {mode === "edit" && exportActions.length > 0 ? (
          <div ref={exportMenuRef} className="relative shrink-0">
            <button
              type="button"
              data-testid="mini-app-export-button"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              disabled={!canExport}
              title={!hasBoundDoc ? "Open a document to export" : "Export document"}
              onClick={() => setExportMenuOpen((open) => !open)}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exportInFlight ? "Exporting..." : "Export ▾"}
            </button>
            {exportMenuOpen && canExport ? (
              <div
                role="menu"
                aria-label="Export document"
                className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[10rem] overflow-hidden rounded-md border border-border bg-background-panel py-1 shadow-md"
              >
                {exportActions.flatMap((action) => {
                  const choices = action.id === "export-svg" || action.id === "export-png" ? designScopeChoices : [];
                  const entries = choices.length > 0
                    ? choices.map((choice) => ({
                        key: `${action.id}:${choice.label}`,
                        label: `${action.label} · ${choice.label}`,
                        scope: choice.scope,
                      }))
                    : [{ key: action.id, label: action.label, scope: undefined }];
                  return entries.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      role="menuitem"
                      disabled={exportInFlight}
                      onClick={() => void handleExport(action, entry.scope)}
                      className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {entry.label}
                    </button>
                  ));
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close app"
          title="Close app"
          className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      {appId === "nautilo-video" ? (
        <VideoHostSupportNotice
          serverUrl={setupStatus?.serverUrl ?? (typeof window === "undefined" ? null : window.location.origin)}
          isDesktopShell={isDesktop}
          supportsWorkspaceMedia={supportsVideoWorkspaceMedia}
        />
      ) : null}

      {closeConfirming ? (
        <div
          role="alertdialog"
          aria-label="Unsaved app changes"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-foreground"
        >
          <span>Save your changes before leaving.</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                pendingLeaveRef.current = null;
                const stay = pendingStayRef.current;
                pendingStayRef.current = null;
                setCloseConfirming(false);
                stay?.();
              }}
              className="rounded-md border border-border bg-background px-2.5 py-1 font-medium hover:bg-background-element"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={() => {
                const leave = pendingLeaveRef.current;
                pendingLeaveRef.current = null;
                pendingStayRef.current = null;
                setCloseConfirming(false);
                leave?.();
              }}
              className="rounded-md border border-border bg-background px-2.5 py-1 font-medium text-[var(--error)] hover:bg-background-element"
            >
              Discard and continue
            </button>
          </div>
        </div>
      ) : null}

      {reloadNotice ? (
        <div
          data-testid="mini-app-reload-notice"
          className="shrink-0 border-b border-border bg-background-element px-4 py-1.5 text-xs text-foreground-muted"
        >
          {reloadNotice}
        </div>
      ) : null}

      {lifecycleNotice ? (
        <div
          data-testid="mini-app-lifecycle-notice"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-foreground"
        >
          <span>{lifecycleNotice.message}</span>
          <div className="flex shrink-0 gap-2">
            {lifecycleNotice.kind === "blocked" ? (
              <>
                <button
                  type="button"
                  onClick={() => void retryLifecycleTransition()}
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => void retryLifecycleTransition("save-copy")}
                >
                  Save Copy
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => {
                lifecycleAbortRef.current?.abort();
                setLifecycleNotice(null);
                onLifecycleCancel?.();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {pendingSourceHash ? (
        <div
          data-testid="mini-app-update-available"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-foreground"
        >
          <span className="min-w-0 truncate">
            App source changed. Reload the app when you are ready to update the running preview.
          </span>
          <button
            type="button"
            onClick={() => requestLeave(() => void reloadRuntime())}
            disabled={reloadInFlight}
            className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reloadInFlight ? "Reloading..." : "Reload app"}
          </button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {state.kind === "loading" && (
          <div className="px-6 py-5 text-sm text-foreground-muted">Loading app…</div>
        )}
        {state.kind === "error" && (
          <div className="px-6 py-5">
            <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
              {state.message}
            </div>
          </div>
        )}
        {runtime ? (
          <iframe
            key={iframeInstanceKey}
            ref={iframeRef}
            title={runtime.manifest.name}
            sandbox="allow-scripts"
            inert={reloadInFlight || undefined}
            srcDoc={bridgeReadyIframeKey === iframeInstanceKey ? iframeSrcDoc : undefined}
            onLoad={() => {
              const currentTheme = themeRef.current;
              const iframe = iframeRef.current;
              if (currentTheme && iframe) postAppTheme(iframe, currentTheme);
            }}
            className="h-full min-h-0 w-full flex-1 border-0 bg-background"
          />
        ) : null}
        <VideoGenerationReviewOverlay
          approval={videoGenerationReview?.approval ?? null}
          presentation={videoGenerationReview?.presentation}
          roomId={videoGenerationReview?.roomId}
          busy={videoGenerationSubmitting}
          error={videoGenerationReviewError}
          onOnce={submitVideoGenerationReview}
          onCancel={cancelVideoGenerationReview}
        />
        {workspaceMediaPicker ? <VideoWorkspaceMediaPicker {...workspaceMediaPicker} loadPreview={loadWorkspaceMediaPickerPreview} onSelect={(artifact) => closeWorkspaceMediaPicker(artifact)} onUpload={(selection) => { const resolve = videoMediaPickResolveRef.current; if (resolve && selection) { videoMediaPickResolveRef.current = null; closeWorkspaceMediaPicker(null, true); resolve(selection); } else closeWorkspaceMediaPicker("upload", true); }} onCancel={() => closeWorkspaceMediaPicker(null, true)} /> : null}
        {videoGenerationPreview ? (
          <section className="absolute inset-0 z-20 grid place-items-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-label="Generated take preview" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeVideoGenerationPreview(); } }}>
            <div className="max-h-full w-full max-w-4xl overflow-auto rounded-lg border border-border bg-background p-3 shadow-2xl">
              <header className="mb-2 flex items-center justify-between gap-3 text-sm font-medium text-foreground">
                <span>{videoGenerationPreview.label}</span>
                <button ref={videoGenerationPreviewCloseRef} type="button" onClick={closeVideoGenerationPreview} className="rounded border border-border px-2 py-1 hover:bg-background-element">Close preview</button>
              </header>
              {videoGenerationPreview.mediaKind === "video"
                ? <video src={videoGenerationPreview.src} controls autoPlay playsInline className="max-h-[70vh] w-full rounded bg-black" />
                : <audio src={videoGenerationPreview.src} controls autoPlay className="w-full" />}
            </div>
          </section>
        ) : null}
      </div>
      {conversionRunner.conflictDialog}
    </div>
  );
}
