import { describe, expect, test } from "bun:test";
import { createEmptyProject, type VideoProject } from "./edl";
import { copyTimelineSelection, detachAudio, moveClip, setClipFade, splitClip, trimClip } from "./commands";
import { clipFades, fadeFactor, validFades } from "./fades";
import { compileSequence, evaluateSequence } from "./sequence-evaluation";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";
import { buildSequenceRenderPlan } from "./render-plan";

function fixture(): VideoProject {
  const project = createEmptyProject();
  project.media = [{ id: "media", kind: "video", ref: "fixture.mp4", durationSec: 20 }];
  project.sequences[0]!.durationSec = 4;
  project.sequences[0]!.tracks = [{ id: "lane", kind: "video", order: 0, clips: [{ id: "v", trackId: "lane", kind: "video", mediaId: "media", timelineStartSec: 0, durationSec: 4, sourceInSec: 3, sourceOutSec: 7, props: {} }] }];
  return project;
}
function applied(project = fixture()) {
  const result = setClipFade(project, { clipId: "v", key: "videoIn", durationSec: 2, linkedAudio: true });
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

describe("source-anchored clip fades", () => {
  test("evaluates opacity/audio together without changing timing; native plan shares source windows", () => {
    const original = fixture(); const project = applied(original);
    expect(original.sequences[0]!.tracks[0]!.clips[0]!.props).toEqual({});
    const compiled = compileSequence(project);
    expect(evaluateSequence(compiled, 0)[0]).toMatchObject({ gain: 0, opacity: 0 });
    expect(evaluateSequence(compiled, 1)[0]).toMatchObject({ gain: 0.5, opacity: 0.5 });
    expect(evaluateSequence(compiled, 2)[0]).toMatchObject({ gain: 1, opacity: 1 });
    expect(buildSequenceRenderPlan(project)).toMatchObject({ ok: true, plan: { durationSec: 4, layers: [{ fades: { videoIn: { startSec: 3, durationSec: 2 }, audioIn: { startSec: 3, durationSec: 2 } } }] } });
  });
  test("split, trim, move and range copy preserve a partial fade instead of restarting it", () => {
    const project = applied(); const originalFades = clipFades(project.sequences[0]!.tracks[0]!.clips[0]!);
    const split = splitClip(project, { clipId: "v", atSec: 1 }); expect(split.ok).toBe(true); if (!split.ok) return;
    expect(evaluateSequence(compileSequence(split.project), 1)[0]).toMatchObject({ opacity: 0.5, gain: 0.5 });
    const trimmed = trimClip(project, { clipId: "v", timelineStartSec: 1, durationSec: 3 }); expect(trimmed.ok).toBe(true); if (!trimmed.ok) return;
    expect(evaluateSequence(compileSequence(trimmed.project), 1)[0]?.opacity).toBe(0.5);
    const moved = moveClip(trimmed.project, { clipId: "v", toTrackId: "lane", timelineStartSec: 0 }); expect(moved.ok).toBe(true); if (!moved.ok) return;
    expect(evaluateSequence(compileSequence(moved.project), 0)[0]?.opacity).toBe(0.5);
    const copied = copyTimelineSelection(project, { clipIds: [], range: { inSec: 1, outSec: 3 } }); expect(copied.ok).toBe(true); if (!copied.ok) return;
    expect(clipFades(copied.clipboard.clips[0]!)).toEqual(originalFades);
    expect(copied.clipboard.clips[0]!.sourceInSec).toBe(4);
  });
  test("saved effects require 1.1; legacy files stay 1.0; malformed ramps fail closed", () => {
    const legacy = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), fixture()));
    expect(legacy.ok && legacy.document.manifest.version).toBe("1.0");
    const html = serializeVideoHtml(createDefaultManifest(), applied());
    const parsed = parseVideoHtml(html); expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.document.manifest.version).toBe("1.1");
    expect(parsed.ok && evaluateSequence(compileSequence(parsed.document.project), 1)[0]?.opacity).toBe(0.5);
    expect(parseVideoHtml(html.replace('"version": "1.1"', '"version": "1.0"')).ok).toBe(false);
    for (const raw of [null, [], { nonsense: {} }, { audioIn: { startSec: -1, durationSec: 1 } }, { videoIn: { startSec: 0, durationSec: Infinity } }, { videoIn: { startSec: 0, durationSec: 0 } }]) expect(validFades(raw)).toBe(false);
  });
  test("linked targets and track protection are atomic; removal never deletes clips", () => {
    const detached = detachAudio(fixture(), { clipId: "v" }); expect(detached.ok).toBe(true); if (!detached.ok) return;
    const sound = detached.project.sequences[0]!.tracks.find((track) => track.clips.some((clip) => clip.kind === "audio"))!;
    sound.hidden = true;
    const before = JSON.stringify(detached.project);
    expect(setClipFade(detached.project, { clipId: "v", key: "videoIn", durationSec: 1, linkedAudio: true }).ok).toBe(false);
    expect(JSON.stringify(detached.project)).toBe(before);
    expect(setClipFade(detached.project, { clipId: "v", key: "videoIn", durationSec: 1, linkedAudio: false }).ok).toBe(true);
    sound.hidden = false;
    const project = applied(detached.project);
    expect(project.sequences[0]!.tracks.flatMap((track) => track.clips).filter((clip) => clipFades(clip).audioIn)).toHaveLength(2);
    const removed = setClipFade(project, { clipId: "v", key: "videoIn", durationSec: 0, linkedAudio: true }); expect(removed.ok).toBe(true); if (!removed.ok) return;
    expect(removed.project.sequences[0]!.tracks.flatMap((track) => track.clips)).toHaveLength(2);
    expect(removed.project.sequences[0]!.tracks.flatMap((track) => track.clips).every((clip) => Object.keys(clipFades(clip)).length === 0)).toBe(true);
    expect(setClipFade(fixture(), { clipId: "v", key: "videoOut", durationSec: 5 }).ok).toBe(false);
  });
  test("opposing fades multiply; separating audio carries only audio ramps", () => {
    expect(fadeFactor({ videoIn: { startSec: 0, durationSec: 2 }, videoOut: { startSec: 0, durationSec: 2 } }, "video", 1)).toBe(0.25);
    const separated = detachAudio(applied(), { clipId: "v" }); expect(separated.ok).toBe(true); if (!separated.ok) return;
    const audio = separated.project.sequences[0]!.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === "audio")!;
    expect(clipFades(audio)).toEqual({ audioIn: { startSec: 3, durationSec: 2 } });
  });
});
