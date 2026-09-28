import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  acceptProtectedTaskAwaitReply,
  type AcceptProtectedTaskAwaitReplyInput,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { sessionMessages } from "../../src/schema/sessions";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  requestor: "40000000-0000-4000-8000-000000000004",
  recipient: "50000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  namespace: "70000000-0000-4000-8000-000000000007",
  room: "80000000-0000-4000-8000-000000000008",
  session: "90000000-0000-4000-8000-000000000009",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const messageObjectId = "message:v2:accepted-reply";
const parkedAt = new Date("2026-09-28T12:34:56.000Z");
const acceptedAt = new Date("2026-09-28T12:35:00.000Z");
const parkKey = "nautilo.protectedTaskRunPark.v1";
const acceptanceKey = "nautilo.protectedTaskAwaitReplyAcceptance.v1";

function reference(): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
  };
}

function interrupts() {
  return [
    { id: "interrupt:approval", kind: "approval" as const, requestId: "approval:1" },
    { id: "interrupt:reply", kind: "await_reply" as const },
  ];
}

function acceptance(overrides: Record<string, unknown> = {}) {
  return {
    acceptanceId: "await-reply-acceptance:1",
    interruptId: "interrupt:reply",
    message: {
      roomId: ids.room,
      sessionId: ids.session,
      messageId: "41",
      editRevision: 2,
      cryptoObjectId: messageObjectId,
      namespaceId: ids.namespace,
      sourceUserId: ids.recipient,
    },
    acceptedAt,
    ...overrides,
  } as AcceptProtectedTaskAwaitReplyInput["acceptance"];
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

function acceptanceReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    acceptanceId: "await-reply-acceptance:1",
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    nextExecutionSegment: 2,
    interrupt: { id: "interrupt:reply", kind: "await_reply" },
    message: acceptance().message,
    acceptedAt: acceptedAt.toISOString(),
    ...overrides,
  };
}

function input(
  overrides: Partial<AcceptProtectedTaskAwaitReplyInput> = {},
): AcceptProtectedTaskAwaitReplyInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    priorJobId: ids.job,
    generation: 3,
    executionSegment: 1,
    interrupts: interrupts(),
    parkedAt,
    priorJobReference: reference(),
    acceptance: acceptance(),
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.requestor,
    requestorId: ids.requestor,
    agentId: ids.agent,
    prompt: "",
    expectedOutput: null,
    scheduleKind: "one_shot",
    status: "awaiting",
    targetRoomId: ids.room,
    targetUserIds: [ids.recipient],
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
    cryptoMappingState: "verified",
    metadata: {},
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
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
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
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
    metadata: { [parkKey]: parkReceipt() },
    ...overrides,
  };
}

type MessageRow = Readonly<{
  roomId: string | null;
  sessionId: string;
  messageId: number;
  editRevision: number;
  cryptoObjectId: string | null;
  namespaceId: string;
  sourceUserId: string;
  role: string;
  createdAt: Date;
  lifecycleNamespaceId: string;
  lifecycleRoomId: string;
  lifecycleCryptoObjectId: string;
  lifecycleKeyClass: string;
  lifecycleAuthorRole: string;
  lifecyclePayloadVersion: number;
  lifecycleCompletion: string;
  lifecycleDisposition: string;
}>;

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    roomId: ids.room,
    sessionId: ids.session,
    messageId: 41,
    editRevision: 2,
    cryptoObjectId: messageObjectId,
    namespaceId: ids.namespace,
    sourceUserId: ids.recipient,
    role: "user",
    createdAt: new Date("2026-09-28T12:34:58.000Z"),
    lifecycleNamespaceId: ids.namespace,
    lifecycleRoomId: ids.room,
    lifecycleCryptoObjectId: messageObjectId,
    lifecycleKeyClass: "ai",
    lifecycleAuthorRole: "user",
    lifecyclePayloadVersion: 2,
    lifecycleCompletion: "complete",
    lifecycleDisposition: "mapped",
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  job?: Job | undefined;
  message?: MessageRow | undefined;
  loseUpdate?: boolean;
}>;

function harness(options: FixtureOptions = {}) {
  const taskRow = Object.prototype.hasOwnProperty.call(options, "task")
    ? options.task
    : task();
  const runRow = Object.prototype.hasOwnProperty.call(options, "run")
    ? options.run
    : run();
  const jobRow = Object.prototype.hasOwnProperty.call(options, "job")
    ? options.job
    : job();
  const messageRow = Object.prototype.hasOwnProperty.call(options, "message")
    ? options.message
    : message();
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<Record<string, unknown>> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) return jobRow ? [jobRow] : [];
    if (table === sessionMessages) return messageRow ? [messageRow] : [];
    throw new Error("unexpected table");
  };
  const tx = {
    select: (_selection?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          innerJoin: (_joined: unknown, _condition: unknown) => query,
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table);
          },
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table !== jobs) throw new Error("unexpected update table");
            writes.push(patch);
            return options.loseUpdate || !jobRow ? [] : [{ ...jobRow, ...patch }];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, locks, writes };
}

describe("protected Task await-reply acceptance CAS", () => {
  test("locks Task, Run, and prior Job before accepting one protected Message", async () => {
    const fixture = harness();

    expect(await acceptProtectedTaskAwaitReply(fixture.db, input())).toEqual({
      status: "accepted",
    });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
      { table: sessionMessages, kind: "share" },
    ]);
    expect(fixture.writes).toEqual([{
      metadata: {
        [parkKey]: parkReceipt(),
        [acceptanceKey]: acceptanceReceipt(),
      },
    }]);
    expect(JSON.stringify(fixture.writes)).not.toContain("plaintext");
  });

  test("returns an exact replay without re-reading or rewriting the Message", async () => {
    const fixture = harness({
      job: job({
        metadata: {
          [parkKey]: parkReceipt(),
          [acceptanceKey]: acceptanceReceipt(),
        },
      }),
      message: undefined,
    });

    expect(await acceptProtectedTaskAwaitReply(fixture.db, input())).toEqual({
      status: "exact_replay",
    });
    expect(fixture.locks).toHaveLength(3);
    expect(fixture.writes).toEqual([]);
  });

  test("accepts the requestor as the reply source without a target-user entry", async () => {
    const requestorAcceptance = acceptance({
      message: { ...acceptance().message, sourceUserId: ids.requestor },
    });
    const fixture = harness({
      task: task({ targetUserIds: [] }),
      message: message({ sourceUserId: ids.requestor }),
    });

    expect(await acceptProtectedTaskAwaitReply(fixture.db, input({
      acceptance: requestorAcceptance,
    }))).toEqual({ status: "accepted" });
  });

  test("rejects a different reply after one acceptance won", async () => {
    const fixture = harness({
      job: job({
        metadata: {
          [parkKey]: parkReceipt(),
          [acceptanceKey]: acceptanceReceipt(),
        },
      }),
    });
    const changed = acceptance({
      acceptanceId: "await-reply-acceptance:2",
      message: { ...acceptance().message, messageId: "42" },
    });

    expect(await acceptProtectedTaskAwaitReply(fixture.db, input({
      acceptance: changed,
    }))).toEqual({ status: "rejected", reason: "conflict" });
    expect(fixture.writes).toEqual([]);
  });

  test("rejects stopped, terminal, stale, Plain, and unauthorized Task state", async () => {
    const cases: FixtureOptions[] = [
      { task: task({ status: "cancelled" }) },
      { task: task({ status: "completed" }) },
      { task: task({ contentRepresentation: "ordinary" }) },
      { task: task({ prompt: "plaintext" }) },
      { task: task({ cryptoMappingState: "stale" }) },
      { task: task({ targetRoomId: ids.task }) },
      { task: task({ targetUserIds: [] }) },
      { run: run({ status: "cancelled", completedAt: parkedAt }) },
      { job: job({ metadata: { [parkKey]: parkReceipt({ generation: 4 }) } }) },
    ];

    for (const options of cases) {
      const fixture = harness(options);
      const result = await acceptProtectedTaskAwaitReply(fixture.db, input());
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(["stale", "conflict"]).toContain(result.reason);
      }
      expect(fixture.writes).toEqual([]);
    }
  });

  test("requires an exact current Human-authored AI-key encrypted revision", async () => {
    for (const changed of [
      message({ editRevision: 3 }),
      message({ cryptoObjectId: "message:v2:other" }),
      message({ namespaceId: ids.task }),
      message({ lifecycleRoomId: ids.task }),
      message({ sourceUserId: ids.requestor }),
      message({ role: "assistant" }),
      message({ createdAt: new Date("2026-09-28T12:34:55.000Z") }),
      message({ lifecycleKeyClass: "human" }),
      message({ lifecycleCompletion: "pending" }),
      message({ lifecycleDisposition: "stale_mapping" }),
    ]) {
      const fixture = harness({ message: changed });
      expect(await acceptProtectedTaskAwaitReply(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects an absent Message and malformed interrupt selection", async () => {
    expect(await acceptProtectedTaskAwaitReply(
      harness({ message: undefined }).db,
      input(),
    )).toEqual({ status: "rejected", reason: "not_found" });

    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;
    expect(acceptProtectedTaskAwaitReply(db, input({
      acceptance: acceptance({ interruptId: "interrupt:approval" }),
    }))).rejects.toThrow("acceptance is malformed");
    expect(acceptProtectedTaskAwaitReply(db, input({
      acceptance: acceptance({
        acceptedAt: new Date("2026-09-28T12:34:55.000Z"),
      }),
    }))).rejects.toThrow("acceptance is malformed");
    expect(acceptProtectedTaskAwaitReply(db, input({
      acceptance: {
        ...acceptance(),
        hidden: "content",
      } as never,
    }))).rejects.toThrow("acceptance is malformed");
    expect(transactions).toBe(0);
  });

  test("throws so the transaction rolls back when the Job CAS loses its row", () => {
    expect(acceptProtectedTaskAwaitReply(
      harness({ loseUpdate: true }).db,
      input(),
    )).rejects.toThrow("acceptance lost its Job");
  });

});
