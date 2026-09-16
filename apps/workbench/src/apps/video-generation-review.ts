import { buildVideoGenerationPlanDraft } from "../../../../packages/first-party-apps/video/src/generation-plan";
import type { GenerationReference } from "../../../../packages/first-party-apps/video/src/generation-brief";
import { simpleGenerationPrompt } from "../../../../packages/first-party-apps/video/src/generator-composer";
import { parseVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import type { VideoGenerationBridgeRequest } from "./app-bridge";
import type { GenerationReviewPresentation } from "../components/media-generation-visual-review";

/** Parent re-derives creative inputs; the sandbox never supplies reference paths. */
export async function compileBoundVideoGenerationRequest(
  content: string, request: VideoGenerationBridgeRequest, previousSceneVideo?: GenerationReference,
) {
  const parsed = parseVideoHtml(content);
  if (!parsed.ok || !parsed.document.project.generationBrief) throw new Error("The saved video direction is unavailable.");
  const { project } = parsed.document;
  const brief = project.generationBrief!;
  const source = request.job.source;
  const shot = source.kind === "shot" ? brief.shots.find(shot => shot.id === source.shotId) : undefined;
  const settings = { ...request.job.requestedSettings };
  if (shot?.durationSec !== undefined) delete settings.durationSeconds;
  const compiled = await buildVideoGenerationPlanDraft(brief, {
    version: 1, document: request.document,
    scope: source.kind === "shot" ? { kind: "shots", shotIds: [source.shotId] } : { kind: "quick-brief" },
    jobs: [{ source, modelId: request.job.modelId, settings }],
  }, { media: project.media, ...(previousSceneVideo ? { previousSceneVideo } : {}) });
  if (compiled.status !== "ready-for-quote" || compiled.jobs[0].prompt !== request.job.prompt ||
      compiled.jobs[0].catalogModelId !== request.job.modelId ||
      JSON.stringify(compiled.jobs[0].requestedSettings) !== JSON.stringify(request.job.requestedSettings ?? {})) {
    throw new Error("The direction changed. Generate again from the saved scene.");
  }
  const referenceNames: Record<string, string> = {};
  for (const reference of [...brief.references, ...(brief.blocks ?? []).flatMap(block => block.references ?? []), ...(shot?.references ?? [])]) {
    if (reference.source?.kind === "workspace-artifact") referenceNames[reference.source.artifactId] = reference.name;
    if (reference.source?.kind === "project-media") {
      const mediaId = reference.source.mediaId;
      const media = project.media.find(item => item.id === mediaId);
      if (media?.source?.kind === "workspace-artifact") referenceNames[media.source.artifactId] = reference.name;
    }
  }
  const previous = shot ? brief.shots[brief.shots.findIndex(candidate => candidate.id === shot.id) - 1] : undefined;
  const continuationArtifact = previousSceneVideo?.source?.kind === "workspace-artifact" ? previousSceneVideo.source.artifactId : undefined;
  if (continuationArtifact) referenceNames[continuationArtifact] = previous?.title || "Previous scene";
  const presentation: GenerationReviewPresentation = {
    prompt: shot?.description || simpleGenerationPrompt(brief),
    sceneName: shot?.title || "New video",
    referenceNames,
    ...(continuationArtifact ? { continuation: { artifactId: continuationArtifact, sceneName: previous?.title || "Previous scene" } } : {}),
  };
  return { ...compiled.jobs[0], presentation };
}
