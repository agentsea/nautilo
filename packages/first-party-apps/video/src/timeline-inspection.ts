import { type Clip, type Track, type VideoProject } from "./edl";
import { computeSequenceDurationSec } from "./timing";
import { transitionTarget } from "./transitions";

export function inspectClip(clip: Clip) {
  const supported = ["text", "muted", "volume", "fades", "transition"];
  return {
    id: clip.id, kind: clip.kind, trackId: clip.trackId,
    timelineStartSec: clip.timelineStartSec, durationSec: clip.durationSec,
    mediaId: clip.mediaId ?? null, sourceInSec: clip.sourceInSec ?? null, sourceOutSec: clip.sourceOutSec ?? null,
    linkedClipIds: [...clip.linkedClipIds ?? []],
    props: Object.fromEntries(Object.entries(clip.props).filter(([key]) => supported.includes(key))),
    unsupportedPropertyNames: Object.keys(clip.props).filter((key) => !supported.includes(key)),
  };
}

function inspectTrack(track: Track) {
  return { id: track.id, kind: track.kind, name: track.name ?? track.kind, order: track.order, clipCount: track.clips.length, hidden: !!track.hidden, muted: !!track.muted, locked: !!track.locked };
}

/** Complete scoped metadata, not media bytes, host paths, or preview leases. */
export function inspectProject(project: VideoProject, includeClips: boolean) {
  const sequence = project.sequences[0]!;
  const tracks = [...sequence.tracks].sort((a, b) => a.order - b.order);
  const allClips = tracks.flatMap((track) => track.clips);
  return {
    sequenceId: sequence.id, frameRate: sequence.frameRate,
    durationSec: computeSequenceDurationSec(sequence),
    trackCount: sequence.tracks.length, clipCount: allClips.length, mediaCount: project.media.length,
    scope: { sequenceId: sequence.id, totalSequences: project.sequences.length, clipsIncluded: includeClips, omittedClipCount: includeClips ? 0 : allClips.length },
    tracks: tracks.map(inspectTrack),
    media: project.media.map((asset) => ({ id: asset.id, kind: asset.kind, label: asset.label ?? asset.id, durationSec: asset.durationSec ?? null, lifecycle: asset.lifecycle ?? null })),
    ...(includeClips ? { clips: allClips.map((clip) => ({ ...inspectClip(clip), ...(clip.kind === "video" ? { transition: (() => {
      const target = transitionTarget(project, clip.id);
      return "error" in target ? { available: false, reason: target.error } : { available: target.maxDurationSec > 0, outgoingClipId: target.outgoing.id, maxDurationSec: target.maxDurationSec };
    })() } : {}) })) } : {}),
  };
}

export function summarizeTimelineEdit(before: VideoProject, after: VideoProject) {
  const beforeTracks = before.sequences[0]!.tracks;
  const afterTracks = after.sequences[0]!.tracks;
  const beforeClips = beforeTracks.flatMap((track) => track.clips);
  const afterClips = afterTracks.flatMap((track) => track.clips);
  const changed = <T extends { id: string }, R>(old: T[], next: T[], inspect: (value: T) => R) => {
    const oldMap = new Map(old.map((item) => [item.id, item]));
    const nextMap = new Map(next.map((item) => [item.id, item]));
    const ids = new Set([...oldMap.keys(), ...nextMap.keys()]);
    return [...ids].flatMap((id) => {
      const prev = oldMap.get(id); const after = nextMap.get(id);
      return JSON.stringify(prev) === JSON.stringify(after) ? [] : [{ id, before: prev ? inspect(prev) : null, after: after ? inspect(after) : null }];
    });
  };
  const tracks = changed(beforeTracks, afterTracks, inspectTrack);
  return {
    beforeDurationSec: computeSequenceDurationSec(before.sequences[0]!), afterDurationSec: computeSequenceDurationSec(after.sequences[0]!),
    changedTrackIds: tracks.map((track) => track.id), tracks,
    clips: changed(beforeClips, afterClips, inspectClip),
    protectedTracks: before.sequences[0]!.tracks.filter((track) => track.hidden || track.locked).map((track) => ({ id: track.id, name: track.name ?? track.kind, hidden: !!track.hidden, locked: !!track.locked })),
  };
}
