// Frame-domain helpers for timeline presentation and interaction.
//
// The EDL intentionally stores seconds. These helpers derive integer timeline
// frames only at an interaction boundary; they never rewrite persisted timing.

import { DEFAULT_FRAME_RATE, type FrameRate, type Sequence } from "../edl";

export type FrameRounding = "nearest" | "floor" | "ceil";

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

/** Returns a validated copy so callers cannot mutate a shared default rate. */
export function normalizeFrameRate(frameRate: FrameRate | undefined): FrameRate {
  const value = frameRate ?? DEFAULT_FRAME_RATE;
  if (
    !Number.isSafeInteger(value.numerator) ||
    !Number.isSafeInteger(value.denominator) ||
    value.numerator <= 0 ||
    value.denominator <= 0
  ) {
    throw new RangeError("Frame rate must have positive integer numerator and denominator.");
  }
  return { numerator: value.numerator, denominator: value.denominator };
}

/** Frames per second represented by a rational sequence frame rate. */
export function frameRateToFramesPerSecond(frameRate: FrameRate | undefined): number {
  const rate = normalizeFrameRate(frameRate);
  return rate.numerator / rate.denominator;
}

/** Obtain the explicit sequence rate, with the legacy 30/1 fallback. */
export function sequenceFrameRate(sequence: Partial<Pick<Sequence, "frameRate">>): FrameRate {
  return normalizeFrameRate(sequence.frameRate);
}

/** Convert canonical seconds to a frame-domain position using explicit rounding. */
export function secondsToFrame(
  seconds: number,
  frameRate: FrameRate | undefined,
  rounding: FrameRounding = "nearest",
): number {
  assertFinite(seconds, "Seconds");
  const exactFrame = seconds * frameRateToFramesPerSecond(frameRate);
  switch (rounding) {
    case "floor":
      return Math.floor(exactFrame);
    case "ceil":
      return Math.ceil(exactFrame);
    case "nearest":
      return Math.round(exactFrame);
  }
}

/** Convert a (possibly fractional while dragging) frame position to seconds. */
export function frameToSeconds(frame: number, frameRate: FrameRate | undefined): number {
  assertFinite(frame, "Frame");
  const rate = normalizeFrameRate(frameRate);
  return (frame * rate.denominator) / rate.numerator;
}

/** Plural alias for callers that describe a frame count rather than a position. */
export const framesToSeconds = frameToSeconds;
