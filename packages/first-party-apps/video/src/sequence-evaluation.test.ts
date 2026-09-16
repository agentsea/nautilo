import { describe, expect, test } from "bun:test";
import { createEmptyProject, type VideoProject } from "./edl";
import { compileSequence, evaluateSequence } from "./sequence-evaluation";

export function sequenceFixture(): VideoProject {
  const project = createEmptyProject();
  const sequence = project.sequences[0]!;
  sequence.durationSec = 5;
  sequence.frameRate = { numerator: 30000, denominator: 1001 };
  project.media = [
    { id: "first", kind: "video", ref: "first.mp4", durationSec: 12 },
    { id: "second", kind: "video", ref: "second.mp4", durationSec: 8 },
    { id: "audio", kind: "audio", ref: "audio.mp4", durationSec: 5 },
  ];
  sequence.tracks = [
    { id: "top", kind: "video", order: 0, clips: [
      { id: "a", kind: "video", trackId: "top", mediaId: "first", timelineStartSec: 0, durationSec: 2, sourceInSec: 3, sourceOutSec: 5, props: {} },
      { id: "b", kind: "video", trackId: "top", mediaId: "second", timelineStartSec: 3, durationSec: 2, sourceInSec: 1, sourceOutSec: 3, props: {} },
    ] },
    { id: "sound", kind: "audio", order: 1, clips: [
      { id: "sound-a", kind: "audio", trackId: "sound", mediaId: "audio", timelineStartSec: 0, durationSec: 5, sourceInSec: 0, sourceOutSec: 5, props: { volume: 0.5 } },
    ] },
  ];
  return project;
}

describe("assembled sequence evaluation", () => {
  test("cuts, source offsets, gaps, and the end are half-open on the rational grid", () => {
    const compiled = compileSequence(sequenceFixture());
    expect(compiled.frameDurationSec).toBe(1001 / 30000);
    expect(evaluateSequence(compiled, 1).find((entry) => entry.clip.id === "a")?.sourceTimeSec).toBe(4);
    expect(evaluateSequence(compiled, 2).map((entry) => entry.clip.id)).toEqual(["sound-a"]);
    expect(evaluateSequence(compiled, 3).map((entry) => entry.clip.id)).toEqual(["sound-a", "b"]);
    expect(evaluateSequence(compiled, 3).at(-1)?.sourceTimeSec).toBe(1);
    expect(evaluateSequence(compiled, 5)).toEqual([]);
    expect(evaluateSequence(compiled, Number.NaN)).toEqual([]);
  });

  test("hiding suppresses the whole track without changing its saved mute or lock state", () => {
    const project = sequenceFixture();
    const top = project.sequences[0]!.tracks[0]!;
    top.hidden = true; top.locked = true;
    let entry = evaluateSequence(compileSequence(project), 1).find((item) => item.clip.id === "a");
    expect(entry).toBeUndefined();
    top.hidden = false;
    expect(evaluateSequence(compileSequence(project), 1).find((item) => item.clip.id === "a")).toMatchObject({ visual: true, gain: 1 });
    top.hidden = true;
    top.muted = true;
    expect(evaluateSequence(compileSequence(project), 1).map((item) => item.clip.id)).toEqual(["sound-a"]);
    top.hidden = false;
    entry = evaluateSequence(compileSequence(project), 1).find((item) => item.clip.id === "a");
    expect(entry).toMatchObject({ visual: true, gain: 0 });
    project.sequences[0]!.tracks[1]!.hidden = true;
    expect(evaluateSequence(compileSequence(project), 1).map((item) => item.clip.id)).toEqual(["a"]);
  });

  test("lower track order is painted above higher order and detach mute prevents double audio", () => {
    const project = sequenceFixture();
    project.sequences[0]!.tracks[0]!.clips[0]!.props = { muted: true };
    const entries = evaluateSequence(compileSequence(project), 1);
    expect(entries.map((item) => item.clip.id)).toEqual(["sound-a", "a"]);
    expect(entries.map((item) => item.gain)).toEqual([0.5, 0]);
  });
});
