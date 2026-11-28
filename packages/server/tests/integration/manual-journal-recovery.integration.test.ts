import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  isNull,
  llmUsageEvents,
  namespaces,
  queryStenographerAdminStatus,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  roomEvents,
  roomJournalBatches,
  roomJournalModelRecoveries,
  roomJournalState,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import {
  deleteMessageHardInTx,
  editCanonicalTranscriptMessageInTx,
} from "@nautilo/trust";
import {
  candidateRoomIds,
  compactionCandidateRooms,
  compactionModelExposureDependencies,
  createOrdinaryStenographerIntentAdapter,
  extractionModelExposureDependencies,
  failCompaction,
  failExtraction,
  historicalCandidateRoomIds,
  resolveCurrentOrdinaryCompactionCoordinates,
  tryClaimCompactionRoom,
  tryClaimRoom,
  type CompactionClaim,
  type ExtractionClaim,
} from "@nautilo/runtime";
import { createStenographerMemoryFunding } from "../../src/lib/stenographer-memory-funding";
import { requestManualJournalRecovery } from "../../src/lib/request-manual-journal-recovery";

type Db = ReturnType<typeof createDirectDb>;
type Fixture = Readonly<{
  userId: string;
  userActorId: string;
  agentId: string;
  agentActorId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
  messageId: number;
  recordIds: string[];
}>;

let db: Db;
const fixtures: Fixture[] = [];
const TEST_EXTRACTOR_VERSION = "journal-recovery-fixture-v1";
const BASE = new Date(Date.now() - 4 * 60_000);
const MODEL = "fixture:journal-service";
const RECOVERY_MODEL = "fixture:journal-recovery-service";

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(4);
});

afterAll(async () => {
  for (const fixture of fixtures.reverse()) {
    await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, fixture.roomId));
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, fixture.sessionId));
    await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.roomId));
    await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
    if (fixture.recordIds.length > 0) {
      await db.update(reflectionRecords).set({ disposition: "purged" }).where(inArray(
        reflectionRecords.recordId,
        fixture.recordIds,
      ));
      await db.delete(reflectionRecordPayloadRepresentationHeads).where(inArray(
        reflectionRecordPayloadRepresentationHeads.recordId,
        fixture.recordIds,
      ));
      await db.delete(reflectionRecordPayloadRepresentations).where(inArray(
        reflectionRecordPayloadRepresentations.recordId,
        fixture.recordIds,
      ));
    }
    await db.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
    await db.delete(actors).where(eq(actors.id, fixture.agentActorId));
    await db.delete(agents).where(eq(agents.id, fixture.agentId));
    await db.delete(actors).where(eq(actors.id, fixture.userActorId));
    await db.delete(users).where(eq(users.id, fixture.userId));
  }
  await db?.end();
}, 30_000);

async function fixture(label: string): Promise<Fixture> {
  const id = randomUUID();
  const [user] = await db.insert(users).values({
    name: `Journal recovery ${label}`,
    email: `journal-recovery-${id}@integration.test`,
  }).returning({ id: users.id });
  const [human] = await db.insert(actors).values({
    ownerId: user!.id, displayName: "Journal recovery operator", kind: "user",
  }).returning({ id: actors.id });
  const [agent] = await db.insert(agents).values({
    handle: `journal-recovery-${id}`,
  }).returning({ id: agents.id });
  const [agentActor] = await db.insert(actors).values({
    ownerId: user!.id, displayName: "Journal recovery Agent", kind: "agent",
    agentId: agent!.id,
  }).returning({ id: actors.id });
  const [namespace] = await db.insert(namespaces).values({
    scope: "private", label: `journal-recovery-${id}`,
  }).returning({ id: namespaces.id });
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId, ownerId: user!.id, type: "private", label,
    graphThreadId: `room:${roomId}`, namespaceId: namespace!.id,
    humanActorIds: [human!.id], createdBy: human!.id,
  });
  await db.insert(roomMembers).values([
    { roomId, actorId: human!.id, roomRole: "admin", joinedAt: BASE },
    { roomId, actorId: agentActor!.id, roomRole: "member", joinedAt: BASE },
  ]);
  const [session] = await db.insert(sessions).values({
    threadId: `journal-recovery:${id}`, ownerId: user!.id, personaId: "owner",
    agentId: agent!.id, roomId, channel: "electron",
  }).returning({ id: sessions.id });
  const [message] = await db.insert(sessionMessages).values({
    sessionId: session!.id, role: "user", content: "Synthetic Journal evidence",
    fingerprint: `fp:v1:human:${id}`, createdAt: new Date(BASE.getTime() + 1_000),
  }).returning({ id: sessionMessages.id });
  await db.insert(roomJournalState).values({
    roomId, extractorVersion: TEST_EXTRACTOR_VERSION, historicalBackfillStatus: "not_needed",
    createdAt: BASE, updatedAt: BASE,
  });
  const value = {
    userId: user!.id, userActorId: human!.id, agentId: agent!.id,
    agentActorId: agentActor!.id, namespaceId: namespace!.id,
    roomId, sessionId: session!.id, messageId: message!.id, recordIds: [],
  };
  fixtures.push(value);
  return value;
}

function funding(
  createInvoker: () => (prompt: string) => Promise<string>,
  humanId: string,
  afterOuterCheck?: () => Promise<void>,
) {
  return createStenographerMemoryFunding({
    db,
    ports: {
      readRecord: (dependency) => Promise.resolve({
        recordRef: dependency.recordRef,
        lifecycle: "current",
        structuralHeight: 0,
        processingGeneration: dependency.observedProcessingGeneration,
        semantic: {
          observedContentFingerprint: `fixture:${dependency.recordRef}`,
          posture: "derived",
          statement: "Synthetic Journal evidence",
          sourceDependencies: [],
          anchors: [],
          childRecordRefs: [],
          producer: {
            producerRef: "stenographer",
            policyVersion: "manual-journal-recovery-fixture-v1",
          },
          terminalAuthorityLeafHandles: dependency.terminalAuthorityLeafHandles,
          modelExposureDependencies: [],
        },
      } satisfies DurableRecordEnvelope),
      readSource: () => Promise.resolve({
        status: "current", kind: "unknown",
        audienceHumanIds: [humanId], includesPublicBoundary: false,
      }),
      readAudience: () => Promise.resolve({
        humanIds: [humanId], includesPublicBoundary: false,
      }),
    },
    budget: { maxVisitedRecords: 256, maxTraversalWork: 1_024 },
    commitmentKey: new Uint8Array(32).fill(29),
    resolveServiceModel: () => MODEL,
    assertAvailable: () => Promise.resolve(),
    admitsCurrentServiceInputs: async (tx, dependencies) => {
      const messageIds = [...new Set(dependencies.flatMap((dependency) => {
        if (dependency.kind !== "source"
          || dependency.sourceKind !== "message") return [];
        const match = /^message:(\d+)$/u.exec(dependency.logicalSourceRef);
        if (match === null) return [];
        const messageId = Number(match[1]);
        return Number.isSafeInteger(messageId) && messageId > 0
          ? [messageId]
          : [];
      }))];
      if (messageIds.length === 0) return dependencies.length > 0;
      const current = await tx.select({ id: sessionMessages.id })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .innerJoin(users, eq(users.id, sessions.ownerId))
        .where(and(
          inArray(sessionMessages.id, messageIds),
          isNull(users.disabledAt),
        ));
      return current.length === messageIds.length;
    },
    createInvoker: options => {
      const invoke = createInvoker();
      return async (prompt, signal) => {
        signal?.throwIfAborted();
        await options.assertCurrent?.();
        await afterOuterCheck?.();
        await options.beforeProviderDispatch?.();
        return invoke(prompt);
      };
    },
  });
}

async function recordUnknownAttempt(input: Readonly<{
  roomId: string;
  callType: "room_stenographer" | "room_event_compaction";
  operationId: string;
  modelId: string;
  at: Date;
  fundingKind?: "personal" | "server" | "service" | null;
  payerHumanId?: string;
}>): Promise<void> {
  const fundingKind = input.fundingKind === undefined
    ? "service"
    : input.fundingKind;
  await db.insert(llmUsageEvents).values({
    roomId: input.roomId, callType: input.callType, provider: "fixture",
    model: input.modelId,
    providerRoute: fundingKind === null ? null : "fixture",
    fundingKind,
    payerHumanId: fundingKind === "personal" ? input.payerHumanId : null,
    credentialId: fundingKind === "personal" ? randomUUID() : null,
    credentialRevision: fundingKind === "personal" ? 1 : null,
    ...(fundingKind === null ? {} : {
      endpoint: "/v1/chat/completions",
      attemptOutcome: "succeeded" as const,
      costState: "estimated" as const,
      estimatedCostUsd: "0.01",
    }),
    occurredAt: input.at,
    metadata: { operationId: input.operationId },
  });
}

async function addNativeCompactionEvents(
  f: Fixture,
  sourceBatchId: string,
  startSequence: number,
  count: number,
): Promise<void> {
  const recordIds = Array.from({ length: count }, () => randomUUID());
  f.recordIds.push(...recordIds);
  const encoder = new TextEncoder();
  await db.transaction(async (tx) => {
    await tx.insert(reflectionRecords).values(recordIds.map(recordId => ({
      recordId,
      lifecycle: "current" as const,
      structuralHeight: 0,
      producerPolicyVersion: "manual-journal-recovery-fixture-v1",
      processingGeneration: 1,
      payloadVersion: 1,
      disposition: "available" as const,
      createdAt: BASE,
      updatedAt: BASE,
    })));
    await tx.insert(reflectionRecordPayloadRepresentations).values(
      recordIds.map((recordId, index) => ({
        recordId,
        representation: "ordinary" as const,
        representationGeneration: 1,
        payloadVersion: 1,
        plaintextPayloadBytes: encoder.encode(JSON.stringify({
          statement: `Synthetic compaction fact ${startSequence + index} ${"x".repeat(520)}`,
        })),
        createdAt: BASE,
      })),
    );
    await tx.insert(reflectionRecordPayloadRepresentationHeads).values(
      recordIds.map(recordId => ({
        recordId,
        representation: "ordinary" as const,
        currentRepresentationGeneration: 1,
        updatedAt: BASE,
      })),
    );
    await tx.execute(sql`
      SELECT set_config('nautilo.stenographer_writer_version', '2', true)
    `);
    await tx.insert(roomEvents).values(recordIds.map((recordId, index) => ({
      id: recordId,
      roomId: f.roomId,
      sequence: startSequence + index,
      kind: "fact" as const,
      statement: null,
      status: "active" as const,
      sourceMessageIds: [f.messageId],
      sourceBatchId,
      batchLocalOrdinal: startSequence + index - 1,
      extractorVersion: TEST_EXTRACTOR_VERSION,
      projectionKind: "native" as const,
      recordId,
      nativeAttachedAt: BASE,
      createdAt: BASE,
    })));
  });
}

async function authorizeExtractionRecovery(
  f: Fixture,
): Promise<{ claim: ExtractionClaim; authorizedAt: Date }> {
  const claimedAt = new Date(Date.now() - 20_000);
  const original = await tryClaimRoom(db, f.roomId, claimedAt);
  if (!original) throw new Error("expected original extraction claim");
  await funding(() => async () => "unused", f.userId)
    .admitExtractionModel(original, extractionModelExposureDependencies(original));
  const failedAt = new Date(claimedAt.getTime() + 1_000);
  await recordUnknownAttempt({
    roomId: f.roomId,
    callType: "room_stenographer",
    operationId: original.batchId,
    modelId: MODEL,
    at: failedAt,
  });
  await failExtraction({
    claim: original,
    errorCode: "provider_outcome_unknown",
    modelId: MODEL,
    db,
    now: failedAt,
  });
  const authorizedAt = new Date(failedAt.getTime() + 1_000);
  const queued = await requestManualJournalRecovery({
    db,
    now: authorizedAt,
    observedThrough: failedAt,
    authorizedBy: f.userId,
    modelId: RECOVERY_MODEL,
  });
  expect(queued.queued).toBeGreaterThanOrEqual(1);
  expect(queued.held).toBe(0);
  const claim = await tryClaimRoom(
    db,
    f.roomId,
    new Date(authorizedAt.getTime() + 1_000),
  );
  if (!claim?.manualModelRecoveryId) {
    throw new Error("expected manual extraction recovery claim");
  }
  return { claim, authorizedAt };
}

async function authorizeCompactionRecovery(
  f: Fixture,
): Promise<{ claim: CompactionClaim; authorizedAt: Date }> {
  const [sourceBatch] = await db.insert(roomJournalBatches).values({
    roomId: f.roomId,
    fromMessageIdExclusive: 0,
    throughMessageIdInclusive: f.messageId,
    extractorVersion: TEST_EXTRACTOR_VERSION,
    observationPublicationVersion: 2,
    status: "completed",
    attemptCount: 1,
    operationCount: 0,
    completedAt: BASE,
    createdAt: BASE,
  }).returning({ id: roomJournalBatches.id });
  await addNativeCompactionEvents(f, sourceBatch!.id, 1, 80);
  const claimedAt = new Date(Date.now() - 20_000);
  await db.update(roomJournalState).set({ compactionDueAt: claimedAt })
    .where(eq(roomJournalState.roomId, f.roomId));
  const original = await tryClaimCompactionRoom(db, f.roomId, claimedAt);
  if (!original) throw new Error("expected original compaction claim");
  await funding(() => async () => "unused", f.userId)
    .admitCompactionModel(original, compactionModelExposureDependencies(original));
  const failedAt = new Date(claimedAt.getTime() + 1_000);
  await recordUnknownAttempt({
    roomId: f.roomId,
    callType: "room_event_compaction",
    operationId: original.modelOperationId,
    modelId: MODEL,
    at: failedAt,
  });
  await failCompaction({
    claim: original,
    errorCode: "provider_outcome_unknown",
    modelId: MODEL,
    db,
    now: failedAt,
  });
  const authorizedAt = new Date(failedAt.getTime() + 1_000);
  expect(await requestManualJournalRecovery({
    db,
    now: authorizedAt,
    observedThrough: failedAt,
    authorizedBy: f.userId,
    modelId: RECOVERY_MODEL,
  })).toEqual({ queued: 1, held: 0 });
  const claim = await tryClaimCompactionRoom(
    db,
    f.roomId,
    new Date(authorizedAt.getTime() + 1_000),
  );
  if (!claim?.manualModelRecoveryId) {
    throw new Error("expected manual compaction recovery claim");
  }
  return { claim, authorizedAt };
}

describe("manual Journal recovery on PostgreSQL", () => {
  test("reports active unknown provider outcomes until each journal lane recovers", async () => {
    const room = await fixture("Recovery dashboard");
    const currentHolds = async () => (await queryStenographerAdminStatus({
      now: BASE, since: BASE, until: BASE, includeRecovery: true,
    }, db)).unresolvedProviderOutcomes!;
    const baseline = await currentHolds();
    const roomState = eq(roomJournalState.roomId, room.roomId);
    await db.update(roomJournalState).set({
      lastExtractionErrorCode: "provider_outcome_unknown",
      lastExtractionErrorAt: BASE,
      extractionFailureCount: 1,
      lastCompactionErrorCode: "provider_outcome_unknown",
      lastCompactionErrorAt: BASE,
      compactionFailureCount: 1,
    }).where(roomState);
    expect(await currentHolds()).toBe(baseline + 2);
    await db.update(roomJournalState).set({ extractionFailureCount: 0 }).where(roomState);
    expect(await currentHolds()).toBe(baseline + 1);
    await db.update(roomJournalState).set({ compactionFailureCount: 0 }).where(roomState);
    expect(await currentHolds()).toBe(baseline);
  });

  test("rejects a disabled Human operator before assessing work", async () => {
    const f = await fixture("disabled-operator");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.userId));
    let rejected: unknown;
    try {
      await requestManualJournalRecovery({
        db,
        now: new Date(),
        observedThrough: new Date(),
        authorizedBy: f.userId,
        modelId: RECOVERY_MODEL,
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("Journal recovery authorizer is unavailable");
  });

  test("recovers a legacy null-binding extraction and observation-fences it", async () => {
    const f = await fixture("extraction");
    const claimedAt = new Date(Date.now() - 60_000);
    const claim = await tryClaimRoom(db, f.roomId, claimedAt);
    if (!claim) throw new Error("expected extraction claim");
    await funding(() => async () => "unused", f.userId)
      .admitExtractionModel(claim, extractionModelExposureDependencies(claim));
    const failedAt = new Date(claimedAt.getTime() + 1_000);
    await recordUnknownAttempt({
      roomId: f.roomId, callType: "room_stenographer",
      operationId: claim.batchId, modelId: MODEL, at: failedAt,
    });
    await failExtraction({ claim, errorCode: "provider_outcome_unknown", modelId: MODEL, db, now: failedAt });
    await db.update(roomJournalBatches).set({
      acceptedModelBinding: null,
    }).where(eq(roomJournalBatches.id, claim.batchId));

    const request = { db, now: new Date(failedAt.getTime() + 1_000), observedThrough: failedAt,
      authorizedBy: f.userId, modelId: RECOVERY_MODEL };
    expect(await requestManualJournalRecovery(request)).toEqual({ queued: 1, held: 0 });
    expect(await requestManualJournalRecovery(request)).toEqual({ queued: 0, held: 0 });
    const recovered = await tryClaimRoom(db, f.roomId, new Date(request.now.getTime() + 1_000));
    expect(recovered?.manualModelRecoveryId).toBeString();
    let calls = 0;
    const admitted = await funding(() => async () => (calls += 1, "[]"), f.userId)
      .admitExtractionModel(
        recovered as ExtractionClaim,
        extractionModelExposureDependencies(recovered as ExtractionClaim),
      );
    expect(admitted.modelId).toBe(RECOVERY_MODEL);
    const [canonicallyBoundBatch] = await db.select({
      binding: roomJournalBatches.acceptedModelBinding,
    }).from(roomJournalBatches).where(eq(roomJournalBatches.id, claim.batchId));
    expect(canonicallyBoundBatch?.binding).toMatchObject({
      version: 1,
      kind: "service",
      role: "memorySummarization",
      modelId: RECOVERY_MODEL,
    });
    expect(canonicallyBoundBatch?.binding?.inputCommitment)
      .toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
    await admitted.invoke("synthetic prompt");
    expect(calls).toBe(1);
    const [spent] = await db.select().from(roomJournalModelRecoveries).where(eq(
      roomJournalModelRecoveries.id,
      recovered!.manualModelRecoveryId!,
    ));
    expect(spent?.spentAt).not.toBeNull();

    const newerFailure = new Date(request.now.getTime() + 3_000);
    await recordUnknownAttempt({
      roomId: f.roomId, callType: "room_stenographer", operationId: claim.batchId,
      modelId: RECOVERY_MODEL, at: newerFailure,
    });
    await failExtraction({ claim: recovered!, errorCode: "provider_outcome_unknown",
      modelId: RECOVERY_MODEL, db, now: newerFailure });
    expect(await requestManualJournalRecovery({ ...request, now: new Date(newerFailure.getTime() + 1_000) }))
      .toEqual({ queued: 0, held: 0 });
    expect(await db.select().from(roomJournalModelRecoveries).where(eq(
      roomJournalModelRecoveries.roomId,
      f.roomId,
    ))).toHaveLength(1);
  }, 30_000);

  test.each(["edit", "delete"] as const)(
    "fences a canonical source-message %s between the outer check and extraction grant spend",
    async (mutation) => {
      const f = await fixture(`dispatch-race-extraction-${mutation}`);
      const { claim, authorizedAt } = await authorizeExtractionRecovery(f);
      let calls = 0;
      let mutated = false;
      const admitted = await funding(
        () => async () => (calls += 1, "[]"),
        f.userId,
        async () => {
          if (mutated) return;
          mutated = true;
          await db.transaction(async (tx) => {
            if (mutation === "edit") {
              const edited = await editCanonicalTranscriptMessageInTx(tx, {
                messageId: f.messageId,
                expectedRevision: 0,
                content: "Synthetic Journal evidence edited after approval",
                clearCryptoObjectId: true,
                editedAt: new Date(authorizedAt.getTime() + 2_000),
              });
              expect(edited).not.toBeNull();
              return;
            }
            await deleteMessageHardInTx(tx, f.messageId);
          });
        },
      ).admitExtractionModel(
        claim,
        extractionModelExposureDependencies(claim),
      );

      const rejected = await admitted.invoke("synthetic extraction prompt")
        .then(() => undefined, (error: unknown) => error);
      expect(rejected).toBeInstanceOf(Error);
      expect(calls).toBe(0);
      const [retired] = await db.select({
        spentAt: roomJournalModelRecoveries.spentAt,
      }).from(roomJournalModelRecoveries).where(eq(
        roomJournalModelRecoveries.id,
        claim.manualModelRecoveryId!,
      ));
      if (mutation === "delete") {
        expect(retired).toBeUndefined();
      } else {
        expect(retired?.spentAt).toBeNull();
      }

      const repeated = await admitted.invoke("synthetic extraction prompt")
        .then(() => undefined, (error: unknown) => error);
      expect(repeated).toBeInstanceOf(Error);
      expect(calls).toBe(0);
      expect(await tryClaimRoom(
        db,
        f.roomId,
        new Date(authorizedAt.getTime() + 180_000),
      )).toBeNull();
      await db.delete(roomJournalModelRecoveries).where(eq(
        roomJournalModelRecoveries.roomId,
        f.roomId,
      ));
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT set_config('nautilo.stenographer_writer_version', '2', true)
        `);
        await tx.update(roomJournalBatches).set({
          status: "completed",
          observationPublicationVersion: 2,
          errorCode: null,
          lastErrorAt: null,
          lastErrorAttempt: null,
          lastErrorModelId: null,
        }).where(eq(roomJournalBatches.roomId, f.roomId));
      });
      await db.update(roomJournalState).set({
        extractionFailureCount: 0,
        lastExtractionErrorCode: null,
        lastExtractionErrorAt: null,
      }).where(eq(roomJournalState.roomId, f.roomId));
    },
    30_000,
  );

  test.each(["unchanged", "same-window representation rewrite"] as const)(
    "%s compaction input is checked atomically with recovery grant spend",
    async (scenario) => {
      const f = await fixture(`dispatch-race-compaction-${scenario}`);
      const { claim, authorizedAt } = await authorizeCompactionRecovery(f);
      let calls = 0;
      let mutated = false;
      const admitted = await funding(
        () => async () => (calls += 1, "compaction result"),
        f.userId,
        async () => {
          if (mutated || scenario === "unchanged") return;
          mutated = true;
          await db.transaction(async (tx) => {
            const recordId = f.recordIds[0]!;
            await tx.insert(reflectionRecordPayloadRepresentations).values({
              recordId,
              representation: "ordinary",
              representationGeneration: 2,
              payloadVersion: 1,
              plaintextPayloadBytes: new TextEncoder().encode(JSON.stringify({
                statement: `Rewritten same-window compaction fact. ${"x".repeat(520)}`,
              })),
              createdAt: new Date(authorizedAt.getTime() + 2_000),
            });
            await tx.update(reflectionRecordPayloadRepresentationHeads).set({
              currentRepresentationGeneration: 2,
              updatedAt: new Date(authorizedAt.getTime() + 2_000),
            }).where(and(
              eq(reflectionRecordPayloadRepresentationHeads.recordId, recordId),
              eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
            ));
          });
          const [head] = await db.select({
            generation: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
          }).from(reflectionRecordPayloadRepresentationHeads).where(and(
            eq(reflectionRecordPayloadRepresentationHeads.recordId, f.recordIds[0]!),
            eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
          ));
          expect(head?.generation).toBe(2);
        },
      ).admitCompactionModel(
        claim,
        compactionModelExposureDependencies(claim),
      );

      const outcome = await admitted.invoke("synthetic compaction prompt")
        .then(() => undefined, (error: unknown) => error);
      const [grant] = await db.select({
        spentAt: roomJournalModelRecoveries.spentAt,
        sourceChangedAt: roomJournalModelRecoveries.sourceChangedAt,
      }).from(roomJournalModelRecoveries).where(eq(
        roomJournalModelRecoveries.id,
        claim.manualModelRecoveryId!,
      ));
      if (scenario === "unchanged") {
        expect(outcome).toBeUndefined();
        expect(calls).toBe(1);
        expect(grant?.spentAt).not.toBeNull();
        expect(grant?.sourceChangedAt).toBeNull();
        return;
      }
      expect(outcome).toBeInstanceOf(Error);
      expect(calls).toBe(0);
      expect(grant?.spentAt).toBeNull();
      expect(grant?.sourceChangedAt).not.toBeNull();
      const repeated = await admitted.invoke("synthetic compaction prompt")
        .then(() => undefined, (error: unknown) => error);
      expect(repeated).toBeInstanceOf(Error);
      expect(calls).toBe(0);
      expect(await tryClaimCompactionRoom(
        db,
        f.roomId,
        new Date(authorizedAt.getTime() + 180_000),
      )).toBeNull();
      await db.delete(roomJournalModelRecoveries).where(eq(
        roomJournalModelRecoveries.roomId,
        f.roomId,
      ));
      await db.update(roomJournalState).set({
        compactionFailureCount: 0,
        lastCompactionErrorCode: null,
        lastCompactionErrorAt: null,
        lastCompactionErrorAttempt: null,
        lastCompactionErrorModelId: null,
      }).where(eq(roomJournalState.roomId, f.roomId));
    },
    30_000,
  );

  test.each([["live", "crash"], ["historical", "crash"], ["live", "admission failure"], ["historical", "admission failure"]] as const)(
    "reclaims an exact unspent %s extraction after %s before first model dispatch",
    async (lane, failure) => {
      const f = await fixture(`pre-dispatch-crash-${lane}`);
      if (lane === "historical") {
        await db.update(roomJournalState).set({
          historicalBackfillStatus: "pending",
          historicalBackfillCursorMessageId: 0,
          historicalBackfillTargetMessageId: f.messageId,
        }).where(eq(roomJournalState.roomId, f.roomId));
      }
      const firstClaimedAt = new Date(Date.now() - 90_000);
      const first = await tryClaimRoom(
        db,
        f.roomId,
        firstClaimedAt,
        120_000,
        lane,
      );
      if (!first) throw new Error(`expected ${lane} extraction claim`);
      await funding(() => async () => "unused", f.userId)
        .admitExtractionModel(first, extractionModelExposureDependencies(first));
      const failedAt = new Date(firstClaimedAt.getTime() + 1_000);
      await recordUnknownAttempt({
        roomId: f.roomId,
        callType: "room_stenographer",
        operationId: first.batchId,
        modelId: MODEL,
        at: failedAt,
      });
      await failExtraction({
        claim: first,
        errorCode: "provider_outcome_unknown",
        modelId: MODEL,
        db,
        now: failedAt,
      });
      const authorizedAt = new Date(failedAt.getTime() + 1_000);
      const queued = await requestManualJournalRecovery({
        db,
        now: authorizedAt,
        observedThrough: failedAt,
        authorizedBy: f.userId,
        modelId: RECOVERY_MODEL,
      });
      expect(queued.queued).toBeGreaterThanOrEqual(1);
      expect(queued.held).toBe(0);

      const recoveryClaimedAt = new Date(authorizedAt.getTime() + 1_000);
      const beforeCrash = await tryClaimRoom(
        db,
        f.roomId,
        recoveryClaimedAt,
        failure === "crash" ? 1 : 120_000,
        lane,
      );
      if (!beforeCrash?.manualModelRecoveryId) {
        throw new Error("expected manual recovery extraction claim");
      }
      const recoveryId = beforeCrash.manualModelRecoveryId;
      const recoveryLease = beforeCrash.leaseToken;

      let restartedAt = new Date(recoveryClaimedAt.getTime() + 1);
      if (failure === "admission failure") {
        const rejected = createOrdinaryStenographerIntentAdapter({
          db, now: () => recoveryClaimedAt, claimExtraction: async () => beforeCrash,
          admitExtractionModel: async () => { throw new Error("model temporarily unavailable"); },
          failExtraction: async (input) => {
            expect(input.modelId).toBe(RECOVERY_MODEL);
            await failExtraction(input);
          },
          publishExtraction: async () => { throw new Error("unexpected publication"); },
        });
        await rejected.prepareExtraction({
          roomId: f.roomId, lane, modelId: "venice:changed-default",
          signal: new AbortController().signal, now: recoveryClaimedAt,
        });
        const [state] = await db.select().from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId));
        expect(state?.leaseToken).not.toBe(recoveryLease);
        expect(await tryClaimRoom(db, f.roomId, restartedAt, 120_000, lane)).toBeNull();
        if (!state?.extractionRetryAfter) throw new Error("expected retry after admission failure");
        restartedAt = new Date(state.extractionRetryAfter.getTime() + 1);
      }
      const reclaimed = await tryClaimRoom(
        db,
        f.roomId,
        restartedAt,
        120_000,
        lane,
      );
      expect(reclaimed).toMatchObject({
        batchId: first.batchId,
        lane,
        manualModelRecoveryId: recoveryId,
      });
      expect(reclaimed?.leaseToken).not.toBe(recoveryLease);
      const [unspent] = await db.select().from(roomJournalModelRecoveries)
        .where(eq(roomJournalModelRecoveries.id, recoveryId));
      expect(unspent).toMatchObject({
        claimLeaseToken: reclaimed?.leaseToken,
        spentAt: null,
      });

      let calls = 0;
      const admitted = await funding(
        () => async () => (calls += 1, "[]"),
        f.userId,
      ).admitExtractionModel(
        reclaimed as ExtractionClaim,
        extractionModelExposureDependencies(reclaimed as ExtractionClaim),
      );
      await admitted.invoke("synthetic prompt");
      expect(calls).toBe(1);
      const [spent] = await db.select().from(roomJournalModelRecoveries)
        .where(eq(roomJournalModelRecoveries.id, recoveryId));
      expect(spent?.spentAt).not.toBeNull();

      const afterSpentLease = new Date(restartedAt.getTime() + 120_001);
      expect(await tryClaimRoom(
        db,
        f.roomId,
        afterSpentLease,
        120_000,
        lane,
      )).toBeNull();
      const [stillSpent] = await db.select().from(roomJournalModelRecoveries)
        .where(eq(roomJournalModelRecoveries.id, recoveryId));
      expect(stillSpent?.spentAt).toEqual(spent?.spentAt);
    },
    30_000,
  );

  test.each(["live", "historical"] as const)(
    "holds a spent manual %s invalid response until a new explicit recovery click",
    async (lane) => {
      const f = await fixture(`manual-invalid-${lane}`);
      if (lane === "historical") {
        await db.update(roomJournalState).set({
          historicalBackfillStatus: "pending",
          historicalBackfillCursorMessageId: 0,
          historicalBackfillTargetMessageId: f.messageId,
        }).where(eq(roomJournalState.roomId, f.roomId));
      }
      const firstAt = new Date(Date.now() - 10_000);
      const first = await tryClaimRoom(db, f.roomId, firstAt, 120_000, lane);
      if (!first) throw new Error(`expected ${lane} extraction claim`);
      await funding(() => async () => "unused", f.userId)
        .admitExtractionModel(first, extractionModelExposureDependencies(first));
      const unknownAt = new Date(firstAt.getTime() + 1_000);
      await recordUnknownAttempt({
        roomId: f.roomId,
        callType: "room_stenographer",
        operationId: first.batchId,
        modelId: MODEL,
        at: unknownAt,
      });
      await failExtraction({
        claim: first,
        errorCode: "provider_outcome_unknown",
        modelId: MODEL,
        db,
        now: unknownAt,
      });
      const authorizedAt = new Date(unknownAt.getTime() + 1_000);
      await requestManualJournalRecovery({
        db,
        now: authorizedAt,
        observedThrough: unknownAt,
        authorizedBy: f.userId,
        modelId: RECOVERY_MODEL,
      });
      const paidClaimedAt = new Date(authorizedAt.getTime() + 1_000);
      const paid = await tryClaimRoom(
        db,
        f.roomId,
        paidClaimedAt,
        120_000,
        lane,
      );
      if (!paid?.manualModelRecoveryId) {
        throw new Error("expected paid extraction recovery claim");
      }
      let calls = 0;
      const statusBeforeInvalid = lane === "live"
        ? await queryStenographerAdminStatus({
            now: new Date(), since: BASE, until: new Date(), includeRecovery: true,
          }, db)
        : null;
      const adapter = createOrdinaryStenographerIntentAdapter({
        ...funding(
          () => async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            calls += 1;
            return "malformed";
          },
          f.userId,
        ),
        db,
        claimExtraction: async () => paid,
        claimCompaction: async () => null,
        prepareNextRebuild: async () => null,
        publishExtraction: async () => ({ published: true, eventsWritten: 0 }),
      });
      const prepared = await adapter.prepareExtraction({
        roomId: f.roomId,
        lane,
        modelId: RECOVERY_MODEL,
        now: paidClaimedAt,
        signal: new AbortController().signal,
      });
      expect(await prepared.publish({ revalidationToken: 1 }))
        .toMatchObject({ status: "failed", processed: true });
      expect(calls).toBe(1);
      const [completedBatch] = await db.select({
        lastErrorAt: roomJournalBatches.lastErrorAt,
      }).from(roomJournalBatches).where(eq(roomJournalBatches.id, paid.batchId));
      const [spentRecovery] = await db.select({
        spentAt: roomJournalModelRecoveries.spentAt,
      }).from(roomJournalModelRecoveries).where(eq(
        roomJournalModelRecoveries.id,
        paid.manualModelRecoveryId,
      ));
      const invalidAt = completedBatch?.lastErrorAt;
      if (invalidAt === null || invalidAt === undefined || spentRecovery?.spentAt === null
        || spentRecovery?.spentAt === undefined) {
        throw new Error("expected durable spent recovery and invalid completion");
      }
      expect(invalidAt.getTime()).toBeGreaterThanOrEqual(
        spentRecovery.spentAt.getTime(),
      );
      expect(invalidAt.getTime()).toBeGreaterThan(paidClaimedAt.getTime());
      if (statusBeforeInvalid !== null) {
        const statusAfterInvalid = await queryStenographerAdminStatus({
          now: invalidAt, since: BASE, until: invalidAt, includeRecovery: true,
        }, db);
        expect(statusAfterInvalid.unresolvedProviderOutcomes)
          .toBe((statusBeforeInvalid.unresolvedProviderOutcomes ?? 0) - 1);
        expect(statusAfterInvalid.health).toBe("degraded");
      }

      const scheduledAt = new Date(invalidAt.getTime() + 60_000);
      const scheduledCandidates = lane === "live"
        ? await candidateRoomIds(db, scheduledAt)
        : await historicalCandidateRoomIds(db, scheduledAt);
      expect(scheduledCandidates).not.toContain(f.roomId);
      expect(await tryClaimRoom(
        db,
        f.roomId,
        scheduledAt,
        120_000,
        lane,
      )).toBeNull();

      const clickedAt = new Date(invalidAt.getTime() + 1_000);
      const click = await requestManualJournalRecovery({
        db,
        now: clickedAt,
        observedThrough: invalidAt,
        authorizedBy: f.userId,
        modelId: RECOVERY_MODEL,
      });
      expect(click.queued).toBeGreaterThanOrEqual(1);
      const clickedCandidates = lane === "live"
        ? await candidateRoomIds(db, scheduledAt)
        : await historicalCandidateRoomIds(db, scheduledAt);
      expect(clickedCandidates).toContain(f.roomId);
      const rearmed = await tryClaimRoom(
        db,
        f.roomId,
        scheduledAt,
        120_000,
        lane,
      );
      expect(rearmed?.manualModelRecoveryId).toBeString();
      expect(rearmed?.manualModelRecoveryId).not.toBe(paid.manualModelRecoveryId);
    },
    30_000,
  );

  test("does not reclaim an unspent extraction across generation, lease, or payer fences", async () => {
    const prepare = async (label: string) => {
      const f = await fixture(`pre-dispatch-fence-${label}`);
      const firstAt = new Date();
      const first = await tryClaimRoom(db, f.roomId, firstAt);
      if (!first) throw new Error("expected extraction claim");
      await funding(() => async () => "unused", f.userId)
        .admitExtractionModel(first, extractionModelExposureDependencies(first));
      const failedAt = new Date(firstAt.getTime() + 1_000);
      await recordUnknownAttempt({
        roomId: f.roomId,
        callType: "room_stenographer",
        operationId: first.batchId,
        modelId: MODEL,
        at: failedAt,
      });
      await failExtraction({
        claim: first,
        errorCode: "provider_outcome_unknown",
        modelId: MODEL,
        db,
        now: failedAt,
      });
      const authorizedAt = new Date(failedAt.getTime() + 1_000);
      expect(await requestManualJournalRecovery({
        db,
        now: authorizedAt,
        observedThrough: failedAt,
        authorizedBy: f.userId,
        modelId: RECOVERY_MODEL,
      })).toEqual({ queued: 1, held: 0 });
      const claimedAt = new Date(authorizedAt.getTime() + 1_000);
      const claim = await tryClaimRoom(db, f.roomId, claimedAt);
      if (!claim?.manualModelRecoveryId) {
        throw new Error("expected manual recovery extraction claim");
      }
      await funding(() => async () => "must not run", f.userId)
        .admitExtractionModel(claim, extractionModelExposureDependencies(claim));
      return {
        f,
        claim,
        recoveryId: claim.manualModelRecoveryId,
        restartedAt: new Date(claimedAt.getTime() + 120_001),
      };
    };

    const generation = await prepare("generation");
    await db.update(roomJournalState).set({
      rebuildGeneration: sql`${roomJournalState.rebuildGeneration} + 1`,
    }).where(eq(roomJournalState.roomId, generation.f.roomId));
    expect(await tryClaimRoom(
      db,
      generation.f.roomId,
      generation.restartedAt,
    )).toBeNull();

    const lease = await prepare("lease");
    await db.update(roomJournalModelRecoveries).set({
      claimLeaseToken: randomUUID(),
    }).where(eq(roomJournalModelRecoveries.id, lease.recoveryId));
    expect(await tryClaimRoom(
      db,
      lease.f.roomId,
      lease.restartedAt,
    )).toBeNull();

    const payer = await prepare("payer");
    await db.update(roomJournalBatches).set({
      acceptedModelBinding: {
        version: 1,
        kind: "human",
        role: "memorySummarization",
        modelId: RECOVERY_MODEL,
        humanUserId: payer.f.userId,
        preferenceRevision: 1,
        funding: {
          kind: "personal",
          providerRoute: "fixture",
          credentialId: randomUUID(),
          credentialRevision: 1,
        },
        inputCommitment: `hmac-sha256:${"A".repeat(43)}`,
      },
    }).where(eq(roomJournalBatches.id, payer.claim.batchId));
    let payerRejected: unknown;
    try {
      await tryClaimRoom(db, payer.f.roomId, payer.restartedAt);
    } catch (error) {
      payerRejected = error;
    }
    expect(payerRejected).toBeInstanceOf(Error);
    expect((payerRejected as Error).message).toContain("recovery binding changed");
    const [payerRecovery] = await db.select().from(roomJournalModelRecoveries)
      .where(eq(roomJournalModelRecoveries.id, payer.recoveryId));
    expect(payerRecovery).toMatchObject({
      claimLeaseToken: payer.claim.leaseToken,
      spentAt: null,
    });
  }, 30_000);

  test("recovers a legacy null-binding compaction hold without publishing twice", async () => {
    const f = await fixture("compaction");
    const [sourceBatch] = await db.insert(roomJournalBatches).values({
      roomId: f.roomId, fromMessageIdExclusive: 0,
      throughMessageIdInclusive: f.messageId, extractorVersion: TEST_EXTRACTOR_VERSION,
      observationPublicationVersion: 2,
      status: "completed", attemptCount: 1, operationCount: 0,
      completedAt: BASE, createdAt: BASE,
    }).returning({ id: roomJournalBatches.id });
    await addNativeCompactionEvents(f, sourceBatch!.id, 1, 80);
    const dueAt = new Date(Date.now() - 60_000);
    await db.update(roomJournalState).set({ compactionDueAt: dueAt })
      .where(eq(roomJournalState.roomId, f.roomId));
    const claim = await tryClaimCompactionRoom(db, f.roomId, dueAt);
    if (!claim) throw new Error("expected compaction claim");
    await funding(() => async () => "unused", f.userId)
      .admitCompactionModel(claim, compactionModelExposureDependencies(claim));
    const failedAt = new Date(dueAt.getTime() + 1_000);
    await recordUnknownAttempt({ roomId: f.roomId, callType: "room_event_compaction",
      operationId: claim.modelOperationId, modelId: MODEL, at: failedAt });
    await failCompaction({ claim, errorCode: "provider_outcome_unknown", modelId: MODEL, db, now: failedAt });
    await db.update(roomJournalState).set({
      compactionAcceptedModelBinding: null,
      compactionAcceptedPlan: null,
    }).where(eq(roomJournalState.roomId, f.roomId));
    const beforeFailure = new Date(failedAt.getTime() - 1);
    expect(await requestManualJournalRecovery({
      db,
      now: new Date(failedAt.getTime() + 1_000),
      observedThrough: beforeFailure,
      authorizedBy: f.userId,
      modelId: RECOVERY_MODEL,
    })).toEqual({ queued: 0, held: 0 });
    expect(await db.select({
      plan: roomJournalState.compactionAcceptedPlan,
    }).from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId)))
      .toEqual([{ plan: null }]);
    const unrelatedWorkId = `${claim.modelOperationId}:unrelated`;
    await db.update(llmUsageEvents).set({
      metadata: { operationId: unrelatedWorkId },
    }).where(and(
      eq(llmUsageEvents.roomId, f.roomId),
      eq(llmUsageEvents.callType, "room_event_compaction"),
      eq(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, claim.modelOperationId),
    ));
    const mismatched = await requestManualJournalRecovery({
      db, now: new Date(failedAt.getTime() + 1_000), observedThrough: failedAt,
      authorizedBy: f.userId, modelId: RECOVERY_MODEL,
    });
    expect(mismatched.held).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(roomJournalModelRecoveries).where(and(
      eq(roomJournalModelRecoveries.roomId, f.roomId),
      eq(roomJournalModelRecoveries.workKind, "compaction"),
    ))).toHaveLength(0);
    expect(await db.select({
      plan: roomJournalState.compactionAcceptedPlan,
    }).from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId)))
      .toEqual([{ plan: null }]);
    await db.update(llmUsageEvents).set({
      metadata: { operationId: claim.modelOperationId },
    }).where(and(
      eq(llmUsageEvents.roomId, f.roomId),
      eq(llmUsageEvents.callType, "room_event_compaction"),
      eq(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, unrelatedWorkId),
    ));
    await recordUnknownAttempt({
      roomId: f.roomId,
      callType: "room_event_compaction",
      operationId: unrelatedWorkId,
      modelId: MODEL,
      at: new Date(failedAt.getTime() + 500),
    });
    const result = await requestManualJournalRecovery({
      db, now: new Date(failedAt.getTime() + 1_000), observedThrough: failedAt,
      authorizedBy: f.userId, modelId: RECOVERY_MODEL,
    });
    expect(result).toEqual({ queued: 1, held: 0 });
    const [queuedRecovery] = await db.select({
      workId: roomJournalModelRecoveries.workId,
    }).from(roomJournalModelRecoveries).where(and(
      eq(roomJournalModelRecoveries.roomId, f.roomId),
      eq(roomJournalModelRecoveries.workKind, "compaction"),
    ));
    expect(queuedRecovery?.workId).toBe(claim.modelOperationId);
    const recoveredAt = new Date(failedAt.getTime() + 2_000);
    expect((await compactionCandidateRooms(db, recoveredAt))
      .map((candidate) => candidate.roomId)).toContain(f.roomId);
    const recovered = await tryClaimCompactionRoom(db, f.roomId, recoveredAt, 1);
    expect(recovered?.manualModelRecoveryId).toBeString();
    const reboundOnce = await tryClaimCompactionRoom(
      db,
      f.roomId,
      new Date(recoveredAt.getTime() + 1),
      1,
    );
    const reboundTwice = await tryClaimCompactionRoom(
      db,
      f.roomId,
      new Date(recoveredAt.getTime() + 2),
      120_000,
    );
    expect(reboundOnce?.manualModelRecoveryId)
      .toBe(recovered?.manualModelRecoveryId);
    expect(reboundTwice?.manualModelRecoveryId)
      .toBe(recovered?.manualModelRecoveryId);
    expect(reboundTwice?.leaseToken).not.toBe(reboundOnce?.leaseToken);
    const [legacyClaimedState] = await db.select({
      binding: roomJournalState.compactionAcceptedModelBinding,
    }).from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId));
    expect(legacyClaimedState?.binding).toBeNull();
    const rejected = createOrdinaryStenographerIntentAdapter({
      db, now: () => new Date(recoveredAt.getTime() + 3), claimCompaction: async () => reboundTwice,
      admitCompactionModel: async () => { throw new Error("model temporarily unavailable"); },
      failCompaction: async (input) => {
        expect(input.modelId).toBe(RECOVERY_MODEL);
        await failCompaction(input);
      },
      publishExtraction: async () => { throw new Error("unexpected publication"); },
    });
    await rejected.prepareCompaction({
      roomId: f.roomId, modelId: "venice:changed-default",
      now: recoveredAt, signal: new AbortController().signal,
    });
    const [parked] = await db.select().from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId));
    if (!parked?.compactionRetryAfter) throw new Error("expected deferred compaction");
    expect(parked.compactionLeaseToken).not.toBe(reboundTwice?.leaseToken);
    const retryAt = new Date(parked.compactionRetryAfter.getTime() + 1);
    const resumed = await tryClaimCompactionRoom(db, f.roomId, retryAt);
    expect(resumed?.manualModelRecoveryId).toBe(recovered?.manualModelRecoveryId);
    let calls = 0;
    const adapter = createOrdinaryStenographerIntentAdapter({
      ...funding(
        () => async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          calls += 1;
          return "malformed";
        },
        f.userId,
      ),
      db,
      claimExtraction: async () => null,
      claimCompaction: async () => resumed as CompactionClaim,
      prepareNextRebuild: async () => null,
      publishExtraction: async () => ({ published: true, eventsWritten: 0 }),
    });
    const prepared = await adapter.prepareCompaction({
      roomId: f.roomId,
      modelId: RECOVERY_MODEL,
      now: new Date(recoveredAt.getTime() + 2),
      signal: new AbortController().signal,
    });
    const [canonicallyBoundState] = await db.select({
      binding: roomJournalState.compactionAcceptedModelBinding,
    }).from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId));
    expect(canonicallyBoundState?.binding).toMatchObject({
      version: 1,
      kind: "service",
      role: "memorySummarization",
      modelId: RECOVERY_MODEL,
    });
    expect(canonicallyBoundState?.binding?.inputCommitment)
      .toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
    expect(await prepared.publish({ revalidationToken: 1 }))
      .toMatchObject({ status: "failed", processed: true });
    expect(calls).toBe(1);
    const [authorization] = await db.select().from(roomJournalModelRecoveries)
      .where(and(
        eq(roomJournalModelRecoveries.roomId, f.roomId),
        eq(roomJournalModelRecoveries.workKind, "compaction"),
      ));
    expect(authorization?.spentAt).not.toBeNull();
    const [invalidState] = await db.select({
      lastErrorAt: roomJournalState.lastCompactionErrorAt,
      lastErrorCode: roomJournalState.lastCompactionErrorCode,
    }).from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId));
    const invalidAt = invalidState?.lastErrorAt;
    if (invalidAt === null || invalidAt === undefined || authorization?.spentAt === null
      || authorization?.spentAt === undefined) {
      throw new Error("expected durable spent compaction recovery and invalid completion");
    }
    expect(invalidState?.lastErrorCode).toBe("invalid_output");
    expect(invalidAt.getTime()).toBeGreaterThanOrEqual(
      authorization.spentAt.getTime(),
    );
    expect(invalidAt.getTime()).toBeGreaterThan(recoveredAt.getTime() + 2);
    const scheduledAt = new Date(invalidAt.getTime() + 60_000);
    expect((await compactionCandidateRooms(db, scheduledAt))
      .map((candidate) => candidate.roomId)).not.toContain(f.roomId);
    expect(await tryClaimCompactionRoom(db, f.roomId, scheduledAt)).toBeNull();

    const clickedAt = new Date(invalidAt.getTime() + 1_000);
    const clicked = await requestManualJournalRecovery({
      db,
      now: clickedAt,
      observedThrough: invalidAt,
      authorizedBy: f.userId,
      modelId: RECOVERY_MODEL,
    });
    expect(clicked.queued).toBeGreaterThanOrEqual(1);
    expect((await compactionCandidateRooms(db, scheduledAt))
      .map((candidate) => candidate.roomId)).toContain(f.roomId);
    const rearmed = await tryClaimCompactionRoom(db, f.roomId, scheduledAt);
    expect(rearmed?.manualModelRecoveryId).toBeString();
    expect(rearmed?.manualModelRecoveryId)
      .not.toBe(recovered?.manualModelRecoveryId);
  }, 30_000);

  test("parks changed compaction inputs until a fresh service-authorized click", async () => {
    const f = await fixture("drifted-legacy-compaction");
    const other = await fixture("compaction-fairness");
    const [sourceBatch] = await db.insert(roomJournalBatches).values({
      roomId: f.roomId,
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: f.messageId,
      extractorVersion: TEST_EXTRACTOR_VERSION,
      observationPublicationVersion: 2,
      status: "completed",
      attemptCount: 1,
      operationCount: 0,
      completedAt: BASE,
      createdAt: BASE,
    }).returning({ id: roomJournalBatches.id });
    await addNativeCompactionEvents(f, sourceBatch!.id, 1, 80);
    const failedAt = new Date(Date.now() - 20_000);
    const dueAt = new Date("2000-01-01T00:00:00.000Z");
    await db.update(roomJournalState).set({
      compactionDueAt: dueAt,
      compactionFailureCount: 1,
      lastCompactionErrorCode: "provider_outcome_unknown",
      lastCompactionErrorAt: failedAt,
      lastCompactionErrorAttempt: 1,
      lastCompactionErrorModelId: MODEL,
    }).where(eq(roomJournalState.roomId, f.roomId));
    const coordinates = await db.transaction(tx =>
      resolveCurrentOrdinaryCompactionCoordinates(tx, f.roomId));
    if (!coordinates) throw new Error("expected legacy compaction coordinates");
    await recordUnknownAttempt({
      roomId: f.roomId,
      callType: "room_event_compaction",
      operationId: coordinates.workId,
      modelId: MODEL,
      at: failedAt,
    });
    const authorizedAt = new Date(failedAt.getTime() + 1_000);
    expect(await requestManualJournalRecovery({
      db,
      now: authorizedAt,
      observedThrough: failedAt,
      authorizedBy: f.userId,
      modelId: RECOVERY_MODEL,
    })).toEqual({ queued: 1, held: 0 });

    await db.update(roomJournalState).set({
      compactionDueAt: new Date(dueAt.getTime() + 1),
    }).where(eq(roomJournalState.roomId, other.roomId));
    await addNativeCompactionEvents(f, sourceBatch!.id, 81, 1);
    const claimAt = new Date(authorizedAt.getTime() + 1_000);
    expect((await compactionCandidateRooms(db, claimAt, 1))
      .map(candidate => candidate.roomId)).toEqual([f.roomId]);
    expect(await tryClaimCompactionRoom(db, f.roomId, claimAt)).toBeNull();

    const [deferred] = await db.select({
      binding: roomJournalState.compactionAcceptedModelBinding,
      plan: roomJournalState.compactionAcceptedPlan,
      retryAfter: roomJournalState.compactionRetryAfter,
    }).from(roomJournalState).where(eq(roomJournalState.roomId, f.roomId));
    expect(deferred?.binding).toBeNull();
    expect(deferred?.plan).toBeNull();
    expect(deferred?.retryAfter).toBeNull();
    const [grant] = await db.select().from(roomJournalModelRecoveries).where(and(
      eq(roomJournalModelRecoveries.roomId, f.roomId),
      eq(roomJournalModelRecoveries.workKind, "compaction"),
    ));
    expect(grant?.spentAt).toBeNull();
    expect(grant?.sourceChangedAt).toEqual(claimAt);
    expect(grant?.replacementInputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await compactionCandidateRooms(db, new Date(claimAt.getTime() + 86_400_000), 1))
      .map(candidate => candidate.roomId)).toEqual([other.roomId]);
    const status = () => queryStenographerAdminStatus({
      now: claimAt, since: BASE, until: claimAt, includeRecovery: true, includeRecoverySources: true,
    }, db);
    expect((await status()).staleAuthorizedSourceRooms).toBe(1);
    const next = new Date(claimAt.getTime() + 1);
    const clicked = {
      db, now: next, observedThrough: next, authorizedBy: f.userId, modelId: "venice:new-target",
      admitsFreshServiceInputs: async (_tx: unknown, dependencies: readonly unknown[]) => dependencies.length > 0,
    };
    expect(await requestManualJournalRecovery({ ...clicked, observedThrough: failedAt })).toEqual({ queued: 0, held: 1 });
    expect(await requestManualJournalRecovery({ ...clicked, admitsFreshServiceInputs: async () => false }))
      .toEqual({ queued: 0, held: 1 });
    // A subsequent change cannot reuse an earlier observation of the replacement.
    await addNativeCompactionEvents(f, sourceBatch!.id, 82, 1);
    expect(await requestManualJournalRecovery(clicked)).toEqual({ queued: 0, held: 1 });
    expect(await requestManualJournalRecovery(clicked)).toEqual({ queued: 0, held: 1 });
    const freshAt = new Date(next.getTime() + 1);
    const fresh = { ...clicked, now: freshAt, observedThrough: freshAt };
    expect(await requestManualJournalRecovery(fresh)).toEqual({ queued: 1, held: 0 });
    expect(await requestManualJournalRecovery(fresh)).toEqual({ queued: 0, held: 0 });
    expect((await status()).staleAuthorizedSourceRooms).toBe(0);
    const lateCoordinates = await db.transaction(tx =>
      resolveCurrentOrdinaryCompactionCoordinates(tx, f.roomId));
    if (!lateCoordinates) throw new Error("expected freshly authorized compaction coordinates");
    const lateReceiptAt = new Date(freshAt.getTime() + 1);
    await recordUnknownAttempt({
      roomId: f.roomId,
      callType: "room_event_compaction",
      operationId: lateCoordinates.workId,
      modelId: fresh.modelId,
      at: lateReceiptAt,
    });
    expect(await tryClaimCompactionRoom(db, f.roomId, lateReceiptAt)).toBeNull();
    const [lateGrant] = await db.select().from(roomJournalModelRecoveries).where(and(
      eq(roomJournalModelRecoveries.roomId, f.roomId),
      eq(roomJournalModelRecoveries.workKind, "compaction"),
      eq(roomJournalModelRecoveries.freshServiceInputs, true),
    ));
    expect(lateGrant?.spentAt).toBeNull();
    expect(lateGrant?.sourceChangedAt).toEqual(lateReceiptAt);
    expect(lateGrant?.replacementInputDigest).toBe(lateGrant?.authorizedInputDigest);

    // A late wire consumes the observation, not a fresh authorization. New
    // inputs need their own stable observation and subsequent operator click.
    await addNativeCompactionEvents(f, sourceBatch!.id, 83, 1);
    const changedAgainAt = new Date(lateReceiptAt.getTime() + 1);
    const changedAgain = {
      ...fresh,
      now: changedAgainAt,
      observedThrough: changedAgainAt,
    };
    expect(await requestManualJournalRecovery(changedAgain))
      .toEqual({ queued: 0, held: 1 });
    const reauthorizedAt = new Date(changedAgainAt.getTime() + 1);
    const reauthorized = {
      ...fresh,
      now: reauthorizedAt,
      observedThrough: reauthorizedAt,
    };
    expect(await requestManualJournalRecovery(reauthorized))
      .toEqual({ queued: 1, held: 0 });
    const beforeRevision = await db.transaction(tx => resolveCurrentOrdinaryCompactionCoordinates(tx, f.roomId));
    if (!beforeRevision) throw new Error("expected eligible inputs");
    await db.transaction(async tx => {
      const recordId = f.recordIds[0]!;
      await tx.insert(reflectionRecordPayloadRepresentations).values({
        recordId, representation: "ordinary", representationGeneration: 2, payloadVersion: 1,
        plaintextPayloadBytes: new TextEncoder().encode(JSON.stringify({
          statement: `Synthetic compaction fact 1. ${"x".repeat(520)}`,
        })),
      });
      await tx.update(reflectionRecordPayloadRepresentationHeads).set({ currentRepresentationGeneration: 2 })
        .where(and(eq(reflectionRecordPayloadRepresentationHeads.recordId, recordId),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary")));
    });
    const afterRevision = await db.transaction(tx => resolveCurrentOrdinaryCompactionCoordinates(tx, f.roomId));
    expect(afterRevision?.workId).toBe(beforeRevision.workId);
    expect(afterRevision?.inputDigest).not.toBe(beforeRevision.inputDigest);
    const revisionAt = new Date(reauthorizedAt.getTime() + 1);
    expect(await tryClaimCompactionRoom(db, f.roomId, revisionAt)).toBeNull();
    expect(await requestManualJournalRecovery(reauthorized)).toEqual({ queued: 0, held: 1 });
    const revisedAt = new Date(revisionAt.getTime() + 1);
    expect(await requestManualJournalRecovery({ ...fresh, now: revisedAt, observedThrough: revisedAt }))
      .toEqual({ queued: 1, held: 0 });
    const payerDeniedClaim = await tryClaimCompactionRoom(db, f.roomId, revisedAt);
    if (!payerDeniedClaim) throw new Error("expected reauthorized compaction claim");
    const payerDeniedAt = new Date(revisedAt.getTime() + 1);
    await failCompaction({
      claim: payerDeniedClaim,
      errorCode: "input_authority_unavailable",
      modelId: reauthorized.modelId,
      db,
      now: payerDeniedAt,
    });
    const [payerDeniedGrant] = await db.select().from(roomJournalModelRecoveries)
      .where(eq(roomJournalModelRecoveries.id, payerDeniedClaim.manualModelRecoveryId!));
    expect(payerDeniedGrant?.spentAt).toBeNull();
    expect(payerDeniedGrant?.sourceChangedAt).toEqual(payerDeniedAt);
    expect((await compactionCandidateRooms(db, payerDeniedAt))
      .map(candidate => candidate.roomId)).not.toContain(f.roomId);

    const payerReauthorizedAt = new Date(payerDeniedAt.getTime() + 1);
    const payerReauthorized = {
      ...fresh,
      now: payerReauthorizedAt,
      observedThrough: payerReauthorizedAt,
    };
    expect(await requestManualJournalRecovery(payerReauthorized))
      .toEqual({ queued: 1, held: 0 });
    const claim = await tryClaimCompactionRoom(db, f.roomId, payerReauthorizedAt);
    if (!claim) throw new Error("expected newly authorized inputs");
    expect(claim.requiresCurrentServicePayer).toBe(true);
    expect(claim.manualRecoveryModelId).toBe(payerReauthorized.modelId);
    expect(claim.modelOperationId).not.toBe(coordinates.workId);
    let calls = 0;
    const admitted = await funding(() => async () => { calls++; return "result"; }, f.userId)
      .admitCompactionModel(claim, compactionModelExposureDependencies(claim));
    await admitted.invoke("compaction fixture");
    expect(calls).toBe(1);
    const [spent] = await db.select().from(roomJournalModelRecoveries)
      .where(eq(roomJournalModelRecoveries.id, claim.manualModelRecoveryId!));
    expect(spent?.spentAt).not.toBeNull();
    expect(spent?.targetModelId).toBe(payerReauthorized.modelId);
    expect(spent?.authorizedInputDigest).toBeString();
    const [retired] = await db.select().from(roomJournalModelRecoveries)
      .where(eq(roomJournalModelRecoveries.id, grant!.id));
    expect(retired?.spentAt).toBeNull();
  }, 30_000);

  test("requires exact service receipts for legacy work and revalidates extraction access after a null-binding crash", async () => {
    type Receipt = Readonly<{
      modelId: string;
      fundingKind: "personal" | "server" | "service" | null;
      occurredAfterFailure?: boolean;
    }>;
    const prepare = async (label: string, receipts: readonly Receipt[]) => {
      const f = await fixture(`legacy-receipt-${label}`);
      const claimedAt = new Date(Date.now() - 20_000);
      const claim = await tryClaimRoom(db, f.roomId, claimedAt);
      if (!claim) throw new Error("expected legacy extraction claim");
      const failedAt = new Date(claimedAt.getTime() + 1_000);
      for (const receipt of receipts) {
        await recordUnknownAttempt({
          roomId: f.roomId,
          callType: "room_stenographer",
          operationId: claim.batchId,
          modelId: receipt.modelId,
          at: receipt.occurredAfterFailure
            ? new Date(failedAt.getTime() + 1)
            : failedAt,
          fundingKind: receipt.fundingKind,
          payerHumanId: f.userId,
        });
      }
      await failExtraction({
        claim,
        errorCode: "provider_outcome_unknown",
        modelId: MODEL,
        db,
        now: failedAt,
      });
      return { f, claim, failedAt };
    };

    const exact = await prepare("exact", [
      { modelId: MODEL, fundingKind: "service" },
    ]);
    const personal = await prepare("personal", [
      { modelId: MODEL, fundingKind: "personal" },
    ]);
    const mixed = await prepare("mixed", [
      { modelId: MODEL, fundingKind: "service" },
      { modelId: MODEL, fundingKind: "personal" },
    ]);
    const absent = await prepare("absent", []);
    const unknownFunding = await prepare("unknown-funding", [
      { modelId: MODEL, fundingKind: null },
    ]);
    const otherModel = await prepare("other-model", [
      { modelId: "fixture:other-service", fundingKind: "service" },
    ]);
    const lateOnly = await prepare("late-only", [{
      modelId: MODEL,
      fundingKind: "service",
      occurredAfterFailure: true,
    }]);
    const all = [
      exact,
      personal,
      mixed,
      absent,
      unknownFunding,
      otherModel,
      lateOnly,
    ];
    const prepareCompactionReceiptFailure = async (
      label: string,
      receipts: readonly Receipt[],
    ) => {
      const f = await fixture(`legacy-compaction-receipt-${label}`);
      const failedAt = new Date(Date.now() - 10_000);
      const workId = `legacy-compaction:${f.roomId}:${label}`;
      for (const receipt of receipts) {
        await recordUnknownAttempt({
          roomId: f.roomId,
          callType: "room_event_compaction",
          operationId: workId,
          modelId: receipt.modelId,
          at: receipt.occurredAfterFailure
            ? new Date(failedAt.getTime() + 1)
            : failedAt,
          fundingKind: receipt.fundingKind,
          payerHumanId: f.userId,
        });
      }
      await db.update(roomJournalState).set({
        compactionDueAt: failedAt,
        compactionFailureCount: 1,
        lastCompactionErrorCode: "provider_outcome_unknown",
        lastCompactionErrorAt: failedAt,
        lastCompactionErrorAttempt: 1,
        lastCompactionErrorModelId: MODEL,
      }).where(eq(roomJournalState.roomId, f.roomId));
      return { f, failedAt };
    };
    const rejectedCompactions = [
      await prepareCompactionReceiptFailure("personal", [
        { modelId: MODEL, fundingKind: "personal" },
      ]),
      await prepareCompactionReceiptFailure("mixed", [
        { modelId: MODEL, fundingKind: "service" },
        { modelId: MODEL, fundingKind: "personal" },
      ]),
      await prepareCompactionReceiptFailure("absent", []),
      await prepareCompactionReceiptFailure("unknown-funding", [
        { modelId: MODEL, fundingKind: null },
      ]),
      await prepareCompactionReceiptFailure("other-model", [
        { modelId: "fixture:other-service", fundingKind: "service" },
      ]),
      await prepareCompactionReceiptFailure("late-only", [{
        modelId: MODEL,
        fundingKind: "service",
        occurredAfterFailure: true,
      }]),
    ];
    const observedThrough = new Date(Math.max(
      ...all.map((item) => item.failedAt.getTime()),
      ...rejectedCompactions.map((item) => item.failedAt.getTime()),
    ));
    const authorizedAt = new Date(observedThrough.getTime() + 1_000);
    const receiptAssessment = { queued: 0, held: 0 };
    const cursors = new Set<string>();
    let after: string | null = null;
    do {
      const result = await requestManualJournalRecovery({
        db,
        now: authorizedAt,
        observedThrough,
        authorizedBy: exact.f.userId,
        modelId: RECOVERY_MODEL,
        page: { after, limit: 2 },
      });
      expect(result.queued + result.held).toBeLessThanOrEqual(2);
      receiptAssessment.queued += result.queued;
      receiptAssessment.held += result.held;
      after = result.nextCursor ?? null;
      if (after !== null) {
        expect(cursors.has(after)).toBe(false);
        cursors.add(after);
      }
    } while (after !== null);
    expect([...cursors].some((cursor) =>
      cursor.startsWith("extraction:")
    )).toBe(true);
    expect(cursors.has("compaction:")).toBe(true);
    expect([...cursors].some((cursor) =>
      cursor.startsWith("compaction:") && cursor !== "compaction:"
    )).toBe(true);
    expect(receiptAssessment.held).toBeGreaterThanOrEqual(12);

    const queued = await db.select({
      roomId: roomJournalModelRecoveries.roomId,
    }).from(roomJournalModelRecoveries).where(inArray(
      roomJournalModelRecoveries.roomId,
      all.map((item) => item.f.roomId),
    ));
    expect(queued.map((row) => row.roomId)).toEqual([exact.f.roomId]);
    const rejectedCompactionRecoveries = await db.select({
      roomId: roomJournalModelRecoveries.roomId,
    }).from(roomJournalModelRecoveries).where(inArray(
      roomJournalModelRecoveries.roomId,
      rejectedCompactions.map((item) => item.f.roomId),
    ));
    expect(rejectedCompactionRecoveries).toHaveLength(0);

    const firstClaimAt = new Date(authorizedAt.getTime() + 1_000);
    const first = await tryClaimRoom(
      db,
      exact.f.roomId,
      firstClaimAt,
      1,
    );
    if (!first?.manualModelRecoveryId) {
      throw new Error("expected exact legacy recovery claim");
    }
    const reclaimed = await tryClaimRoom(
      db,
      exact.f.roomId,
      new Date(firstClaimAt.getTime() + 1),
      120_000,
    );
    expect(reclaimed?.manualModelRecoveryId)
      .toBe(first.manualModelRecoveryId);
    expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
    const [stillLegacy] = await db.select({
      binding: roomJournalBatches.acceptedModelBinding,
    }).from(roomJournalBatches).where(eq(
      roomJournalBatches.id,
      exact.claim.batchId,
    ));
    expect(stillLegacy?.binding).toBeNull();

    await db.update(users).set({ disabledAt: new Date() })
      .where(eq(users.id, exact.f.userId));
    const rejection = await funding(
      () => async () => "must not dispatch",
      exact.f.userId,
    ).admitExtractionModel(
      reclaimed as ExtractionClaim,
      extractionModelExposureDependencies(reclaimed as ExtractionClaim),
    ).then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    const [unspent] = await db.select({
      spentAt: roomJournalModelRecoveries.spentAt,
    }).from(roomJournalModelRecoveries).where(eq(
      roomJournalModelRecoveries.id,
      first.manualModelRecoveryId,
    ));
    expect(unspent?.spentAt).toBeNull();
  }, 30_000);
});
