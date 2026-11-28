import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb, eq, inArray, llmUsageEvents, namespaces, queryReflectionAdminStatus, reflectionRecords,
  reflectionRecordSemanticWork, roomEvents, roomJournalBatches, rooms, users,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { disabledReflectionSemanticSchedulerStatus, reflectionModelOperationId } from "@nautilo/runtime";
import type { MemoryOperationBinding } from "@nautilo/types";
import { createAutomaticMemoryRecovery } from "../../src/lib/memory-recovery-service";

let db: ReturnType<typeof createDirectDb>;

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);
});
afterAll(async () => { await db?.end(); });

test("Reflection recovery finds refused service work past an ambiguous attempt and queues it once", async () => {
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    name: "Reflection recovery tester",
    email: `reflection-recovery-${suffix}@integration.test`,
    handle: `reflection_recovery_${suffix.replaceAll("-", "").slice(0, 12)}`,
  }).returning({ id: users.id });
  if (!owner) throw new Error("missing recovery test owner");
  const [namespace] = await db.insert(namespaces).values({
    scope: "private", label: `reflection-recovery-${suffix}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("missing recovery test namespace");
  const roomId = randomUUID();
  const recordIds = [`recovery-${suffix}-a`, `recovery-${suffix}-b`];
  const startedAt = new Date("2026-01-10T00:00:00.000Z");
  const failedAt = new Date("2026-01-10T00:01:00.000Z");
  const backoff = new Date("2026-01-12T00:00:00.000Z");
  const now = new Date("2026-01-11T00:00:00.000Z");
  const oldModel = "openai:gpt-5.6-sol";
  const newModel = "venice:test-model";
  const bindings = ["B", "C"].map((char): MemoryOperationBinding => ({
    version: 1, kind: "service", role: "memoryReflection", modelId: oldModel,
    inputCommitment: `hmac-sha256:${char.repeat(42)}A`,
  }));

  try {
    await db.insert(rooms).values({
      id: roomId, ownerId: owner.id, type: "private", label: "Reflection recovery",
      graphThreadId: `room:${roomId}`, namespaceId: namespace.id,
    });
    await db.insert(reflectionRecords).values(recordIds.map<typeof reflectionRecords.$inferInsert>(recordId => ({
      recordId, lifecycle: "current", structuralHeight: 1,
      producerPolicyVersion: "recovery-test-v1", processingGeneration: 1,
    })));
    await db.insert(reflectionRecordSemanticWork).values(recordIds.map<typeof reflectionRecordSemanticWork.$inferInsert>((recordId, index) => ({
      recordId, generation: 1, changeReason: "created", stage: "organization",
      state: "checkpointed", waitingReason: "provider", acceptedModelBindingGeneration: 1,
      acceptedModelBinding: bindings[index]!, dueSince: startedAt, startedAt, nextAttemptAt: backoff,
      createdAt: startedAt, updatedAt: failedAt,
    })));
    await db.insert(llmUsageEvents).values(bindings.map<typeof llmUsageEvents.$inferInsert>((binding, index) => ({
      roomId, occurredAt: failedAt, callType: "room_reflection", model: oldModel,
      provider: "openai", providerRoute: "surplus", fundingKind: "service",
      endpoint: "/v1/chat/completions", attemptOutcome: index === 0 ? "unknown" : "failed",
      costState: "unknown", failureCode: index === 0 ? "outcome_unknown" : "no_sellers_for_model",
      metadata: { operationId: reflectionModelOperationId(binding, "primary") },
    })));

    const recovery = () => createAutomaticMemoryRecovery({
      db: () => db, resolveReflectionModel: () => newModel, resolveJournalModel: () => oldModel,
    });
    const primary = recovery();
    const input = { now, limit: 1, signal: new AbortController().signal };
    const readWork = () => db.select({
      model: reflectionRecordSemanticWork.acceptedModelBinding,
      nextAttemptAt: reflectionRecordSemanticWork.nextAttemptAt,
      waitingReason: reflectionRecordSemanticWork.waitingReason,
    }).from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds))
      .orderBy(reflectionRecordSemanticWork.recordId);
    const waiting = bindings.map(model => ({ model, nextAttemptAt: backoff, waitingReason: "provider" as const }));
    await primary.recoverReflection(input);
    expect(await readWork()).toEqual(waiting);
    await Promise.all([
      primary.recoverReflection(input),
      recovery().recoverReflection({ ...input, limit: 2 }),
    ]);
    const recovered = [
      waiting[0]!,
      { model: { ...bindings[1]!, modelId: newModel }, nextAttemptAt: now, waitingReason: null },
    ];
    expect(await readWork()).toEqual(recovered);
    await primary.recoverReflection({ ...input, now: failedAt });
    expect(await readWork()).toEqual(recovered);

    const unresolvedRecord = eq(reflectionRecordSemanticWork.recordId, recordIds[0]!);
    await db.update(reflectionRecordSemanticWork).set({
      state: "claimed", claimGeneration: 1, leaseToken: randomUUID(), waitingReason: null,
      nextAttemptAt: null, leaseExpiresAt: backoff, updatedAt: now,
    }).where(unresolvedRecord);
    await db.update(reflectionRecordSemanticWork).set({
      state: "complete", claimGeneration: null, leaseToken: null, leaseExpiresAt: null, completedGeneration: 1, completedAt: now, updatedAt: now,
      completionOutcome: "provider_outcome_unknown", waitingReason: null, nextAttemptAt: null,
    }).where(unresolvedRecord);
    const statusInput = {
      now, since: failedAt, until: now, scheduler: disabledReflectionSemanticSchedulerStatus(15_000),
    };
    const status = await queryReflectionAdminStatus({ ...statusInput, includeRecovery: true }, db);
    expect(status.unresolvedProviderOutcomes).toBe(1);
    expect(await queryReflectionAdminStatus(statusInput, db)).not.toHaveProperty("unresolvedProviderOutcomes");
    expect(status.health).toBe("degraded");
    expect(status.last24h.completedWork).toBe(0);
  } finally {
    await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, roomId));
    // Keep these append-only fixture identities out of later worker bootstrap scans.
    await db.update(reflectionRecords).set({disposition: "purged"})
      .where(inArray(reflectionRecords.recordId, recordIds));
    await db.delete(reflectionRecordSemanticWork).where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(namespaces).where(eq(namespaces.id, namespace.id));
    await db.delete(users).where(eq(users.id, owner.id));
  }
});

test("automatic Reflection rebind holds a whole spent manual family", async () => {
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    name: "Manual Reflection refusal tester",
    email: `manual-refusal-${suffix}@integration.test`,
    handle: `manual_refusal_${suffix.replaceAll("-", "").slice(0, 12)}`,
  }).returning({ id: users.id });
  if (!owner) throw new Error("missing refusal test owner");
  const [namespace] = await db.insert(namespaces).values({
    scope: "private", label: `manual-refusal-${suffix}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("missing refusal test namespace");
  const roomId = randomUUID();
  const batchId = randomUUID();
  const manualRecordIds = [
    randomUUID(),
    randomUUID(),
  ];
  const ordinaryRecordId = randomUUID();
  const recordIds = [...manualRecordIds, ordinaryRecordId];
  const authorizedAt = new Date("2026-02-10T00:00:00.000Z");
  const refusedAt = new Date("2026-02-10T00:01:00.000Z");
  const retryAt = new Date("2026-02-12T00:00:00.000Z");
  const now = new Date("2026-02-11T00:00:00.000Z");
  const oldModel = "openai:gpt-5.6-sol";
  const newModel = "venice:test-model";
  const manualBinding: MemoryOperationBinding = {
    version: 1, kind: "service", role: "memoryReflection", modelId: oldModel,
    inputCommitment: `hmac-sha256:${"M".repeat(43)}`,
  };
  const ordinaryBinding: MemoryOperationBinding = {
    ...manualBinding,
    inputCommitment: `hmac-sha256:${"O".repeat(43)}`,
  };
  const recoveryId = randomUUID();
  try {
    await db.insert(rooms).values({
      id: roomId, ownerId: owner.id, type: "private", label: "Manual refusal",
      graphThreadId: `room:${roomId}`, namespaceId: namespace.id,
    });
    await db.insert(roomJournalBatches).values({
      id: batchId, roomId, fromMessageIdExclusive: 0, throughMessageIdInclusive: 3,
      extractorVersion: "reflection-manual-refusal-v1", status: "completed",
    });
    await db.insert(reflectionRecords).values(recordIds.map(recordId => ({
      recordId, lifecycle: "current" as const, structuralHeight: 1,
      producerPolicyVersion: "reflection-manual-refusal-v1", processingGeneration: 1,
    })));
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('nautilo.stenographer_writer_version', '2', true)`);
      await tx.insert(roomEvents).values(recordIds.map((recordId, index) => ({
        id: recordId, roomId, sequence: index + 1, kind: "fact" as const,
        statement: null, status: "active" as const, sourceMessageIds: [index + 1],
        sourceBatchId: batchId, batchLocalOrdinal: index,
        extractorVersion: "reflection-manual-refusal-v1", projectionKind: "native" as const,
        recordId, nativeAttachedAt: authorizedAt, createdAt: authorizedAt,
      })));
    });
    await db.insert(reflectionRecordSemanticWork).values([
      ...manualRecordIds.map(recordId => ({
        recordId, generation: 2, changeReason: "created" as const,
        stage: "organization" as const, state: "checkpointed" as const,
        waitingReason: "provider" as const, acceptedModelBindingGeneration: 2,
        acceptedModelBinding: manualBinding, dueSince: authorizedAt,
        startedAt: authorizedAt, nextAttemptAt: retryAt,
        manualRecoveryId: recoveryId, manualRecoverySourceGeneration: 1,
        manualRecoveryAuthorizedBy: owner.id, manualRecoveryAuthorizedAt: authorizedAt,
        manualRecoveryObservedThrough: authorizedAt,
        manualRecoveryServiceModelId: oldModel, manualRecoverySpentAt: refusedAt,
        createdAt: authorizedAt, updatedAt: refusedAt,
      })),
      {
        recordId: ordinaryRecordId, generation: 1, changeReason: "created" as const,
        stage: "organization" as const, state: "checkpointed" as const,
        waitingReason: "provider" as const, acceptedModelBindingGeneration: 1,
        acceptedModelBinding: ordinaryBinding, dueSince: authorizedAt,
        startedAt: authorizedAt, nextAttemptAt: retryAt,
        createdAt: authorizedAt, updatedAt: refusedAt,
      },
    ]);
    await db.insert(llmUsageEvents).values([manualBinding, ordinaryBinding].map(binding => ({
      roomId, occurredAt: refusedAt, callType: "room_reflection" as const,
      model: oldModel, provider: "openai", providerRoute: "surplus",
      fundingKind: "service" as const, endpoint: "/v1/chat/completions",
      attemptOutcome: "failed" as const, costState: "unknown" as const,
      failureCode: "no_sellers_for_model",
      metadata: { operationId: reflectionModelOperationId(binding, "primary") },
    })));

    const recovery = createAutomaticMemoryRecovery({
      db: () => db, resolveReflectionModel: () => newModel,
      resolveJournalModel: () => oldModel,
    });
    await recovery.recoverReflection({
      now, limit: 10, signal: new AbortController().signal,
    });
    const stored = await db.select({
      recordId: reflectionRecordSemanticWork.recordId,
      binding: reflectionRecordSemanticWork.acceptedModelBinding,
      nextAttemptAt: reflectionRecordSemanticWork.nextAttemptAt,
      waitingReason: reflectionRecordSemanticWork.waitingReason,
      recoveryId: reflectionRecordSemanticWork.manualRecoveryId,
      spentAt: reflectionRecordSemanticWork.manualRecoverySpentAt,
    }).from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    const byId = new Map(stored.map(row => [row.recordId, row]));
    for (const recordId of manualRecordIds) {
      expect(byId.get(recordId)).toMatchObject({
        binding: manualBinding, nextAttemptAt: retryAt, waitingReason: "provider",
        recoveryId, spentAt: refusedAt,
      });
    }
    expect(byId.get(ordinaryRecordId)).toMatchObject({
      binding: { ...ordinaryBinding, modelId: newModel },
      nextAttemptAt: now,
      waitingReason: null,
      recoveryId: null,
    });
  } finally {
    await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, roomId));
    await db.delete(roomEvents).where(eq(roomEvents.roomId, roomId));
    await db.update(reflectionRecords).set({ disposition: "purged" })
      .where(inArray(reflectionRecords.recordId, recordIds));
    await db.delete(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    await db.delete(roomJournalBatches).where(eq(roomJournalBatches.id, batchId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(namespaces).where(eq(namespaces.id, namespace.id));
    await db.delete(users).where(eq(users.id, owner.id));
  }
});
