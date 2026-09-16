import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { FrameRate, Sequence } from "../edl";
import {
  advanceTimelineInteraction,
  beginTimelineInteraction,
  cancelTimelineInteraction,
  isActiveTimelineInteraction,
  resetTimelineInteraction,
  type TimelineInteractionState,
} from "./interaction-state";
import { buildTimelineSnapIndex, resolveTimelineSnap, type TimelineSnapResult, type TimelineSnapTarget } from "./snap-index";
import { frameRateToFramesPerSecond, frameToSeconds, sequenceFrameRate, secondsToFrame } from "./timing";
import { secondsToPixels, timelineTickStep } from "./timeline-utils";

export type TimelineRange = {
  inSec: number;
  outSec: number;
};

type RangeDragMode = "in" | "out";

type RangeGesture = {
  mode: RangeDragMode;
  pointerId: number;
  captureTarget: HTMLDivElement;
  initialRange: TimelineRange;
};

type PlayheadGesture = {
  pointerId: number;
  captureTarget: HTMLDivElement;
  startSec: number;
  startX: number;
  moved: boolean;
};

export type RulerProps = {
  sequence: Sequence;
  durationSec: number;
  pixelsPerSecond: number;
  playheadSec: number;
  onScrub: (seconds: number) => void;
  /** Local-only range presentation; it has no edit command in this fixture. */
  range?: TimelineRange | undefined;
  snapEnabled?: boolean | undefined;
  /** No clips means no editable range or transport gesture. */
  interactive?: boolean | undefined;
  onRangeChange?: ((range: TimelineRange) => void) | undefined;
};

export type RangeWingKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function rangeForKeyboardKey(
  range: TimelineRange,
  mode: RangeDragMode,
  key: RangeWingKey,
  durationSec: number,
  frameRate: FrameRate,
): TimelineRange {
  const inFrame = secondsToFrame(Math.min(range.inSec, range.outSec), frameRate);
  const outFrame = secondsToFrame(Math.max(range.inSec, range.outSec), frameRate);
  const durationFrame = Math.max(outFrame, secondsToFrame(durationSec, frameRate));
  if (mode === "in") {
    const frame = key === "Home" ? 0 : key === "End" ? outFrame : Math.min(outFrame, Math.max(0, inFrame + (key === "ArrowLeft" ? -1 : 1)));
    return { inSec: frameToSeconds(frame, frameRate), outSec: frameToSeconds(outFrame, frameRate) };
  }
  const frame = key === "Home" ? inFrame : key === "End" ? durationFrame : Math.max(inFrame, Math.min(durationFrame, outFrame + (key === "ArrowLeft" ? -1 : 1)));
  return { inSec: frameToSeconds(inFrame, frameRate), outSec: frameToSeconds(frame, frameRate) };
}

export function resolvePlayheadPointerSeconds(
  sequence: Sequence,
  durationSec: number,
  clientX: number,
  rulerLeft: number,
  pixelsPerSecond: number,
  snapEnabled: boolean,
  altKey: boolean,
  previousTarget?: TimelineSnapTarget,
): TimelineSnapResult {
  const rate = sequenceFrameRate(sequence);
  const rawSeconds = Math.min(durationSec, Math.max(0, (clientX - rulerLeft) / pixelsPerSecond));
  return resolveTimelineSnap(buildTimelineSnapIndex(sequence), {
    frame: rawSeconds * frameRateToFramesPerSecond(rate),
    pixelsPerSecond,
    enabled: snapEnabled && !altKey,
    previousTarget,
  });
}

export function restorePlayheadOnCancel(startSec: number, onScrub: (seconds: number) => void): void {
  onScrub(startSec);
}

export function Ruler({
  sequence,
  durationSec,
  pixelsPerSecond,
  playheadSec,
  onScrub,
  range,
  snapEnabled = true,
  interactive = true,
  onRangeChange,
}: RulerProps): ReactElement {
  const rulerRef = useRef<HTMLDivElement>(null);
  const rangeGestureRef = useRef<RangeGesture | null>(null);
  const playheadGestureRef = useRef<PlayheadGesture | null>(null);
  const interactionRef = useRef<TimelineInteractionState>(resetTimelineInteraction());
  const totalSec = durationSec + 2;
  // Keep labels readable at Fit and at close zoom. This changes display only,
  // never the frame grid or snapping tolerance.
  const tickStep = timelineTickStep(pixelsPerSecond);
  const ticks = Array.from({ length: Math.floor(totalSec / tickStep) + 1 }, (_, index) => Number((index * tickStep).toFixed(3)));
  const activeRange = range ?? { inSec: playheadSec, outSec: playheadSec };
  const rangeStart = Math.min(activeRange.inSec, activeRange.outSec);
  const rangeEnd = Math.max(activeRange.inSec, activeRange.outSec);
  const constrainPlayhead = (seconds: number) => rangeEnd > rangeStart ? Math.max(rangeStart, Math.min(rangeEnd, seconds)) : seconds;

  const resetRangeInteraction = () => {
    interactionRef.current = resetTimelineInteraction();
  };

  const cancelRangeGesture = () => {
    const gesture = rangeGestureRef.current;
    if (!gesture) return;
    interactionRef.current = cancelTimelineInteraction(interactionRef.current);
    if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    rangeGestureRef.current = null;
    onRangeChange?.(gesture.initialRange);
    resetRangeInteraction();
  };

  const cancelPlayheadGesture = () => {
    const gesture = playheadGestureRef.current;
    if (!gesture) return;
    interactionRef.current = cancelTimelineInteraction(interactionRef.current);
    if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    playheadGestureRef.current = null;
    restorePlayheadOnCancel(gesture.startSec, onScrub);
    resetRangeInteraction();
  };

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (playheadGestureRef.current) {
          event.preventDefault();
          cancelPlayheadGesture();
        } else if (rangeGestureRef.current) {
          event.preventDefault();
          cancelRangeGesture();
        }
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  });

  const proposedRange = (clientX: number, altKey: boolean): TimelineRange | null => {
    const gesture = rangeGestureRef.current;
    const rect = rulerRef.current?.getBoundingClientRect();
    const interaction = interactionRef.current;
    if (!gesture || !rect || !isActiveTimelineInteraction(interaction)) return null;
    const rate = sequenceFrameRate(sequence);
    const rawSeconds = Math.max(0, (clientX - rect.left) / pixelsPerSecond);
    const rawFrame = rawSeconds * frameRateToFramesPerSecond(rate);
    const snap = resolveTimelineSnap(buildTimelineSnapIndex(sequence, { playheadSec }), {
      frame: rawFrame,
      pixelsPerSecond,
      enabled: snapEnabled && !altKey,
      previousTarget: interaction.snap?.target,
    });
    const next = gesture.mode === "in"
      ? { inSec: Math.min(snap.seconds, gesture.initialRange.outSec), outSec: gesture.initialRange.outSec }
      : { inSec: gesture.initialRange.inSec, outSec: Math.max(snap.seconds, gesture.initialRange.inSec) };
    interactionRef.current = advanceTimelineInteraction(interaction, {
      current: { pointer: { x: clientX, y: rect.top }, frame: rawFrame },
      proposal: next,
      snap,
    });
    return next;
  };

  const updateRange = (clientX: number, altKey: boolean) => {
    const next = proposedRange(clientX, altKey);
    if (next) onRangeChange?.(next);
  };

  const beginRangeDrag = (event: ReactPointerEvent<HTMLDivElement>, mode: RangeDragMode) => {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = rulerRef.current?.getBoundingClientRect();
    const rate = sequenceFrameRate(sequence);
    const startSeconds = mode === "in" ? rangeStart : rangeEnd;
    interactionRef.current = beginTimelineInteraction({
      kind: "range-wing",
      start: {
        pointer: { x: event.clientX, y: event.clientY },
        frame: secondsToFrame(startSeconds, rate),
      },
      proposal: activeRange,
    });
    rangeGestureRef.current = { mode, pointerId: event.pointerId, captureTarget: event.currentTarget, initialRange: activeRange };
    if (rect) updateRange(event.clientX, event.altKey);
  };

  const finishRangeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = rangeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    updateRange(event.clientX, event.altKey);
    if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    rangeGestureRef.current = null;
    resetRangeInteraction();
  };

  const advancePlayheadDrag = (clientX: number, clientY: number, altKey: boolean) => {
    const gesture = playheadGestureRef.current;
    const rect = rulerRef.current?.getBoundingClientRect();
    const interaction = interactionRef.current;
    if (!gesture || !rect || !isActiveTimelineInteraction(interaction)) return;
    // A small pointer-intent dead zone keeps incidental hand movement a tap;
    // an intentional drag leaves the range intact.
    if (!gesture.moved && Math.abs(clientX - gesture.startX) < 3) return;
    gesture.moved = true;
    const snap = resolvePlayheadPointerSeconds(
      sequence,
      durationSec,
      clientX,
      rect.left,
      pixelsPerSecond,
      snapEnabled,
      altKey,
      interaction.snap?.target,
    );
    interactionRef.current = advanceTimelineInteraction(interaction, {
      current: { pointer: { x: clientX, y: clientY }, frame: snap.rawFrame },
      proposal: { playheadSec: snap.seconds },
      snap,
    });
    onScrub(constrainPlayhead(snap.seconds));
  };

  const beginPlayheadDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rate = sequenceFrameRate(sequence);
    interactionRef.current = beginTimelineInteraction({
      kind: "playhead",
      start: {
        pointer: { x: event.clientX, y: event.clientY },
        frame: secondsToFrame(playheadSec, rate),
      },
      proposal: { playheadSec },
    });
    playheadGestureRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      startSec: playheadSec,
      startX: event.clientX,
      moved: false,
    };
  };

  const finishPlayheadDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = playheadGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    advancePlayheadDrag(event.clientX, event.clientY, event.altKey);
    if (!gesture.moved) {
      onRangeChange?.({ inSec: playheadSec, outSec: playheadSec });
      onScrub(playheadSec);
    }
    if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    playheadGestureRef.current = null;
    resetRangeInteraction();
  };

  const handleRangeKey = (event: ReactKeyboardEvent<HTMLDivElement>, mode: RangeDragMode) => {
    if (event.key === "Escape") {
      if (rangeGestureRef.current) {
        event.preventDefault();
        cancelRangeGesture();
      }
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    event.stopPropagation();
    onRangeChange?.(rangeForKeyboardKey(activeRange, mode, event.key, durationSec, sequenceFrameRate(sequence)));
  };

  return (
    <div
      ref={rulerRef}
      className="video-ruler"
      style={{ width: secondsToPixels(totalSec, pixelsPerSecond) }}
      onPointerDown={(event) => {
        if (!interactive) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const rate = sequenceFrameRate(sequence);
        onScrub(constrainPlayhead(frameToSeconds(secondsToFrame(Math.max(0, (event.clientX - rect.left) / pixelsPerSecond), rate), rate)));
      }}
      onPointerMove={(event) => {
        if (rangeGestureRef.current?.pointerId === event.pointerId) updateRange(event.clientX, event.altKey);
      }}
      onPointerUp={finishRangeDrag}
      onPointerCancel={cancelRangeGesture}
    >
      {ticks.map((second) => (
        <div className="video-ruler__tick" key={second} style={{ left: secondsToPixels(second, pixelsPerSecond) }}>
          <span>{second}s</span>
        </div>
      ))}
      {interactive ? <div
        aria-label={`Selected timeline range ${rangeStart.toFixed(2)} to ${rangeEnd.toFixed(2)} seconds`}
        className="video-ruler__range"
        style={{
          position: "absolute", top: 0, bottom: 0, left: secondsToPixels(rangeStart, pixelsPerSecond), width: Math.max(2, secondsToPixels(rangeEnd - rangeStart, pixelsPerSecond)),
          background: "repeating-linear-gradient(135deg, color-mix(in srgb, #2ecf97 30%, transparent) 0 4px, color-mix(in srgb, #eeb546 24%, transparent) 4px 8px)",
          borderInline: "1px solid currentColor", color: "#2ecf97", pointerEvents: "none",
        }}
      /> : null}
      <div className="video-ruler__playhead" style={{ left: secondsToPixels(playheadSec, pixelsPerSecond) }} />
      {interactive ? (
        <div
          className="video-ruler__playhead-handle"
          role="slider"
          tabIndex={0}
          aria-label="Move playhead"
          aria-valuemin={0}
          aria-valuemax={durationSec}
          aria-valuenow={playheadSec}
          title="Tap to clear selection · Drag playhead · Alt/Option bypasses snap · Escape cancels"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault(); event.stopPropagation();
              onRangeChange?.({ inSec: playheadSec, outSec: playheadSec });
              onScrub(playheadSec);
            }
          }}
          style={{
            position: "absolute",
            left: secondsToPixels(playheadSec, pixelsPerSecond),
            top: 0,
            zIndex: 7,
            width: 12,
            height: 30,
            transform: "translateX(-50%)",
            border: "2px solid #27c3d9",
            borderRadius: 4,
            background: "color-mix(in srgb, #27c3d9 24%, var(--video-panel))",
            cursor: "ew-resize",
            touchAction: "none",
          }}
          onPointerDown={beginPlayheadDrag}
          onPointerMove={(event) => {
            if (playheadGestureRef.current?.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            advancePlayheadDrag(event.clientX, event.clientY, event.altKey);
          }}
          onPointerUp={finishPlayheadDrag}
          onPointerCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cancelPlayheadGesture();
          }}
        />
      ) : null}
      {interactive ? <div
        className="video-ruler__range-wing video-ruler__range-wing--in"
        role="slider" tabIndex={0} aria-label="Range in handle" aria-valuemin={0} aria-valuemax={rangeEnd} aria-valuenow={rangeStart}
        title="Selection start — Arrow keys step one frame; Home/End use bounds; Alt/Option bypasses snap; Escape cancels a drag"
        style={{ position: "absolute", left: secondsToPixels(rangeStart, pixelsPerSecond), top: 1, zIndex: 5, transform: "translateX(-100%)", padding: "2px 4px", border: "1px solid #2ecf97", borderRadius: "4px 0 0 4px", background: "var(--video-panel)", color: "#2ecf97", cursor: "ew-resize", fontSize: "0.62rem", fontWeight: 800, touchAction: "none" }}
        onPointerDown={(event) => beginRangeDrag(event, "in")}
        onKeyDown={(event) => handleRangeKey(event, "in")}
      >
        IN
      </div> : null}
      {interactive ? <div
        className="video-ruler__range-wing video-ruler__range-wing--out"
        role="slider" tabIndex={0} aria-label="Range out handle" aria-valuemin={rangeStart} aria-valuemax={durationSec} aria-valuenow={rangeEnd}
        title="Selection end — Arrow keys step one frame; Home/End use bounds; Alt/Option bypasses snap; Escape cancels a drag"
        style={{ position: "absolute", left: secondsToPixels(rangeEnd, pixelsPerSecond), top: 1, zIndex: 5, padding: "2px 4px", border: "1px solid #eeb546", borderRadius: "0 4px 4px 0", background: "var(--video-panel)", color: "#eeb546", cursor: "ew-resize", fontSize: "0.62rem", fontWeight: 800, touchAction: "none" }}
        onPointerDown={(event) => beginRangeDrag(event, "out")}
        onKeyDown={(event) => handleRangeKey(event, "out")}
      >
        OUT
      </div> : null}
    </div>
  );
}
