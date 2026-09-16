import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { forkCoordinator } from "../../src/fork/fork-coordinator";
import type { RegisteredTurnSlice } from "../../src/fork/fork-metadata";

const slice: RegisteredTurnSlice = {
  message: "m",
  attachmentTextBlocks: [],
  multimodalImages: [],
};

describe("ForkCoordinator lane eviction (M170 / MAJOR #4)", () => {
  test("empty lane state is evicted after main + fork reconcile fully", () => {
    const lane = `room:${randomUUID()}`;

    // Allocate BOTH sequences before completing main 1 — otherwise the lane
    // evicts the moment main 1 reconciles and seq numbers reset.
    const m1Seq = forkCoordinator.nextSequence(lane);
    forkCoordinator.registerTurn(lane, {
      sequence: m1Seq,
      jobId: "m1",
      turnId: "t1",
      kind: "main",
      mergedSlice: slice,
    });

    const f2Seq = forkCoordinator.nextSequence(lane);
    forkCoordinator.registerForkTurn(lane, {
      sequence: f2Seq,
      jobId: "f2",
      turnId: "t2",
      mergedSlice: slice,
      forkThreadId: `${lane}:fork:t2:${randomUUID()}`,
    });

    forkCoordinator.markMainCompleted(lane, "m1");
    // Fork 2 still unreconciled → lane stays alive.
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(true);

    forkCoordinator.markForkCompleted(lane, f2Seq);
    // Fully reconciled → evicted.
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });

  test("lane is NOT evicted while a paused (unreconciled) fork is registered", () => {
    const lane = `room:${randomUUID()}`;

    const m1Seq = forkCoordinator.nextSequence(lane);
    forkCoordinator.registerTurn(lane, {
      sequence: m1Seq,
      jobId: "m1",
      turnId: "t1",
      kind: "main",
      mergedSlice: slice,
    });
    const f2Seq = forkCoordinator.nextSequence(lane);
    const forkThreadId = `${lane}:fork:t2:${randomUUID()}`;
    forkCoordinator.registerForkTurn(lane, {
      sequence: f2Seq,
      jobId: "f2",
      turnId: "t2",
      mergedSlice: slice,
      forkThreadId,
    });
    forkCoordinator.markMainCompleted(lane, "m1");

    // A paused fork (interrupt, not yet resumed) keeps the lane alive even
    // though main finished — its sequence is unreconciled.
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(true);

    // Resume path advances ordering by checkpoint id (R6).
    forkCoordinator.markForkCompletedByCheckpoint(forkThreadId);
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });

  test("getSeqCounter / hasUnreconciledLowerTurns track the lane", () => {
    const lane = `room:${randomUUID()}`;
    expect(forkCoordinator.getSeqCounter(lane)).toBe(0);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(false);

    forkCoordinator.nextSequence(lane);
    forkCoordinator.registerTurn(lane, {
      sequence: 1,
      jobId: "m1",
      turnId: "t1",
      kind: "main",
      mergedSlice: slice,
    });
    forkCoordinator.nextSequence(lane);
    forkCoordinator.registerForkTurn(lane, {
      sequence: 2,
      jobId: "f2",
      turnId: "t2",
      mergedSlice: slice,
    });

    expect(forkCoordinator.getSeqCounter(lane)).toBe(2);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(true);

    forkCoordinator.markMainCompleted(lane, "m1");
    // fork 2 still pending → still unreconciled
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(true);

    forkCoordinator.markForkCompleted(lane, 2);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(false);
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });
});
