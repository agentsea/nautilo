import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { VideoAutosave, bridgeWriteResult, type VideoAutosaveState, type VideoSavedDocumentIdentity } from "./autosave";
import { parsePlaybackCommand, planPlaybackCommand, type PlaybackResult } from "./live-playback";
import { parseGenerationReviewCommand, GENERATION_REVIEW_REQUESTED } from "./generation-agent";
import { parseMediaCommand, newMediaOperation, mediaOperationActive, type MediaOperation, type MediaOperationsResult } from "./media-agent";
import {
  getNautiloApp,
  isNoDocumentError,
  isSafeVideoGenerationRequestPrompt,
  type NautiloDocumentEnvelope,
  type NautiloAppBridge,
  type NautiloVideoGenerationTakeStatus,
  type NautiloVideoGenerationTakeSummary,
  type NautiloVideoImportReady,
  type NautiloVideoPreviewRequest,
} from "./bridge";
import { buildVideoContextSummary, type VideoContextSummary } from "./context-summary";
import { selectClipIds } from "./clip-selection";
import { createEmptyProject, findClip, isClipKindAllowedOnTrack, type Clip, type ClipKind, type MediaAsset, type TrackKind, type VideoManifest, type VideoProject } from "./edl";
import { addClip, addTrack, admitImportedMedia, deleteClip, deleteTrack, detachAudio, moveClip, moveClipGroup, reorderTrack, requiresFirstSourceRateDecision, splitClip, trimClip, updateClipProps, updateTrack, type AddClipInput, type AddImportedMediaInput, type FirstSourceRateDecision } from "./commands";
import { admitGeneratedTakeMedia, copyTimelineSelection, pasteTimelineClipboard, removeTimelineSelection, setClipFade, setCutTransition, type GeneratedTakeRevalidation, type TimelineClipboard } from "./commands";
import { FadeContext, FadeInspector, FadeLibrary } from "./FadeControls";
import { MediaBinPreview } from "./MediaBinPreview";
import { GeneratorWorkspace } from "./GeneratorWorkspace";
import { runGenerationSequence } from "./generation-sequence";
import { placeGeneratedMediaSequence } from "./generator-composer";
import { generationSettingsForSource } from "./generation-settings";
import { GenerationSettingsControls } from "./GenerationSettingsControls";
import { TransitionContext, TransitionInspector, TransitionLibrary, type TransitionEdit } from "./TransitionControls";
import { clipTransition, transitionTarget, type TransitionKind } from "./transitions";
import { clipFades, type FadeEdit, type FadeKey } from "./fades";
import { generatedTakesEqual, validateGeneratedTake, validateGeneratedTakes, type GeneratedTake } from "./generation-takes";
import { planSyntheticClip, type SyntheticClipKind } from "./synthetic-clips";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";
import { createEmptyGenerationBrief, effectiveGenerationDirectionBlocks, updateGenerationShot, type GenerationBrief } from "./generation-brief";
import {
  VIDEO_GENERATION_CATALOG_MODELS,
  generationPlanIssueMessage,
  VIDEO_GENERATION_PLAN_VERSION,
  buildVideoGenerationPlanDraft,
  type VideoGenerationCatalogModelId,
  type VideoGenerationRequestedSettings,
  type VideoGenerationPlanDraftV1,
  type VideoGenerationPlanIntentV1,
} from "./generation-plan";
import { computeSequenceDurationSec } from "./timing";
import { Timeline, type TimelineClipboardAction } from "./timeline/Timeline";
import type { TimelineRange } from "./timeline/Ruler";
import { FrameRateDialog, formatFrameRate } from "./FrameRateDialog";
import { TextLibrary, ToolboxRail, UnavailableEffectLibrary, type ToolboxCategory } from "./Toolbox";
import { VIDEO_MEDIA_DRAG_TYPE } from "./timeline/TimelineTrack";
import type { ClipMoveRequest, ClipTrimLeftRequest, ClipTrimRightRequest } from "./timeline/ClipBlock";
import {
  DEFAULT_CUTTING_ROOM_LAYOUT,
  PREVIEW_PERCENT_KEYBOARD_STEP,
  PREVIEW_PERCENT_MAX,
  PREVIEW_PERCENT_MIN,
  adjustPreviewPercent,
  clearNarrowDrawer,
  closePanelForViewport,
  isPanelOpen,
  panelWidths,
  resolveHostTheme,
  setPreviewPercent,
  toggleFocus,
  togglePanelForViewport,
  type CuttingRoomLayout,
  type ThemeMode,
} from "./cutting-room-layout";
import { createCuttingRoomFixtureProject } from "./cutting-room-fixture";
import { ProgramPreview } from "./ProgramPreview";
import { VideoProjectHistory, type VideoProjectHistoryState } from "./project-history";
import { deriveVideoAgentReceipt, recoverVideoAgentReceipt, revertVideoAgentReceipt, type VideoAgentReceipt } from "./agent-receipt";

type AppPhase = { kind: "loading" } | { kind: "no-document" } | { kind: "invalid"; message: string } | { kind: "ready" };
type VideoWorkspace = "edit" | "generate";
type GenerationReview = Readonly<{
  document: VideoSavedDocumentIdentity;
  draft: Extract<VideoGenerationPlanDraftV1, { status: "ready-for-quote" }> | Extract<VideoGenerationPlanDraftV1, { status: "blocked" }>;
}>;
type GenerationQuoteState = "queued" | "cancelled" | "expired" | "unavailable" | "submission-unknown";
type GeneratedTakeLoadState = "idle" | "loading" | "ready" | "unavailable";
export type GeneratedTakeRefreshDisposition = "active" | "terminal" | "retry";
export type GeneratedTakeProgressPresentation = Readonly<{
  message: string;
  timing: string | null;
  isActive: boolean;
}>;
export type GeneratedTakeElapsedObservation = Readonly<{
  elapsedSeconds: number;
  observedAtMs: number;
}>;
type VideoExportState =
  | { kind: "idle" }
  | { kind: "active"; message: string; processedTimeUs?: number }
  | { kind: "complete"; message: string }
  | { kind: "failed"; message: string };
type WorkspaceCopyState =
  | { kind: "idle" }
  | { kind: "active"; message: string }
  | { kind: "complete"; message: string; canOpen: boolean }
  | { kind: "failed"; message: string };

const GENERATED_TAKE_STATUS_CONCURRENCY = 6;
const GENERATED_TAKE_POLL_INTERVAL_MS = 5_000;
const MAX_GENERATED_TAKE_SESSION_RETRIES = 3;
/**
 * Workspace-generated media remains host-authorized after promotion. The
 * iframe names only its persisted media id; the parent re-reads the bound
 * document and resolves the exact durable artifact. All existing Current
 * Folder and legacy media retain the ref-based preview path.
 */
export function videoPreviewRequestForAsset(
  asset: Pick<MediaAsset, "id" | "ref" | "lifecycle" | "source">,
): NautiloVideoPreviewRequest {
  if (asset.lifecycle === "durable" && asset.source?.kind === "workspace-artifact") {
    return { mediaId: asset.id };
  }
  return { ref: asset.ref };
}

/** Map a timeline playhead into the active clip's retained source range. */
export function videoPreviewSourceTime(clip: Pick<Clip, "timelineStartSec" | "durationSec" | "sourceInSec" | "sourceOutSec">, playheadSec: number): number {
  const sourceStart = clip.sourceInSec ?? 0;
  const sourceEnd = clip.sourceOutSec ?? sourceStart + clip.durationSec;
  return Math.max(sourceStart, Math.min(sourceEnd, sourceStart + playheadSec - clip.timelineStartSec));
}

const INITIAL_AUTOSAVE_STATE: VideoAutosaveState = {
  status: "idle",
  dirty: false,
  errorMessage: null,
  conflictLatestContent: null,
  lastSavedAt: null,
};

function parseEnvelope(value: unknown): NautiloDocumentEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["content"] !== "string") return null;
  return {
    content: record["content"],
    ...(typeof record["mimeType"] === "string" ? { mimeType: record["mimeType"] } : {}),
    ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
    baseSha256: typeof record["baseSha256"] === "string" ? record["baseSha256"] : null,
    baseRevision: typeof record["baseRevision"] === "number" ? record["baseRevision"] : null,
  };
}

function statusLabel(state: VideoAutosaveState): string {
  switch (state.status) {
    case "saving":
      return "Saving...";
    case "saved":
      return "Saved";
    case "unsaved":
      return "Unsaved";
    case "conflict":
      return "Conflict";
    case "failed":
      return "Failed";
    default:
      return state.dirty ? "Unsaved" : "Saved";
  }
}

function sameSavedDocumentIdentity(left: VideoSavedDocumentIdentity | null, right: VideoSavedDocumentIdentity): boolean {
  return left?.sha256 === right.sha256 && left.revision === right.revision;
}

function formatGeneratedTakeDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

/** Project the last provider observation forward for display only. */
export function displayedGeneratedTakeElapsedSeconds(
  observation: GeneratedTakeElapsedObservation | undefined,
  nowMs: number,
): number | undefined {
  if (!observation || !Number.isSafeInteger(observation.elapsedSeconds) || observation.elapsedSeconds < 0 || !Number.isFinite(observation.observedAtMs) || !Number.isFinite(nowMs)) return undefined;
  return observation.elapsedSeconds + Math.max(0, Math.floor((nowMs - observation.observedAtMs) / 1_000));
}

/**
 * A fresh provider result may arrive behind the display clock. Keep the
 * visible elapsed value monotonic without persisting or acting on it.
 */
export function reconcileGeneratedTakeElapsedObservation(
  prior: GeneratedTakeElapsedObservation | undefined,
  providerElapsedSeconds: number | undefined,
  observedAtMs: number,
): GeneratedTakeElapsedObservation | undefined {
  if (typeof providerElapsedSeconds !== "number" || !Number.isSafeInteger(providerElapsedSeconds) || providerElapsedSeconds < 0 || !Number.isFinite(observedAtMs)) return prior;
  const projectedPrior = displayedGeneratedTakeElapsedSeconds(prior, observedAtMs);
  return {
    elapsedSeconds: Math.max(providerElapsedSeconds, projectedPrior ?? 0),
    observedAtMs,
  };
}

/**
 * Paid generation is cancellable only before its parent submits it. Once a
 * take appears here, progress must be honest: provider timing is elapsed and
 * typical, never a fabricated completion percentage or remaining countdown.
 */
export function generatedTakeProgressPresentation(
  status: NautiloVideoGenerationTakeStatus,
  displayedElapsedSeconds: number | undefined = status.progress?.elapsedSeconds,
): GeneratedTakeProgressPresentation | null {
  const elapsed = displayedElapsedSeconds;
  const estimate = status.progress?.estimatedSeconds;
  const timing = [
    elapsed === undefined ? null : `${formatGeneratedTakeDuration(elapsed)} elapsed`,
    estimate === undefined ? null : `Typical time: about ${formatGeneratedTakeDuration(estimate)}`,
  ].filter((part): part is string => part !== null).join(" · ") || null;
  const isActive = ["preparing", "queued", "submitting", "generating", "downloading", "saving"].includes(status.state);

  switch (status.state) {
    case "preparing":
      return { message: "Checking progress…", timing, isActive };
    case "queued":
    case "submitting":
      return { message: "Submitted for generation…", timing, isActive };
    case "generating":
      if (elapsed !== undefined && estimate !== undefined && elapsed > estimate) {
        return { message: "This run is taking longer than typical, but it is still active.", timing, isActive };
      }
      return { message: elapsed === undefined ? "Checking progress…" : "Generation is active.", timing, isActive };
    case "downloading":
      return { message: "Generation finished—downloading securely.", timing, isActive };
    case "saving":
      return { message: "Saving to Workspace…", timing, isActive };
    default:
      return null;
  }
}

/**
 * The only conversion from a host status projection into document lineage.
 * Status may be displayed before this succeeds, but only a fully validated,
 * completed Workspace artifact can ever enter `project.generatedTakes`.
 */
export function generatedTakeFromArtifactReadyStatus(
  summary: NautiloVideoGenerationTakeSummary,
  status: NautiloVideoGenerationTakeStatus,
): GeneratedTake | null {
  // D525 reaches `cleanup-pending` only after the readable Workspace artifact
  // is complete. Its bookkeeping must stay visible, but cannot strand a
  // finished take outside the edit flow.
  if (status.takeId !== summary.takeId || !["ready", "cleanup-pending"].includes(status.state) || !status.artifact) return null;
  try {
    return validateGeneratedTake({
      id: summary.takeId,
      briefRevision: summary.documentRevision,
      shotId: summary.shotId,
      shotLabel: summary.shotLabel,
      mediaKind: status.mediaKind,
      modelId: status.modelId,
      settings: status.settings,
      artifact: status.artifact,
    });
  } catch {
    return null;
  }
}

/** Merge durable document lineage with the current host list without hiding either. */
export function mergeGeneratedTakeSummaries(
  hostSummaries: readonly NautiloVideoGenerationTakeSummary[],
  persisted: readonly GeneratedTake[] | undefined,
): NautiloVideoGenerationTakeSummary[] {
  const entries = new Map(hostSummaries.map((summary) => [summary.takeId, summary]));
  for (const take of persisted ?? []) {
    if (!entries.has(take.id)) {
      entries.set(take.id, {
        takeId: take.id,
        shotId: take.shotId ?? "recorded-generated-take",
        shotLabel: take.shotLabel ?? `Generated ${take.mediaKind}`,
        documentRevision: take.briefRevision,
      });
    }
  }
  return [...entries.values()];
}

/**
 * Admit completed candidates one at a time against the document's strict
 * cap/identity validator. A host can list more than the document can retain;
 * that must leave the project untouched rather than creating an invalid draft.
 */
export function admitGeneratedTakeCandidates(
  persisted: readonly GeneratedTake[] | undefined,
  candidates: readonly GeneratedTake[],
): Readonly<{ takes: GeneratedTake[]; rejectedCount: number }> {
  let takes: GeneratedTake[];
  try {
    takes = validateGeneratedTakes(persisted ?? []);
  } catch {
    return { takes: [...(persisted ?? [])], rejectedCount: candidates.length };
  }
  let rejectedCount = 0;
  for (const candidate of candidates) {
    const prior = takes.find((take) => take.id === candidate.id);
    if (prior) {
      if (!generatedTakesEqual(prior, candidate)) rejectedCount += 1;
      continue;
    }
    try {
      takes = validateGeneratedTakes([...takes, candidate]);
    } catch {
      rejectedCount += 1;
    }
  }
  return { takes, rejectedCount };
}

/** Keep a short recovery window for an expiring parent attestation, never an endless unsupported-host loop. */
export function nextGeneratedTakePollState(
  disposition: GeneratedTakeRefreshDisposition,
  retryAttempts: number,
): Readonly<{ shouldPoll: boolean; retryAttempts: number }> {
  if (disposition === "active") return { shouldPoll: true, retryAttempts: 0 };
  if (disposition === "terminal") return { shouldPoll: false, retryAttempts: 0 };
  const nextAttempts = retryAttempts + 1;
  return { shouldPoll: nextAttempts <= MAX_GENERATED_TAKE_SESSION_RETRIES, retryAttempts: nextAttempts };
}

/** Retry must leave the manual Refresh control reachable after its finite budget ends. */
export function generatedTakeLoadStateAfterRetry(): GeneratedTakeLoadState {
  return "unavailable";
}

/** A preview is a parent-owned action, never a returned transport URL or blob. */
export async function requestGeneratedTakePreview(
  generation: Pick<NonNullable<NautiloAppBridge["videoGeneration"]>, "previewTake"> | undefined,
  takeId: string,
): Promise<"opened" | "unavailable"> {
  if (!generation) return "unavailable";
  try {
    const result = await generation.previewTake({ takeId });
    return result.kind === "opened" ? "opened" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function formatPlayheadTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function buildGenieStatusLine(summary: VideoContextSummary, saveLabel: string): string {
  const clipCount = summary.summary.clipCount;
  const clipPart = `Genie sees ${clipCount} clip${clipCount === 1 ? "" : "s"}`;
  const selectionPart = summary.selection ? `selected ${summary.selection.kind}` : "no clip selected";
  const playheadPart = `playhead ${formatPlayheadTimecode(summary.playheadSec)}`;
  return `${clipPart} · ${selectionPart} · ${playheadPart} · ${saveLabel}`;
}

function clipDisplayName(clip: Clip | null): string {
  if (!clip) return "No clip selected";
  const text = typeof clip.props["text"] === "string" ? clip.props["text"] : null;
  return text?.trim() || clip.mediaId || `${clip.kind} clip`;
}

function trackDisplayName(id: string, kind: string): string {
  const explicitName = id.replace(/^track-/, "").replaceAll("-", " ").trim();
  if (explicitName && !["video", "overlay", "captions", "voice", "music"].includes(explicitName)) {
    return explicitName.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  switch (kind) {
    case "video": return "Video";
    case "overlay": return "Overlays";
    case "caption": return "Captions";
    case "audio": return "Voice audio";
    case "music": return "Music";
    default: return "Track";
  }
}

/**
 * Identify the clip id `addClip` generated for a synthetic add.
 *
 * `addClip` creates the new clip id internally and only returns the next
 * project, so the new id must be derived by diffing clip ids. `addClip`
 * appends exactly one clip and never rewrites existing ids, so there is
 * exactly one id in `next` that is absent from `prev`. We additionally
 * match the planner's (trackId, kind, start, duration) as a defense in
 * depth so a stray id change elsewhere can never be mis-attributed.
 *
 * Returns `undefined` if no single matching new clip is found, which the
 * caller treats as a command error rather than committing a bad selection.
 */
function findCreatedClipId(prev: VideoProject, next: VideoProject, input: AddClipInput, sequenceId = prev.sequences[0]?.id): string | undefined {
  if (!sequenceId) return undefined;
  const prevSequence = prev.sequences.find((sequence) => sequence.id === sequenceId);
  const nextSequence = next.sequences.find((sequence) => sequence.id === sequenceId);
  if (!prevSequence || !nextSequence) return undefined;
  const prevIds = new Set<string>();
  for (const track of prevSequence.tracks) {
    for (const clip of track.clips) prevIds.add(clip.id);
  }
  for (const track of nextSequence.tracks) {
    for (const clip of track.clips) {
      if (prevIds.has(clip.id)) continue;
      if (
        clip.trackId === input.trackId &&
        clip.kind === input.kind &&
        clip.timelineStartSec === input.timelineStartSec &&
        clip.durationSec === input.durationSec
      ) {
        return clip.id;
      }
    }
  }
  return undefined;
}

function mediaPlacementKind(asset: MediaAsset): ClipKind {
  if (asset.kind === "audio") return "audio";
  if (asset.kind === "image") return "image";
  return "video";
}

/** Only still images have an editable default display duration. */
export function mediaPlacementDurationSec(asset: Pick<MediaAsset, "kind" | "durationSec">): number | undefined {
  return asset.durationSec ?? (asset.kind === "image" ? 5 : undefined);
}

function getPreferredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  return media?.matches ? "dark" : "light";
}

function getHostTheme(): ThemeMode {
  const hostTheme = typeof document === "undefined" ? undefined : document.documentElement.dataset["theme"];
  return resolveHostTheme(hostTheme, getPreferredTheme());
}

export function VideoApp(): ReactElement {
  const [phase, setPhase] = useState<AppPhase>({ kind: "loading" });
  const [project, setProject] = useState<VideoProject>(() => createEmptyProject());
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<ReadonlySet<string>>(() => new Set());
  const [layout, setLayout] = useState<CuttingRoomLayout>(DEFAULT_CUTTING_ROOM_LAYOUT);
  const [toolboxCategory, setToolboxCategory] = useState<ToolboxCategory>("Media");
  const focusCreatedTextRef = useRef(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [timelineRange, setTimelineRange] = useState<TimelineRange>({ inSec: 0, outSec: 0 });
  const timelineRangeRef = useRef(timelineRange);
  timelineRangeRef.current = timelineRange;
  const [playing, setPlaying] = useState(false);
  const [sourcePreviewId, setSourcePreviewId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getHostTheme());
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches === true,
  );
  const [autosaveState, setAutosaveState] = useState<VideoAutosaveState>(INITIAL_AUTOSAVE_STATE);
  const [contextSummary, setContextSummary] = useState<VideoContextSummary | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<VideoProjectHistoryState>({ canUndo: false, canRedo: false });
  const [agentReceipt, setAgentReceipt] = useState<VideoAgentReceipt | null>(null);
  const [receiptReverted, setReceiptReverted] = useState(false);
  const [receiptDismissed, setReceiptDismissed] = useState(false);
  const [receiptsEnabled, setReceiptsEnabled] = useState(true);
  const [receiptPreferenceMessage, setReceiptPreferenceMessage] = useState<string | null>(null);
  const [receiptPreferenceBusy, setReceiptPreferenceBusy] = useState(false);
  const [mediaImportStatus, setMediaImportStatus] = useState<string | null>(null);
  const [mediaImportBusy, setMediaImportBusy] = useState(false);
  const [pendingVideoImport, setPendingVideoImport] = useState<(NautiloVideoImportReady & { frameRate: { numerator: number; denominator: number } }) | null>(null);
  const [firstSourceRate, setFirstSourceRate] = useState<FirstSourceRateDecision | "ask">("ask");
  const [ratePreferenceMessage, setRatePreferenceMessage] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<VideoWorkspace>("edit");
  const [generationModelId, setGenerationModelId] = useState<VideoGenerationCatalogModelId>(VIDEO_GENERATION_CATALOG_MODELS.seedance);
  const [generationSettings, setGenerationSettings] = useState<VideoGenerationRequestedSettings>({});
  const [generationReview, setGenerationReview] = useState<GenerationReview | null>(null);
  const [generationReviewBusy, setGenerationReviewBusy] = useState(false);
  const [generationRunMessage, setGenerationRunMessage] = useState<string | null>(null);
  const generationRunRef = useRef<AbortController | null>(null);
  const generationPreparationRef = useRef(false);
  useEffect(() => () => generationRunRef.current?.abort(), []);
  const [generationQuoteState, setGenerationQuoteState] = useState<GenerationQuoteState | null>(null);
  const [generatedTakeLoadState, setGeneratedTakeLoadState] = useState<GeneratedTakeLoadState>("idle");
  const [generationPollEpoch, setGenerationPollEpoch] = useState(0);
  const [generatedTakeSummaries, setGeneratedTakeSummaries] = useState<readonly NautiloVideoGenerationTakeSummary[]>([]);
  const [generatedTakeStatuses, setGeneratedTakeStatuses] = useState<Record<string, NautiloVideoGenerationTakeStatus>>({});
  const [generatedTakeUnavailableIds, setGeneratedTakeUnavailableIds] = useState<readonly string[]>([]);
  const [generatedTakeStatusMessage, setGeneratedTakeStatusMessage] = useState<string | null>(null);
  const generatedTakeWatching = true;
  const [generatedTakeElapsedObservations, setGeneratedTakeElapsedObservations] = useState<Record<string, GeneratedTakeElapsedObservation>>({});
  const [generatedTakeClockNowMs, setGeneratedTakeClockNowMs] = useState<number | null>(null);
  const [exportState, setExportState] = useState<VideoExportState>({ kind: "idle" });
  const [publishToWorkspace, setPublishToWorkspace] = useState(false);
  const [exportSettings, setExportSettings] = useState<VideoExportSettings>(() => normalizeVideoExportSettings(undefined)!);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [workspaceExportSupported, setWorkspaceExportSupported] = useState(false);
  const [workspaceCopyState, setWorkspaceCopyState] = useState<WorkspaceCopyState>({ kind: "idle" });
  const [workspaceCopyDestinationLabel, setWorkspaceCopyDestinationLabel] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const media = getNautiloApp()?.media;
    void Promise.resolve().then(() => media?.getExportCapabilities?.() ?? { workspace: false }).then((value) => {
      if (!active) return;
      setWorkspaceExportSupported(value.workspace);
      if (!value.workspace) setPublishToWorkspace(false);
    }).catch(() => {
      if (active) { setWorkspaceExportSupported(false); setPublishToWorkspace(false); }
    });
    return () => { active = false; };
  }, [phase]);
  useEffect(() => {
    let active = true; const media = getNautiloApp()?.media;
    void media?.getWorkspaceCopyCapabilities?.().then((value) => { if (active) setWorkspaceCopyDestinationLabel(value.available ? value.roomLabel ?? "Current Room" : null); }).catch(() => { if (active) setWorkspaceCopyDestinationLabel(null); });
    return () => { active = false; };
  }, [phase]);

  const manifestRef = useRef<VideoManifest>(createDefaultManifest());
  const projectRef = useRef<VideoProject>(project);
  const documentPathRef = useRef<string | undefined>(undefined);
  const documentEpochRef = useRef(0);
  const autosaveRef = useRef<VideoAutosave | null>(null);
  const historyRef = useRef(new VideoProjectHistory());
  const agentReceiptRef = useRef<VideoAgentReceipt | null>(null);
  const receiptPreferenceEpochRef = useRef(0);
  const selectedClipIdRef = useRef<string | null>(selectedClipId);
  const selectedClipIdsRef = useRef<ReadonlySet<string>>(selectedClipIds);
  const playheadSecRef = useRef<number>(playheadSec);
  const previewResizeSessionRef = useRef<{ previewPercent: number; dispose: () => void } | null>(null);
  const previewReadyRef = useRef(true);
  const clipboardRef = useRef<TimelineClipboard | null>(null);
  const [clipboard, setClipboard] = useState<TimelineClipboard | null>(null);
  const previewClockRef = useRef<(() => number | null) | null>(null);
  const workspaceSwitchRef = useRef<HTMLDivElement | null>(null);
  const generatedTakeSummariesRef = useRef<readonly NautiloVideoGenerationTakeSummary[]>([]);
  const exportControllerRef = useRef<AbortController | null>(null);
  const mediaImportOperationRef = useRef<MediaOperation | null>(null);
  const mediaExportOperationRef = useRef<MediaOperation | null>(null);
  const workspaceCopyControllerRef = useRef<AbortController | null>(null);
  const mediaImportRequestRef = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { mediaImportRequestRef.current = null; }, []);

  const sequence = project.sequences[0] ?? createEmptyProject().sequences[0]!;
  const savedProjectContent = autosaveRef.current?.getSavedSnapshot().content;
  const savedMediaIds = useMemo(() => {
    const parsed = savedProjectContent ? parseVideoHtml(savedProjectContent) : null;
    return new Set(parsed?.ok ? parsed.document.project.media.map((asset) => asset.id) : []);
  }, [savedProjectContent]);
  const savedReferenceKeys = useMemo(() => {
    const parsed = savedProjectContent ? parseVideoHtml(savedProjectContent) : null;
    const brief = parsed?.ok ? parsed.document.project.generationBrief : undefined;
    if (!brief) return new Set<string>();
    const shared = effectiveGenerationDirectionBlocks(brief).flatMap((block) => block.kind === "references" ? block.references ?? [] : []);
    return new Set([...shared, ...brief.shots.flatMap((shot) => shot.references)].map((reference) => JSON.stringify([reference.id, reference.source])));
  }, [savedProjectContent]);
  const selectedClip = useMemo(() => findClip(sequence, selectedClipId ?? "")?.clip ?? null, [sequence, selectedClipId]);
  const [selectedFade, setSelectedFade] = useState<{ clipId: string; key: FadeKey } | null>(null);
  const [selectedTransition, setSelectedTransition] = useState<{ clipId: string; kind: TransitionKind } | null>(null);
  const durationSec = useMemo(() => Math.max(sequence.durationSec, computeSequenceDurationSec(sequence)), [sequence]);
  const rangeStartSec = Math.min(durationSec, Math.max(0, Math.min(timelineRange.inSec, timelineRange.outSec)));
  const rangeEndSec = Math.min(durationSec, Math.max(rangeStartSec, Math.max(timelineRange.inSec, timelineRange.outSec)));
  const rangePlayback = rangeEndSec > rangeStartSec;
  const playbackStartSec = rangePlayback ? rangeStartSec : 0;
  const playbackEndSec = rangePlayback ? rangeEndSec : durationSec;
  const handleTimelineRangeChange = useCallback((next: TimelineRange) => {
    setTimelineRange(next);
    if (next.inSec === next.outSec) return;
    setPlaying(false);
    const start = Math.min(durationSec, Math.max(0, Math.min(next.inSec, next.outSec)));
    const end = Math.min(durationSec, Math.max(start, Math.max(next.inSec, next.outSec)));
    const position = Math.max(start, Math.min(end, playheadSecRef.current));
    playheadSecRef.current = position;
    setPlayheadSec(position);
  }, [durationSec]);
  useEffect(() => {
    setTimelineRange((current) => {
      const inSec = Math.min(durationSec, current.inSec);
      const outSec = Math.min(durationSec, current.outSec);
      return inSec === current.inSec && outSec === current.outSec ? current : { inSec, outSec };
    });
  }, [durationSec]);
  // OUT is exclusive: retain the last selected frame instead of showing the
  // first frame beyond the selection when transport stops at the boundary.
  const previewTimeSec = rangePlayback && playheadSec >= playbackEndSec
    ? Math.max(playbackStartSec, playbackEndSec - sequence.frameRate.denominator / sequence.frameRate.numerator)
    : playheadSec;
  const hasTimelineClips = useMemo(() => sequence.tracks.some((track) => track.clips.length > 0), [sequence.tracks]);
  const scrubberMaxSec = durationSec;
  const scrubberStepSec = sequence.frameRate.denominator / sequence.frameRate.numerator;
  const projectPanelOpen = isPanelOpen(layout, "project", isNarrowViewport);
  const propertiesPanelOpen = isPanelOpen(layout, "properties", isNarrowViewport);

  useEffect(() => {
    if (!focusCreatedTextRef.current || !propertiesPanelOpen || !selectedClip) return;
    focusCreatedTextRef.current = false;
    document.querySelector<HTMLTextAreaElement>('[aria-label="Clip text"]')?.focus();
  }, [propertiesPanelOpen, selectedClip]);
  const generatedTakeDisplaySummaries = useMemo(
    () => mergeGeneratedTakeSummaries(generatedTakeSummaries, project.generatedTakes),
    [generatedTakeSummaries, project.generatedTakes],
  );
  const hasActiveGeneratedTake = useMemo(
    () => Object.entries(generatedTakeStatuses).some(([takeId, status]) => !generatedTakeUnavailableIds.includes(takeId) && generatedTakeProgressPresentation(status)?.isActive === true),
    [generatedTakeStatuses, generatedTakeUnavailableIds],
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const syncTheme = () => setTheme(getHostTheme());
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media?.addEventListener("change", syncTheme);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", syncTheme);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return;
    const syncViewport = () => {
      setIsNarrowViewport(media.matches);
      if (!media.matches) setLayout(clearNarrowDrawer);
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  // Keep the latest selection/playhead in refs so long-lived bridge/autosave
  // subscriptions read current values without re-subscribing on every change.
  useEffect(() => {
    selectedClipIdRef.current = selectedClipId;
  }, [selectedClipId]);
  useEffect(() => {
    selectedClipIdsRef.current = selectedClipIds;
  }, [selectedClipIds]);
  useEffect(() => {
    playheadSecRef.current = playheadSec;
  }, [playheadSec]);
  useEffect(() => {
    generatedTakeSummariesRef.current = generatedTakeSummaries;
  }, [generatedTakeSummaries]);
  const publishContext = useCallback((nextProject: VideoProject, nextSelectedClipId: string | null, nextPlayheadSec: number) => {
    const state = autosaveRef.current?.getState() ?? INITIAL_AUTOSAVE_STATE;
    const summary = buildVideoContextSummary({
      ...(documentPathRef.current ? { documentPath: documentPathRef.current } : {}),
      project: nextProject,
      selectedClipId: nextSelectedClipId,
      selectedClipIds: [...selectedClipIdsRef.current],
      range: timelineRangeRef.current,
      savedVersion: autosaveRef.current?.getSavedDocumentIdentity() ?? null,
      playheadSec: nextPlayheadSec,
      dirty: state.dirty,
      lastSavedAt: state.lastSavedAt,
    });
    setContextSummary(summary);
    getNautiloApp()?.context.set(summary);
  }, []);

  // Range/multi-selection changes are transient, but must reach Genie even
  // while playback is paused. They never create a document/history write.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    publishContext(projectRef.current, selectedClipIdRef.current, playheadSecRef.current);
  }, [timelineRange, selectedClipIds, publishContext, phase.kind]);

  const applyDocument = useCallback(
    (
      document: { manifest: VideoManifest; project: VideoProject },
      envelope?: NautiloDocumentEnvelope,
      stableContent?: string,
    ) => {
      documentEpochRef.current += 1;
      mediaImportRequestRef.current = null;
      if (mediaOperationActive(mediaImportOperationRef.current)) mediaImportOperationRef.current = { ...mediaImportOperationRef.current!, stage: "unknown", code: "document_changed", stateChanged: "unknown" };
      setMediaImportBusy(false);
      setPendingVideoImport(null);
      manifestRef.current = document.manifest;
      projectRef.current = document.project;
      if (envelope?.path) {
        if (envelope.path !== documentPathRef.current) { clipboardRef.current = null; setClipboard(null); }
        documentPathRef.current = envelope.path;
      }
      setProject(document.project);
      setSelectedClipId(null);
      setSelectedClipIds(new Set());
      setCommandError(null);
      setGenerationReview(null);
      setGenerationQuoteState(null);
      historyRef.current.clear();
      agentReceiptRef.current = null;
      setAgentReceipt(null);
      setReceiptReverted(false);
      setHistoryState(historyRef.current.getState());
      const content = stableContent ?? serializeVideoHtml(document.manifest, document.project);
      autosaveRef.current?.markInitialLoad(content, envelope?.baseSha256 ?? null, envelope?.baseRevision ?? null);
      publishContext(document.project, null, playheadSecRef.current);
    },
    [publishContext],
  );

  const commitProject = useCallback(
    (nextProject: VideoProject, nextSelectedClipId = selectedClipIdRef.current, recordHistory = true, preserveSelection = false) => {
      // Serialize/validate before changing refs or visible state. A malformed
      // command result must fail as one atomic non-edit, never an invalid
      // in-memory project waiting to fail at autosave time.
      const content = serializeVideoHtml(manifestRef.current, nextProject);
      if (recordHistory) {
        historyRef.current.record(projectRef.current, nextProject);
        setHistoryState(historyRef.current.getState());
      }
      projectRef.current = nextProject;
      setProject(nextProject);
      if (!preserveSelection) {
        setSelectedClipId(nextSelectedClipId);
        setSelectedClipIds(nextSelectedClipId ? new Set([nextSelectedClipId]) : new Set());
        setCommandError(null);
      }
      autosaveRef.current?.notifyChange(content);
      publishContext(nextProject, nextSelectedClipId, playheadSecRef.current);
    },
    [publishContext],
  );

  const applyHistory = useCallback((direction: "undo" | "redo") => {
    const result = direction === "undo"
      ? historyRef.current.undo(projectRef.current)
      : historyRef.current.redo(projectRef.current);
    setHistoryState(historyRef.current.getState());
    if (!result.ok) {
      setCommandError(result.reason);
      return;
    }
    const selected = selectedClipIdRef.current;
    const retainedSelection = selected && result.project.sequences[0] && findClip(result.project.sequences[0], selected) ? selected : null;
    commitProject(result.project, retainedSelection, false);
  }, [commitProject]);

  const performClipboardAction = useCallback((action: TimelineClipboardAction, range: TimelineRange): boolean => {
    const current = projectRef.current;
    const selection = { range, clipIds: [...selectedClipIdsRef.current] };
    const copied = action === "copy" || action === "cut" ? copyTimelineSelection(current, selection) : null;
    if (copied && !copied.ok) { setCommandError(copied.error); return false; }
    if (action === "copy" && copied?.ok) {
      clipboardRef.current = copied.clipboard; setClipboard(copied.clipboard); setCommandError(null); return true;
    }
    if (action === "paste" && !clipboardRef.current) { setCommandError("Copy or cut a timeline selection first. This clipboard belongs to the open project."); return false; }
    const result = action === "paste" ? pasteTimelineClipboard(current, clipboardRef.current!, playheadSecRef.current) : removeTimelineSelection(current, selection);
    if (!result.ok) { setCommandError(result.error); return false; }
    const oldIds = new Set(current.sequences[0]!.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    const pastedIds = action === "paste" ? result.project.sequences[0]!.tracks.flatMap((track) => track.clips.filter((clip) => !oldIds.has(clip.id)).map((clip) => clip.id)) : [];
    try { commitProject(result.project, pastedIds[0] ?? null); }
    catch { setCommandError("This edit cannot be saved in the current project format. Nothing was changed; the previous clipboard is retained."); return false; }
    setPlaying(false);
    selectedClipIdRef.current = pastedIds[0] ?? null;
    selectedClipIdsRef.current = new Set(pastedIds);
    setSelectedClipIds(new Set(pastedIds));
    if (action === "cut" && copied?.ok) { clipboardRef.current = copied.clipboard; setClipboard(copied.clipboard); }
    return true;
  }, [commitProject]);

  const revertAgentEdit = useCallback(() => {
    const receipt = agentReceiptRef.current;
    const autosave = autosaveRef.current;
    if (!receipt || !autosave) return;
    if (autosave.getState().status === "conflict") {
      setCommandError("Resolve the unsaved edit conflict before reverting a Genie edit. Your draft has not been discarded.");
      return;
    }
    const result = revertVideoAgentReceipt(receipt, projectRef.current, manifestRef.current);
    if (!result.ok) { setCommandError(result.reason); return; }
    const selected = selectedClipIdRef.current;
    const retained = selected && result.project.sequences[0] && findClip(result.project.sequences[0], selected) ? selected : null;
    try {
      commitProject(result.project, retained, false);
    } catch (error) {
      setCommandError(`Revert could not be applied: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Consume synchronously, before another click. Save/conflict status remains
    // visible; applying an inverse locally is not a claim that it was persisted.
    agentReceiptRef.current = null;
    setReceiptReverted(true);
  }, [commitProject]);

  useEffect(() => {
    const preferences = getNautiloApp()?.preferences;
    if (!preferences) return;
    let active = true;
    const epoch = receiptPreferenceEpochRef.current;
    const apply = (value: { enabled?: unknown }) => {
      if (active && typeof value?.enabled === "boolean") setReceiptsEnabled(value.enabled);
    };
    const unsubscribe = preferences.subscribe<{ enabled?: unknown }>("video.agentReceipts", (value) => { receiptPreferenceEpochRef.current += 1; apply(value); });
    void preferences.get<{ enabled?: unknown }>("video.agentReceipts").then((value) => { if (epoch === receiptPreferenceEpochRef.current) apply(value); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);

  const toggleReceiptNotices = useCallback(async () => {
    const enabled = !receiptsEnabled;
    receiptPreferenceEpochRef.current += 1;
    setReceiptsEnabled(enabled);
    setReceiptPreferenceMessage(null);
    const preferences = getNautiloApp()?.preferences;
    if (!preferences) { setReceiptPreferenceMessage("Notice preference applies to this session only."); return; }
    setReceiptPreferenceBusy(true);
    try { await preferences.set("video.agentReceipts", { enabled }); }
    catch { setReceiptPreferenceMessage("Notice preference applies to this session only; it could not be saved on this device."); }
    finally { setReceiptPreferenceBusy(false); }
  }, [receiptsEnabled]);

  const handlePreviewReadyChange = useCallback((ready: boolean) => {
    previewReadyRef.current = ready;
  }, []);

  const handleExportVideo = useCallback(async (workspaceChoice = publishToWorkspace, requestedSettings: VideoExportSettings = exportSettings) => {
    if (exportControllerRef.current) return;
    const settings = normalizeVideoExportSettings(requestedSettings);
    if (!settings) { setExportState({ kind: "failed", message: "Choose valid export settings before exporting." }); return; }
    const bridge = getNautiloApp();
    const document = autosaveRef.current?.getSavedDocumentIdentity();
    if (!bridge?.media || !document || !documentPathRef.current || autosaveRef.current?.getState().dirty) {
      setExportState({ kind: "failed", message: "Save this video before exporting." });
      return;
    }
    const controller = new AbortController();
    exportControllerRef.current = controller;
    const operation = newMediaOperation("export");
    operation.exportSettings = settings;
    mediaExportOperationRef.current = operation;
    const updateOperation = (patch: Partial<MediaOperation>) => { if (mediaExportOperationRef.current?.id === operation.id) mediaExportOperationRef.current = { ...mediaExportOperationRef.current, ...patch }; };
    setExportState({ kind: "active", message: "Preparing the saved snapshot for export…" });
    try {
      const result = await bridge.media.exportVideo({ document, publishToWorkspace: workspaceChoice, exportSettings: settings }, {
        signal: controller.signal,
        onProgress: (progress) => { updateOperation({ stage: progress.stage, ...(progress.processedTimeUs !== undefined ? { processedTimeUs: progress.processedTimeUs } : {}) }); setExportState({
          kind: "active",
          message: progress.stage === "rendering" ? "Rendering the saved snapshot…" : progress.stage === "saving" ? "Saving MP4…" : progress.stage === "publishing" ? "Saving to Workspace…" : "Preparing the saved snapshot for export…",
          ...(progress.processedTimeUs !== undefined ? { processedTimeUs: progress.processedTimeUs } : {}),
        }); },
      });
      if (result.kind === "succeeded") {
        updateOperation({ stage: "succeeded", stateChanged: true, label: result.label, sizeBytes: result.sizeBytes, ...(result.workspace ? { workspace: result.workspace } : {}) });
        const local = `Saved ${result.label} to your computer (${(result.sizeBytes / 1_048_576).toFixed(1)} MB).`;
        const workspace = result.workspace?.status === "published"
          ? ` Also saved to Workspace at ${result.workspace.path}.`
          : result.workspace?.status === "not_published"
            ? " Local copy is safe. Workspace copy was not published."
            : result.workspace?.status === "unknown"
              ? ` Local copy is safe. Check ${result.workspace.path} in Workspace before retrying.`
              : workspaceChoice
                ? " Local copy is safe. Workspace publication was not confirmed; check Workspace before retrying."
                : "";
        setExportState({ kind: "complete", message: `${local}${workspace}` });
      } else if (result.kind === "cancelled") {
        updateOperation({ stage: "cancelled", stateChanged: "unknown" });
        setExportState({ kind: "idle" });
      } else {
        updateOperation({ stage: "failed", code: /^[a-z0-9_]+$/u.test(result.code) ? result.code : "export_unavailable", stateChanged: "unknown" });
        const message = result.code === "workspace_media_unsupported"
          ? "This export path does not yet support the project's mix of local and Workspace media. No MP4 was saved."
          : result.code === "document_changed"
            ? "The saved video changed while export was starting. Review the latest version and export again."
          : result.code === "source_unavailable" || result.code === "source_changed"
            ? "An original media file is missing, changed, or unreadable. Restore the original file and try again."
          : result.code === "workspace_publication_unsupported"
            ? "Saving to Workspace is available only for a bound Workspace video. Your local export was not started."
          : result.code === "unsupported_environment"
            ? "Open this project in the latest Nautilo Desktop to save an MP4."
          : result.code === "export_settings_unsupported"
            ? "Update Nautilo Desktop to export with these resolution and quality settings. No MP4 was saved."
          : result.code === "not_signed_in"
            ? "Sign in again to download this project's media, then export again."
          : result.code === "unsupported_synthetic_clip"
            ? "This timeline contains a synthetic clip that local MP4 export does not support yet."
          : result.code === "text_overflow"
            ? "Text does not fit in the frame. Shorten it or split it into more clips, save, and export again. No MP4 was saved."
          : result.code === "unsupported_props"
            ? "A clip uses styling or an effect that export does not support. Remove that property before exporting; no MP4 was saved."
            : result.code === "destination_exists"
              ? "That file now exists. Choose a new export name and try again."
              : result.code === "destination_filesystem_unsupported"
                ? "This drive cannot safely publish the export without risking an overwrite. Choose another destination."
            : `Video export is unavailable (${result.code}).`;
        setExportState({ kind: "failed", message });
      }
    } catch (error) {
      updateOperation({ stage: "unknown", code: "export_unconfirmed", stateChanged: "unknown" });
      if (controller.signal.aborted) setExportState({ kind: "idle" });
      else setExportState({ kind: "failed", message: error instanceof Error ? error.message : "Video export failed." });
    } finally {
      if (exportControllerRef.current === controller) exportControllerRef.current = null;
    }
  }, [publishToWorkspace, exportSettings]);

  const handleSaveWorkspaceCopy = useCallback(async () => {
    if (workspaceCopyControllerRef.current) return;
    const media = getNautiloApp()?.media; const autosave = autosaveRef.current;
    if (!media?.saveWorkspaceCopy || !autosave || !documentPathRef.current) { setWorkspaceCopyState({ kind: "failed", message: "Workspace copy is unavailable in this host." }); return; }
    const controller = new AbortController(); workspaceCopyControllerRef.current = controller;
    setWorkspaceCopyState({ kind: "active", message: "Saving the current draft first…" });
    try {
      await autosave.flush();
      if (controller.signal.aborted) { setWorkspaceCopyState({ kind: "failed", message: "Workspace copy cancelled. Your Current Folder project is unchanged." }); return; }
      const saved = autosave.getSavedDocumentIdentity();
      if (!saved || autosave.getState().dirty || autosave.getState().status === "failed" || autosave.getState().status === "conflict") {
        setWorkspaceCopyState({ kind: "failed", message: "Resolve the save problem before creating a Workspace copy." }); return;
      }
      const result = await media.saveWorkspaceCopy({ sha256: saved.sha256 }, { signal: controller.signal,
        onProgress: (progress) => setWorkspaceCopyState({ kind: "active", message: progress.stage === "uploading_media"
          ? `Saving media to Workspace${progress.total ? ` (${progress.completed ?? 0}/${progress.total})` : ""}…`
          : progress.stage === "publishing_document" ? "Saving the Workspace project…" : progress.stage === "cleaning_up" ? "Cleaning up an incomplete copy…" : "Preparing the saved project…" }) });
      if (result.kind === "succeeded") setWorkspaceCopyState({ kind: "complete", canOpen: true, message: `Saved a Workspace copy in ${result.roomLabel} at ${result.path}. Your Current Folder project is unchanged.` });
      else if (result.kind === "cancelled") setWorkspaceCopyState({ kind: "failed", message: result.retainedPaths.length ? `Cancelled. Check these retained Workspace paths before retrying: ${result.retainedPaths.join(", ")}.` : "Workspace copy cancelled. Your Current Folder project is unchanged." });
      else if (result.kind === "unknown") setWorkspaceCopyState({ kind: "failed", message: result.code === "authority_changed"
        ? "The account, destination, or document changed while copying. A copy may already exist in the previous Workspace destination. Return to the original account and destination to check before retrying."
        : `Workspace could not confirm the copy. Do not retry blindly. Check: ${result.retainedPaths.join(", ") || "the original destination Room"}.` });
      else {
        const message = result.code === "document_changed" ? "The Current Folder project changed while the copy was being prepared. Save the current project and try again."
          : result.code === "mixed_workspace_authority_unsupported" || result.code === "workspace_generation_binding_unsupported" ? "This project already contains Workspace-linked media or generated takes. Copying those bindings into another destination is not supported yet; the original is unchanged."
          : result.code === "source_unavailable" || result.code === "source_changed" ? "An original media source is missing or changed. Restore or re-import it, then try again."
          : result.code === "unsupported_source_format" ? "One source is not a supported MP4, M4A, MP3, WAV, PNG, JPEG, or WebP file. Re-import it in a supported format."
          : result.code === "not_signed_in" ? "Sign in to Workspace, then try saving the copy again."
          : "The Workspace copy was not created. Your Current Folder project is unchanged.";
        setWorkspaceCopyState({ kind: "failed", message: result.retainedPaths.length ? `${message} Retained paths: ${result.retainedPaths.join(", ")}.` : message });
      }
    } catch (error) { setWorkspaceCopyState({ kind: "failed", message: error instanceof Error ? error.message : "Workspace copy failed." }); }
    finally { if (workspaceCopyControllerRef.current === controller) workspaceCopyControllerRef.current = null; }
  }, []);

  const openWorkspaceCopy = useCallback(async () => {
    const autosave = autosaveRef.current;
    if (!autosave || autosave.getState().dirty || autosave.getState().status === "saving" || autosave.getState().status === "conflict" || autosave.getState().status === "failed") {
      setWorkspaceCopyState({ kind: "failed", message: "Your Current Folder draft changed after the copy was made. Save another copy instead of discarding newer work." }); return;
    }
    const result = await getNautiloApp()?.media?.openWorkspaceCopy?.();
    if (!result?.opened) setWorkspaceCopyState({ kind: "failed", message: result?.code === "document_changed" ? "Your Current Folder draft changed after the copy was made. Save another copy instead of discarding newer work." : "The Workspace copy is no longer available to open." });
  }, []);

  const refreshGeneratedTakes = useCallback(async (isCurrent: () => boolean = () => true): Promise<GeneratedTakeRefreshDisposition> => {
    const bridge = getNautiloApp();
    if (!bridge?.videoGeneration) {
      if (!isCurrent()) return "terminal";
      setGeneratedTakeLoadState("unavailable");
      setGeneratedTakeStatuses({});
      setGeneratedTakeElapsedObservations({});
      setGeneratedTakeUnavailableIds((projectRef.current.generatedTakes ?? []).map((take) => take.id));
      setGeneratedTakeStatusMessage("Generated media is available only in the supported Workspace Video host.");
      return "terminal";
    }
    if (!isCurrent()) return "terminal";
    setGeneratedTakeLoadState("loading");
    setGeneratedTakeStatusMessage(null);
    try {
      const listed = await bridge.videoGeneration.listTakes();
      if (!isCurrent()) return "terminal";
      if (listed.kind !== "ready") {
        // A present Workspace bridge can briefly lose its five-minute
        // attestation while the parent reissues it. Retain current cards and
        // status text, disable their actions, then make a bounded retry.
        setGeneratedTakeUnavailableIds([
          ...new Set([
            ...generatedTakeSummariesRef.current.map((take) => take.takeId),
            ...(projectRef.current.generatedTakes ?? []).map((take) => take.id),
          ]),
        ]);
        setGeneratedTakeLoadState(generatedTakeLoadStateAfterRetry());
        setGeneratedTakeStatusMessage("Generated media is reconnecting. Existing candidates remain unchanged.");
        return "retry";
      }
      // The status list is bounded by the server, but never fan it out as one
      // 512-request burst. Every listed take is checked; none are truncated.
      const responses: Array<{ summary: NautiloVideoGenerationTakeSummary; result: Awaited<ReturnType<NonNullable<typeof bridge.videoGeneration>["getTakeStatus"]>> }> = [];
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < listed.takes.length && isCurrent()) {
          const index = nextIndex++;
          const summary = listed.takes[index]!;
          const result = await bridge.videoGeneration!.getTakeStatus({ takeId: summary.takeId }).catch(() => ({ kind: "unavailable" as const, code: "unavailable" }));
          responses[index] = { summary, result };
        }
      };
      await Promise.all(Array.from({ length: Math.min(GENERATED_TAKE_STATUS_CONCURRENCY, listed.takes.length) }, () => worker()));
      if (!isCurrent()) return "terminal";
      const nextStatuses: Record<string, NautiloVideoGenerationTakeStatus> = {};
      const newlyAdmitted: GeneratedTake[] = [];
      const unavailableIds: string[] = [];
      let admissionProblem: string | null = null;
      for (const { summary, result } of responses) {
        if (result.kind !== "ready") {
          unavailableIds.push(summary.takeId);
          continue;
        }
        nextStatuses[summary.takeId] = result.status;
        const candidate = generatedTakeFromArtifactReadyStatus(summary, result.status);
        if (["ready", "cleanup-pending"].includes(result.status.state) && !candidate) {
          admissionProblem ??= `A ready take could not be recorded safely. Refresh it before adding it to Edit.`;
          continue;
        }
        if (candidate) newlyAdmitted.push(candidate);
      }
      const revalidations: GeneratedTakeRevalidation[] = [];
      for (const candidate of newlyAdmitted) {
        if (!isCurrent()) return "terminal";
        if (projectRef.current.media.some((asset) => asset.source?.kind === "workspace-artifact" && asset.source.artifactId === candidate.artifact.artifactId)) continue;
        const result = await bridge.videoGeneration.revalidateTake({ takeId: candidate.id }).catch(() => null);
        if (result && !("kind" in result) && result.status === "ready") revalidations.push(result);
        else {
          unavailableIds.push(candidate.id);
          admissionProblem ??= "Generated media is saved. Reconnecting its Media Bin preview…";
        }
      }
      if (!isCurrent()) return "terminal";
      const current = projectRef.current;
      const existing = current.generatedTakes ?? [];
      const admitted = admitGeneratedTakeCandidates(existing, newlyAdmitted);
      const nextTakes = admitted.takes;
      if (admitted.rejectedCount > 0) {
        admissionProblem ??= "Some ready takes could not be recorded because their Workspace lineage conflicts with this project's safe candidate limit. Your project was not changed for those takes.";
      }
      const listedIds = new Set(listed.takes.map((take) => take.takeId));
      for (const take of existing) {
        if (!listedIds.has(take.id)) unavailableIds.push(take.id);
      }
      if (!isCurrent()) return "terminal";
      let nextProject = nextTakes.length !== existing.length ? { ...current, generatedTakes: nextTakes } : current;
      for (const revalidation of revalidations) {
        const result = admitGeneratedTakeMedia(nextProject, revalidation);
        if (result.ok) nextProject = result.project;
        else admissionProblem ??= result.error;
      }
      if (nextProject !== current) {
        // One ordinary project transaction admits all newly-ready candidates;
        // `commitProject` is also the sole autosave path for this mutation.
        commitProject(nextProject, selectedClipIdRef.current, false, true);
      }
      generatedTakeSummariesRef.current = listed.takes;
      setGeneratedTakeSummaries(listed.takes);
      // A temporary status read must not erase the last useful card. Its id
      // stays unavailable until a later parent-owned read succeeds.
      setGeneratedTakeStatuses((prior) => ({ ...prior, ...nextStatuses }));
      const observedAtMs = Date.now();
      setGeneratedTakeElapsedObservations((prior) => {
        const next = { ...prior };
        for (const [takeId, status] of Object.entries(nextStatuses)) {
          if (generatedTakeProgressPresentation(status)?.isActive !== true) {
            delete next[takeId];
            continue;
          }
          const observation = reconcileGeneratedTakeElapsedObservation(prior[takeId], status.progress?.elapsedSeconds, observedAtMs);
          if (observation) next[takeId] = observation;
        }
        return next;
      });
      setGeneratedTakeUnavailableIds(unavailableIds);
      setGeneratedTakeLoadState("ready");
      setGeneratedTakeStatusMessage(admissionProblem);
      if (unavailableIds.length > 0) return "retry";
      return Object.values(nextStatuses).some((status) => !["ready", "needs-action", "failed", "unknown", "cleanup-pending"].includes(status.state)) ? "active" : "terminal";
    } catch {
      if (!isCurrent()) return "terminal";
      setGeneratedTakeUnavailableIds([
        ...new Set([
          ...generatedTakeSummariesRef.current.map((take) => take.takeId),
          ...(projectRef.current.generatedTakes ?? []).map((take) => take.id),
        ]),
      ]);
      setGeneratedTakeLoadState(generatedTakeLoadStateAfterRetry());
      setGeneratedTakeStatusMessage("Generated media is reconnecting. Existing candidates remain unchanged.");
      return "retry";
    }
  }, [commitProject]);

  const mutateGenerationBrief = useCallback((mutate: (brief: GenerationBrief) => GenerationBrief) => {
    try {
      const current = projectRef.current;
      const nextBrief = mutate(current.generationBrief ?? createEmptyGenerationBrief());
      setGenerationReview(null);
      setGenerationQuoteState(null);
      commitProject({ ...current, generationBrief: nextBrief });
      return nextBrief;
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "That generation direction could not be saved.");
      return null;
    }
  }, [commitProject]);

  const openGenerateWorkspace = useCallback(() => {
    // Workspace navigation is deliberately view-only. The canonical brief is
    // created only by the first actual field or shot mutation.
    setWorkspace("generate");
  }, []);

  const returnToEditWorkspace = useCallback(() => {
    setWorkspace("edit");
    window.requestAnimationFrame(() => {
      workspaceSwitchRef.current?.querySelector<HTMLButtonElement>('[data-workspace="edit"]')?.focus();
    });
  }, []);

  const toggleFullWidth = useCallback(() => {
    // The Video app owns only its two columns and their exact restoration.
    // The optional parent bridge owns Genie-rail visibility/focus; absence is
    // deliberately harmless on older or non-first-party hosts.
    const enabled = !layout.focusSnapshot;
    setLayout(toggleFocus);
    void getNautiloApp()?.hostLayout?.setFullWidth({ enabled });
  }, [layout.focusSnapshot]);

  useEffect(() => {
    // Media admission is project behavior, not a Generate-tab affordance.
    if (phase.kind !== "ready" || !getNautiloApp()?.videoGeneration) return;
    let cancelled = false;
    let timer: number | null = null;
    let retryAttempts = 0;
    let running = false;
    const poll = async () => {
      if (running || cancelled) return;
      running = true;
      const disposition = await refreshGeneratedTakes(() => !cancelled);
      running = false;
      const next = nextGeneratedTakePollState(disposition, retryAttempts);
      retryAttempts = next.retryAttempts;
      if (!cancelled && disposition === "retry" && !next.shouldPoll) {
        setGeneratedTakeStatusMessage("Updates paused. Reconnect generated media to check your existing takes. No new generation will start.");
      }
      if (!cancelled && (next.shouldPoll || disposition === "terminal")) timer = window.setTimeout(() => void poll(), GENERATED_TAKE_POLL_INTERVAL_MS);
    };
    const reconnect = () => {
      if (timer !== null) window.clearTimeout(timer);
      retryAttempts = 0;
      void poll();
    };
    const visibleAgain = () => { if (!document.hidden) reconnect(); };
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    document.addEventListener("visibilitychange", visibleAgain);
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      document.removeEventListener("visibilitychange", visibleAgain);
    };
  }, [phase.kind, refreshGeneratedTakes, generationPollEpoch]);

  // One local, display-only ticker serves every active candidate. It is
  // anchored to safe provider observations and never changes the durable job.
  useEffect(() => {
    const clockActive = workspace === "generate" && generatedTakeWatching && hasActiveGeneratedTake;
    if (!clockActive) {
      setGeneratedTakeClockNowMs(null);
      return;
    }
    const tick = () => setGeneratedTakeClockNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [generatedTakeWatching, hasActiveGeneratedTake, workspace]);

  const clearGenerationReview = useCallback(() => {
    setGenerationReview(null);
    setGenerationQuoteState(null);
  }, []);

  const reviewGenerationPlan = useCallback(async (shotIds?: string[], override?: { modelId: VideoGenerationCatalogModelId; settings: VideoGenerationRequestedSettings }) => {
    if (generationPreparationRef.current || generationRunRef.current) return;
    const autosave = autosaveRef.current;
    if (!autosave) {
      setCommandError("Generation review requires a saved bound video document.");
      return;
    }
    generationPreparationRef.current = true;
    setGenerationReviewBusy(true);
    clearGenerationReview();
    try {
      await autosave.saveNow();
      const autosaveState = autosave.getState();
      const document = autosave.getSavedDocumentIdentity();
      if (!document || autosaveState.dirty || autosaveState.status === "conflict" || autosaveState.status === "failed") {
        setCommandError("Save or resolve this video document before reviewing a generation plan.");
        return;
      }
      const source = shotIds?.length ? { kind: "shot" as const, shotId: shotIds[0]! } : { kind: "quick-brief" as const };
      const selectedModel = override?.modelId ?? generationModelId;
      const selectedSettings = override?.settings ?? generationSettings;
      if (!source) {
        setCommandError("Choose exactly one shot before reviewing its generation plan.");
        return;
      }
      const intent: VideoGenerationPlanIntentV1 = {
        version: VIDEO_GENERATION_PLAN_VERSION,
        document,
        scope: source.kind === "quick-brief" ? { kind: "quick-brief" } : { kind: "shots", shotIds: (shotIds?.length ? shotIds : [source.shotId]) as [string, ...string[]] },
        jobs: (shotIds?.length ? shotIds.map((shotId) => ({ source: { kind: "shot" as const, shotId }, modelId: selectedModel, settings: generationSettingsForSource(projectRef.current.generationBrief ?? createEmptyGenerationBrief(), { kind: "shot", shotId }, selectedSettings) })) : [{ source, modelId: selectedModel, settings: selectedSettings }]) as VideoGenerationPlanIntentV1["jobs"],
      };
      const draft = await buildVideoGenerationPlanDraft(projectRef.current.generationBrief ?? createEmptyGenerationBrief(), intent, { media: projectRef.current.media, allowPendingContinuation: true });
      if (!sameSavedDocumentIdentity(autosave.getSavedDocumentIdentity(), document) || autosave.getState().dirty) {
        setCommandError("The direction changed during review. Review the current saved document again.");
        return;
      }
      setGenerationReview({ document, draft });
      return { document, draft };
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "The generation plan could not be reviewed.");
    } finally {
      generationPreparationRef.current = false;
      setGenerationReviewBusy(false);
    }
    return undefined;
  }, [clearGenerationReview, generationModelId, generationSettings]);

  const getExactGenerationQuote = useCallback(async (review: GenerationReview | null = generationReview, selectedContinuationTakeId?: string) => {
    if (!review || review.draft.status !== "ready-for-quote" || generationRunRef.current) return;
    const autosave = autosaveRef.current;
    const generation = getNautiloApp()?.videoGeneration;
    if (!generation) { setGenerationQuoteState("unavailable"); return; }
    if (!autosave || !sameSavedDocumentIdentity(autosave.getSavedDocumentIdentity(), review.document) || autosave.getState().dirty) {
      clearGenerationReview();
      setCommandError("The direction changed. Generate again to review the current saved version.");
      return;
    }
    const briefSnapshot = JSON.stringify(projectRef.current.generationBrief ?? createEmptyGenerationBrief());
    const completedSceneTakes = new Map<string, string>();
    const controller = new AbortController();
    generationRunRef.current = controller;
    setGenerationReviewBusy(true);
    try {
      const result = await runGenerationSequence({
        sources: review.draft.jobs.map((job) => job.source),
        signal: controller.signal,
        onProgress: setGenerationRunMessage,
        prepare: async (source) => {
          const originalJob = review.draft.jobs.find((job) => JSON.stringify(job.source) === JSON.stringify(source));
          if (!originalJob) throw new Error("The selected scene is no longer in this plan.");
          await autosave.saveNow();
          const document = autosave.getSavedDocumentIdentity();
          const state = autosave.getState();
          if (!document || state.dirty || state.status === "conflict" || state.status === "failed" ||
              JSON.stringify(projectRef.current.generationBrief ?? createEmptyGenerationBrief()) !== briefSnapshot) {
            throw new Error("The direction changed or could not be saved. Review it again.");
          }
          const currentBrief = projectRef.current.generationBrief ?? createEmptyGenerationBrief();
          const sceneIndex = source.kind === "shot" ? currentBrief.shots.findIndex(shot => shot.id === source.shotId) : -1;
          const scene = currentBrief.shots[sceneIndex];
          let continuationTakeId: string | undefined;
          let previousSceneVideo: import("./generation-brief").GenerationReference | undefined;
          if (scene?.continueFromPrevious) {
            const previous = currentBrief.shots[sceneIndex - 1];
            if (!previous) throw new Error("The opening scene cannot continue from a previous scene. Turn off continuity or move it later.");
            continuationTakeId = selectedContinuationTakeId ?? completedSceneTakes.get(previous.id) ?? [...(projectRef.current.generatedTakes ?? [])]
              .filter(take => take.shotId === previous.id && take.mediaKind === "video").sort((a, b) => b.briefRevision - a.briefRevision)[0]?.id;
            if (!continuationTakeId) throw new Error("Generate the previous scene first, then continue this scene.");
            const validated = await generation.revalidateTake({ takeId: continuationTakeId });
            if (!("status" in validated) || validated.status !== "ready" || validated.take.shotId !== previous.id || validated.take.artifact.mime !== "video/mp4") throw new Error("The previous scene's media is unavailable. Restore it or generate that scene first.");
            const artifact = validated.take.artifact;
            previousSceneVideo = { id: "previous-scene", name: "Previous scene", mediaKind: "video",
              source: { kind: "workspace-artifact", artifactId: artifact.artifactId, path: artifact.path, mimeType: artifact.mime, sizeBytes: artifact.bytes } };
          }
          // Media admission and ordinary timeline edits may advance the saved
          // revision. Recompile against that exact version, never a stale quote.
          const draft = await buildVideoGenerationPlanDraft(projectRef.current.generationBrief ?? createEmptyGenerationBrief(), {
            version: VIDEO_GENERATION_PLAN_VERSION, document,
            scope: source.kind === "shot" ? { kind: "shots", shotIds: [source.shotId] } : { kind: "quick-brief" },
            jobs: [{ source, modelId: originalJob.catalogModelId, settings: generationSettingsForSource(currentBrief, source, originalJob.requestedSettings) }],
          }, { media: projectRef.current.media, ...(previousSceneVideo ? { previousSceneVideo } : {}) });
          if (draft.status !== "ready-for-quote" || autosave.getState().dirty ||
              !sameSavedDocumentIdentity(autosave.getSavedDocumentIdentity(), document)) {
            throw new Error("The current scene needs a new review.");
          }
          const job = draft.jobs[0];
          if (!isSafeVideoGenerationRequestPrompt(job.prompt)) throw new Error("Add a prompt before requesting generation.");
          return { document, sourceFingerprint: draft.sourceFingerprint, job: {
            source: job.source, ...(job.source.kind === "shot" ? { shotLabel: job.title } : {}),
            modelId: job.catalogModelId, prompt: job.prompt, requestedSettings: job.requestedSettings,
            ...(continuationTakeId ? { continuationTakeId } : {}),
          } };
        },
        request: async (request) => {
          const result = await generation.request(request);
          setGenerationQuoteState(result.kind);
          if (result.kind === "queued" && result.takeId && request.job.source.kind === "shot") completedSceneTakes.set(request.job.source.shotId, result.takeId);
          return result;
        },
        waitUntilReady: async (takeId, signal) => {
          while (!signal.aborted) {
            const response = await generation.getTakeStatus({ takeId });
            if (response.kind !== "ready" || response.status.takeId !== takeId) throw new Error("Generation status is unavailable. Check this scene's takes before trying again.");
            const status = response.status;
            if ((status.state === "ready" || status.state === "cleanup-pending") && status.artifact) {
              await refreshGeneratedTakes(() => !signal.aborted);
              return;
            }
            if (["failed", "unknown", "needs-action"].includes(status.state)) throw new Error(status.failure?.message ?? "This scene needs attention.");
            await new Promise<void>((resolve) => {
              const finish = () => { window.clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
              const timer = window.setTimeout(finish, GENERATED_TAKE_POLL_INTERVAL_MS);
              signal.addEventListener("abort", finish, { once: true });
              if (signal.aborted) finish();
            });
          }
          throw new Error("Sequence stopped.");
        },
      });
      setGenerationRunMessage(result.message);
    } finally {
      generationRunRef.current = null;
      setGenerationReviewBusy(false);
    }
  }, [clearGenerationReview, generationReview, refreshGeneratedTakes]);

  useEffect(() => {
    if (!generationReview || !autosaveState.lastSavedAt) return;
    if (!sameSavedDocumentIdentity(autosaveRef.current?.getSavedDocumentIdentity() ?? null, generationReview.document)) {
      clearGenerationReview();
    }
  }, [autosaveState.dirty, autosaveState.lastSavedAt, autosaveState.status, clearGenerationReview, generationReview]);

  const completeVideoImport = useCallback((imported: NautiloVideoImportReady, rateDecision?: FirstSourceRateDecision) => {
    const operation = mediaImportOperationRef.current;
    const updateOperation = (patch: Partial<MediaOperation>) => { if (operation && mediaImportOperationRef.current?.id === operation.id) mediaImportOperationRef.current = { ...mediaImportOperationRef.current, ...patch }; };
    const before = projectRef.current;
    const mediaKind = imported.mediaKind ?? "video";
    const common = {
      ref: imported.mediaRef,
      label: imported.label,
      lifecycle: imported.source ? "durable" : "local-working",
      ...(imported.source ? { source: imported.source } : {}),
    } as const;
    const input: AddImportedMediaInput = mediaKind === "image"
      ? { ...common, mediaKind: "image" }
      : mediaKind === "audio"
        ? { ...common, mediaKind: "audio", durationSec: imported.durationSec as number }
        : { ...common, mediaKind: "video", durationSec: imported.durationSec as number, frameRate: imported.frameRate!, ...(rateDecision ? { rateDecision } : {}) };
    const result = admitImportedMedia(before, input);
    if (!result.ok) {
      updateOperation({ stage: "failed", code: "admission_failed", stateChanged: "unknown" });
      setMediaImportStatus(`Import was not applied: ${result.error}`);
      return;
    }
    const createdAsset = result.project.media.find((asset) => !before.media.some((existing) => existing.id === asset.id));
    if (!createdAsset) {
      updateOperation({ stage: "failed", code: "admission_failed", stateChanged: "unknown" });
      setMediaImportStatus("Import was not applied because the new Media Bin item could not be identified.");
      return;
    }
    setPendingVideoImport(null);
    setMediaImportStatus(imported.source
      ? `${createdAsset.label ?? "Media"} was added to the Media Bin. Drag it to a compatible track when you are ready.`
      : `${createdAsset.label ?? "Media"} was added to the Media Bin as a local-working Current Folder reference. Drag it to a compatible track to place it.`);
    commitProject(result.project, null);
    updateOperation({ stage: "saving", stateChanged: true, mediaId: createdAsset.id, label: createdAsset.label ?? "Media" });
    void autosaveRef.current?.saveNow().then(() => {
      const state = autosaveRef.current?.getState();
      const saved = state && !state.dirty && state.status !== "conflict" && state.status !== "failed" && projectRef.current.media.some(asset => asset.id === createdAsset.id);
      updateOperation(saved ? { stage: "succeeded" } : { stage: "failed", code: "save_required" });
    }).catch(() => updateOperation({ stage: "failed", code: "save_required" }));
  }, [commitProject]);

  const rememberFirstSourceRate = useCallback((decision: FirstSourceRateDecision | "ask") => {
    const preferences = getNautiloApp()?.preferences;
    if (!preferences) { setRatePreferenceMessage("This host cannot remember the choice. You will be asked next time."); return; }
    void preferences.set("video.firstSourceRate", { decision }).then(() => { setFirstSourceRate(decision); setRatePreferenceMessage(null); }).catch(() => setRatePreferenceMessage("Could not remember your choice. You will be asked next time."));
  }, []);

  useEffect(() => {
    const preferences = getNautiloApp()?.preferences;
    if (!preferences) return;
    let revision = 0;
    let active = true;
    const apply = (value: { decision?: unknown }) => {
      if (!active) return;
      const decision = value?.decision;
      setFirstSourceRate(decision === "keep-project-rate" || decision === "adopt-source-rate" ? decision : "ask");
    };
    const unsubscribe = preferences.subscribe<{ decision?: unknown }>("video.firstSourceRate", (value) => { revision += 1; apply(value); });
    void preferences.get<{ decision?: unknown }>("video.firstSourceRate").then((value) => { if (revision === 0) apply(value); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);

  const handleImportVideo = useCallback(() => {
    if (pendingVideoImport || mediaImportRequestRef.current || mediaOperationActive(mediaImportOperationRef.current)) return;
    const bridge = getNautiloApp();
    if (!bridge?.media) {
      setMediaImportStatus("Media import requires a supported Desktop Current Folder or Workspace host.");
      return;
    }
    setMediaImportStatus("Choosing and inspecting media…");
    const request = { cancelled: false };
    const operation = newMediaOperation("import");
    mediaImportOperationRef.current = operation;
    const updateOperation = (patch: Partial<MediaOperation>) => { if (mediaImportOperationRef.current?.id === operation.id) mediaImportOperationRef.current = { ...mediaImportOperationRef.current, ...patch }; };
    mediaImportRequestRef.current = request;
    setMediaImportBusy(true);
    void bridge.media.importVideo().then(async (result) => {
      if (mediaImportRequestRef.current !== request) return;
      if (request.cancelled) { updateOperation({ stage: "cancelled", stateChanged: "unknown" }); return; }
      if (result.kind !== "ready") {
        updateOperation({ stage: result.code === "cancelled" ? "cancelled" : "failed", code: /^[a-z0-9_]+$/u.test(result.code) ? result.code : "import_unavailable", stateChanged: "unknown" });
        setMediaImportStatus(result.code === "cancelled" ? "Import cancelled. Your project was not changed." : `Import unavailable (${result.code}). Your project was not changed.`);
        return;
      }
      if ((result.mediaKind ?? "video") === "video" && result.frameRate && requiresFirstSourceRateDecision(projectRef.current, result.frameRate)) {
        const preference = await bridge.preferences?.get<{ decision?: unknown }>("video.firstSourceRate").catch(() => undefined);
        if (mediaImportRequestRef.current !== request) return;
        if (request.cancelled) { updateOperation({ stage: "cancelled", stateChanged: "unknown" }); return; }
        if (preference?.decision === "adopt-source-rate" || preference?.decision === "keep-project-rate") {
          // Revalidate at commit against the current project; a concurrent edit
          // must never turn a remembered first-import choice into a rate change.
          completeVideoImport(result, preference.decision);
          return;
        }
        setPendingVideoImport(result as NautiloVideoImportReady & { frameRate: { numerator: number; denominator: number } });
        updateOperation({ stage: "awaiting-rate", sourceRate: result.frameRate });
        setMediaImportStatus(null);
        return;
      }
      completeVideoImport(result);
    }).catch(() => {
      if (mediaImportRequestRef.current !== request) return;
      updateOperation({ stage: "unknown", code: "import_unconfirmed", stateChanged: "unknown" });
      setMediaImportStatus("Import could not start. Your project was not changed; try again in a supported Desktop host.");
    }).finally(() => {
      if (mediaImportRequestRef.current !== request) return;
      mediaImportRequestRef.current = null;
      setMediaImportBusy(false);
    });
  }, [completeVideoImport, pendingVideoImport]);

  const cancelMediaImport = useCallback(() => {
    const operation = mediaImportOperationRef.current;
    if (!operation) return;
    if (mediaImportRequestRef.current) {
      mediaImportRequestRef.current.cancelled = true;
      mediaImportOperationRef.current = { ...operation, stage: "cancelling" };
      setMediaImportStatus("Import cancelled for this project. Close the native file chooser to finish.");
    } else if (pendingVideoImport) {
      setPendingVideoImport(null);
      mediaImportOperationRef.current = { ...operation, stage: "cancelled", stateChanged: "unknown" };
      setMediaImportStatus("Import cancelled. The media was not added to this project's Media Bin.");
    }
  }, [pendingVideoImport]);

  const loadEnvelope = useCallback(
    (envelope: NautiloDocumentEnvelope) => {
      const content = envelope.content.trim().length === 0 ? serializeVideoHtml(createDefaultManifest(), createEmptyProject()) : envelope.content;
      const parsed = parseVideoHtml(content);
      if (!parsed.ok) {
        setPhase({ kind: "invalid", message: parsed.error });
        return;
      }
      setPhase({ kind: "ready" });
      applyDocument(parsed.document, { ...envelope, content }, content);
    },
    [applyDocument],
  );

  useEffect(() => {
    const bridge = getNautiloApp();
    if (!bridge) {
      setPhase({ kind: "no-document" });
      applyDocument({ manifest: createDefaultManifest(), project: createEmptyProject() });
      return;
    }

    const autosave = new VideoAutosave(
      async (content, base) => {
        const updatedAt = new Date().toISOString();
        const captured = parseVideoHtml(content);
        if (!captured.ok) return { kind: "failed", message: captured.error };
        const saveContent = serializeVideoHtml(captured.document.manifest, captured.document.project, { touchMetadata: true, updatedAt });
        const result = bridgeWriteResult(
          await bridge.document.write(
            { content: saveContent },
            { baseSha256: base.sha256, baseRevision: base.revision },
          ),
        );
        if (result.kind !== "saved") return result;
        if (result.path) documentPathRef.current = result.path;
        return { ...result, persistedContent: result.persistedContent ?? saveContent };
      },
      async () => parseEnvelope(await bridge.document.read()),
    );
    autosaveRef.current = autosave;
    let active = true;
    let changeEpoch = 0;
    let loaded = false;
    let renamedPath: string | undefined;
    const recoverReceipt = async (epoch: number) => {
      if (!bridge.document.authoredChange) return;
      const snapshot = autosave.getSavedSnapshot();
      try {
        const change = await bridge.document.authoredChange();
        if (!active || epoch !== changeEpoch || snapshot.sha256 !== autosave.getSavedSnapshot().sha256) return;
        const receipt = recoverVideoAgentReceipt(change, snapshot.sha256, projectRef.current, manifestRef.current);
        if (!receipt || receipt.patchId === agentReceiptRef.current?.patchId) return;
        agentReceiptRef.current = receipt;
        setAgentReceipt(receipt);
        setReceiptReverted(false);
        setReceiptDismissed(false);
      } catch { /* Retained history is optional; never block the current draft. */ }
    };
    const unsubscribeAutosave = autosave.subscribe((state) => {
      setAutosaveState(state);
      const projected = parseVideoHtml(autosave.getDraftContent());
      if (projected.ok) {
        manifestRef.current = projected.document.manifest;
        if (JSON.stringify(projectRef.current) !== JSON.stringify(projected.document.project)) {
          projectRef.current = projected.document.project;
          setProject(projected.document.project);
        }
      }
      publishContext(projectRef.current, selectedClipIdRef.current, playheadSecRef.current);
    });
    const reloadFromHost = async (epoch: number) => {
      const beforeRead = autosave.getSavedSnapshot();
      const latest = parseEnvelope(await bridge.document.read());
      if (!active || epoch !== changeEpoch) return;
      if (!latest) {
        setPhase({ kind: "invalid", message: "Unexpected document envelope from host." });
        return;
      }
      if (renamedPath) latest.path = renamedPath;
      const current = autosave.getSavedSnapshot();
      if (current.sha256 !== beforeRead.sha256 || current.revision !== beforeRead.revision) {
        // A local save finished while this read was pending. Read again from
        // that baseline rather than projecting potentially older bytes.
        await reloadFromHost(epoch);
        return;
      }
      if (latest.baseRevision !== null && current.revision !== null && latest.baseRevision < current.revision) return;
      if (!loaded) { loaded = true; loadEnvelope(latest); void recoverReceipt(epoch); return; }
      const projectedContent = autosave.applyRemoteEnvelope(latest);
      const projected = parseVideoHtml(projectedContent);
      if (!projected.ok) {
        setPhase({ kind: "invalid", message: projected.error });
        return;
      }
      setPhase({ kind: "ready" });
      manifestRef.current = projected.document.manifest;
      projectRef.current = projected.document.project;
      setProject(projected.document.project);
      historyRef.current.observeExternal(projected.document.project);
      publishContext(projected.document.project, selectedClipIdRef.current, playheadSecRef.current);
      void recoverReceipt(epoch);
    };
    const unsubscribeDocumentChange = bridge.document.onChange?.((event) => {
      if (event.type === "renamed") {
        if (event.path) {
          renamedPath = event.path;
          documentPathRef.current = event.path;
          publishContext(projectRef.current, selectedClipIdRef.current, playheadSecRef.current);
        }
        return;
      }
      if (event.type === "patch_applied") {
        const previous = autosave.getSavedSnapshot();
        // Metadata and duplicate events do not cancel a needed content read.
        if (event.sha256 === previous.sha256 || (event.revision !== null && previous.revision !== null && event.revision <= previous.revision)) return;
      }
      // A chooser or first-source decision was admitted against the earlier
      // document. Do not apply its late result after an external content change.
      // An import already saving follows the normal autosave conflict path.
      if (mediaImportRequestRef.current || mediaImportOperationRef.current?.stage === "awaiting-rate") {
        mediaImportRequestRef.current = null;
        if (mediaImportOperationRef.current) mediaImportOperationRef.current = { ...mediaImportOperationRef.current, stage: "unknown", code: "document_changed", stateChanged: "unknown" };
        setMediaImportBusy(false);
        setPendingVideoImport(null);
      }
      const epoch = ++changeEpoch;
      void (async () => {
        if (event.type === "deleted") {
          setPhase({ kind: "invalid", message: "Document was deleted." });
          return;
        }
        if (event.type === "patch_applied") {
          const previous = autosave.getSavedSnapshot();
          if (previous.sha256 === event.previousSha256 && previous.revision === event.previousRevision &&
            event.envelope.baseSha256 === event.sha256 && event.envelope.baseRevision === event.revision &&
            parseVideoHtml(event.envelope.content).ok) {
            const receipt = deriveVideoAgentReceipt(event, previous);
            // This is synchronous: a second patch observes this canonical
            // predecessor, not a later asynchronous full-document reread.
            autosave.applyRemoteEnvelope(event.envelope);
            if (receipt) {
              agentReceiptRef.current = receipt;
              setAgentReceipt(receipt);
              setReceiptReverted(false);
              setReceiptDismissed(false);
            }
            return;
          }
        }
        // Missing predecessor/unattributed refresh: reconcile, never invent
        // an authored inverse from the dirty human draft or a guessed base.
        await reloadFromHost(epoch);
      })().catch((err) => {
        if (!active || epoch !== changeEpoch) return;
        setPhase({ kind: "invalid", message: err instanceof Error ? err.message : "Failed to reload changed document." });
      });
    });

    const initialEpoch = changeEpoch;
    void (async () => {
      try {
        const envelope = parseEnvelope(await bridge.document.read());
        if (!active || initialEpoch !== changeEpoch) return;
        if (!envelope) {
          setPhase({ kind: "invalid", message: "Unexpected document envelope from host." });
          return;
        }
        if (renamedPath) envelope.path = renamedPath;
        loaded = true;
        loadEnvelope(envelope);
        void recoverReceipt(initialEpoch);
      } catch (err) {
        if (!active || initialEpoch !== changeEpoch) return;
        if (isNoDocumentError(err)) {
          setPhase({ kind: "no-document" });
          applyDocument({ manifest: createDefaultManifest(), project: createEmptyProject() });
          return;
        }
        setPhase({ kind: "invalid", message: err instanceof Error ? err.message : "Failed to load document." });
      }
    })();

    return () => {
      active = false;
      unsubscribeDocumentChange?.();
      unsubscribeAutosave();
      void autosave.flush();
      autosave.destroy();
      autosaveRef.current = null;
    };
  }, [applyDocument, loadEnvelope, publishContext]);

  useEffect(() => {
    if (!playing || durationSec <= 0) return;
    let frame = 0;
    let timer = 0;
    let active = true;
    let previous = performance.now();
    // Chromium suspends animation frames in an occluded window even while its
    // native decoders keep playing. Race the visual frame with a transport
    // wake-up at the project's frame cadence; whichever fires cancels its peer.
    // This also advances silent gaps and text-only sequences offscreen.
    const schedule = () => {
      frame = window.requestAnimationFrame(tick);
      timer = window.setTimeout(() => tick(performance.now()), scrubberStepSec * 1_000);
    };
    const tick = (now: number) => {
      if (!active) return;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      const elapsedSec = Math.max(0, (now - previous) / 1_000);
      previous = now;
      if (!previewReadyRef.current) {
        schedule();
        return;
      }
      setPlayheadSec((current) => {
        const next = Math.max(playbackStartSec, Math.min(playbackEndSec, previewClockRef.current?.() ?? current + elapsedSec));
        playheadSecRef.current = next;
        publishContext(projectRef.current, selectedClipIdRef.current, next);
        if (next >= playbackEndSec) setPlaying(false);
        return next;
      });
      schedule();
    };
    schedule();
    return () => { active = false; window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [durationSec, playbackStartSec, playbackEndSec, playing, publishContext, scrubberStepSec]);

  useEffect(() => {
    if (durationSec > 0) return;
    setPlaying(false);
    setPlayheadSec(0);
  }, [durationSec]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const isEditingControl =
        event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true']");
      if (event.key === "Escape") {
        if (previewResizeSessionRef.current) return;
        if (workspace === "generate" && !isEditingControl) {
          event.preventDefault();
          returnToEditWorkspace();
          return;
        }
        if (isNarrowViewport && !isEditingControl) setLayout(clearNarrowDrawer);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void autosaveRef.current?.saveNow();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !isEditingControl) {
        event.preventDefault();
        applyHistory(event.shiftKey ? "redo" : "undo");
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyHistory, commitProject, isNarrowViewport, returnToEditWorkspace, workspace]);

  useEffect(() => {
    const onBlur = () => {
      void autosaveRef.current?.flush();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  const handleMoveClip = useCallback(
    (request: ClipMoveRequest) => {
      const found = findClip(projectRef.current.sequences[0]!, request.clipId);
      const targetTrack = projectRef.current.sequences[0]!.tracks.find((track) => track.id === request.toTrackId);
      if (!found || !targetTrack) { setCommandError("The clip or destination track changed. Try the move again."); return; }
      const group = selectedClipIdsRef.current;
      if (group.size > 1 && group.has(request.clipId)) {
        const result = moveClipGroup(projectRef.current, {
          clipIds: [...group],
          anchorClipId: request.clipId,
          toTrackId: request.toTrackId,
          timelineStartSec: request.timelineStartSec,
        });
        if (!result.ok) {
          setCommandError(result.error);
          return;
        }
        commitProject(result.project, request.clipId);
        setSelectedClipIds(new Set(group));
        return;
      }
      const result = moveClip(projectRef.current, request);
      if (result.ok) commitProject(result.project, request.clipId);
      else setCommandError(result.error);
    },
    [commitProject],
  );

  const placeMediaOnTrack = useCallback((request: { mediaId: string; trackId: string; timelineStartSec: number }) => {
    const before = projectRef.current;
    const asset = before.media.find((entry) => entry.id === request.mediaId);
    if (!asset) {
      setCommandError("That Media Bin item is no longer available.");
      return;
    }
    const durationSec = mediaPlacementDurationSec(asset);
    if (!durationSec) {
      setCommandError("This media needs a measured duration before it can be placed.");
      return;
    }
    const input: AddClipInput = {
      trackId: request.trackId,
      kind: mediaPlacementKind(asset),
      mediaId: asset.id,
      timelineStartSec: request.timelineStartSec,
      durationSec,
      sourceInSec: 0,
      sourceOutSec: durationSec,
    };
    const result = addClip(before, input);
    if (!result.ok) {
      setCommandError(result.error);
      return;
    }
    const createdClipId = findCreatedClipId(before, result.project, input);
    commitProject(result.project, createdClipId ?? null);
    setMediaImportStatus(`${asset.label ?? "Media"} was placed at ${request.timelineStartSec.toFixed(2)}s.`);
  }, [commitProject]);

  const placeMediaAtPlayhead = useCallback((mediaId: string) => {
    const before = projectRef.current;
    const asset = before.media.find((entry) => entry.id === mediaId);
    const sequence = before.sequences[0];
    if (!asset || !sequence) return;
    const durationSec = mediaPlacementDurationSec(asset);
    if (!durationSec) {
      setCommandError("This media needs a measured duration before it can be placed.");
      return;
    }
    const kind = mediaPlacementKind(asset);
    const compatibleTracks = [...sequence.tracks]
      .sort((left, right) => left.order - right.order)
      .filter((track) => isClipKindAllowedOnTrack(kind, track.kind));
    if (compatibleTracks.length === 0) {
      setCommandError(`Add a compatible ${asset.kind === "audio" ? "audio" : "visual"} track first.`);
      return;
    }
    let lastError = "No compatible track has room at the playhead.";
    for (const track of compatibleTracks) {
      const result = addClip(before, {
        trackId: track.id,
        kind,
        mediaId,
        timelineStartSec: playheadSecRef.current,
        durationSec,
        sourceInSec: 0,
        sourceOutSec: durationSec,
      });
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      const created = result.project.sequences[0]?.tracks.flatMap((entry) => entry.clips).find((clip) =>
        clip.mediaId === mediaId && !before.sequences[0]?.tracks.flatMap((entry) => entry.clips).some((existing) => existing.id === clip.id));
      commitProject(result.project, created?.id ?? null);
      setMediaImportStatus(`${asset.label ?? "Media"} was added at the playhead.`);
      return;
    }
    setCommandError(lastError);
  }, [commitProject]);

  const handleAddTrack = useCallback((kind: TrackKind) => {
    const result = addTrack(projectRef.current, { kind });
    if (result.ok) commitProject(result.project, null);
    else setCommandError(result.error);
  }, [commitProject]);

  const handleDeleteTrack = useCallback((trackId: string) => {
    const result = deleteTrack(projectRef.current, { trackId });
    if (result.ok) commitProject(result.project, null);
    else setCommandError(result.error);
  }, [commitProject]);

  const handleReorderTrack = useCallback((trackId: string, destinationIndex: number) => {
    const result = reorderTrack(projectRef.current, { trackId, destinationIndex });
    if (result.ok) commitProject(result.project, selectedClipIdRef.current);
    else setCommandError(result.error);
  }, [commitProject]);

  const handleUpdateTrack = useCallback((trackId: string, patch: Partial<Pick<VideoProject["sequences"][number]["tracks"][number], "name" | "locked" | "muted" | "hidden">>) => {
    const result = updateTrack(projectRef.current, { trackId, ...patch });
    if (result.ok) commitProject(result.project, selectedClipIdRef.current);
    else setCommandError(result.error);
  }, [commitProject]);

  const selectTimelineClip = useCallback((clipId: string | null, additive = false, preserveSelection = false) => {
    setSelectedFade(null);
    setSelectedTransition(null);
    const next = selectClipIds(selectedClipIdsRef.current, clipId, additive, preserveSelection);
    const primary = clipId !== null && next.has(clipId) ? clipId : [...next][0] ?? null;
    // A following pointer-up may arrive before effects; use the same exact set.
    selectedClipIdsRef.current = next;
    selectedClipIdRef.current = primary;
    setSelectedClipIds(next);
    setSelectedClipId(primary);
    publishContext(projectRef.current, primary, playheadSecRef.current);
  }, [publishContext]);

  const selectFade = useCallback((clipId: string, key: FadeKey) => {
    selectTimelineClip(clipId);
    setSelectedFade({ clipId, key });
    setLayout((current) => isPanelOpen(current, "properties", isNarrowViewport) ? current : togglePanelForViewport(current, "properties", isNarrowViewport));
  }, [selectTimelineClip, isNarrowViewport]);
  const editFade = useCallback((input: FadeEdit) => {
    const result = setClipFade(projectRef.current, input);
    if (!result.ok) { setCommandError(result.error); return; }
    setPlaying(false);
    commitProject(result.project, input.clipId);
    selectFade(input.clipId, input.key);
  }, [commitProject, selectFade]);
  const dropFade = useCallback((clipId: string, key: FadeKey) => {
    const found = findClip(projectRef.current.sequences[0]!, clipId);
    if (!found) { setCommandError("This clip is no longer available. Drop onto another clip; nothing was changed."); return; }
    // Re-dropping an applied fade selects its handle without resetting a custom ramp.
    if (clipFades(found.clip)[key]) { selectFade(clipId, key); return; }
    const linkedAudio = key.startsWith("video");
    const peers = linkedAudio ? projectRef.current.sequences[0]!.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === "audio" && (found.clip.linkedClipIds?.includes(clip.id) || clip.linkedClipIds?.includes(clipId))) : [];
    const durationSec = peers.reduce((duration, clip) => Math.min(duration, clip.durationSec), Math.min(1, found.clip.durationSec));
    editFade({ clipId, key, durationSec, linkedAudio });
  }, [editFade, selectFade]);

  const selectTransition = useCallback((clipId: string, kind: TransitionKind) => {
    selectTimelineClip(clipId);
    setSelectedTransition({ clipId, kind });
    setLayout((current) => isPanelOpen(current, "properties", isNarrowViewport) ? current : togglePanelForViewport(current, "properties", isNarrowViewport));
  }, [selectTimelineClip, isNarrowViewport]);
  const editTransition = useCallback((input: TransitionEdit) => {
    const result = setCutTransition(projectRef.current, input);
    if (!result.ok) { setCommandError(result.error); return; }
    setPlaying(false);
    commitProject(result.project, input.clipId);
    selectTransition(input.clipId, input.kind);
  }, [commitProject, selectTransition]);
  const dropTransition = useCallback((clipId: string, kind: TransitionKind) => {
    const target = transitionTarget(projectRef.current, clipId);
    if ("error" in target) { setCommandError(target.error); return; }
    if (target.maxDurationSec <= 0) { setCommandError("No spare footage at this cut. Trim the sources to leave handles, then bring the clips together; nothing was changed."); return; }
    const existing = clipTransition(target.incoming);
    if (existing?.kind === kind) { selectTransition(clipId, kind); return; }
    editTransition({ clipId, kind, durationSec: existing?.durationSec ?? Math.min(1, target.maxDurationSec), direction: existing?.direction ?? "left" });
  }, [editTransition, selectTransition]);

  const handleTrimLeft = useCallback(
    (request: ClipTrimLeftRequest) => {
      const found = findClip(projectRef.current.sequences[0]!, request.clipId);
      if (!found) return;
      const sourceInSec = found.clip.mediaId !== undefined
        ? (found.clip.sourceInSec ?? 0) + request.sourceDeltaSec
        : undefined;
      const trimmed = trimClip(projectRef.current, {
        clipId: request.clipId,
        timelineStartSec: request.timelineStartSec,
        durationSec: request.durationSec,
        ...(sourceInSec !== undefined ? { sourceInSec } : {}),
      });
      if (trimmed.ok) commitProject(trimmed.project, request.clipId);
      else setCommandError(trimmed.error);
    },
    [commitProject],
  );

  const handleTrimRight = useCallback(
    (request: ClipTrimRightRequest) => {
      const result = trimClip(projectRef.current, request);
      if (result.ok) commitProject(result.project, request.clipId);
      else setCommandError(result.error);
    },
    [commitProject],
  );

  const splitSelected = useCallback(() => {
    if (!selectedClipIdRef.current) return;
    const result = splitClip(projectRef.current, { clipId: selectedClipIdRef.current, atSec: playheadSecRef.current });
    if (result.ok) {
      commitProject(result.project, null);
      setLayout((current) => closePanelForViewport(current, "properties", isNarrowViewport));
    }
    else setCommandError(result.error);
  }, [commitProject, isNarrowViewport]);

  const deleteTimelineClip = useCallback((clipId: string) => {
    const result = deleteClip(projectRef.current, { clipId });
    if (result.ok) {
      commitProject(result.project, null);
      setLayout((current) => closePanelForViewport(current, "properties", isNarrowViewport));
    }
    else setCommandError(result.error);
  }, [commitProject, isNarrowViewport]);

  const deleteSelected = useCallback(() => {
    const clipId = selectedClipIdRef.current;
    if (clipId) deleteTimelineClip(clipId);
  }, [deleteTimelineClip]);

  const separateAudio = useCallback((clipId: string) => {
    const result = detachAudio(projectRef.current, { clipId });
    if (result.ok) commitProject(result.project, clipId);
    else setCommandError(result.error);
  }, [commitProject]);

  const updateSelectedText = useCallback(
    (text: string) => {
      const clipId = selectedClipIdRef.current;
      if (!clipId) return;
      const result = updateClipProps(projectRef.current, { clipId, props: { text } });
      if (result.ok) commitProject(result.project, clipId);
      else setCommandError(result.error);
    },
    [commitProject],
  );

  const updateSelectedStart = useCallback(
    (value: string) => {
      const clipId = selectedClipIdRef.current;
      const start = Number(value);
      if (!clipId) return;
      if (value.trim() === "" || !Number.isFinite(start) || start < 0) {
        setCommandError("Start must be a non-negative finite number.");
        return;
      }
      const result = moveClip(projectRef.current, { clipId, timelineStartSec: start });
      if (result.ok) commitProject(result.project, clipId);
      else setCommandError(result.error);
    },
    [commitProject],
  );

  const updateSelectedDuration = useCallback(
    (value: string) => {
      const clipId = selectedClipIdRef.current;
      const duration = Number(value);
      if (!clipId) return;
      if (value.trim() === "" || !Number.isFinite(duration) || duration <= 0) {
        setCommandError("Duration must be a positive finite number.");
        return;
      }
      const result = trimClip(projectRef.current, { clipId, durationSec: duration });
      if (result.ok) commitProject(result.project, clipId);
      else setCommandError(result.error);
    },
    [commitProject],
  );

  const updateSelectedTrack = useCallback(
    (toTrackId: string) => {
      const clipId = selectedClipIdRef.current;
      if (!clipId) return;
      const result = moveClip(projectRef.current, { clipId, toTrackId });
      if (result.ok) commitProject(result.project, clipId);
      else setCommandError(result.error);
    },
    [commitProject],
  );

  const handleAddSyntheticClip = useCallback(
    (kind: SyntheticClipKind) => {
      const before = projectRef.current;
      const planned = planSyntheticClip(before, playheadSecRef.current, kind);
      if (!planned.ok) {
        setCommandError(planned.error);
        return;
      }
      const result = addClip(before, planned.input);
      if (!result.ok) {
        setCommandError(result.error);
        return;
      }
      const createdClipId = findCreatedClipId(before, result.project, planned.input);
      if (!createdClipId) {
        setCommandError(`Failed to identify the newly created ${kind} clip.`);
        return;
      }
      commitProject(result.project, createdClipId);
      focusCreatedTextRef.current = true;
      setLayout((current) => isPanelOpen(current, "properties", isNarrowViewport) ? current : togglePanelForViewport(current, "properties", isNarrowViewport));
    },
    [commitProject, isNarrowViewport],
  );

  const loadStructuralFixture = useCallback(() => {
    const fixture = createCuttingRoomFixtureProject();
    playheadSecRef.current = 0;
    setPlayheadSec(0);
    setPlaying(false);
    commitProject(fixture, null);
  }, [commitProject]);

  const jumpPlayhead = useCallback(
    (seconds: number) => {
      const next = Math.max(playbackStartSec, Math.min(playbackEndSec, seconds));
      setPlaying(false);
      playheadSecRef.current = next;
      setPlayheadSec(next);
      publishContext(projectRef.current, selectedClipIdRef.current, next);
    },
    [playbackStartSec, playbackEndSec, publishContext],
  );

  const togglePlayback = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (durationSec <= 0) return;
    if (rangePlayback || playheadSecRef.current >= playbackEndSec) {
      playheadSecRef.current = playbackStartSec;
      setPlayheadSec(playbackStartSec);
      publishContext(projectRef.current, selectedClipIdRef.current, playbackStartSec);
    }
    setPlaying(true);
  }, [durationSec, playbackEndSec, playbackStartSec, rangePlayback, playing, publishContext]);

  const livePlaybackHandlerRef = useRef<Parameters<NonNullable<NautiloAppBridge["session"]>["onCommand"]>[0]>(() => undefined);
  livePlaybackHandlerRef.current = (input, version) => {
    const reject = (code: Extract<PlaybackResult, { status: "rejected" }>["code"]): PlaybackResult => ({ status: "rejected", code, stateChanged: false, retrySafe: false });
    const autosave = autosaveRef.current;
    if (!autosave) return reject("stale_document");
    const mediaCommand = parseMediaCommand(input);
    const mediaSnapshot = (): MediaOperationsResult => ({ status: "media_operations", import: mediaImportOperationRef.current ? { ...mediaImportOperationRef.current } : null, export: mediaExportOperationRef.current ? { ...mediaExportOperationRef.current } : null, workspaceExportSupported, nativeDialogsRequired: true });
    // Observation/cancellation must remain available while an import is saving
    // or a human edits during a saved-snapshot export. Exact operation IDs fence
    // cancellation so an old request cannot stop newer work.
    if (mediaCommand?.action === "inspect-media") return mediaSnapshot();
    if (mediaCommand?.action === "cancel-export") {
      if (mediaExportOperationRef.current?.id !== mediaCommand.operationId || !exportControllerRef.current) return reject("invalid_command");
      mediaExportOperationRef.current = { ...mediaExportOperationRef.current, stage: "cancelling" };
      exportControllerRef.current.abort();
      return mediaSnapshot();
    }
    if (mediaCommand?.action === "cancel-import") {
      if (mediaImportOperationRef.current?.id !== mediaCommand.operationId || (!mediaImportRequestRef.current && !pendingVideoImport)) return reject("invalid_command");
      cancelMediaImport();
      return mediaSnapshot();
    }
    const saveState = autosave.getState();
    if (saveState.dirty || saveState.status === "conflict" || saveState.status === "failed") return reject("dirty_document");
    const saved = autosave.getSavedDocumentIdentity();
    if (!saved) return reject("stale_document");
    if (version.kind === "artifact_revision" ? saved.revision !== version.revision : saved.sha256 !== version.sha256) return reject("stale_document");
    if (mediaCommand) {
      if (!getNautiloApp()?.media) return reject("invalid_command");
      if (mediaCommand.action === "import-media") {
        if (pendingVideoImport || mediaImportRequestRef.current || mediaOperationActive(mediaImportOperationRef.current)) return reject("invalid_command");
        handleImportVideo();
      } else if (mediaCommand.action === "export-media") {
        if (exportControllerRef.current || durationSec <= 0 || (mediaCommand.publishToWorkspace && !workspaceExportSupported)) return reject("invalid_command");
        void handleExportVideo(mediaCommand.publishToWorkspace, mediaCommand.exportSettings ?? normalizeVideoExportSettings(undefined)!);
      } else if (mediaCommand.action === "choose-import-rate") {
        if (!pendingVideoImport || mediaImportOperationRef.current?.id !== mediaCommand.operationId || mediaImportOperationRef.current.stage !== "awaiting-rate") return reject("invalid_command");
        completeVideoImport(pendingVideoImport, mediaCommand.decision);
      }
      return mediaSnapshot();
    }
    const generationCommand = parseGenerationReviewCommand(input);
    if (generationCommand) {
      if (generationRunRef.current || generationPreparationRef.current || generationReviewBusy || !getNautiloApp()?.videoGeneration) return reject("invalid_command");
      const scene = projectRef.current.generationBrief?.shots.find(shot => shot.id === generationCommand.shotId);
      if (!scene || (generationCommand.continuationTakeId && !scene.continueFromPrevious)) return reject("invalid_command");
      setWorkspace("generate");
      setGenerationModelId(generationCommand.modelId);
      setGenerationSettings(generationCommand.settings);
      // This requests the existing parent-owned approval, never approves it.
      // Do not hold a tool invocation open across Human consent or generation.
      void reviewGenerationPlan([generationCommand.shotId], generationCommand).then(review => {
        if (review?.draft.status === "ready-for-quote") void getExactGenerationQuote(review, generationCommand.continuationTakeId);
      });
      return GENERATION_REVIEW_REQUESTED;
    }
    const command = parsePlaybackCommand(input);
    if (!command) return reject("invalid_command");
    const next = planPlaybackCommand({ playheadSec: playheadSecRef.current, durationSec, playing, range: timelineRangeRef.current }, command);
    if (!next) return reject("out_of_range");
    if (command.action !== "inspect") {
      setSourcePreviewId(null);
      setWorkspace("edit");
      timelineRangeRef.current = next.range;
      playheadSecRef.current = next.playheadSec;
      setTimelineRange(next.range);
      setPlayheadSec(next.playheadSec);
      setPlaying(next.playing);
      publishContext(projectRef.current, selectedClipIdRef.current, next.playheadSec);
    }
    return { status: "ready", state: next, documentChanged: false, playbackConfirmed: false };
  };
  useEffect(() => getNautiloApp()?.session?.onCommand((command, version) => livePlaybackHandlerRef.current(command, version)), []);

  const adjustPreviewResize = useCallback((delta: number) => {
    setLayout((current) => adjustPreviewPercent(current, delta));
  }, []);

  const handlePreviewResizeKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      adjustPreviewResize(-PREVIEW_PERCENT_KEYBOARD_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      adjustPreviewResize(PREVIEW_PERCENT_KEYBOARD_STEP);
    }
  }, [adjustPreviewResize]);

  const beginPreviewResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (previewResizeSessionRef.current) return;
    const divider = event.currentTarget;
    const editor = divider.closest<HTMLElement>(".cutting-room__workspace");
    if (!editor) return;
    const pointerId = event.pointerId;
    const previewPercent = layout.previewPercent;
    const update = (clientY: number) => {
      const rect = editor.getBoundingClientRect();
      setLayout((current) => setPreviewPercent(current, ((clientY - rect.top) / rect.height) * 100));
    };
    const cleanupPreviewResize = () => {
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", commitPreviewResize);
      divider.removeEventListener("pointercancel", restorePreviewResize);
      window.removeEventListener("keydown", onWindowKeyDown);
      if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
      previewResizeSessionRef.current = null;
    };
    const restorePreviewResize = () => {
      const session = previewResizeSessionRef.current;
      if (!session) return;
      setLayout((current) => setPreviewPercent(current, session.previewPercent));
      cleanupPreviewResize();
    };
    const commitPreviewResize = () => cleanupPreviewResize();
    const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientY);
    const onWindowKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      restorePreviewResize();
    };
    previewResizeSessionRef.current = { previewPercent, dispose: cleanupPreviewResize };
    divider.setPointerCapture(pointerId);
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", commitPreviewResize);
    divider.addEventListener("pointercancel", restorePreviewResize);
    window.addEventListener("keydown", onWindowKeyDown);
  }, [layout.previewPercent]);

  useEffect(() => () => {
    previewResizeSessionRef.current?.dispose();
    exportControllerRef.current?.abort();
    workspaceCopyControllerRef.current?.abort();
  }, []);

  if (phase.kind === "loading") {
    return <div className="video-app video-app--loading" data-theme={theme}>Loading video document...</div>;
  }

  if (phase.kind === "invalid") {
    return (
      <div className="video-app video-app--error" data-theme={theme}>
        <header className="video-topbar">
          <h1>Invalid video document</h1>
          <div className="video-topbar__actions">
            <span className="video-status video-status--failed">Failed</span>
          </div>
        </header>
        <div className="video-banner video-banner--error">{phase.message}</div>
      </div>
    );
  }

  return (
    <TransitionContext.Provider value={{ project, selected: selectedTransition, select: selectTransition, drop: dropTransition, edit: editTransition, reject: setCommandError }}><FadeContext.Provider value={{ selected: selectedFade, select: selectFade, drop: dropFade, edit: editFade }}><div className="video-app cutting-room" data-theme={theme}>
      <nav className="cutting-room__document-bar" aria-label="Video document controls">
        <span className={`cutting-room__saved cutting-room__saved--${autosaveState.status}`}><i aria-hidden="true" />{statusLabel(autosaveState)}</span>
        <button type="button" disabled={!historyState.canUndo} onClick={() => applyHistory("undo")} title="Undo the latest human edit">Undo</button><button type="button" disabled={!historyState.canRedo} onClick={() => applyHistory("redo")} title="Redo the latest undone human edit">Redo</button>
        <div className="video-workspace-switch" ref={workspaceSwitchRef} role="group" aria-label="Video workspace">
          <button type="button" data-workspace="edit" aria-pressed={workspace === "edit"} onClick={() => setWorkspace("edit")}>Edit</button>
          <button type="button" data-workspace="generate" aria-pressed={workspace === "generate"} onClick={openGenerateWorkspace}>Generate</button>
        </div>
        <span className="cutting-room__spacer" />
        <button type="button" onClick={handleImportVideo} disabled={mediaImportBusy || Boolean(pendingVideoImport)} title="Import video, audio, or an image from the bound Current Folder or Workspace">Import media</button>
        {exportState.kind === "active" ? <button type="button" onClick={() => exportControllerRef.current?.abort()}>Cancel export</button> : <button type="button" disabled={!documentPathRef.current || !autosaveRef.current?.getSavedDocumentIdentity() || autosaveState.dirty} onClick={() => setExportDialogOpen(true)} title="Choose MP4 resolution and quality">Export video</button>}
        {workspaceCopyDestinationLabel ? workspaceCopyState.kind === "active" ? <button type="button" onClick={() => workspaceCopyControllerRef.current?.abort()}>Cancel Workspace copy</button> : <button type="button" onClick={() => void handleSaveWorkspaceCopy()} title={`Save a Workspace copy in ${workspaceCopyDestinationLabel}`}>Save a Workspace copy <small>{workspaceCopyDestinationLabel}</small></button> : null}
        <button type="button" aria-pressed={projectPanelOpen} onClick={() => setLayout((current) => togglePanelForViewport(current, "project", isNarrowViewport))}>Project</button>
        <button type="button" aria-pressed={propertiesPanelOpen} onClick={() => setLayout((current) => togglePanelForViewport(current, "properties", isNarrowViewport))}>Properties</button>
        <button type="button" className={layout.focusSnapshot ? "is-active" : ""} aria-pressed={Boolean(layout.focusSnapshot)} onClick={toggleFullWidth}>Full width</button>
      </nav>
      {phase.kind === "no-document" ? <div className="video-banner video-banner--info">No document is open. You are editing a local blank template.</div> : null}
      {autosaveState.status === "failed" && autosaveState.errorMessage ? <div className="video-banner video-banner--error">{autosaveState.errorMessage}</div> : null}
      {autosaveState.status === "conflict" ? <div className="video-banner video-banner--conflict"><span>{autosaveState.errorMessage ?? "This video document changed elsewhere. Your draft is still intact."}</span><button type="button" onClick={() => void autosaveRef.current?.reloadLatest().then((latest) => latest && loadEnvelope(latest))}>Discard draft and reload latest</button></div> : null}
      {commandError ? <div className="video-banner video-banner--error">{commandError}</div> : null}
      {mediaImportStatus ? <div className="video-banner video-banner--info">{mediaImportStatus}</div> : null}
      {exportState.kind !== "idle" ? <div className={`video-banner ${exportState.kind === "failed" ? "video-banner--error" : "video-banner--info"}`} role="status">{exportState.message}{exportState.kind === "active" && exportState.processedTimeUs !== undefined && durationSec > 0 ? ` ${Math.min(100, Math.floor(exportState.processedTimeUs / (durationSec * 10_000)))}%` : ""}</div> : null}
      {workspaceCopyState.kind !== "idle" ? <div className={`video-banner ${workspaceCopyState.kind === "failed" ? "video-banner--error" : "video-banner--info"}`} role="status">{workspaceCopyState.message}{workspaceCopyState.kind === "complete" && workspaceCopyState.canOpen ? <button type="button" onClick={() => void openWorkspaceCopy()}>Open Workspace copy</button> : null}</div> : null}
      {pendingVideoImport ? <FrameRateDialog source={pendingVideoImport.frameRate} project={sequence.frameRate} onChoose={(decision, remember) => { completeVideoImport(pendingVideoImport, decision); if (remember) rememberFirstSourceRate(decision); }} onCancel={cancelMediaImport} /> : null}
      {exportDialogOpen ? <ExportDialog settings={exportSettings} frameRate={sequence.frameRate} publishToWorkspace={publishToWorkspace} workspaceSupported={workspaceExportSupported} onChange={setExportSettings} onPublishChange={setPublishToWorkspace} onCancel={() => setExportDialogOpen(false)} onExport={() => { setExportDialogOpen(false); void handleExportVideo(); }} /> : null}
      <main className={`cutting-room__workspace${workspace !== "edit" ? " is-hidden" : ""}`} aria-label="Cutting room editor" aria-hidden={workspace !== "edit"} inert={workspace !== "edit"} style={{ "--preview-percent": `${layout.previewPercent}%`, "--project-width": panelWidths(layout).projectWidth, "--properties-width": panelWidths(layout).propertiesWidth } as CSSProperties}>
        <ToolboxRail category={toolboxCategory} libraryOpen={projectPanelOpen} onBrowse={(category) => {
          setToolboxCategory(category);
          setLayout((current) => {
            // Browsing opens the one library; it never toggles selection or history.
            if (current.focusSnapshot || isPanelOpen(current, "project", isNarrowViewport)) return current;
            return togglePanelForViewport(current, "project", isNarrowViewport);
          });
        }} />
        <aside id="video-toolbox-library" aria-label={`${toolboxCategory} library contents`} className={`cutting-room__panel cutting-room__project${projectPanelOpen ? "" : " is-hidden"}`} aria-hidden={!projectPanelOpen} inert={!projectPanelOpen}>
          <header><strong>{toolboxCategory}</strong><button type="button" aria-label="Hide Project" title="Hide library" onClick={() => setLayout((current) => togglePanelForViewport(current, "project", isNarrowViewport))}>‹</button></header>
          {toolboxCategory === "Text" ? <TextLibrary onAdd={handleAddSyntheticClip} /> : null}
          {toolboxCategory === "Transitions" || toolboxCategory === "Audio" ? <FadeLibrary channel={toolboxCategory === "Audio" ? "audio" : "video"} clip={selectedClip} /> : null}
          {toolboxCategory === "Transitions" ? <TransitionLibrary clip={selectedClip} /> : null}
          {toolboxCategory === "Effects" ? <UnavailableEffectLibrary category="Effects" /> : null}
          <div hidden={toolboxCategory !== "Media"}>
          <section><h2>Media Bin</h2>{project.media.length === 0 ? <div className="video-empty-state"><p>Import or generate media here, then drag it onto any timeline track.</p><div className="video-empty-state__actions"><button type="button" onClick={handleImportVideo} disabled={mediaImportBusy || Boolean(pendingVideoImport)}>Import media</button><button type="button" className="video-button--primary" onClick={openGenerateWorkspace}>Generate</button></div>{sequence.tracks.every((track) => track.clips.length === 0) ? <button type="button" onClick={loadStructuralFixture}>Load 20-clip interaction fixture</button> : null}</div> : <div className="video-media-bin">{project.media.map((asset) => <article
            className="video-asset"
            key={asset.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(VIDEO_MEDIA_DRAG_TYPE, asset.id);
            }}
          >{asset.kind === "video" ? <MediaBinPreview asset={asset} enabled={projectPanelOpen && toolboxCategory === "Media" && workspace === "edit" && (asset.source?.kind !== "workspace-artifact" || savedMediaIds.has(asset.id))} active={sourcePreviewId === asset.id} timelinePlaying={playing} onPlay={() => { setPlaying(false); setSourcePreviewId(asset.id); }} /> : null}<strong>{asset.label ?? asset.id}</strong><span>{asset.kind}{asset.durationSec !== undefined ? ` · ${asset.durationSec}s` : ""} · {asset.lifecycle ?? "local-working"}</span><button type="button" onClick={() => placeMediaAtPlayhead(asset.id)}>Add at playhead</button></article>)}</div>}</section>
          <section className="cutting-room__import-settings"><h2>Import settings</h2><label>First video in a new project<select aria-label="First video frame-rate preference" value={firstSourceRate} onChange={(event) => rememberFirstSourceRate(event.currentTarget.value as FirstSourceRateDecision | "ask")}><option value="ask">Ask me</option><option value="adopt-source-rate">Match the video</option><option value="keep-project-rate">Keep the project rate</option></select></label><p>Current project: {formatFrameRate(sequence.frameRate)}</p>{ratePreferenceMessage ? <p role="status">{ratePreferenceMessage}</p> : null}</section>
          </div>
        </aside>
        <section className="cutting-room__editor" aria-label="Cutting room editor">
          <section className="cutting-room__preview" aria-label="Assembled sequence preview">
            <div className="cutting-room__program"><span>PROGRAM · SEQUENCE</span><span>{formatPlayheadTimecode(playheadSec)}</span></div>
            <div className="cutting-room__stage"><ProgramPreview project={project} timeSec={previewTimeSec} playing={playing} onReadyChange={handlePreviewReadyChange} clockRef={previewClockRef} /></div>
            <div className="cutting-room__transport" role="group" aria-label="Playhead controls"><button type="button" disabled={!hasTimelineClips} onClick={() => jumpPlayhead(0)} aria-label="Jump playhead to start">↤</button><button type="button" className="cutting-room__play" disabled={!hasTimelineClips} title={!hasTimelineClips ? "Add or generate media to begin editing." : rangePlayback ? "Play from IN to OUT, then stop. Tap the playhead handle to clear the selection." : "Play the timeline"} onClick={togglePlayback} aria-label={playing ? "Pause preview" : "Play sequence preview"}>{playing ? "Ⅱ" : "▶"}</button><button type="button" disabled={!hasTimelineClips} onClick={() => jumpPlayhead(durationSec)} aria-label="Jump playhead to end">↦</button><label><span>Playhead</span><input aria-label="Timeline playhead" disabled={!hasTimelineClips} type="range" min={playbackStartSec} max={playbackEndSec} step={scrubberStepSec} value={Math.min(playheadSec, scrubberMaxSec)} onChange={(event) => jumpPlayhead(Number(event.currentTarget.value))} /></label><time>{playheadSec.toFixed(2)}s / {durationSec.toFixed(2)}s</time></div>
          </section>
          <div className="cutting-room__splitter" role="separator" tabIndex={0} aria-label="Resize preview and timeline" aria-orientation="horizontal" aria-valuemin={PREVIEW_PERCENT_MIN} aria-valuemax={PREVIEW_PERCENT_MAX} aria-valuenow={layout.previewPercent} aria-valuetext={`${layout.previewPercent}% preview height`} onPointerDown={beginPreviewResize} onKeyDown={handlePreviewResizeKey}><span /></div>
          <Timeline range={timelineRange} onRangeChange={handleTimelineRangeChange} media={project.media} sequence={sequence} selectedClipId={selectedClipId} selectedClipIds={selectedClipIds} playheadSec={playheadSec} interactive={hasTimelineClips} onSelectClip={selectTimelineClip} onScrub={jumpPlayhead} onMoveClip={handleMoveClip} onTrimLeft={handleTrimLeft} onTrimRight={handleTrimRight} onSplitSelected={splitSelected} onPlaceMedia={placeMediaOnTrack} onAddTrack={handleAddTrack} onDeleteTrack={handleDeleteTrack} onReorderTrack={handleReorderTrack} onUpdateTrack={handleUpdateTrack} onSeparateAudio={separateAudio} onDeleteClip={deleteTimelineClip} onClipboardAction={performClipboardAction} clipboardLabel={clipboard ? `${clipboard.clips.length} clips · ${clipboard.durationSec.toFixed(2)}s → ${[...new Set(clipboard.clips.map((clip) => { const track = sequence.tracks.find((item) => item.id === clip.trackId); return track?.name ?? track?.kind ?? "missing track"; }))].join(", ")}` : undefined} />
        </section>
        <aside className={`cutting-room__panel cutting-room__properties${propertiesPanelOpen ? "" : " is-hidden"}`} aria-hidden={!propertiesPanelOpen} inert={!propertiesPanelOpen}>
          <header><strong>Properties</strong><button type="button" aria-label="Hide Properties" onClick={() => setLayout((current) => togglePanelForViewport(current, "properties", isNarrowViewport))}>›</button></header>
          {selectedClip ? <TransitionInspector clip={selectedClip} /> : null}
          {selectedClip && (selectedClip.kind === "video" || selectedClip.kind === "audio") ? <FadeInspector clip={selectedClip} /> : null}
          {selectedClip ? <div className="cutting-room__properties-content" key={selectedClip.id}><div className="cutting-room__selection"><span>◆</span><div><strong>{clipDisplayName(selectedClip)}</strong><small>{selectedClip.kind} clip</small></div></div>{selectedClip.kind === "text" || selectedClip.kind === "caption" || selectedClip.kind === "callout" ? <label><span>Text</span><textarea aria-label="Clip text" rows={3} value={typeof selectedClip.props["text"] === "string" ? selectedClip.props["text"] : ""} onInput={(event) => updateSelectedText(event.currentTarget.value)} /></label> : null}<label><span>Start</span><input type="number" min="0" step="0.01" defaultValue={selectedClip.timelineStartSec} onBlur={(event) => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".cutting-room__tool-strip"))) updateSelectedStart(event.currentTarget.value); }} /></label><label><span>Duration</span><input type="number" min="0.01" step="0.01" defaultValue={selectedClip.durationSec} onBlur={(event) => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".cutting-room__tool-strip"))) updateSelectedDuration(event.currentTarget.value); }} /></label><label><span>Track</span><select value={selectedClip.trackId} onChange={(event) => updateSelectedTrack(event.currentTarget.value)}>{sequence.tracks.filter((track) => isClipKindAllowedOnTrack(selectedClip.kind, track.kind)).map((track) => <option key={track.id} value={track.id}>{trackDisplayName(track.id, track.kind)}</option>)}</select></label><div className="video-inspector__actions"><button type="button" onClick={deleteSelected}>Delete</button><button type="button" disabled={selectedClip.kind !== "video"} onClick={() => separateAudio(selectedClip.id)}>Separate audio</button></div></div> : <p className="cutting-room__empty-properties">Select a clip for contextual properties.</p>}
        </aside>
      </main>
      <GeneratorWorkspace project={project} documentKey={`${documentEpochRef.current}:${documentPathRef.current ?? "draft"}`} savedReferenceKeys={savedReferenceKeys} savedMediaIds={savedMediaIds} enabled={workspace === "generate"} mutate={mutateGenerationBrief}
        onPlaceSequence={(mediaIds) => {
          const result = placeGeneratedMediaSequence(projectRef.current, mediaIds, playheadSecRef.current);
          if (!result.ok) { setCommandError(result.error); return; }
          commitProject(result.project);
          returnToEditWorkspace();
        }}
        onGenerate={(shotIds) => { setGenerationRunMessage(null); void reviewGenerationPlan(shotIds).then((review) => { if (review) void getExactGenerationQuote(review); }); }} onPlaceMedia={placeMediaAtPlayhead} onReturn={returnToEditWorkspace}
        busy={generationReviewBusy} takes={generatedTakeDisplaySummaries} statuses={generatedTakeStatuses} unavailableIds={generatedTakeUnavailableIds}
        progressForTake={(id) => { const status = generatedTakeStatuses[id]; return status ? generatedTakeProgressPresentation(status, displayedGeneratedTakeElapsedSeconds(generatedTakeElapsedObservations[id], generatedTakeClockNowMs ?? Date.now()))?.message ?? status.state : "Checking"; }}
        onReconnectMedia={() => setGenerationPollEpoch((epoch) => epoch + 1)}
        timingForTake={(id) => { const status = generatedTakeStatuses[id]; return status ? generatedTakeProgressPresentation(status, displayedGeneratedTakeElapsedSeconds(generatedTakeElapsedObservations[id], generatedTakeClockNowMs ?? Date.now()))?.timing ?? null : null; }}
        modelControl={<><label>Model<select value={generationModelId} onChange={(event) => { setGenerationModelId(event.currentTarget.value as VideoGenerationCatalogModelId); setGenerationSettings({}); clearGenerationReview(); }}><option value={VIDEO_GENERATION_CATALOG_MODELS.seedance}>Seedance 2.5</option><option value={VIDEO_GENERATION_CATALOG_MODELS.minimaxH3}>MiniMax H3</option></select></label><GenerationSettingsControls durationScope="video" model={generationModelId} settings={{ ...generationSettings, ...(project.generationBrief?.shots[0]?.durationSec === undefined ? {} : { durationSeconds: project.generationBrief.shots[0].durationSec }) }} onDurationChange={duration => {
          const shot = projectRef.current.generationBrief?.shots[0];
          if (shot) mutateGenerationBrief(brief => updateGenerationShot(brief, shot.id, { durationSec: duration }));
          else setGenerationSettings(current => { const next = { ...current }; if (duration === undefined) delete next.durationSeconds; else next.durationSeconds = duration; return next; });
          clearGenerationReview();
        }} onChange={settings => { const { durationSeconds: _duration, ...otherSettings } = settings; setGenerationSettings(current => ({ ...otherSettings, ...(current.durationSeconds === undefined ? {} : { durationSeconds: current.durationSeconds }) })); clearGenerationReview(); }} /></>}
        {...(generationSettings.durationSeconds === undefined ? {} : { defaultDurationSeconds: generationSettings.durationSeconds })}
        sceneModelControl={<><label>Model<select value={generationModelId} onChange={(event) => { setGenerationModelId(event.currentTarget.value as VideoGenerationCatalogModelId); setGenerationSettings({}); clearGenerationReview(); }}><option value={VIDEO_GENERATION_CATALOG_MODELS.seedance}>Seedance 2.5</option><option value={VIDEO_GENERATION_CATALOG_MODELS.minimaxH3}>MiniMax H3</option></select></label><GenerationSettingsControls includeDuration={false} model={generationModelId} settings={generationSettings} onChange={settings => { setGenerationSettings(settings); clearGenerationReview(); }} /></>}
        feedback={<div role="status">
          {generationReview?.draft.status === "blocked" ? generationReview.draft.issues.map((issue, index) => <p key={index}>{generationPlanIssueMessage(issue)}</p>) : null}
          {generationRunMessage ? <p>{generationRunMessage}</p> : null}
          {generationReviewBusy && generationRunRef.current ? <button onClick={() => generationRunRef.current?.abort()}>Stop after current scene</button> : null}
          {generationQuoteState ? <p>{generationQuoteState === "queued" ? "Generation started. Completed media will appear automatically." : generationQuoteState === "cancelled" ? "Generation cancelled before submission." : generationQuoteState === "submission-unknown" ? "Check this scene’s takes before generating again; submission could not be confirmed." : generationQuoteState === "expired" ? "Approval expired before submission. Generate again for a fresh review." : "The approval could not be prepared. Your prompt and media are preserved."}</p> : null}
          {generatedTakeStatusMessage ? <p>{generatedTakeStatusMessage}</p> : null}
          {generatedTakeLoadState === "unavailable" ? <button onClick={() => setGenerationPollEpoch((epoch) => epoch + 1)}>Reconnect generated media</button> : null}
        </div>} />
      <footer className="video-activity">
        {receiptsEnabled && agentReceipt && !receiptDismissed ? <section className="video-agent-receipt" aria-label="Latest Genie edit">
          <div role="status"><strong>{agentReceipt.summary}</strong><span>{agentReceipt.details.join(" · ")}</span></div>
          <details><summary>Review change</summary><p>{agentReceipt.recovered ? "Recovered from retained document history." : "Latest observed Genie edit in this session."} This is not the complete activity history. Revert removes only this edit and preserves later disjoint work.</p>{agentReceipt.unavailableReason ? <p>{agentReceipt.unavailableReason}</p> : null}</details>
          {receiptReverted ? <p role="status">{autosaveState.dirty ? "Revert applied to your draft. It is not saved yet." : "Revert applied. Your current draft is saved."}</p> : <button type="button" onClick={revertAgentEdit} disabled={!!agentReceipt.unavailableReason || autosaveState.status === "conflict"}>Revert Genie edit</button>}
          <button type="button" onClick={() => setReceiptDismissed(true)}>Dismiss</button>
        </section> : null}
        <div className="cutting-room__context"><span>✦</span><p><strong>Genie context</strong><small>{contextSummary ? buildGenieStatusLine(contextSummary, statusLabel(autosaveState)) : "Loading document context…"}</small></p><button type="button" aria-pressed={receiptsEnabled} disabled={receiptPreferenceBusy} onClick={() => void toggleReceiptNotices()}>Genie notices: {receiptsEnabled ? "On" : "Off"}</button>{agentReceipt && receiptDismissed && receiptsEnabled ? <button type="button" onClick={() => setReceiptDismissed(false)}>Show latest edit</button> : null}</div>
        {receiptPreferenceMessage ? <p role="status">{receiptPreferenceMessage}</p> : null}
      </footer>
    </div></FadeContext.Provider></TransitionContext.Provider>
  );
}
import { normalizeVideoExportSettings, type VideoExportSettings } from "@nautilo/types";
import { ExportDialog } from "./ExportDialog";
