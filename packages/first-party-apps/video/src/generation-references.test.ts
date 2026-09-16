import { expect, test } from "bun:test";
import { VENICE_REFERENCE_AUDIO_MAX_BYTES, VENICE_REFERENCE_AUDIO_SIZE_WARNING } from "@nautilo/types";
import { createEmptyGenerationBrief, appendGenerationShot, updateGenerationShot, type GenerationReference } from "./generation-brief";
import type { MediaAsset } from "./edl";
import { buildVideoGenerationPlanDraft, VIDEO_GENERATION_CATALOG_MODELS as models, type VideoGenerationPlanIntentV1 } from "./generation-plan";
import { setSharedGenerationReferences, sharedGenerationReferences, referenceMentions, setSimpleGenerationPrompt } from "./generator-composer";

const image: GenerationReference = { id: "image-one", name: "Subject", mediaKind: "image", role: "identity", instruction: "Keep the red coat",
  source: { kind: "workspace-artifact", artifactId: "image-public", path: "refs/subject.png", mimeType: "image/png", sizeBytes: 1000 } };
const video: GenerationReference = { id: "video-one", name: "Motion", mediaKind: "video",
  source: { kind: "workspace-artifact", artifactId: "video-public", path: "refs/motion.mp4", mimeType: "video/mp4", sizeBytes: 2000 } };
const audio: GenerationReference = { id: "audio-one", name: "Voice", mediaKind: "audio", instruction: "Keep the soft delivery",
  source: { kind: "workspace-artifact", artifactId: "audio-public", path: "refs/voice.wav", mimeType: "audio/wav", sizeBytes: 3000 } };
function intent(shotId?: string): VideoGenerationPlanIntentV1 {
  const source = shotId ? { kind: "shot" as const, shotId } : { kind: "quick-brief" as const };
  return { version: 1, document: { sha256: "a".repeat(64), revision: 1 }, scope: shotId ? { kind: "shots", shotIds: [shotId] } : { kind: "quick-brief" },
    jobs: [{ source, modelId: models.seedance, settings: {} }] };
}
test("multiple references compile into real typed inputs, provider mentions and creative direction", async () => {
  const brief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, video, audio]), "Follow @Image1 with the camera movement in @Video1 and delivery from @Audio1.");
  const draft = await buildVideoGenerationPlanDraft(brief, intent());
  expect(draft.status).toBe("ready-for-quote"); if (draft.status !== "ready-for-quote") return;
  expect(draft.jobs[0].catalogModelId).toBe(models.seedanceReference);
  expect(draft.jobs[0].referenceImages).toEqual([{ path: "refs/subject.png" }]);
  expect(draft.jobs[0].referenceVideos).toEqual([{ path: "refs/motion.mp4" }]);
  expect(draft.jobs[0].referenceAudios).toEqual([{ path: "refs/voice.wav" }]);
  expect(draft.jobs[0].prompt).toContain("Follow <Image 1> with the camera movement in <Video 1> and delivery from <Audio 1>");
  expect(draft.jobs[0].prompt).toContain("Refer to <Audio 1> for audio guidance. Keep the soft delivery");
  expect(draft.jobs[0].prompt).toContain("Keep the red coat");
});
test("audio references can be saved first but require a visual reference at generation", async () => {
  const brief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [audio]), "Use @Audio1 for the performance.");
  expect(referenceMentions(sharedGenerationReferences(brief)).get(audio.id)).toBe("@Audio1");
  const blocked = await buildVideoGenerationPlanDraft(brief, intent());
  expect(blocked.status).toBe("blocked");
  expect(blocked.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "Add at least one image or video reference before generating with audio references." });
});
test("MiniMax rejects audio and visual references instead of silently dropping them", async () => {
  const brief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, audio]), "Use @Image1 and @Audio1.");
  const base = intent();
  const blocked = await buildVideoGenerationPlanDraft(brief, { ...base, jobs: [{ ...base.jobs[0], modelId: models.minimaxH3 }] });
  expect(blocked.status).toBe("blocked");
  expect(blocked.issues).toContainEqual({ code: "REFERENCE_INPUT_UNSUPPORTED", references: [
    expect.objectContaining({ id: image.id, name: image.name }),
    expect.objectContaining({ id: audio.id, name: audio.name }),
  ] });
});
test("audio donor format, size, and count are checked before quote", async () => {
  const wavAlias = { ...audio, source: { kind: "workspace-artifact" as const, artifactId: "audio-public", path: "refs/voice.wav", mimeType: "audio/x-wav", sizeBytes: 3000 } };
  const accepted = await buildVideoGenerationPlanDraft(setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, wavAlias]), "Make a scene."), intent());
  expect(accepted.status).toBe("ready-for-quote");
  if (accepted.status === "ready-for-quote") expect(accepted.jobs[0].referenceAudios).toEqual([{ path: "refs/voice.wav" }]);
  for (const [candidate, message] of [
    [{ ...audio, source: { kind: "workspace-artifact" as const, artifactId: "audio-public", path: "refs/voice.m4a", mimeType: "audio/mp4", sizeBytes: 3000 } }, "Voice: Seedance audio references must be MP3 or WAV files."],
    [{ ...audio, source: { kind: "workspace-artifact" as const, artifactId: "audio-public", path: "refs/voice.wav", mimeType: "audio/wav", sizeBytes: VENICE_REFERENCE_AUDIO_MAX_BYTES + 1 } }, `Voice: ${VENICE_REFERENCE_AUDIO_SIZE_WARNING}`],
  ] as const) {
    const brief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, candidate]), "Make a scene.");
    const blocked = await buildVideoGenerationPlanDraft(brief, intent());
    expect(blocked.status).toBe("blocked");
    expect(blocked.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message });
  }
  const many = Array.from({ length: 11 }, (_, index): GenerationReference => ({ ...audio, id: `audio-${index}`, name: `Voice ${index + 1}`,
    source: { kind: "workspace-artifact", artifactId: `audio-public-${index}`, path: `refs/voice-${index}.wav`, mimeType: "audio/wav", sizeBytes: 3000 } }));
  const crowded = await buildVideoGenerationPlanDraft(setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, ...many]), "Make a scene."), intent());
  expect(crowded.status).toBe("blocked");
  expect(crowded.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "Seedance accepts at most 10 audio references. Remove 1 and try again." });
});
test("known Media Bin durations enforce per-file and combined audio limits", async () => {
  const audioReference = (id: string): GenerationReference => ({ id: `ref-${id}`, name: id, mediaKind: "audio", source: { kind: "project-media", mediaId: id } });
  const audioAsset = (id: string, durationSec: number): MediaAsset => ({ id, kind: "audio", ref: `${id}.wav`, durationSec, lifecycle: "durable",
    source: { kind: "workspace-artifact", artifactId: `artifact-${id}`, path: `refs/${id}.wav` } });
  const shortBrief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, audioReference("short")]), "Make a scene.");
  const short = await buildVideoGenerationPlanDraft(shortBrief, intent(), { media: [audioAsset("short", 1)] });
  expect(short.status).toBe("blocked");
  expect(short.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "short: Seedance audio references must be 2–30 seconds long." });

  const combinedBrief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [image, audioReference("first"), audioReference("second")]), "Make a scene.");
  const combined = await buildVideoGenerationPlanDraft(combinedBrief, intent(), { media: [audioAsset("first", 16), audioAsset("second", 16)] });
  expect(combined.status).toBe("blocked");
  expect(combined.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "Seedance audio references may be at most 30 seconds combined. Shorten or remove audio and try again." });
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
