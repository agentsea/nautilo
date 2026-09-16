import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { compileBoundVideoGenerationRequest } from "../../src/apps/video-generation-review";
import { createEmptyGenerationBrief } from "../../../../packages/first-party-apps/video/src/generation-brief";
import { setSharedGenerationReferences, setSimpleGenerationPrompt } from "../../../../packages/first-party-apps/video/src/generator-composer";
import { buildVideoGenerationPlanDraft, VIDEO_GENERATION_CATALOG_MODELS as models } from "../../../../packages/first-party-apps/video/src/generation-plan";
import { createDefaultManifest, serializeVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import { createEmptyProject } from "../../../../packages/first-party-apps/video/src/edl";

test("parent rebuilds exact references from saved media and refuses stale/forged creative requests", async () => {
  const brief = setSimpleGenerationPrompt(setSharedGenerationReferences(createEmptyGenerationBrief(), [
    { id: "subject", name: "Subject", mediaKind: "image", source: { kind: "workspace-artifact", artifactId: "public", path: "refs/subject.png", mimeType: "image/png", sizeBytes: 100 } },
    { id: "voice", name: "Voice guide", mediaKind: "audio", source: { kind: "workspace-artifact", artifactId: "public-audio", path: "refs/voice.wav", mimeType: "audio/wav", sizeBytes: 1_024 } },
  ]), "Follow @Image1");
  const document = { sha256: "a".repeat(64), revision: 1 };
  const source = { kind: "quick-brief" as const };
  const draft = await buildVideoGenerationPlanDraft(brief, { version: 1, document, scope: source, jobs: [{ source, modelId: models.seedance, settings: {} }] });
  if (draft.status !== "ready-for-quote") throw new Error("Expected draft");
  const job = draft.jobs[0];
  const request = { requestId: "request", document, sourceFingerprint: draft.sourceFingerprint, job: { source, modelId: job.catalogModelId, prompt: job.prompt, requestedSettings: {} } };
  const content = serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: brief });
  const result = await compileBoundVideoGenerationRequest(content, request);
  expect(result.referenceImages).toEqual([{ path: "refs/subject.png" }]);
  expect(result.referenceAudios).toEqual([{ path: "refs/voice.wav" }]);
  expect(result.presentation).toMatchObject({ prompt: "Follow @Image1", referenceNames: { public: "Subject", "public-audio": "Voice guide" } });
  await rejects(compileBoundVideoGenerationRequest(content, { ...request, job: { ...request.job, prompt: "Forged prompt" } }), /changed/);
  const changed = serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: setSimpleGenerationPrompt(brief, "Changed") });
  await rejects(compileBoundVideoGenerationRequest(changed, request), /changed/);
});
