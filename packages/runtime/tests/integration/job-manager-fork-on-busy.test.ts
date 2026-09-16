import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JobExecutor } from "../../src/job";
import type { ForegroundTurnCandidate } from "../../src/foreground-turn-lifecycle";
import { JobManager, type ForegroundExecutionRoute } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import {
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  setupTestDb,
  createTestRoom,
  waitForDispatchedJobCount,
  getJobFromDb,
  collectEvents,
} from "./helpers";
import { eventBus } from "../../src/event-bus";

/** First message flushes alone; second is sent only after the main job holds the lane. */
const FORK_ON_BUSY_TIMING = {
  coalescerWindowMs: 60_000,
  coalescerFirstSegmentQuietMs: 40,
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
  userId = (await createTestUser("job-mgr-fork-m085")).userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("JobManager M085 fork-on-busy (integration)", () => {
  test("second flush while lane busy dispatches fork executor input + fork metadata", async () => {
    const laneLock = new InMemoryLaneLock();
    const gate = Promise.withResolvers<void>();

    let forkCheckpointId = "";
    const foregroundOutcomes: string[] = [];

    const { events, cleanup } = collectEvents(eventBus);

    const executor: JobExecutor = async function* (input, _jobId, laneKey, _signal) {
      const forkRun = (input as { forkRun?: { mode?: string; checkpointThreadId?: string } }).forkRun;
      if (forkRun?.mode === "fork") {
        forkCheckpointId = forkRun.checkpointThreadId ?? "";
        yield {
          type: "message.tokens",
          laneKey: laneKey ?? "lane",
          content: ".",
          chunkSequence: 1,
          done: true,
        };
        return;
      }
      await gate.promise;
      yield {
        type: "message.tokens",
        laneKey: laneKey ?? "lane",
        content: ".",
        chunkSequence: 1,
        done: true,
      };
    };

    const jm = new JobManager({ laneLock, ...FORK_ON_BUSY_TIMING });
    const ordinaryRoute = {
      executor,
      coalescing: "coalesce",
      coalescingBoundary: "exact-client",
      contention: "fork",
    } satisfies ForegroundExecutionRoute;
    const clientSessionToken = Symbol("ordinary-client-session");
    const candidate = (
      label: string,
      forkEligible = false,
    ): ForegroundTurnCandidate => ({
      onMainTurn: () => foregroundOutcomes.push(`${label}:main`),
      ...(forkEligible
        ? {
            onForkTurn: () => foregroundOutcomes.push(`${label}:fork`),
            runForkTurn: async <T>(
              _turnId: string,
              work: () => Promise<T>,
            ) => {
              foregroundOutcomes.push(`${label}:fork-run`);
              return work();
            },
          }
        : {}),
      onIneligible: () => foregroundOutcomes.push(`${label}:ineligible`),
      coalescingContext: {
        clientSessionToken,
        initiatingClientSurface: "workbench.desktop",
      },
    });
    const lane = `room:${randomUUID()}`;
    const { roomId } = await createTestRoom(userId);
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

    await jm.createForegroundJob(
      userId,
      userId,
      lane,
      {
        ...base,
        message: "first",
        turnId: randomUUID(),
      },
      executor,
      undefined,
      ordinaryRoute,
      undefined,
      candidate("first"),
    );

    const [job1] = await waitForDispatchedJobCount(jm, 1);
    if (!job1) throw new Error("expected first foreground job");

    await jm.createForegroundJob(
      userId,
      userId,
      lane,
      {
        ...base,
        message: "second",
        turnId: randomUUID(),
      },
      executor,
      undefined,
      ordinaryRoute,
      undefined,
      candidate("second", true),
    );

    const [job2] = await waitForDispatchedJobCount(jm, 1);
    if (!job2) throw new Error("expected fork foreground job");

    const row1 = await getJobFromDb(job1.id);
    const row2 = await getJobFromDb(job2.id);
    expect(row1?.input?.["forkRun"]).toBeUndefined();

    const fr = row2?.input?.["forkRun"] as { mode?: string } | undefined;
    expect(fr?.mode).toBe("fork");
    expect(foregroundOutcomes).toEqual([
      "first:main",
      "second:fork",
      "second:fork-run",
    ]);
    // A busy fork is a fresh graph checkpoint, not a new client request. It
    // must retain this accepted turn's exact host proof, without borrowing any
    // parent per-tool approval state.
    expect(row2?.input).toMatchObject({
      currentFolder: "/project-a",
      currentFolderRelayId: ordinaryOrigin.relayId,
      verifiedOrdinaryOrigin: ordinaryOrigin,
    });
    expect(row2?.input?.["approvedToolCalls"]).toBeUndefined();
    expect(row2?.input?.["pendingApproval"]).toBeUndefined();

    expect(forkCheckpointId.length).toBeGreaterThan(0);
    expect(forkCheckpointId).toContain(":fork:");
    expect(graphThreadId.startsWith("room:")).toBe(true);
    expect(forkCheckpointId.startsWith(graphThreadId)).toBe(true);

    const dispatchedIds = events
      .filter((e) => e.type === "job.dispatched")
      .map((e) => e.jobId);
    expect(dispatchedIds.length).toBeGreaterThanOrEqual(2);
    expect(dispatchedIds[0]).toBe(job1.id);
    expect(dispatchedIds[1]).toBe(job2.id);

    const forkForked = events.find((e) => e.type === "job.forked");
    expect(forkForked?.type).toBe("job.forked");
    if (forkForked?.type === "job.forked") {
      expect(forkForked.jobId).toBe(job2.id);
    }

    const ixDisp2 = events.findIndex(
      (e) => e.type === "job.dispatched" && e.jobId === job2.id,
    );
    const ixForked = events.findIndex((e) => e.type === "job.forked");
    const firstTokenAfterForked = events
      .slice(ixForked + 1)
      .find((e) => e.type === "message.tokens" && e.laneKey === lane);
    expect(ixDisp2).toBeGreaterThanOrEqual(0);
    expect(ixForked).toBeGreaterThan(ixDisp2);
    expect(firstTokenAfterForked?.type).toBe("message.tokens");

    cleanup();

    gate.resolve();
  });
});
