import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  and,
  createDirectDb,
  createPostgresJsCanonicalBridgeConnection,
  eq,
  inArray,
  llmUsageEvents,
  namespaces,
  readReflectionRecoveryDiagnostics,
  type PostgresJsBridgeExecutor,
  reflectionRecords,
  reflectionRecordPublications,
  reflectionRecordSemanticWork,
  roomEvents,
  roomJournalBatches,
  rooms,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";
import { DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_VERSION } from "@nautilo/reflection";
import { reflectionModelOperationId } from "@nautilo/runtime";
import {
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";
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

test("Reflection diagnostics find the last matching wire beyond the driver parameter limit", async () => {
  const recordId = randomUUID();
  const now = new Date();
  const binding = {
    version: 1, kind: "service", role: "memoryReflection", modelId: "openai:reflection-test",
    inputCommitment: `hmac-sha256:${randomBytes(32).toString("base64url")}`,
  } as const;
  const wires = Array.from({ length: 65_535 }, (_, i) => `${recordId}:${i}`);
  const rollbackFixture = new Error("roll back diagnostic fixture");
  const rollback = await db.transaction(async tx => {
    await tx.insert(reflectionRecords).values({
      recordId, lifecycle: "current", structuralHeight: 0, producerPolicyVersion: "test", processingGeneration: 1,
    });
    await tx.insert(reflectionRecordSemanticWork).values({
      recordId, generation: 1, completedGeneration: 1, changeReason: "created", stage: "organization",
      state: "complete", acceptedModelBindingGeneration: 1, acceptedModelBinding: binding,
      completionOutcome: "provider_outcome_unknown", startedAt: now, completedAt: now, dueSince: now,
    });
    await tx.insert(llmUsageEvents).values({
      occurredAt: now, callType: "room_reflection", model: binding.modelId, provider: "openai",
      providerRoute: "openai", fundingKind: "service", costState: "actual", actualCostUsd: "0.01",
      endpoint: "/v1/responses", providerRequestId: randomUUID(), attemptOutcome: "succeeded",
      metadata: { operationId: wires.at(-1)! },
    });
    const result = await readReflectionRecoveryDiagnostics({
      since: now, until: now,
      operationIds: current => current.inputCommitment === binding.inputCommitment ? wires : [],
    }, tx);
    expect(result.providerSucceededResultMissing).toBe(1);
    throw rollbackFixture;
  }).catch((error: unknown) => error);
  expect(rollback).toBe(rollbackFixture);
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
    preBindingHold: `manual-reflection-${suffix}-pre-binding`,
    legacy: `manual-reflection-${suffix}-legacy`,
    human: `manual-reflection-${suffix}-human`,
    newer: `manual-reflection-${suffix}-newer`,
    candidateQuarantine: `manual-reflection-${suffix}-candidate-quarantine`,
    authorityQuarantine: `manual-reflection-${suffix}-authority-quarantine`,
    staleCheckpointQuarantine: `manual-reflection-${suffix}-stale-checkpoint-quarantine`,
    sourceCheckpointQuarantine: `manual-reflection-${suffix}-source-checkpoint-quarantine`,
    humanStaleCheckpoint: `manual-reflection-${suffix}-human-stale-checkpoint`,
    staleFreshCalculation: `manual-reflection-${suffix}-stale-fresh-calculation`,
    otherQuarantine: `manual-reflection-${suffix}-other-quarantine`,
  } as const;
  const failedAt = new Date("2001-01-01T10:00:00.000Z");
  const observedThrough = new Date("2001-01-01T10:01:00.000Z");
  const newerFailureAt = new Date("2001-01-01T10:02:00.000Z");
  const now = new Date("2001-01-01T10:03:00.000Z");
  const oldModel = "openai:reflection-old";
  const configuredModel = "anthropic:reflection-current";
  const serviceBinding: MemoryOperationBinding = {
    version: 1,
    kind: "service",
    role: "memoryReflection",
    modelId: oldModel,
    inputCommitment: `hmac-sha256:${"D".repeat(43)}`,
  };
  const authorityBinding: MemoryOperationBinding = {
    ...serviceBinding,
    inputCommitment: `hmac-sha256:${"A".repeat(43)}`,
  };
  const staleCheckpointBinding: MemoryOperationBinding = {
    ...serviceBinding,
    inputCommitment: `hmac-sha256:${"S".repeat(43)}`,
  };
  const sourceCheckpointBinding: MemoryOperationBinding = {
    ...serviceBinding,
    inputCommitment: `hmac-sha256:${"P".repeat(43)}`,
  };
  const staleFreshBinding: MemoryOperationBinding = {
    ...serviceBinding,
    inputCommitment: `hmac-sha256:${"F".repeat(43)}`,
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
    const recoverAfter = new Date("2001-01-02T10:00:00.000Z");
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
      acceptedModelBinding: authorityBinding,
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
    }, {
      recordId: recordIds.staleCheckpointQuarantine,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "publication_unavailable",
      failureDetail: "publication_plan_stale",
      acceptedModelBinding: staleCheckpointBinding,
      acceptedModelBindingGeneration: 1,
      organizerProposalCheckpoint: savedCheckpoint,
      dueSince: failedAt,
      startedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    }, {
      recordId: recordIds.sourceCheckpointQuarantine,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "publication_unavailable",
      failureDetail: "publication_source_unavailable",
      acceptedModelBinding: sourceCheckpointBinding,
      acceptedModelBindingGeneration: 1,
      organizerProposalCheckpoint: savedCheckpoint,
      dueSince: failedAt,
      startedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    }, {
      recordId: recordIds.humanStaleCheckpoint,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "publication_unavailable",
      failureDetail: "publication_plan_stale",
      acceptedModelBinding: humanBinding,
      acceptedModelBindingGeneration: 1,
      organizerProposalCheckpoint: savedCheckpoint,
      dueSince: failedAt,
      startedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    }, {
      recordId: recordIds.staleFreshCalculation,
      generation: 1,
      changeReason: "created",
      stage: "organization",
      state: "quarantined",
      attemptCount: 8,
      quarantineRound: 1,
      recoverAfter,
      failureCode: "publication_unavailable",
      failureDetail: "publication_plan_stale",
      acceptedModelBinding: staleFreshBinding,
      acceptedModelBindingGeneration: 1,
      organizerProposalResumedAt: failedAt,
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

    const request = (
      cutoff: Date,
      requestAt = now,
      page?: Readonly<{ after: string | null; limit: number }>,
    ) => createPostgresJsCanonicalBridgeConnection(db)
      .transaction((tx, executor) => requestManualReflectionRecovery({
        db: tx,
        executor,
        now: requestAt,
        observedThrough: cutoff,
        authorizedBy: operator.id,
        modelId: configuredModel,
        ...(page === undefined ? {} : { page }),
      }), { isolationLevel: "read committed" });
    let cursor: string | null = null;
    let pagedQueued = 0;
    let pagedHeld = 0;
    let pagedSummaries = 0;
    let pageCount = 0;
    do {
      const page = await request(observedThrough, now, { after: cursor, limit: 2 });
      pagedQueued += page.queued;
      pagedHeld += page.held;
      pagedSummaries += page.derivedRepair.summariesQueued;
      cursor = page.nextCursor ?? null;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
      if (page.nextCursor !== undefined) {
        const decoded = Buffer.from(page.nextCursor, "base64url").toString("utf8");
        expect(decoded).not.toContain(oldModel);
        expect(Object.values(recordIds).every(recordId => !decoded.includes(recordId))).toBe(true);
        if (pageCount === 1) {
          const changedCutoff = await request(
            new Date(observedThrough.getTime() + 1),
            now,
            { after: page.nextCursor, limit: 2 },
          ).then(() => undefined, (error: unknown) => error);
          expect(changedCutoff).toBeInstanceOf(RangeError);
        }
      }
    } while (cursor !== null);
    expect({ queued: pagedQueued, held: pagedHeld, summariesQueued: pagedSummaries })
      .toEqual({ queued: 7, held: 3, summariesQueued: 0 });
    expect(pageCount).toBeGreaterThan(1);
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
      recoverAfter,
      failureCode: "candidate_unavailable",
      failureDetail: "candidate_selection_invalid",
    });
    expect(byId.get(recordIds.authorityQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter: now,
      acceptedModelBinding: authorityBinding,
      organizerProposalCheckpoint: savedCheckpoint,
    });
    expect(byId.get(recordIds.staleCheckpointQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter: now,
      failureCode: "publication_unavailable",
      failureDetail: "publication_plan_stale",
      organizerProposalCheckpoint: savedCheckpoint,
      manualRecoverySourceGeneration: 1,
      manualRecoveryAuthorizedBy: operator.id,
      manualRecoveryObservedThrough: observedThrough,
      manualRecoveryServiceModelId: configuredModel,
      manualRecoverySpentAt: null,
    });
    expect(byId.get(recordIds.sourceCheckpointQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter: now,
      failureCode: "publication_unavailable",
      failureDetail: "publication_source_unavailable",
      organizerProposalCheckpoint: savedCheckpoint,
      manualRecoveryId: null,
      manualRecoverySourceGeneration: null,
      manualRecoveryAuthorizedBy: null,
      manualRecoveryObservedThrough: null,
      manualRecoveryServiceModelId: null,
      manualRecoverySpentAt: null,
    });
    expect(byId.get(recordIds.humanStaleCheckpoint)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter: now,
      acceptedModelBinding: humanBinding,
      acceptedModelBindingGeneration: 1,
      organizerProposalCheckpoint: savedCheckpoint,
      manualRecoveryId: null,
      manualRecoverySourceGeneration: null,
      manualRecoveryServiceModelId: null,
      manualRecoverySpentAt: null,
    });
    expect(byId.get(recordIds.staleFreshCalculation)).toMatchObject({
      generation: 2,
      state: "due",
      acceptedModelBinding: null,
      acceptedModelBindingGeneration: null,
      manualRecoverySourceGeneration: 1,
      manualRecoveryAuthorizedBy: operator.id,
      manualRecoveryObservedThrough: observedThrough,
      manualRecoveryServiceModelId: configuredModel,
    });
    expect(byId.get(recordIds.otherQuarantine)).toMatchObject({
      generation: 1,
      state: "quarantined",
      recoverAfter,
    });

    // Replaying the same HTTP observation cannot authorize the newer failure
    // and cannot create another generation for either already-queued subject.
    expect(await request(observedThrough)).toEqual({
      queued: 0,
      held: 3,
      derivedRepair: { retired: 0, sourcesQueued: 0, summariesQueued: 0 },
    });
    expect(await request(newerFailureAt)).toEqual({
      queued: 1,
      held: 3,
      derivedRepair: { retired: 0, sourcesQueued: 0, summariesQueued: 0 },
    });

    // A saved service-funded result that proves it needs a fresh calculation
    // carries this click's exact authorization forward by one generation. The
    // old claim cannot roll it over twice, and the Human-funded sibling never
    // acquires service-spend authorization.
    await db.update(reflectionRecordSemanticWork).set({
      recoveryPolicyVersion: DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_VERSION,
    }).where(inArray(reflectionRecordSemanticWork.recordId, [
      recordIds.authorityQuarantine,
      recordIds.candidateQuarantine,
      recordIds.humanStaleCheckpoint,
      recordIds.otherQuarantine,
      recordIds.sourceCheckpointQuarantine,
    ]));
    await db.update(reflectionRecordSemanticWork).set({
      recoverAfter: new Date("2000-12-31T10:00:00.000Z"),
    }).where(and(
      eq(reflectionRecordSemanticWork.recordId, recordIds.staleCheckpointQuarantine),
      eq(reflectionRecordSemanticWork.generation, 1),
    ));
    const createStore = async (executor: PostgresJsBridgeExecutor) => {
      const handle = await verifyRecordProductPostgresHandle({
        query: executor.query.bind(executor),
        transaction: use => use(executor),
      });
      return new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(0x5a)),
        clock: () => new Date("2001-01-01T10:04:00.000Z"),
      });
    };
    const claimed = await createPostgresJsCanonicalBridgeConnection(db)
      .transaction(async (_tx, executor) => (await createStore(executor)).claimNext(), {
        isolationLevel: "read committed",
      });
    expect(claimed).toMatchObject({
      status: "claimed",
      claim: { recordRef: recordIds.staleCheckpointQuarantine, generation: 1 },
    });
    if (claimed.status !== "claimed") throw new Error("missing conditional recovery claim");
    const claim = claimed.claim;
    const rollover = () => createPostgresJsCanonicalBridgeConnection(db)
      .transaction(async (_tx, executor) => {
        return (await createStore(executor)).defer({
          claim,
          failureCode: "publication_unavailable",
          failureDetail: "publication_plan_stale",
          requiresFreshCalculation: true,
        });
      }, { isolationLevel: "read committed" });
    const conditionalRecoveryId = byId.get(recordIds.staleCheckpointQuarantine)
      ?.manualRecoveryId;
    expect(conditionalRecoveryId).toBeString();
    expect(await rollover()).toEqual({ status: "deferred" });
    const [rolledOver] = await db.select().from(reflectionRecordSemanticWork).where(eq(
      reflectionRecordSemanticWork.recordId,
      recordIds.staleCheckpointQuarantine,
    ));
    expect(rolledOver).toMatchObject({
      generation: 2,
      state: "due",
      acceptedModelBinding: null,
      acceptedModelBindingGeneration: null,
      organizerProposalCheckpoint: null,
      manualRecoveryId: conditionalRecoveryId,
      manualRecoverySourceGeneration: 1,
      manualRecoveryAuthorizedBy: operator.id,
      manualRecoveryObservedThrough: observedThrough,
      manualRecoveryServiceModelId: configuredModel,
      manualRecoverySpentAt: null,
    });
    expect(await rollover()).toEqual({ status: "superseded" });
    expect((await db.select({
      generation: reflectionRecordSemanticWork.generation,
    }).from(reflectionRecordSemanticWork).where(eq(
      reflectionRecordSemanticWork.recordId,
      recordIds.staleCheckpointQuarantine,
    )))[0]?.generation).toBe(2);

    // A pre-binding failure may resume the original unspent authorization.
    // The same observation cannot issue a new grant or reset a spent one.
    const preBindingFailureAt = new Date(rolledOver!.updatedAt.getTime() + 30_000);
    const retryAt = new Date(preBindingFailureAt.getTime() + 1_000);
    const subject = eq(reflectionRecordSemanticWork.recordId, recordIds.preBindingHold);
    await db.insert(reflectionRecordSemanticWork).values({
      ...rolledOver!,
      recordId: recordIds.preBindingHold,
      stage: "organization", state: "quarantined", quarantineRound: 1,
      failureCode: "unexpected_failure", failureDetail: "unexpected_model_invocation_failure",
      nextAttemptAt: null, recoverAfter, updatedAt: preBindingFailureAt,
    });
    await request(preBindingFailureAt, retryAt);
    const [rearmed] = await db.select().from(reflectionRecordSemanticWork).where(subject);
    expect(rearmed).toMatchObject({
      generation: 2, state: "quarantined", recoverAfter: retryAt,
      manualRecoveryId: conditionalRecoveryId, manualRecoverySourceGeneration: 1,
      manualRecoveryObservedThrough: observedThrough, manualRecoverySpentAt: null,
      acceptedModelBinding: null,
    });
    await db.update(reflectionRecordSemanticWork).set({
      manualRecoverySpentAt: retryAt, recoverAfter, updatedAt: retryAt,
    }).where(subject);
    await request(retryAt, new Date(retryAt.getTime() + 1_000));
    const [spent] = await db.select().from(reflectionRecordSemanticWork).where(subject);
    expect(spent).toMatchObject({ generation: 2, recoverAfter, manualRecoverySpentAt: retryAt });
  } finally {
    if (usageIds.length > 0) {
      await db.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, usageIds));
    }
    await db.update(reflectionRecords).set({ disposition: "purged" })
      .where(inArray(reflectionRecords.recordId, Object.values(recordIds)));
    await db.delete(reflectionRecordSemanticWork).where(inArray(
      reflectionRecordSemanticWork.recordId,
      Object.values(recordIds),
    ));
    await db.delete(users).where(eq(users.id, operator.id));
  }
});

test("manual Reflection recovery retains a stale checkpoint behind a pending publication", async () => {
  const suffix = randomUUID();
  const rollback = new Error("rollback pending-publication fixture");
  try {
    await createPostgresJsCanonicalBridgeConnection(db).transaction(async (tx, executor) => {
      const [operator] = await tx.insert(users).values({
        name: "Reflection publication fence operator",
        email: `manual-reflection-publication-${suffix}@integration.test`,
        handle: `manual_reflection_pub_${suffix.replaceAll("-", "").slice(0, 8)}`,
      }).returning({ id: users.id });
      if (!operator) throw new Error("missing Reflection publication fence operator");
      const recordId = `manual-reflection-${suffix}-pending-publication`;
      const failedAt = new Date("2001-01-01T11:00:00.000Z");
      const observedThrough = new Date("2001-01-01T11:01:00.000Z");
      const binding: MemoryOperationBinding = {
        version: 1,
        kind: "service",
        role: "memoryReflection",
        modelId: "openai:reflection-old",
        inputCommitment: `hmac-sha256:${"P".repeat(43)}`,
      };
      await tx.insert(reflectionRecords).values({
        recordId,
        lifecycle: "current",
        structuralHeight: 1,
        producerPolicyVersion: "manual-recovery-test-v1",
        processingGeneration: 1,
      });
      await tx.insert(reflectionRecordSemanticWork).values({
        recordId,
        generation: 1,
        changeReason: "created",
        stage: "organization",
        state: "quarantined",
        attemptCount: 8,
        quarantineRound: 1,
        recoverAfter: new Date("2001-01-02T11:00:00.000Z"),
        failureCode: "publication_unavailable",
        failureDetail: "publication_plan_stale",
        acceptedModelBinding: binding,
        acceptedModelBindingGeneration: 1,
        organizerProposalCheckpoint: new Uint8Array([1, 2, 3]),
        dueSince: failedAt,
        startedAt: failedAt,
        createdAt: failedAt,
        updatedAt: failedAt,
      });
      await tx.insert(reflectionRecordPublications).values({
        publicationId: `manual-reflection-publication-${suffix}`,
        recordId,
        representation: "protected",
        representationGeneration: 1,
        requestCommitment: new Uint8Array(32).fill(7),
        publicationBindingRef: `manual-reflection-binding-${suffix}`,
        state: "reserved",
        createdAt: failedAt,
        updatedAt: failedAt,
      });

      expect(await requestManualReflectionRecovery({
        db: tx,
        executor,
        now: new Date("2001-01-01T11:02:00.000Z"),
        observedThrough,
        authorizedBy: operator.id,
        modelId: "anthropic:reflection-current",
      })).toEqual({
        queued: 0,
        held: 1,
        derivedRepair: { retired: 0, sourcesQueued: 0, summariesQueued: 0 },
      });
      throw rollback;
    }, { isolationLevel: "read committed" });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test.each(["same", "replacement"])("a later Reflection click grants one fresh attempt on the %s model for a fully refused spent family", async target => {
  const suffix = randomUUID();
  const [operator] = await db.insert(users).values({
    name: "Reflection refusal recovery operator",
    email: `reflection-refusal-click-${suffix}@integration.test`,
    handle: `reflection_click_${suffix.replaceAll("-", "").slice(0, 10)}`,
  }).returning({ id: users.id });
  if (!operator) throw new Error("missing refusal recovery operator");
  const [namespace] = await db.insert(namespaces).values({
    scope: "private", label: `reflection-refusal-click-${suffix}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("missing refusal recovery namespace");
  const roomId = randomUUID();
  const batchId = randomUUID();
  const recordIds = [
    randomUUID(),
    randomUUID(),
  ];
  const authorizedAt = new Date("2001-02-01T10:00:00.000Z");
  const spentAt = new Date("2001-02-01T10:00:30.000Z");
  const refusedAt = new Date("2001-02-01T10:01:00.000Z");
  const beforeRefusal = new Date(refusedAt.getTime() - 1);
  const clickedAt = new Date("2001-02-01T10:02:00.000Z");
  const processedAt = new Date("2001-02-01T10:03:00.000Z");
  const retryAt = new Date("2001-02-02T10:00:00.000Z");
  const oldModel = "openai:reflection-old";
  const newModel = target === "same" ? oldModel : "anthropic:reflection-current";
  const binding: MemoryOperationBinding = {
    version: 1, kind: "service", role: "memoryReflection", modelId: oldModel,
    inputCommitment: `hmac-sha256:${"R".repeat(43)}`,
  };
  const oldRecoveryId = randomUUID();
  try {
    await db.insert(rooms).values({
      id: roomId, ownerId: operator.id, type: "private",
      label: "Reflection refusal click", graphThreadId: `room:${roomId}`,
      namespaceId: namespace.id,
    });
    await db.insert(roomJournalBatches).values({
      id: batchId, roomId, fromMessageIdExclusive: 0, throughMessageIdInclusive: 2,
      extractorVersion: "reflection-refusal-click-v1", status: "completed",
    });
    await db.insert(reflectionRecords).values(recordIds.map(recordId => ({
      recordId, lifecycle: "current" as const, structuralHeight: 1,
      producerPolicyVersion: "reflection-refusal-click-v1", processingGeneration: 1,
    })));
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('nautilo.stenographer_writer_version', '2', true)`);
      await tx.insert(roomEvents).values(recordIds.map((recordId, index) => ({
        id: recordId, roomId, sequence: index + 1, kind: "fact" as const,
        statement: null, status: "active" as const, sourceMessageIds: [index + 1],
        sourceBatchId: batchId, batchLocalOrdinal: index,
        extractorVersion: "reflection-refusal-click-v1", projectionKind: "native" as const,
        recordId, nativeAttachedAt: authorizedAt, createdAt: authorizedAt,
      })));
    });
    await db.insert(reflectionRecordSemanticWork).values(recordIds.map(recordId => ({
      recordId, generation: 2, changeReason: "created" as const,
      stage: "organization" as const, state: "checkpointed" as const,
      waitingReason: "provider" as const, acceptedModelBindingGeneration: 2,
      acceptedModelBinding: binding, dueSince: authorizedAt, startedAt: authorizedAt,
      nextAttemptAt: retryAt, manualRecoveryId: oldRecoveryId,
      manualRecoverySourceGeneration: 1, manualRecoveryAuthorizedBy: operator.id,
      manualRecoveryAuthorizedAt: authorizedAt,
      manualRecoveryObservedThrough: authorizedAt,
      manualRecoveryServiceModelId: oldModel, manualRecoverySpentAt: spentAt,
      createdAt: authorizedAt, updatedAt: spentAt,
    })));
    await db.insert(llmUsageEvents).values({
      roomId, occurredAt: refusedAt, callType: "room_reflection", model: oldModel,
      provider: "openai", providerRoute: "surplus", fundingKind: "service",
      endpoint: "/v1/chat/completions", attemptOutcome: "failed",
      costState: "unknown", failureCode: "provider_refused",
      metadata: { operationId: reflectionModelOperationId(binding, "primary") },
    });
    const request = (
      observedThrough: Date,
      now: Date,
      page?: Readonly<{ after: string | null; limit: number }>,
    ) =>
      createPostgresJsCanonicalBridgeConnection(db).transaction((tx, executor) =>
        requestManualReflectionRecovery({
          db: tx, executor, now, observedThrough,
          authorizedBy: operator.id, modelId: newModel,
          ...(page === undefined ? {} : { page }),
        }), { isolationLevel: "read committed" });

    expect(await request(beforeRefusal, clickedAt)).toMatchObject({ queued: 0, held: 2 });
    const before = await db.select().from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    expect(before.every(row => row.generation === 2
      && row.manualRecoveryId === oldRecoveryId
      && row.acceptedModelBinding?.modelId === oldModel)).toBe(true);
    expect(await request(refusedAt, clickedAt)).toMatchObject({ queued: 0, held: 2 });

    let cursor: string | null = null;
    let queued = 0;
    let held = 0;
    let pages = 0;
    do {
      const result = await request(clickedAt, processedAt, { after: cursor, limit: 1 });
      queued += result.queued;
      held += result.held;
      cursor = result.nextCursor ?? null;
      pages += 1;
      expect(pages).toBeLessThan(8);
      if (result.nextCursor !== undefined) {
        const decoded = Buffer.from(result.nextCursor, "base64url").toString("utf8");
        expect(recordIds.every(recordId => !decoded.includes(recordId))).toBe(true);
      }
    } while (cursor !== null);
    expect({ queued, held }).toEqual({ queued: 2, held: 0 });
    const after = await db.select().from(reflectionRecordSemanticWork)
      .where(inArray(reflectionRecordSemanticWork.recordId, recordIds));
    const newRecoveryId = after[0]?.manualRecoveryId;
    expect(newRecoveryId).toBeString();
    expect(newRecoveryId).not.toBe(oldRecoveryId);
    expect(after.every(row => row.generation === 3
      && row.state === "due"
      && row.acceptedModelBinding === null
      && row.manualRecoveryId === newRecoveryId
      && row.manualRecoverySourceGeneration === 2
      && row.manualRecoveryAuthorizedAt?.getTime() === clickedAt.getTime()
      && row.manualRecoveryServiceModelId === newModel
      && row.manualRecoverySpentAt === null)).toBe(true);
    const [historicRefusal] = await db.select({
      model: llmUsageEvents.model,
      outcome: llmUsageEvents.attemptOutcome,
      failureCode: llmUsageEvents.failureCode,
    }).from(llmUsageEvents).where(eq(llmUsageEvents.roomId, roomId));
    expect(historicRefusal).toEqual({
      model: oldModel, outcome: "failed", failureCode: "provider_refused",
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
    await db.delete(users).where(eq(users.id, operator.id));
  }
});
