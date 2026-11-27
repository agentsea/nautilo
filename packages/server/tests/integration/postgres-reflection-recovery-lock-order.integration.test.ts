import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb,
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  eq,
  inArray,
  memoryRecoveryRuns,
  reflectionRecords,
  reflectionRecordSemanticWork,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createHmacRecordSemanticCommitmentPort,
  PostgresSemanticWorkStore,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";
import { createManualMemoryRecovery } from "../../src/lib/manual-memory-recovery";

let db: ReturnType<typeof createDirectDb>;

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);
});

afterAll(async () => {
  await db?.end();
});

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle promptly")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function insertProviderHolds(
  connection: Pick<typeof db, "insert">, recordIds: readonly string[], updatedAt: Date,
): Promise<void> {
  await connection.insert(reflectionRecords).values(recordIds.map(recordId => ({
    recordId,
    lifecycle: "current" as const,
    structuralHeight: 1,
    producerPolicyVersion: "reflection-lock-regression-v1",
    processingGeneration: 1,
    createdAt: updatedAt,
    updatedAt,
  })));
  await connection.insert(reflectionRecordSemanticWork).values(recordIds.map(recordId => ({
    recordId,
    generation: 1,
    completedGeneration: 1,
    changeReason: "created" as const,
    stage: "organization" as const,
    state: "complete" as const,
    completionOutcome: "provider_outcome_unknown" as const,
    acceptedModelBinding: {
      version: 1 as const,
      kind: "service" as const,
      role: "memoryReflection" as const,
      modelId: "surplus:synthetic-model",
      inputCommitment: `hmac-sha256:${"V".repeat(43)}`,
    },
    acceptedModelBindingGeneration: 1,
    dueSince: updatedAt,
    completedAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
  })));
}

async function insertDerivedRepairHolds(
  recordIds: readonly string[],
  updatedAt: Date,
): Promise<void> {
  await db.insert(reflectionRecords).values(recordIds.map(recordId => ({
    recordId,
    lifecycle: "current" as const,
    structuralHeight: 1,
    producerPolicyVersion: "candidate-policy-v1",
    processingGeneration: 1,
    createdAt: updatedAt,
    updatedAt,
  })));
  await db.insert(reflectionRecordSemanticWork).values(recordIds.map(recordId => ({
    recordId,
    generation: 8,
    completedGeneration: 0,
    changeReason: "dependency_lost" as const,
    stage: "organization" as const,
    state: "quarantined" as const,
    attemptCount: 8,
    quarantineRound: 8,
    failureCode: "candidate_unavailable" as const,
    failureDetail: "candidate_selection_invalid" as const,
    recoverAfter: updatedAt,
    dueSince: updatedAt,
    startedAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
  })));
}

async function deleteProviderHolds(recordIds: readonly string[]): Promise<void> {
  await db.update(reflectionRecords).set({ disposition: "purged" })
    .where(inArray(reflectionRecords.recordId, recordIds));
  await db.delete(reflectionRecordSemanticWork)
    .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
}

test("cross-record manual recoveries do not invert retained repair row locks", async () => {
  const suffix = randomUUID();
  const recordIds = [
    `reflection-lock-${suffix}-a`,
    `reflection-lock-${suffix}-b`,
  ] as const;
  const observedThrough = new Date("2004-05-06T07:08:09.000Z");
  const now = new Date(observedThrough.getTime() + 1_000);
  const firstReady = deferred();
  const secondReady = deferred();
  await insertDerivedRepairHolds(recordIds, observedThrough);
  try {
    const contend = async (
      ownedRecordId: string,
      ready: ReturnType<typeof deferred>,
      otherReady: ReturnType<typeof deferred>,
    ) => createPostgresJsCanonicalBridgeConnection(db).transaction(
      async (tx, executor) => {
        // Derived-lineage repair performs this same work-row write before the
        // provider-recovery scan and retains its lock in the outer request.
        await tx.update(reflectionRecordSemanticWork).set({
          recoverAfter: now,
          updatedAt: now,
        }).where(eq(reflectionRecordSemanticWork.recordId, ownedRecordId));
        ready.resolve();
        await otherReady.promise;
        const handle = await verifyRecordProductPostgresHandle({
          query: executor.query.bind(executor),
          transaction: use => use(executor),
        });
        return new PostgresSemanticWorkStore({
          handle,
          commitments: createHmacRecordSemanticCommitmentPort(
            new Uint8Array(32).fill(26),
          ),
          clock: () => now,
        }).requestManualProviderRecovery({
          now,
          observedThrough,
          authorizedBy: randomUUID(),
          modelId: "surplus:synthetic-model",
        });
      },
      { isolationLevel: "read committed" },
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      Promise.all([
        contend(recordIds[0], firstReady, secondReady),
        contend(recordIds[1], secondReady, firstReady),
      ]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("cross-record recovery lock wait did not settle")),
          5_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    expect(results).toEqual([
      { queued: 0, held: 1 },
      { queued: 0, held: 1 },
    ]);
  } finally {
    await deleteProviderHolds(recordIds);
  }
}, 15_000);

test("manual recovery does not wait on a normal admission advisory contender", async () => {
  const recordId = `reflection-lock-${randomUUID()}-admission`;
  const observedThrough = new Date("2004-05-06T07:08:09.000Z");
  const now = new Date(observedThrough.getTime() + 1_000);
  const advisoryHeld = deferred();
  const releaseAdvisory = deferred();
  await insertProviderHolds(db, [recordId], observedThrough);
  let blocker: Promise<void> | undefined;
  try {
    blocker = createPostgresJsCanonicalBridgeConnection(db).transaction(
      async (_tx, executor) => {
        await executor.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`reflection-semantic-work:${recordId}`],
        );
        advisoryHeld.resolve();
        await releaseAdvisory.promise;
      },
      { isolationLevel: "read committed" },
    );
    await advisoryHeld.promise;
    const handle = await verifyRecordProductPostgresHandle(
      createPostgresJsBridgeConnection(db),
    );
    const store = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(27)),
      clock: () => now,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    expect(await Promise.race([
      store.requestManualProviderRecovery({
        now,
        observedThrough,
        authorizedBy: randomUUID(),
        modelId: "surplus:synthetic-model",
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("manual recovery waited on normal admission")),
          2_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout))).toEqual({ queued: 1, held: 0 });
  } finally {
    releaseAdvisory.resolve();
    await Promise.allSettled(blocker === undefined ? [] : [blocker]);
    await deleteProviderHolds([recordId]);
  }
}, 15_000);

test("family-key pages recover interleaved paid families once and advance past ineligible families", async () => {
  const suffix = randomUUID();
  const recordIds = {
    familyAFirst: `reflection-page-${suffix}-a`,
    familyB: `reflection-page-${suffix}-b`,
    ineligible: `reflection-page-${suffix}-c`,
    familyALast: `reflection-page-${suffix}-z`,
  } as const;
  const allRecordIds = Object.values(recordIds);
  const observedThrough = new Date("2004-05-06T07:09:09.000Z");
  const now = new Date(observedThrough.getTime() + 1_000);
  const binding = (marker: string, modelId: string) => ({
    version: 1 as const,
    kind: "service" as const,
    role: "memoryReflection" as const,
    modelId,
    inputCommitment: `hmac-sha256:${marker.repeat(43)}`,
  });
  const familyA = binding("A", "surplus:model\\with-backslash");
  const familyB = binding("B", "surplus:other-model");
  await db.insert(reflectionRecords).values(allRecordIds.map(recordId => ({
    recordId,
    lifecycle: "current" as const,
    structuralHeight: 1,
    producerPolicyVersion: "reflection-page-regression-v1",
    processingGeneration: 1,
    createdAt: observedThrough,
    updatedAt: observedThrough,
  })));
  await db.insert(reflectionRecordSemanticWork).values([
    { recordId: recordIds.familyAFirst, acceptedModelBinding: familyA },
    { recordId: recordIds.familyB, acceptedModelBinding: familyB },
    { recordId: recordIds.ineligible, acceptedModelBinding: null },
    { recordId: recordIds.familyALast, acceptedModelBinding: familyA },
  ].map(({ recordId, acceptedModelBinding }) => ({
    recordId,
    generation: 1,
    completedGeneration: 1,
    changeReason: "created" as const,
    stage: "organization" as const,
    state: "complete" as const,
    completionOutcome: "provider_outcome_unknown" as const,
    acceptedModelBinding,
    acceptedModelBindingGeneration: acceptedModelBinding === null ? null : 1,
    dueSince: observedThrough,
    completedAt: observedThrough,
    createdAt: observedThrough,
    updatedAt: observedThrough,
  })));
  try {
    const handle = await verifyRecordProductPostgresHandle(
      createPostgresJsBridgeConnection(db),
    );
    const store = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(31)),
      clock: () => now,
    });
    let cursor: string | null = null;
    let queued = 0;
    let held = 0;
    let pages = 0;
    do {
      const page = await store.requestManualProviderRecovery({
        now,
        observedThrough,
        authorizedBy: randomUUID(),
        modelId: "surplus:synthetic-model",
        page: { after: cursor, limit: 1 },
      });
      queued += page.queued;
      held += page.held;
      cursor = page.nextCursor ?? null;
      pages += 1;
      expect(pages).toBeLessThan(6);
    } while (cursor !== null);
    expect({ queued, held, pages }).toEqual({ queued: 3, held: 1, pages: 4 });

    const stored = await db.select({
      recordId: reflectionRecordSemanticWork.recordId,
      generation: reflectionRecordSemanticWork.generation,
      recoveryId: reflectionRecordSemanticWork.manualRecoveryId,
    }).from(reflectionRecordSemanticWork).where(inArray(
      reflectionRecordSemanticWork.recordId,
      allRecordIds,
    ));
    const byId = new Map(stored.map(row => [row.recordId, row]));
    expect(byId.get(recordIds.familyAFirst)?.generation).toBe(2);
    expect(byId.get(recordIds.familyALast)?.generation).toBe(2);
    expect(byId.get(recordIds.familyAFirst)?.recoveryId).toBe(
      byId.get(recordIds.familyALast)?.recoveryId,
    );
    expect(byId.get(recordIds.familyB)).toMatchObject({ generation: 2 });
    expect(byId.get(recordIds.ineligible)).toMatchObject({
      generation: 1,
      recoveryId: null,
    });
  } finally {
    await deleteProviderHolds(allRecordIds);
  }
}, 15_000);

test("manual recovery holds a whole paid family when crash settlement left hidden siblings", async () => {
  for (const paged of [false, true]) {
    const suffix = randomUUID();
    const recordIds = {
      terminal: `reflection-whole-family-${suffix}-terminal`,
      checkpointed: `reflection-whole-family-${suffix}-checkpointed`,
      cutoff: `reflection-whole-family-${suffix}-cutoff`,
      excluded: `reflection-whole-family-${suffix}-excluded`,
      independent: `reflection-whole-family-${suffix}-independent`,
    } as const;
    const allRecordIds = Object.values(recordIds);
    const observedThrough = new Date("2004-05-06T07:09:39.000Z");
    const now = new Date(observedThrough.getTime() + 1_000);
    const familyBinding = {
      version: 1 as const,
      kind: "service" as const,
      role: "memoryReflection" as const,
      modelId: "surplus:synthetic-model",
      inputCommitment: `hmac-sha256:${"F".repeat(43)}`,
    };
    const independentBinding = {
      ...familyBinding,
      inputCommitment: `hmac-sha256:${"I".repeat(43)}`,
    };
    await db.insert(reflectionRecords).values(allRecordIds.map(recordId => ({
      recordId,
      lifecycle: "current" as const,
      structuralHeight: 1,
      producerPolicyVersion: "reflection-whole-family-v1",
      processingGeneration: 1,
      createdAt: observedThrough,
      updatedAt: observedThrough,
    })));
    await db.update(reflectionRecords).set({ disposition: "blocked" })
      .where(eq(reflectionRecords.recordId, recordIds.excluded));
    const terminal = (recordId: string, binding: typeof familyBinding, updatedAt: Date) => ({
      recordId,
      generation: 1,
      completedGeneration: 1,
      changeReason: "created" as const,
      stage: "organization" as const,
      state: "complete" as const,
      completionOutcome: "provider_outcome_unknown" as const,
      acceptedModelBinding: binding,
      acceptedModelBindingGeneration: 1,
      dueSince: observedThrough,
      completedAt: observedThrough,
      createdAt: observedThrough,
      updatedAt,
    });
    await db.insert(reflectionRecordSemanticWork).values([
      terminal(recordIds.terminal, familyBinding, observedThrough),
      {
        recordId: recordIds.checkpointed,
        generation: 1,
        changeReason: "created" as const,
        stage: "organization" as const,
        state: "checkpointed" as const,
        acceptedModelBinding: familyBinding,
        acceptedModelBindingGeneration: 1,
        nextAttemptAt: now,
        dueSince: observedThrough,
        startedAt: observedThrough,
        createdAt: observedThrough,
        updatedAt: observedThrough,
      },
      terminal(recordIds.cutoff, familyBinding, now),
      terminal(recordIds.excluded, familyBinding, observedThrough),
      terminal(recordIds.independent, independentBinding, observedThrough),
    ]);
    try {
      const handle = await verifyRecordProductPostgresHandle(
        createPostgresJsBridgeConnection(db),
      );
      const store = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(33)),
        clock: () => now,
      });
      let cursor: string | null = null;
      let queued = 0;
      let held = 0;
      do {
        const result = await store.requestManualProviderRecovery({
          now,
          observedThrough,
          authorizedBy: randomUUID(),
          modelId: "surplus:synthetic-model",
          ...(paged ? { page: { after: cursor, limit: 1 } } : {}),
        });
        queued += result.queued;
        held += result.held;
        cursor = paged ? result.nextCursor ?? null : null;
      } while (cursor !== null);
      expect({ paged, queued, held }).toEqual({ paged, queued: 1, held: 4 });

      const stored = await db.select({
        recordId: reflectionRecordSemanticWork.recordId,
        generation: reflectionRecordSemanticWork.generation,
        state: reflectionRecordSemanticWork.state,
        recoveryId: reflectionRecordSemanticWork.manualRecoveryId,
      }).from(reflectionRecordSemanticWork).where(inArray(
        reflectionRecordSemanticWork.recordId,
        allRecordIds,
      ));
      const byId = new Map(stored.map(row => [row.recordId, row]));
      for (const recordId of allRecordIds.slice(0, 4)) {
        expect(byId.get(recordId)).toMatchObject({ generation: 1, recoveryId: null });
      }
      expect(byId.get(recordIds.checkpointed)?.state).toBe("checkpointed");
      expect(byId.get(recordIds.independent)).toMatchObject({
        generation: 2,
        state: "due",
      });
      expect(byId.get(recordIds.independent)?.recoveryId).toBeString();
    } finally {
      await deleteProviderHolds(allRecordIds);
    }
  }
}, 15_000);

test("a partially bound existing grant stays one family across page selection and row contention", async () => {
  const suffix = randomUUID();
  const recordIds = [
    `reflection-grant-page-${suffix}-bound`,
    `reflection-grant-page-${suffix}-unbound`,
    `reflection-grant-page-${suffix}-other-grant`,
    `reflection-grant-page-${suffix}-spent-a`,
    `reflection-grant-page-${suffix}-spent-b`,
    `reflection-grant-page-${suffix}-unrelated`,
  ] as const;
  const recoveryId = "11111111-1111-4111-8111-111111111111";
  const otherRecoveryId = "55555555-5555-4555-8555-555555555555";
  const spentRecoveryIds = [
    "33333333-3333-4333-8333-333333333333",
    "77777777-7777-4777-8777-777777777777",
  ] as const;
  const unrelatedRecoveryId = "44444444-4444-4444-8444-444444444444";
  const authorizedBy = randomUUID();
  const observedThrough = new Date("2004-05-06T07:10:09.000Z");
  const serviceBinding = {
    version: 1 as const,
    kind: "service" as const,
    role: "memoryReflection" as const,
    modelId: "surplus:synthetic-model",
    inputCommitment: `hmac-sha256:${"G".repeat(43)}`,
  };
  const unrelatedBinding = {
    ...serviceBinding,
    inputCommitment: `hmac-sha256:${"U".repeat(43)}`,
  };
  await db.insert(reflectionRecords).values(recordIds.map(recordId => ({
    recordId,
    lifecycle: "current" as const,
    structuralHeight: 1,
    producerPolicyVersion: "reflection-grant-page-v1",
    processingGeneration: 2,
    createdAt: observedThrough,
    updatedAt: observedThrough,
  })));
  const recovery = {
    manualRecoveryId: recoveryId,
    manualRecoverySourceGeneration: 1,
    manualRecoveryAuthorizedBy: authorizedBy,
    manualRecoveryAuthorizedAt: observedThrough,
    manualRecoveryObservedThrough: observedThrough,
    manualRecoveryServiceModelId: "surplus:synthetic-model",
    manualRecoverySpentAt: null,
  } as const;
  await db.insert(reflectionRecordSemanticWork).values([{
    recordId: recordIds[0],
    generation: 2,
    changeReason: "created",
    stage: "organization",
    state: "quarantined",
    attemptCount: 1,
    quarantineRound: 1,
    acceptedModelBinding: serviceBinding,
    acceptedModelBindingGeneration: 2,
    failureCode: "authority_unavailable",
    recoverAfter: observedThrough,
    dueSince: observedThrough,
    startedAt: observedThrough,
    createdAt: observedThrough,
    updatedAt: observedThrough,
    ...recovery,
  }, {
    recordId: recordIds[1],
    generation: 2,
    changeReason: "created",
    stage: "organization",
    state: "quarantined",
    attemptCount: 1,
    quarantineRound: 1,
    failureCode: "unexpected_failure",
    failureDetail: "unexpected_model_invocation_failure",
    recoverAfter: observedThrough,
    dueSince: observedThrough,
    startedAt: observedThrough,
    createdAt: observedThrough,
    updatedAt: observedThrough,
    ...recovery,
  }, {
    recordId: recordIds[2],
    generation: 2,
    changeReason: "created",
    stage: "organization",
    state: "quarantined",
    attemptCount: 1,
    quarantineRound: 1,
    acceptedModelBinding: serviceBinding,
    acceptedModelBindingGeneration: 2,
    failureCode: "authority_unavailable",
    recoverAfter: observedThrough,
    dueSince: observedThrough,
    startedAt: observedThrough,
    createdAt: observedThrough,
    updatedAt: observedThrough,
    ...recovery,
    manualRecoveryId: otherRecoveryId,
  }, ...recordIds.slice(3, 5).map((recordId, index) => ({
    recordId,
    generation: 2,
    completedGeneration: 2,
    changeReason: "created" as const,
    stage: "organization" as const,
    state: "complete" as const,
    completionOutcome: "provider_outcome_unknown" as const,
    acceptedModelBinding: serviceBinding,
    acceptedModelBindingGeneration: 2,
    dueSince: observedThrough,
    startedAt: observedThrough,
    completedAt: observedThrough,
    createdAt: observedThrough,
    updatedAt: observedThrough,
    ...recovery,
    manualRecoveryId: spentRecoveryIds[index]!,
    manualRecoverySpentAt: observedThrough,
  })), {
    recordId: recordIds[5],
    generation: 2,
    changeReason: "created",
    stage: "organization",
    state: "quarantined",
    attemptCount: 1,
    quarantineRound: 1,
    acceptedModelBinding: unrelatedBinding,
    acceptedModelBindingGeneration: 2,
    failureCode: "authority_unavailable",
    recoverAfter: observedThrough,
    dueSince: observedThrough,
    startedAt: observedThrough,
    createdAt: observedThrough,
    updatedAt: observedThrough,
    ...recovery,
    manualRecoveryId: unrelatedRecoveryId,
  }]);
  const locked = deferred();
  const release = deferred();
  const requestId = randomUUID();
  let blocker: Promise<void> | undefined;
  const completed = { state: "assessed", queued: 0, held: 0 } as const;
  const calls = { reflection: 0, memory: 0 };
  const coordinator = createManualMemoryRecovery({
    db: () => db,
    assertAvailable: async () => {},
    resolveTargets: async () => ({
      stenographer: "test:stenographer",
      reflection: "surplus:synthetic-model",
      memory: "test:memory",
    }),
    pageAvailable: async () => true,
    pageSize: 1,
    pollMs: 1_000,
    lockTimeoutMs: 100,
    onError: () => {},
    recover: {
      stenographer: async () => completed,
      reflection: async ({ executor, now: pageNow, observedThrough, authorizedBy, page }) => {
        calls.reflection += 1;
        const handle = await verifyRecordProductPostgresHandle({
          query: executor.query.bind(executor),
          transaction: use => use(executor),
        });
        const result = await new PostgresSemanticWorkStore({
          handle,
          commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(32)),
          clock: () => pageNow,
        }).requestManualProviderRecovery({
          now: pageNow,
          observedThrough,
          authorizedBy,
          modelId: "surplus:synthetic-model",
          page,
        });
        return { state: "assessed" as const, ...result };
      },
      memory: async ({ page }) => {
        calls.memory += 1;
        const current = page.after === null ? 0 : Number(page.after.slice(1));
        return current < 6
          ? { ...completed, nextCursor: `m${current + 1}` }
          : completed;
      },
    },
  });
  try {
    await coordinator.request({ requestId, authorizedBy, now: observedThrough });
    blocker = db.transaction(async tx => {
      await tx.select({ recordId: reflectionRecordSemanticWork.recordId })
        .from(reflectionRecordSemanticWork)
        .where(eq(reflectionRecordSemanticWork.recordId, recordIds[0]))
        .for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const predecessor = `recovery:${otherRecoveryId}`;
    // Stenographer finishes first. Reflection and the deliberately long Memory
    // lane then alternate through durable page progress.
    expect(await coordinator.processNextPage(requestId)).toBe(true);
    let beforeContention: typeof memoryRecoveryRuns.$inferSelect | undefined;
    let lastObserved: typeof memoryRecoveryRuns.$inferSelect | undefined;
    for (let attempt = 0; attempt < 20; ++attempt) {
      const [saved] = await db.select().from(memoryRecoveryRuns)
        .where(eq(memoryRecoveryRuns.id, requestId));
      lastObserved = saved;
      const reflection = saved?.progress?.reflection;
      const memory = saved?.progress?.memory;
      if (reflection?.after === predecessor
        && (memory?.pages ?? 0) === reflection.pages) {
        beforeContention = saved;
        break;
      }
      expect(await promptly(coordinator.processNextPage(requestId))).toBe(true);
    }
    if (beforeContention === undefined) {
      throw new Error(`durable Reflection cursor did not reach its locked family: ${JSON.stringify({
        calls,
        progress: lastObserved?.progress,
        reflection: lastObserved?.reflection,
        memory: lastObserved?.memory,
      })}`);
    }
    expect(beforeContention?.progress?.reflection).toMatchObject({
      state: "assessed",
      queued: 1,
      held: 0,
      after: predecessor,
    });
    const reflectionCallsBefore = calls.reflection;
    const memoryCallsBefore = calls.memory;
    const contentionResult = await promptly(coordinator.processNextPage(requestId));
    const [contended] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, requestId));
    if (!contentionResult) {
      throw new Error(`durable Reflection contention escaped its savepoint: ${JSON.stringify({
        calls,
        progress: contended?.progress,
        reflection: contended?.reflection,
        memory: contended?.memory,
      })}`);
    }
    expect(calls.reflection).toBe(reflectionCallsBefore + 1);
    expect(calls.memory).toBe(memoryCallsBefore);
    expect(contended?.progress?.reflection).toMatchObject({
      state: "assessed",
      queued: 1,
      held: 0,
      after: predecessor,
      pages: (beforeContention?.progress?.reflection?.pages ?? 0) + 1,
    });
    // The coordinator persisted the contention round without moving the seed,
    // then gives the lower-round Memory lane its promised turn.
    expect(await promptly(coordinator.processNextPage(requestId))).toBe(true);
    expect(calls.memory).toBe(memoryCallsBefore + 1);

    release.resolve();
    await blocker;
    blocker = undefined;
    for (let attempt = 0; attempt < 20; ++attempt) {
      const [saved] = await db.select().from(memoryRecoveryRuns)
        .where(eq(memoryRecoveryRuns.id, requestId));
      if (saved?.stenographer && saved.reflection && saved.memory) break;
      await promptly(coordinator.processNextPage(requestId));
    }
    const [receipt] = await db.select().from(memoryRecoveryRuns)
      .where(eq(memoryRecoveryRuns.id, requestId));
    expect(receipt).toMatchObject({
      stenographer: completed,
      reflection: { state: "assessed", queued: 1, held: 5 },
      memory: completed,
    });
    const stored = await db.select({
      recordId: reflectionRecordSemanticWork.recordId,
      generation: reflectionRecordSemanticWork.generation,
      recoveryId: reflectionRecordSemanticWork.manualRecoveryId,
      recoverAfter: reflectionRecordSemanticWork.recoverAfter,
    }).from(reflectionRecordSemanticWork).where(inArray(
      reflectionRecordSemanticWork.recordId,
      recordIds,
    ));
    expect(stored).toHaveLength(6);
    const byId = new Map(stored.map(row => [row.recordId, row]));
    expect(byId.get(recordIds[0])?.recoveryId).toBe(recoveryId);
    expect(byId.get(recordIds[1])?.recoveryId).toBe(recoveryId);
    expect(byId.get(recordIds[2])?.recoveryId).toBe(otherRecoveryId);
    expect(recordIds.slice(0, 3).every(recordId =>
      byId.get(recordId)?.recoverAfter?.getTime() === observedThrough.getTime()))
      .toBe(true);
    expect(byId.get(recordIds[3])).toMatchObject({
      generation: 2,
      recoveryId: spentRecoveryIds[0],
    });
    expect(byId.get(recordIds[4])).toMatchObject({
      generation: 2,
      recoveryId: spentRecoveryIds[1],
    });
    expect(byId.get(recordIds[5])).toMatchObject({
      generation: 2,
      recoveryId: unrelatedRecoveryId,
    });
    expect(byId.get(recordIds[5])?.recoverAfter?.getTime())
      .toBeGreaterThan(observedThrough.getTime());
  } finally {
    release.resolve();
    await Promise.allSettled(blocker === undefined ? [] : [blocker]);
    await db.delete(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, requestId));
    await deleteProviderHolds(recordIds);
  }
}, 15_000);

test("manual recovery assesses more than 65,535 candidates with bounded binds", async () => {
  const rollback = new Error("rollback large Reflection recovery fixture");
  const prefix = `zz-reflection-large-${randomUUID()}-`;
  const candidateCount = 65_536;
  const controlRecordId = `${prefix}control`;
  const observedThrough = new Date("2005-06-07T08:09:10.000Z");
  const now = new Date(observedThrough.getTime() + 1_000);
  try {
    await createPostgresJsCanonicalBridgeConnection(db).transaction(
      async (tx, executor) => {
        await executor.query(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height, producer_policy_version,
             processing_generation, created_at, updated_at
           )
           SELECT $1 || 'held-' || lpad(series::text, 6, '0'),
                  'current', 1, 'candidate-policy-v1', 1, $3, $3
             FROM generate_series(1, $2::integer) AS series`,
          [prefix, candidateCount, observedThrough],
        );
        await executor.query(
          `INSERT INTO reflection_record_semantic_work (
             record_id, generation, completed_generation, change_reason, stage,
             state, attempt_count, quarantine_round, recover_after, failure_code,
             failure_detail, due_since, started_at, created_at, updated_at
           )
           SELECT $1 || 'held-' || lpad(series::text, 6, '0'),
                  8, 0, 'dependency_lost', 'organization', 'quarantined',
                  8, 8, $3, 'candidate_unavailable',
                  'candidate_selection_invalid', $3, $3, $3, $3
             FROM generate_series(1, $2::integer) AS series`,
          [prefix, candidateCount, observedThrough],
        );
        await insertProviderHolds(tx, [controlRecordId], observedThrough);

        const handle = await verifyRecordProductPostgresHandle({
          query: executor.query.bind(executor),
          transaction: use => use(executor),
        });
        const store = new PostgresSemanticWorkStore({
          handle,
          commitments: createHmacRecordSemanticCommitmentPort(
            new Uint8Array(32).fill(30),
          ),
          clock: () => now,
        });
        expect(await store.requestManualProviderRecovery({
          now,
          observedThrough,
          authorizedBy: randomUUID(),
          modelId: "surplus:synthetic-model",
        })).toEqual({ queued: 1, held: candidateCount });
        const [control] = await tx.select({
          generation: reflectionRecordSemanticWork.generation,
          recoveryId: reflectionRecordSemanticWork.manualRecoveryId,
        }).from(reflectionRecordSemanticWork)
          .where(eq(reflectionRecordSemanticWork.recordId, controlRecordId));
        expect(control?.generation).toBe(2);
        expect(control?.recoveryId).toBeString();
        throw rollback;
      },
      { isolationLevel: "read committed" },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}, 60_000);
