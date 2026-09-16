import { describe, expect, test } from "bun:test";
import {
  addClip,
  addTrack,
  admitImportedVideo,
  admitGeneratedTakeMedia,
  deleteTrack,
  deleteClip,
  detachAudio,
  linkClips,
  moveClip,
  moveClipGroup,
  promoteGeneratedTake,
  reorderTrack,
  splitClip,
  trimClip,
  unlinkClips,
  updateClipProps,
} from "./commands";
import { createDefaultSequence, createEmptyProject, findClip, type VideoProject, type Clip } from "./edl";
import type { GeneratedTake } from "./generation-takes";
import { VideoProjectHistory } from "./project-history";

function sampleGeneratedTake(): GeneratedTake {
  return {
    id: "take_abcdefghijklmnop",
    briefRevision: 4,
    shotId: "shot-opening",
    shotLabel: "Opening move",
    mediaKind: "video",
    modelId: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
    artifact: {
      artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: "generated-media/take-opening.mp4",
      zone: "workspace",
      mime: "video/mp4",
      bytes: 1_024,
    },
  };
}

function projectWithVideoClip(): { project: VideoProject; clipId: string } {
  const project = createEmptyProject();
  const r = addClip(project, {
    trackId: "track-video",
    kind: "video",
    mediaId: "media-1",
    timelineStartSec: 0,
    durationSec: 4,
    sourceInSec: 0,
    sourceOutSec: 4,
  });
  if (!r.ok) throw new Error(`addClip failed: ${r.error}`);
  return { project: r.project, clipId: r.project.sequences[0]!.tracks[0]!.clips[0]!.id };
}

describe("commands.addClip", () => {
  test("adds a clip and bumps metadata", () => {
    const { project, clipId } = projectWithVideoClip();
    const track = project.sequences[0]!.tracks.find((t) => t.id === "track-video")!;
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]).toMatchObject({ id: clipId, kind: "video", durationSec: 4 });
    expect(project.metadata?.updatedAt).toBeTruthy();
  });

  test("accepts video on a lane labeled for audio", () => {
    const project = createEmptyProject();
    const r = addClip(project, { trackId: "track-voice", kind: "video", timelineStartSec: 0, durationSec: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.sequences[0]!.tracks.find((track) => track.id === "track-voice")!.clips[0]!.kind).toBe("video");
  });

  test("rejects overlap within a track", () => {
    const { project } = projectWithVideoClip();
    const r = addClip(project, {
      trackId: "track-video",
      kind: "video",
      timelineStartSec: 2,
      durationSec: 4,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("overlaps");
  });

  test("rejects negative timeline start", () => {
    const project = createEmptyProject();
    const r = addClip(project, { trackId: "track-video", kind: "video", timelineStartSec: -1, durationSec: 1 });
    expect(r.ok).toBe(false);
  });

  test("normalizes a known media source window and refuses measured overflow", () => {
    const project = {
      ...createEmptyProject(),
      media: [{ id: "media-measured", kind: "video" as const, ref: "video-imports/measured.mp4", durationSec: 10 }],
    };
    const added = addClip(project, {
      trackId: "track-video", kind: "video", mediaId: "media-measured", timelineStartSec: 0, durationSec: 4,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(findClip(added.project.sequences[0]!, added.project.sequences[0]!.tracks[0]!.clips[0]!.id)!.clip).toMatchObject({
      sourceInSec: 0,
      sourceOutSec: 4,
    });
    expect(addClip(project, {
      trackId: "track-video", kind: "video", mediaId: "media-measured", timelineStartSec: 0,
      durationSec: 4, sourceInSec: 8,
    })).toEqual({ ok: false, error: "Source window exceeds the measured media duration." });
  });

  test("accepts a rational-frame source window at a long source offset", () => {
    const frame = 1 / 30;
    const project = {
      ...createEmptyProject(),
      media: [{ id: "media-long", kind: "video" as const, ref: "video-imports/long.mp4", durationSec: 2_000 }],
    };
    expect(addClip(project, {
      trackId: "track-video", kind: "video", mediaId: "media-long", timelineStartSec: 0,
      durationSec: frame, sourceInSec: 1_000, sourceOutSec: 1_000 + frame,
    }).ok).toBe(true);
  });
});

describe("commands.deleteClip", () => {
  test("removes only timeline clips, preserves the Media Bin source, and restores through Undo", () => {
    const admitted = admitImportedVideo(createEmptyProject(), {
      ref: "video-imports/source.mp4", label: "Source", durationSec: 4, frameRate: { numerator: 30, denominator: 1 },
    });
    if (!admitted.ok) throw new Error(admitted.error);
    const mediaId = admitted.project.media[0]!.id;
    const placed = addClip(admitted.project, {
      trackId: "track-video", kind: "video", mediaId, timelineStartSec: 0, durationSec: 4,
    });
    if (!placed.ok) throw new Error(placed.error);
    const before = placed.project;
    const clipId = before.sequences[0]!.tracks[0]!.clips[0]!.id;
    const deleted = deleteClip(before, { clipId });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.project.sequences[0]!.tracks.flatMap((track) => track.clips)).toEqual([]);
    expect(deleted.project.media).toEqual(before.media);
    const history = new VideoProjectHistory();
    history.record(before, deleted.project);
    const undone = history.undo(deleted.project);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.project.media).toEqual(before.media);
    expect(undone.project.sequences[0]!.tracks).toEqual(before.sequences[0]!.tracks);
    expect(undone.project.sequences[0]!.durationSec).toBe(4);
  });

  test("refuses a locked target without removing its Media Bin source", () => {
    const { project, clipId } = projectWithVideoClip();
    project.sequences[0]!.tracks[0]!.locked = true;
    const before = structuredClone(project);
    expect(deleteClip(project, { clipId }).ok).toBe(false);
    expect(project).toEqual(before);
  });
});

describe("commands media admission and tracks", () => {
  test("admits imported media to the bin without silently placing a clip", () => {
    const project = createEmptyProject();
    const result = admitImportedVideo(project, {
      ref: "video-imports/interview.mp4",
      label: "Interview",
      durationSec: 12,
      frameRate: { numerator: 30, denominator: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.media).toHaveLength(1);
    expect(result.project.sequences[0]!.tracks.flatMap((track) => track.clips)).toEqual([]);
    expect(result.project.sequences[0]!.durationSec).toBe(0);
  });

  test("adds, reorders, and deletes an empty user track", () => {
    const project = createEmptyProject();
    const added = addTrack(project, { kind: "video", id: "track-b-roll", beforeTrackId: "track-overlay" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.project.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track-captions",
      "track-b-roll",
      "track-overlay",
      "track-video",
      "track-voice",
      "track-music",
    ]);
    const reordered = reorderTrack(added.project, { trackId: "track-b-roll", destinationIndex: 0 });
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;
    expect(reordered.project.sequences[0]!.tracks[0]!.id).toBe("track-b-roll");
    const deleted = deleteTrack(reordered.project, { trackId: "track-b-roll" });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.project.sequences[0]!.tracks.some((track) => track.id === "track-b-roll")).toBe(false);
  });

  test("refuses to delete a non-empty track", () => {
    const { project } = projectWithVideoClip();
    const result = deleteTrack(project, { trackId: "track-video" });
    expect(result).toEqual({ ok: false, error: "Move or delete this track's clips before deleting the track." });
  });
});

describe("commands.moveClip", () => {
  test("moves a clip in time within the same track", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = moveClip(project, { clipId, timelineStartSec: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const track = r.project.sequences[0]!.tracks.find((t) => t.id === "track-video")!;
    expect(track.clips[0]!.timelineStartSec).toBe(10);
  });

  test("moves a video into another lane regardless of its role label", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = moveClip(project, { clipId, toTrackId: "track-voice" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.sequences[0]!.tracks.find((track) => track.id === "track-voice")!.clips[0]!.id).toBe(clipId);
  });

  test("rejects move that would overlap", () => {
    const { project, clipId } = projectWithVideoClip();
    const r2 = addClip(project, { trackId: "track-video", kind: "video", timelineStartSec: 5, durationSec: 2 });
    if (!r2.ok) throw new Error(r2.error);
    const r3 = moveClip(r2.project, { clipId, timelineStartSec: 5 });
    expect(r3.ok).toBe(false);
    if (r3.ok) return;
    expect(r3.error).toContain("overlap");
  });
});

describe("commands.moveClipGroup", () => {
  test("moves a multi-track selection atomically while preserving spacing", () => {
    let project = createEmptyProject();
    const first = addClip(project, { trackId: "track-video", kind: "video", timelineStartSec: 1, durationSec: 2, id: "clip-a" });
    if (!first.ok) throw new Error(first.error);
    const second = addClip(first.project, { trackId: "track-overlay", kind: "image", timelineStartSec: 2, durationSec: 2, id: "clip-b" });
    if (!second.ok) throw new Error(second.error);
    project = second.project;
    const result = moveClipGroup(project, {
      clipIds: ["clip-a", "clip-b"],
      anchorClipId: "clip-a",
      toTrackId: "track-video",
      timelineStartSec: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project.sequences[0]!, "clip-a")!.clip.timelineStartSec).toBe(6);
    expect(findClip(result.project.sequences[0]!, "clip-b")!.clip.timelineStartSec).toBe(7);
  });

  test("rejects the whole selection when one proposed clip collides", () => {
    const first = addClip(createEmptyProject(), { trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 2, id: "clip-a" });
    if (!first.ok) throw new Error(first.error);
    const second = addClip(first.project, { trackId: "track-overlay", kind: "image", timelineStartSec: 0, durationSec: 2, id: "clip-b" });
    if (!second.ok) throw new Error(second.error);
    const blocker = addClip(second.project, { trackId: "track-overlay", kind: "image", timelineStartSec: 5, durationSec: 2, id: "blocker" });
    if (!blocker.ok) throw new Error(blocker.error);
    const result = moveClipGroup(blocker.project, {
      clipIds: ["clip-a", "clip-b"], anchorClipId: "clip-a", toTrackId: "track-video", timelineStartSec: 5,
    });
    expect(result.ok).toBe(false);
    expect(blocker.project).toEqual(blocker.project);
    expect(findClip(blocker.project.sequences[0]!, "clip-a")!.clip.timelineStartSec).toBe(0);
    expect(findClip(blocker.project.sequences[0]!, "clip-b")!.clip.timelineStartSec).toBe(0);
  });
});

describe("commands.trimClip", () => {
  test("trims duration without changing start", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = trimClip(project, { clipId, durationSec: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clip = r.project.sequences[0]!.tracks[0]!.clips[0]!;
    expect(clip.durationSec).toBe(2);
    expect(clip.sourceOutSec).toBe(2);
  });

  test("rejects non-positive duration", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = trimClip(project, { clipId, durationSec: 0 });
    expect(r.ok).toBe(false);
  });

  test("rejects sourceOut < sourceIn", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = trimClip(project, { clipId, sourceInSec: 3, sourceOutSec: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("sourceOutSec");
  });

  test("refuses to extend beyond measured media and preserves the original", () => {
    const base = createEmptyProject();
    const project = { ...base, media: [{ id: "media-1", kind: "video" as const, ref: "video-imports/ten.mp4", durationSec: 10 }] };
    const added = addClip(project, {
      trackId: "track-video", kind: "video", mediaId: "media-1", timelineStartSec: 0,
      durationSec: 10, sourceInSec: 0, sourceOutSec: 10, id: "measured",
    });
    if (!added.ok) throw new Error(added.error);
    const before = JSON.stringify(added.project);
    const result = trimClip(added.project, { clipId: "measured", durationSec: 20 });
    expect(result).toEqual({ ok: false, error: "Source window exceeds the measured media duration." });
    expect(JSON.stringify(added.project)).toBe(before);
  });

  test("commits a left-edge trim atomically beside an adjacent clip", () => {
    const first = addClip(createEmptyProject(), {
      trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 4,
      sourceInSec: 0, sourceOutSec: 4, id: "left",
    });
    if (!first.ok) throw new Error(first.error);
    const second = addClip(first.project, {
      trackId: "track-video", kind: "video", timelineStartSec: 4, durationSec: 2, id: "neighbor",
    });
    if (!second.ok) throw new Error(second.error);
    const trimmed = trimClip(second.project, { clipId: "left", timelineStartSec: 1, durationSec: 3 });
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    expect(findClip(trimmed.project.sequences[0]!, "left")!.clip).toMatchObject({
      timelineStartSec: 1, durationSec: 3, sourceInSec: 1, sourceOutSec: 4,
    });
  });

  test("refuses an atomic trim overlap without moving the original", () => {
    const blocker = addClip(createEmptyProject(), {
      trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 2, id: "blocker",
    });
    if (!blocker.ok) throw new Error(blocker.error);
    const target = addClip(blocker.project, {
      trackId: "track-video", kind: "video", timelineStartSec: 3, durationSec: 2,
      sourceInSec: 0, sourceOutSec: 2, id: "target",
    });
    if (!target.ok) throw new Error(target.error);
    const before = JSON.stringify(target.project);
    expect(trimClip(target.project, { clipId: "target", timelineStartSec: 1, durationSec: 4 }).ok).toBe(false);
    expect(JSON.stringify(target.project)).toBe(before);
  });

  test("left-trims a legacy measured clip missing its source window from the timeline delta", () => {
    const project = {
      ...createEmptyProject(),
      media: [{ id: "legacy-media", kind: "video" as const, ref: "video-imports/legacy.mp4", durationSec: 10 }],
    };
    const legacy: Clip = {
      id: "legacy", trackId: "track-video", kind: "video", mediaId: "legacy-media",
      timelineStartSec: 0, durationSec: 10, props: {},
    };
    project.sequences[0]!.tracks[0]!.clips.push(legacy);
    const result = trimClip(project, { clipId: "legacy", timelineStartSec: 2, durationSec: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project.sequences[0]!, "legacy")!.clip).toMatchObject({ sourceInSec: 2, sourceOutSec: 10 });
  });
});

describe("commands.splitClip", () => {
  test("splits a clip into independent halves with correct source/timeline math", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = splitClip(project, { clipId, atSec: 1.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const track = r.project.sequences[0]!.tracks[0]!;
    expect(track.clips).toHaveLength(2);
    const [a, b] = track.clips as [Clip, Clip];
    expect(a.durationSec).toBeCloseTo(1.5);
    expect(b.durationSec).toBeCloseTo(2.5);
    expect(b.timelineStartSec).toBeCloseTo(1.5);
    // Source split math.
    expect(a.sourceOutSec).toBeCloseTo(1.5);
    expect(b.sourceInSec).toBeCloseTo(1.5);
    expect(b.sourceOutSec).toBeCloseTo(4);
    // Split siblings are separate edits, not linked-selection peers.
    expect(a.linkedClipIds ?? []).not.toContain(b.id);
    expect(b.linkedClipIds ?? []).not.toContain(a.id);
  });

  test("rejects split at boundary", () => {
    const { project, clipId } = projectWithVideoClip();
    expect(splitClip(project, { clipId, atSec: 0 }).ok).toBe(false);
    expect(splitClip(project, { clipId, atSec: 4 }).ok).toBe(false);
  });

  test("normalizes a legacy measured clip and refuses a malformed measured source window", () => {
    const project = {
      ...createEmptyProject(),
      media: [{ id: "measured", kind: "video" as const, ref: "video-imports/measured.mp4", durationSec: 10 }],
    };
    project.sequences[0]!.tracks[0]!.clips.push({
      id: "legacy", trackId: "track-video", kind: "video", mediaId: "measured",
      timelineStartSec: 0, durationSec: 10, props: {},
    });
    const normalized = splitClip(project, { clipId: "legacy", atSec: 4 });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.project.sequences[0]!.tracks[0]!.clips).toMatchObject([
        { sourceInSec: 0, sourceOutSec: 4 },
        { sourceInSec: 4, sourceOutSec: 10 },
      ]);
    }

    const malformed = structuredClone(project);
    malformed.sequences[0]!.tracks[0]!.clips[0] = {
      ...malformed.sequences[0]!.tracks[0]!.clips[0]!, sourceInSec: 2, sourceOutSec: 12,
    };
    const before = JSON.stringify(malformed);
    expect(splitClip(malformed, { clipId: "legacy", atSec: 4 })).toEqual({
      ok: false, error: "Source window exceeds the measured media duration.",
    });
    expect(JSON.stringify(malformed)).toBe(before);
  });
});

describe("commands.deleteClip", () => {
  test("deletes one split half without deleting its sibling", () => {
    const { project, clipId } = projectWithVideoClip();
    const split = splitClip(project, { clipId, atSec: 1 });
    if (!split.ok) throw new Error(split.error);
    const ids = split.project.sequences[0]!.tracks[0]!.clips.map((c) => c.id);
    const target = ids[0]!;
    const r = deleteClip(split.project, { clipId: target });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const remaining = r.project.sequences[0]!.tracks[0]!.clips.map((c) => c.id);
    expect(remaining).toEqual([ids[1]!]);
  });

  test("split synchronizes genuine detached audio into corresponding linked halves", () => {
    const { project, clipId } = projectWithVideoClip();
    const detached = detachAudio(project, { clipId });
    if (!detached.ok) throw new Error(detached.error);
    const split = splitClip(detached.project, { clipId, atSec: 2 });
    if (!split.ok) throw new Error(split.error);
    const halves = split.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips;
const audioHalves = split.project.sequences[0]!.tracks.find((track) => track.kind === "audio" && track.clips.length > 0)!.clips;
    expect(audioHalves).toHaveLength(2);
    expect(halves[0]!.linkedClipIds).toEqual([audioHalves[0]!.id]);
    expect(halves[1]!.linkedClipIds).toEqual([audioHalves[1]!.id]);
    expect(audioHalves[0]!.linkedClipIds).toEqual([halves[0]!.id]);
    expect(audioHalves[1]!.linkedClipIds).toEqual([halves[1]!.id]);

    const deleted = deleteClip(split.project, { clipId: halves[0]!.id });
    if (!deleted.ok) throw new Error(deleted.error);
    expect(findClip(deleted.project.sequences[0]!, halves[1]!.id)).toBeDefined();
    expect(findClip(deleted.project.sequences[0]!, audioHalves[1]!.id)).toBeDefined();
  });

  test("split preserves nonaligned peers across a synchronized video/audio split", () => {
    const { project, clipId } = projectWithVideoClip();
    const detached = detachAudio(project, { clipId });
    if (!detached.ok) throw new Error(detached.error);
    const caption = addClip(detached.project, {
      trackId: "track-captions", kind: "caption", timelineStartSec: 1, durationSec: 1, id: "caption-peer",
    });
    if (!caption.ok) throw new Error(caption.error);
    const audioId = caption.project.sequences[0]!.tracks.find((track) => track.kind === "audio" && track.clips.length > 0)!.clips[0]!.id;
    const linked = linkClips(caption.project, { clipIds: [clipId, audioId, "caption-peer"] });
    if (!linked.ok) throw new Error(linked.error);

    const split = splitClip(linked.project, { clipId, atSec: 2 });
    if (!split.ok) throw new Error(split.error);
    const videoHalves = split.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips;
    const audioHalves = split.project.sequences[0]!.tracks.find((track) => track.kind === "audio" && track.clips.length > 0)!.clips;
    const peer = findClip(split.project.sequences[0]!, "caption-peer")!.clip;
    expect(videoHalves[0]!.linkedClipIds).toEqual([audioHalves[0]!.id, peer.id]);
    expect(videoHalves[1]!.linkedClipIds).toEqual([audioHalves[1]!.id, peer.id]);
    expect(audioHalves[0]!.linkedClipIds).toEqual([videoHalves[0]!.id, peer.id]);
    expect(audioHalves[1]!.linkedClipIds).toEqual([videoHalves[1]!.id, peer.id]);
    expect(peer.linkedClipIds).toEqual([
      videoHalves[0]!.id, videoHalves[1]!.id, audioHalves[0]!.id, audioHalves[1]!.id,
    ]);
  });
});

describe("commands.linkClips / unlinkClips", () => {
  test("links two clips bidirectionally", () => {
    const base = createEmptyProject();
    const a = addClip(base, { trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 2 });
    if (!a.ok) throw new Error(a.error);
    const b = addClip(a.project, { trackId: "track-overlay", kind: "text", timelineStartSec: 0, durationSec: 2 });
    if (!b.ok) throw new Error(b.error);
    const ids = b.project.sequences[0]!.tracks.flatMap((t) => t.clips.map((c) => c.id));
    expect(ids.length).toBe(2);
    const r = linkClips(b.project, { clipIds: ids });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.project.sequences[0]!.tracks.flatMap((t) => t.clips);
    const clipA = all.find((c) => c.id === ids[0])!;
    const clipB = all.find((c) => c.id === ids[1])!;
    expect(clipA.linkedClipIds).toContain(ids[1]);
    expect(clipB.linkedClipIds).toContain(ids[0]);
  });

  test("unlink removes the link", () => {
    const base = createEmptyProject();
    const a = addClip(base, { trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 2 });
    if (!a.ok) throw new Error(a.error);
    const b = addClip(a.project, { trackId: "track-overlay", kind: "text", timelineStartSec: 0, durationSec: 2 });
    if (!b.ok) throw new Error(b.error);
    const ids = b.project.sequences[0]!.tracks.flatMap((t) => t.clips.map((c) => c.id));
    const linked = linkClips(b.project, { clipIds: ids });
    if (!linked.ok) throw new Error(linked.error);
    const r = unlinkClips(linked.project, { clipIds: ids });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.project.sequences[0]!.tracks.flatMap((t) => t.clips);
    expect(all.find((c) => c.id === ids[0])!.linkedClipIds ?? []).not.toContain(ids[1]);
  });
});

describe("commands.detachAudio", () => {
  test("creates space immediately above video, preserving source trim and disabling embedded audio", () => {
    const { project, clipId } = projectWithVideoClip();
    const original = JSON.stringify(project);
    const result = detachAudio(project, { clipId });
    if (!result.ok) throw new Error(result.error);
    const ordered = [...result.project.sequences[0]!.tracks].sort((a, b) => a.order - b.order);
    const videoIndex = ordered.findIndex((track) => track.id === "track-video");
    const video = ordered[videoIndex]!.clips[0]!;
    const audio = ordered[videoIndex - 1]!.clips[0]!;
    expect(audio).toMatchObject({ kind: "audio", mediaId: video.mediaId, timelineStartSec: video.timelineStartSec, durationSec: video.durationSec, sourceInSec: video.sourceInSec, sourceOutSec: video.sourceOutSec });
    expect(video.props["muted"]).toBe(true);
    expect(audio.props["muted"]).not.toBe(true);
    expect(JSON.stringify(project)).toBe(original);
    expect(detachAudio(result.project, { clipId })).toEqual({ ok: false, error: "Audio is already separated from this clip." });
  });

  test("does not collide with occupied audio and leaves locked source projects unchanged", () => {
    const { project, clipId } = projectWithVideoClip();
    const populated = addClip(project, { trackId: "track-voice", kind: "audio", timelineStartSec: 0, durationSec: 4 });
    if (!populated.ok) throw new Error(populated.error);
    expect(detachAudio(populated.project, { clipId }).ok).toBe(true);
    expect(detachAudio(populated.project, { clipId, toTrackId: "track-voice" }).ok).toBe(false);
    const locked = structuredClone(populated.project);
    locked.sequences[0]!.tracks.find((track) => track.id === "track-video")!.locked = true;
    const original = JSON.stringify(locked);
    expect(detachAudio(locked, { clipId }).ok).toBe(false);
    expect(JSON.stringify(locked)).toBe(original);
  });

  test("creates a linked audio clip on an audio track", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = detachAudio(project, { clipId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seq = r.project.sequences[0]!;
    const audioTrack = seq.tracks.find((t) => t.kind === "audio" && t.clips.length > 0)!;
    expect(audioTrack.clips).toHaveLength(1);
    const audio = audioTrack.clips[0]!;
    expect(audio.kind).toBe("audio");
    expect(audio.linkedClipIds).toContain(clipId);
    const videoClip = seq.tracks.find((t) => t.id === "track-video")!.clips[0]!;
    expect(videoClip.linkedClipIds).toContain(audio.id);
  });

  test("rejects detach from a non-video clip", () => {
    const base = createEmptyProject();
    const a = addClip(base, { trackId: "track-captions", kind: "caption", timelineStartSec: 0, durationSec: 2 });
    if (!a.ok) throw new Error(a.error);
    const captionId = a.project.sequences[0]!.tracks.find((t) => t.id === "track-captions")!.clips[0]!.id;
    const r = detachAudio(a.project, { clipId: captionId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("video clip");
  });
});

describe("commands.updateClipProps", () => {
  test("merges partial props into a clip and bumps metadata", () => {
    const base = createEmptyProject();
    const a = addClip(base, {
      trackId: "track-captions",
      kind: "caption",
      timelineStartSec: 0,
      durationSec: 2,
      props: { text: "old", align: "left" },
    });
    if (!a.ok) throw new Error(a.error);
    const captionId = a.project.sequences[0]!.tracks.find((t) => t.id === "track-captions")!.clips[0]!.id;
    const r = updateClipProps(a.project, { clipId: captionId, props: { text: "new" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clip = r.project.sequences[0]!.tracks.find((t) => t.id === "track-captions")!.clips[0]!;
    expect(clip.props).toEqual({ text: "new", align: "left" });
    expect(r.project.metadata?.updatedAt).toBeTruthy();
  });

  test("does not change kind, track, or timing", () => {
    const { project, clipId } = projectWithVideoClip();
    const r = updateClipProps(project, { clipId, props: { volume: 0.5 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clip = r.project.sequences[0]!.tracks[0]!.clips[0]!;
    expect(clip.kind).toBe("video");
    expect(clip.trackId).toBe("track-video");
    expect(clip.timelineStartSec).toBe(0);
    expect(clip.durationSec).toBe(4);
    expect(clip.props).toEqual({ volume: 0.5 });
  });

  test("rejects not-found clip", () => {
    const base = createEmptyProject();
    const r = updateClipProps(base, { clipId: "ghost", props: { x: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Clip not found");
  });

  test("rejects non-object props", () => {
    const { project, clipId } = projectWithVideoClip();

    const r = updateClipProps(project, { clipId, props: "nope" as unknown as Record<string, unknown> });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("props must be an object");
  });
});

describe("commands.promoteGeneratedTake", () => {
  test("automatically admits media without changing any timeline and tolerates duplicate completion", () => {
    const take = sampleGeneratedTake();
    const project = { ...createEmptyProject(), generatedTakes: [take] };
    const ready = { status: "ready" as const, take, durationSec: 4.5 };
    const admitted = admitGeneratedTakeMedia(project, ready);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.project.sequences).toEqual(project.sequences);
    expect(project.media).toHaveLength(0);
    expect(admitted.project.media).toHaveLength(1);
    const duplicate = admitGeneratedTakeMedia(admitted.project, ready);
    expect(duplicate).toEqual({ ok: true, project: admitted.project });
    if (duplicate.ok) expect(duplicate.project).toBe(admitted.project);
    const placed = promoteGeneratedTake(admitted.project, { revalidated: ready, sequenceId: "sequence-1", trackId: "track-video", timelineStartSec: 0 });
    expect(placed.ok).toBe(true);
    if (placed.ok) {
      expect(placed.project.media).toHaveLength(1);
      expect(placed.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips).toHaveLength(1);
    }
  });

  test("automatic admission refuses unrecorded, stale or mismatched media and preserves earlier takes", () => {
    const take = sampleGeneratedTake();
    expect(admitGeneratedTakeMedia(createEmptyProject(), { status: "ready", take, durationSec: 5 }).ok).toBe(false);
    const project = { ...createEmptyProject(), generatedTakes: [take] };
    expect(admitGeneratedTakeMedia(project, { status: "stale", takeId: take.id }).ok).toBe(false);
    const first = admitGeneratedTakeMedia(project, { status: "ready", take, durationSec: 5 });
    if (!first.ok) throw new Error(first.error);
    expect(admitGeneratedTakeMedia(first.project, { status: "ready", take, durationSec: 6 }).ok).toBe(false);
    const nextTake = { ...take, id: "take_qrstuvwxyzabcdef", artifact: { ...take.artifact, artifactId: "22f94bcd-52bb-4dc6-b9e3-ebca09ca22ac", path: "generated-media/alternative.mp4" } };
    const next = admitGeneratedTakeMedia({ ...first.project, generatedTakes: [take, nextTake] }, { status: "ready", take: nextTake, durationSec: 5 });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.project.media).toHaveLength(2);
      expect(next.project.media[0]).toEqual(first.project.media[0]);
      expect(next.project.sequences).toEqual(project.sequences);
    }
  });
  test("adds exactly one durable media asset and one explicit clip without changing sequence rate", () => {
    const take = sampleGeneratedTake();
    const project = { ...createEmptyProject(), generatedTakes: [take] };
    const beforeRate = project.sequences[0]!.frameRate;

    const result = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 4.5 },
      sequenceId: "sequence-1",
      trackId: "track-video",
      timelineStartSec: 0,
      mediaId: "media-generated-opening",
      clipId: "clip-generated-opening",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.sequences[0]!.frameRate).toEqual(beforeRate);
    expect(result.project.media).toHaveLength(1);
    expect(result.project.media[0]).toMatchObject({
      id: "media-generated-opening",
      lifecycle: "durable",
      ref: "generated-media/take-opening.mp4",
      source: {
        kind: "workspace-artifact",
        artifactId: take.artifact.artifactId,
        path: take.artifact.path,
      },
    });
    expect(result.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips).toMatchObject([
      {
        id: "clip-generated-opening",
        mediaId: "media-generated-opening",
        timelineStartSec: 0,
        durationSec: 4.5,
        sourceInSec: 0,
        sourceOutSec: 4.5,
      },
    ]);
  });

  test("refuses unavailable, stale, mismatched, or absent/invalid measured duration without mutation", () => {
    const take = sampleGeneratedTake();
    const project = { ...createEmptyProject(), generatedTakes: [take] };
    const before = JSON.stringify(project);
    const base = { sequenceId: "sequence-1", trackId: "track-video", timelineStartSec: 0 };

    for (const status of ["stale", "deleted", "unavailable", "malformed"] as const) {
      const result = promoteGeneratedTake(project, { ...base, revalidated: { status, takeId: take.id } });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(project)).toBe(before);
    }
    const changed = { ...take, artifact: { ...take.artifact, bytes: take.artifact.bytes + 1 } };
    expect(promoteGeneratedTake(project, { ...base, revalidated: { status: "ready", take: changed, durationSec: 5 } }).ok).toBe(false);
    const missingDuration = { status: "ready" as const, take };
    expect(promoteGeneratedTake(project, { ...base, revalidated: missingDuration as unknown as import("./commands").GeneratedTakeRevalidation }).ok).toBe(false);
    for (const durationSec of [0, Number.NaN, Infinity]) {
      expect(promoteGeneratedTake(project, { ...base, revalidated: { status: "ready", take, durationSec } }).ok).toBe(false);
    }
    const durationless = { ...take, settings: {} };
    const durationlessProject = { ...createEmptyProject(), generatedTakes: [durationless] };
    const durationlessPromotion = promoteGeneratedTake(durationlessProject, {
      ...base,
      revalidated: { status: "ready", take: durationless, durationSec: 3.25 },
    });
    expect(durationlessPromotion.ok).toBe(true);
    if (durationlessPromotion.ok) {
      expect(durationlessPromotion.project.media[0]!.durationSec).toBe(3.25);
    }
  });

  test("uses the ordinary overlap guard and never creates a partial media asset", () => {
    const take = sampleGeneratedTake();
    const existing = addClip(createEmptyProject(), {
      trackId: "track-video",
      kind: "video",
      timelineStartSec: 1,
      durationSec: 3,
    });
    if (!existing.ok) throw new Error(existing.error);
    const project = { ...existing.project, generatedTakes: [take] };

    const result = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 5 },
      sequenceId: "sequence-1",
      trackId: "track-video",
      timelineStartSec: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("overlaps");
    expect(project.media).toHaveLength(0);
  });

  test("requires and honors the explicit target sequence", () => {
    const take = sampleGeneratedTake();
    const first = createEmptyProject().sequences[0]!;
    const second = { ...createDefaultSequence(), id: "sequence-2" };
    const project = { ...createEmptyProject(), sequences: [first, second], generatedTakes: [take] };
    const before = JSON.stringify(project);

    const missingSequence = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 5 },
      sequenceId: "",
      trackId: "track-video",
      timelineStartSec: 0,
    });
    expect(missingSequence.ok).toBe(false);
    expect(JSON.stringify(project)).toBe(before);

    const wrongSequence = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 5 },
      sequenceId: "sequence-missing",
      trackId: "track-video",
      timelineStartSec: 0,
    });
    expect(wrongSequence.ok).toBe(false);
    expect(JSON.stringify(project)).toBe(before);

    const promoted = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 5 },
      sequenceId: "sequence-2",
      trackId: "track-video",
      timelineStartSec: 0,
    });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips).toHaveLength(0);
    expect(promoted.project.sequences[1]!.tracks.find((track) => track.id === "track-video")!.clips).toHaveLength(1);
  });
});
