import { useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { ClipFadeHandles, FADE_DRAG_TYPE, FadeContext } from "../FadeControls";
import { TransitionBadge, TransitionContext, TRANSITION_DRAG_TYPE } from "../TransitionControls";
import { FADE_KEYS, type FadeKey } from "../fades";
import { TimelineMenu } from "./TimelineMenu";
import type { Clip, FrameRate, MediaAsset, Sequence, Track } from "../edl";
import { ClipMediaVisual } from "./ClipMediaVisual";
import {
  advanceTimelineInteraction,
  beginTimelineInteraction,
  cancelTimelineInteraction,
  isActiveTimelineInteraction,
  resetTimelineInteraction,
  type TimelineInteractionState,
} from "./interaction-state";
import { buildTimelineSnapIndex, resolveTimelineMoveSnap, resolveTimelineSnap, type TimelineSnapTarget } from "./snap-index";
import { frameRateToFramesPerSecond, frameToSeconds, secondsToFrame, sequenceFrameRate } from "./timing";
import { nextTrimLeft, nextTrimRight, secondsToPixels, TIMELINE_TRACK_HEIGHT_PX, trackAtVerticalOffset } from "./timeline-utils";

type DragMode = "move" | "trim-left" | "trim-right";

export type ClipMoveRequest = {
  clipId: string;
  toTrackId: string;
  timelineStartSec: number;
};

export type ClipTrimLeftRequest = {
  clipId: string;
  timelineStartSec: number;
  durationSec: number;
  sourceDeltaSec: number;
};

export type ClipTrimRightRequest = {
  clipId: string;
  durationSec: number;
};

export type ClipGestureProposal = {
  clipId: string;
  mode: DragMode;
  timelineStartSec: number;
  durationSec: number;
  toTrackId: string;
};

export type ClipGesturePreview = ClipGestureProposal & {
  snapTarget: TimelineSnapTarget | null;
  snapDisabledByModifier: boolean;
  /** Shift+trim is feedback only; the ordinary trim remains the sole commit. */
  ripplePreview: boolean;
};

type GestureSession = {
  mode: DragMode;
  pointerId: number;
  captureTarget: HTMLDivElement;
  trackHeightPx: number;
  moved: boolean;
  committed: boolean;
};

export type ClipBlockProps = {
  clip: Clip;
  asset?: MediaAsset | undefined;
  sequence: Sequence;
  orderedTracks: readonly Track[];
  selected: boolean;
  selectedClipIds?: ReadonlySet<string> | undefined;
  pixelsPerSecond: number;
  playheadSec: number;
  snapEnabled?: boolean | undefined;
  locked?: boolean | undefined;
  protectionReason?: string | undefined;
  onSelect: (clipId: string, additive?: boolean, preserveSelection?: boolean) => void;
  /** Presentation-only; it never mutates the sequence. */
  onPreviewChange?: ((preview: ClipGesturePreview | null) => void) | undefined;
  onMove: (request: ClipMoveRequest) => void;
  onTrimLeft: (request: ClipTrimLeftRequest) => void;
  onTrimRight: (request: ClipTrimRightRequest) => void;
  onSeparateAudio?: ((clipId: string) => void) | undefined;
  /** Parent-owned canonical delete command; clips never own media-bin removal. */
  onDeleteClip?: ((clipId: string) => void) | undefined;
};

function clipLabel(clip: Clip): string {
  const text = typeof clip.props["text"] === "string" ? clip.props["text"] : null;
  const label = typeof clip.props["label"] === "string" ? clip.props["label"] : null;
  return text?.trim() || label?.trim() || clip.mediaId || `${clip.kind} clip`;
}

function proposalFor(
  clip: Clip,
  mode: DragMode,
  proposedSeconds: number,
  targetTrackId: string,
  frameRate: FrameRate,
): ClipGestureProposal {
  if (mode === "move") {
    return { clipId: clip.id, mode, timelineStartSec: proposedSeconds, durationSec: clip.durationSec, toTrackId: targetTrackId };
  }
  if (mode === "trim-left") {
    const next = nextTrimLeft(clip.timelineStartSec, clip.durationSec, proposedSeconds - clip.timelineStartSec, frameToSeconds(1, frameRate));
    return { clipId: clip.id, mode, ...next, toTrackId: clip.trackId };
  }
  const next = nextTrimRight(clip.durationSec, proposedSeconds - (clip.timelineStartSec + clip.durationSec), frameToSeconds(1, frameRate));
  return { clipId: clip.id, mode, timelineStartSec: clip.timelineStartSec, ...next, toTrackId: clip.trackId };
}

export function trimProposalForKeyboard(
  clip: Clip,
  mode: Exclude<DragMode, "move">,
  key: "ArrowLeft" | "ArrowRight",
  frameRate: FrameRate,
): ClipGestureProposal {
  const boundarySec = mode === "trim-left" ? clip.timelineStartSec : clip.timelineStartSec + clip.durationSec;
  const boundaryFrame = secondsToFrame(boundarySec, frameRate);
  const proposedSeconds = frameToSeconds(Math.max(0, boundaryFrame + (key === "ArrowLeft" ? -1 : 1)), frameRate);
  return proposalFor(clip, mode, proposedSeconds, clip.trackId, frameRate);
}

export function isRipplePreview(mode: DragMode, shiftKey: boolean): boolean {
  return shiftKey && mode !== "move";
}

export function commitTrimProposal(
  proposal: ClipGestureProposal,
  originalClip: Clip,
  onTrimLeft: (request: ClipTrimLeftRequest) => void,
  onTrimRight: (request: ClipTrimRightRequest) => void,
): boolean {
  if (proposal.mode === "trim-left") {
    onTrimLeft({
      clipId: proposal.clipId,
      timelineStartSec: proposal.timelineStartSec,
      durationSec: proposal.durationSec,
      sourceDeltaSec: proposal.timelineStartSec - originalClip.timelineStartSec,
    });
    return true;
  }
  if (proposal.mode === "trim-right") {
    onTrimRight({ clipId: proposal.clipId, durationSec: proposal.durationSec });
    return true;
  }
  return false;
}

function isClipGestureProposal(proposal: Record<string, unknown>): proposal is ClipGestureProposal {
  return typeof proposal["clipId"] === "string"
    && (proposal["mode"] === "move" || proposal["mode"] === "trim-left" || proposal["mode"] === "trim-right")
    && typeof proposal["timelineStartSec"] === "number"
    && typeof proposal["durationSec"] === "number"
    && typeof proposal["toTrackId"] === "string";
}

/**
 * Uses the shared transient interaction state plus the derived snap index.
 * Seconds remain canonical: only the pointer proposal crosses into frames.
 */
export function ClipBlock({
  clip,
  asset,
  sequence,
  orderedTracks,
  selected,
  selectedClipIds,
  pixelsPerSecond,
  playheadSec,
  snapEnabled = true,
  locked = false,
  protectionReason = "Unlock track to edit",
  onSelect,
  onPreviewChange,
  onMove,
  onTrimLeft,
  onTrimRight,
  onSeparateAudio,
  onDeleteClip,
}: ClipBlockProps): ReactElement {
  const fadeContext = useContext(FadeContext);
  const transitionContext = useContext(TransitionContext);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [preview, setPreview] = useState<ClipGesturePreview | null>(null);
  const [interaction, setInteraction] = useState<TimelineInteractionState>(() => resetTimelineInteraction());
  const sessionRef = useRef<GestureSession | null>(null);
  const interactionRef = useRef<TimelineInteractionState>(resetTimelineInteraction());
  const keyboardPreviewTimerRef = useRef<number | null>(null);

  const setTransientInteraction = (next: TimelineInteractionState) => {
    interactionRef.current = next;
    setInteraction(next);
  };

  const clearPreview = () => {
    setPreview(null);
    onPreviewChange?.(null);
  };

  const releaseSession = () => {
    const session = sessionRef.current;
    if (session?.captureTarget.hasPointerCapture(session.pointerId)) session.captureTarget.releasePointerCapture(session.pointerId);
    sessionRef.current = null;
  };

  const cancelGesture = () => {
    const cancelled = cancelTimelineInteraction(interactionRef.current);
    setTransientInteraction(cancelled);
    releaseSession();
    clearPreview();
    setTransientInteraction(resetTimelineInteraction());
  };

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && sessionRef.current) {
        event.preventDefault();
        cancelGesture();
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  });

  useEffect(() => () => {
    if (keyboardPreviewTimerRef.current !== null) window.clearTimeout(keyboardPreviewTimerRef.current);
  }, []);

  const advanceProposal = (clientX: number, clientY: number, altKey: boolean, shiftKey: boolean): ClipGesturePreview | null => {
    const session = sessionRef.current;
    const current = interactionRef.current;
    if (!session || !isActiveTimelineInteraction(current)) return null;

    const rate = sequenceFrameRate(sequence);
    const framesPerSecond = frameRateToFramesPerSecond(rate);
    const startSeconds = session.mode === "trim-right" ? clip.timelineStartSec + clip.durationSec : clip.timelineStartSec;
    const rawFrame = Math.max(0, (startSeconds + (clientX - current.start.pointer.x) / pixelsPerSecond) * framesPerSecond);
    const snapIndex = buildTimelineSnapIndex(sequence, {
        playheadSec,
        ...(current.start.selectionIds ? { activeClipIds: current.start.selectionIds } : {}),
      });
    const snapQuery = {
        frame: rawFrame,
        pixelsPerSecond,
        enabled: snapEnabled && !altKey,
        previousTarget: current.snap?.target,
      };
    const snap = session.mode === "move"
      ? resolveTimelineMoveSnap(snapIndex, snapQuery, clip.durationSec * framesPerSecond)
      : resolveTimelineSnap(snapIndex, snapQuery);
    const targetTrack = trackAtVerticalOffset(orderedTracks, clientY - current.start.pointer.y, clip.trackId, session.trackHeightPx);
    const proposal = proposalFor(clip, session.mode, snap.seconds, targetTrack?.id ?? clip.trackId, rate);
    const advanced = advanceTimelineInteraction(current, {
      current: { pointer: { x: clientX, y: clientY }, frame: rawFrame },
      proposal,
      snap,
    });
    setTransientInteraction(advanced);
    if (clientX !== current.start.pointer.x || clientY !== current.start.pointer.y) session.moved = true;
    if (!isActiveTimelineInteraction(advanced) || !isClipGestureProposal(advanced.proposal)) return null;

    const next: ClipGesturePreview = {
      ...advanced.proposal,
      snapTarget: advanced.snap?.target ?? null,
      snapDisabledByModifier: altKey,
      ripplePreview: isRipplePreview(session.mode, shiftKey),
    };
    setPreview(next);
    onPreviewChange?.(next);
    return next;
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const additive = mode === "move" && (event.shiftKey || event.metaKey || event.ctrlKey);
    onSelect(clip.id, additive, mode === "move" && selected && !additive);
    if (locked) return;
    // Additive activation of an already-selected clip removes it. It must not
    // start a drag after the parent has removed the anchor from its selection.
    if (additive && selected) return;
    const captureTarget = event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    const laneHeight = captureTarget.closest<HTMLElement>(".video-track__lane")?.getBoundingClientRect().height;
    const trackHeightPx = laneHeight && laneHeight > 0 ? laneHeight : TIMELINE_TRACK_HEIGHT_PX;
    const rate = sequenceFrameRate(sequence);
    const startSeconds = mode === "trim-right" ? clip.timelineStartSec + clip.durationSec : clip.timelineStartSec;
    const initialProposal = proposalFor(clip, mode, startSeconds, clip.trackId, rate);
    const started = beginTimelineInteraction({
      kind: mode,
      start: {
        pointer: { x: event.clientX, y: event.clientY },
        frame: startSeconds * frameRateToFramesPerSecond(rate),
        selectionIds: additive
          ? [...(selectedClipIds ?? []), clip.id]
          : selected && selectedClipIds?.size
            ? [...selectedClipIds]
            : [clip.id],
      },
      proposal: initialProposal,
    });
    setTransientInteraction(started);
    sessionRef.current = { mode, pointerId: event.pointerId, captureTarget, trackHeightPx, moved: false, committed: false };
    advanceProposal(event.clientX, event.clientY, event.altKey, event.shiftKey);
  };

  const commitGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId || session.committed) return;
    const next = advanceProposal(event.clientX, event.clientY, event.altKey, event.shiftKey);
    const state = interactionRef.current;
    if (!next || !isActiveTimelineInteraction(state) || !isClipGestureProposal(state.proposal)) return;
    session.committed = true;
    const proposal = state.proposal;

    // Selection happens on pointer-down; a click is not an edit gesture.
    if (proposal.mode === "move" && !session.moved) {
      releaseSession();
      clearPreview();
      setTransientInteraction(resetTimelineInteraction());
      return;
    }

    // The only durable edit boundary: one existing callback from one final proposal.
    if (proposal.mode === "move") {
      onMove({ clipId: proposal.clipId, toTrackId: proposal.toTrackId, timelineStartSec: proposal.timelineStartSec });
    } else {
      commitTrimProposal(proposal, clip, onTrimLeft, onTrimRight);
    }
    releaseSession();
    clearPreview();
    setTransientInteraction(resetTimelineInteraction());
  };

  const commitKeyboardTrim = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    mode: Exclude<DragMode, "move">,
  ) => {
    if (locked) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(clip.id);
    const rate = sequenceFrameRate(sequence);
    const proposal = trimProposalForKeyboard(clip, mode, event.key, rate);
    const startFrame = secondsToFrame(mode === "trim-left" ? clip.timelineStartSec : clip.timelineStartSec + clip.durationSec, rate);
    const started = beginTimelineInteraction({
      kind: mode,
      start: { pointer: { x: 0, y: 0 }, frame: startFrame, selectionIds: [clip.id] },
      proposal: proposalFor(clip, mode, mode === "trim-left" ? clip.timelineStartSec : clip.timelineStartSec + clip.durationSec, clip.trackId, rate),
    });
    const advanced = advanceTimelineInteraction(started, {
      current: { pointer: { x: 0, y: 0 }, frame: secondsToFrame(mode === "trim-left" ? proposal.timelineStartSec : proposal.timelineStartSec + proposal.durationSec, rate) },
      proposal,
    });
    setTransientInteraction(advanced);
    const nextPreview: ClipGesturePreview = {
      ...proposal,
      snapTarget: null,
      snapDisabledByModifier: false,
      ripplePreview: isRipplePreview(mode, event.shiftKey),
    };
    setPreview(nextPreview);
    onPreviewChange?.(nextPreview);

    // A keyboard arrow is one discrete gesture and one ordinary trim commit.
    commitTrimProposal(proposal, clip, onTrimLeft, onTrimRight);
    setTransientInteraction(resetTimelineInteraction());
    if (keyboardPreviewTimerRef.current !== null) window.clearTimeout(keyboardPreviewTimerRef.current);
    keyboardPreviewTimerRef.current = window.setTimeout(() => {
      clearPreview();
      keyboardPreviewTimerRef.current = null;
    }, 900);
  };

  const renderStartSec = preview?.timelineStartSec ?? clip.timelineStartSec;
  const renderDurationSec = preview?.durationSec ?? clip.durationSec;
  const verticalOffset = preview?.mode === "move"
    ? (orderedTracks.findIndex((track) => track.id === preview.toTrackId) - orderedTracks.findIndex((track) => track.id === clip.trackId)) * (sessionRef.current?.trackHeightPx ?? TIMELINE_TRACK_HEIGHT_PX)
    : 0;
  const style: CSSProperties = {
    left: secondsToPixels(renderStartSec, pixelsPerSecond),
    width: Math.max(24, secondsToPixels(renderDurationSec, pixelsPerSecond)),
    transform: verticalOffset ? `translateY(${verticalOffset}px)` : undefined,
    zIndex: preview ? 6 : undefined,
    opacity: preview ? 0.84 : undefined,
    outline: preview ? "2px dashed currentColor" : undefined,
    outlineOffset: preview ? 2 : undefined,
  };

  return (
    <><div
      className={`video-clip video-clip--${clip.kind}${selected ? " video-clip--selected" : ""}${preview ? " video-clip--ghost" : ""}`}
      style={style}
      role="button"
      tabIndex={locked ? -1 : 0}
      title={locked ? protectionReason : undefined}
      aria-label={`${clip.kind} clip ${clip.id}${interaction.kind !== "idle" ? `, ${interaction.kind} preview` : ""}`}
      aria-disabled={locked}
      aria-describedby={preview?.snapTarget || preview?.ripplePreview ? `timeline-feedback-${clip.id}` : undefined}
      onDragOver={(event) => { if (!locked && (event.dataTransfer.types.includes(FADE_DRAG_TYPE) || event.dataTransfer.types.includes(TRANSITION_DRAG_TYPE))) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; } }}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes(TRANSITION_DRAG_TYPE)) {
          event.preventDefault(); event.stopPropagation(); if (locked) return;
          const kind = event.dataTransfer.getData(TRANSITION_DRAG_TYPE);
          if (kind !== "crossfade" && kind !== "swipe") return;
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientX > rect.left + rect.width / 2;
          const edge = clip.timelineStartSec + clip.durationSec;
          const next = after ? sequence.tracks.find((t) => t.id === clip.trackId)?.clips.find((c) => c.id !== clip.id && Math.abs(c.timelineStartSec - edge) <= Number.EPSILON * 16 * Math.max(1, Math.abs(edge))) : undefined;
          if (after && !next) { transitionContext?.reject("No adjoining clip at this edge. Close the gap or drop at another cut; nothing was changed."); return; }
          transitionContext?.drop(next?.id ?? clip.id, kind);
          return;
        }
        if (!event.dataTransfer.types.includes(FADE_DRAG_TYPE)) return;
        event.preventDefault(); event.stopPropagation(); if (locked) return;
        const key = event.dataTransfer.getData(FADE_DRAG_TYPE) as FadeKey;
        if (FADE_KEYS.includes(key)) fadeContext?.drop(clip.id, key);
      }}
      onPointerDown={(event) => beginDrag(event, "move")}
      onPointerMove={(event) => {
        if (sessionRef.current?.pointerId === event.pointerId) advanceProposal(event.clientX, event.clientY, event.altKey, event.shiftKey);
      }}
      onPointerUp={commitGesture}
      onPointerCancel={cancelGesture}
      aria-haspopup={clip.kind === "video" ? "menu" : undefined}
      onContextMenu={(event) => {
        if (locked) { event.preventDefault(); return; }
        if (clip.kind !== "video") return;
        event.preventDefault(); event.stopPropagation(); cancelGesture();
        event.currentTarget.focus(); onSelect(clip.id);
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (locked) return;
        if (event.key === "Enter" || event.key === " ") onSelect(clip.id);
        if (clip.kind === "video" && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
          event.preventDefault(); event.stopPropagation(); onSelect(clip.id);
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom });
        }
      }}
    >
      <div
        className="video-clip__trim video-clip__trim--left"
        role="slider"
        tabIndex={locked ? -1 : 0}
        aria-label="Trim clip start by one frame"
        aria-valuemin={0}
        aria-valuemax={clip.timelineStartSec + clip.durationSec}
        aria-valuenow={renderStartSec}
        title={locked ? protectionReason : "Trim start · Arrow keys step one frame · Shift previews ripple without changing neighbors"}
        onPointerDown={(event) => beginDrag(event, "trim-left")}
        onKeyDown={(event) => commitKeyboardTrim(event, "trim-left")}
      />
      <div className="video-clip__content">
        <strong>{asset?.label ?? clipLabel(clip)}</strong>
        <span>
          {renderStartSec.toFixed(2)}s · {renderDurationSec.toFixed(2)}s{preview ? " · Preview" : ""}
        </span>
        {clip.kind === "video" || clip.kind === "audio" ? <ClipMediaVisual clip={clip} asset={asset} framesPerSecond={frameRateToFramesPerSecond(sequenceFrameRate(sequence))} /> : null}
      </div>
      <ClipFadeHandles clip={clip} pixelsPerSecond={pixelsPerSecond} frameSec={sequence.frameRate.denominator / sequence.frameRate.numerator} locked={locked} />
      <div
        className="video-clip__trim video-clip__trim--right"
        role="slider"
        tabIndex={locked ? -1 : 0}
        aria-label="Trim clip end by one frame"
        aria-valuemin={clip.timelineStartSec}
        aria-valuemax={Math.max(sequence.durationSec, clip.timelineStartSec + clip.durationSec)}
        aria-valuenow={renderStartSec + renderDurationSec}
        title={locked ? protectionReason : "Trim end · Arrow keys step one frame · Shift previews ripple without changing neighbors"}
        onPointerDown={(event) => beginDrag(event, "trim-right")}
        onKeyDown={(event) => commitKeyboardTrim(event, "trim-right")}
      />
      {preview?.snapTarget || preview?.ripplePreview ? (
        <span id={`timeline-feedback-${clip.id}`} hidden>
          {preview.ripplePreview ? "RIPPLE PREVIEW, no neighboring clips changed" : `Snapped to ${preview.snapTarget?.label}`}
        </span>
      ) : null}
    </div><TransitionBadge clip={clip} pixelsPerSecond={pixelsPerSecond} frameSec={sequence.frameRate.denominator / sequence.frameRate.numerator} locked={locked} />{menu ? <TimelineMenu {...menu} onClose={closeMenu} items={[
      { label: "Delete clip", disabled: locked || !onDeleteClip, run: () => onDeleteClip?.(clip.id) },
      { label: "Separate audio", disabled: locked || !clip.mediaId || !onSeparateAudio || sequence.tracks.some((track) => track.clips.some((peer) => peer.kind === "audio" && peer.mediaId === clip.mediaId && clip.linkedClipIds?.includes(peer.id))), run: () => onSeparateAudio?.(clip.id) },
    ]} /> : null}</>
  );
}
