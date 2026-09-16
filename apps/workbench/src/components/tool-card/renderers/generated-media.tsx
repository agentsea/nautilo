/** D525 Phase 3.2 — authenticated Workspace playback for generated video/music. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { apiClient } from "../../../lib/api";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { requestOpenFile } from "../../../adapters/open-file-ref";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { GeneratedMediaAmbientFeedback } from "./generated-media-ambient";
import {
  generatedMediaStateLabel,
  mapMediaGenerationStatusToEnvelope,
  parseGeneratedMediaEnvelope,
  type GeneratedMediaArtifact,
  type GeneratedMediaEnvelope,
  type GeneratedMediaRecoveryAction,
} from "./generated-media-envelope";

const STATUS_POLL_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;

function isGeneratedMediaTerminal(state: GeneratedMediaEnvelope["state"]): boolean {
  return state === "ready" || state === "cleanup-pending" || state === "needs-action" ||
    state === "failed" || state === "unknown";
}

function useHydratedGeneratedMediaEnvelope(
  initial: GeneratedMediaEnvelope,
  roomId: string | undefined,
): GeneratedMediaEnvelope {
  const [current, setCurrent] = useState(initial);
  const currentRef = useRef(initial);

  useEffect(() => {
    currentRef.current = initial;
    setCurrent(initial);
  }, [initial]);

  useEffect(() => {
    const receiptId = initial.receiptId;
    if (!receiptId || !roomId || isGeneratedMediaTerminal(initial.state)) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let failureCount = 0;
    let latestRevision = -1;
    let inFlight = false;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      if (stopped) return;
      clearTimer();
      timer = setTimeout(() => { void poll(); }, delay);
    };
    const poll = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState === "hidden") {
        schedule(STATUS_POLL_DELAYS_MS[2]);
        return;
      }
      inFlight = true;
      controller = new AbortController();
      try {
        const dto = await apiClient.getMediaGenerationStatus(receiptId, {
          roomId,
          signal: controller.signal,
        });
        if (stopped) return;
        if (dto.receiptId !== receiptId || dto.revision < latestRevision) {
          schedule(STATUS_POLL_DELAYS_MS[0]);
          return;
        }
        failureCount = 0;
        // A repeated durable revision carries no new provider observation.
        // Keeping the current envelope object intact lets the display-only
        // elapsed clock continue from its prior anchor between real updates.
        if (dto.revision === latestRevision) {
          schedule(STATUS_POLL_DELAYS_MS[0]);
          return;
        }
        const mapped = mapMediaGenerationStatusToEnvelope(dto, currentRef.current);
        if (!mapped) {
          schedule(STATUS_POLL_DELAYS_MS[0]);
          return;
        }
        latestRevision = dto.revision;
        currentRef.current = mapped;
        setCurrent(mapped);
        if (!isGeneratedMediaTerminal(dto.state)) schedule(STATUS_POLL_DELAYS_MS[0]);
      } catch {
        if (!stopped && !controller.signal.aborted) {
          const index = Math.min(failureCount, STATUS_POLL_DELAYS_MS.length - 1);
          failureCount += 1;
          schedule(STATUS_POLL_DELAYS_MS[index]);
        }
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || stopped || inFlight) return;
      clearTimer();
      void poll();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [initial, roomId]);

  return current;
}

type WorkspaceArtifactSummary = {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
};

type PlaybackState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "failed" };

function formatGeneratedMediaBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatGeneratedMediaDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
}

function resolveGeneratedMediaArtifact(
  artifact: GeneratedMediaArtifact | undefined,
  artifacts: readonly WorkspaceArtifactSummary[],
): (GeneratedMediaArtifact & { internalId: string | null; resolvedPath: string; resolvedMime: string }) | null {
  if (!artifact) return null;
  // `path` is human-readable and may change or collide. Artifact bytes and
  // Open always bind only to the server-issued external artifact id.
  const resolved = artifacts.find((candidate) => candidate.artifactId === artifact.artifactId);
  return {
    ...artifact,
    internalId: resolved?.id ?? null,
    resolvedPath: resolved?.path ?? artifact.path,
    resolvedMime: resolved?.mimeType || artifact.mime,
  };
}

function directoryFor(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

function mediaMimeMatches(mediaKind: "video" | "audio", mime: string): boolean {
  return mediaKind === "video" ? mime.startsWith("video/") : mime.startsWith("audio/");
}

/** The only byte source used by this card is the authenticated Workspace API. */
function useGeneratedMediaBytes(
  internalId: string | null,
  mime: string,
  roomId: string | undefined,
): { playback: PlaybackState; retry: () => void; failPlayback: () => void } {
  const [playback, setPlayback] = useState<PlaybackState>({ status: "idle" });
  const objectUrlRef = useRef<string | null>(null);
  const requestGeneration = useRef(0);

  const revoke = useCallback(() => {
    if (!objectUrlRef.current) return;
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const load = useCallback(() => {
    const generation = ++requestGeneration.current;
    revoke();
    if (!internalId) {
      setPlayback({ status: "idle" });
      return;
    }
    setPlayback({ status: "loading" });
    void apiClient
      .getWorkspaceArtifactBytes(internalId, roomId ? { roomId } : undefined)
      .then((blob) => {
        if (requestGeneration.current !== generation) return;
        const typedBlob = blob.type ? blob : new Blob([blob], { type: mime });
        const src = URL.createObjectURL(typedBlob);
        if (requestGeneration.current !== generation) {
          URL.revokeObjectURL(src);
          return;
        }
        objectUrlRef.current = src;
        setPlayback({ status: "ready", src });
      })
      .catch(() => {
        if (requestGeneration.current === generation) setPlayback({ status: "failed" });
      });
  }, [internalId, mime, revoke, roomId]);

  const failPlayback = useCallback(() => {
    requestGeneration.current += 1;
    revoke();
    setPlayback({ status: "failed" });
  }, [revoke]);

  useEffect(() => {
    load();
    return () => {
      requestGeneration.current += 1;
      revoke();
    };
  }, [load, revoke]);

  return { playback, retry: load, failPlayback };
}

function safeSettingsSummary(settings: GeneratedMediaEnvelope["settings"]): string {
  const parts = Object.entries(settings).map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join(" · ") : "Default settings";
}

function generationProgressCopy(envelope: GeneratedMediaEnvelope): string | null {
  switch (envelope.state) {
    case "submitting":
      return "Submitted to Venice. Awaiting acknowledgement; Nautilo will not duplicate this paid request.";
    case "queued":
      return "Submitted to Venice. Checking progress…";
    case "generating": {
      const elapsed = envelope.progress?.elapsedSeconds;
      const typical = envelope.progress?.estimatedSeconds;
      if (elapsed !== undefined && typical !== undefined && elapsed > typical) {
        return "This run is taking longer than typical, but Venice still reports it active.";
      }
      return "Generation is active.";
    }
    case "downloading":
      return "Generation finished—downloading securely.";
    case "saving":
      return "Saving to Workspace…";
    default:
      return null;
  }
}

/**
 * Provider elapsed time is authoritative at each status observation. Between
 * observations we may advance that one display value locally, but it is never
 * persisted or used to make product decisions. A new progress object replaces
 * the local anchor even if Venice reports a shorter elapsed duration.
 */
function useDisplayedGenerationElapsedSeconds(envelope: GeneratedMediaEnvelope): number | undefined {
  const providerElapsed = envelope.progress?.elapsedSeconds;
  const isTickable = envelope.state === "generating" && providerElapsed !== undefined;
  const [displayedElapsed, setDisplayedElapsed] = useState<number | undefined>(providerElapsed);

  useEffect(() => {
    if (!isTickable || providerElapsed === undefined) {
      setDisplayedElapsed(providerElapsed);
      return;
    }
    let anchorElapsed = providerElapsed;
    let anchorTime = Date.now();
    let timer: number | null = null;
    const update = () => {
      setDisplayedElapsed(anchorElapsed + Math.max(0, Math.floor((Date.now() - anchorTime) / 1_000)));
    };
    const pause = () => {
      anchorElapsed += Math.max(0, Math.floor((Date.now() - anchorTime) / 1_000));
      anchorTime = Date.now();
      update();
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const resume = () => {
      if (timer !== null) return;
      anchorTime = Date.now();
      timer = window.setInterval(update, 1_000);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") pause();
      else resume();
    };
    update();
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState !== "hidden") resume();
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Progress object identity deliberately represents the latest durable
    // observation from the status endpoint, including a same-value refresh.
  }, [envelope.progress, envelope.receiptId, isTickable, providerElapsed]);

  return isTickable ? displayedElapsed : providerElapsed;
}

function GenerationTiming({ envelope }: { envelope: GeneratedMediaEnvelope }): ReactElement | null {
  const elapsed = formatGeneratedMediaDuration(useDisplayedGenerationElapsedSeconds(envelope));
  const typical = formatGeneratedMediaDuration(envelope.progress?.estimatedSeconds);
  if (!elapsed && !typical) return null;
  return (
    <p className="text-[0.65rem] text-foreground-muted" data-testid="generated-media-timing">
      {elapsed && <span>{elapsed} elapsed</span>}
      {elapsed && typical && <span aria-hidden="true"> · </span>}
      {typical && <span>Typical time: about {typical}</span>}
    </p>
  );
}

function StatusSummary({ envelope }: { envelope: GeneratedMediaEnvelope }): ReactElement {
  const active = envelope.state === "queued" || envelope.state === "submitting" ||
    envelope.state === "generating" || envelope.state === "downloading" || envelope.state === "saving";
  const copy = envelope.state === "unknown"
    ? "The queue outcome is unknown. Nautilo will not start another paid generation automatically."
    : envelope.state === "cleanup-pending"
      ? "Your Workspace artifact is ready. Provider cleanup will retry separately."
      : generationProgressCopy(envelope);
  return (
    <section aria-live="polite" aria-busy={active} className="rounded border border-border bg-background-element/30 px-2 py-1.5 space-y-0.5">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium text-foreground">{generatedMediaStateLabel(envelope.state)}</p>
      </div>
      {copy && <p className="text-[0.65rem] text-foreground-muted">{copy}</p>}
      <GenerationTiming envelope={envelope} />
      {envelope.failure && (
        <p role="alert" className="text-[0.65rem] text-tool-error">
          {envelope.failure.code}: {envelope.failure.message}
          {envelope.failure.creditsRefunded === true ? " Credits were refunded." : ""}
        </p>
      )}
    </section>
  );
}

function GenerationObservation({
  envelope,
  isVisible,
  onShow,
  onHide,
}: {
  envelope: GeneratedMediaEnvelope;
  isVisible: boolean;
  onShow: () => void;
  onHide: () => void;
}): ReactElement {
  const active = envelope.state === "queued" || envelope.state === "submitting" ||
    envelope.state === "generating" || envelope.state === "downloading" || envelope.state === "saving";

  // This is intentionally card-local: it changes no provider or durable job
  // state. The durable receipt remains available for a later remount or for
  // restoring the view, so hiding observation can never lose recovery.
  if (!active) return <StatusSummary envelope={envelope} />;
  if (!isVisible) {
    return (
      <section className="rounded border border-border bg-background-element/30 px-2 py-1.5 space-y-1" aria-live="polite">
        <p className="text-xs text-foreground-muted">Generation continues in the background.</p>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          onClick={onShow}
        >
          Show progress
        </button>
      </section>
    );
  }
  return (
    <div className="space-y-1">
      <StatusSummary envelope={envelope} />
      <button
        type="button"
        className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onClick={onHide}
      >
        Hide progress
      </button>
    </div>
  );
}

function emitSafeRecoveryAction(action: GeneratedMediaRecoveryAction): void {
  // Phase 3.3 owns the action route. This bridge carries only the server-issued
  // opaque action handle; it has no provider endpoint, receipt, or prompt.
  window.dispatchEvent(new CustomEvent("nautilo:generated-media-recovery", {
    detail: { actionId: action.actionId, kind: action.kind },
  }));
}

function RecoveryActions({ actions }: { actions: readonly GeneratedMediaRecoveryAction[] }): ReactElement | null {
  if (actions.length === 0) return null;
  return (
    <section aria-label="generation recovery" className="space-y-1.5">
      <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">Recovery</p>
      <div className="flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <button
            key={action.actionId}
            type="button"
            className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            onClick={(event) => {
              event.stopPropagation();
              emitSafeRecoveryAction(action);
            }}
          >
            {action.label}
            {action.newSpend ? " · new paid generation" : ""}
          </button>
        ))}
      </div>
      {actions.some((action) => action.newSpend) && (
        <p className="text-[0.65rem] text-foreground-muted">
          Starting a fresh generation requires a new spend approval.
        </p>
      )}
    </section>
  );
}

function MediaPlayer({
  mediaKind,
  src,
  title,
  onPlaybackError,
}: {
  mediaKind: "video" | "audio";
  src: string;
  title: string;
  onPlaybackError: () => void;
}): ReactElement {
  if (mediaKind === "video") {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        className="w-full rounded bg-black"
        aria-label={`Play generated video: ${title}`}
        data-testid="generated-media-video"
        onError={onPlaybackError}
      >
        <source src={src} />
      </video>
    );
  }
  return (
    <audio
      controls
      preload="metadata"
      className="w-full"
      aria-label={`Play generated audio: ${title}`}
      data-testid="generated-media-audio"
      onError={onPlaybackError}
    >
      <source src={src} />
    </audio>
  );
}

function ArtifactPlayback({ envelope }: { envelope: GeneratedMediaEnvelope }): ReactElement | null {
  const roomId = useRoomNavigation().activeRoomId ?? undefined;
  const artifact = envelope.artifact;
  const lookupKey = artifact ? `${artifact.artifactId}:${artifact.path}` : "";
  const pathPrefix = artifact ? directoryFor(artifact.path) : "";
  const [artifacts, setArtifacts] = useState<WorkspaceArtifactSummary[]>([]);
  const [lookupState, setLookupState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    if (!artifact) return;
    setLookupState("loading");
    void apiClient.listWorkspaceArtifacts({
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(roomId ? { roomId } : {}),
    }).then((response) => {
      if (cancelled) return;
      setArtifacts(response.artifacts);
      setLookupState("ready");
    }).catch(() => {
      if (cancelled) return;
      setArtifacts([]);
      setLookupState("failed");
    });
    return () => { cancelled = true; };
  }, [artifact, lookupKey, pathPrefix, roomId]);

  const resolved = useMemo(() => resolveGeneratedMediaArtifact(artifact, artifacts), [artifact, artifacts]);
  const compatibleMime = resolved ? mediaMimeMatches(envelope.mediaKind, resolved.resolvedMime) : true;
  const { playback, retry, failPlayback } = useGeneratedMediaBytes(
    compatibleMime ? resolved?.internalId ?? null : null,
    resolved?.resolvedMime ?? artifact?.mime ?? "application/octet-stream",
    roomId,
  );

  if (!artifact || (envelope.state !== "ready" && envelope.state !== "cleanup-pending")) return null;

  const open = () => {
    if (!resolved?.internalId || !compatibleMime) return;
    requestOpenFile(artifactOpenFileTarget({
      id: resolved.internalId,
      path: resolved.resolvedPath,
      mimeType: resolved.resolvedMime,
      ...(roomId ? { roomId } : {}),
      sizeBytes: resolved.bytes,
    }));
  };

  return (
    <section aria-label="generated media artifact" className="space-y-2">
      {playback.status === "loading" && (
        <p role="status" className="text-xs text-foreground-muted">Loading the saved Workspace artifact…</p>
      )}
      {playback.status === "failed" && (
        <div className="space-y-1">
          <p role="alert" className="text-xs text-tool-error">Saved media playback is unavailable.</p>
          <button type="button" className="rounded border border-border px-2 py-1 text-[0.7rem]" onClick={retry}>Retry playback</button>
        </div>
      )}
      {playback.status === "ready" && (
        <MediaPlayer mediaKind={envelope.mediaKind} src={playback.src} title={envelope.model} onPlaybackError={failPlayback} />
      )}
      <div className="rounded border border-border px-2 py-1.5 space-y-1">
        <p className="font-mono text-xs text-foreground break-all">Workspace/{resolved?.resolvedPath ?? artifact.path}</p>
        <p className="text-[0.65rem] text-foreground-dim">
          {resolved?.resolvedMime ?? artifact.mime} · {formatGeneratedMediaBytes(artifact.bytes)}
        </p>
        {resolved && !compatibleMime && (
          <p role="alert" className="text-[0.65rem] text-tool-error">
            The saved artifact has an incompatible media type and cannot be played.
          </p>
        )}
        {(lookupState === "failed" || (lookupState === "ready" && !resolved?.internalId)) && (
          <p role="alert" className="text-[0.65rem] text-tool-error">The saved artifact is not currently available to this Workspace.</p>
        )}
        <button
          type="button"
          disabled={!resolved?.internalId || !compatibleMime}
          className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={open}
        >
          Open
        </button>
      </div>
    </section>
  );
}

function GeneratedMediaExpanded({ resultText }: ToolRendererProps): ReactElement {
  const roomId = useRoomNavigation().activeRoomId ?? undefined;
  const initial = useMemo(() => parseGeneratedMediaEnvelope(resultText), [resultText]);
  if (!initial) {
    // Do not echo malformed result text: it may be a provider body or signed URL.
    return (
      <div className="border-t border-border px-3 py-2" data-testid="generated-media-unavailable">
        <p role="alert" className="text-xs text-tool-error">Generated media details are unavailable.</p>
      </div>
    );
  }
  return <HydratedGeneratedMediaExpanded initial={initial} roomId={roomId} />;
}

function HydratedGeneratedMediaExpanded({
  initial,
  roomId,
}: {
  initial: GeneratedMediaEnvelope;
  roomId: string | undefined;
}): ReactElement {
  const envelope = useHydratedGeneratedMediaEnvelope(initial, roomId);
  const ambientState = envelope.state === "submitting" ? "queued" :
    envelope.state === "queued" || envelope.state === "generating" ||
      envelope.state === "downloading" || envelope.state === "saving" ? envelope.state : null;
  const [isProgressVisible, setIsProgressVisible] = useState(true);
  const showVisualSlot = (Boolean(ambientState) && isProgressVisible) ||
    envelope.state === "ready" || envelope.state === "cleanup-pending";
  const [artifactSurfaceVisible, setArtifactSurfaceVisible] = useState(!ambientState);
  const hadAmbientFeedback = useRef(Boolean(ambientState));

  useEffect(() => {
    if (ambientState) {
      hadAmbientFeedback.current = true;
      setArtifactSurfaceVisible(false);
      return;
    }
    if (!hadAmbientFeedback.current) {
      setArtifactSurfaceVisible(true);
      return;
    }
    hadAmbientFeedback.current = false;
    setArtifactSurfaceVisible(true);
  }, [ambientState]);

  return (
    <div className="border-t border-border px-3 py-2 space-y-3" data-testid="generated-media-expanded">
      <GenerationObservation
        envelope={envelope}
        isVisible={isProgressVisible}
        onShow={() => setIsProgressVisible(true)}
        onHide={() => setIsProgressVisible(false)}
      />
      {showVisualSlot && (
        <section
          aria-label="generated media visual"
          data-testid="generated-media-visual-slot"
          className="min-h-32 overflow-hidden transition-[min-height] duration-200 ease-out motion-reduce:transition-none sm:min-h-40"
        >
          {ambientState ? (
            <GeneratedMediaAmbientFeedback
              mediaKind={envelope.mediaKind === "video" ? "video" : "music"}
              state={ambientState}
            />
          ) : (
            <div className={`transition-opacity duration-200 ease-out motion-reduce:transition-none ${artifactSurfaceVisible ? "opacity-100" : "opacity-0"}`}>
              <ArtifactPlayback envelope={envelope} />
            </div>
          )}
        </section>
      )}
      <section aria-label="generation request" className="space-y-1">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">Prompt</p>
        <p className="text-xs text-foreground whitespace-pre-wrap break-words">{envelope.promptSummary || "No prompt summary was saved."}</p>
        <p className="text-[0.65rem] text-foreground-muted">{envelope.model} · {safeSettingsSummary(envelope.settings)}</p>
      </section>
      <RecoveryActions actions={envelope.recoveryActions} />
    </div>
  );
}

function collapsedSummary({ resultText }: Pick<ToolRendererProps, "resultText">): string {
  const envelope = parseGeneratedMediaEnvelope(resultText);
  if (!envelope) return "Generate media";
  return `Generate ${envelope.mediaKind} · ${generatedMediaStateLabel(envelope.state)}`;
}

export const generatedMediaRenderer: ToolRenderer = {
  collapsedSummary,
  autoExpandOnResult: true,
  ExpandedBody: GeneratedMediaExpanded,
};
