import { listOrderedTracks, type Clip, type MediaAsset, type Track, type VideoProject } from "./edl";
import { clipTimelineEndSec, computeSequenceDurationSec } from "./timing";
import { clipFades, fadeFactor } from "./fades";
import { clipTransition, transitionProgress, swipeClipPath, type TransitionRamp } from "./transitions";

export type SequenceEntry = Readonly<{
  clip: Clip;
  track: Track;
  media: MediaAsset | undefined;
  visual: boolean;
  /** HTML media volume uses a normalized gain in [0, 1]. */
  gain: number;
  transitionIn?: TransitionRamp;
  transitionOut?: TransitionRamp;
}>;
export type CompiledSequence = Readonly<{ durationSec: number; frameDurationSec: number; entries: readonly SequenceEntry[] }>;
export type ActiveSequenceEntry = SequenceEntry & Readonly<{ sourceTimeSec: number; opacity?: number; clipPath?: string }>;

/** One source/time/layer interpretation for program preview and render planning.
 * Track order is top-to-bottom; returned entries paint bottom-to-top.
 * Selection never participates in program output.
 */
export function compileSequence(project: VideoProject, sequenceId?: string): CompiledSequence {
  const sequence = sequenceId ? project.sequences.find((item) => item.id === sequenceId) : project.sequences[0];
  if (!sequence) return { durationSec: 0, frameDurationSec: 1 / 30, entries: [] };
  const media = new Map(project.media.map((asset) => [asset.id, asset]));
  return {
    durationSec: Math.max(sequence.durationSec, computeSequenceDurationSec(sequence)),
    frameDurationSec: sequence.frameRate.denominator / sequence.frameRate.numerator,
    entries: listOrderedTracks(sequence).reverse().flatMap((track) => [...track.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec).map((original): SequenceEntry => {
      const incoming = clipTransition(original);
      const successor = track.clips.find((candidate) => clipTransition(candidate)?.fromClipId === original.id);
      const outgoing = successor ? clipTransition(successor) : undefined;
      const before = (incoming?.durationSec ?? 0) / 2;
      const after = (outgoing?.durationSec ?? 0) / 2;
      const sourceIn = original.sourceInSec ?? 0;
      // Expanded decoder windows are projections only. Saved clip edges stay put.
      const clip = before || after ? { ...original, timelineStartSec: original.timelineStartSec - before, sourceInSec: sourceIn - before, durationSec: original.durationSec + before + after } : original;
      const rawVolume = clip.props["volume"];
      const volume = typeof rawVolume === "number" && Number.isFinite(rawVolume) ? Math.max(0, Math.min(1, rawVolume)) : 1;
      return {
        clip, track, media: clip.mediaId ? media.get(clip.mediaId) : undefined,
        visual: clip.kind !== "audio" && track.hidden !== true,
        gain: (clip.kind === "video" || clip.kind === "audio") && track.hidden !== true && track.muted !== true && clip.props["muted"] !== true ? volume : 0,
        ...(incoming ? { transitionIn: { startSec: sourceIn - before, durationSec: incoming.durationSec, kind: incoming.kind, direction: incoming.direction } } : {}),
        ...(outgoing ? { transitionOut: { startSec: sourceIn + original.durationSec - after, durationSec: outgoing.durationSec, kind: outgoing.kind, direction: outgoing.direction } } : {}),
      };
    })),
  };
}

export function evaluateSequence(sequence: CompiledSequence, timeSec: number): readonly ActiveSequenceEntry[] {
  if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec >= sequence.durationSec) return [];
  return sequence.entries.filter(({ clip, visual, gain }) =>
    (visual || gain > 0) && timeSec >= clip.timelineStartSec && timeSec < clipTimelineEndSec(clip),
  ).map((entry) => {
    const sourceTimeSec = (entry.clip.sourceInSec ?? 0) + timeSec - entry.clip.timelineStartSec;
    const fades = clipFades(entry.clip);
    const incoming = entry.transitionIn ? transitionProgress(entry.transitionIn, sourceTimeSec) : 1;
    const outgoing = entry.transitionOut ? 1 - transitionProgress(entry.transitionOut, sourceTimeSec) : 1;
    return { ...entry, sourceTimeSec,
      opacity: fadeFactor(fades, "video", sourceTimeSec) * (entry.transitionIn?.kind === "crossfade" ? incoming : 1),
      ...(entry.transitionIn?.kind === "swipe" ? { clipPath: swipeClipPath(entry.transitionIn.direction, incoming) } : {}),
      gain: entry.gain * fadeFactor(fades, "audio", sourceTimeSec) * incoming * outgoing };
  });
}
