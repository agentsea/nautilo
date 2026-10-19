import { describe, expect, test } from "bun:test";
import type { TaskContentBackfillClaim } from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  readTaskContentBackfillSource,
} from "../../src/routes/task-content-backfill-source";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000002",
  device: "device:test",
  claim: "30000000-0000-4000-8000-000000000003",
  task: "40000000-0000-4000-8000-000000000004",
  run: "50000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  scope: "70000000-0000-4000-8000-000000000007",
  namespace: "80000000-0000-4000-8000-000000000008",
};
const createdAt = new Date("2026-10-10T08:00:00.000Z");
const updatedAt = new Date("2026-10-10T09:00:00.000Z");
const startedAt = new Date("2026-10-10T10:00:00.000Z");
const completedAt = new Date("2026-10-10T11:00:00.000Z");

function definitionClaim(
  overrides: Partial<Extract<TaskContentBackfillClaim["candidate"], {
    kind: "definition";
  }>> = {},
): TaskContentBackfillClaim {
  return {
    claimId: ids.claim,
    humanActorId: ids.actor,
    requesterUserId: ids.user,
    deviceId: ids.device,
    policyRevision: 7,
    expiresAt: new Date("2026-10-10T12:00:00.000Z"),
    candidate: {
      kind: "definition",
      taskId: ids.task,
      sourceCreatedAt: createdAt,
      sourceUpdatedAt: updatedAt,
      sourceRevision: 0,
      sourceStatus: "pending",
      ...overrides,
    },
  };
}

function resultClaim(
  overrides: Partial<Extract<TaskContentBackfillClaim["candidate"], {
    kind: "result";
  }>> = {},
): TaskContentBackfillClaim {
  return {
    ...definitionClaim(),
    candidate: {
      kind: "result",
      taskId: ids.task,
      taskRunId: ids.run,
      sourceUpdatedAt: updatedAt,
      sourceStartedAt: startedAt,
      sourceCompletedAt: completedAt,
      sourceRevision: 0,
      sourceStatus: "errored",
      ...overrides,
    },
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.task,
    ownerId: ids.user,
    requestorId: ids.user,
    agentId: ids.agent,
    prompt: "Inspect every changed package.",
    expectedOutput: "A verified report",
    lastError: null,
    metadata: {},
    preset: "task",
    scheduleKind: "one_shot",
    runAt: new Date("2026-10-10T10:30:00.000Z"),
    cron: null,
    timezone: "Europe/Athens",
    catchup: "run_once",
    callingRoomId: ids.namespace,
    targetChat: "last_in_namespace",
    targetChatHandle: "agent:release",
    targetRoomId: ids.namespace,
    targetUserIds: [ids.user],
    resultDelivery: "raw_and_wake",
    useScope: true,
    scopeId: ids.scope,
    toolsMode: "whitelist",
    toolsWhitelist: ["read_file", "search"],
    selectionProfile: "smartest",
    selectionSpec: null,
    requestedModelId: null,
    fundingMode: "legacy_server",
    timeLimitSeconds: 900,
    awaitResponse: false,
    localExecutionDelegation: null,
    parentTaskId: null,
    depth: 0,
    status: "pending",
    fireLockId: null,
    contentRepresentation: "ordinary",
    contentNamespaceId: null,
    contentRevision: 0,
    cryptoObjectId: null,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped",
    createdAt,
    updatedAt,
    ...overrides,
  };
}

function protectedTaskRow(overrides: Record<string, unknown> = {}) {
  return taskRow({
    status: "errored",
    contentRepresentation: "dual",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
    cryptoMappingState: "verified",
    ...overrides,
  });
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.run,
    taskId: ids.task,
    status: "errored",
    resultText: "",
    lastError: "Provider stopped after producing an empty result.",
    startedAt,
    completedAt,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  };
}

function transaction(rowSets: readonly (readonly unknown[])[]): Readonly<{
  tx: CanonicalTranscriptTx;
  projections: readonly string[][];
}> {
  const remaining = rowSets.map(rows => [...rows]);
  const projections: string[][] = [];
  const tx = {
    select(projection: Record<string, unknown>) {
      projections.push(Object.keys(projection));
      const rows = remaining.shift() ?? [];
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (
          resolve: (value: readonly unknown[]) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as CanonicalTranscriptTx;
  return { tx, projections };
}

describe("Task content backfill source", () => {
  test("preserves the complete supported definition source and operational fields", async () => {
    const f = transaction([[taskRow()], []]);
    const result = await readTaskContentBackfillSource(f.tx, definitionClaim());
    expect(result).not.toBeNull();
    if (result === null || result.source.kind !== "definition") {
      throw new Error("Expected definition source");
    }
    expect(result.agentId).toBe(ids.agent);
    expect(result.contentNamespaceId).toBeNull();
    expect(result.source).toMatchObject({
      requesterHumanId: ids.actor,
      prompt: "Inspect every changed package.",
      expectedOutput: "A verified report",
      activeRun: false,
      operationalFields: {
        scheduleKind: "one_shot",
        runAt: "2026-10-10T10:30:00.000Z",
        timezone: "Europe/Athens",
        targetChat: "last_in_namespace",
        tools: ["read_file", "search"],
        resultDelivery: "raw_and_wake",
        useScope: true,
        scopeId: ids.scope,
        parentTaskId: null,
        timeLimitSeconds: 900,
        selectionProfile: "smartest",
        selectionSpec: null,
        requestedModelId: null,
      },
      agentId: ids.agent,
      preset: "task",
      catchup: "run_once",
      callingRoomId: ids.namespace,
      targetChatHandle: "agent:release",
      targetRoomId: ids.namespace,
      targetUserIds: [ids.user],
      awaitResponse: false,
      fundingMode: "legacy_server",
      localExecutionDelegation: null,
    });
    expect(result.classification.status).toBe("supported");
    expect(f.projections[0]).toContain("prompt");
    expect(f.projections[0]).toContain("localExecutionDelegation");
  });

  test("binds every server-owned execution coordinate without changing the legacy digest", async () => {
    const base = await readTaskContentBackfillSource(
      transaction([[taskRow()], []]).tx,
      definitionClaim(),
    );
    expect(base?.classification.status).toBe("supported");
    if (base?.classification.status !== "supported") throw new Error("Expected supported source");
    const variants = [
      { agentId: "90000000-0000-4000-8000-000000000009" },
      { preset: "schedule" },
      { catchup: "skip" },
      { callingRoomId: null },
      { targetChatHandle: null },
      { targetRoomId: null },
      { targetUserIds: [] },
      { awaitResponse: true },
      { fundingMode: "caller" },
      { localExecutionDelegation: {
        version: 1,
        humanUserId: ids.user,
        agentId: ids.agent,
        sourceRoomId: ids.namespace,
        sourceConversationId: "conversation:release",
        rootTaskId: ids.task,
        target: { instanceId: "desktop", relayId: "relay:test",
          pairingGeneration: "pairing:1", serverOrigin: "https://nautilo.test",
          serverFingerprint: "server:test" },
        projectGrantId: "grant:test",
        ceiling: "basic",
        profile: null,
      } },
    ];
    for (const variant of variants) {
      const changed = await readTaskContentBackfillSource(
        transaction([[taskRow(variant)], []]).tx,
        definitionClaim(),
      );
      expect(changed?.classification.status).toBe("supported");
      if (changed?.classification.status !== "supported") throw new Error("Expected supported source");
      expect(changed.classification.sourceDigest).not.toEqual(base.classification.sourceDigest);
      expect(changed.classification.legacySourceDigest).toEqual(
        base.classification.legacySourceDigest,
      );
    }
  });

  test.each(["in_background", "schedule"])(
    "preserves a supported %s definition and result source",
    async preset => {
      const definition = await readTaskContentBackfillSource(
        transaction([[taskRow({ preset })], []]).tx,
        definitionClaim(),
      );
      expect(definition?.classification.status).toBe("supported");

      const result = await readTaskContentBackfillSource(
        transaction([[protectedTaskRow({ preset })], [runRow()]]).tx,
        resultClaim(),
      );
      expect(result?.classification.status).toBe("supported");
    },
  );

  test.each(["ask_peer", "ping", "repo_docs"])(
    "rejects unsupported %s definition and result routing",
    async preset => {
      expect(await readTaskContentBackfillSource(
        transaction([[taskRow({ preset })]]).tx,
        definitionClaim(),
      )).toBeNull();
      expect(await readTaskContentBackfillSource(
        transaction([[protectedTaskRow({ preset })]]).tx,
        resultClaim(),
      )).toBeNull();
    },
  );

  test("retains an ordinary Task error as authenticated V2 display content", async () => {
    const error = "Provider failed before historical repair.";
    const result = await readTaskContentBackfillSource(
      transaction([[taskRow({ lastError: error, status: "paused" })], []]).tx,
      definitionClaim({ sourceStatus: "paused" }),
    );
    expect(result?.classification).toMatchObject({
      status: "supported",
      kind: "definition",
      payload: {
        formatVersion: 2,
        prompt: "Inspect every changed package.",
        expectedOutput: "A verified report",
        protectedMetadata: {},
        retainedHistoricalError: error,
      },
    });
    if (result?.classification.status !== "supported") {
      throw new Error("Expected supported historical definition");
    }
    expect(result.classification.sourceDigest).toHaveLength(32);
    expect(result.classification.sourcePayloadHash).toHaveLength(32);
    expect(result.classification.operationalFieldsDigest).toHaveLength(32);
  });

  test("returns waiting_parent for a fire lock or any active Run", async () => {
    for (const rows of [
      [[taskRow({ fireLockId: ids.claim })], []],
      [[taskRow()], [{ id: ids.run }]],
    ] as const) {
      const result = await readTaskContentBackfillSource(
        transaction(rows).tx,
        definitionClaim(),
      );
      expect(result?.classification).toEqual({
        status: "waiting_parent",
        reason: "active_definition",
      });
    }
  });

  test("rejects stale source coordinates, foreign ownership, and nested roots", async () => {
    for (const row of [
      taskRow({ updatedAt: new Date(updatedAt.getTime() + 1) }),
      taskRow({ ownerId: "90000000-0000-4000-8000-000000000009" }),
      taskRow({ requestorId: "90000000-0000-4000-8000-000000000009" }),
      taskRow({
        parentTaskId: "90000000-0000-4000-8000-000000000009",
        depth: 1,
      }),
    ]) {
      expect(await readTaskContentBackfillSource(
        transaction([[row]]).tx,
        definitionClaim(),
      )).toBeNull();
    }
  });

  test("preserves an errored result, including empty result text and exact error", async () => {
    const f = transaction([[protectedTaskRow()], [runRow()]]);
    const result = await readTaskContentBackfillSource(
      f.tx,
      resultClaim(),
    );
    expect(result).not.toBeNull();
    if (result === null || result.source.kind !== "run_result") {
      throw new Error("Expected result source");
    }
    expect(result.contentNamespaceId).toBe(ids.namespace);
    expect(result.source).toMatchObject({
      taskRunId: ids.run,
      runStatus: "errored",
      resultText: "",
      lastError: "Provider stopped after producing an empty result.",
    });
    expect(result.classification.status).toBe("supported");
    if (result.classification.status === "supported") {
      expect(result.classification.payload).toEqual({
        formatVersion: 1,
        resultText: "",
        lastError: "Provider stopped after producing an empty result.",
      });
    }
    expect(f.projections[0]).not.toContain("prompt");
    expect(f.projections[0]).not.toContain("expectedOutput");
    expect(f.projections[0]).not.toContain("lastError");
  });

  test("classifies an exact null result as no_content", async () => {
    const result = await readTaskContentBackfillSource(
      transaction([[protectedTaskRow()], [runRow({
        status: "cancelled",
        resultText: null,
        lastError: null,
      })]]).tx,
      resultClaim({ sourceStatus: "cancelled" }),
    );
    expect(result?.classification).toEqual({ status: "no_content" });
  });

  test("rejects unverified parents and exact Run coordinate drift", async () => {
    expect(await readTaskContentBackfillSource(
      transaction([[protectedTaskRow({ cryptoMappingState: "stale" })]]).tx,
      resultClaim(),
    )).toBeNull();
    expect(await readTaskContentBackfillSource(
      transaction([[protectedTaskRow()], [runRow({
        completedAt: new Date(completedAt.getTime() + 1),
      })]]).tx,
      resultClaim(),
    )).toBeNull();
    expect(await readTaskContentBackfillSource(
      transaction([[protectedTaskRow()], [runRow({
        resultRepresentation: "dual",
      })]]).tx,
      resultClaim(),
    )).toBeNull();
  });

  test("does not silently discard an inconsistent persisted tool projection", async () => {
    const result = await readTaskContentBackfillSource(
      transaction([[taskRow({
        toolsMode: "auto",
        toolsWhitelist: ["stale_tool"],
      })], []]).tx,
      definitionClaim(),
    );
    expect(result?.classification).toEqual({
      status: "unsupported",
      reason: "operational_fields",
    });
  });
});
