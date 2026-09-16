import { describe, expect, test } from "bun:test";
import {
  advanceTimelineInteraction,
  beginTimelineInteraction,
  cancelTimelineInteraction,
  createIdleTimelineInteraction,
  isActiveTimelineInteraction,
  resetTimelineInteraction,
} from "./interaction-state";

describe("timeline interaction state", () => {
  test("models a move proposal without mutating start or caller-owned proposal state", () => {
    const proposal = { clipIds: ["clip-1"], deltaFrames: 0 };
    const state = beginTimelineInteraction({
      kind: "move",
      start: { pointer: { x: 10, y: 20 }, frame: 30, selectionIds: ["clip-1"] },
      proposal,
    });
    proposal.deltaFrames = 99;
    proposal.clipIds.push("clip-2");

    expect(state).toMatchObject({ kind: "move", start: { frame: 30 }, current: { frame: 30 }, proposal: { deltaFrames: 0 } });
    expect(state.proposal["clipIds"]).toEqual(["clip-1"]);
    expect(isActiveTimelineInteraction(state)).toBe(true);
  });

  test("updates transient proposal and optional snap only while active", () => {
    const started = beginTimelineInteraction({
      kind: "trim-left",
      start: { pointer: { x: 0, y: 0 }, frame: 60 },
      proposal: { clipId: "clip-1", startFrame: 60 },
    });
    const advanced = advanceTimelineInteraction(started, {
      current: { pointer: { x: 14, y: 0 }, frame: 72 },
      proposal: { clipId: "clip-1", startFrame: 72 },
      snap: {
        rawFrame: 72,
        frame: 70,
        seconds: 70 / 30,
        snapped: true,
        target: { kind: "marker", frame: 70, guideFrame: 70, seconds: 70 / 30, label: "Marker" },
        distanceFrames: 2,
        toleranceFrames: 4,
      },
    });
    expect(advanced).toMatchObject({ kind: "trim-left", current: { frame: 72 }, proposal: { startFrame: 72 }, snap: { frame: 70 } });
  });

  test("cancellation discards the proposal and reset returns idle", () => {
    const state = beginTimelineInteraction({
      kind: "range-wing",
      start: { pointer: { x: 0, y: 0 }, frame: 10 },
      proposal: { rangeStartFrame: 10, rangeEndFrame: 40 },
    });
    const cancelled = cancelTimelineInteraction(state);
    expect(cancelled).toMatchObject({ kind: "cancelled", cancelledKind: "range-wing" });
    expect("proposal" in cancelled).toBe(false);
    expect(resetTimelineInteraction()).toEqual(createIdleTimelineInteraction());
    expect(advanceTimelineInteraction(cancelled, { current: { pointer: { x: 1, y: 1 }, frame: 20 }, proposal: {} })).toBe(cancelled);
  });

  test("supports every explicitly modelled active interaction kind", () => {
    for (const kind of ["move", "trim-left", "trim-right", "playhead", "range-wing", "divider"] as const) {
      expect(
        beginTimelineInteraction({ kind, start: { pointer: { x: 0, y: 0 }, frame: 0 }, proposal: {} }).kind,
      ).toBe(kind);
    }
  });
});
