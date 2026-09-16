import { describe, expect, test } from "bun:test";
import {
  addClip,
  deleteClip,
  detachAudio,
  linkClips,
  moveClip,
  splitClip,
  updateClipProps,
  updateTrack,
} from "./commands";
import { createEmptyProject, type Clip, type VideoProject } from "./edl";
import { validateVideoProject } from "./video-document";

function withTrackState(project: VideoProject, trackId: string, state: { locked?: boolean; muted?: boolean; hidden?: boolean }): VideoProject {
  const sequence = project.sequences[0]!;
  return {
    ...project,
    sequences: [{
      ...sequence,
      tracks: sequence.tracks.map((track) => track.id === trackId ? { ...track, ...state } : track),
    }],
  };
}

function linkedProject(): VideoProject {
  const project = createEmptyProject();
  const video = addClip(project, { id: "video", trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 4 });
  if (!video.ok) throw new Error(video.error);
  const audio = addClip(video.project, { id: "audio", trackId: "track-voice", kind: "audio", timelineStartSec: 0, durationSec: 4 });
  if (!audio.ok) throw new Error(audio.error);
  const linked = linkClips(audio.project, { clipIds: ["video", "audio"] });
  if (!linked.ok) throw new Error(linked.error);
  return linked.project;
}

describe("durable track state", () => {
  test("validates optional state strictly while preserving legacy omission", () => {
    const legacy = validateVideoProject(createEmptyProject());
    expect(legacy.sequences[0]!.tracks[0]!.locked).toBeUndefined();

    const project = createEmptyProject();
    Object.assign(project.sequences[0]!.tracks[0]!, {
      name: "  Picture  ", locked: true, muted: false, hidden: true,
    });
    expect(validateVideoProject(project).sequences[0]!.tracks[0]).toMatchObject({
      name: "Picture", locked: true, muted: false, hidden: true,
    });
    Object.assign(project.sequences[0]!.tracks[0]!, { locked: "yes" });
    expect(() => validateVideoProject(project)).toThrow("locked must be a boolean");
  });

  test("updates editable track state and requires a separate unlock", () => {
    const updated = updateTrack(createEmptyProject(), {
      trackId: "track-video", name: "Main picture", locked: true, muted: true, hidden: true,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.project.sequences[0]!.tracks[0]).toMatchObject({
      name: "Main picture", locked: true, muted: true, hidden: true,
    });
    expect(updateTrack(updated.project, { trackId: "track-video", locked: false, name: "Bypass" })).toEqual({
      ok: false, error: "Track is locked: track-video",
    });
    const presentation = updateTrack(updated.project, { trackId: "track-video", muted: false, hidden: false });
    expect(presentation.ok).toBe(true);
    if (!presentation.ok) return;
    expect(presentation.project.sequences[0]!.tracks[0]).toMatchObject({ locked: true, muted: false, hidden: false });
    expect(updateTrack(updated.project, { trackId: "track-video", locked: false }).ok).toBe(true);
  });

  test("refuses clip, property, and linked-peer mutations atomically", () => {
    const locked = withTrackState(linkedProject(), "track-voice", { locked: true });
    expect(moveClip(locked, { clipId: "video", timelineStartSec: 8 })).toEqual({ ok: false, error: "Track is locked: track-voice" });
    expect(updateClipProps(locked, { clipId: "video", props: { opacity: 0.5 } })).toEqual({ ok: false, error: "Track is locked: track-voice" });
    expect(deleteClip(locked, { clipId: "video" })).toEqual({ ok: false, error: "Track is locked: track-voice" });
    expect(locked.sequences[0]!.tracks.flatMap((track) => track.clips).map((clip) => clip.id).sort()).toEqual(["audio", "video"]);
  });

  test("hidden tracks reject direct and linked edits until explicitly shown", () => {
    const hidden = withTrackState(linkedProject(), "track-voice", { hidden: true });
    const before = structuredClone(hidden);
    for (const result of [
      moveClip(hidden, { clipId: "video", timelineStartSec: 8 }),
      updateClipProps(hidden, { clipId: "audio", props: { volume: 0.5 } }),
      deleteClip(hidden, { clipId: "audio" }),
      splitClip(hidden, { clipId: "audio", atSec: 2 }),
      addClip(hidden, { trackId: "track-voice", kind: "audio", timelineStartSec: 4, durationSec: 2 }),
    ]) expect(result).toEqual({ ok: false, error: "Track is hidden: track-voice. Show it before editing." });
    expect(hidden).toEqual(before);
    const deleted = deleteClip(hidden, { clipId: "video" });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.project.sequences[0]!.tracks.flatMap((track) => track.clips).map((clip) => clip.id)).toEqual(["audio"]);
      const kept = deleted.project.sequences[0]!.tracks.find((track) => track.id === "track-voice")!.clips[0]!;
      expect({ ...kept, linkedClipIds: [] }).toEqual({ ...hidden.sequences[0]!.tracks.find((track) => track.id === "track-voice")!.clips[0]!, linkedClipIds: [] });
    }
    const shown = updateTrack(hidden, { trackId: "track-voice", hidden: false });
    expect(shown.ok).toBe(true); if (!shown.ok) return;
    expect(moveClip(shown.project, { clipId: "video", timelineStartSec: 8 }).ok).toBe(true);
  });

  test("detach preserves audio controls and explicitly mutes original video", () => {
    let project = createEmptyProject();
    const added = addClip(project, {
      id: "video", trackId: "track-video", kind: "video", mediaId: "media", timelineStartSec: 0, durationSec: 4,
      props: { volume: 0.4, muted: false, crop: "fill" },
    });
    if (!added.ok) throw new Error(added.error);
    project = added.project;
    const detached = detachAudio(project, { clipId: "video", toTrackId: "track-voice" });
    expect(detached.ok).toBe(true);
    if (!detached.ok) return;
    const clips = detached.project.sequences[0]!.tracks.flatMap((track) => track.clips);
    expect(clips.find((clip) => clip.id === "video")!.props).toEqual({ volume: 0.4, muted: true, crop: "fill" });
    expect(clips.find((clip) => clip.kind === "audio")!.props).toEqual({ volume: 0.4, muted: false });
  });

  test("split preserves every piece beyond the former 500-clip quota", () => {
    const project = createEmptyProject();
    const track = project.sequences[0]!.tracks[0]!;
    track.clips = Array.from({ length: 500 }, (_, index): Clip => ({
      id: index === 0 ? "split-me" : `clip-${index}`,
      kind: "video",
      trackId: track.id,
      timelineStartSec: index * 2,
      durationSec: 1,
      props: {},
    }));
    const result = splitClip(project, { clipId: "split-me", atSec: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.sequences[0]!.tracks[0]!.clips).toHaveLength(501);
    expect(project.sequences[0]!.tracks[0]!.clips).toHaveLength(500);
  });
});
