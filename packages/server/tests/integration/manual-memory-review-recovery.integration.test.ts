import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  agents, compareAndSwapEncryptionTransitionPolicy, createDirectDb, eq,
  getEncryptionTransitionPolicy, inArray, llmUsageEvents,
  memoryReviewModelRecoveries, memoryReviewReceipts, memoryReviewTurns,
  namespaces, rooms, sessions, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { MaintenanceController } from "@nautilo/runtime";
import type { MemoryOperationBinding } from "@nautilo/types";
import {
  createServerMemoryReviewRuntime,
  MemoryReviewManualRecoveryUnavailableError,
} from "../../src/lib/memory-review-runtime";

let db: ReturnType<typeof createDirectDb>;

beforeAll(() => {
  bootstrapTestDbInstance();
  // The production request runs under an already-open durable receipt
  // transaction. One connection proves every nested operation stays on that
  // transaction/savepoint instead of trying to re-enter a sibling pool slot.
  db = createDirectDb(1);
});

afterAll(async () => {
  await db?.end();
});

test("manual Memory review recovery durably deduplicates explicit service retries and retains unsafe holds", async () => {
  const suffix = randomUUID();
  const [operator] = await db.insert(users).values({
    name: "Memory recovery operator",
    email: `manual-memory-${suffix}@integration.test`,
    handle: `manual_memory_${suffix.replaceAll("-", "").slice(0, 10)}`,
  }).returning({ id: users.id });
  const [namespace] = await db.insert(namespaces).values({
    scope: "private",
    label: `manual-memory-${suffix}`,
  }).returning({ id: namespaces.id });
  if (!operator || !namespace) throw new Error("missing manual Memory recovery fixture owner");
  const [room] = await db.insert(rooms).values({
    ownerId: operator.id,
    type: "private",
    label: "Manual Memory recovery fixture",
    graphThreadId: `manual-memory:${suffix}`,
    namespaceId: namespace.id,
    humanActorIds: [],
  }).returning({ id: rooms.id });
  const [agent] = await db.insert(agents).values({
    handle: `manual-memory-${suffix}`,
  }).returning({ id: agents.id });
  if (!room || !agent) throw new Error("missing manual Memory recovery fixture identity");
  const threadId = `manual-memory:${suffix}`;
  const [session] = await db.insert(sessions).values({
    threadId,
    ownerId: operator.id,
    agentId: agent.id,
    roomId: room.id,
  }).returning({ id: sessions.id });
  if (!session) throw new Error("missing manual Memory recovery fixture session");

  const failedAt = new Date("2026-11-27T10:00:00.000Z");
  const observedThrough = new Date("2026-11-27T10:01:00.000Z");
  const newerFailureAt = new Date("2026-11-27T10:02:00.000Z");
  const now = new Date("2026-11-27T10:03:00.000Z");
  const oldModel = "openai:memory-old";
  const binding = (marker: string): MemoryOperationBinding => ({
    version: 1,
    kind: "service",
    role: "memoryReview",
    modelId: oldModel,
    inputCommitment: `hmac-sha256:${marker.repeat(43)}`,
  });
  const personal: MemoryOperationBinding = {
    version: 1,
    kind: "human",
    role: "memoryReview",
    modelId: oldModel,
    inputCommitment: `hmac-sha256:${"H".repeat(43)}`,
    humanUserId: operator.id,
    preferenceRevision: 1,
    funding: {
      kind: "personal",
      providerRoute: "openai",
      credentialId: randomUUID(),
      credentialRevision: 1,
    },
  };
  const fixtures = [
    { scope: "direct", binding: binding("D"), code: "provider_outcome_unknown", phase: "model", at: failedAt },
    { scope: "invalid", binding: { kind: "service", modelId: oldModel }, code: "invalid_proposal", phase: "model", at: failedAt },
    { scope: "publication", binding: binding("P"), code: "publication_uncertain", phase: "publication", at: failedAt },
    { scope: "personal", binding: personal, code: "provider_outcome_unknown", phase: "model", at: failedAt },
    { scope: "newer", binding: binding("N"), code: "invalid_proposal", phase: "model", at: newerFailureAt },
  ].map((value, index) => ({
    ...value,
    id: randomUUID(),
    generationId: randomUUID(),
    attemptId: randomUUID(),
    firstMessageId: index + 1,
  }));
  const turnIds = fixtures.map(value => value.id);
  let usageId: string | undefined;
  const originalPolicy = await getEncryptionTransitionPolicy(db);
  let activePolicy = originalPolicy;
  const runtime = createServerMemoryReviewRuntime({
    isAcceptingWork: async () => true,
    isAcceptingWorkInTransaction: async (transaction, transactionNow) =>
      (await new MaintenanceController({
        db: transaction,
        now: () => transactionNow,
      }).getState()).state === "normal",
  });

  try {
    await db.insert(memoryReviewTurns).values(fixtures.map(value => ({
      id: value.id,
      generationId: value.generationId,
      sessionId: session.id,
      agentId: agent.id,
      roomId: room.id,
      ownerId: operator.id,
      actorId: `actor:${operator.id}`,
      accessScope: value.scope,
      threadId,
      checkpointThreadId: threadId,
      turnId: `${value.scope}:${suffix}`,
      sourceIds: [value.firstMessageId],
      firstMessageId: value.firstMessageId,
      hasHuman: 1,
      state: "completed" as const,
      acceptedModelBinding: value.binding as MemoryOperationBinding,
      attemptId: value.attemptId,
      failurePhase: value.phase,
      failureCode: value.code,
      completedAt: value.at,
      lastAttemptAt: value.at,
      createdAt: failedAt,
      updatedAt: value.at,
    })));
    await db.insert(memoryReviewReceipts).values(fixtures.map(value => ({
      id: value.attemptId,
      workId: value.generationId,
      actorId: `actor:${operator.id}`,
      ownerId: operator.id,
      agentId: agent.id,
      modelId: oldModel,
      outcome: "failed" as const,
      phase: value.phase,
      code: value.code,
      counts: { created: 0, replaced: 0, promoted: 0, demoted: 0 },
      effects: [],
      durationMs: 0,
      createdAt: value.at,
    })));
    const direct = fixtures[0]!;
    [usageId] = (await db.insert(llmUsageEvents).values({
      occurredAt: failedAt,
      roomId: room.id,
      callType: "memory_review",
      model: oldModel,
      provider: "openai",
      providerRoute: "surplus",
      fundingKind: "service",
      endpoint: "/v1/responses",
      providerRequestId: randomUUID(),
      attemptOutcome: "unknown",
      costState: "unknown",
      metadata: { workId: direct.generationId, attemptId: direct.attemptId },
    }).returning({ id: llmUsageEvents.id })).map(row => row.id);

    const request = (cutoff: Date) => db.transaction((receiptTx) =>
      runtime.requestManualRecovery({
        db: receiptTx,
        now,
        observedThrough: cutoff,
        authorizedBy: operator.id,
      }));
    activePolicy = await compareAndSwapEncryptionTransitionPolicy(db, {
      expectedRevision: activePolicy.revision,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
    });
    expect(await request(observedThrough)).toEqual({ queued: 2, held: 3 });
    expect(await request(observedThrough)).toEqual({ queued: 0, held: 3 });
    const maintenance = new MaintenanceController({ db });
    const maintenanceOperationId = randomUUID();
    await maintenance.enterDraining({ operationId: maintenanceOperationId });
    try {
      const maintenanceRejection = await request(newerFailureAt)
        .then(() => undefined, (error: unknown) => error);
      expect(maintenanceRejection).toBeInstanceOf(
        MemoryReviewManualRecoveryUnavailableError,
      );
      expect((maintenanceRejection as MemoryReviewManualRecoveryUnavailableError).code)
        .toBe("maintenance_unavailable");
    } finally {
      await maintenance.cancel(maintenanceOperationId);
    }
    activePolicy = await compareAndSwapEncryptionTransitionPolicy(db, {
      expectedRevision: activePolicy.revision,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "strict",
    });
    const strictRejection = await request(newerFailureAt)
      .then(() => undefined, (error: unknown) => error);
    expect(strictRejection).toBeInstanceOf(MemoryReviewManualRecoveryUnavailableError);
    expect((strictRejection as MemoryReviewManualRecoveryUnavailableError).code)
      .toBe("access_unavailable");
    activePolicy = await compareAndSwapEncryptionTransitionPolicy(db, {
      expectedRevision: activePolicy.revision,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
    });
    expect(await request(newerFailureAt)).toEqual({ queued: 1, held: 2 });
    expect(await request(newerFailureAt)).toEqual({ queued: 0, held: 2 });

    const recoveries = await db.select().from(memoryReviewModelRecoveries)
      .where(inArray(memoryReviewModelRecoveries.workId, fixtures.map(value => value.generationId)));
    expect(recoveries).toHaveLength(3);
    const held = new Set<string>(fixtures.filter(value => value.scope === "publication" || value.scope === "personal")
      .map(value => value.generationId));
    expect(recoveries.every(value => !held.has(value.workId)
      && value.spentAt === null && value.recoveryAttemptId === null)).toBe(true);
  } finally {
    if (activePolicy.mode !== originalPolicy.mode
      || activePolicy.shadowBehavior !== originalPolicy.shadowBehavior) {
      activePolicy = await compareAndSwapEncryptionTransitionPolicy(db, {
        expectedRevision: activePolicy.revision,
        targetMode: originalPolicy.mode,
        targetShadowBehavior: originalPolicy.shadowBehavior,
      });
    }
    if (usageId) await db.delete(llmUsageEvents).where(eq(llmUsageEvents.id, usageId));
    await db.delete(memoryReviewReceipts).where(inArray(
      memoryReviewReceipts.workId,
      fixtures.map(value => value.generationId),
    ));
    await db.delete(memoryReviewTurns).where(inArray(memoryReviewTurns.id, turnIds));
    await db.delete(sessions).where(eq(sessions.id, session.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, namespace.id));
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.delete(users).where(eq(users.id, operator.id));
  }
});
