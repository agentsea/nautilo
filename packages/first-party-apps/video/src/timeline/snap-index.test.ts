import { describe, expect, test } from "bun:test";
import { createDefaultSequence, type Clip, type Sequence } from "../edl";
import { buildTimelineSnapIndex, resolveTimelineMoveSnap, resolveTimelineSnap } from "./snap-index";

function clip(id: string, start: number, duration: number, kind: Clip["kind"] = "video"): Clip {
  return { id, trackId: kind === "caption" ? "track-captions" : "track-video", kind, timelineStartSec: start, durationSec: duration, props: {} } as Clip;
}

function sampleSequence(): Sequence {
  const sequence = createDefaultSequence();
  sequence.durationSec = 12;
  sequence.tracks.find((track) => track.id === "track-video")!.clips.push(
    clip("a", 0, 3),
    clip("b", 3, 2),
  );
  sequence.tracks.find((track) => track.id === "track-captions")!.clips.push(clip("caption", 6, 2, "caption"));
  sequence.markers = [{ id: "m1", timeSec: 9, label: "Chapter" }];
  return sequence;
}

describe("timeline snap index", () => {
  test("moving either clip edge snaps exactly to neighbors at two zoom levels", () => {
    const sequence = createDefaultSequence(); sequence.durationSec = 20;
    sequence.tracks[0]!.clips = [clip("neighbor", 8, 2)];
    const index = buildTimelineSnapIndex(sequence);
    for (const pixelsPerSecond of [48, 192]) {
      const nearPx = 4 / pixelsPerSecond * 30;
      const before = resolveTimelineMoveSnap(index, { frame: 180 + nearPx, pixelsPerSecond }, 60);
      expect(before.seconds).toBe(6);
      expect(before.target).toMatchObject({ kind: "clip-start", sourceId: "neighbor", guideFrame: 240 });
      const after = resolveTimelineMoveSnap(index, { frame: 300 - nearPx, pixelsPerSecond }, 60);
      expect(after.seconds).toBe(10);
      expect(after.target).toMatchObject({ kind: "clip-end", sourceId: "neighbor", guideFrame: 300 });
      expect(resolveTimelineMoveSnap(index, { frame: 180 + nearPx, pixelsPerSecond, enabled: false }, 60).frame).toBe(180 + nearPx);
    }
  });
  test("docks to exact sub-frame edges instead of rounding into a gap or overlap", () => {
    for (const frameRate of [{ numerator: 30, denominator: 1 }, { numerator: 30000, denominator: 1001 }]) {
      const sequence = createDefaultSequence();
      sequence.frameRate = frameRate; sequence.durationSec = 20;
      const neighbor = clip("neighbor", 9.766666666666667, 4.013333333333334);
      sequence.tracks[0]!.clips = [neighbor];
      const end = neighbor.timelineStartSec + neighbor.durationSec;
      const fps = frameRate.numerator / frameRate.denominator;
      const index = buildTimelineSnapIndex(sequence);
      for (const pixelsPerSecond of [48, 192]) {
        const query = { frame: (end + 4 / pixelsPerSecond) * fps, pixelsPerSecond };
        const docked = resolveTimelineMoveSnap(index, query, 3.27 * fps);
        expect(docked.seconds - end).toBe(0);
        expect(docked.target).toMatchObject({ kind: "clip-end", seconds: end });
        const retained = resolveTimelineMoveSnap(index, { ...query, previousTarget: docked.target }, 3.27 * fps);
        expect(retained.seconds).toBe(end);
        expect(resolveTimelineMoveSnap(index, { ...query, enabled: false }, 3.27 * fps).target).toBeUndefined();
        const before = resolveTimelineMoveSnap(index, { frame: (neighbor.timelineStartSec - 2 + 4 / pixelsPerSecond) * fps, pixelsPerSecond }, 2 * fps);
        expect(before.seconds + 2).toBe(neighbor.timelineStartSec);
        expect(before.target?.kind).toBe("clip-start");
      }
    }
  });
  test("derives typed sequence, clip/cut, playhead, marker, and caption targets", () => {
    const index = buildTimelineSnapIndex(sampleSequence(), { playheadSec: 4 });
    expect(index.frameRate).toEqual({ numerator: 30, denominator: 1 });
    for (const expected of [
      { kind: "sequence-start", frame: 0 },
      { kind: "sequence-end", frame: 360 },
      { kind: "cut", frame: 90, label: "Edit point" },
      { kind: "playhead", frame: 120 },
      { kind: "marker", frame: 270, label: "Chapter", sourceId: "m1" },
      { kind: "caption-start", frame: 180, sourceId: "caption" },
      { kind: "caption-end", frame: 240, sourceId: "caption" },
    ]) {
      expect(index.targets.some((target) => Object.entries(expected).every(([key, value]) => target[key as keyof typeof target] === value))).toBe(true);
    }
  });

  test("excludes every edge from the active moving selection", () => {
    const index = buildTimelineSnapIndex(sampleSequence(), { activeClipIds: ["a"] });
    expect(index.targets.find((target) => target.sourceId === "a")).toBeUndefined();
    expect(index.targets.find((target) => target.kind === "cut" && target.frame === 90)).toBeUndefined();
  });

  test("converts a pixel tolerance through zoom and returns semantic feedback", () => {
    const index = buildTimelineSnapIndex(sampleSequence());
    const nearCut = resolveTimelineSnap(index, { frame: 93, pixelsPerSecond: 30, tolerancePx: 4 });
    expect(nearCut.frame).toBe(90);
    expect(nearCut.target).toMatchObject({ kind: "cut", label: "Edit point", guideFrame: 90 });
    expect(nearCut.toleranceFrames).toBe(4);

    const tooFarWhenZoomedIn = resolveTimelineSnap(index, { frame: 93, pixelsPerSecond: 120, tolerancePx: 4 });
    expect(tooFarWhenZoomedIn.target).toMatchObject({ kind: "frame-grid", frame: 93 });
  });

  test("retains a captured semantic target within the sticky threshold", () => {
    const index = buildTimelineSnapIndex(sampleSequence());
    const captured = resolveTimelineSnap(index, { frame: 92, pixelsPerSecond: 30, tolerancePx: 4 });
    const retained = resolveTimelineSnap(index, {
      frame: 95,
      pixelsPerSecond: 30,
      tolerancePx: 4,
      previousTarget: captured.target,
    });
    expect(retained.target).toMatchObject({ kind: "cut", frame: 90 });
  });

  test("temporary disable returns the raw proposal instead of a grid or semantic target", () => {
    const index = buildTimelineSnapIndex(sampleSequence());
    const result = resolveTimelineSnap(index, { frame: 92.4, pixelsPerSecond: 30, enabled: false });
    expect(result).toMatchObject({ frame: 92.4, snapped: false });
    expect(result.target).toBeUndefined();
  });
});
