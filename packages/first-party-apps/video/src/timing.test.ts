import { describe, expect, test } from "bun:test";
import {
  buildDocumentSummary,
  clampNonNegativeSeconds,
  clipTimelineEndSec,
  clipsOverlappingRange,
  computeSequenceDurationSec,
  detectTrackTimingViolations,
  isCompatibleTrack,
  isValidSeconds,
} from "./timing";
import { createDefaultSequence, type Clip, type Sequence, type Track } from "./edl";

function makeClip(overrides: Partial<Clip> & Pick<Clip, "id" | "trackId" | "kind">): Clip {
  return {
    timelineStartSec: 0,
    durationSec: 1,
    props: {},
    ...overrides,
  } as Clip;
}

function videoTrack(sequence: Sequence): Track {
  const track = sequence.tracks.find((t) => t.kind === "video");
  if (!track) throw new Error("missing video track");
  return track;
}

describe("timing helpers", () => {
  test("clampNonNegativeSeconds and isValidSeconds", () => {
    expect(clampNonNegativeSeconds(-5)).toBe(0);
    expect(clampNonNegativeSeconds(0)).toBe(0);
    expect(clampNonNegativeSeconds(3.5)).toBe(3.5);
    expect(clampNonNegativeSeconds(Number.NaN)).toBe(0);
    expect(isValidSeconds(0)).toBe(true);
    expect(isValidSeconds(-1)).toBe(false);
    expect(isValidSeconds(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("clipTimelineEndSec adds duration", () => {
    expect(clipTimelineEndSec(makeClip({ id: "c1", trackId: "t1", kind: "video", timelineStartSec: 10, durationSec: 2.5 }))).toBe(12.5);
  });

  test("computeSequenceDurationSec covers all clip ends; empty returns 0", () => {
    const seq = createDefaultSequence();
    expect(computeSequenceDurationSec(seq)).toBe(0);
    const track = videoTrack(seq);
    track.clips.push(makeClip({ id: "c1", trackId: track.id, kind: "video", timelineStartSec: 5, durationSec: 3 }));
    expect(computeSequenceDurationSec(seq)).toBe(8);
  });

  test("clipsOverlappingRange finds overlapping clips and excludes self", () => {
    const seq = createDefaultSequence();
    const track = videoTrack(seq);
    track.clips.push(
      makeClip({ id: "a", trackId: track.id, kind: "video", timelineStartSec: 0, durationSec: 5 }),
      makeClip({ id: "b", trackId: track.id, kind: "video", timelineStartSec: 4, durationSec: 2 }),
      makeClip({ id: "c", trackId: track.id, kind: "video", timelineStartSec: 10, durationSec: 1 }),
    );
    const hits = clipsOverlappingRange(track, 3, 6);
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
    const excludingA = clipsOverlappingRange(track, 3, 6, "a");
    expect(excludingA.map((h) => h.id)).toEqual(["b"]);
  });

  test("isCompatibleTrack respects clip/track rules", () => {
    expect(isCompatibleTrack("video", "video")).toBe(true);
    expect(isCompatibleTrack("audio", "music")).toBe(true);
    expect(isCompatibleTrack("caption", "caption")).toBe(true);
    expect(isCompatibleTrack("text", "overlay")).toBe(true);
    expect(isCompatibleTrack("callout", "video")).toBe(true);
    expect(isCompatibleTrack("video", "audio")).toBe(true);
  });

  test("detectTrackTimingViolations flags overlap and ignores empty tracks", () => {
    const seq = createDefaultSequence();
    const track = videoTrack(seq);
    track.clips.push(
      makeClip({ id: "a", trackId: track.id, kind: "video", timelineStartSec: 0, durationSec: 5 }),
      makeClip({ id: "b", trackId: track.id, kind: "video", timelineStartSec: 3, durationSec: 2 }),
    );
    const v = detectTrackTimingViolations(seq);
    expect(v).toHaveLength(1);
    expect(v[0]!.clipIds).toEqual(["a", "b"]);
  });

  test("detectTrackTimingViolations on empty tracks returns []", () => {
    expect(detectTrackTimingViolations(createDefaultSequence())).toEqual([]);
  });

  test("buildDocumentSummary reports every track and exact counts", () => {
    const seq = createDefaultSequence();
    const track = videoTrack(seq);
    track.clips.push(
      makeClip({ id: "a", trackId: track.id, kind: "video", timelineStartSec: 0, durationSec: 4 }),
    );
    const summary = buildDocumentSummary(seq, 3);
    expect(summary.sequenceId).toBe("sequence-1");
    expect(summary.durationSec).toBe(4);
    expect(summary.trackCount).toBe(5);
    expect(summary.clipCount).toBe(1);
    expect(summary.mediaCount).toBe(3);
    expect(summary.tracks).toHaveLength(5);
    expect(summary.tracks[0]).toMatchObject({ kind: "caption", clipCount: 0 });
  });

  test("summarizes tracks beyond the former 32-track quota without omission", () => {
    const seq = createDefaultSequence();
    seq.tracks = Array.from({ length: 40 }, (_, index) => ({ ...seq.tracks[0]!, id: `track-${index}`, order: index, clips: [] }));
    const summary = buildDocumentSummary(seq, 250);
    expect(summary.trackCount).toBe(40);
    expect(summary.tracks.map(track => track.id)).toEqual(seq.tracks.map(track => track.id));
    expect(summary.mediaCount).toBe(250);
  });
});
