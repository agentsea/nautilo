import { expect, test } from "bun:test";
import { createEmptyProject } from "./edl";
import { editGenerationScene, inspectGenerationProject, organizeGenerationProject, parseGenerationReviewCommand, parseGenerationReviewResult, GENERATION_REVIEW_REQUESTED } from "./generation-agent";
import { appendGenerationShot, createEmptyGenerationBrief, materializeGenerationDirectionBlocks, moveGenerationShot, deleteGenerationDirectionBlock } from "./generation-brief";
import { organizeGeneration } from "./agent-tool-handlers";
import { createDefaultManifest, serializeVideoHtml, parseVideoHtml } from "./video-document";
import { editGeneration, inspectGeneration, type AgentToolContext } from "./agent-tool-handlers";

test("Genie can append and update continuation scenes using Media Bin references, without touching clips", () => {
  const original = { ...createEmptyProject(), media: [{ id: "video", kind: "video" as const, ref: "private/source.mp4", label: "Opening footage" }] };
  const first = editGenerationScene(original, { title: "Opening", prompt: "A blue sphere" });
  if (!first.ok) throw new Error(first.error);
  const next = editGenerationScene(first.project, { title: "Next", prompt: "Continue turning", continueFromPrevious: true, mediaIds: ["video"] });
  if (!next.ok) throw new Error(next.error);
  expect(next.project.sequences).toEqual(original.sequences);
  const scene = next.project.generationBrief!.shots[1]!;
  expect(scene.continueFromPrevious).toBe(true);
  expect(scene.references[0]!.source).toEqual({ kind: "project-media", mediaId: "video" });
  const updated = editGenerationScene(next.project, { shotId: scene.id, title: "Next", prompt: "Turn slowly" });
  if (!updated.ok) throw new Error(updated.error);
  const reopened = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), updated.project));
  if (!reopened.ok) throw new Error(reopened.error);
  expect(reopened.document.project.generationBrief!.shots[1]!.description).toBe("Turn slowly");
  expect(JSON.stringify(inspectGenerationProject(updated.project))).not.toContain("private/source.mp4");
});

test("invalid references, first-scene continuation and raw paths fail atomically", () => {
  const project = createEmptyProject();
  for (const extra of [{ continueFromPrevious: true }, { mediaIds: ["missing"] }, { referenceIds: ["missing"] }, { path: "/secret" }, { durationSec: -1 }]) {
    expect(editGenerationScene(project, { title: "Scene", prompt: "Prompt", ...extra }).ok).toBe(false);
    expect(project.generationBrief).toBeUndefined();
  }
});

test("review requests carry explicit settings and an optional inspected take, never paid authority", () => {
  const command = { action: "review-generation", shotId: "shot-next", modelId: "venice:seedance-2-5-text-to-video-basic", settings: { durationSeconds: 4, resolution: "480p", audio: false }, continuationTakeId: "take_abcdefghijklmnop" } as const;
  expect(parseGenerationReviewCommand(command)).toEqual(command);
  for (const changed of [{ ...command, approve: true }, { ...command, continuationTakeId: "mg_receipt" }, { ...command, settings: { ...command.settings, providerUrl: "x" } }]) expect(parseGenerationReviewCommand(changed)).toBeNull();
  expect(parseGenerationReviewResult(GENERATION_REVIEW_REQUESTED)).toEqual(GENERATION_REVIEW_REQUESTED);
  expect(parseGenerationReviewResult({ ...GENERATION_REVIEW_REQUESTED, paidSubmission: true })).toBeNull();
});

test("saved scene tools reject stale versions and return canonical saved IDs on inspection", async () => {
  let content = serializeVideoHtml(createDefaultManifest(), createEmptyProject());
  let writes = 0;
  const ctx: AgentToolContext = { nautiloApp: { document: { createFromAction: async () => { throw new Error("Not used"); }, read: async () => ({ content, baseSha256: "current", baseRevision: 1, displayPath: "test.video.html", mimeType: "text/html" }), write: async (_target: unknown, next: { content: string }) => { writes++; content = next.content; return { kind: "saved", sha256: "next", revision: 2 }; } } } };
  const target = { surface: "workspace" as const, path: "test.video.html" };
  expect(await editGeneration({ target, expectedSha256: "stale", scene: { title: "Next", prompt: "Continue" } }, ctx)).toMatchObject({ status: "conflict" });
  expect(writes).toBe(0);
  expect(await editGeneration({ target, expectedSha256: "current", scene: { title: "Next", prompt: "Continue" } }, ctx)).toMatchObject({ status: "saved" });
  expect(writes).toBe(1);
  expect(await inspectGeneration({ target }, ctx)).toMatchObject({ ok: true, scenes: [{ title: "Next", description: "Continue" }] });
});

test("scene/block organization uses shared commands, persists order and retains media and takes", () => {
  const brief = materializeGenerationDirectionBlocks(appendGenerationShot(appendGenerationShot({ ...createEmptyGenerationBrief(), quickBrief: "Direction" }, { title: "A", description: "First" }, () => "scene-a"), { title: "B", description: "Next" }, () => "scene-b"));
  const project = { ...createEmptyProject(), generationBrief: brief, generatedTakes: [{
    id: "take_abcdefghijklmnop", briefRevision: 1, shotId: "scene-a", shotLabel: "A", mediaKind: "video" as const,
    modelId: "seedance-2-5", settings: { durationSeconds: 4 },
    artifact: { artifactId: "11111111-1111-4111-8111-111111111111", path: "generated/opening.mp4", zone: "workspace" as const, mime: "video/mp4", bytes: 1024 },
  }] };
  const inspected = inspectGenerationProject(project);
  expect(inspected.blocks.map(block => block.id)).toEqual(["legacy-goal", "legacy-scene-a", "legacy-scene-b"]);
  const moved = organizeGenerationProject(project, [{ action: "move-scene", id: "scene-b", destinationIndex: 0 }]);
  if (!moved.ok) throw new Error(moved.error);
  expect(moved.project.generationBrief).toEqual(moveGenerationShot(brief, "scene-b", 0));
  expect(moved.project.generationBrief!.blocks.filter(block => block.kind === "shot").map(block => block.shotId)).toEqual(["scene-b", "scene-a"]);
  expect(moved.project.generationBrief!.blocks.filter(block => block.kind === "shot").map(block => block.id)).toEqual(["legacy-scene-b", "legacy-scene-a"]);
  const blockMoved = organizeGenerationProject(moved.project, [{ action: "move-block", id: "legacy-scene-a", destinationIndex: 1 }]);
  if (!blockMoved.ok) throw new Error(blockMoved.error);
  expect(blockMoved.project.generationBrief!.shots.map(shot => shot.id)).toEqual(["scene-a", "scene-b"]);
  const removed = organizeGenerationProject(moved.project, [{ action: "delete-block", id: "legacy-goal" }]);
  if (!removed.ok) throw new Error(removed.error);
  expect(removed.project.generationBrief).toEqual(deleteGenerationDirectionBlock(moved.project.generationBrief!, "legacy-goal"));
  expect(removed.project.sequences).toBe(project.sequences);
  expect(removed.project.media).toBe(project.media);
  const reopened = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), removed.project));
  if (!reopened.ok) throw new Error(reopened.error);
  expect(reopened.document.project.generationBrief!.shots.map(shot => shot.id)).toEqual(["scene-b", "scene-a"]);
  const deleteAll = organizeGenerationProject(removed.project, [{ action: "delete-scene", id: "scene-a" }, { action: "delete-scene", id: "scene-b" }]);
  if (!deleteAll.ok) throw new Error(deleteAll.error);
  expect(inspectGenerationProject(deleteAll.project).blocks).toEqual([]);
  expect(deleteAll.project.generationBrief!.shots).toEqual([]);
  expect(deleteAll.project.generatedTakes).toBe(project.generatedTakes);
  const reopenedEmpty = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), deleteAll.project));
  if (!reopenedEmpty.ok) throw new Error(reopenedEmpty.error);
  expect(reopenedEmpty.document.project.generatedTakes).toEqual(project.generatedTakes);
  expect(organizeGenerationProject(project, [{ action: "delete-scene", id: "scene-a" }, { action: "move-block", id: "missing", destinationIndex: 0 }]).ok).toBe(false);
  expect(project.generationBrief.shots).toHaveLength(2);
});

test("organization never writes after a stale snapshot or invalid batch", async () => {
  let writes = 0;
  const project = { ...createEmptyProject(), generationBrief: appendGenerationShot(createEmptyGenerationBrief(), { title: "A", description: "First" }, () => "scene-a") };
  const ctx = { nautiloApp: { document: { read: async () => ({ content: serializeVideoHtml(createDefaultManifest(), project), baseSha256: "current", baseRevision: 1 }), write: async () => { writes++; return { kind: "saved", sha256: "new", revision: 2 }; } } } } as unknown as AgentToolContext;
  const args = { target: { surface: "workspace" as const, path: "test.video.html" }, expectedSha256: "stale", operations: [{ action: "delete-scene", id: "scene-a" }] };
  expect(await organizeGeneration(args, ctx)).toMatchObject({ status: "conflict" });
  expect(writes).toBe(0);
  await organizeGeneration({ ...args, expectedSha256: "current", operations: [...args.operations, { action: "delete-scene", id: "missing" }] }, ctx);
  expect(writes).toBe(0);
  expect(await organizeGeneration({ ...args, expectedSha256: "current" }, ctx)).toMatchObject({ status: "saved" });
  expect(writes).toBe(1);
});
