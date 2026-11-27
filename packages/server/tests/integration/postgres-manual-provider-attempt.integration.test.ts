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
