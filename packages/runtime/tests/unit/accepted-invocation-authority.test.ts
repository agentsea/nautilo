import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assertAcceptedInvocationAuthoritySubject,
  createAcceptedInvocationAuthority,
} from "@nautilo/trust";
import { Job, type JobExecutor } from "../../src/job";
import {
  JobManager,
  getCurrentAcceptedInvocationAuthority,
  getCurrentAcceptedWorkAuthority,
  runWithAcceptedWorkAuthorities,
  type WorkAcceptanceSinks,
} from "../../src/job-manager";
import {
  getCurrentInitiatingClientSurface,
  runWithInitiatingClientSurface,
} from "@nautilo/agent";
import { createMaintenanceAcceptanceAuthority } from "../../src/maintenance-controller";

const noopUpdate = async () => {};

function input(humanUserId: string, laneKey: string) {
  const roomId = randomUUID();
  return {
    message: "accepted invocation authority test",
    ownerId: humanUserId,
    requestorId: humanUserId,
    agentId: "agent-1",
    roomId,
    graphThreadId: `${laneKey}:thread`,
    turnId: randomUUID(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for accepted invocation authority test");
}

function acceptanceSinks(onInsert?: () => void): WorkAcceptanceSinks {
  return {
    insertAcceptance: async () => {
      onInsert?.();
      return randomUUID();
    },
    linkAcceptancesToJob: async (ids) => ids.length,
    terminalizeAllAcceptedWork: async () => 0,
    userCancelAcceptedWork: async () => 0,
  };
}

describe("M254 accepted invocation Job authority", () => {
  test("scopes both independent authorities for an already-admitted continuation", async () => {
    const invocation = createAcceptedInvocationAuthority("human-continuation");
    const maintenance = createMaintenanceAcceptanceAuthority();

    await runWithAcceptedWorkAuthorities(maintenance, invocation, async () => {
      expect(getCurrentAcceptedInvocationAuthority()).toBe(invocation);
      expect(getCurrentAcceptedWorkAuthority()).toBe(maintenance);
    });

    expect(getCurrentAcceptedInvocationAuthority()).toBeUndefined();
    expect(getCurrentAcceptedWorkAuthority()).toBeUndefined();
  });

  test("mints only after durable acceptance and propagates through Job ALS", async () => {
    const humanUserId = "human-1";
    let inserted = false;
    let authorityInsideExecutor = getCurrentAcceptedInvocationAuthority();
    let maintenanceInsideExecutor = getCurrentAcceptedWorkAuthority();
    const finished = Promise.withResolvers<void>();
    const executor: JobExecutor = async function* () {
      authorityInsideExecutor = getCurrentAcceptedInvocationAuthority();
      maintenanceInsideExecutor = getCurrentAcceptedWorkAuthority();
      finished.resolve();
      yield* [];
    };
    const manager = new JobManager({
      persist: async () => randomUUID(),
      updateStatus: noopUpdate,
      acceptanceSinks: acceptanceSinks(() => {
        inserted = true;
      }),
    });

    const accepted = await manager.createForegroundJob(
      humanUserId,
      humanUserId,
      "lane:human-1",
      input(humanUserId, "lane:human-1"),
      executor,
      undefined,
      { executor, coalescing: "separate", contention: "serialize" },
    );

    expect(inserted).toBe(true);
    expect(accepted.invocationAcceptanceAuthority).toBeDefined();
    await finished.promise;
    expect(authorityInsideExecutor).toBe(
      accepted.invocationAcceptanceAuthority,
    );
    expect(maintenanceInsideExecutor).toBe(accepted.acceptanceAuthority);
    expect(() =>
      assertAcceptedInvocationAuthoritySubject(
        authorityInsideExecutor!,
        humanUserId,
      ),
    ).not.toThrow();
    expect(getCurrentAcceptedInvocationAuthority()).toBeUndefined();
    expect(getCurrentAcceptedWorkAuthority()).toBeUndefined();
    await waitFor(() => manager.getActiveJobs().length === 0);
  });

  test("keeps a direct surface only in the exact main-turn execution", async () => {
    const humanUserId = "human-surface";
    const finished = Promise.withResolvers<void>();
    let observed = "unknown";
    let persistedInput: Record<string, unknown> | undefined;
    const executor: JobExecutor = async function* () {
      observed = getCurrentInitiatingClientSurface();
      finished.resolve();
      yield* [];
    };
    const manager = new JobManager({
      persist: async (payload) => {
        persistedInput = payload.input;
        return randomUUID();
      },
      updateStatus: noopUpdate,
      acceptanceSinks: acceptanceSinks(),
    });
    await manager.createForegroundJob(
      humanUserId,
      humanUserId,
      "lane:human-surface",
      input(humanUserId, "lane:human-surface"),
      executor,
      undefined,
      {
        executor,
        coalescing: "separate",
        coalescingBoundary: "exact-client",
        contention: "fork",
      },
      undefined,
      {
        onMainTurn: () => {},
        onIneligible: () => {},
        coalescingContext: {
          clientSessionToken: Symbol("session"),
          initiatingClientSurface: "mobile.web",
        },
      },
    );
    await finished.promise;
    expect(observed).toBe("mobile.web");
    expect(persistedInput).not.toHaveProperty("initiatingClientSurface");
    expect(persistedInput).not.toHaveProperty("clientActionSessionId");
    expect(getCurrentInitiatingClientSurface()).toBe("unknown");
  });

  test("a background Job spawned under a known turn resets its surface to unknown", async () => {
    const observed = Promise.withResolvers<string>();
    const originalExecute = Job.prototype.execute;
    Job.prototype.execute = async function() {
      observed.resolve(getCurrentInitiatingClientSurface());
    };
    try {
      const manager = new JobManager({
        persist: async () => randomUUID(),
        updateStatus: noopUpdate,
        acceptanceSinks: acceptanceSinks(),
      });
      await runWithInitiatingClientSurface("mobile.web", () =>
        manager.createBackgroundJob("owner", "human", { task: "nested" }),
      );
      expect(await observed.promise).toBe("unknown");
    } finally {
      Job.prototype.execute = originalExecute;
    }
  });

  test("rejects a continuation authority bound to another Human before acceptance", async () => {
    let inserts = 0;
    const manager = new JobManager({
      persist: async () => randomUUID(),
      updateStatus: noopUpdate,
      acceptanceSinks: acceptanceSinks(() => {
        inserts += 1;
      }),
    });
    const aliceAuthority = createAcceptedInvocationAuthority("alice");

    expect(
      manager.createForegroundJob(
        "bob",
        "bob",
        "lane:bob",
        input("bob", "lane:bob"),
        undefined,
        undefined,
        undefined,
        aliceAuthority,
      ),
    ).rejects.toThrow("Accepted invocation authority subject mismatch");
    await Promise.resolve();
    expect(inserts).toBe(0);
  });

  test("carries an accepted Human resume through the synthetic Job lifecycle", async () => {
    const humanUserId = "human-resume";
    const authority = createAcceptedInvocationAuthority(humanUserId);
    const manager = new JobManager({
      persist: async () => randomUUID(),
      updateStatus: noopUpdate,
    });
    let observed = getCurrentAcceptedInvocationAuthority();

    await manager.runResumeJobLifecycle(
      {
        laneKey: "lane:resume",
        roomId: "room-resume",
        graphThreadId: "thread-resume",
        humanUserId,
      },
      async () => {
        observed = getCurrentAcceptedInvocationAuthority();
      },
      authority,
    );

    expect(observed).toBe(authority);
    expect(getCurrentAcceptedInvocationAuthority()).toBeUndefined();
    expect(manager.getActiveJobIdsForRoom("room-resume")).toEqual([]);
  });

  test("splits a reused lane before differently bound Humans can coalesce", async () => {
    const callbacks: Array<() => void> = [];
    const seenSubjects: string[] = [];
    const linkedGroupSizes: number[] = [];
    const executor: JobExecutor = async function* () {
      const authority = getCurrentAcceptedInvocationAuthority()!;
      try {
        assertAcceptedInvocationAuthoritySubject(authority, "alice");
        seenSubjects.push("alice");
      } catch {
        assertAcceptedInvocationAuthoritySubject(authority, "bob");
        seenSubjects.push("bob");
      }
      yield* [];
    };
    const setTimer = ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const manager = new JobManager({
      setTimer,
      clearTimer: (() => {}) as typeof clearTimeout,
      coalescerWindowMs: 60_000,
      coalescerFirstSegmentQuietMs: 60_000,
      persist: async () => randomUUID(),
      updateStatus: noopUpdate,
      acceptanceSinks: {
        ...acceptanceSinks(),
        linkAcceptancesToJob: async (ids) => {
          linkedGroupSizes.push(ids.length);
          return ids.length;
        },
      },
    });
    const sharedLane = "lane:incorrectly-reused";

    await manager.createForegroundJob(
      "alice",
      "alice",
      sharedLane,
      input("alice", sharedLane),
      executor,
    );
    await manager.createForegroundJob(
      "bob",
      "bob",
      sharedLane,
      input("bob", sharedLane),
      executor,
    );
    for (const callback of callbacks) callback();
    await waitFor(() => seenSubjects.length === 2);
    expect(seenSubjects).toEqual(["alice", "bob"]);
    expect(linkedGroupSizes).toEqual([1, 1]);
  });
});
