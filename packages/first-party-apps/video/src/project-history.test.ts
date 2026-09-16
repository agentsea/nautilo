import { describe, expect, test } from "bun:test";
import { createEmptyProject, type VideoProject } from "./edl";
import { mergeVideoProjects, VideoProjectHistory } from "./project-history";
import { createStarterGenerationBrief, moveGenerationDirectionBlock, updateGenerationDirectionBlock } from "./generation-brief";

function project(): VideoProject {
  const value = createEmptyProject();
  value.metadata = { title: "Base" };
  return value;
}

describe("VideoProjectHistory", () => {
  test("undoes a human clip edit over a disjoint external title edit", () => {
    const before = project();
    const after = structuredClone(before);
    after.sequences[0]!.tracks[0]!.clips.push({
      id: "clip-human",
      trackId: "track-video",
      kind: "video",
      timelineStartSec: 0,
      durationSec: 2,
      props: {},
    });
    after.sequences[0]!.durationSec = 2;
    const current = structuredClone(after);
    current.metadata!.title = "External title";

    const history = new VideoProjectHistory();
    history.record(before, after);
    const undone = history.undo(current);

    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.project.metadata?.title).toBe("External title");
    expect(undone.project.sequences[0]!.tracks[0]!.clips).toEqual([]);
    expect(history.getState()).toEqual({ canUndo: false, canRedo: true });
  });

  test("fences a same-target undo and leaves the entry available", () => {
    const before = project();
    const after = structuredClone(before);
    after.metadata!.title = "Human title";
    const current = structuredClone(after);
    current.metadata!.title = "External title";
    const history = new VideoProjectHistory();
    history.record(before, after);

    const result = history.undo(current);

    expect(result).toEqual({
      ok: false,
      direction: "undo",
      reason: "The project title changed elsewhere. Nothing was overwritten.",
    });
    expect(history.getState()).toEqual({ canUndo: true, canRedo: false });
  });

  test("redo reapplies only the human delta over later disjoint work", () => {
    const before = project();
    const after = structuredClone(before);
    after.metadata!.title = "Human title";
    const history = new VideoProjectHistory();
    history.record(before, after);
    const undone = history.undo(after);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    const current = structuredClone(undone.project);
    current.sequences[0]!.markers = [{ id: "external-marker", timeSec: 0 }];

    const redone = history.redo(current);

    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.project.metadata?.title).toBe("Human title");
    expect(redone.project.sequences[0]!.markers).toEqual([{ id: "external-marker", timeSec: 0 }]);
  });

  test("merges two actors editing different clips and fences the same clip", () => {
    const base = project();
    const first = base.sequences[0]!.tracks[0]!;
    first.clips.push({ id: "a", trackId: first.id, kind: "video", timelineStartSec: 0, durationSec: 2, props: {} });
    first.clips.push({ id: "b", trackId: first.id, kind: "video", timelineStartSec: 2, durationSec: 2, props: {} });
    base.sequences[0]!.durationSec = 4;
    const human = structuredClone(base);
    human.sequences[0]!.tracks[0]!.clips[0]!.timelineStartSec = 1;
    const external = structuredClone(base);
    external.sequences[0]!.tracks[0]!.clips[1]!.timelineStartSec = 5;

    const merged = mergeVideoProjects(base, human, external);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.project.sequences[0]!.tracks[0]!.clips.map((clip) => clip.timelineStartSec)).toEqual([1, 5]);

    external.sequences[0]!.tracks[0]!.clips[0]!.timelineStartSec = 3;
    expect(mergeVideoProjects(base, human, external)).toEqual({
      ok: false,
      reason: "This clip's position or timing changed elsewhere. Nothing was overwritten.",
    });
  });

  test("refuses to replay a delta inside a track that is now locked", () => {
    const base = project();
    const human = structuredClone(base);
    human.sequences[0]!.tracks[0]!.clips.push({
      id: "human-clip",
      trackId: "track-video",
      kind: "video",
      timelineStartSec: 0,
      durationSec: 1,
      props: {},
    });
    human.sequences[0]!.durationSec = 1;
    const external = structuredClone(base);
    external.sequences[0]!.tracks[0]!.locked = true;

    expect(mergeVideoProjects(base, human, external)).toEqual({
      ok: false,
      reason: "Unlock track track-video before undoing an edit to its contents.",
    });
  });

  test("allows undoing the human's own standalone lock action", () => {
    const before = project();
    const after = structuredClone(before);
    after.sequences[0]!.tracks[0]!.locked = true;
    const history = new VideoProjectHistory();
    history.record(before, after);

    const result = history.undo(after);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.sequences[0]!.tracks[0]!.locked).toBeUndefined();
  });

  test("fences disjoint field edits whose combined result overlaps clips", () => {
    const base = project();
    const track = base.sequences[0]!.tracks[0]!;
    track.clips = [
      { id: "a", trackId: track.id, kind: "video", timelineStartSec: 0, durationSec: 2, props: {} },
      { id: "b", trackId: track.id, kind: "video", timelineStartSec: 4, durationSec: 2, props: {} },
    ];
    base.sequences[0]!.durationSec = 6;
    const local = structuredClone(base);
    local.sequences[0]!.tracks[0]!.clips[0]!.timelineStartSec = 2;
    const external = structuredClone(base);
    external.sequences[0]!.tracks[0]!.clips[1]!.timelineStartSec = 2;

    expect(mergeVideoProjects(base, local, external)).toEqual({
      ok: false,
      reason: "The merged project would overlap clips a and b on track track-video.",
    });
  });

  test("fences a track deletion against an external child add but preserves a sibling add", () => {
    const base = project();
    const local = structuredClone(base);
    local.sequences[0]!.tracks = local.sequences[0]!.tracks.filter((track) => track.id !== "track-video");
    const externalChild = structuredClone(base);
    externalChild.sequences[0]!.tracks[0]!.clips.push({ id: "new", trackId: "track-video", kind: "video", timelineStartSec: 0, durationSec: 1, props: {} });
    externalChild.sequences[0]!.durationSec = 1;
    expect(mergeVideoProjects(base, local, externalChild).ok).toBe(false);

    const externalSibling = structuredClone(base);
    externalSibling.sequences[0]!.markers = [{ id: "marker", timeSec: 0 }];
    const merged = mergeVideoProjects(base, local, externalSibling);
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.project.sequences[0]!.markers).toEqual([{ id: "marker", timeSec: 0 }]);
  });

  test("rejects a merge that introduces a dangling clip media reference", () => {
    const base = project();
    base.media = [{ id: "source", kind: "video", ref: "media/source.mp4" }];
    const local = structuredClone(base);
    local.media = [];
    const external = structuredClone(base);
    external.sequences[0]!.tracks[0]!.clips.push({ id: "new", trackId: "track-video", kind: "video", mediaId: "source", timelineStartSec: 0, durationSec: 1, props: {} });
    external.sequences[0]!.durationSec = 1;

    expect(mergeVideoProjects(base, local, external)).toEqual({
      ok: false,
      reason: "Media source is used by another editor's clip change; removing it would be unsafe.",
    });
  });

  test("undoes and redoes semantic generation block order", () => {
    const before = project();
    before.generationBrief = createStarterGenerationBrief();
    const firstId = before.generationBrief.blocks[0]!.id;
    const after = structuredClone(before);
    after.generationBrief = moveGenerationDirectionBlock(after.generationBrief!, firstId, after.generationBrief!.blocks.length - 1);
    const history = new VideoProjectHistory();
    history.record(before, after);

    const undone = history.undo(after);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.project.generationBrief?.blocks.map((block) => block.id)).toEqual(before.generationBrief.blocks.map((block) => block.id));
    const redone = history.redo(undone.project);
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.project.generationBrief?.blocks.map((block) => block.id)).toEqual(after.generationBrief.blocks.map((block) => block.id));
  });

  test("fences an ordered block reorder against an external block edit", () => {
    const base = project();
    base.generationBrief = createStarterGenerationBrief();
    const local = structuredClone(base);
    const firstId = local.generationBrief!.blocks[0]!.id;
    local.generationBrief = moveGenerationDirectionBlock(local.generationBrief!, firstId, local.generationBrief!.blocks.length - 1);
    const external = structuredClone(base);
    const edited = external.generationBrief!.blocks[1]!;
    external.generationBrief = updateGenerationDirectionBlock(external.generationBrief!, edited.id, { collapsed: true });

    const result = mergeVideoProjects(base, local, external);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("The generation brief order or content changed elsewhere. Nothing was overwritten.");
      expect(result.reason).not.toMatch(/project\.sequences|generationBrief\.blocks/);
    }
  });

  test("undoes muted playback state while a track remains locked", () => {
    const before = project();
    before.sequences[0]!.tracks[0]!.locked = true;
    const after = structuredClone(before);
    after.sequences[0]!.tracks[0]!.muted = true;
    const history = new VideoProjectHistory();
    history.record(before, after);

    const undone = history.undo(after);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.project.sequences[0]!.tracks[0]).toMatchObject({ locked: true });
    expect(undone.project.sequences[0]!.tracks[0]!.muted).toBeUndefined();
    const redone = history.redo(undone.project);
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.project.sequences[0]!.tracks[0]).toMatchObject({ locked: true, muted: true });
  });
});
