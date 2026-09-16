// Pure time/track helpers for the V1 EDL model.
//
// All time values are SECONDS. Helpers are explicit about units in their
// names to avoid ms/frame confusion. No React/DOM dependency.

import {
  type Clip,
  type ClipKind,
  type Sequence,
  type Track,
  type TrackKind,
  COMPATIBLE_TRACK_BY_CLIP_KIND,
  findClip,
  findTrack,
  isClipKindAllowedOnTrack,
  listAllClips,
  listOrderedTracks,
} from "./edl";

/** Clamp a value to be non-negative. NaN maps to 0. */
export function clampNonNegativeSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

/** Returns true if value is a finite, non-negative number. */
export function isValidSeconds(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** End time on the timeline for a clip. */
export function clipTimelineEndSec(clip: Clip): number {
  return clip.timelineStartSec + clip.durationSec;
}

/**
 * Compute the minimum sequence duration covering all clip ends. Returns 0 for
 * empty sequences.
 */
export function computeSequenceDurationSec(sequence: Sequence): number {
  let max = 0;
  for (const clip of listAllClips(sequence)) {
    const end = clipTimelineEndSec(clip);
    if (end > max) max = end;
  }
  return max;
}

/**
 * Find clips on a track that overlap the given timeline range
 * [startSec, endSec). Excludes the optional `excludeClipId`.
 */
export function clipsOverlappingRange(
  track: Track,
  startSec: number,
  endSec: number,
  excludeClipId?: string,
): Clip[] {
  if (!(endSec > startSec)) return [];
  return track.clips.filter((clip) => {
    if (excludeClipId && clip.id === excludeClipId) return false;
    const clipStart = clip.timelineStartSec;
    const clipEnd = clipTimelineEndSec(clip);
    return clipStart < endSec && clipEnd > startSec;
  });
}

/** True if a clip kind may be placed on a track kind. */
export function isCompatibleTrack(clipKind: ClipKind, trackKind: TrackKind): boolean {
  return isClipKindAllowedOnTrack(clipKind, trackKind);
}

export type DocumentSummary = {
  sequenceId: string;
  durationSec: number;
  trackCount: number;
  clipCount: number;
  /** Complete per-track summary, ordered by `track.order`. */
  tracks: Array<{
    id: string;
    kind: TrackKind;
    order: number;
    clipCount: number;
  }>;
  mediaCount: number;
};

/** Complete structural summary; transport limits belong to the host. */
export function buildDocumentSummary(
  sequence: Sequence,
  mediaCount: number,
): DocumentSummary {
  const ordered = listOrderedTracks(sequence);
  const clipCount = listAllClips(sequence).length;
  return {
    sequenceId: sequence.id,
    durationSec: computeSequenceDurationSec(sequence),
    trackCount: sequence.tracks.length,
    clipCount,
    tracks: ordered.map((track) => ({
      id: track.id,
      kind: track.kind,
      order: track.order,
      clipCount: track.clips.length,
    })),
    mediaCount,
  };
}

export type TrackTimingViolation = {
  kind: "overlap";
  trackId: string;
  clipIds: [string, string];
};

/**
 * Detect overlapping clips on the same track. V1 disallows overlaps within a
 * single track (clips must be sequential).
 */
export function detectTrackTimingViolations(sequence: Sequence): TrackTimingViolation[] {
  const violations: TrackTimingViolation[] = [];
  for (const track of sequence.tracks) {
    const sorted = [...track.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (clipTimelineEndSec(prev) > curr.timelineStartSec) {
        violations.push({ kind: "overlap", trackId: track.id, clipIds: [prev.id, curr.id] });
      }
    }
  }
  return violations;
}

export {
  COMPATIBLE_TRACK_BY_CLIP_KIND,
  findClip,
  findTrack,
  isClipKindAllowedOnTrack,
  listAllClips,
  listOrderedTracks,
};
