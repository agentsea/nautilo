import { describe, expect, test } from "bun:test";
import { addClip } from "./commands";
import { createEmptyProject, EDL_VERSION, type VideoProject } from "./edl";
import { findFirstNonOverlappingStart, planSyntheticClip } from "./synthetic-clips";

function projectWithoutSyntheticTracks(): VideoProject {
  return {
    version: EDL_VERSION,
    sequences: [
      {
        id: "sequence-1",
        frameRate: { numerator: 30, denominator: 1 },
        durationSec: 0,
        tracks: [
          { id: "track-video", kind: "video", order: 0, clips: [] },
          { id: "track-voice", kind: "audio", order: 1, clips: [] },
        ],
      },
    ],
    media: [],
  };
}

function projectWithOverlayClip(startSec: number, durationSec: number): VideoProject {
  const project = createEmptyProject();
  const r = addClip(project, {
    trackId: "track-overlay",
    kind: "text",
    timelineStartSec: startSec,
    durationSec,
    props: { text: "Existing" },
  });
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

describe("planSyntheticClip defaults", () => {
  test("title preset targets overlay text clip", () => {
    const project = createEmptyProject();
    const r = planSyntheticClip(project, 0, "title");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toEqual({
      trackId: "track-overlay",
      kind: "text",
      timelineStartSec: 0,
      durationSec: 3,
      props: { text: "Title" },
    });
    expect(r.input.id).toBeUndefined();
  });

  test("caption preset targets caption track", () => {
    const project = createEmptyProject();
    const r = planSyntheticClip(project, 2, "caption");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toEqual({
      trackId: "track-captions",
      kind: "caption",
      timelineStartSec: 2,
      durationSec: 3,
      props: { text: "Caption" },
    });
  });

  test("callout preset uses 2s duration on overlay track", () => {
    const project = createEmptyProject();
    const r = planSyntheticClip(project, 1, "callout");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toEqual({
      trackId: "track-overlay",
      kind: "callout",
      timelineStartSec: 1,
      durationSec: 2,
      props: { text: "Callout" },
    });
  });

  test("planned input is accepted by addClip", () => {
    const project = createEmptyProject();
    const planned = planSyntheticClip(project, 0, "title");
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const added = addClip(project, planned.input);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const clip = added.project.sequences[0]!.tracks.find((t) => t.id === "track-overlay")!.clips[0]!;
    expect(clip.kind).toBe("text");
    expect(clip.props).toEqual({ text: "Title" });
    expect(clip.timelineStartSec).toBe(0);
    expect(clip.durationSec).toBe(3);
  });
});

describe("planSyntheticClip playhead normalization", () => {
  test("negative playhead clamps to 0", () => {
    const project = createEmptyProject();
    const r = planSyntheticClip(project, -5, "caption");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.timelineStartSec).toBe(0);
  });

  test("non-finite playhead clamps to 0", () => {
    const project = createEmptyProject();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = planSyntheticClip(project, bad, "title");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.input.timelineStartSec).toBe(0);
    }
  });
});

describe("planSyntheticClip occupied playhead advancing", () => {
  test("advances past a clip occupying the playhead on the same track", () => {
    const project = projectWithOverlayClip(0, 3);
    const r = planSyntheticClip(project, 1, "title");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.timelineStartSec).toBe(3);
    const added = addClip(project, r.input);
    expect(added.ok).toBe(true);
  });

  test("advances past multiple stacked overlaps", () => {
    const project = projectWithOverlayClip(0, 5);
    const r = planSyntheticClip(project, 0, "callout");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Existing [0,5); callout duration 2 would be [0,2) — advance to 5.
    expect(r.input.timelineStartSec).toBe(5);
  });

  test("caption track advances independently of overlay occupancy", () => {
    const overlayBusy = projectWithOverlayClip(0, 10);
    const r = planSyntheticClip(overlayBusy, 0, "caption");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.trackId).toBe("track-captions");
    expect(r.input.timelineStartSec).toBe(0);
  });
});

describe("findFirstNonOverlappingStart", () => {
  test("returns playhead when the slot is free", () => {
    const project = createEmptyProject();
    const track = project.sequences[0]!.tracks.find((t) => t.id === "track-overlay")!;
    expect(findFirstNonOverlappingStart(track, 4, 3)).toBe(4);
  });

  test("skips a gap too small then lands after the blocker", () => {
    const project = createEmptyProject();
    const track = project.sequences[0]!.tracks.find((t) => t.id === "track-overlay")!;
    track.clips.push({
      id: "block",
      trackId: track.id,
      kind: "text",
      timelineStartSec: 0,
      durationSec: 3,
      props: {},
    });
    expect(findFirstNonOverlappingStart(track, 2, 3)).toBe(3);
  });
});

describe("planSyntheticClip errors", () => {
  test("works on universal lanes without dedicated synthetic tracks", () => {
    const project = projectWithoutSyntheticTracks();
    expect(planSyntheticClip(project, 0, "title").ok).toBe(true);
    expect(planSyntheticClip(project, 0, "caption").ok).toBe(true);
    expect(planSyntheticClip(project, 0, "callout").ok).toBe(true);
  });

  test("error message names the synthetic kind", () => {
    const project = projectWithoutSyntheticTracks();
    project.sequences[0]!.tracks.forEach((track) => { track.hidden = true; });
    const r = planSyntheticClip(project, 0, "caption");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("caption");
  });

  test("returns error for project with no sequences", () => {
    const project: VideoProject = { version: EDL_VERSION, sequences: [], media: [] };
    const r = planSyntheticClip(project, 0, "title");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no sequences");
  });
});
