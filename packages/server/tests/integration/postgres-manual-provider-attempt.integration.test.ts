import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb,
  createPostgresJsBridgeConnection,
  eq,
  inArray,
  reflectionRecords,
  reflectionRecordSemanticWork,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { DurableSleepClaim } from "@nautilo/reflection";
import type { MemoryOperationBinding } from "@nautilo/types";

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

function deferred<Value = void>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
}> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

test("one exact manual provider attempt survives binding and rejects concurrent or changed-lease replay", async () => {
  const suffix = randomUUID();
  const now = new Date("2002-03-04T05:06:07.000Z");
  const recoveryId = randomUUID();
  const recordIds = [
    `manual-attempt-${suffix}-a`,
    `manual-attempt-${suffix}-B`,
  ];
  const initialLeaseTokens = [randomUUID(), randomUUID()];
  const [operator] = await db.insert(users).values({
    name: "Manual provider attempt operator",
    email: `manual-provider-attempt-${suffix}@integration.test`,
  }).returning({ id: users.id });
  if (operator === undefined) throw new Error("missing manual attempt operator");
  try {
    await db.insert(reflectionRecords).values(recordIds.map(recordId => ({
      recordId,
      lifecycle: "current" as const,
      structuralHeight: 1,
      producerPolicyVersion: "manual-provider-attempt-test-v1",
      processingGeneration: 2,
    })));
    await db.insert(reflectionRecordSemanticWork).values(recordIds.map((recordId, index) => ({
      recordId,
      generation: 2,
      changeReason: "created" as const,
      stage: "organization" as const,
      state: "claimed" as const,
      claimGeneration: 2,
      leaseToken: initialLeaseTokens[index]!,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      manualRecoveryId: recoveryId,
      manualRecoverySourceGeneration: 1,
      manualRecoveryAuthorizedBy: operator.id,
      manualRecoveryAuthorizedAt: new Date(now.getTime() - 2_000),
      manualRecoveryObservedThrough: new Date(now.getTime() - 3_000),
      manualRecoveryServiceModelId: "surplus:synthetic-model",
      dueSince: new Date(now.getTime() - 5_000),
      startedAt: new Date(now.getTime() - 4_000),
      createdAt: new Date(now.getTime() - 5_000),
      updatedAt: new Date(now.getTime() - 4_000),
    })));

    const handle = await verifyRecordProductPostgresHandle(
      createPostgresJsBridgeConnection(db),
    );
    const store = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(29)),
      clock: () => now,
    });
    const claims: DurableSleepClaim[] = recordIds.map((recordRef, index) => ({
      logicalObjectRef: recordRef,
      recordRef,
      generation: 2,
      changeReason: "created",
      stage: "organization",
      leaseToken: initialLeaseTokens[index]!,
      operatorAuthorizedAttempt: true,
    }));
    const binding: MemoryOperationBinding = {
      version: 1,
      kind: "service",
      role: "memoryReflection",
      modelId: "surplus:synthetic-model",
      inputCommitment: `hmac-sha256:${"U".repeat(43)}`,
    };

    expect(await store.bindAcceptedModelOperation(claims, async () => binding))
      .toEqual(binding);
    const bound = await db.select({
      recordId: reflectionRecordSemanticWork.recordId,
      spentAt: reflectionRecordSemanticWork.manualRecoverySpentAt,
    }).from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    expect(bound).toHaveLength(2);
    expect(bound.every(row => row.spentAt === null)).toBeTrue();

    const attempts = await Promise.all([
      store.consumeManualProviderAttempt(claims),
      store.consumeManualProviderAttempt(claims),
    ]);
    expect([...attempts].sort()).toEqual(["blocked", "consumed"]);
    const spent = await db.select({
      spentAt: reflectionRecordSemanticWork.manualRecoverySpentAt,
    }).from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    expect(spent).toHaveLength(2);
    expect(spent.every(row => row.spentAt?.getTime() === now.getTime())).toBeTrue();

    const changedLeaseTokens = [randomUUID(), randomUUID()];
    for (const [index, recordId] of recordIds.entries()) {
      await db.update(reflectionRecordSemanticWork).set({
        leaseToken: changedLeaseTokens[index]!,
        leaseExpiresAt: new Date(now.getTime() + 120_000),
      }).where(eq(reflectionRecordSemanticWork.recordId, recordId));
    }
    const changedLeaseClaims = claims.map((claim, index) => ({
      ...claim,
      leaseToken: changedLeaseTokens[index]!,
    }));
    expect(await store.consumeManualProviderAttempt(claims)).toBe("blocked");
    expect(await store.consumeManualProviderAttempt(changedLeaseClaims)).toBe("blocked");
  } finally {
    // Immutable fixture identities must also be invisible to subsequent
    // worker bootstrap scans after their mutable work is removed.
    await db.update(reflectionRecords).set({ disposition: "purged" })
      .where(inArray(reflectionRecords.recordId, recordIds));
    await db.delete(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    await db.delete(users).where(eq(users.id, operator.id));
  }
});

test("scheduled bootstrap skips a row that became a provider hold after its scan", async () => {
  const suffix = randomUUID();
  const now = new Date("2004-05-06T07:08:09.000Z");
  const observedThrough = new Date(now.getTime() - 1_000);
  const prefix = `zz-manual-lock-order-${suffix}:`;
  const recordId = `${prefix}hold`;
  const acceptedBinding: MemoryOperationBinding = {
    version: 1,
    kind: "service",
    role: "memoryReflection",
    modelId: "surplus:synthetic-model",
    inputCommitment: `hmac-sha256:${"L".repeat(43)}`,
  };
  const [operator] = await db.insert(users).values({
    name: "Manual recovery lock operator",
    email: `manual-recovery-lock-${suffix}@integration.test`,
  }).returning({ id: users.id });
  if (operator === undefined) throw new Error("missing recovery lock operator");
  const releaseBlocker = deferred();
  const blockerReady = deferred();
  let blocker: Promise<void> | undefined;
  try {
    await db.insert(reflectionRecords).values({
      recordId,
      lifecycle: "current",
      structuralHeight: 1,
      producerPolicyVersion: "manual-recovery-lock-order-v1",
      processingGeneration: 1,
    });
    await db.insert(reflectionRecordSemanticWork).values({
      recordId,
      generation: 1,
      completedGeneration: 1,
      changeReason: "dependency_lost",
      stage: "organization",
      state: "complete",
      acceptedModelBinding: acceptedBinding,
      acceptedModelBindingGeneration: 1,
      completionOutcome: "completed",
      completedAt: observedThrough,
      dueSince: new Date(now.getTime() - 10_000),
      createdAt: new Date(now.getTime() - 10_000),
      updatedAt: observedThrough,
    });
    blocker = db.transaction(async tx => {
      await tx.delete(reflectionRecordSemanticWork)
        .where(eq(reflectionRecordSemanticWork.recordId, recordId));
      await tx.insert(reflectionRecordSemanticWork).values({
        recordId,
        generation: 2,
        completedGeneration: 2,
        changeReason: "dependency_lost",
        stage: "organization",
        state: "complete",
        acceptedModelBinding: acceptedBinding,
        acceptedModelBindingGeneration: 2,
        completionOutcome: "provider_outcome_unknown",
        dueSince: new Date(now.getTime() - 10_000),
        completedAt: observedThrough,
        createdAt: new Date(now.getTime() - 10_000),
        updatedAt: observedThrough,
      });
      blockerReady.resolve();
      await releaseBlocker.promise;
    });
    await blockerReady.promise;
    const handle = await verifyRecordProductPostgresHandle(
      createPostgresJsBridgeConnection(db),
    );
    const store = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(
        new Uint8Array(32).fill(31),
      ),
      clock: () => now,
    });
    const bootstrap = store.bootstrapPage({ limit: 1, continuation: prefix });
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
    const bootstrapResult = await Promise.race([
      bootstrap,
      new Promise<never>((_resolve, reject) => {
        bootstrapTimer = setTimeout(
          () => reject(new Error("bootstrap waited behind manual recovery")),
          2_000,
        );
      }),
    ]).finally(() => clearTimeout(bootstrapTimer));
    expect(bootstrapResult.admitted).toBe(0);
    releaseBlocker.resolve();
    await blocker;
    const [held] = await db.select({
      generation: reflectionRecordSemanticWork.generation,
      completionOutcome: reflectionRecordSemanticWork.completionOutcome,
    }).from(reflectionRecordSemanticWork)
      .where(eq(reflectionRecordSemanticWork.recordId, recordId));
    expect(held).toEqual({
      generation: 2,
      completionOutcome: "provider_outcome_unknown",
    });
    expect(await store.requestManualProviderRecovery({
      now,
      observedThrough,
      authorizedBy: operator.id,
      modelId: "surplus:synthetic-model",
    })).toEqual({ queued: 1, held: 0 });
  } finally {
    releaseBlocker.resolve();
    await Promise.allSettled(blocker === undefined ? [] : [blocker]);
    await db.update(reflectionRecords).set({ disposition: "purged" })
      .where(eq(reflectionRecords.recordId, recordId));
    await db.delete(reflectionRecordSemanticWork)
      .where(eq(reflectionRecordSemanticWork.recordId, recordId));
    await db.delete(users).where(eq(users.id, operator.id));
  }
}, 15_000);

test("scheduled bootstrap preserves ambiguous outcomes while promoting completed work", async () => {
  const suffix = randomUUID();
  const now = new Date("2003-04-05T06:07:08.000Z");
  const prefix = `zz-bootstrap-provider-hold-${suffix}:`;
  const recordIds = {
    manual: `${prefix}manual`,
    legacy: `${prefix}legacy`,
    repaired: `${prefix}repaired`,
  } as const;
  const allRecordIds = Object.values(recordIds);
  const manualRecoveryId = randomUUID();
  let operatorId: string | undefined;
  try {
    const [operator] = await db.insert(users).values({
      name: "Bootstrap provider hold operator",
      email: `bootstrap-provider-hold-${suffix}@integration.test`,
    }).returning({ id: users.id });
    if (operator === undefined) throw new Error("missing bootstrap hold operator");
    operatorId = operator.id;
    await db.insert(reflectionRecords).values(allRecordIds.map(recordId => ({
      recordId,
      lifecycle: "current" as const,
      structuralHeight: 1,
      producerPolicyVersion: "bootstrap-provider-hold-test-v1",
      processingGeneration: 5,
    })));
    await db.insert(reflectionRecordSemanticWork).values([{
      recordId: recordIds.manual,
      generation: 6,
      completedGeneration: 6,
      changeReason: "dependency_lost" as const,
      stage: "organization" as const,
      state: "complete" as const,
      completionOutcome: "provider_outcome_unknown" as const,
      manualRecoveryId,
      manualRecoverySourceGeneration: 5,
      manualRecoveryAuthorizedBy: operator.id,
      manualRecoveryAuthorizedAt: new Date(now.getTime() - 5_000),
      manualRecoveryObservedThrough: new Date(now.getTime() - 6_000),
      manualRecoveryServiceModelId: "surplus:synthetic-model",
      manualRecoverySpentAt: new Date(now.getTime() - 4_000),
      completedAt: new Date(now.getTime() - 3_000),
      dueSince: new Date(now.getTime() - 10_000),
      createdAt: new Date(now.getTime() - 10_000),
      updatedAt: new Date(now.getTime() - 3_000),
    }, {
      recordId: recordIds.legacy,
      generation: 3,
      completedGeneration: 3,
      changeReason: "created" as const,
      stage: "organization" as const,
      state: "complete" as const,
      completionOutcome: "completed" as const,
      completedAt: new Date(now.getTime() - 3_000),
      dueSince: new Date(now.getTime() - 10_000),
      createdAt: new Date(now.getTime() - 10_000),
      updatedAt: new Date(now.getTime() - 3_000),
    }, {
      recordId: recordIds.repaired,
      generation: 4,
      completedGeneration: 4,
      changeReason: "dependency_lost" as const,
      stage: "organization" as const,
      state: "complete" as const,
      completionOutcome: "dependency_repaired" as const,
      completedAt: new Date(now.getTime() - 3_000),
      dueSince: new Date(now.getTime() - 10_000),
      createdAt: new Date(now.getTime() - 10_000),
      updatedAt: new Date(now.getTime() - 3_000),
    }]);

    const handle = await verifyRecordProductPostgresHandle(
      createPostgresJsBridgeConnection(db),
    );
    const store = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(
        new Uint8Array(32).fill(30),
      ),
      clock: () => now,
    });

    expect((await store.bootstrapPage({
      // The two eligible fixtures sort contiguously after the unique prefix;
      // provider holds are filtered before pagination.
      limit: 2,
      continuation: prefix,
    })).admitted).toBe(2);
    const rows = await db.select({
      recordId: reflectionRecordSemanticWork.recordId,
      generation: reflectionRecordSemanticWork.generation,
      changeReason: reflectionRecordSemanticWork.changeReason,
      state: reflectionRecordSemanticWork.state,
      completionOutcome: reflectionRecordSemanticWork.completionOutcome,
      recoveryId: reflectionRecordSemanticWork.manualRecoveryId,
      spentAt: reflectionRecordSemanticWork.manualRecoverySpentAt,
    }).from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, allRecordIds));
    const byRecord = new Map(rows.map(row => [row.recordId, row]));
    expect(byRecord.get(recordIds.manual)).toMatchObject({
      generation: 6,
      changeReason: "dependency_lost",
      state: "complete",
      completionOutcome: "provider_outcome_unknown",
      recoveryId: manualRecoveryId,
      spentAt: new Date(now.getTime() - 4_000),
    });
    expect(byRecord.get(recordIds.legacy)).toMatchObject({
      generation: 4,
      changeReason: "scheduled_review",
      state: "due",
      completionOutcome: null,
    });
    expect(byRecord.get(recordIds.repaired)).toMatchObject({
      generation: 5,
      changeReason: "scheduled_review",
      state: "due",
      completionOutcome: null,
    });
  } finally {
    await db.update(reflectionRecords).set({ disposition: "purged" })
      .where(inArray(reflectionRecords.recordId, allRecordIds));
    await db.delete(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, allRecordIds));
    if (operatorId !== undefined) {
      await db.delete(users).where(eq(users.id, operatorId));
    }
  }
});
