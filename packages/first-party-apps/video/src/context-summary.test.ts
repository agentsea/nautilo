import { describe, expect, test } from "bun:test";
import { createEmptyProject } from "./edl";
import { buildVideoContextSummary } from "./context-summary";

describe("buildVideoContextSummary", () => {
  test("publishes range precedence, complete multi-selection, effects, protection and saved version", () => {
    const project = createEmptyProject();
    const track = project.sequences[0]!.tracks[0]!;
    track.hidden = true;
    track.name = "Protected picture";
    track.clips = ["a", "b"].map((id, index) => ({ id, kind: "video", trackId: track.id, timelineStartSec: index * 3, durationSec: 3, props: { fades: { videoIn: { startSec: 0, durationSec: 1 } } } }));
    const summary = buildVideoContextSummary({ project, selectedClipId: "a", selectedClipIds: ["a", "b", "a", "missing"], range: { inSec: 5, outSec: 2 }, playheadSec: 2, dirty: true, savedVersion: { sha256: "saved", revision: 3 } });
    expect(summary.selectionScope).toEqual({ clipIds: ["a", "b"], range: { inSec: 2, outSec: 5 }, precedence: "range" });
    expect(summary.selectedClips.map((clip) => clip.id)).toEqual(["a", "b"]);
    expect(summary.selectedClips[0]?.props).toHaveProperty("fades");
    expect(summary.tracks[0]).toMatchObject({ name: "Protected picture", hidden: true });
    expect(summary.savedVersion).toEqual({ sha256: "saved", revision: 3 });
    expect(summary.summary.dirty).toBe(true);
    expect(buildVideoContextSummary({ project, selectedClipIds: ["b"], range: { inSec: 2, outSec: 2 }, playheadSec: 2, dirty: false }).selectionScope).toEqual({ clipIds: ["b"], range: null, precedence: "clips" });
  });
  test("builds bounded summary with selected clip metadata", () => {
    const project = createEmptyProject();
    project.media.push({ id: "media-1", kind: "video", ref: "assets/intro.mp4", durationSec: 5, label: "Intro" });
    project.sequences[0]!.tracks[0]!.clips.push({
      id: "clip-1",
      kind: "video",
      trackId: "track-video",
      mediaId: "media-1",
      timelineStartSec: 1,
      durationSec: 4,
      props: {},
    });

    const summary = buildVideoContextSummary({
      documentPath: "/workspace/intro.video.html",
      project,
      selectedClipId: "clip-1",
      playheadSec: 1.5,
      dirty: true,
      lastSavedAt: new Date("2026-07-06T12:00:00.000Z"),
    });

    expect(summary.title).toBe("intro.video.html");
    expect(summary.documentPath).toBe("/workspace/intro.video.html");
    expect(summary.selection).toEqual({
      clipId: "clip-1",
      trackId: "track-video",
      kind: "video",
      timelineStartSec: 1,
      durationSec: 4,
    });
    expect(summary.summary.clipCount).toBe(1);
    expect(summary.summary.mediaCount).toBe(1);
    expect(summary.summary.description).toContain("1 clip");
    expect(JSON.stringify(summary)).not.toContain("assets/intro.mp4");
  });

  test("caps only the human-readable description while keeping exact counts and selection recovery data", () => {
    const project = createEmptyProject();
    const longClipId = "clip-" + "x".repeat(400);
    project.sequences[0]!.tracks[0]!.clips.push({
      id: longClipId,
      kind: "video",
      trackId: "track-video",
      timelineStartSec: 0,
      durationSec: 1,
      props: {},
    });

    const summary = buildVideoContextSummary({
      project,
      selectedClipId: longClipId,
      playheadSec: 0,
      dirty: false,
    });

    expect(summary.summary.description).toHaveLength(220);
    expect(summary.summary.description).toEndWith("…");
    expect(summary.summary.clipCount).toBe(1);
    expect(summary.selection?.clipId).toBe(longClipId);
  });
});
