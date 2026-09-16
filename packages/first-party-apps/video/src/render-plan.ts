import type { ClipKind, FrameRate, TrackKind, VideoProject } from "./edl";
import { normalizeVideoExportSettings, videoExportDimensions, type VideoExportSettings } from "@nautilo/types";
import { compileSequence } from "./sequence-evaluation";
import { isTextCompositionKind } from "./text-composition";
import { clipFades, validFades, type Fades } from "./fades";
import { transitionProblem, type TransitionRamp } from "./transitions";

export const SEQUENCE_RENDER_PLAN_VERSION = 1 as const;

export type SequenceRenderLayer = Readonly<{
  clipId: string;
  kind: ClipKind;
  trackKind: TrackKind;
  mediaId?: string;
  timelineStartSec: number;
  durationSec: number;
  sourceInSec: number;
  visual: boolean;
  gain: number;
  fades?: Fades;
  transitionIn?: TransitionRamp;
  transitionOut?: TransitionRamp;
  /** Present only for built-in text, caption, and callout clips. */
  text?: string;
}>;

export type SequenceRenderPlanV1 = Readonly<{
  version: typeof SEQUENCE_RENDER_PLAN_VERSION;
  durationSec: number;
  width: number;
  height: number;
  frameRate: FrameRate;
  exportSettings?: VideoExportSettings;
  /** Bottom-to-top visual order, matching compileSequence. */
  layers: readonly SequenceRenderLayer[];
}>;

export type BuildSequenceRenderPlanResult =
  | Readonly<{ ok: true; plan: SequenceRenderPlanV1 }>
  | Readonly<{ ok: false; error: { code: "sequence_not_found" | "invalid_settings" | "missing_media" | "unsupported_props" | "unsupported_synthetic_clip" | "invalid_props"; clipId?: string } }>;

const TEXT_KINDS = new Set<ClipKind>(["text", "caption", "callout"]);

export function buildSequenceRenderPlan(
  project: VideoProject,
  sequenceId?: string,
  settings: Readonly<{ width?: number; height?: number; exportSettings?: VideoExportSettings }> = {},
): BuildSequenceRenderPlanResult {
  const sequence = sequenceId ? project.sequences.find((item) => item.id === sequenceId) : project.sequences[0];
  if (!sequence) return { ok: false, error: { code: "sequence_not_found" } };
  if (transitionProblem(project)) return { ok: false, error: { code: "invalid_props" } };
  const exportSettings = normalizeVideoExportSettings(settings.exportSettings);
  if (!exportSettings) return { ok: false, error: { code: "invalid_settings" } };
  const dimensions = videoExportDimensions(exportSettings);
  const width = settings.width ?? dimensions.width;
  const height = settings.height ?? dimensions.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width % 2 !== 0 || height % 2 !== 0) {
    return { ok: false, error: { code: "invalid_settings" } };
  }
  const compiled = compileSequence(project, sequence.id);
  const layers: SequenceRenderLayer[] = [];
  for (const entry of compiled.entries) {
    const { clip, media } = entry;
    const allowed = TEXT_KINDS.has(clip.kind) ? new Set(["text"])
      : clip.kind === "video" || clip.kind === "audio" ? new Set(["muted", "volume", "fades", "transition"]) : new Set<string>();
    if (Object.keys(clip.props).some((key) => !allowed.has(key))) {
      return { ok: false, error: { code: "unsupported_props", clipId: clip.id } };
    }
    if (clip.props["muted"] !== undefined && typeof clip.props["muted"] !== "boolean") {
      return { ok: false, error: { code: "invalid_props", clipId: clip.id } };
    }
    if (clip.props["fades"] !== undefined && (!validFades(clip.props["fades"]) || (clip.kind === "audio" && Object.keys(clip.props["fades"]).some((key) => key.startsWith("video"))))) return { ok: false, error: { code: "invalid_props", clipId: clip.id } };
    if (clip.props["volume"] !== undefined && (typeof clip.props["volume"] !== "number" || !Number.isFinite(clip.props["volume"]) || clip.props["volume"] < 0 || clip.props["volume"] > 1)) {
      return { ok: false, error: { code: "invalid_props", clipId: clip.id } };
    }
    if (TEXT_KINDS.has(clip.kind) && typeof clip.props["text"] !== "string") {
      return { ok: false, error: { code: "invalid_props", clipId: clip.id } };
    }
    if ((clip.kind === "video" || clip.kind === "audio" || clip.kind === "image") && !media) {
      return { ok: false, error: { code: "missing_media", clipId: clip.id } };
    }
    layers.push({
      clipId: clip.id,
      kind: clip.kind,
      trackKind: entry.track.kind,
      ...(media ? { mediaId: media.id } : {}),
      timelineStartSec: clip.timelineStartSec,
      durationSec: clip.durationSec,
      sourceInSec: clip.sourceInSec ?? 0,
      visual: entry.visual,
      gain: entry.gain,
      ...(Object.keys(clipFades(clip)).length ? { fades: clipFades(clip) } : {}),
      ...(entry.transitionIn ? { transitionIn: entry.transitionIn } : {}),
      ...(entry.transitionOut ? { transitionOut: entry.transitionOut } : {}),
      ...(isTextCompositionKind(clip.kind) ? { text: clip.props["text"] as string } : {}),
    });
  }
  return { ok: true, plan: { version: SEQUENCE_RENDER_PLAN_VERSION, durationSec: compiled.durationSec, width, height, frameRate: { ...sequence.frameRate }, layers,
    ...(settings.exportSettings ? { exportSettings } : {}) } };
}
