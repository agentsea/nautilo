import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  resolvePublishedProtectedTaskAwaitReply,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import type { Job } from "../../src/schema/jobs";
import type { TaskRun } from "../../src/schema/task-runs";
import type { Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  requestor: "40000000-0000-4000-8000-000000000004",
  sourceUser: "50000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  namespace: "70000000-0000-4000-8000-000000000007",
  room: "80000000-0000-4000-8000-000000000008",
  session: "90000000-0000-4000-8000-000000000009",
};
const operationId = "shared-human:operation:reply-1";
const messageId = 41;
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const inputObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const messageObjectId = "message:v2:published-reply";
const parkedAt = new Date("2026-09-28T12:34:56.000Z");
const publishedAt = new Date("2026-09-28T12:35:00.000Z");
const parkKey = "nautilo.protectedTaskRunPark.v1";

function reference(): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
  };
}

function parkReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    interrupts: [
      { id: "interrupt:approval", kind: "approval", requestId: "approval:1" },
      { id: "interrupt:reply", kind: "await_reply" },
    ],
    parkedAt: parkedAt.toISOString(),
    ...overrides,
  };
}

function publication(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    operationSessionId: ids.session,
    operationRoomId: ids.room,
    operationMessageId: messageId,
    operationNamespaceId: ids.namespace,
    operationCryptoObjectId: messageObjectId,
    terminalAt: publishedAt,
    roomId: ids.room,
    sessionId: ids.session,
    messageId,
    editRevision: 2,
    cryptoObjectId: messageObjectId,
    namespaceId: ids.namespace,
    sourceUserId: ids.sourceUser,
    role: "user",
    createdAt: new Date("2026-09-28T12:34:58.000Z"),
    lifecycleNamespaceId: ids.namespace,
    lifecycleRoomId: ids.room,
    lifecycleCryptoObjectId: messageObjectId,
    lifecycleOperationId: operationId,
    lifecycleKeyClass: "ai",
    lifecycleAuthorRole: "user",
    lifecyclePayloadVersion: 2,
    lifecycleCompletion: "complete",
    lifecycleDisposition: "mapped",
    ...overrides,
  };
}

function candidate(receipt = parkReceipt()) {
  const task = {
    id: ids.task,
    ownerId: ids.requestor,
    requestorId: ids.requestor,
    agentId: ids.agent,
    prompt: "",
    expectedOutput: null,
    scheduleKind: "one_shot",
    status: "awaiting",
    targetRoomId: ids.room,
    targetUserIds: [ids.sourceUser],
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: inputObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
    cryptoMappingState: "verified",
    metadata: {},
  } as Task;
  const run = {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "awaiting",
    modelId: "openai:gpt-6-sol",
    resultText: null,
    startedAt: new Date("2026-09-28T12:00:00.000Z"),
    completedAt: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
  } as TaskRun;
  const job = {
    id: ids.job,
    ownerId: ids.requestor,
    requestorId: ids.requestor,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "completed",
    input: reference(),
    result: null,
    message: null,
    createdAt: new Date("2026-09-28T12:00:01.000Z"),
    startedAt: new Date("2026-09-28T12:00:02.000Z"),
    completedAt: parkedAt,
    metadata: { [parkKey]: receipt },
  } as Job;
  return { task, run, job };
}

function database(responses: readonly (readonly unknown[])[]): DirectDatabase {
  const pending = [...responses];
  return {
    select() {
      const rows = pending.shift();
      if (rows === undefined) throw new Error("unexpected query");
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (
          resolve: (value: readonly unknown[]) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as DirectDatabase;
}

describe("resolvePublishedProtectedTaskAwaitReply", () => {
  test("returns a complete content-free acceptance input for one exact match", async () => {
    const result = await resolvePublishedProtectedTaskAwaitReply(
      database([[publication()], [candidate()]]),
      { operationId, messageId },
    );
    expect(result).toEqual({
      status: "resolved",
      input: {
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        priorJobId: ids.job,
        generation: 3,
        executionSegment: 1,
        interrupts: [
          { id: "interrupt:approval", kind: "approval", requestId: "approval:1" },
          { id: "interrupt:reply", kind: "await_reply" },
        ],
        parkedAt,
        priorJobReference: reference(),
        acceptance: {
          acceptanceId: operationId,
          interruptId: "interrupt:reply",
          message: {
            roomId: ids.room,
            sessionId: ids.session,
            messageId: String(messageId),
            editRevision: 2,
            cryptoObjectId: messageObjectId,
            namespaceId: ids.namespace,
            sourceUserId: ids.sourceUser,
          },
          acceptedAt: publishedAt,
        },
      },
    });
  });

  test("fails closed when two parked Tasks can consume the same reply", async () => {
    const result = await resolvePublishedProtectedTaskAwaitReply(
      database([[publication()], [candidate(), candidate()]]),
      { operationId, messageId },
    );
    expect(result).toEqual({ status: "ambiguous" });
  });

  test("fails closed on malformed or multiple await-reply interrupts", async () => {
    const malformed = candidate(parkReceipt({ generation: -1 }));
    expect(await resolvePublishedProtectedTaskAwaitReply(
      database([[publication()], [malformed]]),
      { operationId, messageId },
    )).toEqual({ status: "no_match" });

    const multiple = candidate(parkReceipt({ interrupts: [
      { id: "interrupt:a", kind: "await_reply" },
      { id: "interrupt:b", kind: "await_reply" },
    ] }));
    expect(await resolvePublishedProtectedTaskAwaitReply(
      database([[publication()], [multiple]]),
      { operationId, messageId },
    )).toEqual({ status: "no_match" });
  });

  test("derives replay-stable identity and time from durable publication", async () => {
    const first = await resolvePublishedProtectedTaskAwaitReply(
      database([[publication()], [candidate()]]),
      { operationId, messageId },
    );
    const replay = await resolvePublishedProtectedTaskAwaitReply(
      database([[publication()], [candidate()]]),
      { operationId, messageId },
    );
    expect(replay).toEqual(first);
    expect(replay.status === "resolved"
      ? replay.input.acceptance.acceptedAt
      : null).toEqual(publishedAt);
  });
});
