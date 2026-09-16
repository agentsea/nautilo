import { expect, test } from "bun:test";
import { appendGenerationDirectionBlock, createEmptyGenerationBrief, updateGenerationShot } from "./generation-brief";
import { beginSceneDesign, setSimpleGenerationPrompt, simpleGenerationPrompt, sharedGenerationReferences, setSharedGenerationReferences, placeGeneratedMediaSequence } from "./generator-composer";
import { createEmptyProject } from "./edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";
import { addClip } from "./commands";

test("sequence placement creates editable adjacent clips and never leaves a partial insertion", () => {
  const project = { ...createEmptyProject(), media: [
    { id: "opening", kind: "video" as const, ref: "opening.mp4", durationSec: 4 },
    { id: "ending", kind: "video" as const, ref: "ending.mp4", durationSec: 6 },
  ] };
  const result = placeGeneratedMediaSequence(project, ["opening", "ending"], 2);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.project.sequences[0]!.tracks.flatMap((track) => track.clips).map((clip) =>
      [clip.mediaId, clip.timelineStartSec, clip.durationSec])).toEqual([["opening", 2, 4], ["ending", 6, 6]]);
    expect(result.project.media).toEqual(project.media);
  }
  expect(placeGeneratedMediaSequence(project, ["opening", "missing"], 2).ok).toBe(false);
  expect(project.sequences[0]!.tracks.flatMap((track) => track.clips)).toEqual([]);
});

test("sequence placement finds room without overwriting, trimming or shifting existing footage", () => {
  let project = { ...createEmptyProject(), media: [{ id: "opening", kind: "video" as const, ref: "opening.mp4", durationSec: 4 }] };
  for (const track of project.sequences[0]!.tracks) {
    const result = addClip(project, { trackId: track.id, kind: "video", mediaId: "opening", timelineStartSec: 0, durationSec: 4 });
    if (!result.ok) throw new Error(result.error);
    project = { ...result.project, media: project.media };
  }
  const before = project.sequences[0]!.tracks;
  const result = placeGeneratedMediaSequence(project, ["opening"], 0);
  expect(result.ok).toBe(true);
  if (result.ok) {
    for (const track of before) expect(result.project.sequences[0]!.tracks.find((item) => item.id === track.id)).toEqual(track);
    expect(result.project.sequences[0]!.tracks).toHaveLength(before.length + 1);
  }
});

test("Simple to Advanced moves the prompt once and preserves other saved direction", () => {
  let brief = setSimpleGenerationPrompt(createEmptyGenerationBrief(), "Opening in the forest");
  brief = appendGenerationDirectionBlock(brief, { kind: "goal", quickBrief: "Always use soft light", goal: "Quiet" });
  const advanced = beginSceneDesign(brief);
  expect(advanced.shots[0]?.description).toBe("Opening in the forest");
  expect(advanced.blocks.filter((block) => block.kind === "goal").map((block) => block.quickBrief)).toEqual(["", "Always use soft light"]);
  expect(beginSceneDesign(advanced)).toBe(advanced);
  const changed = setSimpleGenerationPrompt(advanced, "A different opening");
  expect(changed.shots[0]?.description).toBe("A different opening");
  expect(brief.shots).toEqual([]);
});

test("shared reference edits retain creative metadata and round-trip through the same video document", () => {
  const brief = createEmptyGenerationBrief();
  brief.references = [
    { id: "image1", name: "Subject", mediaKind: "image", role: "Identity", instruction: "Keep the coat", source: { kind: "project-media", mediaId: "subject" } },
    { id: "video1", name: "Movement", mediaKind: "video", source: { kind: "project-media", mediaId: "motion" } },
    { id: "audio1", name: "Delivery", mediaKind: "audio", source: { kind: "project-media", mediaId: "voice" } },
  ];
  const edited = setSharedGenerationReferences(brief, sharedGenerationReferences(brief).filter((ref) => ref.id !== "video1"));
  expect(sharedGenerationReferences(edited)).toEqual([{ ...brief.references[0]!, mention: "@Image1" }, { ...brief.references[2]!, mention: "@Audio1" }]);
  expect(brief.references).toHaveLength(3);
  const parsed = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: edited }));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(sharedGenerationReferences(parsed.document.project.generationBrief!)).toEqual([{ ...brief.references[0]!, mention: "@Image1" }, { ...brief.references[2]!, mention: "@Audio1" }]);
});

test("switching modes never replaces references, clips or an existing scene", () => {
  const advanced = beginSceneDesign(setSimpleGenerationPrompt(createEmptyGenerationBrief(), "Scene one"));
  const revised = updateGenerationShot(advanced, advanced.shots[0]!.id, { camera: "Orbit", audio: "Birds" });
  expect(beginSceneDesign(revised)).toBe(revised);
  expect(simpleGenerationPrompt(revised)).toBe("Scene one");
  expect(revised.shots[0]?.audio).toBe("Birds");
});
