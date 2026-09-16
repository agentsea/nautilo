import { describe, expect, test } from "bun:test";
import { isClipKindAllowedOnTrack, type Clip, type Sequence } from "./edl";
import { createCuttingRoomFixtureProject } from "./cutting-room-fixture";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";

function listClips(sequence: Sequence): Clip[] {
  return sequence.tracks.flatMap((track) => track.clips);
}

describe("cutting-room structural fixture", () => {
  test("has exactly six ordered compatible tracks and twenty non-overlapping clips", () => {
    const project = createCuttingRoomFixtureProject();
    const sequence = project.sequences[0]!;

    expect(project.media).toEqual([]);
    expect(sequence.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(sequence.durationSec).toBe(75);
    expect(sequence.tracks.map((track) => [track.id, track.kind, track.order])).toEqual([
      ["track-picture", "video", 0],
      ["track-b-roll", "video", 1],
      ["track-overlays", "overlay", 2],
      ["track-captions", "caption", 3],
      ["track-voice", "audio", 4],
      ["track-music", "music", 5],
    ]);
    const clips = listClips(sequence);
    expect(clips).toHaveLength(20);
    expect(new Set(clips.map((clip) => clip.id)).size).toBe(20);

    for (const track of sequence.tracks) {
      expect(track.clips.every((clip) => clip.trackId === track.id && isClipKindAllowedOnTrack(clip.kind, track.kind))).toBe(true);
      const ordered = [...track.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]!;
        const current = ordered[index]!;
        expect(previous.timelineStartSec + previous.durationSec).toBeLessThanOrEqual(current.timelineStartSec);
      }
    }
  });

  test("round-trips through the bounded document parser without media bytes or invented decode metadata", () => {
    const project = createCuttingRoomFixtureProject();
    const serialized = serializeVideoHtml(createDefaultManifest(), project);
    const parsed = parseVideoHtml(serialized);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.project).toEqual(project);
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toMatch(/codec|decoded|resolution|waveform/i);
  });

  test("returns deterministic independent project instances", () => {
    const first = createCuttingRoomFixtureProject();
    const second = createCuttingRoomFixtureProject();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.sequences[0]).not.toBe(second.sequences[0]);
    expect(first.sequences[0]!.tracks[0]!.clips[0]).not.toBe(second.sequences[0]!.tracks[0]!.clips[0]);

    first.sequences[0]!.tracks[0]!.clips[0]!.props["label"] = "Changed only here";
    expect(second.sequences[0]!.tracks[0]!.clips[0]!.props["label"]).toBe("Dawn over the studio");
  });
});
