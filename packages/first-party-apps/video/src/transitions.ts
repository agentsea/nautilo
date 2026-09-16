import type { Clip, VideoProject } from "./edl";

export type TransitionKind = "crossfade" | "swipe";
export type SwipeDirection = "left" | "right" | "up" | "down";
/** Owned by the incoming clip; the cut is derived from its current start. */
export type CutTransition = { fromClipId: string; kind: TransitionKind; durationSec: number; direction: SwipeDirection };
/** Source-local projection, never a second saved effect. */
export type TransitionRamp = { startSec: number; durationSec: number; kind: TransitionKind; direction: SwipeDirection };
export const SWIPE_DIRECTIONS: readonly SwipeDirection[] = ["left", "right", "up", "down"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export function validTransitionRamp(value: unknown): value is TransitionRamp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 4 && finite(r["startSec"]) && r["startSec"] >= 0 && finite(r["durationSec"]) && r["durationSec"] > 0
    && Number.isFinite(r["startSec"] + r["durationSec"]) && (r["kind"] === "crossfade" || r["kind"] === "swipe") && SWIPE_DIRECTIONS.includes(r["direction"] as SwipeDirection);
}
export function validCutTransition(value: unknown): value is CutTransition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 4 && typeof r["fromClipId"] === "string" && r["fromClipId"].length > 0
    && validTransitionRamp({ startSec: 0, durationSec: r["durationSec"], kind: r["kind"], direction: r["direction"] });
}
export function clipTransition(clip: Clip): CutTransition | undefined {
  return validCutTransition(clip.props["transition"]) ? clip.props["transition"] : undefined;
}
export function hasProjectTransitions(project: VideoProject): boolean {
  return project.sequences.some((sequence) => sequence.tracks.some((track) => track.clips.some((clip) => clip.props["transition"] !== undefined)));
}
const sameEdge = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * 16 * Math.max(1, Math.abs(a), Math.abs(b));

/** Physical source handles and adjacent cuts determine the bound, not a UI ceiling. */
export function transitionTarget(project: VideoProject, clipId: string): { incoming: Clip; outgoing: Clip; maxDurationSec: number } | { error: string } {
  const track = project.sequences.flatMap((s) => s.tracks).find((t) => t.clips.some((c) => c.id === clipId));
  const incoming = track?.clips.find((c) => c.id === clipId);
  const outgoing = track?.clips.find((c) => c.id !== clipId && sameEdge(c.timelineStartSec + c.durationSec, incoming?.timelineStartSec ?? -1));
  if (!incoming || !outgoing || incoming.kind !== "video" || outgoing.kind !== "video") return { error: "Choose the second of two touching video clips on the same track. Gaps are not transitions." };
  const source = project.media.find((asset) => asset.id === outgoing.mediaId);
  const nextSource = project.media.find((asset) => asset.id === incoming.mediaId);
  if (!source?.durationSec || !nextSource?.durationSec) return { error: "Both sources need measured durations. Restore their media before adding a transition." };
  if ((outgoing.sourceInSec ?? 0) + outgoing.durationSec > source.durationSec || (incoming.sourceInSec ?? 0) + incoming.durationSec > nextSource.durationSec) return { error: "A clip extends beyond its measured source. Restore or trim the media before adding a transition." };
  const priorHalf = (clipTransition(outgoing)?.durationSec ?? 0) / 2;
  const nextClip = track?.clips.find((c) => clipTransition(c)?.fromClipId === incoming.id);
  const nextHalf = (nextClip ? clipTransition(nextClip)!.durationSec : 0) / 2;
  const handles = Math.min(source.durationSec - ((outgoing.sourceInSec ?? 0) + outgoing.durationSec), incoming.sourceInSec ?? 0,
    outgoing.durationSec - priorHalf, incoming.durationSec - nextHalf);
  return { incoming, outgoing, maxDurationSec: Math.max(0, handles * 2) };
}

export function transitionProblem(project: VideoProject): string | null {
  for (const sequence of project.sequences) for (const track of sequence.tracks) for (const clip of track.clips) {
    if (clip.props["transition"] === undefined) continue;
    const transition = clipTransition(clip);
    if (!transition) return "Invalid cut transition. Restore the document or remove this effect.";
    const target = transitionTarget({ ...project, sequences: [sequence] }, clip.id);
    if ("error" in target || target.outgoing.id !== transition.fromClipId) return "This edit would break a transition. Remove it first, or move both adjoining clips together. Nothing was changed.";
    if (transition.durationSec > target.maxDurationSec && !sameEdge(transition.durationSec, target.maxDurationSec)) return `Not enough source footage for this transition. Use at most ${target.maxDurationSec.toFixed(3)}s, or remove it before trimming. Nothing was changed.`;
  }
  return null;
}
export function transitionProgress(ramp: TransitionRamp, sourceTimeSec: number): number {
  return Math.max(0, Math.min(1, (sourceTimeSec - ramp.startSec) / ramp.durationSec));
}
export function swipeClipPath(direction: SwipeDirection, progress: number): string {
  const hidden = (1 - progress) * 100;
  return direction === "left" ? `inset(0 0 0 ${hidden}%)` : direction === "right" ? `inset(0 ${hidden}% 0 0)` : direction === "up" ? `inset(${hidden}% 0 0 0)` : `inset(0 0 ${hidden}% 0)`;
}
