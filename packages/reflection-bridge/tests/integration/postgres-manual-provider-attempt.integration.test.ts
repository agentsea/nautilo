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
} from "../../src/server/postgres-semantic-work-store";
import { verifyRecordProductPostgresHandle } from "../../src/server/product-postgres";

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
    // Record identities are immutable product history. Remove the disposable
    // mutable work only; the empty identities can remain in the scratch DB.
    await db.delete(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    await db.delete(users).where(eq(users.id, operator.id));
  }
});
