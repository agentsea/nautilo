import type { VideoProject } from "./edl";
import { appendGenerationShot, createEmptyGenerationBrief, updateGenerationShot, deleteGenerationShot, moveGenerationShot, deleteGenerationDirectionBlock, moveGenerationDirectionBlock, materializeGenerationDirectionBlocks, effectiveGenerationDirectionBlocks, type GenerationShotPatch } from "./generation-brief";
import { sharedGenerationReferences } from "./generator-composer";
import { VIDEO_GENERATION_CATALOG_MODELS, type VideoGenerationCatalogModelId, type VideoGenerationRequestedSettings } from "./generation-plan";

export type GenerationReviewCommand = {
  action: "review-generation";
  shotId: string;
  modelId: VideoGenerationCatalogModelId;
  settings: VideoGenerationRequestedSettings;
  continuationTakeId?: string;
};

export function parseGenerationReviewCommand(input: unknown): GenerationReviewCommand | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (v["action"] !== "review-generation" || Object.keys(v).some(key => !["action", "shotId", "modelId", "settings", "continuationTakeId"].includes(key)) ||
    typeof v["shotId"] !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(v["shotId"]) ||
    !Object.values(VIDEO_GENERATION_CATALOG_MODELS).includes(v["modelId"] as VideoGenerationCatalogModelId) ||
    (v["continuationTakeId"] !== undefined && (typeof v["continuationTakeId"] !== "string" || !/^take_[A-Za-z0-9_-]{16,128}$/u.test(v["continuationTakeId"])))) return null;
  const settings = v["settings"];
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const s = settings as Record<string, unknown>;
  if (Object.keys(s).some(key => !["durationSeconds", "resolution", "aspectRatio", "audio"].includes(key)) ||
    (s["durationSeconds"] !== undefined && (!Number.isSafeInteger(s["durationSeconds"]) || Number(s["durationSeconds"]) <= 0)) ||
    (s["resolution"] !== undefined && typeof s["resolution"] !== "string") ||
    (s["aspectRatio"] !== undefined && typeof s["aspectRatio"] !== "string") ||
    (s["audio"] !== undefined && typeof s["audio"] !== "boolean")) return null;
  // The shared plan/compiler owns provider-specific settings validation.
  return v as GenerationReviewCommand;
}

export const GENERATION_REVIEW_REQUESTED = { status: "review_requested", paidSubmission: false, documentChanged: false, retrySafe: false } as const;
export function parseGenerationReviewResult(input: unknown): typeof GENERATION_REVIEW_REQUESTED | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  return Object.keys(v).length === 4 && Object.entries(GENERATION_REVIEW_REQUESTED).every(([key, value]) => v[key] === value)
    ? GENERATION_REVIEW_REQUESTED : null;
}

export function inspectGenerationProject(project: VideoProject) {
  const brief = project.generationBrief ?? createEmptyGenerationBrief();
  return {
    quickBrief: brief.quickBrief,
    blocks: effectiveGenerationDirectionBlocks(brief).map(block => ({ ...block, ...(block.references ? { references: block.references.map(ref => ({ id: ref.id, name: ref.name, mediaKind: ref.mediaKind })) } : {}) })),
    scenes: brief.shots.map(shot => ({ ...shot, references: shot.references.map(ref => ({ id: ref.id, name: ref.name, mediaKind: ref.mediaKind })) })),
    references: sharedGenerationReferences(brief).map(ref => ({ id: ref.id, name: ref.name, mediaKind: ref.mediaKind })),
    media: project.media.map(media => ({ id: media.id, name: media.label ?? media.id, kind: media.kind })),
    takes: (project.generatedTakes ?? []).map(take => ({ id: take.id, shotId: take.shotId, name: take.shotLabel, mediaKind: take.mediaKind })),
    guidance: "Edit a scene using these IDs. Continue uses the previous scene's completed take. review-generation requests the open editor's exact-price approval; it does not confirm a paid submission. Results enter the Media Bin automatically. Never retry an uncertain generation.",
  };
}

/** Atomic organization through the same scene/block operations used by the UI. */
export function organizeGenerationProject(project: VideoProject, input: unknown): { ok: true; project: VideoProject } | { ok: false; error: string } {
  try {
    if (!Array.isArray(input) || input.length === 0) throw new Error("Provide scene or block operations.");
    let brief = materializeGenerationDirectionBlocks(project.generationBrief ?? createEmptyGenerationBrief());
    for (const operation of input) {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Invalid organization operation.");
      const op = operation as Record<string, unknown>;
      const moving = op["action"] === "move-scene" || op["action"] === "move-block";
      if (!["delete-scene", "move-scene", "delete-block", "move-block"].includes(String(op["action"])) ||
        typeof op["id"] !== "string" || Object.keys(op).some(key => !["action", "id", ...(moving ? ["destinationIndex"] : [])].includes(key)) ||
        (moving && !Number.isSafeInteger(op["destinationIndex"]))) throw new Error("Choose an inspected scene/block ID and a zero-based destination index for moves.");
      if (op["action"] === "delete-scene") brief = deleteGenerationShot(brief, op["id"]);
      else if (op["action"] === "delete-block") brief = deleteGenerationDirectionBlock(brief, op["id"]);
      else if (op["action"] === "move-block") brief = moveGenerationDirectionBlock(brief, op["id"], Number(op["destinationIndex"]));
      else brief = moveGenerationShot(brief, op["id"], Number(op["destinationIndex"]));
    }
    // Removing direction never deletes completed takes, Media Bin assets or clips.
    return { ok: true, project: { ...project, generationBrief: brief } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Invalid organization operation." }; }
}

export function editGenerationScene(project: VideoProject, input: unknown): { ok: true; project: VideoProject } | { ok: false; error: string } {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide a scene edit.");
    const v = input as Record<string, unknown>;
    if (Object.keys(v).some(key => !["shotId", "title", "prompt", "continueFromPrevious", "durationSec", "referenceIds", "mediaIds", "camera", "motion"].includes(key))) throw new Error("Unknown scene edit field.");
    if (typeof v["title"] !== "string" || typeof v["prompt"] !== "string" || (v["shotId"] !== undefined && typeof v["shotId"] !== "string")) throw new Error("Provide a title and prompt, and an existing shotId to update rather than append.");
    const brief = project.generationBrief ?? createEmptyGenerationBrief();
    const patch: GenerationShotPatch = { title: v["title"], description: v["prompt"] };
    for (const key of ["continueFromPrevious", "durationSec", "camera", "motion"] as const) if (v[key] !== undefined) Object.assign(patch, { [key]: v[key] });
    if (v["referenceIds"] !== undefined || v["mediaIds"] !== undefined) {
      if ((v["referenceIds"] !== undefined && !Array.isArray(v["referenceIds"])) || (v["mediaIds"] !== undefined && !Array.isArray(v["mediaIds"]))) throw new Error("Reference and media IDs must be arrays.");
      const available = [...sharedGenerationReferences(brief), ...brief.shots.flatMap(shot => shot.references)];
      patch.references = (v["referenceIds"] as unknown[] ?? []).map(id => {
        const ref = available.find(candidate => candidate.id === id);
        if (!ref) throw new Error("Reference not found. Inspect generation first.");
        return ref;
      });
      for (const id of v["mediaIds"] as unknown[] ?? []) {
        const media = project.media.find(candidate => candidate.id === id);
        if (!media || !["image", "video"].includes(media.kind)) throw new Error("Choose an image or video already in this project's Media Bin.");
        const usedIds = new Set(patch.references.map(reference => reference.id));
        let serial = 1;
        while (usedIds.has(`ref-${serial}`)) serial++;
        patch.references.push({ id: `ref-${serial}`, name: media.label ?? "Media reference", mediaKind: media.kind as "image" | "video", source: { kind: "project-media", mediaId: media.id } });
      }
    }
    const { durationSec, ...rest } = patch;
    const generationBrief = v["shotId"] ? updateGenerationShot(brief, v["shotId"], patch) : appendGenerationShot(brief, { ...rest, ...(durationSec === undefined ? {} : { durationSec }) });
    if (generationBrief.shots[0]?.continueFromPrevious) throw new Error("The first scene has no preceding scene to continue.");
    return { ok: true, project: { ...project, generationBrief } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Invalid scene edit." }; }
}
