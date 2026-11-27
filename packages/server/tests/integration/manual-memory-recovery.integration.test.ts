import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDirectDb, eq, inArray, memoryRecoveryRuns, recoverExpiredMaintenanceWith } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createManualMemoryRecovery } from "../../src/lib/manual-memory-recovery";

let db: ReturnType<typeof createDirectDb>;
beforeAll(() => { bootstrapTestDbInstance(); db = createDirectDb(4); });
afterAll(async () => { await db?.end(); });

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not respect the recovery lock timeout")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a failed lane rolls back its changes, other lanes finish, and concurrent or restarted requests return one receipt", async () => {
  const input = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const rollbackMarker = randomUUID();
  let reflectionAvailable = false;
  let maintenance = false;
  const calls = { stenographer: 0, memory: 0, reflection: 0 };
  const createService = () => createManualMemoryRecovery({
    pageAvailable: async () => !maintenance,
    pageSize: 1, pollMs: 1000, db: () => db, assertAvailable: async () => { if (maintenance) throw new Error("maintenance"); }, onError: () => {},
    recover: {
      stenographer: async ({ observedThrough, authorizedBy, page }) => {
        expect(authorizedBy).toBe(input.authorizedBy);
        expect(page.limit).toBe(1);
        expect(observedThrough.toISOString()).toBe(input.now.toISOString());
        calls.stenographer++;
        return { state: "assessed", queued: 1, held: 0, ...(page.after === null && { nextCursor: "second" }) };
      },
      reflection: async ({ executor, page }) => {
        calls.reflection++;
        if (!page.after) return { state: "assessed", queued: 2, held: 1, nextCursor: "remaining",
          derivedRepair: { retired: 0, sourcesQueued: 0, summariesQueued: 2 } };
        expect(page.after).toBe("remaining");
        if (reflectionAvailable) return { state: "assessed", queued: 1, held: 0 };

        const insert = db.insert(memoryRecoveryRuns).values({
          id: rollbackMarker, authorizedBy: input.authorizedBy, observedThrough: input.now,
        }).toSQL();
        await executor.query(insert.sql, insert.params.map(String));
        throw new Error("injected admission failure");
      },
      memory: async () => { calls.memory++; return { state: "assessed", queued: 1, held: 0 }; },
    },
  });
  try {
    const [first, duplicate] = await Promise.all([createService().request(input), createService().request(input)]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ stenographer: null, reflection: null, memory: null });
    expect(calls).toEqual({ stenographer: 0, memory: 0, reflection: 0 });
    maintenance = true;
    expect(await createService().processNextPage(input.requestId)).toBe(false);
    expect(calls.stenographer).toBe(0);
    maintenance = false;
    const drain = async () => {
      // A new coordinator instance on each page must resume from the database.
      while (await createService().processNextPage(input.requestId)) { /* drain */ }
    };
    for (let page = 0; page < 3; ++page) {
      expect(await createService().processNextPage(input.requestId)).toBe(true);
    }
    expect(calls).toEqual({ stenographer: 1, memory: 1, reflection: 1 });
    await Promise.all([drain(), drain()]);
    const [assessed] = await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(assessed).toMatchObject({ stenographer: { state: "assessed", queued: 2, held: 0 },
      reflection: { state: "unavailable" }, memory: { state: "assessed", queued: 1, held: 0 } });
    reflectionAvailable = true;
    const resumed = await createService().request({ ...input, now: new Date(input.now.getTime() + 1000) });
    expect(resumed).toMatchObject({ observedThrough: first.observedThrough, reflection: null });
    await drain();
    const final = await createService().request(input);
    expect(final).toMatchObject({ stenographer: assessed?.stenographer, memory: assessed?.memory,
      reflection: { state: "assessed", queued: 3, held: 1,
        derivedRepair: { retired: 0, sourcesQueued: 0, summariesQueued: 2 } } });
    expect(final).not.toHaveProperty("progress");
    expect(calls.memory).toBe(1);
    expect(calls.stenographer).toBe(2);
    expect(calls.reflection).toBe(3);
    expect(await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, rollbackMarker))).toHaveLength(0);
  } finally {
    await db.delete(memoryRecoveryRuns).where(inArray(memoryRecoveryRuns.id, [input.requestId, rollbackMarker]));
  }
});

test("a newly started worker finishes a saved request without another HTTP call", async () => {
  const input = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const completed = { state: "assessed", queued: 0, held: 0 } as const;
  let wakeCount = 0;
  let wake!: () => void;
  const dispatched = new Promise<void>(resolve => { wake = resolve; });
  const service = createManualMemoryRecovery({
    db: () => db, assertAvailable: async () => {}, pageAvailable: async () => true,
    pageSize: 1, pollMs: 25, onError: () => {},
    wakeMemory: () => { ++wakeCount; wake(); },
    recover: {
      stenographer: async () => completed, reflection: async () => completed,
      memory: async input => {
        expect(input.page).toEqual({ after: null, limit: 1 });
        return { ...completed, queued: 1 };
      },
    },
  });
  try {
    // Old receipts have no progress object. The worker must keep completed
    // lanes intact and begin the remaining lane at its first page.
    await db.insert(memoryRecoveryRuns).values({
      id: input.requestId, authorizedBy: input.authorizedBy, observedThrough: input.now,
      stenographer: completed, reflection: completed,
    });
    service.start();
    await dispatched;
    const [saved] = await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(saved?.memory).toEqual({ ...completed, queued: 1 });
    expect(wakeCount).toBe(1);
  } finally {
    await service.stop();
    await db.delete(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, input.requestId));
  }
});

test("lock contention preserves the grant and cursor, releases global gates, and yields to other lanes", async () => {
  const input = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const markerId = randomUUID();
  const completed = { state: "assessed", queued: 0, held: 0 } as const;
  const calls = { stenographer: 0, reflection: 0, memory: 0 };
  let releaseGate!: () => void;
  let releaseWork!: () => void;
  const gateRelease = new Promise<void>(resolve => { releaseGate = resolve; });
  const workRelease = new Promise<void>(resolve => { releaseWork = resolve; });
  let gateBlocker: Promise<unknown> | undefined;
  let workBlocker: Promise<unknown> | undefined;
  const service = createManualMemoryRecovery({
    db: () => db,
    assertAvailable: async () => {},
    pageAvailable: async (tx, now) =>
      (await recoverExpiredMaintenanceWith(tx, now)).snapshot.state === "normal",
    pageSize: 1,
    pollMs: 1_000,
    lockTimeoutMs: 50,
    onError: () => {},
    recover: {
      stenographer: async ({ db: tx }) => {
        calls.stenographer++;
        await tx.select().from(memoryRecoveryRuns)
          .where(eq(memoryRecoveryRuns.id, markerId)).for("update");
        return completed;
      },
      reflection: async () => { calls.reflection++; return completed; },
      memory: async () => { calls.memory++; return completed; },
    },
  });
  try {
    await db.insert(memoryRecoveryRuns).values({
      id: markerId, authorizedBy: input.authorizedBy, observedThrough: input.now,
      stenographer: completed, reflection: completed, memory: completed,
    });
    await service.request(input);

    let gateLocked!: () => void;
    const gateReady = new Promise<void>(resolve => { gateLocked = resolve; });
    gateBlocker = db.transaction(async tx => {
      await recoverExpiredMaintenanceWith(tx, input.now);
      gateLocked();
      await gateRelease;
    });
    await gateReady;
    expect(await promptly(service.processNextPage(input.requestId))).toBe(false);
    expect(calls).toEqual({ stenographer: 0, reflection: 0, memory: 0 });
    const [afterGateContention] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(afterGateContention?.progress).toBeNull();
    releaseGate();
    await gateBlocker;

    let workLocked!: () => void;
    const workReady = new Promise<void>(resolve => { workLocked = resolve; });
    workBlocker = db.transaction(async tx => {
      await tx.select().from(memoryRecoveryRuns)
        .where(eq(memoryRecoveryRuns.id, markerId)).for("update");
      workLocked();
      await workRelease;
    });
    await workReady;

    expect(await promptly(service.processNextPage(input.requestId))).toBe(true);
    const [afterWorkContention] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(afterWorkContention).toMatchObject({
      stenographer: null,
      progress: { stenographer: { state: "assessed", queued: 0, held: 0, after: null, pages: 1 } },
    });
    // The failed page transaction no longer retains the singleton gate.
    expect((await promptly(recoverExpiredMaintenanceWith(db, input.now))).snapshot.state).toBe("normal");
    // Lower-round lanes run before the contended lane is attempted again.
    expect(await service.processNextPage(input.requestId)).toBe(true);
    expect(await service.processNextPage(input.requestId)).toBe(true);
    expect(calls).toEqual({ stenographer: 1, reflection: 1, memory: 1 });
    // Once the other lanes have caught up, another collision requests normal
    // scheduler backoff instead of spinning on the same work lock.
    expect(await promptly(service.processNextPage(input.requestId))).toBe(false);
    const [afterBackoff] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(afterBackoff?.progress?.stenographer).toMatchObject({ after: null, pages: 2 });

    releaseWork();
    await workBlocker;
    expect(await service.processNextPage(input.requestId)).toBe(true);
    const [saved] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(saved).toMatchObject({
      stenographer: completed, reflection: completed, memory: completed, progress: {},
    });
    expect(calls).toEqual({ stenographer: 3, reflection: 1, memory: 1 });
  } finally {
    releaseGate();
    releaseWork();
    const blockers: Promise<unknown>[] = [];
    if (gateBlocker) blockers.push(gateBlocker);
    if (workBlocker) blockers.push(workBlocker);
    await Promise.allSettled(blockers);
    await db.delete(memoryRecoveryRuns).where(inArray(memoryRecoveryRuns.id, [input.requestId, markerId]));
  }
});

test("persisted service order lets a newer request finish while an older request remains contended", async () => {
  const older = {
    requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date(Date.now() - 1_000),
  };
  const newer = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const markerId = randomUUID();
  const completed = { state: "assessed", queued: 0, held: 0 } as const;
  let releaseWork!: () => void;
  const workRelease = new Promise<void>(resolve => { releaseWork = resolve; });
  let workBlocker: Promise<unknown> | undefined;
  const createService = () => createManualMemoryRecovery({
    db: () => db,
    assertAvailable: async () => {},
    pageAvailable: async () => true,
    pageSize: 1,
    pollMs: 1_000,
    lockTimeoutMs: 50,
    onError: () => {},
    recover: {
      stenographer: async ({ db: tx, authorizedBy }) => {
        if (authorizedBy === older.authorizedBy) {
          await tx.select().from(memoryRecoveryRuns)
            .where(eq(memoryRecoveryRuns.id, markerId)).for("update");
        }
        return completed;
      },
      reflection: async () => completed,
      memory: async () => completed,
    },
  });
  try {
    await db.insert(memoryRecoveryRuns).values({
      id: markerId, authorizedBy: older.authorizedBy, observedThrough: older.now,
      stenographer: completed, reflection: completed, memory: completed,
    });
    const firstCoordinator = createService();
    await firstCoordinator.request(older);

    let workLocked!: () => void;
    const workReady = new Promise<void>(resolve => { workLocked = resolve; });
    workBlocker = db.transaction(async tx => {
      await tx.select().from(memoryRecoveryRuns)
        .where(eq(memoryRecoveryRuns.id, markerId)).for("update");
      workLocked();
      await workRelease;
    });
    await workReady;
    expect(await promptly(firstCoordinator.processNextPage(older.requestId))).toBe(true);
    const [contended] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, older.requestId));
    expect(contended?.progress?.lastServicedAt).toBeString();

    await firstCoordinator.request(newer);
    // A fresh coordinator must use only durable progress to rotate requests.
    const restartedCoordinator = createService();
    for (let attempt = 0; attempt < 8; ++attempt) {
      await promptly(restartedCoordinator.processNextPage());
      const [receipt] = await db.select().from(memoryRecoveryRuns)
        .where(eq(memoryRecoveryRuns.id, newer.requestId));
      if (receipt?.stenographer && receipt.reflection && receipt.memory) break;
    }
    const [olderWhileLocked, newerFinished] = await Promise.all([
      db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, older.requestId)).then(rows => rows[0]),
      db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, newer.requestId)).then(rows => rows[0]),
    ]);
    expect(olderWhileLocked?.stenographer).toBeNull();
    expect(newerFinished).toMatchObject({
      stenographer: completed, reflection: completed, memory: completed,
    });

    releaseWork();
    await workBlocker;
    expect(await restartedCoordinator.processNextPage(older.requestId)).toBe(true);
    const [olderFinished] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, older.requestId));
    expect(olderFinished).toMatchObject({
      stenographer: completed, reflection: completed, memory: completed,
    });
  } finally {
    releaseWork();
    if (workBlocker) await Promise.allSettled([workBlocker]);
    await db.delete(memoryRecoveryRuns).where(inArray(memoryRecoveryRuns.id, [
      older.requestId, newer.requestId, markerId,
    ]));
  }
});
