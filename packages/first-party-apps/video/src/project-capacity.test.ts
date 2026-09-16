import { expect, test } from "bun:test";
import { addClip, addTrack, admitImportedMedia, moveClip, moveClipGroup, copyTimelineSelection, pasteTimelineClipboard } from "./commands";
import { createEmptyProject, type Clip, type VideoProject } from "./edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";
import { appendGenerationShot, createEmptyGenerationBrief, validateGenerationBrief } from "./generation-brief";
import { buildDocumentSummary } from "./timing";

function populatedProject(): VideoProject {
  const project = createEmptyProject();
  const sequence = project.sequences[0]!;
  sequence.tracks = Array.from({ length: 33 }, (_, index) => ({
    id: `track-${index}`, kind: "video", order: index, clips: [],
  }));
  sequence.tracks[0]!.clips = Array.from({ length: 501 }, (_, index): Clip => ({
    id: `clip-${index}`, kind: "caption", trackId: "track-0",
    timelineStartSec: index * 2, durationSec: 1, props: { text: `Caption ${index}` },
  }));
  sequence.markers = Array.from({ length: 501 }, (_, index) => ({ id: `marker-${index}`, timeSec: index, label: `Marker ${index}` }));
  project.media = Array.from({ length: 201 }, (_, index) => ({
    id: `media-${index}`, kind: "image", ref: `images/image-${index}.png`, label: `Image ${index}`,
  }));
  return project;
}

function roundTrip(project: VideoProject): VideoProject {
  const result = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), project));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.document.project;
}

test("larger collections survive save/reopen, import, track creation and complete inspection", () => {
  const project = populatedProject();
  const added = addTrack(project, { kind: "video", id: "another-track" });
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  const imported = admitImportedMedia(added.project, { mediaKind: "image", ref: "images/new.png", label: "Long label ".repeat(50) });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const restored = roundTrip(imported.project);
  expect(restored.media).toHaveLength(202);
  expect(restored.sequences[0]!.tracks).toHaveLength(34);
  expect(restored.sequences[0]!.markers).toHaveLength(501);
  const summary = buildDocumentSummary(restored.sequences[0]!, restored.media.length);
  expect(summary.tracks).toHaveLength(34);
  expect(summary.clipCount).toBe(501);
  expect(project.media).toHaveLength(201);
});

test("add, move, group move and paste do not impose a clip quota", () => {
  let project = populatedProject();
  const added = addClip(project, { id: "moving", kind: "caption", trackId: "track-1", timelineStartSec: 1100, durationSec: 1, props: { text: "Move me" } });
  expect(added.ok).toBe(true); if (!added.ok) return; project = added.project;
  const moved = moveClip(project, { clipId: "moving", toTrackId: "track-0" });
  expect(moved.ok).toBe(true); if (!moved.ok) return; project = moved.project;
  const second = addClip(project, { id: "group-moving", kind: "caption", trackId: "track-1", timelineStartSec: 1200, durationSec: 1, props: { text: "Group" } });
  expect(second.ok).toBe(true); if (!second.ok) return;
  const third = addClip(second.project, { id: "group-companion", kind: "caption", trackId: "track-1", timelineStartSec: 1202, durationSec: 1, props: { text: "Companion" } });
  expect(third.ok).toBe(true); if (!third.ok) return;
  const group = moveClipGroup(third.project, { clipIds: ["group-moving", "group-companion"], anchorClipId: "group-moving", toTrackId: "track-0", timelineStartSec: 1200 });
  expect(group.ok).toBe(true); if (!group.ok) return; project = group.project;
  const copy = copyTimelineSelection(project, { clipIds: ["moving"] });
  expect(copy.ok).toBe(true); if (!copy.ok) return;
  const paste = pasteTimelineClipboard(project, copy.clipboard, 1300);
  expect(paste.ok).toBe(true); if (!paste.ok) return;
  expect(roundTrip(paste.project).sequences[0]!.tracks[0]!.clips).toHaveLength(505);
  expect(moveClip(project, { clipId: "moving", timelineStartSec: 0 }).ok).toBe(false);
});

test("large scene and block collections preserve full creative text through serialization", () => {
  const base = appendGenerationShot(createEmptyGenerationBrief(), { title: "Opening", description: "A scene" }, () => "shot-base");
  const text = "Creative direction. ".repeat(12000);
  const shots = Array.from({ length: 129 }, (_, index) => ({ ...base.shots[0]!, id: `shot-${index}` }));
  const blocks = Array.from({ length: 193 }, (_, index) => ({ id: `block-${index}`, kind: "note" as const, note: index === 0 ? text : "Note" }));
  const brief = validateGenerationBrief({ ...base, shots, blocks });
  const restored = roundTrip({ ...createEmptyProject(), generationBrief: brief });
  expect(restored.generationBrief!.shots).toEqual(shots);
  expect(restored.generationBrief!.blocks).toEqual(blocks);
  expect(new TextEncoder().encode(serializeVideoHtml(createDefaultManifest(), restored)).byteLength).toBeGreaterThan(200 * 1024);
});

test("media metadata retains long references and measured durations without local quotas", () => {
  const path = `media/${"nested/".repeat(160)}source.mp4`;
  const imported = admitImportedMedia(createEmptyProject(), {
    mediaKind: "video", ref: path, label: "A complete human label ".repeat(40),
    durationSec: 86401, frameRate: { numerator: 30, denominator: 1 },
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(imported.error);
  expect(roundTrip(imported.project).media).toEqual(imported.project.media);
  expect(admitImportedMedia(createEmptyProject(), {
    mediaKind: "video", ref: "../outside.mp4", label: "Invalid source",
    durationSec: 86401, frameRate: { numerator: 30, denominator: 1 },
  }).ok).toBe(false);
});

test("frame-rate validation preserves exact rationals rather than imposing a local FPS ceiling", () => {
  for (const rate of [{ numerator: 300000, denominator: 10000 }, { numerator: 480, denominator: 1 }]) {
    const project = createEmptyProject();
    project.sequences[0]!.frameRate = rate;
    expect(roundTrip(project).sequences[0]!.frameRate).toEqual(rate);
  }
});
