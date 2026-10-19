import { describe, expect, test } from "bun:test";

import {
  classifyTaskHistoricalContentSourceV1,
  type TaskHistoricalDefinitionSourceV1,
  type TaskHistoricalRunResultSourceV1,
} from "../../src/task/task-historical-content-source.ts";

const ids = {
  human: "10000000-0000-4000-8000-000000000001",
  task: "20000000-0000-4000-8000-000000000002",
  run: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  room: "50000000-0000-4000-8000-000000000005",
  targetRoom: "60000000-0000-4000-8000-000000000006",
  targetUser: "70000000-0000-4000-8000-000000000007",
};
const createdAt = new Date("2026-10-10T08:00:00.000Z");
const updatedAt = new Date("2026-10-10T09:00:00.000Z");
const startedAt = new Date("2026-10-10T10:00:00.000Z");
const completedAt = new Date("2026-10-10T11:00:00.000Z");

function operationalFields() {
  return {
    scheduleKind: "one_shot" as const,
    runAt: "2026-10-10T10:00:00.000Z",
    timezone: "UTC",
    targetChat: "orphan" as const,
    resultDelivery: "raw" as const,
    useScope: false,
    parentTaskId: null,
  };
}

function definition(
  overrides: Partial<TaskHistoricalDefinitionSourceV1> = {},
): TaskHistoricalDefinitionSourceV1 {
  return {
    kind: "definition",
    taskId: ids.task,
    requesterHumanId: ids.human,
    sourceRevision: 0,
    taskCreatedAt: createdAt,
    taskUpdatedAt: updatedAt,
    taskStatus: "pending",
    activeRun: false,
    parentTaskId: null,
    taskLastError: null,
    prompt: "Summarize the release evidence.",
    expectedOutput: "A short report",
    metadata: {},
    operationalFields: operationalFields(),
    agentId: ids.agent,
    preset: "task",
    catchup: "run_once",
    callingRoomId: ids.room,
    targetChatHandle: null,
    targetRoomId: ids.targetRoom,
    targetUserIds: [ids.targetUser],
    awaitResponse: false,
    fundingMode: "legacy_server",
    localExecutionDelegation: null,
    ...overrides,
  };
}

function result(
  overrides: Partial<TaskHistoricalRunResultSourceV1> = {},
): TaskHistoricalRunResultSourceV1 {
  return {
    kind: "run_result",
    taskId: ids.task,
    taskRunId: ids.run,
    requesterHumanId: ids.human,
    sourceRevision: 0,
    taskCreatedAt: createdAt,
    taskUpdatedAt: updatedAt,
    taskStatus: "completed",
    runStartedAt: startedAt,
    runCompletedAt: completedAt,
    runStatus: "completed",
    resultText: "Release evidence is ready.",
    lastError: null,
    metadata: {},
    operationalFields: operationalFields(),
    agentId: ids.agent,
    preset: "task",
    catchup: "run_once",
    callingRoomId: ids.room,
    targetChatHandle: null,
    targetRoomId: ids.targetRoom,
    targetUserIds: [ids.targetUser],
    awaitResponse: false,
    fundingMode: "legacy_server",
    localExecutionDelegation: null,
    ...overrides,
  };
}

function supported(input: TaskHistoricalDefinitionSourceV1 | TaskHistoricalRunResultSourceV1) {
  const classified = classifyTaskHistoricalContentSourceV1(input);
  expect(classified.status).toBe("supported");
  if (classified.status !== "supported") throw new Error("Expected supported source");
  return classified;
}

describe("historical Task content source", () => {
  test("returns canonical definition payload and binds every source lifecycle fact", () => {
    const base = supported(definition());
    expect(base.kind).toBe("definition");
    if (base.kind !== "definition") throw new Error("Expected definition");
    expect(base.payload).toEqual({
      formatVersion: 1,
      prompt: "Summarize the release evidence.",
      expectedOutput: "A short report",
      protectedMetadata: {},
    });
    expect(base.sourcePayloadHash).toHaveLength(32);
    expect(base.operationalFieldsDigest).toHaveLength(32);
    expect(base.sourceDigest).toHaveLength(32);
    expect(base.legacySourceDigest).toHaveLength(32);

    const promptEdit = supported(definition({ prompt: "Summarize different evidence." }));
    const statusEdit = supported(definition({ taskStatus: "paused" }));
    const timeEdit = supported(definition({
      taskUpdatedAt: new Date(updatedAt.getTime() + 1),
    }));
    expect(promptEdit.sourcePayloadHash).not.toEqual(base.sourcePayloadHash);
    expect(promptEdit.sourceDigest).not.toEqual(base.sourceDigest);
    expect(statusEdit.sourcePayloadHash).toEqual(base.sourcePayloadHash);
    expect(statusEdit.sourceDigest).not.toEqual(base.sourceDigest);
    expect(timeEdit.sourcePayloadHash).toEqual(base.sourcePayloadHash);
    expect(timeEdit.sourceDigest).not.toEqual(base.sourceDigest);
  });

  test("binds server-owned execution coordinates only in the current digest", () => {
    const base = supported(definition());
    const delegation = {
      version: 1 as const,
      humanUserId: ids.human,
      agentId: ids.agent,
      sourceRoomId: ids.room,
      sourceConversationId: "conversation:source",
      rootTaskId: ids.task,
      target: {
        instanceId: "desktop-instance",
        relayId: "relay:test",
        pairingGeneration: "pairing:1",
        serverOrigin: "https://nautilo.test",
        serverFingerprint: "server:test",
      },
      projectGrantId: "grant:test",
      ceiling: "development" as const,
      profile: { id: "profile:test", revision: 2 },
    };
    const changes: Partial<TaskHistoricalDefinitionSourceV1>[] = [
      { agentId: "80000000-0000-4000-8000-000000000008" },
      { preset: "schedule" },
      { catchup: "skip" },
      { callingRoomId: null },
      { targetChatHandle: "agent:test" },
      { targetRoomId: null },
      { targetUserIds: [] },
      { awaitResponse: true },
      { fundingMode: "caller" },
      { localExecutionDelegation: delegation },
    ];
    for (const change of changes) {
      const changed = supported(definition(change));
      expect(changed.sourceDigest).not.toEqual(base.sourceDigest);
      expect(changed.legacySourceDigest).toEqual(base.legacySourceDigest);
      expect(changed.operationalFieldsDigest).toEqual(base.operationalFieldsDigest);
      expect(changed.sourcePayloadHash).toEqual(base.sourcePayloadHash);
    }
  });

  test("rejects malformed local-source coordinates", () => {
    expect(classifyTaskHistoricalContentSourceV1(definition({
      localExecutionDelegation: { version: 1 },
    } as unknown as Partial<TaskHistoricalDefinitionSourceV1>))).toEqual({
      status: "unsupported", reason: "operational_fields",
    });
  });

  test("accounts for active, nested, malformed, and unencodable definitions", () => {
    for (const source of [
      definition({ taskStatus: "running" }),
      definition({ taskStatus: "awaiting" }),
      definition({ taskStatus: "pending", activeRun: true }),
      definition({ taskStatus: "paused", activeRun: true }),
    ]) expect(classifyTaskHistoricalContentSourceV1(source)).toEqual({
      status: "waiting_parent", reason: "active_definition",
    });
    expect(classifyTaskHistoricalContentSourceV1(definition({
      parentTaskId: "40000000-0000-4000-8000-000000000004",
    }))).toEqual({ status: "unsupported", reason: "nested_task" });
    const errored = supported(definition({ taskLastError: "provider unavailable" }));
    expect(errored.kind).toBe("definition");
    if (errored.kind !== "definition") throw new Error("Expected definition");
    expect(errored.payload).toEqual({
      formatVersion: 2,
      prompt: "Summarize the release evidence.",
      expectedOutput: "A short report",
      protectedMetadata: {},
      retainedHistoricalError: "provider unavailable",
    });
    const changedError = supported(definition({ taskLastError: "different failure" }));
    expect(changedError.sourcePayloadHash).not.toEqual(errored.sourcePayloadHash);
    expect(changedError.sourceDigest).not.toEqual(errored.sourceDigest);
    expect(supported(definition({ taskLastError: "" })).payload).toMatchObject({
      formatVersion: 2, retainedHistoricalError: "",
    });
    expect(classifyTaskHistoricalContentSourceV1(definition({
      taskUpdatedAt: new Date("invalid"),
    }))).toEqual({ status: "unsupported", reason: "invalid_source" });
    expect(classifyTaskHistoricalContentSourceV1(definition({
      metadata: { futureField: true },
    }))).toEqual({ status: "unsupported", reason: "metadata" });
    expect(classifyTaskHistoricalContentSourceV1(definition({
      taskLastError: "authenticated error",
      metadata: { retainedHistoricalError: "metadata substitution" },
    }))).toEqual({ status: "unsupported", reason: "metadata" });
    expect(classifyTaskHistoricalContentSourceV1(definition({
      metadata: { target: "x".repeat(2_000_000), mode: "update", publish: "branch" },
    }))).toEqual({ status: "unsupported", reason: "payload" });
    expect(classifyTaskHistoricalContentSourceV1(definition({
      operationalFields: { ...operationalFields(), unknown: true },
    } as unknown as Partial<TaskHistoricalDefinitionSourceV1>))).toEqual({
      status: "unsupported", reason: "operational_fields",
    });
  });

  test("supports terminal completed, errored, and cancelled run results without truncation", () => {
    for (const runStatus of ["completed", "errored", "cancelled"] as const) {
      const classified = supported(result({ runStatus }));
      expect(classified.kind).toBe("run_result");
      if (classified.kind !== "run_result") throw new Error("Expected run result");
      expect(classified.payload).toEqual({
        formatVersion: 1,
        resultText: "Release evidence is ready.",
        lastError: null,
      });
    }
    expect(classifyTaskHistoricalContentSourceV1(result({
      runCompletedAt: new Date(startedAt.getTime() - 1),
    }))).toEqual({ status: "unsupported", reason: "invalid_source" });
  });

  test("distinguishes absent result content from exact empty-string content", () => {
    expect(classifyTaskHistoricalContentSourceV1(result({
      resultText: null, lastError: null,
    }))).toEqual({ status: "no_content" });
    const empty = supported(result({ resultText: "", lastError: null }));
    expect(empty.kind).toBe("run_result");
    if (empty.kind !== "run_result") throw new Error("Expected run result");
    expect(empty.payload.resultText).toBe("");
  });

  test("canonical metadata commitment is independent of input key order", () => {
    const first = supported(definition({
      metadata: {
        target: "/work/repository",
        mode: "update",
        publish: "branch",
        instructions: "Preserve existing behavior.",
      },
    }));
    const reordered = supported(definition({
      metadata: {
        instructions: "Preserve existing behavior.",
        publish: "branch",
        mode: "update",
        target: "/work/repository",
      },
    }));
    expect(reordered.operationalMetadata).toEqual(first.operationalMetadata);
    expect(reordered.payload).toEqual(first.payload);
    expect(reordered.sourcePayloadHash).toEqual(first.sourcePayloadHash);
    expect(reordered.sourceDigest).toEqual(first.sourceDigest);
  });
});
