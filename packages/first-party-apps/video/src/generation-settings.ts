import type { GenerationBrief } from "./generation-brief";
import type { VideoGenerationJobSource, VideoGenerationRequestedSettings } from "./generation-plan";

/** A scene's explicit duration wins; all other reviewed choices survive recompilation. */
export function generationSettingsForSource(brief: GenerationBrief, source: VideoGenerationJobSource, settings: VideoGenerationRequestedSettings): VideoGenerationRequestedSettings {
  const result = { ...settings };
  if (source.kind === "shot" && brief.shots.find(shot => shot.id === source.shotId)?.durationSec !== undefined) delete result.durationSeconds;
  return result;
}
