import {
  appendGenerationDirectionBlock, appendGenerationShot, effectiveGenerationDirectionBlocks,
  materializeGenerationDirectionBlocks, updateGenerationDirectionBlock, updateGenerationShot,
  validateGenerationBrief, type GenerationBrief, type GenerationReference,
} from "./generation-brief";
import type { MediaAsset, VideoProject } from "./edl";
import { addClip, addTrack, type CommandResult } from "./commands";

/** One reference library projected from existing documents, not a second store. */
export function sharedGenerationReferences(brief: GenerationBrief): GenerationReference[] {
  const references = effectiveGenerationDirectionBlocks(brief).filter((block) => block.kind === "references").flatMap((block) => block.references ?? []);
  return references.filter((reference, index) => references.findIndex((item) => item.id === reference.id) === index);
}

export function referenceMentions(references: readonly GenerationReference[]): Map<string, string> {
  const counts = { image: 0, video: 0, audio: 0 };
  const reserved = new Set(references.flatMap(reference => reference.mention ? [reference.mention] : []));
  const mentions = new Map<string, string>();
  for (const reference of references) {
    if (mentions.has(reference.id)) continue;
    const kind = reference.mediaKind ?? "image";
    const prefix = `@${kind[0]!.toUpperCase()}${kind.slice(1)}`;
    if (reference.mention) { mentions.set(reference.id, reference.mention); continue; }
    let mention: string;
    do { mention = `${prefix}${++counts[kind]}`; } while (reserved.has(mention));
    reserved.add(mention); mentions.set(reference.id, mention);
  }
  return mentions;
}

export function setSharedGenerationReferences(brief: GenerationBrief, references: GenerationReference[]): GenerationBrief {
  const prior = sharedGenerationReferences(brief);
  const tokens = referenceMentions(prior);
  const used = new Set<string>([...tokens.values(), ...(JSON.stringify(brief).match(/@(Image|Video|Audio)[1-9][0-9]*/gu) ?? [])]);
  references = references.map(reference => {
    const previous = prior.find(item => item.id === reference.id);
    const kind = reference.mediaKind ?? "image";
    const prefix = `@${kind[0]!.toUpperCase()}${kind.slice(1)}`;
    const old = reference.mention ?? (previous?.mediaKind === reference.mediaKind ? tokens.get(reference.id) : undefined);
    if (old?.startsWith(prefix)) return { ...reference, mention: old };
    let index = 1; while (used.has(`${prefix}${index}`)) index++;
    const mention = `${prefix}${index}`; used.add(mention);
    return { ...reference, mention };
  });
  const current = materializeGenerationDirectionBlocks(brief);
  const boards = current.blocks.filter((block) => block.kind === "references");
  if (!boards.length) return appendGenerationDirectionBlock(current, { kind: "references", references });
  return validateGenerationBrief({ ...current, blocks: current.blocks.map((block) => block.kind === "references" ? { ...block, references: block.id === boards[0]!.id ? references : [] } : block) });
}

export function simpleGenerationPrompt(brief: GenerationBrief): string {
  if (brief.shots.length) return brief.shots[0]!.description;
  return effectiveGenerationDirectionBlocks(brief).find((block) => block.kind === "goal")?.quickBrief ?? "";
}

export function setSimpleGenerationPrompt(brief: GenerationBrief, prompt: string): GenerationBrief {
  if (brief.shots.length) return updateGenerationShot(brief, brief.shots[0]!.id, { description: prompt });
  const current = materializeGenerationDirectionBlocks(brief);
  const goal = current.blocks.find((block) => block.kind === "goal");
  return goal ? updateGenerationDirectionBlock(current, goal.id, { quickBrief: prompt }) : appendGenerationDirectionBlock(current, { kind: "goal", quickBrief: prompt, goal: "" });
}

/** Promoting the simple prompt never duplicates it into every later scene. */
export function beginSceneDesign(brief: GenerationBrief): GenerationBrief {
  if (brief.shots.length) return brief;
  const current = materializeGenerationDirectionBlocks(brief);
  const prompt = simpleGenerationPrompt(current);
  const sourceBlock = current.blocks.find((block) => block.kind === "goal");
  const next = appendGenerationShot({ ...current, blocks: current.blocks.map((block) => block.id === sourceBlock?.id ? { ...block, quickBrief: "" } : block) }, { title: "Opening", description: prompt });
  return next;
}

export function assetForGenerationReference(project: VideoProject, reference: GenerationReference): MediaAsset | undefined {
  const source = reference.source;
  return source?.kind === "project-media" ? project.media.find((asset) => asset.id === source.mediaId)
    : source?.kind === "workspace-artifact" ? project.media.find((asset) => asset.source?.kind === "workspace-artifact" && asset.source.artifactId === source.artifactId) : undefined;
}

/** One deliberate placement transaction; a failed sequence never places a prefix. */
export function placeGeneratedMediaSequence(project: VideoProject, mediaIds: readonly string[], timelineStartSec: number): CommandResult<VideoProject> {
  const sequence = project.sequences[0];
  if (!sequence || !mediaIds.length || !Number.isFinite(timelineStartSec) || timelineStartSec < 0) {
    return { ok: false, error: "Choose completed scenes and a valid playhead position." };
  }
  const media = mediaIds.map((id) => project.media.find((asset) => asset.id === id));
  if (media.some((asset) => !asset || asset.kind !== "video" || !asset.durationSec || !Number.isFinite(asset.durationSec))) {
    return { ok: false, error: "Every scene needs a completed video in the Media Bin." };
  }
  const place = (base: VideoProject, trackId: string): CommandResult<VideoProject> => {
    let next = base;
    let start = timelineStartSec;
    for (const asset of media) {
      const result = addClip(next, { sequenceId: sequence.id, trackId, kind: "video", mediaId: asset!.id,
        timelineStartSec: start, durationSec: asset!.durationSec!, sourceInSec: 0, sourceOutSec: asset!.durationSec! });
      if (!result.ok) return result;
      next = result.project;
      start += asset!.durationSec!;
    }
    return { ok: true, project: next };
  };
  for (const track of [...sequence.tracks].sort((a, b) => a.order - b.order)) {
    if (track.hidden || track.locked) continue;
    const result = place(project, track.id);
    if (result.ok) return result;
  }
  const added = addTrack(project, { sequenceId: sequence.id, kind: "video" });
  if (!added.ok) return added;
  const track = added.project.sequences[0]!.tracks.find((candidate) => !sequence.tracks.some((existing) => existing.id === candidate.id));
  return track ? place(added.project, track.id) : { ok: false, error: "A track could not be created. Your timeline is unchanged." };
}
