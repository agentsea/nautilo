import { describe, expect, test } from "bun:test";
import type { Sequence, Track } from "../edl";
import { invokeSplitSelected } from "./Timeline";
import { commitTrimProposal, isRipplePreview, trimProposalForKeyboard } from "./ClipBlock";
import { advanceTimelineInteraction, beginTimelineInteraction, cancelTimelineInteraction, resetTimelineInteraction } from "./interaction-state";
import { rangeForKeyboardKey, resolvePlayheadPointerSeconds, restorePlayheadOnCancel } from "./Ruler";
import { buildTimelineSnapIndex, resolveTimelineSnap } from "./snap-index";
import { frameToSeconds, sequenceFrameRate } from "./timing";
import {
  nextTrimLeft,
  nextTrimRight,
  pixelsToSeconds,
  secondsToPixels,
  snapSeconds,
  trackAtVerticalOffset,
} from "./timeline-utils";

const tracks: Track[] = [
  { id: "track-video", kind: "video", order: 0, clips: [] },
  { id: "track-overlay", kind: "overlay", order: 1, clips: [] },
  { id: "track-captions", kind: "caption", order: 2, clips: [] },
];

const snapSequence: Sequence = {
  id: "snap-fixture",
  frameRate: { numerator: 30, denominator: 1 },
  durationSec: 12,
  tracks: [
    {
      id: "track-video",
      kind: "video",
      order: 0,
      clips: [
        { id: "active", kind: "video", trackId: "track-video", timelineStartSec: 0, durationSec: 3, props: {} },
        { id: "other", kind: "video", trackId: "track-video", timelineStartSec: 3, durationSec: 2, props: {} },
      ],
    },
  ],
};

describe("timeline-utils", () => {
  test("converts pixels and seconds", () => {
    expect(secondsToPixels(2, 50)).toBe(100);
    expect(pixelsToSeconds(125, 50)).toBe(2.5);
    expect(pixelsToSeconds(-10, 50)).toBe(0);
  });

  test("snaps seconds to increments", () => {
    expect(snapSeconds(1.23, 0.1)).toBeCloseTo(1.2);
    expect(snapSeconds(1.26, 0.1)).toBeCloseTo(1.3);
  });

  test("finds target track from vertical drag", () => {
    expect(trackAtVerticalOffset(tracks, 60, "track-video")?.id).toBe("track-overlay");
    expect(trackAtVerticalOffset(tracks, 400, "track-video")?.id).toBe("track-captions");
    expect(trackAtVerticalOffset(tracks, -400, "track-overlay")?.id).toBe("track-video");
  });

  test("computes left and right trims", () => {
    expect(nextTrimLeft(2, 4, 1, 1 / 30)).toEqual({
      timelineStartSec: 3,
      durationSec: 3,
      sourceDeltaSec: 1,
    });
    expect(nextTrimRight(4, -10, 1 / 30).durationSec).toBeCloseTo(1 / 30);
  });

  test("trim minimum follows the project frame rather than a tenth of a second", () => {
    for (const frameRate of [{ numerator: 60, denominator: 1 }, { numerator: 30000, denominator: 1001 }]) {
      const frame = frameToSeconds(1, frameRate);
      const clip = { ...snapSequence.tracks[0]!.clips[0]!, durationSec: 2 * frame };
      expect(trimProposalForKeyboard(clip, "trim-right", "ArrowLeft", frameRate).durationSec).toBeCloseTo(frame);
      expect(trimProposalForKeyboard(clip, "trim-left", "ArrowRight", frameRate).durationSec).toBeCloseTo(frame);
      expect(nextTrimRight(1, -10, frame).durationSec).toBeCloseTo(frame);
      expect(nextTrimLeft(0, 1, 10, frame).durationSec).toBeCloseTo(frame);
      expect(nextTrimRight(frame / 2, 0, frame).durationSec).toBe(frame / 2);
    }
  });

  test("uses the shared frame rate and semantic index at two zoom tolerances", () => {
    const index = buildTimelineSnapIndex(snapSequence, { activeClipIds: ["active"], playheadSec: 7 });
    expect(sequenceFrameRate(snapSequence)).toEqual({ numerator: 30, denominator: 1 });
    expect(index.targets.find((target) => target.sourceId === "active")).toBeUndefined();

    const zoomedOut = resolveTimelineSnap(index, { frame: 93, pixelsPerSecond: 30, tolerancePx: 4 });
    const zoomedIn = resolveTimelineSnap(index, { frame: 93, pixelsPerSecond: 120, tolerancePx: 4 });
    expect(zoomedOut.target).toMatchObject({ kind: "clip-start", frame: 90, sourceId: "other" });
    expect(zoomedIn.target).toMatchObject({ kind: "frame-grid", frame: 93 });
  });

  test("temporarily disables snapping with the shared resolver", () => {
    const index = buildTimelineSnapIndex(snapSequence, { activeClipIds: ["active"] });
    const raw = resolveTimelineSnap(index, { frame: 92.4, pixelsPerSecond: 48, enabled: false });
    expect(raw).toMatchObject({ frame: 92.4, snapped: false });
    expect(raw.target).toBeUndefined();
    expect(frameToSeconds(raw.frame, index.frameRate)).toBeCloseTo(3.08);
  });

  test("advances and cancels a live proposal without creating a durable edit", () => {
    const started = beginTimelineInteraction({
      kind: "move",
      start: { pointer: { x: 0, y: 0 }, frame: 0, selectionIds: ["active"] },
      proposal: { clipId: "active", timelineStartSec: 0 },
    });
    const advanced = advanceTimelineInteraction(started, {
      current: { pointer: { x: 96, y: 0 }, frame: 60 },
      proposal: { clipId: "active", timelineStartSec: 2 },
    });
    expect(advanced).toMatchObject({ kind: "move", proposal: { timelineStartSec: 2 } });
    const cancelled = cancelTimelineInteraction(advanced);
    expect(cancelled).toMatchObject({ kind: "cancelled", cancelledKind: "move" });
    expect("proposal" in cancelled).toBe(false);
    expect(resetTimelineInteraction()).toEqual({ kind: "idle" });
  });

  test("enables the sole Split action only with selection and parent callback", () => {
    let commits = 0;
    expect(invokeSplitSelected(null, () => commits++)).toBe(false);
    expect(invokeSplitSelected("active", undefined)).toBe(false);
    expect(invokeSplitSelected("active", () => commits++)).toBe(true);
    expect(commits).toBe(1);
  });

  test("steps and bounds range wings on the sequence frame grid", () => {
    const rate = { numerator: 30, denominator: 1 };
    expect(rangeForKeyboardKey({ inSec: 1, outSec: 2 }, "in", "ArrowRight", 10, rate).inSec).toBeCloseTo(31 / 30);
    expect(rangeForKeyboardKey({ inSec: 1, outSec: 2 }, "out", "ArrowLeft", 10, rate).outSec).toBeCloseTo(59 / 30);
    expect(rangeForKeyboardKey({ inSec: 1, outSec: 2 }, "in", "Home", 10, rate)).toEqual({ inSec: 0, outSec: 2 });
    expect(rangeForKeyboardKey({ inSec: 1, outSec: 2 }, "in", "End", 10, rate)).toEqual({ inSec: 2, outSec: 2 });
    expect(rangeForKeyboardKey({ inSec: 1, outSec: 2 }, "out", "Home", 10, rate)).toEqual({ inSec: 1, outSec: 1 });
    expect(rangeForKeyboardKey({ inSec: 1, outSec: 2 }, "out", "End", 10, rate)).toEqual({ inSec: 1, outSec: 10 });
  });

  test("keyboard trim proposes exactly one frame and Shift is feedback-only ripple", () => {
    const clip = snapSequence.tracks[0]!.clips[0]!;
    const rate = snapSequence.frameRate;
    const left = trimProposalForKeyboard(clip, "trim-left", "ArrowRight", rate);
    const right = trimProposalForKeyboard(clip, "trim-right", "ArrowLeft", rate);
    expect(left.timelineStartSec).toBeCloseTo(1 / 30);
    expect(left.durationSec).toBeCloseTo(3 - 1 / 30);
    expect(right.durationSec).toBeCloseTo(3 - 1 / 30);
    expect(isRipplePreview("trim-left", true)).toBe(true);
    expect(isRipplePreview("trim-right", true)).toBe(true);
    expect(isRipplePreview("move", true)).toBe(false);
    expect(isRipplePreview("trim-left", false)).toBe(false);

    let leftCommits = 0;
    let rightCommits = 0;
    expect(commitTrimProposal(left, clip, () => leftCommits++, () => rightCommits++)).toBe(true);
    expect(leftCommits).toBe(1);
    expect(rightCommits).toBe(0);
    expect(commitTrimProposal(right, clip, () => leftCommits++, () => rightCommits++)).toBe(true);
    expect(leftCommits).toBe(1);
    expect(rightCommits).toBe(1);
  });

  test("joined playhead pointer proposals stream from the shared snap spine and cancel exactly", () => {
    const snapped = resolvePlayheadPointerSeconds(snapSequence, 12, 145, 0, 48, true, false);
    expect(snapped.seconds).toBe(3);
    expect(snapped.target).toMatchObject({ kind: "cut", label: "Edit point" });

    const bypassed = resolvePlayheadPointerSeconds(snapSequence, 12, 145, 0, 48, true, true);
    expect(bypassed.seconds).toBeCloseTo(145 / 48);
    expect(bypassed.target).toBeUndefined();

    const scrubbed: number[] = [];
    restorePlayheadOnCancel(2.25, (seconds) => scrubbed.push(seconds));
    expect(scrubbed).toEqual([2.25]);
  });
});
