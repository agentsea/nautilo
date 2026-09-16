// Pure command-style mutations over the V1 EDL VideoProject.
//
// Each command returns a NEW valid VideoProject or a structured error
// `{ ok:false, error }`. No React/DOM dependency. The agent tool handlers
// layer on top of these to read/serialize/persist via the app bridge.

import {
  type Clip,
  type ClipKind,
  type FrameRate,
  type MediaAsset,
  type WorkspaceArtifactMediaSource,
  type Sequence,
  type Track,
  type TrackKind,
  type VideoProject,
  COMPATIBLE_TRACK_BY_CLIP_KIND,
  EDL_VERSION,
  findClip,
  findTrack,
  createEmptyProject,
  isFrameRate,
  isProjectRelativeMediaRef,
} from "./edl";
import {
  clipTimelineEndSec,
  clipsOverlappingRange,
  computeSequenceDurationSec,
  detectTrackTimingViolations,
  isCompatibleTrack,
  isValidSeconds,
} from "./timing";
import {
  generatedTakesEqual,
  validateGeneratedTake,
  type GeneratedTake,
} from "./generation-takes";
import { validateVideoProject } from "./video-document";
import { clipFades, FADE_KEYS, fadeSupported, validFades, type FadeEdit, type FadeKey } from "./fades";
import { clipTransition, transitionProblem, transitionTarget, type TransitionKind, type SwipeDirection } from "./transitions";

export type CommandError = { ok: false; error: string };
export type CommandOk<T> = { ok: true; project: T };
export type CommandResult<T> = CommandOk<T> | CommandError;

export type TimelineSelection = { range?: { inSec: number; outSec: number } | undefined; clipIds: readonly string[] };
/** Transient, same-project data. Never serialize this to the OS clipboard. */
export type TimelineClipboard = {
  sequenceId: string;
  frameRate: FrameRate;
  durationSec: number;
  clips: Clip[];
  media: MediaAsset[];
};

function clipboardSourceIdentity(asset: MediaAsset): string {
  return JSON.stringify([asset.id, asset.kind, asset.ref, asset.lifecycle, asset.source?.kind, asset.source?.artifactId, asset.source?.path, asset.durationSec]);
}

function clipFragment(clip: Clip, start: number, end: number, id: string): Clip {
  const next = structuredClone(clip);
  next.id = id;
  next.timelineStartSec = start;
  next.durationSec = end - start;
  if (clip.kind === "video" || clip.kind === "audio" || clip.sourceInSec !== undefined) {
    next.sourceInSec = (clip.sourceInSec ?? 0) + start - clip.timelineStartSec;
    next.sourceOutSec = next.sourceInSec + next.durationSec;
  }
  return next;
}

function resolveClipboardSelection(project: VideoProject, selection: TimelineSelection): { ok: true; sequence: Sequence; origin: number; end: number; parts: Array<{ clip: Clip; start: number; end: number }> } | CommandError {
  const result = assertSequence(project);
  if (!result.ok) return result;
  const { sequence } = result;
  const all = sequence.tracks.flatMap((track) => track.clips);
  const range = selection.range;
  if (range && range.inSec !== range.outSec) {
    if (!isValidSeconds(range.inSec) || !isValidSeconds(range.outSec)) return error("Choose a valid timeline range.");
    const rate = sequence.frameRate.numerator / sequence.frameRate.denominator;
    const origin = Math.round(Math.min(range.inSec, range.outSec) * rate) / rate;
    const end = Math.round(Math.max(range.inSec, range.outSec) * rate) / rate;
    const parts = sequence.tracks.filter((track) => !track.locked && !track.hidden).flatMap((track) => track.clips.flatMap((clip) => {
      const start = Math.max(origin, clip.timelineStartSec);
      const stop = Math.min(end, clipTimelineEndSec(clip));
      return stop > start ? [{ clip, start, end: stop }] : [];
    }));
    return parts.length ? { ok: true, sequence, origin, end, parts } : error("No visible, unlocked clips intersect this range.");
  }
  if (!selection.clipIds.length) return error("Select clips or drag IN/OUT to select a range first.");
  for (const id of selection.clipIds) if (!all.some((clip) => clip.id === id)) return error("The selection changed. Select the clips again.");
  const visible = sequence.tracks.filter((track) => !track.hidden).flatMap((track) => track.clips);
  const visibleIds = new Set(visible.map((clip) => clip.id));
  const ids = new Set(selection.clipIds.filter((id) => visibleIds.has(id)));
  if (!ids.size) return error("No visible clips are selected. Select a visible clip or a range.");
  // Include incoming as well as outgoing links, without inventing track targets.
  let changed = true;
  while (changed) {
    changed = false;
    for (const clip of visible) if (ids.has(clip.id) || clip.linkedClipIds?.some((id) => ids.has(id))) {
      for (const id of [clip.id, ...(clip.linkedClipIds ?? [])]) if (visibleIds.has(id) && !ids.has(id)) { ids.add(id); changed = true; }
    }
  }
  const chosen = all.filter((clip) => ids.has(clip.id));
  const locked = sequence.tracks.find((track) => track.locked && track.clips.some((clip) => ids.has(clip.id)));
  if (locked) return error(`Unlock ${locked.name ?? locked.kind} before editing its linked selection.`);
  const origin = Math.min(...chosen.map((clip) => clip.timelineStartSec));
  const end = Math.max(...chosen.map(clipTimelineEndSec));
  return { ok: true, sequence, origin, end, parts: chosen.map((clip) => ({ clip, start: clip.timelineStartSec, end: clipTimelineEndSec(clip) })) };
}

export function copyTimelineSelection(project: VideoProject, selection: TimelineSelection): { ok: true; clipboard: TimelineClipboard } | CommandError {
  const resolved = resolveClipboardSelection(project, selection);
  if (!resolved.ok) return resolved;
  const ids = new Set(resolved.parts.map(({ clip }) => clip.id));
  const clips = resolved.parts.map(({ clip, start, end }) => {
    const fragment = clipFragment(clip, start, end, clip.id);
    fragment.timelineStartSec -= resolved.origin;
    fragment.linkedClipIds = (clip.linkedClipIds ?? []).filter((id) => ids.has(id));
    return fragment;
  });
  const mediaIds = new Set(clips.flatMap((clip) => clip.mediaId ? [clip.mediaId] : []));
  const clipboardProblem = transitionProblem({ ...project, sequences: [{ ...resolved.sequence, tracks: resolved.sequence.tracks.map((track) => ({ ...track, clips: clips.filter((clip) => clip.trackId === track.id) })) }] });
  if (clipboardProblem) return error("Copy both complete clips of a transition, or remove the transition before copying this range.");
  if ([...mediaIds].some((id) => !project.media.some((asset) => asset.id === id))) return error("A selected source is missing. Restore it in the Media Bin first.");
  return { ok: true, clipboard: { sequenceId: resolved.sequence.id, frameRate: { ...resolved.sequence.frameRate }, durationSec: resolved.end - resolved.origin, clips, media: structuredClone(project.media.filter((asset) => mediaIds.has(asset.id))) } };
}

/** Gap-preserving deletion. The caller replaces the clipboard only after commit. */
export function removeTimelineSelection(project: VideoProject, selection: TimelineSelection): CommandResult<VideoProject> {
  const resolved = resolveClipboardSelection(project, selection);
  if (!resolved.ok) return resolved;
  const { sequence, parts } = resolved;
  const affected = new Map(parts.map((part) => [part.clip.id, part]));
  const affectedTracks = affectedClipTrackIds(sequence, affected.keys());
  const protectedTrack = sequence.tracks.find((track) => !track.hidden && track.locked && affectedTracks.has(track.id));
  if (protectedTrack) return error(`Cannot cut linked media while ${protectedTrack.name ?? protectedTrack.kind} is locked. Unlock it or unlink the clips first.`);
  const pieces = new Map<string, Clip[]>();
  for (const clip of sequence.tracks.flatMap((track) => track.clips)) {
    const part = affected.get(clip.id);
    if (!part) { pieces.set(clip.id, [structuredClone(clip)]); continue; }
    const remaining: Clip[] = [];
    if (part.start > clip.timelineStartSec) remaining.push(clipFragment(clip, clip.timelineStartSec, part.start, clip.id));
    if (part.end < clipTimelineEndSec(clip)) remaining.push(clipFragment(clip, part.end, clipTimelineEndSec(clip), remaining.length ? generateId("clip") : clip.id));
    pieces.set(clip.id, remaining);
  }
  for (const [oldId, fragments] of pieces) {
    const original = findClip(sequence, oldId)!.clip;
    for (const fragment of fragments) {
      if (!original.linkedClipIds) continue;
      fragment.linkedClipIds = original.linkedClipIds.flatMap((linkedId) => (pieces.get(linkedId) ?? []).filter((peer) =>
        !(affected.has(oldId) && affected.has(linkedId)) || (peer.timelineStartSec < clipTimelineEndSec(fragment) && clipTimelineEndSec(peer) > fragment.timelineStartSec),
      ).map((peer) => peer.id));
    }
  }
  const next = { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => pieces.get(clip.id) ?? []) })) };
  try {
    return { ok: true, project: validateVideoProject(bumpMetadata(replaceSequence(project, 0, next))) };
  } catch { return error("The cut would create invalid clips or exceed this project's supported format. Nothing was changed."); }
}

export function pasteTimelineClipboard(project: VideoProject, clipboard: TimelineClipboard, atSec: number): CommandResult<VideoProject> {
  const sequence = project.sequences[0];
  if (!sequence || sequence.id !== clipboard.sequenceId) return error("This clipboard belongs to another sequence. Copy a selection here first.");
  if (!ratesEqual(sequence.frameRate, clipboard.frameRate)) return error("The project frame rate changed. Copy the selection again before pasting.");
  if (!isValidSeconds(atSec) || !clipboard.clips.length) return error("Choose a valid playhead position and copy a selection first.");
  for (const asset of clipboard.media) {
    const current = project.media.find((candidate) => candidate.id === asset.id);
    if (!current || clipboardSourceIdentity(current) !== clipboardSourceIdentity(asset)) return error(`Source ${asset.label ?? "media"} changed or is missing. Restore it or copy again.`);
  }
  const rate = sequence.frameRate.numerator / sequence.frameRate.denominator;
  const start = Math.round(atSec * rate) / rate;
  const ids = new Map(clipboard.clips.map((clip) => [clip.id, generateId("clip")]));
  const added = clipboard.clips.map((clip): Clip => ({ ...structuredClone(clip), id: ids.get(clip.id)!, timelineStartSec: start + clip.timelineStartSec, linkedClipIds: (clip.linkedClipIds ?? []).flatMap((id) => ids.has(id) ? [ids.get(id)!] : []) }));
  for (const clip of added) {
    const transition = clipTransition(clip);
    if (transition) {
      const from = ids.get(transition.fromClipId);
      if (!from) return error("The copied transition is missing its other clip. Copy both clips again.");
      clip.props["transition"] = { ...transition, fromClipId: from };
    }
    const track = findTrack(sequence, clip.trackId);
    if (!track) return error("An original paste track was deleted. Restore it with Undo or copy another selection.");
    if (track.locked) return error(`Unlock ${track.name ?? track.kind} before pasting.`);
    if (track.hidden) return error(`Show ${track.name ?? track.kind} before pasting.`);
    if (!isCompatibleTrack(clip.kind, track.kind)) return error(`The original ${track.name ?? track.kind} track cannot accept this clip type.`);
    // Seconds-at-rest arithmetic can put a reconstructed end one ULP beyond
    // its old gap. Normalize only floating-point roundoff, not real overlaps.
    const exactEdge = (value: number) => {
      for (const neighbor of track.clips) for (const edge of [neighbor.timelineStartSec, clipTimelineEndSec(neighbor)]) {
        if (Math.abs(value - edge) <= Number.EPSILON * 16 * Math.max(1, Math.abs(value), Math.abs(edge))) return edge;
      }
      return value;
    };
    const end = exactEdge(clipTimelineEndSec(clip));
    clip.timelineStartSec = exactEdge(clip.timelineStartSec);
    clip.durationSec = end - clip.timelineStartSec;
    if (clipTimelineEndSec(clip) > end) clip.durationSec -= clipTimelineEndSec(clip) - end;
    if (clip.sourceInSec !== undefined) clip.sourceOutSec = clip.sourceInSec + clip.durationSec;
    if (clipsOverlappingRange(track, clip.timelineStartSec, clipTimelineEndSec(clip)).length) return error(`Not enough space on ${track.name ?? track.kind}. Move the playhead to a gap or make room; existing clips were not moved.`);
    const invalidSource = validateSourceWindow(project, clip.mediaId, clip.sourceInSec, clip.sourceOutSec, clip.durationSec);
    if (invalidSource) return invalidSource;
  }
  const next = { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: [...track.clips, ...added.filter((clip) => clip.trackId === track.id)].sort((a, b) => a.timelineStartSec - b.timelineStartSec) })) };
  next.durationSec = Math.max(sequence.durationSec, computeSequenceDurationSec(next));
  try {
    return { ok: true, project: validateVideoProject(bumpMetadata(replaceSequence(project, 0, next))) };
  } catch { return error("The paste would create invalid clips or exceed this project's supported format. Nothing was changed."); }
}

// Minimal id generator. Foundation-only; later phases can swap for a
// host-supplied id allocator if needed.
let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function error(message: string): CommandError {
  return { ok: false, error: message };
}

function lockedTrackError(sequence: Sequence, trackIds: Iterable<string>): CommandError | null {
  for (const trackId of new Set(trackIds)) {
    const track = findTrack(sequence, trackId);
    if (track?.locked) return error(`Track is locked: ${track.id}`);
    if (track?.hidden) return error(`Track is hidden: ${track.id}. Show it before editing.`);
  }
  return null;
}

function affectedClipTrackIds(sequence: Sequence, clipIds: Iterable<string>): Set<string> {
  const inboundLinks = new Map<string, string[]>();
  for (const clip of sequence.tracks.flatMap((track) => track.clips)) {
    for (const linkedId of clip.linkedClipIds ?? []) {
      inboundLinks.set(linkedId, [...(inboundLinks.get(linkedId) ?? []), clip.id]);
    }
  }
  const pending = [...clipIds];
  const visited = new Set<string>();
  const trackIds = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const found = findClip(sequence, id);
    if (!found) continue;
    trackIds.add(found.track.id);
    for (const linkedId of found.clip.linkedClipIds ?? []) pending.push(linkedId);
    for (const linkingId of inboundLinks.get(id) ?? []) pending.push(linkingId);
  }
  return trackIds;
}

function assertSequence(project: VideoProject, sequenceId?: string): { ok: true; sequence: Sequence; index: number } | CommandError {
  if (project.sequences.length === 0) return error("Project has no sequences.");
  if (sequenceId) {
    const index = project.sequences.findIndex((s) => s.id === sequenceId);
    if (index < 0) return error(`Sequence not found: ${sequenceId}`);
    return { ok: true, sequence: project.sequences[index]!, index };
  }
  return { ok: true, sequence: project.sequences[0]!, index: 0 };
}

function replaceSequence(project: VideoProject, index: number, next: Sequence): VideoProject {
  const sequences = project.sequences.map((s, i) => (i === index ? next : s));
  return { ...project, sequences };
}

function bumpMetadata(project: VideoProject): VideoProject {
  return {
    ...project,
    metadata: {
      ...project.metadata,
      updatedAt: new Date().toISOString(),
    },
  };
}

function finishEdit(project: VideoProject): CommandResult<VideoProject> {
  const problem = transitionProblem(project);
  return problem ? error(problem) : { ok: true, project: bumpMetadata(project) };
}

export function setCutTransition(project: VideoProject, input: { clipId: string; kind: TransitionKind; direction: SwipeDirection; durationSec: number }): CommandResult<VideoProject> {
  const found = assertSequence(project);
  if (!found.ok) return found;
  const owner = findClip(found.sequence, input.clipId);
  if (!owner) return error("Clip no longer exists. Select another cut.");
  const track = findTrack(found.sequence, owner.clip.trackId)!;
  if (track.hidden || track.locked) return error("Show and unlock this track before changing its transition.");
  if (!Number.isFinite(input.durationSec) || input.durationSec < 0) return error("Choose a finite transition duration.");
  const props = { ...owner.clip.props };
  if (input.durationSec === 0) delete props["transition"];
  else {
    const target = transitionTarget(project, input.clipId);
    if ("error" in target) return error(target.error);
    props["transition"] = { fromClipId: target.outgoing.id, kind: input.kind, direction: input.direction, durationSec: input.durationSec };
  }
  const next = { ...found.sequence, tracks: found.sequence.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.id === input.clipId ? { ...c, props } : c) })) };
  return finishEdit(replaceSequence(project, found.index, next));
}

function isTrulyEmptyProject(project: VideoProject): boolean {
  return project.media.length === 0 && project.sequences.every((sequence) => sequence.tracks.every((track) => track.clips.length === 0));
}

function ratesEqual(left: FrameRate, right: FrameRate): boolean {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

export type FirstSourceRateDecision = "keep-project-rate" | "adopt-source-rate";

/**
 * Returns true only for the first source in a truly empty project. Later
 * imports never get to mutate the established sequence rate implicitly.
 */
export function requiresFirstSourceRateDecision(project: VideoProject, sourceRate: FrameRate): boolean {
  const sequence = project.sequences[0];
  return Boolean(sequence && isTrulyEmptyProject(project) && !ratesEqual(sequence.frameRate, sourceRate));
}

type ImportedMediaBaseInput = {
  ref: string;
  label: string;
  /** Current Folder imports are working references until a future promotion. */
  lifecycle?: "local-working" | "durable";
  /** Present only for a host-authorized durable Workspace import. */
  source?: WorkspaceArtifactMediaSource;
  mediaId?: string;
  clipId?: string;
};

export type AddImportedMediaInput = ImportedMediaBaseInput & (
  | {
      /** Omission preserves the original video-only caller contract. */
      mediaKind?: "video";
      durationSec: number;
      frameRate: FrameRate;
      /** Required exactly when a differing source is the first source in an empty project. */
      rateDecision?: FirstSourceRateDecision;
    }
  | { mediaKind: "audio"; durationSec: number; frameRate?: never; rateDecision?: never }
  | { mediaKind: "image"; durationSec?: never; frameRate?: never; rateDecision?: never }
);

/** Legacy source-compatible name; the optional discriminator defaults to video. */
export type AddImportedVideoInput = AddImportedMediaInput;

/**
 * Admit imported media to the project Media Bin without placing it on the
 * timeline. Placement is a separate Human action through `addClip`.
 */
export function admitImportedMedia(project: VideoProject, input: AddImportedMediaInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;
  if (!isProjectRelativeMediaRef(input.ref)) return error("Imported media ref must be a safe project-relative ref.");
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    return error("Imported media label must be a bounded non-empty string.");
  }
  const mediaKind = input.mediaKind ?? "video";
  if (mediaKind !== "video" && mediaKind !== "audio" && mediaKind !== "image") return error("Imported media kind is unsupported.");
  if (mediaKind === "video" || mediaKind === "audio") {
    const durationSec = input.durationSec;
    if (!Number.isFinite(durationSec) || durationSec === undefined || durationSec <= 0) {
      return error("Imported video and audio require a positive finite measured duration.");
    }
  } else if (input.durationSec !== undefined) {
    return error("Imported images must not declare a media duration.");
  }
  if (mediaKind === "video") {
    if (!isFrameRate(input.frameRate)) return error("Imported video frame rate must be a positive rational rate with safe integer components.");
  } else if (input.frameRate !== undefined) {
    return error("Only imported video may declare a frame rate.");
  }
  if (mediaKind !== "video" && input.rateDecision !== undefined) return error("Only imported video may change the sequence rate.");
  if (input.source) {
    if (input.lifecycle !== "durable" || input.source.kind !== "workspace-artifact" || input.source.path !== input.ref || !input.source.artifactId.trim()) {
      return error("Durable Workspace imports require one matching public artifact source.");
    }
  } else if (input.lifecycle === "durable") {
    return error("Durable imported media requires a Workspace artifact source.");
  }
  if (project.media.some((asset) => asset.ref === input.ref)) return error("This media reference is already in the project.");

  const sourceFrameRate = mediaKind === "video" ? input.frameRate : undefined;
  const needsDecision = sourceFrameRate !== undefined && requiresFirstSourceRateDecision(project, sourceFrameRate);
  if (needsDecision && !input.rateDecision) {
    return error("Choose whether to keep the project rate or adopt this first source rate.");
  }
  if (!needsDecision && input.rateDecision === "adopt-source-rate") {
    return error("Only a differing first source in a truly empty project may adopt its rate.");
  }

  const mediaId = input.mediaId ?? generateId("media");
  const asset: MediaAsset = {
    id: mediaId,
    kind: mediaKind,
    ref: input.ref,
    lifecycle: input.lifecycle ?? "local-working",
    ...(input.source ? { source: { ...input.source } } : {}),
    ...(mediaKind === "video" || mediaKind === "audio" ? { durationSec: input.durationSec! } : {}),
    ...(sourceFrameRate ? { frameRate: { ...sourceFrameRate } } : {}),
    label: input.label.trim(),
  };
  let prepared: VideoProject = { ...project, media: [...project.media, asset] };
  if (input.rateDecision === "adopt-source-rate") {
    prepared = replaceSequence(prepared, index, { ...sequence, frameRate: { ...input.frameRate } });
  }
  return finishEdit(prepared);
}

export function admitImportedVideo(project: VideoProject, input: AddImportedVideoInput): CommandResult<VideoProject> {
  return admitImportedMedia(project, input);
}

/**
 * Backward-compatible compound import used by older callers and fixtures.
 * New editing UI calls `admitImportedMedia` and lets the Human place the
 * asset from the Media Bin deliberately.
 */
export function addImportedMedia(project: VideoProject, input: AddImportedMediaInput): CommandResult<VideoProject> {
  const admitted = admitImportedMedia(project, input);
  if (!admitted.ok) return admitted;
  const targetSequence = admitted.project.sequences[0]!;
  const mediaKind = input.mediaKind ?? "video";
  const placementDurationSec = mediaKind === "image" ? 5 : input.durationSec!;
  const clipKind: ClipKind = mediaKind;
  const availableTracks = targetSequence.tracks.filter((track) => !track.locked && !track.hidden && isCompatibleTrack(clipKind, track.kind));
  const targetTrack = availableTracks.find((track) => track.kind === (clipKind === "audio" ? "audio" : "video")) ?? availableTracks[0];
  if (!targetTrack) return error(`Project has no compatible track for imported ${mediaKind}.`);
  const admittedAsset = admitted.project.media.find((asset) => !project.media.some((existing) => existing.id === asset.id));
  if (!admittedAsset) return error("Imported media could not be identified after admission.");
  const result = addClip(admitted.project, {
    trackId: targetTrack.id,
    kind: clipKind,
    mediaId: admittedAsset.id,
    timelineStartSec: computeSequenceDurationSec(targetSequence),
    durationSec: placementDurationSec,
    sourceInSec: 0,
    sourceOutSec: placementDurationSec,
    ...(input.clipId ? { id: input.clipId } : {}),
  });
  if (!result.ok) return result;
  const nextSequence = result.project.sequences[0]!;
  const durationSec = Math.max(nextSequence.durationSec, computeSequenceDurationSec(nextSequence));
  return finishEdit(replaceSequence(result.project, 0, { ...nextSequence, durationSec }));
}

export function addImportedVideo(project: VideoProject, input: AddImportedVideoInput): CommandResult<VideoProject> {
  return addImportedMedia(project, input);
}

export type AddTrackInput = {
  sequenceId?: string;
  kind: TrackKind;
  id?: string;
  /** Insert before this track; omission appends at the bottom. */
  beforeTrackId?: string;
};

export function addTrack(project: VideoProject, input: AddTrackInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;
  if (!Object.values(COMPATIBLE_TRACK_BY_CLIP_KIND).some((kinds) => kinds.includes(input.kind))) {
    return error(`Unsupported track kind: ${String(input.kind)}`);
  }
  const id = input.id ?? generateId(`track-${input.kind}`);
  if (!id.trim() || sequence.tracks.some((track) => track.id === id)) return error("Track id must be unique and non-empty.");
  const ordered = [...sequence.tracks].sort((left, right) => left.order - right.order);
  const beforeIndex = input.beforeTrackId === undefined ? ordered.length : ordered.findIndex((track) => track.id === input.beforeTrackId);
  if (beforeIndex < 0) return error(`Track not found: ${input.beforeTrackId}`);
  const locked = lockedTrackError(sequence, ordered.slice(beforeIndex).map((track) => track.id));
  if (locked) return locked;
  let number = ordered.length + 1;
  while (ordered.some((track) => track.name === `Track ${number}`)) number += 1;
  ordered.splice(beforeIndex, 0, { id, kind: input.kind, name: `Track ${number}`, order: beforeIndex, clips: [] });
  const tracks = ordered.map((track, order) => ({ ...track, order }));
  return finishEdit(replaceSequence(project, index, { ...sequence, tracks }));
}

export type DeleteTrackInput = { sequenceId?: string; trackId: string };

export function deleteTrack(project: VideoProject, input: DeleteTrackInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;
  const track = findTrack(sequence, input.trackId);
  if (!track) return error(`Track not found: ${input.trackId}`);
  if (track.locked) return error(`Track is locked: ${track.id}`);
  if (track.hidden) return error(`Track is hidden: ${track.id}. Show it before editing.`);
  if (track.clips.length > 0) return error("Move or delete this track's clips before deleting the track.");
  const tracks = sequence.tracks
    .filter((candidate) => candidate.id !== input.trackId)
    .sort((left, right) => left.order - right.order)
    .map((candidate, order) => ({ ...candidate, order }));
  return finishEdit(replaceSequence(project, index, { ...sequence, tracks }));
}

export type ReorderTrackInput = { sequenceId?: string; trackId: string; destinationIndex: number };

export function reorderTrack(project: VideoProject, input: ReorderTrackInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;
  const ordered = [...sequence.tracks].sort((left, right) => left.order - right.order);
  const sourceIndex = ordered.findIndex((track) => track.id === input.trackId);
  if (sourceIndex < 0) return error(`Track not found: ${input.trackId}`);
  if (!Number.isSafeInteger(input.destinationIndex) || input.destinationIndex < 0 || input.destinationIndex >= ordered.length) {
    return error("Track destination must be within the sequence.");
  }
  const firstAffected = Math.min(sourceIndex, input.destinationIndex);
  const lastAffected = Math.max(sourceIndex, input.destinationIndex);
  const locked = lockedTrackError(sequence, ordered.slice(firstAffected, lastAffected + 1).map((track) => track.id));
  if (locked) return locked;
  const [moved] = ordered.splice(sourceIndex, 1);
  ordered.splice(input.destinationIndex, 0, moved!);
  const tracks = ordered.map((track, order) => ({ ...track, order }));
  return finishEdit(replaceSequence(project, index, { ...sequence, tracks }));
}

export type UpdateTrackInput = {
  sequenceId?: string;
  trackId: string;
  name?: string;
  locked?: boolean;
  muted?: boolean;
  hidden?: boolean;
};

/** Update presentation/protection state without mutating any clip. */
export function updateTrack(project: VideoProject, input: UpdateTrackInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;
  const track = findTrack(sequence, input.trackId);
  if (!track) return error(`Track not found: ${input.trackId}`);
  if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim().length === 0)) {
    return error("Track name must be a non-empty string when present.");
  }
  for (const field of ["locked", "muted", "hidden"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") return error(`Track ${field} must be a boolean when present.`);
  }
  if (input.name === undefined && input.locked === undefined && input.muted === undefined && input.hidden === undefined) {
    return error("updateTrack requires at least one track field.");
  }
  if (track.locked) {
    if (input.name !== undefined || (input.locked === false && (input.muted !== undefined || input.hidden !== undefined))) {
      return error(`Track is locked: ${track.id}`);
    }
  }
  const nextTrack: Track = {
    ...track,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.locked !== undefined ? { locked: input.locked } : {}),
    ...(input.muted !== undefined ? { muted: input.muted } : {}),
    ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
  };
  return finishEdit(replaceSequence(project, index, {
    ...sequence,
    tracks: sequence.tracks.map((candidate) => candidate.id === track.id ? nextTrack : candidate),
  }));
}

/**
 * The bridge/server rechecks this immediately before a human promotion. A
 * `.video.html` candidate is lineage only, so it can never by itself attest
 * that a Workspace artifact is still readable or still belongs to the take.
 */
export type GeneratedTakeRevalidation =
  /** `durationSec` is the host-measured readable artifact duration, never requested settings. */
  | { status: "ready"; take: GeneratedTake; durationSec: number }
  | { status: "stale" | "deleted" | "unavailable" | "malformed"; takeId: string };

export type PromoteGeneratedTakeInput = {
  /** A host-owned status result, not a receipt or provider response. */
  revalidated: GeneratedTakeRevalidation;
  /** Explicit placement; promotion never inserts itself when a take completes. */
  sequenceId: string;
  trackId: string;
  timelineStartSec: number;
  mediaId?: string;
  clipId?: string;
};

function promotionRevalidationError(revalidated: unknown): CommandError | null {
  if (!revalidated || typeof revalidated !== "object" || Array.isArray(revalidated)) {
    return error("Generated take revalidation is malformed.");
  }
  const record = revalidated as Record<string, unknown>;
  switch (record["status"]) {
    case "ready":
      return null;
    case "stale":
      return error("Generated take is stale. Refresh it before promotion.");
    case "deleted":
      return error("Generated take artifact was deleted and cannot be promoted.");
    case "unavailable":
      return error("Generated take artifact is unavailable and cannot be promoted.");
    case "malformed":
      return error("Generated take revalidation is malformed.");
    default:
      return error("Generated take revalidation is malformed.");
  }
}

/**
 * Admit a revalidated completed take to the bin only. Repeated completion is
 * idempotent; no clip, track, sequence rate, or existing media is changed.
 */
export function admitGeneratedTakeMedia(project: VideoProject, revalidation: GeneratedTakeRevalidation, requestedMediaId?: string): CommandResult<VideoProject> {
  const readinessError = promotionRevalidationError(revalidation);
  if (readinessError) return readinessError;
  const readiness = revalidation as Extract<GeneratedTakeRevalidation, { status: "ready" }>;

  let revalidated: GeneratedTake;
  try {
    revalidated = validateGeneratedTake(readiness.take);
  } catch {
    return error("Generated take revalidation is malformed.");
  }
  const durationSec = readiness.durationSec;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return error("Generated take revalidation requires a positive finite measured artifact duration.");
  }
  const persisted = project.generatedTakes?.find((take) => take.id === revalidated.id);
  if (!persisted) return error("Generated take is not part of this project.");
  try {
    if (!generatedTakesEqual(persisted, revalidated)) {
      return error("Generated take changed after it was recorded. Refresh it before promotion.");
    }
  } catch {
    return error("Recorded generated take is malformed.");
  }

  const existing = project.media.find((asset) => asset.source?.kind === "workspace-artifact" && asset.source.artifactId === revalidated.artifact.artifactId);
  if (existing) {
    if (existing.kind !== revalidated.mediaKind || existing.durationSec !== durationSec || existing.source?.kind !== "workspace-artifact" || existing.source.path !== revalidated.artifact.path) {
      return error("Generated media differs from the recorded source. Existing media was preserved.");
    }
    return { ok: true, project };
  }
  const mediaId = requestedMediaId ?? generateId("media");
  if (typeof mediaId !== "string" || mediaId.length === 0 || project.media.some((asset) => asset.id === mediaId)) {
    return error("Generated take media id must be unique and non-empty.");
  }
  const asset: MediaAsset = {
    id: mediaId,
    kind: revalidated.mediaKind,
    ref: revalidated.artifact.path,
    lifecycle: "durable",
    source: {
      kind: "workspace-artifact",
      artifactId: revalidated.artifact.artifactId,
      path: revalidated.artifact.path,
    },
    durationSec,
    label: revalidated.shotLabel ?? `Generated ${revalidated.mediaKind}`,
  };
  return { ok: true, project: validateVideoProject(bumpMetadata({ ...project, media: [...project.media, asset] })) };
}

/** Explicit placement reuses automatic bin admission; completion itself never adds clips. */
export function promoteGeneratedTake(project: VideoProject, input: PromoteGeneratedTakeInput): CommandResult<VideoProject> {
  const admitted = admitGeneratedTakeMedia(project, input?.revalidated, input?.mediaId);
  if (!admitted.ok) return admitted;
  const readiness = input.revalidated as Extract<GeneratedTakeRevalidation, { status: "ready" }>;
  const asset = admitted.project.media.find((item) => item.source?.kind === "workspace-artifact" && item.source.artifactId === readiness.take.artifact.artifactId)!;
  if (typeof input.trackId !== "string" || input.trackId.length === 0) return error("Generated take promotion requires an explicit track.");
  if (typeof input.sequenceId !== "string" || input.sequenceId.length === 0) return error("Generated take promotion requires an explicit sequence.");
  if (!isValidSeconds(input.timelineStartSec)) return error("Generated take promotion requires a non-negative finite timeline start.");
  const placed = addClip(admitted.project, {
    sequenceId: input.sequenceId,
    trackId: input.trackId,
    kind: asset.kind === "video" ? "video" : "audio",
    mediaId: asset.id,
    timelineStartSec: input.timelineStartSec,
    durationSec: readiness.durationSec,
    sourceInSec: 0,
    sourceOutSec: readiness.durationSec,
    ...(input.clipId ? { id: input.clipId } : {}),
  });
  // `addClip` remains the single compatibility, cap, and overlap authority.
  // Because it is pure, a rejected placement leaves `project` untouched.
  return placed;
}

export type AddClipInput = {
  sequenceId?: string;
  trackId: string;
  kind: ClipKind;
  mediaId?: string;
  timelineStartSec: number;
  durationSec: number;
  sourceInSec?: number;
  sourceOutSec?: number;
  props?: Record<string, unknown>;
  id?: string;
};

function measuredMediaDuration(project: VideoProject, mediaId: string | undefined): number | undefined {
  if (mediaId === undefined) return undefined;
  return project.media.find((asset) => asset.id === mediaId)?.durationSec;
}

function validateSourceWindow(
  project: VideoProject,
  mediaId: string | undefined,
  sourceInSec: number | undefined,
  sourceOutSec: number | undefined,
  durationSec: number,
): CommandError | null {
  if (sourceInSec !== undefined && !isValidSeconds(sourceInSec)) {
    return error("sourceInSec must be a non-negative finite number when present.");
  }
  if (sourceOutSec !== undefined && !isValidSeconds(sourceOutSec)) {
    return error("sourceOutSec must be a non-negative finite number when present.");
  }
  if (sourceInSec !== undefined && sourceOutSec !== undefined) {
    if (sourceOutSec < sourceInSec) return error("sourceOutSec must be >= sourceInSec.");
    const scale = Math.max(1, Math.abs(sourceInSec), Math.abs(sourceOutSec), Math.abs(durationSec));
    if (Math.abs(sourceOutSec - sourceInSec - durationSec) > Number.EPSILON * 16 * scale) {
      return error("Source window duration must match clip duration.");
    }
  }
  const measuredDuration = measuredMediaDuration(project, mediaId);
  if (measuredDuration !== undefined && sourceOutSec !== undefined && sourceOutSec > measuredDuration) {
    return error("Source window exceeds the measured media duration.");
  }
  return null;
}

export function addClip(project: VideoProject, input: AddClipInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const track = findTrack(sequence, input.trackId);
  if (!track) return error(`Track not found: ${input.trackId}`);
  if (track.locked) return error(`Track is locked: ${track.id}`);
  if (track.hidden) return error(`Track is hidden: ${track.id}. Show it before editing.`);

  if (!isCompatibleTrack(input.kind, track.kind)) {
    return error(`Clip kind "${input.kind}" is not allowed on ${track.kind} track.`);
  }
  if (!isValidSeconds(input.timelineStartSec)) return error("timelineStartSec must be a non-negative finite number.");
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) return error("durationSec must be a positive number.");

  let sourceInSec = input.sourceInSec;
  let sourceOutSec = input.sourceOutSec;
  const measuredDuration = measuredMediaDuration(project, input.mediaId);
  if (measuredDuration !== undefined && sourceInSec === undefined && sourceOutSec === undefined) {
    sourceInSec = 0;
    sourceOutSec = input.durationSec;
  } else if (sourceInSec !== undefined && sourceOutSec === undefined) {
    sourceOutSec = sourceInSec + input.durationSec;
  } else if (sourceOutSec !== undefined && sourceInSec === undefined) {
    sourceInSec = sourceOutSec - input.durationSec;
  }
  const sourceWindowError = validateSourceWindow(project, input.mediaId, sourceInSec, sourceOutSec, input.durationSec);
  if (sourceWindowError) return sourceWindowError;

  const newClip: Clip = {
    kind: input.kind,
    id: input.id ?? generateId("clip"),
    trackId: track.id,
    timelineStartSec: input.timelineStartSec,
    durationSec: input.durationSec,
    ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
    ...(sourceInSec !== undefined ? { sourceInSec } : {}),
    ...(sourceOutSec !== undefined ? { sourceOutSec } : {}),
    props: input.props ?? {},
  } as Clip;

  // Reject overlap creation: V1 disallows overlapping clips within a track.
  const overlaps = clipsOverlappingRange(track, input.timelineStartSec, input.timelineStartSec + input.durationSec);
  if (overlaps.length > 0) {
    return error(`Clip overlaps existing clip(s) on track ${track.id}: ${overlaps.map((c) => c.id).join(", ")}`);
  }

  const nextTrack: Track = { ...track, clips: [...track.clips, newClip] };
  const nextSeq: Sequence = { ...sequence, tracks: sequence.tracks.map((t) => (t.id === track.id ? nextTrack : t)) };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type MoveClipInput = {
  sequenceId?: string;
  clipId: string;
  toTrackId?: string;
  timelineStartSec?: number;
};

export function moveClip(project: VideoProject, input: MoveClipInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const found = findClip(sequence, input.clipId);
  if (!found) return error(`Clip not found: ${input.clipId}`);
  const { clip, track } = found;

  const targetTrackId = input.toTrackId ?? track.id;
  const targetTrack = findTrack(sequence, targetTrackId);
  if (!targetTrack) return error(`Target track not found: ${targetTrackId}`);
  const locked = lockedTrackError(sequence, [...affectedClipTrackIds(sequence, [clip.id]), targetTrack.id]);
  if (locked) return locked;
  if (!isCompatibleTrack(clip.kind, targetTrack.kind)) {
    return error(`Clip kind "${clip.kind}" is not allowed on ${targetTrack.kind} track.`);
  }

  const newStart = input.timelineStartSec ?? clip.timelineStartSec;
  if (!isValidSeconds(newStart)) return error("timelineStartSec must be a non-negative finite number.");

  const end = newStart + clip.durationSec;
  const overlaps = clipsOverlappingRange(targetTrack, newStart, end, clip.id);
  if (overlaps.length > 0) {
    return error(`Move would overlap clip(s) on track ${targetTrack.id}: ${overlaps.map((c) => c.id).join(", ")}`);
  }

  const clipWithNewTrack: Clip = { ...clip, trackId: targetTrack.id, timelineStartSec: newStart };
  // Remove from old track, add to target track. When source and target are
  // the same track, build the new clip list in one pass to avoid the second
  // map branch overwriting the first.
  const nextSeq: Sequence = {
    ...sequence,
    tracks: sequence.tracks.map((t) => {
      if (t.id === track.id && t.id === targetTrack.id) {
        return { ...t, clips: [...t.clips.filter((c) => c.id !== clip.id), clipWithNewTrack] };
      }
      if (t.id === track.id) {
        return { ...t, clips: t.clips.filter((c) => c.id !== clip.id) };
      }
      if (t.id === targetTrack.id) {
        return { ...t, clips: [...t.clips, clipWithNewTrack] };
      }
      return t;
    }),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type MoveClipGroupInput = {
  sequenceId?: string;
  clipIds: readonly string[];
  anchorClipId: string;
  toTrackId: string;
  timelineStartSec: number;
};

/** Move a Human selection as one atomic edit. Any invalid member or overlap rejects the whole group. */
export function moveClipGroup(project: VideoProject, input: MoveClipGroupInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;
  const ids = [...new Set(input.clipIds)];
  if (ids.length < 2 || !ids.includes(input.anchorClipId)) return error("Group move requires at least two unique clips including the anchor.");
  const orderedTracks = [...sequence.tracks].sort((left, right) => left.order - right.order);
  const anchor = findClip(sequence, input.anchorClipId);
  const targetAnchorTrackIndex = orderedTracks.findIndex((track) => track.id === input.toTrackId);
  const sourceAnchorTrackIndex = anchor ? orderedTracks.findIndex((track) => track.id === anchor.track.id) : -1;
  if (!anchor) return error(`Clip not found: ${input.anchorClipId}`);
  if (targetAnchorTrackIndex < 0) return error(`Target track not found: ${input.toTrackId}`);
  if (!isValidSeconds(input.timelineStartSec)) return error("timelineStartSec must be a non-negative finite number.");
  const locked = lockedTrackError(sequence, affectedClipTrackIds(sequence, ids));
  if (locked) return locked;
  const deltaSec = input.timelineStartSec - anchor.clip.timelineStartSec;
  const deltaTrack = targetAnchorTrackIndex - sourceAnchorTrackIndex;
  const selected = new Set(ids);
  const proposals: Clip[] = [];

  for (const clipId of ids) {
    const found = findClip(sequence, clipId);
    if (!found) return error(`Clip not found: ${clipId}`);
    const sourceTrackIndex = orderedTracks.findIndex((track) => track.id === found.track.id);
    const targetTrack = orderedTracks[sourceTrackIndex + deltaTrack];
    if (!targetTrack) return error("Group move would place a clip outside the available tracks.");
    if (targetTrack.locked) return error(`Track is locked: ${targetTrack.id}`);
    if (targetTrack.hidden) return error(`Track is hidden: ${targetTrack.id}. Show it before editing.`);
    if (!isCompatibleTrack(found.clip.kind, targetTrack.kind)) {
      return error(`Clip kind "${found.clip.kind}" is not allowed on ${targetTrack.kind} track.`);
    }
    const timelineStartSec = found.clip.timelineStartSec + deltaSec;
    if (!isValidSeconds(timelineStartSec)) return error("Group move would place a clip before the timeline start.");
    proposals.push({ ...found.clip, trackId: targetTrack.id, timelineStartSec });
  }

  for (const proposal of proposals) {
    const targetTrack = findTrack(sequence, proposal.trackId)!;
    const externalOverlap = targetTrack.clips.some((clip) =>
      !selected.has(clip.id) && proposal.timelineStartSec < clipTimelineEndSec(clip) && clip.timelineStartSec < clipTimelineEndSec(proposal));
    const selectedOverlap = proposals.some((other) =>
      other.id !== proposal.id && other.trackId === proposal.trackId && proposal.timelineStartSec < clipTimelineEndSec(other) && other.timelineStartSec < clipTimelineEndSec(proposal));
    if (externalOverlap || selectedOverlap) return error("Group move would overlap another clip; nothing was moved.");
  }

  const proposalById = new Map(proposals.map((clip) => [clip.id, clip]));
  const tracks = orderedTracks.map((track) => ({
    ...track,
    clips: [
      ...track.clips.filter((clip) => !selected.has(clip.id)),
      ...proposals.filter((clip) => clip.trackId === track.id),
    ],
  }));
  if (proposalById.size !== selected.size) return error("Group move could not resolve every selected clip.");
  return finishEdit(replaceSequence(project, index, { ...sequence, tracks }));
}

export type TrimClipInput = {
  sequenceId?: string;
  clipId: string;
  /** Final timeline position, allowing a left-edge trim to validate and commit atomically. */
  timelineStartSec?: number;
  sourceInSec?: number;
  sourceOutSec?: number;
  durationSec?: number;
};

export function trimClip(project: VideoProject, input: TrimClipInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const found = findClip(sequence, input.clipId);
  if (!found) return error(`Clip not found: ${input.clipId}`);
  const { clip, track } = found;
  const locked = lockedTrackError(sequence, affectedClipTrackIds(sequence, [clip.id]));
  if (locked) return locked;

  const nextStart = input.timelineStartSec ?? clip.timelineStartSec;
  if (!isValidSeconds(nextStart)) return error("timelineStartSec must be a non-negative finite number.");
  if (input.durationSec !== undefined) {
    if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
      return error("durationSec must be a positive number.");
    }
  }
  const nextDuration = input.durationSec !== undefined ? input.durationSec : clip.durationSec;
  const startDelta = nextStart - clip.timelineStartSec;
  let nextSourceIn = input.sourceInSec ?? clip.sourceInSec;
  let nextSourceOut = input.sourceOutSec ?? clip.sourceOutSec;
  if (input.sourceInSec === undefined && startDelta !== 0 && nextSourceIn !== undefined) {
    nextSourceIn += startDelta;
  }
  if (input.sourceOutSec === undefined && (input.durationSec !== undefined || startDelta !== 0) && nextSourceIn !== undefined) {
    nextSourceOut = nextSourceIn + nextDuration;
  } else if (input.sourceInSec !== undefined && input.sourceOutSec === undefined) {
    nextSourceOut = input.sourceInSec + nextDuration;
  } else if (input.sourceOutSec !== undefined && input.sourceInSec === undefined) {
    nextSourceIn = input.sourceOutSec - nextDuration;
  }
  const measuredDuration = measuredMediaDuration(project, clip.mediaId);
  if (measuredDuration !== undefined && nextSourceIn === undefined && nextSourceOut === undefined) {
    nextSourceIn = startDelta;
    nextSourceOut = startDelta + nextDuration;
  }
  const sourceWindowError = validateSourceWindow(project, clip.mediaId, nextSourceIn, nextSourceOut, nextDuration);
  if (sourceWindowError) return sourceWindowError;

  // Validate the final range once so left-edge trims need no invalid intermediate move.
  const newEnd = nextStart + nextDuration;
  if (newEnd !== clipTimelineEndSec(clip) || nextStart !== clip.timelineStartSec) {
    const overlaps = clipsOverlappingRange(track, nextStart, newEnd, clip.id);
    if (overlaps.length > 0) {
      return error(`Trim would overlap clip(s) on track ${track.id}: ${overlaps.map((c) => c.id).join(", ")}`);
    }
  }

  const nextClip: Clip = {
    ...clip,
    timelineStartSec: nextStart,
    durationSec: nextDuration,
    ...(nextSourceIn !== undefined ? { sourceInSec: nextSourceIn } : clip.sourceInSec !== undefined ? { sourceInSec: clip.sourceInSec } : {}),
    ...(nextSourceOut !== undefined ? { sourceOutSec: nextSourceOut } : clip.sourceOutSec !== undefined ? { sourceOutSec: clip.sourceOutSec } : {}),
  };
  const nextTrack: Track = { ...track, clips: track.clips.map((c) => (c.id === clip.id ? nextClip : c)) };
  const nextSeq: Sequence = { ...sequence, tracks: sequence.tracks.map((t) => (t.id === track.id ? nextTrack : t)) };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type SplitClipInput = {
  sequenceId?: string;
  clipId: string;
  atSec: number;
};

export function splitClip(project: VideoProject, input: SplitClipInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const found = findClip(sequence, input.clipId);
  if (!found) return error(`Clip not found: ${input.clipId}`);
  const { clip, track } = found;
  const affectedTrackIds = affectedClipTrackIds(sequence, [clip.id]);
  const locked = lockedTrackError(sequence, affectedTrackIds);
  if (locked) return locked;

  if (!isValidSeconds(input.atSec)) return error("atSec must be a non-negative finite number.");
  if (input.atSec <= clip.timelineStartSec || input.atSec >= clipTimelineEndSec(clip)) {
    return error("atSec must be strictly inside the clip's timeline range.");
  }

  let normalizedClip = clip;
  const measuredDuration = measuredMediaDuration(project, clip.mediaId);
  if (measuredDuration !== undefined && clip.sourceInSec === undefined && clip.sourceOutSec === undefined) {
    normalizedClip = { ...clip, sourceInSec: 0, sourceOutSec: clip.durationSec };
  }
  const sourceWindowError = validateSourceWindow(
    project,
    normalizedClip.mediaId,
    normalizedClip.sourceInSec,
    normalizedClip.sourceOutSec,
    normalizedClip.durationSec,
  );
  if (sourceWindowError) return sourceWindowError;

  const firstDuration = input.atSec - normalizedClip.timelineStartSec;
  const secondDuration = normalizedClip.durationSec - firstDuration;

  const firstSourceIn = normalizedClip.sourceInSec;
  const firstSourceOut = normalizedClip.sourceInSec !== undefined ? normalizedClip.sourceInSec + firstDuration : undefined;
  const secondSourceIn = firstSourceOut;
  const secondSourceOut = normalizedClip.sourceOutSec;

  const firstId = generateId("clip");
  const secondId = generateId("clip");

  const first: Clip = {
    ...normalizedClip,
    id: firstId,
    durationSec: firstDuration,
    ...(firstSourceIn !== undefined ? { sourceInSec: firstSourceIn } : {}),
    ...(firstSourceOut !== undefined ? { sourceOutSec: firstSourceOut } : {}),
    ...(normalizedClip.linkedClipIds ? { linkedClipIds: [...normalizedClip.linkedClipIds] } : {}),
  };
  const second: Clip = {
    ...normalizedClip,
    id: secondId,
    timelineStartSec: input.atSec,
    durationSec: secondDuration,
    ...(secondSourceIn !== undefined ? { sourceInSec: secondSourceIn } : {}),
    ...(secondSourceOut !== undefined ? { sourceOutSec: secondSourceOut } : {}),
    ...(normalizedClip.linkedClipIds ? { linkedClipIds: [...normalizedClip.linkedClipIds] } : {}),
  };

  const synchronizedLinked = (normalizedClip.linkedClipIds ?? [])
    .map((id) => findClip(sequence, id)?.clip)
    .filter((candidate): candidate is Clip => candidate !== undefined
      && candidate.timelineStartSec === normalizedClip.timelineStartSec
      && candidate.durationSec === normalizedClip.durationSec);
  const linkedSplits = new Map<string, readonly [Clip, Clip]>();
  for (const linked of synchronizedLinked) {
    let normalizedLinked = linked;
    if (measuredMediaDuration(project, linked.mediaId) !== undefined && linked.sourceInSec === undefined && linked.sourceOutSec === undefined) {
      normalizedLinked = { ...linked, sourceInSec: 0, sourceOutSec: linked.durationSec };
    }
    const linkedWindowError = validateSourceWindow(
      project, normalizedLinked.mediaId, normalizedLinked.sourceInSec, normalizedLinked.sourceOutSec, normalizedLinked.durationSec,
    );
    if (linkedWindowError) return linkedWindowError;
    const linkedFirstId = generateId("clip");
    const linkedSecondId = generateId("clip");
    const linkedCutSource = normalizedLinked.sourceInSec !== undefined ? normalizedLinked.sourceInSec + firstDuration : undefined;
    linkedSplits.set(linked.id, [{
      ...normalizedLinked,
      id: linkedFirstId,
      durationSec: firstDuration,
      ...(linkedCutSource !== undefined ? { sourceOutSec: linkedCutSource } : {}),
      linkedClipIds: [firstId],
    }, {
      ...normalizedLinked,
      id: linkedSecondId,
      timelineStartSec: input.atSec,
      durationSec: secondDuration,
      ...(linkedCutSource !== undefined ? { sourceInSec: linkedCutSource } : {}),
      linkedClipIds: [secondId],
    }]);
  }
  const splitIds = new Map<string, readonly [string, string]>([
    [normalizedClip.id, [firstId, secondId]],
    ...[...linkedSplits].map(([id, [linkedFirst, linkedSecond]]) => [id, [linkedFirst.id, linkedSecond.id]] as const),
  ]);
  const correspondingLinks = (original: Clip, halfIndex: 0 | 1): string[] => Array.from(new Set(
    (original.linkedClipIds ?? []).flatMap((id) => splitIds.get(id)?.[halfIndex] ?? [id]),
  ));
  first.linkedClipIds = correspondingLinks(normalizedClip, 0);
  second.linkedClipIds = correspondingLinks(normalizedClip, 1);
  for (const [originalId, halves] of linkedSplits) {
    const original = findClip(sequence, originalId)!.clip;
    halves[0].linkedClipIds = correspondingLinks(original, 0);
    halves[1].linkedClipIds = correspondingLinks(original, 1);
  }

  const nextTrack: Track = {
    ...track,
    clips: track.clips.flatMap((c) => (c.id === clip.id ? [first, second] : [c])),
  };
  const nextSeq: Sequence = {
    ...sequence,
    tracks: sequence.tracks.map((t) => ({
      ...(t.id === track.id ? nextTrack : t),
      clips: (t.id === track.id ? nextTrack : t).clips.flatMap((candidate) => {
        const synchronizedSplit = linkedSplits.get(candidate.id);
        if (synchronizedSplit) return [...synchronizedSplit];
        return [candidate.id !== firstId && candidate.id !== secondId && candidate.linkedClipIds?.some((id) => splitIds.has(id))
          ? { ...candidate, linkedClipIds: Array.from(new Set(candidate.linkedClipIds.flatMap((id) => splitIds.get(id) ?? [id]))) }
          : candidate];
      }),
    })),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type DeleteClipInput = {
  sequenceId?: string;
  clipId: string;
  /** Also delete linked clips. Defaults to true. */
  unlinkLinked?: boolean;
};

export function deleteClip(project: VideoProject, input: DeleteClipInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const found = findClip(sequence, input.clipId);
  if (!found) return error(`Clip not found: ${input.clipId}`);
  const { clip } = found;

  const directProtection = lockedTrackError(sequence, [found.track.id]);
  if (directProtection) return directProtection;

  const unlinkLinked = input.unlinkLinked !== false;
  const idsToDelete = new Set<string>([clip.id]);
  if (unlinkLinked) {
    for (const linkedId of clip.linkedClipIds ?? []) {
      const peer = findClip(sequence, linkedId);
      if (peer && !peer.track.hidden) idsToDelete.add(linkedId);
    }
  }
  const locked = lockedTrackError(sequence, [...affectedClipTrackIds(sequence, idsToDelete)].filter((id) => !findTrack(sequence, id)?.hidden));
  if (locked) return locked;

  const nextSeq: Sequence = {
    ...sequence,
    tracks: sequence.tracks.map((t) => ({
      ...t,
      clips: t.clips
        .filter((c) => !idsToDelete.has(c.id))
        .map((c) => c.linkedClipIds?.some((id) => idsToDelete.has(id))
          ? { ...c, linkedClipIds: c.linkedClipIds.filter((id) => !idsToDelete.has(id)) }
          : c),
    })),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type LinkClipsInput = {
  sequenceId?: string;
  clipIds: string[];
};

export function linkClips(project: VideoProject, input: LinkClipsInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  if (!Array.isArray(input.clipIds) || input.clipIds.length < 2) {
    return error("linkClips requires at least two clip ids.");
  }
  const uniqueIds = Array.from(new Set(input.clipIds));
  for (const id of uniqueIds) {
    if (!findClip(sequence, id)) return error(`Clip not found: ${id}`);
  }
  const locked = lockedTrackError(sequence, affectedClipTrackIds(sequence, uniqueIds));
  if (locked) return locked;

  const nextSeq: Sequence = {
    ...sequence,
    tracks: sequence.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (!uniqueIds.includes(c.id)) {
          // Adding links among selected clips must not break existing links
          // to other clips (or leave only one direction of such a link).
          return c;
        }
        const others = uniqueIds.filter((lid) => lid !== c.id);
        const existing = c.linkedClipIds ?? [];
        const merged = Array.from(new Set([...others, ...existing])).filter((lid) => uniqueIds.includes(lid) || existing.includes(lid));
        return { ...c, linkedClipIds: merged };
      }),
    })),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export function unlinkClips(project: VideoProject, input: LinkClipsInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  if (!Array.isArray(input.clipIds) || input.clipIds.length < 2) {
    return error("unlinkClips requires at least two clip ids.");
  }
  const uniqueIds = new Set(input.clipIds);
  const locked = lockedTrackError(sequence, affectedClipTrackIds(sequence, uniqueIds));
  if (locked) return locked;

  const nextSeq: Sequence = {
    ...sequence,
    tracks: sequence.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (!uniqueIds.has(c.id)) return c;
        if (!c.linkedClipIds || c.linkedClipIds.length === 0) return c;
        const filtered = c.linkedClipIds.filter((lid) => !uniqueIds.has(lid));
        if (filtered.length === c.linkedClipIds.length) return c;
        return { ...c, linkedClipIds: filtered };
      }),
    })),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type DetachAudioInput = {
  sequenceId?: string;
  clipId: string;
  toTrackId?: string;
};

export function detachAudio(project: VideoProject, input: DetachAudioInput): CommandResult<VideoProject> {
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const found = findClip(sequence, input.clipId);
  if (!found) return error(`Clip not found: ${input.clipId}`);
  const { clip, track } = found;

  if (clip.kind !== "video") return error("detachAudio requires a video clip.");
  if (clipTransition(clip) || track.clips.some((other) => clipTransition(other)?.fromClipId === clip.id)) return error("Remove the adjoining transition before separating audio so its sound blend is not silently changed.");
  if (!clip.mediaId) return error("detachAudio requires the video clip to reference a media asset.");
  if (sequence.tracks.some((candidate) => candidate.clips.some((peer) =>
    peer.kind === "audio" && peer.mediaId === clip.mediaId && clip.linkedClipIds?.includes(peer.id),
  ))) return error("Audio is already separated from this clip.");

  // A normal separation lands immediately above the video. Explicit tool
  // destinations remain supported, with the same collision/lock validation.
  let workingSequence = sequence;
  let targetTrack: Track | undefined;
  if (input.toTrackId) {
    targetTrack = findTrack(sequence, input.toTrackId);
    if (!targetTrack) return error(`Target track not found: ${input.toTrackId}`);
  } else {
    const ordered = [...sequence.tracks].sort((a, b) => a.order - b.order);
    const above = ordered[ordered.findIndex((candidate) => candidate.id === track.id) - 1];
    if (above && (above.kind === "audio" || above.kind === "music") && !above.locked && !above.hidden
      && clipsOverlappingRange(above, clip.timelineStartSec, clipTimelineEndSec(clip)).length === 0) {
      targetTrack = above;
    } else {
      const trackId = generateId("track-audio");
      const added = addTrack(project, { sequenceId: sequence.id, kind: "audio", id: trackId, beforeTrackId: track.id });
      if (!added.ok) return added;
      const addedSequence = added.project.sequences[index]!;
      workingSequence = { ...addedSequence, tracks: addedSequence.tracks.map((candidate) => candidate.id === trackId ? { ...candidate, name: `${track.name ?? "Video"} audio` } : candidate) };
      targetTrack = workingSequence.tracks.find((candidate) => candidate.id === trackId);
    }
  }
  if (!targetTrack) return error("No audio track available for detachAudio.");
  const locked = lockedTrackError(sequence, [...affectedClipTrackIds(sequence, [clip.id]), targetTrack.id]);
  if (locked) return locked;
  if (!isCompatibleTrack("audio", targetTrack.kind)) {
    return error(`Audio clip is not allowed on ${targetTrack.kind} track.`);
  }

  const audioClipId = generateId("clip");
  const audioClip: Clip = {
    kind: "audio",
    id: audioClipId,
    trackId: targetTrack.id,
    timelineStartSec: clip.timelineStartSec,
    durationSec: clip.durationSec,
    mediaId: clip.mediaId,
    ...(clip.sourceInSec !== undefined ? { sourceInSec: clip.sourceInSec } : {}),
    ...(clip.sourceOutSec !== undefined ? { sourceOutSec: clip.sourceOutSec } : {}),
    linkedClipIds: [clip.id],
    props: {
      ...(typeof clip.props["volume"] === "number" ? { volume: clip.props["volume"] } : {}),
      ...(typeof clip.props["muted"] === "boolean" ? { muted: clip.props["muted"] } : {}),
      ...(Object.keys(clipFades(clip)).some((key) => key.startsWith("audio")) ? { fades: Object.fromEntries(Object.entries(clipFades(clip)).filter(([key]) => key.startsWith("audio"))) } : {}),
    },
  };

  const overlaps = clipsOverlappingRange(targetTrack, audioClip.timelineStartSec, clipTimelineEndSec(audioClip));
  if (overlaps.length > 0) {
    return error(`Detach would overlap clip(s) on track ${targetTrack.id}: ${overlaps.map((c) => c.id).join(", ")}`);
  }

  const videoWithLink: Clip = {
    ...clip,
    props: { ...clip.props, muted: true },
    linkedClipIds: Array.from(new Set([audioClipId, ...(clip.linkedClipIds ?? [])])),
  };

  const nextSeq: Sequence = {
    ...workingSequence,
    tracks: workingSequence.tracks.map((t) => {
      if (t.id === track.id) {
        return { ...t, clips: t.clips.map((c) => (c.id === clip.id ? videoWithLink : c)) };
      }
      if (t.id === targetTrack.id) {
        return { ...t, clips: [...t.clips, audioClip] };
      }
      return t;
    }),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

export type UpdateClipPropsInput = {
  sequenceId?: string;
  clipId: string;
  /** Partial props to merge into the clip's `props`. Top-level keys overwrite. */
  props: Record<string, unknown>;
};

/**
 * Update a clip's free-form `props` by merging the provided partial props.
 * Used by the agent-tool `replaceCaptionText` handler (and any future
 * prop-patching handler). Does NOT change kind, track, timing, or links.
 *
 * ADD-ONLY: this is a new export; existing commands are untouched.
 */
export function updateClipProps(
  project: VideoProject,
  input: UpdateClipPropsInput,
): CommandResult<VideoProject> {
  if (!input.props || typeof input.props !== "object" || Array.isArray(input.props)) {
    return error("props must be an object.");
  }
  const seqRes = assertSequence(project, input.sequenceId);
  if (!seqRes.ok) return seqRes;
  const { sequence, index } = seqRes;

  const found = findClip(sequence, input.clipId);
  if (!found) return error(`Clip not found: ${input.clipId}`);
  const { clip, track } = found;
  const locked = lockedTrackError(sequence, affectedClipTrackIds(sequence, [clip.id]));
  if (locked) return locked;

  const nextProps = { ...clip.props, ...input.props };
  if (nextProps["fades"] !== undefined && (!validFades(nextProps["fades"]) || Object.keys(nextProps["fades"]).some((key) => !fadeSupported(clip, key as FadeKey)))) return error("Invalid clip fades.");
  const nextClip: Clip = { ...clip, props: nextProps };
  const nextTrack: Track = {
    ...track,
    clips: track.clips.map((c) => (c.id === clip.id ? nextClip : c)),
  };
  const nextSeq: Sequence = {
    ...sequence,
    tracks: sequence.tracks.map((t) => (t.id === track.id ? nextTrack : t)),
  };
  const nextProject = replaceSequence(project, index, nextSeq);
  return finishEdit(nextProject);
}

/** One atomic human/agent command; zero duration removes just this effect. */
export function setClipFade(project: VideoProject, input: FadeEdit): CommandResult<VideoProject> {
  if (!FADE_KEYS.includes(input.key)) return error("Unknown fade type.");
  const result = assertSequence(project);
  if (!result.ok) return result;
  const { sequence, index } = result;
  const found = findClip(sequence, input.clipId);
  if (!found || !fadeSupported(found.clip, input.key)) return error("Select a video or audio clip that supports this fade.");
  if (!Number.isFinite(input.durationSec) || input.durationSec < 0) return error("Fade duration must be a finite, non-negative number.");
  const targets: Array<{ clip: Clip; key: FadeKey }> = [{ clip: found.clip, key: input.key }];
  if (input.linkedAudio && input.key.startsWith("video")) {
    const key = input.key === "videoIn" ? "audioIn" : "audioOut";
    targets.push({ clip: found.clip, key });
    for (const track of sequence.tracks) for (const clip of track.clips) {
      if (clip.kind === "audio" && (found.clip.linkedClipIds?.includes(clip.id) || clip.linkedClipIds?.includes(found.clip.id))) targets.push({ clip, key });
    }
  }
  const protectedTrack = targets.some(({ clip }) => { const track = findTrack(sequence, clip.trackId); return !track || track.locked || track.hidden; });
  if (protectedTrack) return error("A target track is hidden or locked. Show/unlock it, or turn off linked audio.");
  if (targets.some(({ clip }) => input.durationSec > clip.durationSec)) return error("Fade duration exceeds a target clip. Choose a shorter fade.");
  const patches = new Map<string, Clip>();
  for (const target of targets) {
    const clip = patches.get(target.clip.id) ?? target.clip;
    const fades = { ...clipFades(clip) };
    if (input.durationSec === 0) delete fades[target.key];
    else fades[target.key] = { startSec: (clip.sourceInSec ?? 0) + (target.key.endsWith("In") ? 0 : clip.durationSec - input.durationSec), durationSec: input.durationSec };
    const props = { ...clip.props };
    if (Object.keys(fades).length) props["fades"] = fades;
    else delete props["fades"];
    patches.set(clip.id, { ...clip, props });
  }
  const next = { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => patches.get(clip.id) ?? clip) })) };
  return finishEdit(replaceSequence(project, index, next));
}

// Re-export a few helpers/tests use.
export {
  COMPATIBLE_TRACK_BY_CLIP_KIND,
  createEmptyProject,
  detectTrackTimingViolations,
  EDL_VERSION,
  isCompatibleTrack,
};
