import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { forkCoordinator } from "../../src/fork/fork-coordinator";
import type { RegisteredTurnSlice } from "../../src/fork/fork-metadata";

const emptySlice: RegisteredTurnSlice = {
  message: "m",
  attachmentTextBlocks: [],
  multimodalImages: [],
};

/**
 * M170 — the splice machinery is gone. The fork-coordinator now advances its
 * lane commit-ordering cursor when a turn reaches a terminal outcome:
 * `markMainCompleted` (main) and `markForkCompleted` (fork). A fork's reply
 * reaches the parent via the transcript (M168 rebuild), not a checkpoint splice.
 *
 * NOTE: a fully-reconciled lane is EVICTED (MAJOR #4), after which
 * `getCommittedSeq` returns 0 by contract — so we either keep a trailing
 * unreconciled turn alive while asserting `committedSeq`, or assert the
 * reconciled end-state via `hasLaneForTests` / `hasUnreconciledLowerTurns`.
 */
describe("ForkCoordinator contiguous ordering (M170)", () => {
  function main(lane: string, sequence: number, jobId: string): void {
    forkCoordinator.nextSequence(lane);
    forkCoordinator.registerTurn(lane, {
      sequence,
      jobId,
      turnId: `t${sequence}`,
      kind: "main",
      mergedSlice: emptySlice,
    });
  }
  function fork(lane: string, sequence: number, jobId: string): void {
    forkCoordinator.nextSequence(lane);
    forkCoordinator.registerForkTurn(lane, {
      sequence,
      jobId,
      turnId: `t${sequence}`,
      mergedSlice: emptySlice,
    });
  }

  test("completed main turn is not a fork predecessor", () => {
    const lane = `room:${randomUUID()}`;
    // Allocate main1 + fork2 first so the lane survives main1 reconciling.
    main(lane, 1, "m1");
    fork(lane, 2, "f2");

    forkCoordinator.markMainCompleted(lane, "m1");
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);

    // The reconciled main 1 is no longer a predecessor of fork 2.
    const preds = forkCoordinator.getTurnsBeforeSequence(lane, 2);
    expect(preds.map((p) => p.sequence)).toEqual([]);
  });

  test("a later main turn does not commit ahead of an earlier unreconciled fork", () => {
    const lane = `room:${randomUUID()}`;
    main(lane, 1, "m1");
    fork(lane, 2, "f2");

    forkCoordinator.markMainCompleted(lane, "m1");
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);

    // A later main turn (seq 3) registers only after main 1 released the lane.
    main(lane, 3, "m3");

    // Main 3 finishes first, but fork 2 is still unreconciled → committedSeq
    // must stay at 1 (the BLOCKER-#1 gate keeps later turns forking).
    forkCoordinator.markMainCompleted(lane, "m3");
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(true);

    // Fork 2 completes → both 2 and (already-terminal) 3 advance contiguously,
    // fully reconciling the lane (which then evicts).
    forkCoordinator.markForkCompleted(lane, 2);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(false);
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });

  test("out-of-order fork completions still advance in sequence order", () => {
    const lane = `room:${randomUUID()}`;
    main(lane, 1, "m1");
    fork(lane, 2, "f2");
    fork(lane, 3, "f3");

    forkCoordinator.markMainCompleted(lane, "m1");
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);

    // Fork 3 completes first → cannot advance past the still-pending fork 2.
    forkCoordinator.markForkCompleted(lane, 3);
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(true);

    // Fork 2 completes → 2 then 3 advance; lane fully reconciles.
    forkCoordinator.markForkCompleted(lane, 2);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(false);
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });

  test("a failed/cancelled fork still advances ordering (no hang)", () => {
    const lane = `room:${randomUUID()}`;
    main(lane, 1, "m1");
    fork(lane, 2, "f2");

    forkCoordinator.markMainCompleted(lane, "m1");
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);

    // JobManager calls this in the fork job's `.finally` for failed/cancelled —
    // ordering must still advance so the lane never hangs.
    forkCoordinator.markForkCompleted(lane, 2);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(false);
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });

  test("markForkCompleted is idempotent and re-entrant-safe", () => {
    const lane = `room:${randomUUID()}`;
    // Keep fork 2 unreconciled so the lane stays alive across the repeated call.
    fork(lane, 1, "f1");
    fork(lane, 2, "f2");

    forkCoordinator.markForkCompleted(lane, 1);
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);
    // A second call for the same (already-reconciled) sequence is a no-op.
    forkCoordinator.markForkCompleted(lane, 1);
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);
  });

  test("markForkCompletedByCheckpoint advances by fork thread id; unknown id no-ops", () => {
    const lane = `room:${randomUUID()}`;
    const forkThreadId = `${lane}:fork:t1:${randomUUID()}`;
    forkCoordinator.nextSequence(lane);
    forkCoordinator.registerForkTurn(lane, {
      sequence: 1,
      jobId: "f1",
      turnId: "t1",
      mergedSlice: emptySlice,
      forkThreadId,
    });
    // Keep a trailing unreconciled fork so the lane survives seq 1 reconciling.
    fork(lane, 2, "f2");

    // Unknown / non-fork thread id is a safe no-op.
    expect(() =>
      forkCoordinator.markForkCompletedByCheckpoint(`${lane}:not-a-fork`),
    ).not.toThrow();
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(0);

    forkCoordinator.markForkCompletedByCheckpoint(forkThreadId);
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);
  });
});
