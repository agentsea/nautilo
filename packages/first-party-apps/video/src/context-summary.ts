import type { Clip, VideoProject } from "./edl";
import { findClip, listAllClips } from "./edl";
import { computeSequenceDurationSec } from "./timing";
import { inspectClip } from "./timeline-inspection";

const MAX_DESCRIPTION_CHARS = 220;

export type VideoContextSummary = {
  title: string;
  documentPath?: string;
  selection?: {
    clipId: string;
    trackId: string;
    kind: Clip["kind"];
    timelineStartSec: number;
    durationSec: number;
  };
  playheadSec: number;
  selectionScope: { clipIds: string[]; range: { inSec: number; outSec: number } | null; precedence: "range" | "clips" };
  selectedClips: ReturnType<typeof inspectClip>[];
  tracks: Array<{ id: string; name: string; hidden: boolean; locked: boolean; muted: boolean }>;
  savedVersion: { sha256: string; revision: number | null } | null;
  summary: {
    sequenceCount: number;
    trackCount: number;
    clipCount: number;
    mediaCount: number;
    durationSec: number;
    dirty: boolean;
    lastSavedAt?: string;
    description: string;
  };
};

export type BuildVideoContextSummaryInput = {
  documentPath?: string;
  project: VideoProject;
  selectedClipId?: string | null;
  selectedClipIds?: readonly string[];
  range?: { inSec: number; outSec: number };
  savedVersion?: { sha256: string; revision: number | null } | null;
  playheadSec: number;
  dirty: boolean;
  lastSavedAt?: Date | null;
};

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function clampDescription(value: string): string {
  if (value.length <= MAX_DESCRIPTION_CHARS) return value;
  return `${value.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
}

function selectedClip(project: VideoProject, clipId: string | null | undefined): Clip | null {
  if (!clipId) return null;
  const sequence = project.sequences[0];
  if (!sequence) return null;
  return findClip(sequence, clipId)?.clip ?? null;
}

export function buildVideoContextSummary(input: BuildVideoContextSummaryInput): VideoContextSummary {
  const sequence = input.project.sequences[0];
  const title = input.documentPath ? basename(input.documentPath) : input.project.metadata?.title ?? "Untitled video";
  const clipCount = input.project.sequences.reduce((total, seq) => total + listAllClips(seq).length, 0);
  const trackCount = input.project.sequences.reduce((total, seq) => total + seq.tracks.length, 0);
  const durationSec = sequence ? computeSequenceDurationSec(sequence) : 0;
  const selection = selectedClip(input.project, input.selectedClipId);
  const clips = sequence ? listAllClips(sequence) : [];
  const clipIds = new Set(clips.map((clip) => clip.id));
  const requestedIds = input.selectedClipIds ?? (selection ? [selection.id] : []);
  const selectedIds = [...new Set(requestedIds)].filter((id) => clipIds.has(id));
  const selectedSet = new Set(selectedIds);
  const start = Math.max(0, Math.min(durationSec, Math.min(input.range?.inSec ?? 0, input.range?.outSec ?? 0)));
  const end = Math.max(start, Math.min(durationSec, Math.max(input.range?.inSec ?? 0, input.range?.outSec ?? 0)));
  const range = Number.isFinite(start) && Number.isFinite(end) && end > start ? { inSec: start, outSec: end } : null;
  const description = clampDescription(
    [
      `${input.project.sequences.length} sequence(s)`,
      `${trackCount} track(s)`,
      `${clipCount} clip(s)`,
      `${input.project.media.length} media asset(s)`,
      `${durationSec.toFixed(2)}s duration`,
      input.dirty ? "unsaved changes" : "saved",
      selection ? `selected ${selection.kind} ${selection.id}` : "no clip selected",
    ].join("; "),
  );

  return {
    title,
    ...(input.documentPath ? { documentPath: input.documentPath } : {}),
    ...(selection
      ? {
          selection: {
            clipId: selection.id,
            trackId: selection.trackId,
            kind: selection.kind,
            timelineStartSec: selection.timelineStartSec,
            durationSec: selection.durationSec,
          },
        }
      : {}),
    playheadSec: Number.isFinite(input.playheadSec) ? Math.max(0, input.playheadSec) : 0,
    selectionScope: { clipIds: selectedIds, range, precedence: range ? "range" : "clips" },
    selectedClips: clips.filter((clip) => selectedSet.has(clip.id)).map(inspectClip),
    tracks: sequence?.tracks.map((track) => ({ id: track.id, name: track.name ?? track.kind, hidden: !!track.hidden, locked: !!track.locked, muted: !!track.muted })) ?? [],
    savedVersion: input.savedVersion ?? null,
    summary: {
      sequenceCount: input.project.sequences.length,
      trackCount,
      clipCount,
      mediaCount: input.project.media.length,
      durationSec,
      dirty: input.dirty,
      ...(input.lastSavedAt ? { lastSavedAt: input.lastSavedAt.toISOString() } : {}),
      description,
    },
  };
}
