import { describe, expect, test } from "bun:test";
import { VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_SIZE_WARNING } from "@nautilo/types";
import { createEmptyGenerationBrief, appendGenerationShot, moveGenerationDirectionBlock, updateGenerationBrief, updateGenerationShot, validateGenerationBrief } from "./generation-brief";
import {
  VIDEO_GENERATION_CATALOG_MODELS,
  buildVideoGenerationPlanDraft,
  validateVideoGenerationPlanIntent,
  type VideoGenerationPlanIntentV1,
} from "./generation-plan";

const document = { sha256: "a".repeat(64), revision: 4 } as const;

function quickIntent(overrides: Partial<VideoGenerationPlanIntentV1> = {}): VideoGenerationPlanIntentV1 {
  return {
    version: 1,
    document,
    scope: { kind: "quick-brief" },
    jobs: [{ source: { kind: "quick-brief" }, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings: {} }],
    ...overrides,
  };
}

function shotIntent(shotIds: readonly [string, ...string[]]): VideoGenerationPlanIntentV1 {
  return {
    version: 1,
    document,
    scope: { kind: "shots", shotIds },
    jobs: shotIds.map((shotId) => ({
      source: { kind: "shot" as const, shotId },
      modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance,
      settings: {},
    })) as [VideoGenerationPlanIntentV1["jobs"][0], ...VideoGenerationPlanIntentV1["jobs"][0][]],
  };
}

describe("Video generation plan compiler", () => {
  test("explains oversized generation references before quoting without changing the saved brief", async () => {
    for (const sizeBytes of [VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_MAX_BYTES + 1]) {
      const brief = updateGenerationBrief(createEmptyGenerationBrief(), {
        quickBrief: "Continue the coastal flight.",
        references: [{ id: "ref-flight", name: "Coastal flight", mediaKind: "video", source: {
          kind: "workspace-artifact", artifactId: "flight", path: "References/flight.mp4", mimeType: "video/mp4", sizeBytes,
        } }],
      });
      const before = JSON.stringify(brief);
      const plan = await buildVideoGenerationPlanDraft(brief, quickIntent());
      expect(JSON.stringify(brief)).toBe(before);
      if (sizeBytes > VENICE_REFERENCE_VIDEO_MAX_BYTES) {
        expect(plan.status).toBe("blocked");
        expect(plan.jobs).toEqual([]);
        expect(plan.issues).toEqual([{ code: "REFERENCE_UNAVAILABLE", message: `Coastal flight: ${VENICE_REFERENCE_VIDEO_SIZE_WARNING}` }]);
      } else expect(plan.status).toBe("ready-for-quote");
    }
  });

  test("lowers one quick brief to one deterministic text-only job", async () => {
    const brief = updateGenerationBrief(createEmptyGenerationBrief(), {
      goal: "Introduce the film.",
      quickBrief: "A blue hour walk through rain.",
      continuity: "Keep the coat wet.",
      audio: "Distant traffic.",
      exclusions: "No logos.",
    });
    const plan = await buildVideoGenerationPlanDraft(brief, quickIntent());

    expect(plan.status).toBe("ready-for-quote");
    if (plan.status !== "ready-for-quote") return;
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toMatchObject({
      jobKey: "quick-1",
      source: { kind: "quick-brief" },
      catalogModelId: VIDEO_GENERATION_CATALOG_MODELS.seedance,
      requestedSettings: {},
    });
    expect(plan.jobs[0]?.prompt).toBe([
      "Goal:\nIntroduce the film.",
      "Quick brief:\nA blue hour walk through rain.",
      "Continuity:\nKeep the coat wet.",
      "Audio direction:\nDistant traffic.",
      "Do not include:\nNo logos.",
    ].join("\n\n"));
  });

  test("keeps an explicitly ordered multi-shot partition as one job per selected source", async () => {
    const first = appendGenerationShot(createEmptyGenerationBrief(), { title: "Arrival", description: "She enters." }, () => "shot-arrival");
    const brief = appendGenerationShot(first, { title: "Departure", description: "She leaves." }, () => "shot-departure");
    const plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-departure", "shot-arrival"]));

    expect(plan.status).toBe("ready-for-quote");
    if (plan.status !== "ready-for-quote") return;
    expect(plan.jobs.map((job) => [job.jobKey, job.title, job.source])).toEqual([
      ["shot-shot-departure", "Departure", { kind: "shot", shotId: "shot-departure" }],
      ["shot-shot-arrival", "Arrival", { kind: "shot", shotId: "shot-arrival" }],
    ]);
  });

  test("compiles the Human-selected framing alongside camera and motion presets", async () => {
    const brief = appendGenerationShot(createEmptyGenerationBrief(), {
      title: "Arrival",
      description: "She enters.",
      framing: "Medium wide",
      camera: "Tracking",
      motion: "Subject action",
    }, () => "shot-arrival");
    const plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-arrival"]));

    expect(plan.status).toBe("ready-for-quote");
    if (plan.status !== "ready-for-quote") return;
    expect(plan.jobs[0]?.prompt).toContain("Framing:\nMedium wide");
    expect(plan.jobs[0]?.prompt).toContain("Camera:\nTracking");
    expect(plan.jobs[0]?.prompt).toContain("Motion:\nSubject action");
  });

  test("lowers a custom preset to Human text instead of leaking the editor sentinel", async () => {
    const brief = appendGenerationShot(createEmptyGenerationBrief(), {
      title: "Arrival",
      description: "She enters.",
      camera: "Custom: low handheld orbit",
    }, () => "shot-arrival");
    const plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-arrival"]));

    expect(plan.status).toBe("ready-for-quote");
    if (plan.status !== "ready-for-quote") return;
    expect(plan.jobs[0]?.prompt).toContain("Camera:\nlow handheld orbit");
    expect(plan.jobs[0]?.prompt).not.toContain("Custom:");
  });

  test("compiles repeated canvas direction blocks in their saved order, not through one shared global field", async () => {
    const first = appendGenerationShot(createEmptyGenerationBrief(), { title: "First", description: "First action" }, () => "shot-first");
    const withShots = appendGenerationShot(first, { title: "Second", description: "Second action" }, () => "shot-second");
    const canvas = validateGenerationBrief({ ...withShots, blocks: [
      { id: "goal-a", kind: "goal", quickBrief: "First beat", goal: "Open quietly" },
      { id: "shot-a", kind: "shot", shotId: "shot-first" },
      { id: "goal-b", kind: "goal", quickBrief: "Second beat", goal: "End brightly" },
      { id: "shot-b", kind: "shot", shotId: "shot-second" },
    ] });
    const reordered = moveGenerationDirectionBlock(canvas, "shot-b", 1);
    const plan = await buildVideoGenerationPlanDraft(reordered, quickIntent());

    expect(reordered.shots.map((shot) => shot.id)).toEqual(["shot-second", "shot-first"]);
    expect(plan.status).toBe("ready-for-quote");
    if (plan.status !== "ready-for-quote") return;
    expect(plan.jobs[0]?.prompt).toContain("Goal:\nOpen quietly\n\nQuick brief:\nFirst beat\n\nGoal:\nEnd brightly\n\nQuick brief:\nSecond beat");
  });

  test("blocks every global and selected-shot semantic reference without injecting labels into prompts", async () => {
    let brief = appendGenerationShot(createEmptyGenerationBrief(), {
      title: "Arrival",
      description: "She enters.",
      references: [{ id: "ref-shot", name: "Walk reference" }],
    }, () => "shot-arrival");
    brief = updateGenerationBrief(brief, { references: [{ id: "ref-global", name: "Character reference" }] });
    const plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-arrival"]));

    expect(plan.status).toBe("blocked");
    if (plan.status !== "blocked") return;
    expect(plan.jobs).toEqual([]);
    expect(plan.issues).toEqual([
      { code: "REFERENCE_UNAVAILABLE", message: 'Replace "Character reference" with a saved Workspace image, video, or MP3/WAV audio file.' },
      { code: "REFERENCE_UNAVAILABLE", message: 'Replace "Walk reference" with a saved Workspace image, video, or MP3/WAV audio file.' },
    ]);
  });

  test("does not let an unselected shot reference block a different explicit partition", async () => {
    let brief = appendGenerationShot(createEmptyGenerationBrief(), { title: "One", description: "First." }, () => "shot-one");
    brief = appendGenerationShot(brief, {
      title: "Two",
      description: "Second.",
      references: [{ id: "ref-two", name: "Only second shot" }],
    }, () => "shot-two");
    const plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-one"]));

    expect(plan.status).toBe("ready-for-quote");
  });

  test("rejects fractional and ambiguous shot duration without rounding", async () => {
    let brief = appendGenerationShot(createEmptyGenerationBrief(), { title: "Arrival", description: "She enters.", durationSec: 4.5 }, () => "shot-arrival");
    let plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-arrival"]));
    expect(plan.status).toBe("blocked");
    if (plan.status === "blocked") {
      expect(plan.issues).toContainEqual({ code: "FRACTIONAL_DURATION", shotId: "shot-arrival", durationSec: 4.5 });
    }

    brief = updateGenerationShot(brief, "shot-arrival", { durationSec: 5 });
    plan = await buildVideoGenerationPlanDraft(brief, {
      ...shotIntent(["shot-arrival"]),
      jobs: [{
        source: { kind: "shot", shotId: "shot-arrival" },
        modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance,
        settings: { durationSeconds: 6 },
      }],
    });
    expect(plan.status).toBe("blocked");
    if (plan.status === "blocked") {
      expect(plan.issues).toContainEqual({ code: "AMBIGUOUS_DURATION", shotId: "shot-arrival" });
    }
  });

  test("uses an integral shot duration as an unnormalized host request setting", async () => {
    const brief = appendGenerationShot(createEmptyGenerationBrief(), { title: "Arrival", description: "She enters.", durationSec: 5 }, () => "shot-arrival");
    const plan = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-arrival"]));

    expect(plan.status).toBe("ready-for-quote");
    if (plan.status === "ready-for-quote") expect(plan.jobs[0]?.requestedSettings).toEqual({ durationSeconds: 5 });
  });

  test("rejects inferred/mismatched source selections, duplicates, missing shots, and unsupported models", async () => {
    const brief = appendGenerationShot(createEmptyGenerationBrief(), { title: "Arrival", description: "She enters." }, () => "shot-arrival");
    const mismatched = await buildVideoGenerationPlanDraft(brief, {
      ...shotIntent(["shot-arrival"]),
      jobs: [{ source: { kind: "quick-brief" }, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings: {} }],
    });
    expect(mismatched.status).toBe("blocked");
    if (mismatched.status === "blocked") expect(mismatched.issues).toContainEqual({ code: "INVALID_SCOPE" });

    const duplicate = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-arrival", "shot-arrival"]));
    expect(duplicate.status).toBe("blocked");
    if (duplicate.status === "blocked") expect(duplicate.issues).toContainEqual({ code: "DUPLICATE_SHOT", shotId: "shot-arrival" });

    const missing = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-missing"]));
    expect(missing.status).toBe("blocked");
    if (missing.status === "blocked") expect(missing.issues).toContainEqual({ code: "MISSING_SHOT", shotId: "shot-missing" });

    expect(() => validateVideoGenerationPlanIntent({ ...quickIntent(), jobs: [{ source: { kind: "quick-brief" }, modelId: "venice:sonilo-v1-1-music", settings: {} }] })).toThrow(
      "supported text-to-video catalog model",
    );
  });

  test("accepts larger plans while validating identities and model-setting strings", () => {
    const manyShotIds = Array.from({ length: 129 }, (_, index) => `shot-${index}`);
    expect(() => validateVideoGenerationPlanIntent({
      ...quickIntent(),
      scope: { kind: "shots", shotIds: manyShotIds },
      jobs: [{ source: { kind: "shot", shotId: "shot-0" }, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings: {} }],
    })).not.toThrow();
    expect(() => validateVideoGenerationPlanIntent({
      ...quickIntent(),
      jobs: Array.from({ length: 129 }, () => ({
        source: { kind: "quick-brief" },
        modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance,
        settings: {},
      })),
    })).not.toThrow();
    expect(() => validateVideoGenerationPlanIntent({
      ...quickIntent(),
      scope: { kind: "shots", shotIds: ["../not-a-shot"] },
      jobs: [{ source: { kind: "shot", shotId: "../not-a-shot" }, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings: {} }],
    })).toThrow("stable app identifier");
    expect(() => validateVideoGenerationPlanIntent({
      ...quickIntent(),
      jobs: [{
        source: { kind: "quick-brief" },
        modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance,
        settings: { aspectRatio: "é".repeat(33) },
      }],
    })).toThrow("exceeds 64 UTF-8 bytes");
    expect(() => validateVideoGenerationPlanIntent({
      ...quickIntent(),
      jobs: [{
        source: { kind: "quick-brief" },
        modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance,
        settings: { resolution: "x".repeat(65) },
      }],
    })).toThrow("exceeds 64 UTF-8 bytes");
  });

  test("fingerprint changes for a brief, model/settings, selection, or document version", async () => {
    const first = appendGenerationShot(createEmptyGenerationBrief(), { title: "One", description: "First." }, () => "shot-one");
    const brief = appendGenerationShot(first, { title: "Two", description: "Second." }, () => "shot-two");
    const baseline = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-one"]));
    const changedBrief = await buildVideoGenerationPlanDraft(updateGenerationShot(brief, "shot-one", { description: "Changed." }), shotIntent(["shot-one"]));
    const changedModel = await buildVideoGenerationPlanDraft(brief, {
      ...shotIntent(["shot-one"]),
      jobs: [{ source: { kind: "shot", shotId: "shot-one" }, modelId: VIDEO_GENERATION_CATALOG_MODELS.minimaxH3, settings: {} }],
    });
    const changedSelection = await buildVideoGenerationPlanDraft(brief, shotIntent(["shot-two"]));
    const changedDocument = await buildVideoGenerationPlanDraft(brief, {
      ...shotIntent(["shot-one"]),
      document: { ...document, revision: 5 },
    });

    expect(new Set([
      baseline.sourceFingerprint,
      changedBrief.sourceFingerprint,
      changedModel.sourceFingerprint,
      changedSelection.sourceFingerprint,
      changedDocument.sourceFingerprint,
    ]).size).toBe(5);
  });
});
