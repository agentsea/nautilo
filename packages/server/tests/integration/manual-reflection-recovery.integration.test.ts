import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb,
  createPostgresJsCanonicalBridgeConnection,
  eq,
  inArray,
  llmUsageEvents,
  reflectionRecords,
  reflectionRecordSemanticWork,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";
import { reflectionModelOperationId } from "@nautilo/runtime";
import type { MemoryOperationBinding } from "@nautilo/types";

import { requestManualReflectionRecovery } from "../../src/reflection/request-manual-recovery";

let db: ReturnType<typeof createDirectDb>;
let previousCommitmentKey: string | undefined;

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);
  previousCommitmentKey = process.env[PUSH_TOKEN_ENCRYPTION_KEY];
  process.env[PUSH_TOKEN_ENCRYPTION_KEY] = "5a".repeat(32);
});

afterAll(async () => {
  if (previousCommitmentKey === undefined) delete process.env[PUSH_TOKEN_ENCRYPTION_KEY];
  else process.env[PUSH_TOKEN_ENCRYPTION_KEY] = previousCommitmentKey;
  await db?.end();
});

test("manual Reflection recovery queues each observed service hold once and retains unsafe or Human work", async () => {
  const suffix = randomUUID();
  const [operator] = await db.insert(users).values({
    name: "Reflection recovery operator",
    email: `manual-reflection-${suffix}@integration.test`,
    handle: `manual_reflection_${suffix.replaceAll("-", "").slice(0, 10)}`,
  }).returning({ id: users.id });
  if (!operator) throw new Error("missing Reflection recovery operator");

  const recordIds = {
    direct: `manual-reflection-${suffix}-direct`,
    legacy: `manual-reflection-${suffix}-legacy`,
    human: `manual-reflection-${suffix}-human`,
    newer: `manual-reflection-${suffix}-newer`,
    candidateQuarantine: `manual-reflection-${suffix}-candidate-quarantine`,
    authorityQuarantine: `manual-reflection-${suffix}-authority-quarantine`,
    otherQuarantine: `manual-reflection-${suffix}-other-quarantine`,
  } as const;
  const failedAt = new Date("2026-11-27T10:00:00.000Z");
  const observedThrough = new Date("2026-11-27T10:01:00.000Z");
  const newerFailureAt = new Date("2026-11-27T10:02:00.000Z");
  const now = new Date("2026-11-27T10:03:00.000Z");
  const oldModel = "openai:reflection-old";
  const configuredModel = "anthropic:reflection-current";
  const serviceBinding: MemoryOperationBinding = {
    version: 1,
    kind: "service",
    role: "memoryReflection",
    modelId: oldModel,
    inputCommitment: `hmac-sha256:${"D".repeat(43)}`,
  };
  const newerBinding: MemoryOperationBinding = {
    ...serviceBinding,
    inputCommitment: `hmac-sha256:${"N".repeat(43)}`,
  };
  const humanBinding: MemoryOperationBinding = {
    version: 1,
    kind: "human",
    role: "memoryReflection",
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
  const legacyBinding = { kind: "service" as const, modelId: oldModel };
  let usageIds: string[] = [];

  try {
    await db.insert(reflectionRecords).values(Object.values(recordIds).map(recordId => ({
      recordId,
      lifecycle: "current" as const,
      structuralHeight: 1,
      producerPolicyVersion: "manual-recovery-test-v1",
      processingGeneration: 1,
    })));
    await db.insert(reflectionRecordSemanticWork).values([
      [recordIds.direct, serviceBinding, failedAt],
      [recordIds.legacy, legacyBinding, failedAt],
      [recordIds.human, humanBinding, failedAt],
      [recordIds.newer, newerBinding, newerFailureAt],
    ].map(([recordId, binding, updatedAt]) => ({
      recordId: recordId as string,
      generation: 1,
      completedGeneration: 1,
      changeReason: "created" as const,
      stage: "organization" as const,
      state: "complete" as const,
      acceptedModelBindingGeneration: 1,
      acceptedModelBinding: binding as MemoryOperationBinding,
      completionOutcome: "provider_outcome_unknown" as const,
      dueSince: failedAt,
      startedAt: failedAt,
      completedAt: updatedAt as Date,
      createdAt: failedAt,
      updatedAt: updatedAt as Date,
    })));
    const recoverAfter = new Date("2026-11-28T10:00:00.000Z");
    const savedCheckpoint = new Uint8Array([1, 2, 3, 4]);
    await db.insert(reflectionRecordSemanticWork).values([{
      recordId: recordIds.candidateQuarantine,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "candidate_unavailable",
      failureDetail: "candidate_selection_invalid",
      dueSince: failedAt,
      startedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    }, {
      recordId: recordIds.authorityQuarantine,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "authority_unavailable",
      acceptedModelBinding: serviceBinding,
      acceptedModelBindingGeneration: 1,
      organizerProposalCheckpoint: savedCheckpoint,
      dueSince: failedAt,
      startedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    }, {
      recordId: recordIds.otherQuarantine,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "unexpected_failure",
      failureDetail: "unexpected_model_invocation_failure",
      dueSince: failedAt,
      startedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    }]);
    usageIds = (await db.insert(llmUsageEvents).values([
      { route: "openai", outcome: "unknown" as const, requestId: randomUUID() },
      { route: "surplus", outcome: "succeeded" as const, requestId: randomUUID() },
    ].map(({ route, outcome, requestId }) => ({
      occurredAt: failedAt,
      callType: "room_reflection",
      model: oldModel,
      provider: "openai",
      providerRoute: route,
      fundingKind: "service" as const,
      endpoint: "/v1/responses",
      providerRequestId: requestId,
      attemptOutcome: outcome,
      costState: outcome === "succeeded" ? "actual" as const : "unknown" as const,
      actualCostUsd: outcome === "succeeded" ? "0.01" : null,
      metadata: { operationId: reflectionModelOperationId(serviceBinding, "primary") },
    }))).returning({ id: llmUsageEvents.id })).map(row => row.id);

    const request = (cutoff: Date) => createPostgresJsCanonicalBridgeConnection(db)
      .transaction((tx, executor) => requestManualReflectionRecovery({
        db: tx,
        executor,
        now,
        observedThrough: cutoff,
        authorizedBy: operator.id,
        modelId: configuredModel,
      }), { isolationLevel: "read committed" });
    expect(await request(observedThrough)).toEqual({ queued: 4, held: 2 });
    const first = await db.select().from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, Object.values(recordIds)))
      .orderBy(reflectionRecordSemanticWork.recordId);
    const byId = new Map(first.map(row => [row.recordId, row]));
    for (const recordId of [recordIds.direct, recordIds.legacy]) {
      expect(byId.get(recordId)).toMatchObject({
        generation: 2,
        state: "due",
        acceptedModelBinding: null,
        acceptedModelBindingGeneration: null,
        manualRecoverySourceGeneration: 1,
        manualRecoveryAuthorizedBy: operator.id,
        manualRecoveryObservedThrough: observedThrough,
        manualRecoveryServiceModelId: configuredModel,
        manualRecoverySpentAt: null,
      });
    }
    expect(byId.get(recordIds.human)).toMatchObject({ generation: 1, state: "complete" });
    expect(byId.get(recordIds.newer)).toMatchObject({ generation: 1, state: "complete" });
    expect(byId.get(recordIds.candidateQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter: now,
      failureCode: "candidate_unavailable",
      failureDetail: "candidate_selection_invalid",
    });
    expect(byId.get(recordIds.authorityQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter: now,
      acceptedModelBinding: serviceBinding,
      organizerProposalCheckpoint: savedCheckpoint,
    });
    expect(byId.get(recordIds.otherQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter,
    });

    // Replaying the same HTTP observation cannot authorize the newer failure
    // and cannot create another generation for either already-queued subject.
    expect(await request(observedThrough)).toEqual({ queued: 0, held: 2 });
    expect(await request(newerFailureAt)).toEqual({ queued: 1, held: 2 });
  } finally {
    if (usageIds.length > 0) {
      await db.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, usageIds));
    }
    await db.delete(reflectionRecordSemanticWork).where(inArray(
      reflectionRecordSemanticWork.recordId,
      Object.values(recordIds),
    ));
    await db.delete(users).where(eq(users.id, operator.id));
  }
});
