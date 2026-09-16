import { expect, test } from "bun:test";
import { appendGenerationShot, createEmptyGenerationBrief } from "./generation-brief";
import { buildVideoGenerationPlanDraft, VIDEO_GENERATION_CATALOG_MODELS as models } from "./generation-plan";
import { generationSettingsForSource } from "./generation-settings";

test("low-cost settings survive review and execution recompilation, including scene overrides", async () => {
  const settings = { durationSeconds: 4, resolution: "480p", audio: false };
  const brief = appendGenerationShot(createEmptyGenerationBrief(), { description: "A blue sphere turns slowly", durationSec: 4 }, () => "opening");
  const source = { kind: "shot" as const, shotId: "opening" };
  const intent = { version: 1 as const, document: { sha256: "a".repeat(64), revision: 1 }, scope: { kind: "shots" as const, shotIds: ["opening"] as [string] } };
  const review = await buildVideoGenerationPlanDraft(brief, { ...intent, jobs: [{ source, modelId: models.seedance, settings: generationSettingsForSource(brief, source, settings) }] });
  expect(review.status).toBe("ready-for-quote"); if (review.status !== "ready-for-quote") return;
  expect(review.jobs[0].requestedSettings).toEqual(settings);
  const execution = await buildVideoGenerationPlanDraft(brief, { ...intent, jobs: [{ source, modelId: review.jobs[0].catalogModelId, settings: generationSettingsForSource(brief, source, review.jobs[0].requestedSettings) }] });
  expect(execution.status).toBe("ready-for-quote"); if (execution.status !== "ready-for-quote") return;
  expect(execution.jobs[0].requestedSettings).toEqual(settings);
  expect(generationSettingsForSource(brief, { kind: "quick-brief" }, settings)).toEqual(settings);
});
