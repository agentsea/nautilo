import { describe, expect, test } from "bun:test";
import { createEmptyProject } from "./edl";
import { buildSequenceRenderPlan } from "./render-plan";

describe("sequence render plan", () => {
  test("new-project captions and titles paint above video; saved legacy order stays authoritative", () => {
    const project = createEmptyProject(); const sequence = project.sequences[0]!;
    project.media = [{ id: "v", kind: "video", ref: "v.mp4" }];
    for (const track of sequence.tracks) {
      if (track.kind === "video") track.clips = [{ id: "v", kind: "video", trackId: track.id, mediaId: "v", timelineStartSec: 0, durationSec: 1, props: {} }];
      if (track.kind === "overlay") track.clips = [{ id: "t", kind: "text", trackId: track.id, timelineStartSec: 0, durationSec: 1, props: { text: "Title" } }];
      if (track.kind === "caption") track.clips = [{ id: "c", kind: "caption", trackId: track.id, timelineStartSec: 0, durationSec: 1, props: { text: "Caption" } }];
    }
    const current = buildSequenceRenderPlan(project);
    expect(current.ok && current.plan.layers.map((layer) => layer.clipId)).toEqual(["v", "t", "c"]);
    sequence.tracks.forEach((track, order) => { track.order = order; });
    const legacy = buildSequenceRenderPlan(project);
    expect(legacy.ok && legacy.plan.layers.map((layer) => layer.clipId)).toEqual(["c", "t", "v"]);
  });
  test("lowers shared compiled order, gaps, gains, and text without media authority", () => {
    const project = createEmptyProject();
    const sequence = project.sequences[0]!;
    project.media.push({ id: "media_v", kind: "video", ref: "secret/source.mp4" });
    sequence.durationSec = 7;
    sequence.tracks[0]!.clips.push({ id: "v", trackId: sequence.tracks[0]!.id, kind: "video", mediaId: "media_v", timelineStartSec: 2, durationSec: 3, sourceInSec: 1, props: { volume: 0.4 } });
    const result = buildSequenceRenderPlan(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.durationSec).toBe(7);
    expect(result.plan.layers.map((item) => item.clipId)).toEqual(["v"]);
    expect(result.plan.layers[0]).toMatchObject({ mediaId: "media_v", timelineStartSec: 2, sourceInSec: 1, gain: 0.4 });
    expect(JSON.stringify(result.plan)).not.toContain("secret/source.mp4");
  });

  test("carries literal synthetic text with timing and visibility, without media authority", () => {
    const project = createEmptyProject(); const track = project.sequences[0]!.tracks[1]!;
    track.clips.push({ id: "text", trackId: track.id, kind: "text", timelineStartSec: 0, durationSec: 1, props: { text: "x';movie=/private/file" } });
    expect(buildSequenceRenderPlan(project)).toMatchObject({ ok: true, plan: { layers: [{ kind: "text", text: "x';movie=/private/file", gain: 0, visual: true }] } });
    track.hidden = true;
    expect(buildSequenceRenderPlan(project)).toMatchObject({ ok: true, plan: { layers: [{ visual: false }] } });
    track.clips[0]!.props = { text: "Title", fontFamily: "unimplemented" };
    expect(buildSequenceRenderPlan(project)).toMatchObject({ ok: false, error: { code: "unsupported_props" } });
    track.clips[0]!.props = { text: 42 };
    expect(buildSequenceRenderPlan(project)).toMatchObject({ ok: false, error: { code: "invalid_props" } });
  });

  test("fails closed for missing media, unknown transforms, and invalid gain", () => {
    for (const props of [{ crop: "fill" }, { volume: 2 }]) {
      const project = createEmptyProject();
      const track = project.sequences[0]!.tracks[0]!;
      track.clips.push({ id: "bad", trackId: track.id, kind: "video", mediaId: "absent", timelineStartSec: 0, durationSec: 1, props });
      expect(buildSequenceRenderPlan(project)).toMatchObject({ ok: false });
    }
  });
});
