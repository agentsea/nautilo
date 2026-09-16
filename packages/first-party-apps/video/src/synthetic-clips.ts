// Pure planner for human-created synthetic Title, Caption, and Callout clips.
// Returns AddClipInput ready for commands.addClip — no React/DOM, no mutation.

import type { AddClipInput } from "./commands";
import type { ClipKind, Track, VideoProject } from "./edl";
import { listOrderedTracks } from "./edl";
import {
  clampNonNegativeSeconds,
  clipTimelineEndSec,
  clipsOverlappingRange,
  isCompatibleTrack,
} from "./timing";

export type SyntheticClipKind = "title" | "caption" | "callout";

export type PlanSyntheticClipResult =
  | { ok: true; input: AddClipInput }
  | { ok: false; error: string };

type SyntheticPreset = {
  clipKind: ClipKind;
  defaultText: string;
  durationSec: number;
};

const PRESETS: Readonly<Record<SyntheticClipKind, SyntheticPreset>> = {
  title: { clipKind: "text", defaultText: "Title", durationSec: 3 },
  caption: { clipKind: "caption", defaultText: "Caption", durationSec: 3 },
  callout: { clipKind: "callout", defaultText: "Callout", durationSec: 2 },
};

function assertSequence(project: VideoProject) {
  if (project.sequences.length === 0) {
    return { ok: false as const, error: "Project has no sequences." };
  }
  return { ok: true as const, sequence: project.sequences[0]! };
}

/** First track (by `order`) that accepts the clip kind. */
function findFirstCompatibleTrack(project: VideoProject, clipKind: ClipKind): Track | undefined {
  const seqRes = assertSequence(project);
  if (!seqRes.ok) return undefined;
  const tracks = listOrderedTracks(seqRes.sequence).filter((track) => !track.locked && !track.hidden && isCompatibleTrack(clipKind, track.kind));
  return tracks.find((track) => track.kind === (clipKind === "caption" ? "caption" : "overlay")) ?? tracks[0];
}

/**
 * First timeline start at or after `playheadSec` where `[start, start + duration)`
 * does not overlap existing clips on `track`. When the desired slot collides,
 * advance to the latest end among conflicting clips and retry.
 */
export function findFirstNonOverlappingStart(
  track: Track,
  playheadSec: number,
  durationSec: number,
): number {
  let start = clampNonNegativeSeconds(playheadSec);
  // At most one advance per existing clip on the track.
  for (let attempt = 0; attempt <= track.clips.length; attempt++) {
    const end = start + durationSec;
    const overlaps = clipsOverlappingRange(track, start, end);
    if (overlaps.length === 0) return start;
    start = Math.max(...overlaps.map(clipTimelineEndSec));
  }
  return start;
}

export function planSyntheticClip(
  project: VideoProject,
  playheadSec: number,
  kind: SyntheticClipKind,
): PlanSyntheticClipResult {
  const seqRes = assertSequence(project);
  if (!seqRes.ok) return seqRes;

  const preset = PRESETS[kind];
  const track = findFirstCompatibleTrack(project, preset.clipKind);
  if (!track) {
    return { ok: false, error: `No compatible track for synthetic ${kind} clip.` };
  }

  const timelineStartSec = findFirstNonOverlappingStart(track, playheadSec, preset.durationSec);

  return {
    ok: true,
    input: {
      trackId: track.id,
      kind: preset.clipKind,
      timelineStartSec,
      durationSec: preset.durationSec,
      props: { text: preset.defaultText },
    },
  };
}
