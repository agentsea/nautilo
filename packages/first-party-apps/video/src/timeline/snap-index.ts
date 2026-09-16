// Pure, derived timeline snap targets. This module has no UI or persistence
// side effects; a gesture may retain its returned result as transient feedback.

import { type Clip, type FrameRate, type Sequence } from "../edl";
import { frameRateToFramesPerSecond, frameToSeconds, sequenceFrameRate } from "./timing";

export type TimelineSnapTargetKind =
  | "sequence-start"
  | "sequence-end"
  | "clip-start"
  | "clip-end"
  | "cut"
  | "playhead"
  | "marker"
  | "caption-start"
  | "caption-end"
  | "frame-grid";

export type TimelineSnapTarget = {
  kind: TimelineSnapTargetKind;
  frame: number;
  /** The guide's frame position, duplicated for consumers that render guides. */
  guideFrame: number;
  seconds: number;
  label: string;
  sourceId?: string;
};

export type TimelineSnapIndex = {
  frameRate: FrameRate;
  targets: readonly TimelineSnapTarget[];
  sequenceStartFrame: number;
  sequenceEndFrame: number;
};

export type BuildTimelineSnapIndexOptions = {
  playheadSec?: number;
  /** Clip edges belonging to this moving/trimming selection are not targets. */
  activeClipIds?: readonly string[];
};

export type TimelineSnapQuery = {
  frame: number;
  pixelsPerSecond: number;
  tolerancePx?: number;
  enabled?: boolean;
  /** Reusing the captured semantic target prevents flicker at the threshold. */
  previousTarget?: TimelineSnapTarget | undefined;
  stickyToleranceMultiplier?: number;
};

export type TimelineSnapResult = {
  rawFrame: number;
  frame: number;
  seconds: number;
  snapped: boolean;
  /** Undefined only when snapping has been temporarily disabled. */
  target?: TimelineSnapTarget;
  distanceFrames: number;
  toleranceFrames: number;
};

const DEFAULT_TOLERANCE_PX = 8;
const DEFAULT_STICKY_TOLERANCE_MULTIPLIER = 1.5;

const TARGET_PRIORITY: Readonly<Record<TimelineSnapTargetKind, number>> = {
  cut: 0,
  marker: 1,
  playhead: 2,
  "caption-start": 3,
  "caption-end": 3,
  "clip-start": 4,
  "clip-end": 4,
  "sequence-start": 5,
  "sequence-end": 5,
  "frame-grid": 6,
};

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function addTarget(
  targets: TimelineSnapTarget[],
  kind: Exclude<TimelineSnapTargetKind, "frame-grid">,
  seconds: number,
  frameRate: FrameRate,
  label: string,
  sourceId?: string,
): void {
  const frame = seconds * frameRateToFramesPerSecond(frameRate);
  targets.push({
    kind,
    frame,
    guideFrame: frame,
    seconds,
    label,
    ...(sourceId ? { sourceId } : {}),
  });
}

// Semantic edges retain the canonical seconds, including sub-frame media ends.
// Only the fallback frame grid may quantize a proposed position.
function clipEdges(clip: Clip): [number, number] {
  return [clip.timelineStartSec, clip.timelineStartSec + clip.durationSec];
}

/**
 * Derive semantic targets from the current document snapshot. It deliberately
 * does not alter the sequence or retain any gesture state.
 */
export function buildTimelineSnapIndex(sequence: Sequence, options: BuildTimelineSnapIndexOptions = {}): TimelineSnapIndex {
  const frameRate = sequenceFrameRate(sequence);
  const activeClipIds = new Set(options.activeClipIds ?? []);
  const targets: TimelineSnapTarget[] = [];
  const startFrame = 0;
  const endFrame = sequence.durationSec * frameRateToFramesPerSecond(frameRate);
  addTarget(targets, "sequence-start", startFrame, frameRate, "Sequence start");
  addTarget(targets, "sequence-end", sequence.durationSec, frameRate, "Sequence end");

  const edgeCounts = new Map<number, number>();
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (activeClipIds.has(clip.id)) continue;
      const [start, end] = clipEdges(clip);
      addTarget(targets, "clip-start", start, frameRate, "Clip start", clip.id);
      addTarget(targets, "clip-end", end, frameRate, "Clip end", clip.id);
      edgeCounts.set(start, (edgeCounts.get(start) ?? 0) + 1);
      edgeCounts.set(end, (edgeCounts.get(end) ?? 0) + 1);
      if (clip.kind === "caption") {
        addTarget(targets, "caption-start", start, frameRate, "Caption start", clip.id);
        addTarget(targets, "caption-end", end, frameRate, "Caption end", clip.id);
      }
    }
  }
  for (const [seconds, count] of edgeCounts) {
    if (count > 1) addTarget(targets, "cut", seconds, frameRate, "Edit point");
  }
  if (options.playheadSec !== undefined) {
    assertFinite(options.playheadSec, "Playhead seconds");
    addTarget(targets, "playhead", options.playheadSec, frameRate, "Playhead");
  }
  for (const marker of sequence.markers ?? []) {
    addTarget(targets, "marker", marker.timeSec, frameRate, marker.label?.trim() || "Marker", marker.id);
  }

  // Different semantic targets at one frame are intentional (for example a
  // caption edge which is also a cut). Exact duplicates add no useful guide.
  const unique = new Map<string, TimelineSnapTarget>();
  for (const target of targets) {
    const key = `${target.kind}:${target.frame}:${target.sourceId ?? ""}`;
    if (!unique.has(key)) unique.set(key, target);
  }
  const orderedTargets = [...unique.values()].sort(
    (a, b) => a.frame - b.frame || TARGET_PRIORITY[a.kind] - TARGET_PRIORITY[b.kind] || a.label.localeCompare(b.label),
  );
  return { frameRate, targets: orderedTargets, sequenceStartFrame: startFrame, sequenceEndFrame: endFrame };
}

function isIndexedTarget(index: TimelineSnapIndex, candidate: TimelineSnapTarget): boolean {
  return index.targets.some(
    (target) => target.kind === candidate.kind && target.frame === candidate.frame && target.sourceId === candidate.sourceId,
  );
}

function gridTarget(frame: number, frameRate: FrameRate): TimelineSnapTarget {
  return {
    kind: "frame-grid",
    frame,
    guideFrame: frame,
    seconds: frameToSeconds(frame, frameRate),
    label: "Frame grid",
  };
}

/**
 * Resolve one proposed frame against semantic targets and the sequence grid.
 * Pixel tolerance is converted through the current zoom, so the physical grab
 * distance stays stable while the frame range changes with magnification.
 */
export function resolveTimelineSnap(index: TimelineSnapIndex, query: TimelineSnapQuery): TimelineSnapResult {
  assertFinite(query.frame, "Proposed frame");
  assertFinite(query.pixelsPerSecond, "Pixels per second");
  if (query.pixelsPerSecond <= 0) throw new RangeError("Pixels per second must be greater than zero.");
  const tolerancePx = query.tolerancePx ?? DEFAULT_TOLERANCE_PX;
  assertFinite(tolerancePx, "Snap tolerance pixels");
  if (tolerancePx < 0) throw new RangeError("Snap tolerance pixels must not be negative.");
  const toleranceFrames = (tolerancePx / query.pixelsPerSecond) * frameRateToFramesPerSecond(index.frameRate);
  if (query.enabled === false) {
    return {
      rawFrame: query.frame,
      frame: query.frame,
      seconds: frameToSeconds(query.frame, index.frameRate),
      snapped: false,
      distanceFrames: 0,
      toleranceFrames,
    };
  }

  const stickyMultiplier = query.stickyToleranceMultiplier ?? DEFAULT_STICKY_TOLERANCE_MULTIPLIER;
  assertFinite(stickyMultiplier, "Sticky snap tolerance multiplier");
  if (stickyMultiplier < 1) throw new RangeError("Sticky snap tolerance multiplier must be at least 1.");
  const previous = query.previousTarget;
  if (previous && isIndexedTarget(index, previous)) {
    const distanceFrames = Math.abs(query.frame - previous.frame);
    if (distanceFrames <= toleranceFrames * stickyMultiplier) {
      return {
        rawFrame: query.frame,
        frame: previous.frame,
        seconds: previous.seconds,
        snapped: true,
        target: previous,
        distanceFrames,
        toleranceFrames,
      };
    }
  }

  const semantic = index.targets
    .map((target) => ({ target, distanceFrames: Math.abs(query.frame - target.frame) }))
    .filter((candidate) => candidate.distanceFrames <= toleranceFrames)
    .sort(
      (a, b) =>
        a.distanceFrames - b.distanceFrames ||
        TARGET_PRIORITY[a.target.kind] - TARGET_PRIORITY[b.target.kind] ||
        a.target.frame - b.target.frame,
    )[0];
  if (semantic) {
    return {
      rawFrame: query.frame,
      frame: semantic.target.frame,
      seconds: semantic.target.seconds,
      snapped: true,
      target: semantic.target,
      distanceFrames: semantic.distanceFrames,
      toleranceFrames,
    };
  }

  const frame = Math.round(query.frame);
  return {
    rawFrame: query.frame,
    frame,
    seconds: frameToSeconds(frame, index.frameRate),
    snapped: frame !== query.frame,
    target: gridTarget(frame, index.frameRate),
    distanceFrames: Math.abs(query.frame - frame),
    toleranceFrames,
  };
}

/** Moving a clip can dock either its leading or trailing edge to a neighbor. */
export function resolveTimelineMoveSnap(index: TimelineSnapIndex, query: TimelineSnapQuery, durationFrames: number): TimelineSnapResult {
  const leading = resolveTimelineSnap(index, query);
  if (query.enabled === false) return leading;
  const trailing = resolveTimelineSnap(index, { ...query, frame: query.frame + durationFrames });
  const semantic = (result: TimelineSnapResult) => result.target && result.target.kind !== "frame-grid";
  if (!semantic(trailing) || (semantic(leading) && leading.distanceFrames <= trailing.distanceFrames)) return leading;
  const frame = trailing.frame - durationFrames;
  if (frame < 0) return leading;
  return { ...trailing, rawFrame: query.frame, frame, seconds: trailing.seconds - frameToSeconds(durationFrames, index.frameRate) };
}
