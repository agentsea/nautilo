import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb, eq, inArray, llmUsageEvents, namespaces, queryReflectionAdminStatus, reflectionRecords,
  reflectionRecordSemanticWork, rooms, users,
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
    await db.delete(reflectionRecordSemanticWork).where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    // Reflection Record identities are append-only, including in disposable test databases.
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(namespaces).where(eq(namespaces.id, namespace.id));
    await db.delete(users).where(eq(users.id, owner.id));
  }
});
