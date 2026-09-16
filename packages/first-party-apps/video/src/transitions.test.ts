import { describe, expect, test } from "bun:test";
import { createEmptyProject } from "./edl";
import { copyTimelineSelection, deleteClip, moveClip, moveClipGroup, pasteTimelineClipboard, setCutTransition, splitClip, trimClip, updateTrack } from "./commands";
import { clipTransition, transitionProblem, transitionTarget, validCutTransition } from "./transitions";
import { compileSequence, evaluateSequence } from "./sequence-evaluation";
import { buildSequenceRenderPlan } from "./render-plan";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";

function fixture() {
  const project = createEmptyProject();
  project.media = [{ id: "a", kind: "video", ref: "a.mp4", durationSec: 8 }, { id: "b", kind: "video", ref: "b.mp4", durationSec: 8 }];
  project.sequences[0]!.durationSec = 6;
  project.sequences[0]!.tracks = [{ id: "lane", kind: "music", order: 0, clips: [
    { id: "a", kind: "video", trackId: "lane", mediaId: "a", timelineStartSec: 0, durationSec: 3, sourceInSec: 0, sourceOutSec: 3, props: {} },
    { id: "b", kind: "video", trackId: "lane", mediaId: "b", timelineStartSec: 3, durationSec: 3, sourceInSec: 3, sourceOutSec: 6, props: {} },
  ] }];
  return project;
}
const input = { clipId: "b", kind: "crossfade" as const, direction: "left" as const, durationSec: 2 };
function applied() { const result = setCutTransition(fixture(), input); if (!result.ok) throw new Error(result.error); return result.project; }

describe("cut transitions", () => {
  test("two live sources blend at a fixed cut without changing saved timing", () => {
    const project = fixture(); const next = applied();
    expect(project.sequences[0]!.tracks[0]!.clips[1]!.props).toEqual({});
    expect(next.sequences[0]!.tracks[0]!.clips.map((clip) => [clip.timelineStartSec, clip.durationSec])).toEqual([[0, 3], [3, 3]]);
    const compiled = compileSequence(next);
    expect(evaluateSequence(compiled, 1.9)).toHaveLength(1);
    expect(evaluateSequence(compiled, 3).map((entry) => [entry.sourceTimeSec, entry.opacity, entry.gain])).toEqual([[3, 1, 0.5], [3, 0.5, 0.5]]);
    expect(evaluateSequence(compiled, 4)).toHaveLength(1);
    expect(buildSequenceRenderPlan(next)).toMatchObject({ ok: true, plan: { durationSec: 6, layers: [
      { timelineStartSec: 0, durationSec: 4, sourceInSec: 0, transitionOut: { startSec: 2, durationSec: 2 } },
      { timelineStartSec: 2, durationSec: 4, sourceInSec: 2, transitionIn: { startSec: 2, durationSec: 2 } },
    ] } });
  });
  test("swipe direction is shared geometry, not a fade through black", () => {
    for (const [direction, expected] of [["left", "inset(0 0 0 50%)"], ["right", "inset(0 50% 0 0)"], ["up", "inset(50% 0 0 0)"], ["down", "inset(0 0 50% 0)"]] as const) {
      const result = setCutTransition(fixture(), { ...input, kind: "swipe", direction }); if (!result.ok) throw new Error(result.error);
      expect(evaluateSequence(compileSequence(result.project), 3)[1]).toMatchObject({ opacity: 1, clipPath: expected });
    }
  });
  test("missing handles, unknown source duration, gaps, hidden/locked lanes and malformed effects refuse atomically", () => {
    for (const change of [(p: ReturnType<typeof fixture>) => { p.sequences[0]!.tracks[0]!.hidden = true; },
      (p: ReturnType<typeof fixture>) => { p.sequences[0]!.tracks[0]!.locked = true; },
      (p: ReturnType<typeof fixture>) => { p.sequences[0]!.tracks[0]!.clips[1]!.sourceInSec = 0; },
      (p: ReturnType<typeof fixture>) => { p.sequences[0]!.tracks[0]!.clips[1]!.timelineStartSec = 3.01; },
      (p: ReturnType<typeof fixture>) => { delete p.media[0]!.durationSec; }]) {
      const project = fixture(); change(project); const before = JSON.stringify(project);
      expect(setCutTransition(project, input).ok).toBe(false); expect(JSON.stringify(project)).toBe(before);
    }
    expect(setCutTransition(fixture(), { ...input, durationSec: Infinity }).ok).toBe(false);
    expect(validCutTransition({ ...input, fromClipId: "a" })).toBe(false);
    const bad = applied(); bad.sequences[0]!.tracks[0]!.clips[1]!.props["transition"] = { fromClipId: "a", kind: "injected", direction: "left", durationSec: 1 };
    expect(transitionProblem(bad)).not.toBeNull(); expect(buildSequenceRenderPlan(bad).ok).toBe(false);
  });
  test("edits cannot orphan an effect; whole-pair movement and removal preserve clip identities", () => {
    const project = applied();
    expect(moveClip(project, { clipId: "b", toTrackId: "lane", timelineStartSec: 4 }).ok).toBe(false);
    expect(trimClip(project, { clipId: "a", durationSec: 2 }).ok).toBe(false);
    expect(splitClip(project, { clipId: "a", atSec: 1 }).ok).toBe(false);
    expect(deleteClip(project, { clipId: "a" }).ok).toBe(false);
    expect(moveClipGroup(project, { clipIds: ["a", "b"], anchorClipId: "a", toTrackId: "lane", timelineStartSec: 2 }).ok).toBe(true);
    const hidden = updateTrack(project, { trackId: "lane", hidden: true }); if (!hidden.ok) throw new Error(hidden.error);
    expect(evaluateSequence(compileSequence(hidden.project), 3)).toHaveLength(0);
    const removed = setCutTransition(project, { ...input, durationSec: 0 }); if (!removed.ok) throw new Error(removed.error);
    expect(clipTransition(removed.project.sequences[0]!.tracks[0]!.clips[1]!)).toBeUndefined();
    expect(removed.project.sequences[0]!.tracks[0]!.clips).toHaveLength(2);
  });
  test("complete pair copy remaps references; partial copies refuse; 1.2 guards old readers", () => {
    const project = applied();
    expect(copyTimelineSelection(project, { clipIds: ["b"] }).ok).toBe(false);
    const copy = copyTimelineSelection(project, { clipIds: ["a", "b"] }); if (!copy.ok) throw new Error(copy.error);
    const pasted = pasteTimelineClipboard(project, copy.clipboard, 6); if (!pasted.ok) throw new Error(pasted.error);
    const clips = pasted.project.sequences[0]!.tracks[0]!.clips;
    expect(clipTransition(clips[3]!)?.fromClipId).toBe(clips[2]!.id);
    const html = serializeVideoHtml(createDefaultManifest(), pasted.project);
    const parsed = parseVideoHtml(html); expect(parsed.ok && parsed.document.manifest.version).toBe("1.2");
    expect(parseVideoHtml(html.replace('"version": "1.2"', '"version": "1.1"')).ok).toBe(false);
    expect(parsed.ok && evaluateSequence(compileSequence(parsed.document.project), 9)).toHaveLength(2);
  });
  test("neighboring transitions cannot demand overlapping windows inside a short middle clip", () => {
    const project = applied(); const lane = project.sequences[0]!.tracks[0]!;
    lane.clips.push({ ...structuredClone(lane.clips[1]!), id: "c", timelineStartSec: 6, props: {} });
    project.sequences[0]!.durationSec = 9;
    expect(transitionTarget(project, "c")).toMatchObject({ maxDurationSec: 4 });
    expect(setCutTransition(project, { ...input, clipId: "c", durationSec: 5 }).ok).toBe(false);
  });
});
