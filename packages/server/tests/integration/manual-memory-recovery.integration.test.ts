import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDirectDb, eq, inArray, memoryRecoveryRuns, recoverExpiredMaintenanceWith } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createManualMemoryRecovery } from "../../src/lib/manual-memory-recovery";

let db: ReturnType<typeof createDirectDb>;
beforeAll(() => { bootstrapTestDbInstance(); db = createDirectDb(4); });
afterAll(async () => { await db?.end(); });

const defaultTargets = {
  stenographer: "openai:journal-at-click",
  reflection: "venice:reflection-at-click",
  memory: "surplus:memory-at-click",
};

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
    resolveTargets: async () => defaultTargets,
    pageAvailable: async () => !maintenance,
    pageSize: 1, pollMs: 1000, db: () => db, assertAvailable: async () => { if (maintenance) throw new Error("maintenance"); }, onError: () => {},
    recover: {
      stenographer: async ({ observedThrough, authorizedBy, modelId, page }) => {
        expect(authorizedBy).toBe(input.authorizedBy);
        expect(modelId).toBe(defaultTargets.stenographer);
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

test("one click pins every configured model and authorizer across config changes, pages, duplicates, and restart", async () => {
  const click = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const laterOperator = randomUUID();
  let configured = {
    stenographer: "openai:gpt-at-click",
    reflection: "venice:llama-at-click",
    memory: "surplus:review-at-click",
  };
  let resolutions = 0;
  const observed: Record<keyof typeof configured, Array<{
    modelId: string; authorizedBy: string; after: string | null;
  }>> = { stenographer: [], reflection: [], memory: [] };
  type Recover = Parameters<typeof createManualMemoryRecovery>[0]["recover"]["stenographer"];
  const recoverLane = (lane: keyof typeof observed): Recover =>
    async ({ modelId, authorizedBy, page }) => {
      observed[lane].push({ modelId, authorizedBy, after: page.after });
      return page.after === null
        ? { state: "assessed", queued: 1, held: 0, nextCursor: `${lane}-next` }
        : { state: "assessed", queued: 1, held: 0 };
    };
  const createService = () => createManualMemoryRecovery({
    db: () => db,
    assertAvailable: async () => {},
    resolveTargets: async () => { resolutions++; return { ...configured }; },
    pageAvailable: async () => true,
    pageSize: 1,
    pollMs: 1_000,
    onError: () => {},
    recover: {
      stenographer: recoverLane("stenographer"),
      reflection: recoverLane("reflection"),
      memory: recoverLane("memory"),
    },
  });
  const pinned = { ...configured };
  try {
    const first = await createService().request(click);
    configured = {
      stenographer: "venice:changed-after-click",
      reflection: "surplus:changed-after-click",
      memory: "openai:changed-after-click",
    };
    const duplicate = await createService().request({
      ...click,
      authorizedBy: laterOperator,
      now: new Date(click.now.getTime() + 60_000),
    });
    expect(duplicate).toEqual(first);
    expect(resolutions).toBe(1);

    // Recreate the coordinator for every page to prove only durable state is used.
    while (await createService().processNextPage(click.requestId)) { /* drain */ }
    for (const lane of Object.keys(observed) as Array<keyof typeof observed>) {
      expect(observed[lane]).toEqual([
        { modelId: pinned[lane], authorizedBy: click.authorizedBy, after: null },
        { modelId: pinned[lane], authorizedBy: click.authorizedBy, after: `${lane}-next` },
      ]);
    }
    const [saved] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, click.requestId));
    expect(saved).toMatchObject({
      authorizedBy: click.authorizedBy,
      observedThrough: click.now,
      progress: { targets: pinned },
      stenographer: { state: "assessed", queued: 2, held: 0 },
      reflection: { state: "assessed", queued: 2, held: 0 },
      memory: { state: "assessed", queued: 2, held: 0 },
    });
  } finally {
    await db.delete(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, click.requestId));
  }
});

test("an unavailable lane is held without blocking pinned lanes or activating after config change", async () => {
  const requestId = randomUUID();
  let targets: Partial<typeof defaultTargets> = {
    stenographer: defaultTargets.stenographer,
    reflection: defaultTargets.reflection,
  };
  const createService = () => createManualMemoryRecovery({
    db: () => db,
    assertAvailable: async () => {},
    resolveTargets: async () => targets,
    pageAvailable: async () => true,
    pageSize: 1,
    pollMs: 1_000,
    onError: () => {},
    recover: {
      stenographer: async () => ({ state: "assessed", queued: 0, held: 0 }),
      reflection: async () => ({ state: "assessed", queued: 0, held: 0 }),
      memory: async () => ({ state: "assessed", queued: 0, held: 0 }),
    },
  });
  try {
    await createService().request({ requestId, authorizedBy: randomUUID(), now: new Date() });
    targets = defaultTargets;
    while (await createService().processNextPage(requestId)) { /* drain */ }
    const [saved] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, requestId));
    expect(saved).toMatchObject({
      stenographer: { state: "assessed" },
      reflection: { state: "assessed" },
      memory: { state: "unavailable" },
      progress: { targets: {
        stenographer: defaultTargets.stenographer,
        reflection: defaultTargets.reflection,
      } },
    });
  } finally {
    await db.delete(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, requestId));
  }
});

test("a legacy receipt without model targets is held until an explicit new click", async () => {
  const input = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const replacement = { ...input, requestId: randomUUID(), now: new Date(input.now.getTime() + 1) };
  const completed = { state: "assessed", queued: 0, held: 0 } as const;
  let wakeCount = 0;
  const service = createManualMemoryRecovery({
    resolveTargets: async () => defaultTargets,
    db: () => db, assertAvailable: async () => {}, pageAvailable: async () => true,
    pageSize: 1, pollMs: 25, onError: () => {},
    wakeMemory: () => { ++wakeCount; },
    recover: {
      stenographer: async () => completed, reflection: async () => completed,
      memory: async input => {
        expect(input.page).toEqual({ after: null, limit: 1 });
        return { ...completed, queued: 1 };
      },
    },
  });
  try {
    // Old receipts have no target object. The worker must keep completed
    // lanes intact but may not infer authority for the remaining lane.
    await db.insert(memoryRecoveryRuns).values({
      id: input.requestId, authorizedBy: input.authorizedBy, observedThrough: input.now,
      stenographer: completed, reflection: completed,
    });
    service.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    const [saved] = await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, input.requestId));
    expect(saved?.memory).toEqual({ state: "unavailable" });
    expect(wakeCount).toBe(0);

    await service.request(replacement);
    while (await service.processNextPage(replacement.requestId)) { /* drain */ }
    const [recovered] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, replacement.requestId));
    expect(recovered).toMatchObject({
      stenographer: completed,
      reflection: completed,
      memory: { ...completed, queued: 1 },
      progress: { targets: defaultTargets },
    });
    expect(wakeCount).toBe(1);
  } finally {
    await service.stop();
    await db.delete(memoryRecoveryRuns).where(inArray(memoryRecoveryRuns.id, [
      input.requestId, replacement.requestId,
    ]));
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
    resolveTargets: async () => defaultTargets,
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
    expect(afterGateContention?.progress).toEqual({ targets: defaultTargets });
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
      stenographer: completed, reflection: completed, memory: completed,
      progress: { targets: defaultTargets },
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
    resolveTargets: async () => defaultTargets,
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
