import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { forkCoordinator } from "../../src/fork/fork-coordinator";
import type { ForkRunMetadata } from "../../src/fork/fork-metadata";
import {
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  setupTestDb,
  createTestRoom,
  waitForDispatchedJobCount,
  getJobFromDb,
} from "./helpers";

const TIMING = {
  coalescerWindowMs: 60_000,
  coalescerFirstSegmentQuietMs: 30,
} as const;

const ordinaryOrigin = {
  kind: "local_electron" as const,
  userId: "user-1",
  actorId: "actor-1",
  relayId: "relay-terminal-a",
  desktopSessionId: "desktop-session-1",
  pairingGeneration: "pairing-1",
  requestId: "request-1",
};

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  userId = (await createTestUser("fork-main-after-unspliced")).userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("JobManager BLOCKER #1 (M085)", () => {
  test("ordinary main turn does not run on parent while a lower fork is unspliced", async () => {
    const laneLock = new InMemoryLaneLock();
    const main1Gate = Promise.withResolvers<void>();
    const fork2Gate = Promise.withResolvers<void>();

    type Recorded = { jobId: string; forkRun?: ForkRunMetadata };
    const recorded: Recorded[] = [];

    let main1JobId = "";
    let fork2JobId: string | undefined;

    const executor: JobExecutor = async function* (input, jobId, laneKey) {
      const fr = (input as { forkRun?: ForkRunMetadata }).forkRun;
      recorded.push({ jobId, ...(fr ? { forkRun: fr } : {}) });
      if (!fr) {
        // main1 — hold the lane until released
        main1JobId = jobId;
        await main1Gate.promise;
        yield {
          type: "message.tokens",
          laneKey: laneKey ?? "lane",
          content: "main1-done",
          chunkSequence: 1,
          done: true,
        };
        return;
      }
      // forked turns — do not mark completion; we drive that manually.
      if (!fork2JobId) fork2JobId = jobId;
      await fork2Gate.promise;
      yield {
        type: "message.tokens",
        laneKey: laneKey ?? "lane",
        content: "fork-done",
        chunkSequence: 1,
        done: true,
      };
    };

    const jm = new JobManager({ laneLock, ...TIMING });
    const { roomId } = await createTestRoom(userId);
    const lane = `room:${roomId}`;
    const graphThreadId = `room:${roomId}`;
    const base = {
      ownerId: userId,
      requestorId: userId,
      agentId: "a1",
      roomId,
      graphThreadId,
      threadId: graphThreadId,
      currentFolder: "/project-a",
      currentFolderRelayId: ordinaryOrigin.relayId,
      verifiedOrdinaryOrigin: ordinaryOrigin,
    };

    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "first",
      turnId: randomUUID(),
    }, executor);

    const [job1] = await waitForDispatchedJobCount(jm, 1);
    if (!job1) throw new Error("expected main1");

    // While main1 is busy, send msg 2 → fork seq 2
    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "second",
      turnId: randomUUID(),
    }, executor);
    const [job2] = await waitForDispatchedJobCount(jm, 1);
    if (!job2) throw new Error("expected fork2");

    const row2 = await getJobFromDb(job2.id);
    const fork2 = row2?.input?.["forkRun"] as ForkRunMetadata | undefined;
    expect(fork2?.mode).toBe("fork");
    expect(row2?.input).toMatchObject({
      currentFolder: "/project-a",
      currentFolderRelayId: ordinaryOrigin.relayId,
      verifiedOrdinaryOrigin: ordinaryOrigin,
    });
    if (!fork2) throw new Error("fork2 metadata missing");

    // Release main1 so the lane lock physically frees, but DON'T mark
    // fork2 complete yet — it remains "unreconciled".
    main1Gate.resolve();
    expect(main1JobId).toBeTruthy();

    // Wait for main1 to be marked terminal in the coordinator.
    const startWait = Date.now();
    while (Date.now() - startWait < 5_000) {
      if (forkCoordinator.getCommittedSeq(lane) >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(1);

    // committedSeq=1, seqCounter=2 (fork2 still incomplete). Lane lock is
    // free, but the next main turn must NOT run as a normal main on the
    // parent checkpoint — it must route to a fork.
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(true);

    await jm.createForegroundJob(userId, userId, lane, {
      ...base,
      message: "third",
      turnId: randomUUID(),
    }, executor);
    const [job3] = await waitForDispatchedJobCount(jm, 1);
    if (!job3) throw new Error("expected job3");

    const row3 = await getJobFromDb(job3.id);
    const fork3 = row3?.input?.["forkRun"] as ForkRunMetadata | undefined;
    expect(fork3?.mode).toBe("fork");
    expect(fork3?.sequence).toBe(3);
    // The unreconciled path uses the same M085 constructor. It preserves the
    // new turn's accepted host proof but does not synthesize an old approval.
    expect(row3?.input).toMatchObject({
      currentFolder: "/project-a",
      currentFolderRelayId: ordinaryOrigin.relayId,
      verifiedOrdinaryOrigin: ordinaryOrigin,
    });
    expect(row3?.input?.["approvedToolCalls"]).toBeUndefined();
    expect(row3?.input?.["pendingApproval"]).toBeUndefined();
    if (!fork3) throw new Error("fork3 metadata missing");
    // fork 2 must show up as a pending predecessor for fork 3
    expect(fork3.pendingTurns.some((p) => p.sequence === 2)).toBe(true);

    // Now drive fork2 completion manually, then fork3.
    fork2Gate.resolve();
    if (!fork2JobId) throw new Error("missing fork2 job id");

    forkCoordinator.markForkCompleted(lane, 2);
    // After fork 2 completes, only seq 3 remains pending — verify mid-flight
    // before the final completion evicts the lane state.
    expect(forkCoordinator.getCommittedSeq(lane)).toBe(2);
    expect(forkCoordinator.hasUnreconciledLowerTurns(lane)).toBe(true);

    forkCoordinator.markForkCompleted(lane, 3);
    // Lane fully reconciled → evicted (MAJOR #4).
    expect(forkCoordinator.hasLaneForTests(lane)).toBe(false);
  });
});
