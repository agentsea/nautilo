import type { Track } from "../edl";

export const TIMELINE_PIXELS_PER_SECOND = 48;
export const TIMELINE_TRACK_HEIGHT_PX = 68;
export const TIMELINE_SNAP_SEC = 0.05;

/** Shared display spacing; does not change the sequence grid or snap tolerance. */
export function timelineTickStep(pixelsPerSecond: number): number {
  const minimumStep = 56 / pixelsPerSecond;
  const magnitude = 10 ** Math.floor(Math.log10(minimumStep));
  return ([1, 2, 5, 10].find((factor) => factor * magnitude >= minimumStep) ?? 10) * magnitude;
}

export function secondsToPixels(seconds: number, pixelsPerSecond = TIMELINE_PIXELS_PER_SECOND): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, seconds) * pixelsPerSecond;
}

export function pixelsToSeconds(pixels: number, pixelsPerSecond = TIMELINE_PIXELS_PER_SECOND): number {
  if (!Number.isFinite(pixels) || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 0;
  return Math.max(0, pixels) / pixelsPerSecond;
}

export function snapSeconds(seconds: number, snapSec = TIMELINE_SNAP_SEC): number {
  if (!Number.isFinite(seconds)) return 0;
  if (!Number.isFinite(snapSec) || snapSec <= 0) return Math.max(0, seconds);
  return Math.max(0, Math.round(seconds / snapSec) * snapSec);
}

export function trackAtVerticalOffset(
  orderedTracks: readonly Track[],
  deltaY: number,
  startTrackId: string,
  trackHeightPx = TIMELINE_TRACK_HEIGHT_PX,
): Track | null {
  const startIndex = orderedTracks.findIndex((track) => track.id === startTrackId);
  if (startIndex < 0) return null;
  const offset = Math.round(deltaY / trackHeightPx);
  const nextIndex = Math.min(Math.max(startIndex + offset, 0), orderedTracks.length - 1);
  return orderedTracks[nextIndex] ?? null;
}

export function nextTrimLeft(
  oldStartSec: number,
  oldDurationSec: number,
  deltaSec: number,
  frameDurationSec: number,
): { timelineStartSec: number; durationSec: number; sourceDeltaSec: number } {
  const minimumDurationSec = Math.min(oldDurationSec, frameDurationSec);
  const oldEndSec = oldStartSec + oldDurationSec;
  const maxStartSec = oldEndSec - minimumDurationSec;
  const timelineStartSec = Math.min(Math.max(0, oldStartSec + deltaSec), maxStartSec);
  const durationSec = Math.max(minimumDurationSec, oldEndSec - timelineStartSec);
  return {
    timelineStartSec,
    durationSec,
    sourceDeltaSec: timelineStartSec - oldStartSec,
  };
}

export function nextTrimRight(oldDurationSec: number, deltaSec: number, frameDurationSec: number): { durationSec: number } {
  return {
    durationSec: Math.max(Math.min(oldDurationSec, frameDurationSec), oldDurationSec + deltaSec),
  };
}
