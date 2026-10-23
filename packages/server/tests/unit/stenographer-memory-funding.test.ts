import { describe, expect, spyOn, test } from "bun:test";
import { MemoryProviderOutcomeUnknownError, type CapabilityFundingSession } from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";
import type { DurableModelExposureDependency, DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { compactionModelExposureDependencies, createRoomSideModelInvoker, type CompactionClaim } from "@nautilo/runtime";
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

const protectedEvidence = {
  readRecord: () => Promise.resolve(null),
  readSource: () => Promise.resolve(null),
  readAudience: () => Promise.resolve(null),
};

describe("ordinary Stenographer Memory funding", () => {
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
