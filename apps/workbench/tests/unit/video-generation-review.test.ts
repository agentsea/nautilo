import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { compileBoundVideoGenerationRequest } from "../../src/apps/video-generation-review";
import { appendGenerationShot, createEmptyGenerationBrief } from "../../../../packages/first-party-apps/video/src/generation-brief";
import { addScopedGenerationReferences, setGenerationReferenceScope } from "../../../../packages/first-party-apps/video/src/generation-reference-scope";
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

test("host review re-derives each scene's references and rejects approval after scope changes", async () => {
  let brief = appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "First", description: "A speaker" }, () => "one"), { title: "Second", description: "The landscape" }, () => "two");
  brief = addScopedGenerationReferences(brief, [{ id: "subject", name: "Subject", mediaKind: "image", source: { kind: "workspace-artifact", artifactId: "subject", path: "refs/subject.png", mimeType: "image/png", sizeBytes: 100 } }]);
  brief = addScopedGenerationReferences(brief, [{ id: "voice", name: "Voice", mediaKind: "audio", source: { kind: "workspace-artifact", artifactId: "voice", path: "refs/voice.wav", mimeType: "audio/wav", sizeBytes: 100 } }], "one");
  const document = { sha256: "a".repeat(64), revision: 1 };
  const content = serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: brief });
  for (const shotId of ["one", "two"]) {
    const source = { kind: "shot" as const, shotId };
    const plan = await buildVideoGenerationPlanDraft(brief, { version: 1, document, scope: { kind: "shots", shotIds: [shotId] }, jobs: [{ source, modelId: models.seedance, settings: {} }] });
    if (plan.status !== "ready-for-quote") throw new Error("Expected draft");
    const job = plan.jobs[0];
    const request = { requestId: "review", document, sourceFingerprint: plan.sourceFingerprint, job: { source, modelId: job.catalogModelId, prompt: job.prompt, requestedSettings: {} } };
    const reviewed = await compileBoundVideoGenerationRequest(content, request);
    expect(reviewed.referenceImages).toEqual([{ path: "refs/subject.png" }]);
    expect(reviewed.referenceAudios).toEqual(shotId === "one" ? [{ path: "refs/voice.wav" }] : []);
    expect(reviewed.presentation.sceneName).toBe(shotId === "one" ? "First" : "Second");
    const changed = serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: setGenerationReferenceScope(brief, "voice", ["two"]) });
    await rejects(compileBoundVideoGenerationRequest(changed, request), /changed/);
  }
});
