import { expect, test } from "bun:test";
import { copyTimelineSelection, removeTimelineSelection, pasteTimelineClipboard, type TimelineClipboard } from "./commands";
import { createEmptyProject, type VideoProject } from "./edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";
import { VideoProjectHistory } from "./project-history";

function fixture(): VideoProject {
  const project = createEmptyProject();
  project.media = [{ id: "source", kind: "video", ref: "media/source.mp4", durationSec: 20 }];
  project.sequences[0]!.durationSec = 10;
  project.sequences[0]!.tracks = [
    { id: "audio", kind: "audio", order: 0, name: "Voice", clips: [{ id: "a", kind: "audio", trackId: "audio", mediaId: "source", timelineStartSec: 0, durationSec: 10, sourceInSec: 5, sourceOutSec: 15, linkedClipIds: ["v"], props: {} }] },
    { id: "video", kind: "video", order: 1, name: "Picture", clips: [{ id: "v", kind: "video", trackId: "video", mediaId: "source", timelineStartSec: 0, durationSec: 10, sourceInSec: 5, sourceOutSec: 15, linkedClipIds: ["a"], props: { muted: true } }] },
  ];
  return project;
}
const range = { range: { inSec: 2, outSec: 4 }, clipIds: ["v"] };
function copy(project: VideoProject, selection = range): TimelineClipboard {
  const result = copyTimelineSelection(project, selection);
  if (!result.ok) throw new Error(result.error);
  return result.clipboard;
}
function remove(project: VideoProject): VideoProject {
  const result = removeTimelineSelection(project, range);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test("range copy is non-mutating and cuts source windows rather than whole selected clips", () => {
  const project = fixture(); const before = structuredClone(project);
  const clipboard = copy(project);
  expect(project).toEqual(before);
  expect(clipboard.durationSec).toBe(2);
  expect(clipboard.clips.map((clip) => [clip.timelineStartSec, clip.durationSec, clip.sourceInSec, clip.sourceOutSec])).toEqual([[0, 2, 7, 9], [0, 2, 7, 9]]);
  clipboard.clips[0]!.props["volume"] = 0;
  expect(project).toEqual(before);
});

test("cut leaves synchronized linked left/right fragments and paste restores the gap with fresh linked IDs", () => {
  const project = fixture(); const clipboard = copy(project); const cut = remove(project);
  for (const track of cut.sequences[0]!.tracks) {
    expect(track.clips.map((clip) => [clip.timelineStartSec, clip.durationSec, clip.sourceInSec, clip.sourceOutSec])).toEqual([[0, 2, 5, 7], [4, 6, 9, 15]]);
  }
  expect(cut.sequences[0]!.tracks[0]!.clips[0]!.linkedClipIds).toEqual([cut.sequences[0]!.tracks[1]!.clips[0]!.id]);
  expect(cut.sequences[0]!.tracks[0]!.clips[1]!.linkedClipIds).toEqual([cut.sequences[0]!.tracks[1]!.clips[1]!.id]);
  const pasted = pasteTimelineClipboard(cut, clipboard, 2);
  expect(pasted.ok).toBe(true); if (!pasted.ok) return;
  const [audio, video] = pasted.project.sequences[0]!.tracks.map((track) => track.clips[1]!);
  expect(audio!.id).not.toBe("a"); expect(video!.id).not.toBe("v");
  expect(audio!.linkedClipIds).toEqual([video!.id]); expect(video!.linkedClipIds).toEqual([audio!.id]);
  expect(video!.props["muted"]).toBe(true);
  expect(pasted.project.media).toEqual(project.media);
  const saved = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), pasted.project));
  expect(saved.ok).toBe(true);
});

test("clip selection includes linked peers and repeated paste keeps offsets without duplicating assets", () => {
  const project = fixture();
  const result = copyTimelineSelection(project, { clipIds: ["v"] }); expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.clipboard.clips.length).toBe(2);
  const first = pasteTimelineClipboard(project, result.clipboard, 10); expect(first.ok).toBe(true); if (!first.ok) return;
  const second = pasteTimelineClipboard(first.project, result.clipboard, 20); expect(second.ok).toBe(true); if (!second.ok) return;
  expect(second.project.media.length).toBe(1);
  expect(second.project.sequences[0]!.durationSec).toBe(30);
  expect(new Set(second.project.sequences[0]!.tracks.flatMap((track) => track.clips.map((clip) => clip.id))).size).toBe(6);
});

test("locked independent tracks are excluded but locked linked peers refuse destructive edits", () => {
  const project = fixture(); project.sequences[0]!.tracks[0]!.locked = true;
  expect(copy(project).clips.map((clip) => clip.id)).toEqual(["v"]);
  expect(copy(project).clips[0]!.linkedClipIds).toEqual([]);
  const before = structuredClone(project);
  expect(removeTimelineSelection(project, range).ok).toBe(false);
  expect(project).toEqual(before);
  for (const track of project.sequences[0]!.tracks) track.clips[0]!.linkedClipIds = [];
  const result = removeTimelineSelection(project, range); expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.project.sequences[0]!.tracks[0]).toEqual(project.sequences[0]!.tracks[0]);
  expect(result.project.sequences[0]!.tracks[1]!.clips.length).toBe(2);
});

test("hidden linked tracks are excluded from cut/copy/delete without blocking the visible selection", () => {
  const project = fixture();
  const clipboard = copy(project);
  project.sequences[0]!.tracks[0]!.hidden = true;
  const before = structuredClone(project);
  expect(copy(project).clips.map((clip) => clip.id)).toEqual(["v"]);
  const cut = removeTimelineSelection(project, range);
  expect(cut.ok).toBe(true); if (!cut.ok) return;
  const hidden = cut.project.sequences[0]!.tracks[0]!.clips[0]!;
  expect({ ...hidden, linkedClipIds: [] }).toEqual({ ...before.sequences[0]!.tracks[0]!.clips[0]!, linkedClipIds: [] });
  expect(cut.project.sequences[0]!.tracks[1]!.clips.map((clip) => [clip.timelineStartSec, clip.durationSec])).toEqual([[0, 2], [4, 6]]);
  expect(hidden.linkedClipIds).toEqual(cut.project.sequences[0]!.tracks[1]!.clips.map((clip) => clip.id));
  expect(copyTimelineSelection(project, { clipIds: ["a", "v"] })).toMatchObject({ ok: true, clipboard: { clips: [{ id: "v", linkedClipIds: [] }] } });
  const deleted = removeTimelineSelection(project, { clipIds: ["a", "v"] });
  expect(deleted.ok).toBe(true); if (!deleted.ok) return;
  expect(deleted.project.sequences[0]!.tracks[1]!.clips).toEqual([]);
  expect(deleted.project.sequences[0]!.tracks[0]!.clips).toEqual([{ ...before.sequences[0]!.tracks[0]!.clips[0]!, linkedClipIds: [] }]);
  const history = new VideoProjectHistory(); history.record(project, cut.project);
  const undone = history.undo(cut.project);
  expect(undone.ok && undone.project.sequences).toEqual(project.sequences);
  expect(parseVideoHtml(serializeVideoHtml(createDefaultManifest(), cut.project)).ok).toBe(true);
  expect(pasteTimelineClipboard(project, clipboard, 10).ok).toBe(false);
  expect(removeTimelineSelection(project, { clipIds: ["a"] }).ok).toBe(false);
  expect(project).toEqual(before);
  for (const track of project.sequences[0]!.tracks) track.clips[0]!.linkedClipIds = [];
  const result = removeTimelineSelection(project, range);
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.project.sequences[0]!.tracks[0]).toEqual(project.sequences[0]!.tracks[0]);
  expect(result.project.sequences[0]!.tracks[1]!.clips.length).toBe(2);
});

test("paste collision, removed or locked lanes, missing or rebound media and changed rate refuse atomically", () => {
  const project = fixture(); const clipboard = copy(project);
  const variants: Array<[VideoProject, number]> = [[project, 1]];
  const locked = fixture(); locked.sequences[0]!.tracks[0]!.locked = true; variants.push([locked, 10]);
  const missingTrack = fixture(); missingTrack.sequences[0]!.tracks.pop(); variants.push([missingTrack, 10]);
  const missingMedia = fixture(); missingMedia.media = []; variants.push([missingMedia, 10]);
  const changedMedia = fixture(); changedMedia.media[0]!.ref = "other.mp4"; variants.push([changedMedia, 10]);
  const changedRate = fixture(); changedRate.sequences[0]!.frameRate.numerator = 60; variants.push([changedRate, 10]);
  for (const [target, at] of variants) { const before = structuredClone(target); expect(pasteTimelineClipboard(target, clipboard, at).ok).toBe(false); expect(target).toEqual(before); }
});

test("empty, invalid and locked-only selections do not cut nothing", () => {
  const project = fixture();
  for (const selection of [{ clipIds: [] }, { clipIds: ["missing"] }, { clipIds: [], range: { inSec: 11, outSec: 12 } }, { clipIds: [], range: { inSec: NaN, outSec: 12 } }]) {
    expect(copyTimelineSelection(project, selection).ok).toBe(false);
    expect(removeTimelineSelection(project, selection).ok).toBe(false);
  }
  project.sequences[0]!.tracks.forEach((track) => { track.locked = true; });
  expect(copyTimelineSelection(project, range).ok).toBe(false);
});

test("rational frame boundaries preserve fractional source offsets and gaps inside the clipboard", () => {
  const project = fixture(); project.sequences[0]!.frameRate = { numerator: 30000, denominator: 1001 };
  const selection = { range: { inSec: 1.234, outSec: 3.456 }, clipIds: [] };
  const clipboard = copyTimelineSelection(project, selection); expect(clipboard.ok).toBe(true); if (!clipboard.ok) return;
  expect(clipboard.clipboard.clips[0]!.sourceInSec).toBeCloseTo(5 + Math.round(1.234 * 30000 / 1001) * 1001 / 30000);
  const deleted = removeTimelineSelection(project, selection); expect(deleted.ok).toBe(true); if (!deleted.ok) return;
  const result = pasteTimelineClipboard(deleted.project, clipboard.clipboard, 1.234);
  expect(result).toMatchObject({ ok: true });
});

test("each cut and paste is one human Undo step; copy does not enter history", () => {
  const project = fixture(); const clipboard = copy(project); const cut = remove(project);
  const history = new VideoProjectHistory(); history.record(project, cut);
  const pasted = pasteTimelineClipboard(cut, clipboard, 10); expect(pasted.ok).toBe(true); if (!pasted.ok) return;
  history.record(cut, pasted.project);
  const undoPaste = history.undo(pasted.project); expect(undoPaste.ok).toBe(true); if (!undoPaste.ok) return;
  expect(undoPaste.project.sequences).toEqual(cut.sequences);
  const undoCut = history.undo(undoPaste.project); expect(undoCut.ok).toBe(true); if (!undoCut.ok) return;
  expect(undoCut.project.sequences).toEqual(project.sequences);
});

test("range clipboard preserves leading and internal gaps plus disjoint later human or Genie work", () => {
  const project = fixture();
  const clips = project.sequences[0]!.tracks.map((track) => track.clips[0]!);
  for (const clip of clips) { clip.timelineStartSec = 3; clip.durationSec = 2; clip.sourceOutSec = 7; clip.linkedClipIds = []; }
  clips[1]!.timelineStartSec = 7;
  const selected = { range: { inSec: 2, outSec: 10 }, clipIds: [] };
  const copied = copyTimelineSelection(project, selected); expect(copied.ok).toBe(true); if (!copied.ok) return;
  expect(copied.clipboard.durationSec).toBe(8);
  expect(copied.clipboard.clips.map((clip) => clip.timelineStartSec)).toEqual([1, 5]);
  const cut = removeTimelineSelection(project, selected); expect(cut.ok).toBe(true); if (!cut.ok) return;
  const history = new VideoProjectHistory(); history.record(project, cut.project);
  const concurrent = structuredClone(cut.project);
  concurrent.sequences[0]!.tracks[0]!.name = "Later track label";
  const pasted = pasteTimelineClipboard(concurrent, copied.clipboard, 10); expect(pasted.ok).toBe(true); if (!pasted.ok) return;
  expect(pasted.project.sequences[0]!.tracks.map((track) => track.clips[0]!.timelineStartSec)).toEqual([11, 15]);
  history.record(concurrent, pasted.project);
  const undoPaste = history.undo(pasted.project); expect(undoPaste.ok).toBe(true); if (!undoPaste.ok) return;
  const undoCut = history.undo(undoPaste.project); expect(undoCut.ok).toBe(true); if (!undoCut.ok) return;
  expect(undoCut.project.sequences[0]!.tracks[0]!.name).toBe("Later track label");
  expect(undoCut.project.sequences[0]!.tracks.map((track) => track.clips)).toEqual(project.sequences[0]!.tracks.map((track) => track.clips));
});
