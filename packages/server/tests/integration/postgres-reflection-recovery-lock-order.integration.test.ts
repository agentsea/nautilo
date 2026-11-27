import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb,
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  eq,
  inArray,
  reflectionRecords,
  reflectionRecordSemanticWork,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createHmacRecordSemanticCommitmentPort,
  PostgresSemanticWorkStore,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";

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

async function insertProviderHolds(recordIds: readonly string[], updatedAt: Date): Promise<void> {
  await db.insert(reflectionRecords).values(recordIds.map(recordId => ({
    recordId,
    lifecycle: "current" as const,
    structuralHeight: 1,
    producerPolicyVersion: "reflection-lock-regression-v1",
    processingGeneration: 1,
    createdAt: updatedAt,
    updatedAt,
  })));
  await db.insert(reflectionRecordSemanticWork).values(recordIds.map(recordId => ({
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
    failureDetail: "candidate_selection_invalid",
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
  await insertProviderHolds([recordId], observedThrough);
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
