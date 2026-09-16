import { expect, test } from "bun:test";
import { createEmptyGenerationBrief, appendGenerationShot, updateGenerationShot, type GenerationReference } from "./generation-brief";
import { buildVideoGenerationPlanDraft, VIDEO_GENERATION_CATALOG_MODELS as models, type VideoGenerationPlanIntentV1 } from "./generation-plan";
import { setSharedGenerationReferences, sharedGenerationReferences, referenceMentions, setSimpleGenerationPrompt } from "./generator-composer";

const image: GenerationReference = { id: "image-one", name: "Subject", mediaKind: "image", role: "identity", instruction: "Keep the red coat",
  source: { kind: "workspace-artifact", artifactId: "image-public", path: "refs/subject.png", mimeType: "image/png", sizeBytes: 1000 } };
const video: GenerationReference = { id: "video-one", name: "Motion", mediaKind: "video",
  source: { kind: "workspace-artifact", artifactId: "video-public", path: "refs/motion.mp4", mimeType: "video/mp4", sizeBytes: 2000 } };
function intent(shotId?: string): VideoGenerationPlanIntentV1 {
  const source = shotId ? { kind: "shot" as const, shotId } : { kind: "quick-brief" as const };
  return { version: 1, document: { sha256: "a".repeat(64), revision: 1 }, scope: shotId ? { kind: "shots", shotIds: [shotId] } : { kind: "quick-brief" },
    jobs: [{ source, modelId: models.seedance, settings: {} }] };
}
test("multiple references compile into real typed inputs, provider mentions and creative direction", async () => {
  const brief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, video]), "Follow @Image1 with the camera movement in @Video1.");
  const draft = await buildVideoGenerationPlanDraft(brief, intent());
  expect(draft.status).toBe("ready-for-quote"); if (draft.status !== "ready-for-quote") return;
  expect(draft.jobs[0].catalogModelId).toBe(models.seedanceReference);
  expect(draft.jobs[0].referenceImages).toEqual([{ path: "refs/subject.png" }]);
  expect(draft.jobs[0].referenceVideos).toEqual([{ path: "refs/motion.mp4" }]);
  expect(draft.jobs[0].prompt).toContain("Follow <Image 1> with the camera movement in <Video 1>");
  expect(draft.jobs[0].prompt).toContain("Keep the red coat");
});
test("removing a reference preserves the remaining token and never silently retargets prompts", async () => {
  const second = { ...image, id: "image-two", name: "Style", source: { ...image.source!, kind: "workspace-artifact" as const, artifactId: "other", path: "refs/style.png", mimeType: "image/png", sizeBytes: 1000 } };
  let brief = setSharedGenerationReferences(createEmptyGenerationBrief(), [image, second]);
  brief = setSharedGenerationReferences(brief, sharedGenerationReferences(brief).filter(ref => ref.id !== image.id));
  expect(referenceMentions(sharedGenerationReferences(brief)).get(second.id)).toBe("@Image2");
  brief.blocks.unshift({ id: "prompt", kind: "goal", quickBrief: "Use @Image1" });
  const blocked = await buildVideoGenerationPlanDraft(brief, intent());
  expect(blocked.status).toBe("blocked");
  expect(blocked.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "The prompt mentions removed reference @Image1. Update the prompt or attach that reference." });
});
test("continuation requires the previous output at execution and compiles an extension", async () => {
  let brief = appendGenerationShot(createEmptyGenerationBrief(), { description: "Opening" }, () => "opening");
  brief = appendGenerationShot(brief, { description: "Walk outside", continueFromPrevious: true }, () => "next");
  const blocked = await buildVideoGenerationPlanDraft(brief, intent("next"));
  expect(blocked.issues).toContainEqual({ code: "CONTINUATION_REQUIRED", shotId: "next" });
  const draft = await buildVideoGenerationPlanDraft(brief, intent("next"), { previousSceneVideo: { ...video, id: "previous-scene" } });
  expect(draft.status).toBe("ready-for-quote"); if (draft.status !== "ready-for-quote") return;
  expect(draft.jobs[0].prompt).toStartWith("Extend <Video 1>");
  expect(draft.jobs[0].referenceVideos).toEqual([{ path: "refs/motion.mp4" }]);
  brief = updateGenerationShot(brief, "next", { continueFromPrevious: false });
  expect((await buildVideoGenerationPlanDraft(brief, intent("next"))).status).toBe("ready-for-quote");
});
