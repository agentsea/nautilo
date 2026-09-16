import type { Clip, VideoProject } from "./edl";

export const FADE_KEYS = ["videoIn", "videoOut", "audioIn", "audioOut"] as const;
export type FadeKey = typeof FADE_KEYS[number];
/** Source-local seconds: splits and range copies preserve the original ramp. */
export type Fade = { startSec: number; durationSec: number };
export type Fades = Partial<Record<FadeKey, Fade>>;
export type FadeEdit = { clipId: string; key: FadeKey; durationSec: number; linkedAudio?: boolean };
export const FADE_LABELS: Record<FadeKey, string> = {
  videoIn: "Video fade in", videoOut: "Video fade out", audioIn: "Audio fade in", audioOut: "Audio fade out",
};

export function validFades(value: unknown): value is Fades {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, raw]) => {
    if (!FADE_KEYS.includes(key as FadeKey) || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const fade = raw as Record<string, unknown>;
    return Object.keys(fade).length === 2 && typeof fade["startSec"] === "number" && Number.isFinite(fade["startSec"]) && fade["startSec"] >= 0
      && typeof fade["durationSec"] === "number" && Number.isFinite(fade["durationSec"]) && fade["durationSec"] > 0 && Number.isFinite(fade["startSec"] + fade["durationSec"]);
  });
}
export function clipFades(clip: Clip): Fades {
  return validFades(clip.props["fades"]) ? clip.props["fades"] : {};
}
export function hasProjectFades(project: VideoProject): boolean {
  return project.sequences.some((sequence) => sequence.tracks.some((track) => track.clips.some((clip) => Object.keys(clipFades(clip)).length > 0)));
}
export function fadeFactor(fades: Fades, channel: "video" | "audio", sourceTime: number): number {
  const progress = (fade: Fade) => Math.max(0, Math.min(1, (sourceTime - fade["startSec"]) / fade["durationSec"]));
  const fadeIn = fades[`${channel}In`]; const fadeOut = fades[`${channel}Out`];
  return (fadeIn ? progress(fadeIn) : 1) * (fadeOut ? 1 - progress(fadeOut) : 1);
}
export function fadeSupported(clip: Clip, key: FadeKey): boolean {
  return clip.kind === "video" || (clip.kind === "audio" && key.startsWith("audio"));
}
