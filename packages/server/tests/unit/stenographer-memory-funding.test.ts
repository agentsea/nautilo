import { describe, expect, spyOn, test } from "bun:test";
import { MemoryProviderOutcomeUnknownError, type CapabilityFundingSession } from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";
import type { DurableModelExposureDependency, DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { compactionModelExposureDependencies, createRoomSideModelInvoker, extractionModelExposureDependencies,
  type CompactionClaim, type ExtractionClaim } from "@nautilo/runtime";
import type { MemoryOperationBinding } from "@nautilo/types";

import * as capabilityFunding from "../../src/lib/capability-funding";
import { createStenographerMemoryFunding } from "../../src/lib/stenographer-memory-funding";
import { runWithProtectedMemoryEvidence } from "../../src/lib/protected-memory-model-evidence";

const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const BATCH = "30000000-0000-4000-8000-000000000001";
const LEASE = "40000000-0000-4000-8000-000000000001";
const HUMAN = "50000000-0000-4000-8000-000000000001";

function database(replayRows: readonly Record<string, unknown>[]) {
  const results: unknown[][] = [
    [{ roomId: ROOM }],
    [{ roomId: ROOM, accepted: null, acceptedPlan: null }],
    [{ accepted: null }],
    [{ roomId: ROOM }],
    [...replayRows],
  ];
  const updates: Record<string, unknown>[] = [];
  const select = () => {
    const rows = results.shift() ?? [];
    const query = {
      from() { return this; },
      innerJoin() { return this; },
      where() { return this; },
      for() { return this; },
      limit: () => Promise.resolve(rows),
    };
    return query;
  };
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push(values);
        return [];
      },
    }),
  });
  const db = {
    select,
    update,
    transaction: async <T>(run: (tx: { select: typeof select; update: typeof update }) => Promise<T>) =>
      run({ select, update }),
  } as unknown as DirectDatabase;
  return { db, updates, remaining: () => results.length };
}

function funding(db: DirectDatabase, createInvoker?: typeof createRoomSideModelInvoker) {
  return createStenographerMemoryFunding({
    db,
    ports: {
      readRecord: () => Promise.resolve(null),
      readSource: () => Promise.resolve(null),
      readAudience: () => Promise.resolve(null),
    },
    budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    commitmentKey: new Uint8Array(32).fill(7),
    resolveServiceModel: () => "service:model",
    assertAvailable: () => Promise.resolve(),
    ...(createInvoker === undefined ? {} : { createInvoker }),
  });
}

function ordinaryCompactionDatabase() {
  let accepted: MemoryOperationBinding | null = null;
  let acceptedPlan: CompactionClaim["acceptedPlan"] | null = null;
  const updates: Record<string, unknown>[] = [];
  const select = () => {
    const query = {
      from() { return this; },
      where() { return this; },
      for() { return this; },
      limit: () => Promise.resolve([{ roomId: ROOM, accepted, acceptedPlan }]),
    };
    return query;
  };
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push(values);
        if ("compactionAcceptedModelBinding" in values) {
          accepted = values["compactionAcceptedModelBinding"] as MemoryOperationBinding;
        }
        if ("compactionAcceptedPlan" in values) {
          acceptedPlan = values["compactionAcceptedPlan"] as CompactionClaim["acceptedPlan"];
        }
        return [];
      },
    }),
  });
  const transaction = async <T>(run: (tx: {
    select: typeof select;
    update: typeof update;
  }) => Promise<T>) => run({ select, update });
  return {
    db: { select, update, transaction } as unknown as DirectDatabase,
    accepted: () => accepted,
    acceptedPlan: () => acceptedPlan,
    updates,
  };
}

function ordinaryExtractionDatabase(
  disabledAt: Date | null = null,
  replayRows: readonly Record<string, unknown>[] = [],
) {
  let accepted: MemoryOperationBinding | null = null;
  let authorityReads = 0;
  const updates: Record<string, unknown>[] = [];
  const select = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const rows = keys.includes("acceptedPlan")
      ? [{ roomId: ROOM, accepted, acceptedPlan: null }]
      : keys.includes("attemptOutcome")
        ? [...replayRows]
      : keys.includes("disabledAt")
        ? (authorityReads += 1, [{ id: 41, disabledAt }])
        : keys.includes("accepted")
          ? [{ accepted }]
          : [{ roomId: ROOM }];
    const query = {
      from() { return this; },
      innerJoin() { return this; },
      where() { return this; },
      for() { return this; },
      limit: () => Promise.resolve(rows),
    };
    return query;
  };
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push(values);
        if ("acceptedModelBinding" in values) {
          accepted = values["acceptedModelBinding"] as MemoryOperationBinding;
        }
        return [];
      },
    }),
  });
  const transaction = async <T>(run: (tx: {
    select: typeof select;
    update: typeof update;
  }) => Promise<T>) => run({ select, update });
  return {
    db: { select, update, transaction } as unknown as DirectDatabase,
    accepted: () => accepted,
    authorityReads: () => authorityReads,
    updates,
  };
}

const humanSource: Extract<DurableModelExposureDependency, { kind: "source" }> = {
  kind: "source",
  sourceKind: "message",
  logicalSourceRef: "message:41",
  observedRevision: "3",
  observedContentFingerprint: "sha256:current-human-message",
  terminalAuthorityLeafHandle: NAMESPACE,
};

function journalRecord(recordRef: string): DurableRecordEnvelope {
  return {
    recordRef,
    lifecycle: "current",
    structuralHeight: 0,
    processingGeneration: 1,
    semantic: {
      posture: "derived",
      observedContentFingerprint: `sha256:${recordRef}`,
      statement: "Current journal fact.",
      sourceDependencies: [],
      anchors: [],
      childRecordRefs: [],
      producer: { producerRef: "stenographer", policyVersion: "ordinary-v1" },
      terminalAuthorityLeafHandles: [NAMESPACE],
      modelExposureDependencies: [humanSource],
    },
  };
}

function ordinaryCompactionClaim(): CompactionClaim {
  const dependency = (recordRef: string): DurableModelExposureDependency => ({
    kind: "record",
    recordRef,
    observedProcessingGeneration: 1,
    terminalAuthorityLeafHandles: [NAMESPACE],
  });
  const events = Array.from({ length: 80 }, (_, index) => {
    const prefix = `Journal fact ${index + 1}: `;
    return {
      id: `event:${index + 1}`,
      roomId: ROOM,
      sequence: index + 1,
      kind: "fact" as const,
      statement: `${prefix}${"x".repeat(500 - prefix.length)}`,
      status: "active" as const,
      modelExposureDependency: dependency(`record:event:${index + 1}`),
    };
  });
  const selected = events.slice(0, -50);
  const tail = events.slice(-50);
  const acceptedPlan = {
    version: 1 as const,
    owner: "ordinary" as const,
    operationId: "compaction:ordinary-personal",
    rebuildGeneration: 0,
    previousRollupId: null,
    selectedEventIds: selected.map((event) => event.id),
    protectedTailEventIds: tail.map((event) => event.id),
  };
  return {
    roomId: ROOM,
    ownerId: "room-owner-is-not-payer-evidence",
    leaseToken: LEASE,
    attemptCount: 1,
    modelOperationId: acceptedPlan.operationId,
    acceptedPlan,
    namespaceId: NAMESPACE,
    previousRollup: null,
    plan: {
      trigger: { due: true, byCount: false, byCodePoints: true, effectiveEventCount: 80, statementCodePoints: 40_000 },
      previousRollup: null,
      selectedEvents: selected,
      protectedTail: tail,
      throughEventSequence: selected.at(-1)!.sequence,
      prompt: "Compaction evidence.",
      inputCodePoints: 20,
      hasMoreEligiblePrefix: false,
      scheduleAnotherPassAfterPublish: false,
      modelExposure: {
        previousRollupThroughEventSequence: null,
        selectedEventSequences: selected.map((event) => event.sequence),
        protectedTailEventSequences: tail.map((event) => event.sequence),
      },
    },
  };
}

function ordinaryExtractionClaim(rebuildGeneration: number | null): ExtractionClaim {
  const createdAt = new Date("2026-11-26T12:00:00.000Z");
  const row = {
    id: 41,
    createdAt,
    role: "user" as const,
    text: "Remember the exact current observation.",
    displayLabel: "Human",
    editRevision: 3,
  };
  return {
    batchId: BATCH,
    roomId: ROOM,
    ownerId: HUMAN,
    leaseToken: LEASE,
    attemptCount: 1,
    lane: "live",
    namespaceId: NAMESPACE,
    rebuildGeneration,
    plan: {
      fromMessageIdExclusive: 40,
      throughMessageIdInclusive: 41,
      trigger: "count",
      sourceRows: [{ ...row, conversationalBoundary: true }],
      coveredMessageIds: [41],
      conversationalMessageCount: 1,
      newestEligibleSourceAt: createdAt,
    },
    sourceRows: [row],
    priorContextRows: [],
    latestRollup: null,
    visibleEvents: [{
      id: "record:event-current",
      roomId: ROOM,
      sequence: 1,
      kind: "fact",
      statement: "Current journal fact.",
      status: "active",
      modelExposureDependency: {
        kind: "record",
        recordRef: "record:event-current",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: [NAMESPACE],
      },
    }],
  };
}

const protectedEvidence = {
  readRecord: () => Promise.resolve(null),
  readSource: () => Promise.resolve(null),
  readAudience: () => Promise.resolve(null),
};

describe("ordinary Stenographer Memory funding", () => {
  test("uses exact retired Journal ancestry for ordinary live and rebuild extraction", async () => {
    const oldDependency: Extract<DurableModelExposureDependency, { kind: "record" }> = {
      kind: "record",
      recordRef: "record:event-old",
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: [NAMESPACE],
    };
    const currentRecord = {
      ...journalRecord("record:event-current"),
      semantic: {
        ...journalRecord("record:event-current").semantic,
        modelExposureDependencies: [oldDependency],
      },
    };
    const retiredRecord: DurableRecordEnvelope = {
      ...journalRecord(oldDependency.recordRef),
      lifecycle: "superseded",
      processingGeneration: 2,
    };
    const createRuntime = (state: ReturnType<typeof ordinaryExtractionDatabase>, rooms: string[],
      invocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]>, retiredAvailable = true) => createStenographerMemoryFunding({
        db: state.db,
        ports: {
          readRecord: async (dependency) => dependency.recordRef === currentRecord.recordRef ? currentRecord : null,
          readSource: async () => ({status: "current", kind: "human", authorHumanId: HUMAN,
            audienceHumanIds: [HUMAN], includesPublicBoundary: false}),
          readAudience: async () => ({humanIds: [HUMAN], includesPublicBoundary: false}),
        },
        budget: {maxVisitedRecords: 8, maxTraversalWork: 16},
        commitmentKey: new Uint8Array(32).fill(13),
        resolveServiceModel: () => "openai:service",
        assertAvailable: () => Promise.resolve(),
        readRetiredJournalPredecessor: async (dependency, roomId) => {
          rooms.push(roomId);
          return retiredAvailable && dependency.recordRef === retiredRecord.recordRef
            ? retiredRecord
            : null;
        },
        createInvoker: (options) => {
          invocations.push(options);
          return async () => { throw new Error("provider must not run during admission"); };
        },
      });

    const rebuildState = ordinaryExtractionDatabase();
    const rebuildRooms: string[] = [];
    const rebuildInvocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    const rebuildClaim = ordinaryExtractionClaim(7);
    const rebuildDependencies = extractionModelExposureDependencies(rebuildClaim);
    const admitted = await createRuntime(rebuildState, rebuildRooms, rebuildInvocations)
      .admitExtractionModel(rebuildClaim, rebuildDependencies);
    expect(admitted.modelId).toBe("openai:service");
    expect(rebuildState.accepted()).toMatchObject({
      version: 1,
      kind: "service",
      role: "memorySummarization",
      modelId: "openai:service",
    });
    expect(rebuildState.updates).toHaveLength(1);
    expect(rebuildInvocations).toHaveLength(1);
    expect(rebuildInvocations[0]).not.toHaveProperty("fundingSession");
    expect(rebuildRooms).toEqual([ROOM, ROOM]);
    await admitted.assertCurrent();
    expect(rebuildRooms).toEqual([ROOM, ROOM, ROOM]);

    const liveState = ordinaryExtractionDatabase();
    const liveRooms: string[] = [];
    const liveInvocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    const liveClaim = ordinaryExtractionClaim(null);
    const liveAdmitted = await createRuntime(liveState, liveRooms, liveInvocations)
      .admitExtractionModel(liveClaim, extractionModelExposureDependencies(liveClaim));
    expect(liveAdmitted.modelId).toBe("openai:service");
    expect(liveState.accepted()).toMatchObject({
      version: 1,
      kind: "service",
      role: "memorySummarization",
      modelId: "openai:service",
    });
    expect(liveState.updates).toHaveLength(1);
    expect(liveInvocations).toHaveLength(1);
    expect(liveInvocations[0]).not.toHaveProperty("fundingSession");
    expect(liveRooms).toEqual([ROOM, ROOM]);
    await liveAdmitted.assertCurrent();
    expect(liveRooms).toEqual([ROOM, ROOM, ROOM]);

    const revokedState = ordinaryExtractionDatabase();
    const revokedRooms: string[] = [];
    const revokedInvocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    const revoked = await createRuntime(
      revokedState,
      revokedRooms,
      revokedInvocations,
      false,
    ).admitExtractionModel(liveClaim, extractionModelExposureDependencies(liveClaim))
      .catch((error: unknown) => error);
    expect(revoked).toMatchObject({
      message: "Memory input evidence or current authority changed",
    });
    expect(revokedRooms).toEqual([ROOM]);
    expect(revokedState.accepted()).toBeNull();
    expect(revokedState.updates).toHaveLength(0);
    expect(revokedInvocations).toHaveLength(0);

    const disabledState = ordinaryExtractionDatabase(
      new Date("2026-11-26T12:01:00.000Z"),
    );
    const disabledRooms: string[] = [];
    const disabledInvocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    const disabled = await createRuntime(
      disabledState,
      disabledRooms,
      disabledInvocations,
    ).admitExtractionModel(liveClaim, extractionModelExposureDependencies(liveClaim))
      .catch((error: unknown) => error);
    expect(disabled).toMatchObject({
      message: "Stenographer input authority is unavailable",
    });
    expect(disabledRooms).toEqual([]);
    expect(disabledState.authorityReads()).toBe(1);
    expect(disabledState.accepted()).toBeNull();
    expect(disabledState.updates).toHaveLength(0);
    expect(disabledInvocations).toHaveLength(0);

    const uncertainState = ordinaryExtractionDatabase(
      new Date("2026-11-26T12:01:00.000Z"),
      [{
        id: "attempt-unknown",
        attemptOutcome: "succeeded",
        failureCode: null,
        metadata: { operationId: BATCH },
      }],
    );
    const uncertain = await createRuntime(uncertainState, [], [])
      .admitExtractionModel(liveClaim, extractionModelExposureDependencies(liveClaim))
      .catch((error: unknown) => error);
    expect(uncertain).toBeInstanceOf(MemoryProviderOutcomeUnknownError);
    expect(uncertainState.authorityReads()).toBe(0);
    expect(uncertainState.accepted()).toBeNull();
    expect(uncertainState.updates).toHaveLength(0);
  });

  test.each([
    "openai:gpt-6-luna",
    "venice:openai-gpt-56-luna",
    "openrouter:minimax/minimax-m3",
  ])("admits an exact known-nonusable extraction retry for %s", async (modelId) => {
    const state = ordinaryExtractionDatabase(null, [{
      id: "settled-provider-result",
      attemptOutcome: "succeeded",
      failureCode: null,
      metadata: { operationId: BATCH },
    }]);
    const claim: ExtractionClaim = {
      ...ordinaryExtractionClaim(null),
      previousModelResultKnownNonusable: true,
      visibleEvents: [],
    };
    const invocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    const runtime = createStenographerMemoryFunding({
      db: state.db,
      ports: {
        readRecord: async () => null,
        readSource: async () => ({
          status: "current",
          kind: "human",
          authorHumanId: HUMAN,
          audienceHumanIds: [HUMAN],
          includesPublicBoundary: true,
        }),
        readAudience: async () => null,
      },
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
      commitmentKey: new Uint8Array(32).fill(17),
      resolveServiceModel: () => modelId,
      assertAvailable: () => Promise.resolve(),
      createInvoker: (options) => {
        invocations.push(options);
        return async () => "unused";
      },
    });

    const admitted = await runtime.admitExtractionModel(
      claim,
      extractionModelExposureDependencies(claim),
    );

    expect(admitted.modelId).toBe(modelId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ modelId, operationId: BATCH });
    expect(state.authorityReads()).toBe(1);
  });

  test("keeps an uncertain wire outcome quarantined despite a known-nonusable claim", async () => {
    const state = ordinaryExtractionDatabase(null, [{
      id: "unsettled-provider-result",
      attemptOutcome: "unknown",
      failureCode: null,
      metadata: { operationId: BATCH },
    }]);
    const claim: ExtractionClaim = {
      ...ordinaryExtractionClaim(null),
      previousModelResultKnownNonusable: true,
    };

    const result = await createStenographerMemoryFunding({
      db: state.db,
      ports: protectedEvidence,
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
      commitmentKey: new Uint8Array(32).fill(19),
      resolveServiceModel: () => "openai:gpt-6-luna",
      assertAvailable: () => Promise.resolve(),
    }).admitExtractionModel(claim, extractionModelExposureDependencies(claim))
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(MemoryProviderOutcomeUnknownError);
    expect(state.authorityReads()).toBe(0);
    expect(state.accepted()).toBeNull();
  });

  test("freezes a personal compaction binding from exact current Human Record ancestry", async () => {
    const state = ordinaryCompactionDatabase();
    const claim = ordinaryCompactionClaim();
    const dependencies = compactionModelExposureDependencies(claim);
    expect(claim.plan.selectedEvents).toHaveLength(30);
    expect(claim.plan.protectedTail).toHaveLength(50);
    expect(dependencies).toHaveLength(80);
    expect(dependencies?.at(0)).toMatchObject({
      kind: "record",
      recordRef: "record:event:1",
    });
    expect(dependencies?.at(-1)).toMatchObject({
      kind: "record",
      recordRef: "record:event:80",
    });

    let audience = [HUMAN];
    let selections = 0;
    const openedPriors: unknown[] = [];
    const openedRoles: string[] = [];
    const readRecords: string[] = [];
    const personalFunding = {
      kind: "personal" as const,
      providerRoute: "openrouter",
      credentialId: "80000000-0000-4000-8000-000000000001",
      credentialRevision: 4,
    };
    const session = (
      humanUserId: string,
      recheck: () => Promise<void> = () => Promise.resolve(),
    ): CapabilityFundingSession => ({
      humanUserId,
      async resolveModel(role) {
        await recheck();
        openedRoles.push(role);
        selections += 1;
        return { modelId: "openrouter:openai/gpt-6-luna", preferenceRevision: 9 };
      },
      async openModel(modelId, workload, prior) {
        await recheck();
        expect(modelId).toBe("openrouter:openai/gpt-6-luna");
        expect(workload).toBe("memory");
        openedPriors.push(prior);
        return {
          binding: prior ?? personalFunding,
          fundingSession: {
            kind: "personal",
            workload: "memory",
            recheckAttempt: async () => recheck(),
            runAttempt: async () => {
              throw new Error("provider dispatch is outside this admission test");
            },
          },
        };
      },
      openService: () => { throw new Error("not a service provider"); },
    });
    const sessionSpy = spyOn(
      capabilityFunding,
      "createCapabilityFundingSession",
    ).mockImplementation(session);
    const invocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    try {
      const runtime = createStenographerMemoryFunding({
        db: state.db,
        ports: {
          readRecord: async (dependency) => {
            readRecords.push(dependency.recordRef);
            return journalRecord(dependency.recordRef);
          },
          readSource: async () => ({
            status: "current",
            kind: "human",
            authorHumanId: HUMAN,
            audienceHumanIds: audience,
            includesPublicBoundary: false,
          }),
          readAudience: async () => ({
            humanIds: audience,
            includesPublicBoundary: false,
          }),
        },
        budget: { maxVisitedRecords: 256, maxTraversalWork: 256 },
        commitmentKey: new Uint8Array(32).fill(11),
        resolveServiceModel: () => "openai:service",
        assertAvailable: () => Promise.resolve(),
        createInvoker: (options) => {
          invocations.push(options);
          return async () => "unused";
        },
      });

      const admitted = await runtime.admitCompactionModel(claim, dependencies);
      expect(admitted.modelId).toBe("openrouter:openai/gpt-6-luna");
      expect(state.accepted()).toMatchObject({
        version: 1,
        kind: "human",
        role: "memorySummarization",
        modelId: "openrouter:openai/gpt-6-luna",
        humanUserId: HUMAN,
        preferenceRevision: 9,
        funding: personalFunding,
      });
      expect(state.acceptedPlan()).toEqual(claim.acceptedPlan);
      expect(state.updates).toHaveLength(1);
      expect(openedRoles).toEqual(["memorySummarization"]);
      expect(openedPriors).toEqual([undefined, personalFunding]);
      expect(new Set(readRecords).size).toBe(80);
      expect(invocations[0]).toMatchObject({
        allowUnpinnedSurplusRetry: true,
        fundingSession: { allowUnpinnedSurplusRetry: true },
      });

      const reopened = await runtime.admitCompactionModel(claim, dependencies);
      expect(reopened.modelId).toBe(admitted.modelId);
      expect(selections).toBe(1);
      expect(state.updates).toHaveLength(1);
      expect(openedPriors).toEqual([undefined, personalFunding, personalFunding]);

      const changedPlan = {
        ...claim,
        acceptedPlan: {
          ...claim.acceptedPlan,
          protectedTailEventIds: ["90000000-0000-4000-8000-000000000001"],
        },
      };
      expect(await runtime.admitCompactionModel(
        changedPlan,
        compactionModelExposureDependencies(changedPlan),
      ).catch((error: unknown) => error)).toMatchObject({
        message: "Memory compaction acceptance changed",
      });

      audience = [HUMAN, "a0000000-0000-4000-8000-000000000001"];
      expect(await admitted.assertCurrent().catch((error: unknown) => error))
        .toMatchObject({ message: "Memory input evidence or current authority changed" });
    } finally {
      sessionSpy.mockRestore();
    }
  });
});

describe("protected Stenographer Memory funding", () => {
  test("admits a durable binding when the exact operation has no wire evidence", async () => {
    const state = database([]);
    const invocations: Array<Parameters<typeof createRoomSideModelInvoker>[0]> = [];
    const admitted = await runWithProtectedMemoryEvidence(
      protectedEvidence,
      () => funding(state.db, (options) => {
        invocations.push(options);
        return async () => "unused";
      }).admitProtectedExtractionModel({
        kind: "extraction",
        sourceBatchId: BATCH,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        leaseToken: LEASE,
      }, () => Promise.resolve(undefined)),
    );

    expect(admitted.modelId).toBe("service:model");
    expect(state.updates).toHaveLength(1);
    expect(state.remaining()).toBe(0);
    expect(invocations[0]).not.toHaveProperty("allowUnpinnedSurplusRetry");
  });

  test("quarantines an exact protected operation with prior wire evidence", async () => {
    const state = database([{
      id: "attempt-1",
      attemptOutcome: "succeeded",
      failureCode: null,
      metadata: { operationId: BATCH },
    }]);
    const result = await runWithProtectedMemoryEvidence(
      protectedEvidence,
      () => funding(state.db).admitProtectedExtractionModel({
        kind: "extraction",
        sourceBatchId: BATCH,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        leaseToken: LEASE,
      }, () => Promise.resolve(undefined)),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(MemoryProviderOutcomeUnknownError);
    expect(state.remaining()).toBe(0);
  });
});
