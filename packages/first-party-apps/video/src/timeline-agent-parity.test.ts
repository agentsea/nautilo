import { describe, expect, test } from "bun:test";
import manifest from "../app.json";
import * as exportedTools from "../agent-tools";
import { editTimeline, inspectTimeline, previewTimelineEdit, type AgentToolContext, type ServerNautiloAppHost } from "./agent-tool-handlers";
import { applyTimelineOperations, TIMELINE_EDIT_OPERATIONS_SCHEMA, TIMELINE_EDIT_ACTIONS } from "./timeline-agent-edit";
import { createEmptyVideoHtml, parseVideoHtml, serializeVideoHtml } from "./video-document";
import { findClip, type VideoProject } from "./edl";
import { copyTimelineSelection, linkClips, removeTimelineSelection, setClipFade, setCutTransition } from "./commands";
import { buildSequenceRenderPlan } from "./render-plan";

const target = { surface: "workspace", path: "parity.video.html" } as const;
function fixture() {
  const parsed = parseVideoHtml(createEmptyVideoHtml());
  if (!parsed.ok) throw new Error(parsed.error);
  const project = parsed.document.project;
  project.media = [{ id: "source", kind: "video", ref: "assets/fixture.mp4", durationSec: 20, label: "Fixture" }];
  const video = project.sequences[0]!.tracks.find((track) => track.id === "track-video")!;
  video.clips = [0, 1].map((i) => ({ id: `v${i + 1}`, kind: "video", trackId: video.id, timelineStartSec: i * 4, durationSec: 4, sourceInSec: 2 + i * 4, sourceOutSec: 6 + i * 4, mediaId: "source", props: {} }));
  const audio = project.sequences[0]!.tracks.find((track) => track.id === "track-voice")!;
  audio.clips = [{ id: "a1", kind: "audio", trackId: audio.id, timelineStartSec: 0, durationSec: 8, sourceInSec: 2, sourceOutSec: 10, mediaId: "source", props: {} }];
  const titles = project.sequences[0]!.tracks.find((track) => track.id === "track-captions")!;
  titles.clips = [{ id: "title", kind: "caption", trackId: titles.id, timelineStartSec: 0, durationSec: 3, props: { text: "Hello" } }];
  return { project, manifest: parsed.document.manifest };
}
function harness(project = fixture().project) {
  let content = serializeVideoHtml(fixture().manifest, project);
  const sha = () => new Bun.CryptoHasher("sha256").update(content).digest("hex");
  let revision = 1;
  let writes = 0;
  let rejectWrite = false;
  const document: ServerNautiloAppHost["document"] = {
    async createFromAction() { throw new Error("unused"); },
    async read() { return { content, mimeType: "text/html", displayPath: target.path, baseSha256: sha(), baseRevision: revision }; },
    async write(_target, next, expected) {
      writes += 1;
      if (rejectWrite || expected?.baseSha256 !== sha() || expected.baseRevision !== revision) return { kind: "conflict", currentSha256: sha() };
      content = next.content; revision += 1;
      return { kind: "saved", sha256: sha(), revision };
    },
  };
  return {
    ctx: { nautiloApp: { document } } satisfies AgentToolContext,
    args: (operations: Array<Record<string, unknown>>) => ({ target, expectedSha256: sha(), expectedRevision: revision, operations: operations.map(({ action, ...fields }) => {
      if (["add-track", "update-track", "delete-track", "reorder-track"].includes(action as string)) return { op: "track", mode: (action as string).split("-")[0], ...fields };
      if (action === "link-clips" || action === "unlink-clips") return { op: "links", mode: action.split("-")[0], ...fields };
      return { op: action, ...fields };
    }) }),
    content: () => content, writes: () => writes,
    rejectWrite: () => { rejectWrite = true; },
    project: () => { const result = parseVideoHtml(content); if (!result.ok) throw new Error(result.error); return result.document.project; },
  };
}

describe("Genie timeline parity", () => {
  test("manifest, runtime validation and callable exports agree", () => {
    for (const id of ["preview-timeline-edit", "edit-timeline"]) {
      const tool = manifest.agent.tools.find((item) => item.id === id)!;
      expect(tool.inputSchema.properties).toHaveProperty("operations", TIMELINE_EDIT_OPERATIONS_SCHEMA);
      expect(typeof exportedTools[tool.handler as keyof typeof exportedTools]).toBe("function");
      expect(tool.inputSchema.required).toEqual(["target", "expectedSha256", "operations"]);
      expect(tool.impact).toBe(id === "edit-timeline" ? "high" : "read-only");
      expect(tool.requiredCapability).toBe(id === "edit-timeline" ? "use_project_content" : null);
    }
  });

  test("inspection returns exact version, full scoped clips, media identities, effects and protection without source paths", async () => {
    const h = harness();
    const result = await inspectTimeline({ target, includeClips: true }, h.ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toEqual({ sha256: h.args([]).expectedSha256, revision: 1 });
    expect(result.scope.omittedClipCount).toBe(0);
    expect(result.clips).toHaveLength(4);
    expect(result.media).toEqual([{ id: "source", kind: "video", label: "Fixture", durationSec: 20, lifecycle: null }]);
    expect(result.clips?.find((clip) => clip.id === "v2")?.transition).toMatchObject({ available: true, outgoingClipId: "v1", maxDurationSec: 8 });
    expect(JSON.stringify(result)).not.toContain("assets/fixture.mp4");
    const brief = await inspectTimeline({ target }, h.ctx);
    expect(brief.ok && brief.scope.omittedClipCount).toBe(4);
    expect(brief).not.toHaveProperty("clips");
  });

  const examples: Array<[string, Record<string, unknown>]> = [
    ["add-track", { trackId: "new-lane", name: "Mixed media" }],
    ["update-track", { trackId: "track-video", name: "Picture", muted: true }],
    ["delete-track", { trackId: "track-music" }],
    ["reorder-track", { trackId: "track-video", destinationIndex: 1 }],
    ["add-clip", { trackId: "track-music", kind: "video", mediaId: "source", timelineStartSec: 10, durationSec: 2 }],
    ["move-clip", { clipId: "v1", toTrackId: "track-music", timelineStartSec: 1 }],
    ["move-group", { clipIds: ["v1", "v2"], anchorClipId: "v1", toTrackId: "track-music", timelineStartSec: 1 }],
    ["split-clip", { clipId: "v1", atSec: 2 }],
    ["trim-clip", { clipId: "v1", durationSec: 3 }],
    ["delete-clip", { clipId: "v1" }],
    ["detach-audio", { clipId: "v1" }],
    ["link-clips", { clipIds: ["v1", "a1"] }],
    ["unlink-clips", { clipIds: ["v1", "a1"] }],
    ["set-text", { clipId: "title", text: "Changed" }],
    ["set-clip-audio", { clipId: "a1", volume: 0.5, muted: false }],
    ["set-fade", { clipId: "a1", key: "audioOut", durationSec: 1 }],
    ["set-transition", { clipId: "v2", kind: "crossfade", direction: "left", durationSec: 1 }],
    ["delete-selection", { inSec: 1, outSec: 2 }],
    ["copy-selection", { inSec: 1, outSec: 2, destinationSec: 12 }],
    ["move-selection", { inSec: 1, outSec: 2, destinationSec: 12 }],
  ];
  for (const [action, fields] of examples) test(`${action} previews without writing then persists through the document host`, async () => {
    const project = fixture().project;
    const linked = action === "unlink-clips" ? linkClips(project, { clipIds: ["v1", "a1"] }) : { ok: true as const, project };
    if (!linked.ok) throw new Error(linked.error);
    const h = harness(linked.project);
    const before = h.content();
    const args = h.args([{ action, ...fields }]);
    expect(await previewTimelineEdit(args, h.ctx)).toMatchObject({ ok: true, status: "preview", stateChanged: false });
    expect(h.content()).toBe(before); expect(h.writes()).toBe(0);
    const result = await editTimeline(args, h.ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    expect(h.writes()).toBe(1);
    expect(parseVideoHtml(h.content()).ok).toBe(true);
    expect(h.content()).not.toBe(before);
  });

  test("all exposed operation variants have a working persistence example", () => {
    expect(examples.map(([action]) => action).sort()).toEqual([...TIMELINE_EDIT_ACTIONS].sort());
  });

  test("missing measurements and surplus track-mode fields cannot create guessed media or bypass the schema", async () => {
    const project = fixture().project;
    delete project.media[0]!.durationSec;
    const h = harness(project);
    expect(await editTimeline(h.args([{ action: "add-clip", trackId: "track-music", kind: "video", mediaId: "source", timelineStartSec: 0, durationSec: 5 }]), h.ctx)).toMatchObject({ ok: false });
    expect(await editTimeline(h.args([{ action: "add-track", hidden: true }]), h.ctx)).toMatchObject({ ok: false });
    expect(h.writes()).toBe(0);
  });

  test("a track + placement + effect batch commits once and returns created identities", async () => {
    const h = harness();
    const result = await editTimeline(h.args([
      { action: "add-track", trackId: "narration", name: "Narration" },
      { action: "add-clip", trackId: "narration", kind: "audio", mediaId: "source", timelineStartSec: 0, durationSec: 4 },
      { action: "set-fade", clipId: "v1", key: "videoIn", durationSec: 1 },
    ]), h.ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    expect(h.writes()).toBe(1);
    if (!result.ok || result.status !== "saved") return;
    expect(result.summary?.clips.some((clip) => clip.before === null && clip.after?.trackId === "narration")).toBe(true);
    expect(buildSequenceRenderPlan(h.project()).ok).toBe(true);
  });

  test("effect commands match human command output and survive the export-plan gate", async () => {
    const h = harness();
    const fade = { clipId: "v1", key: "videoIn" as const, durationSec: 1, linkedAudio: false };
    const transition = { clipId: "v2", kind: "swipe" as const, direction: "up" as const, durationSec: 2 };
    const faded = setClipFade(h.project(), fade); if (!faded.ok) throw new Error(faded.error);
    const transitioned = setCutTransition(faded.project, transition); if (!transitioned.ok) throw new Error(transitioned.error);
    expect(await editTimeline(h.args([{ action: "set-fade", ...fade }, { action: "set-transition", ...transition }]), h.ctx)).toMatchObject({ status: "saved" });
    expect(h.project().sequences).toEqual(transitioned.project.sequences);
    expect(buildSequenceRenderPlan(h.project())).toEqual(buildSequenceRenderPlan(transitioned.project));
    expect(await editTimeline(h.args([{ action: "set-fade", ...fade, durationSec: 0 }, { action: "set-transition", ...transition, durationSec: 0 }]), h.ctx)).toMatchObject({ status: "saved" });
    expect(findClip(h.project().sequences[0]!, "v2")!.clip.props).not.toHaveProperty("transition");
  });

  test("hidden linked media is excluded by the same range commands as human editing", async () => {
    const linked = linkClips(fixture().project, { clipIds: ["v1", "a1"] }); if (!linked.ok) throw new Error(linked.error);
    linked.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.hidden = true;
    const h = harness(linked.project);
    const selection = { clipIds: [], range: { inSec: 1, outSec: 2 } };
    const expected = removeTimelineSelection(h.project(), selection); if (!expected.ok) throw new Error(expected.error);
    const copy = copyTimelineSelection(h.project(), selection); expect(copy.ok && copy.clipboard.clips.every((clip) => clip.kind !== "video")).toBe(true);
    expect(await editTimeline(h.args([{ action: "delete-selection", inSec: 1, outSec: 2 }]), h.ctx)).toMatchObject({ status: "saved" });
    const normalize = (project: VideoProject) => project.sequences[0]!.tracks.map((track) => ({ id: track.id, hidden: track.hidden, clips: track.clips.map((clip) => ({ kind: clip.kind, timelineStartSec: clip.timelineStartSec, durationSec: clip.durationSec, sourceInSec: clip.sourceInSec, props: clip.props })) }));
    expect(normalize(h.project())).toEqual(normalize(expected.project));
  });

  test("failed batch and cut/paste collision make no partial writes", async () => {
    for (const operations of [
      [{ action: "update-track", trackId: "track-video", name: "Must roll back" }, { action: "move-clip", clipId: "v1", timelineStartSec: 3 }],
      [{ action: "move-selection", clipIds: ["v1"], destinationSec: 4 }],
      [{ action: "set-transition", clipId: "v2", kind: "swipe", direction: "left", durationSec: 100 }],
    ]) {
      const h = harness(); const before = h.content();
      expect(await editTimeline(h.args(operations), h.ctx)).toMatchObject({ ok: false });
      expect(h.writes()).toBe(0); expect(h.content()).toBe(before);
    }
  });

  test("stale inspection and intervening writes refuse without blind retries", async () => {
    const h = harness();
    const args = h.args([{ action: "delete-clip", clipId: "v1" }]);
    const stale = { ...args, expectedSha256: "old" };
    expect(await previewTimelineEdit(stale, h.ctx)).toMatchObject({ status: "conflict", stateChanged: false });
    expect(await editTimeline(stale, h.ctx)).toMatchObject({ status: "conflict" });
    expect(await editTimeline({ ...args, expectedRevision: 2 }, h.ctx)).toMatchObject({ status: "conflict" });
    expect(h.writes()).toBe(0);
    const before = h.content(); h.rejectWrite();
    expect(await editTimeline(args, h.ctx)).toMatchObject({ status: "conflict" });
    expect(h.writes()).toBe(1); expect(h.content()).toBe(before);
  });

  test("malformed or unsafe operations are refused without changing the project", async () => {
    for (const operation of [
      { action: "set-text", clipId: "v1", text: "Not text" },
      { action: "set-clip-audio", clipId: "a1", volume: 2 },
      { action: "set-fade", clipId: "a1", key: "videoIn", durationSec: 1 },
      { action: "set-transition", clipId: "v2", kind: "code", direction: "left", durationSec: 1 },
      { action: "add-clip", trackId: "track-video", kind: "video", mediaId: "invented", timelineStartSec: 10, durationSec: 2 },
      { action: "delete-selection", inSec: 1 }, { action: "link-clips", clipIds: ["v1", "v1"] },
      { action: "update-track", trackId: "track-video", locked: "false" },
      { action: "move-clip", clipId: "v1", timelineStartSec: Number.NaN },
      { action: "add-track", ref: "/private/source.mp4" }, { action: "__proto__" },
    ]) {
      const h = harness(); const before = h.content();
      expect(await editTimeline(h.args([operation]), h.ctx)).toMatchObject({ ok: false });
      expect(h.writes()).toBe(0); expect(h.content()).toBe(before);
    }
    expect(applyTimelineOperations(fixture().project, [])).toMatchObject({ ok: false });
  });

  test("locked and hidden targets cannot be modified through properties or effects", async () => {
    for (const state of ["locked", "hidden"] as const) {
      const project = fixture().project;
      project.sequences[0]!.tracks.find((track) => track.id === "track-video")![state] = true;
      const h = harness(project);
      for (const operation of [{ action: "set-fade", clipId: "v1", key: "videoIn", durationSec: 1 }, { action: "move-clip", clipId: "v1", timelineStartSec: 10 }, { action: "set-clip-audio", clipId: "v1", volume: 0.5 }]) expect(await editTimeline(h.args([operation]), h.ctx)).toMatchObject({ ok: false });
      expect(h.writes()).toBe(0);
    }
  });

  test("linking and unlinking a subset preserves reciprocal links to outside peers", async () => {
    const linked = linkClips(fixture().project, { clipIds: ["v1", "a1"] }); if (!linked.ok) throw new Error(linked.error);
    const h = harness(linked.project);
    expect(await editTimeline(h.args([{ action: "link-clips", clipIds: ["v1", "title"] }]), h.ctx)).toMatchObject({ status: "saved" });
    const links = (id: string) => findClip(h.project().sequences[0]!, id)!.clip.linkedClipIds ?? [];
    expect(links("v1")).toContain("a1"); expect(links("v1")).toContain("title");
    expect(links("a1")).toContain("v1");
    expect(await editTimeline(h.args([{ action: "unlink-clips", clipIds: ["v1", "title"] }]), h.ctx)).toMatchObject({ status: "saved" });
    expect(links("title")).not.toContain("v1");
    expect(links("v1")).not.toContain("title");
    expect(links("v1")).toContain("a1"); expect(links("a1")).toContain("v1");
  });
});
