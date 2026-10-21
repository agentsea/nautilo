import { assertApprovalSelectionsAreContentFree, projectApprovalRow, applyApprovalPatch, compileApprovalSelection } from "../fixtures/protected-approval-projection";
import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  acceptProtectedTaskHumanContinuation,
  protectedTaskHumanContinuationAcceptanceId,
  type AcceptProtectedTaskHumanContinuationInput,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import { sessionMessages } from "../../src/schema/sessions";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";
import { actors } from "../../src/schema/trust";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  requestor: "40000000-0000-4000-8000-000000000004",
  recipient: "50000000-0000-4000-8000-000000000005",
  humanActor: "50000000-0000-4000-8000-000000000015",
  requestorActor: "50000000-0000-4000-8000-000000000016",
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
const acceptanceKey = "nautilo.protectedTaskHumanContinuationAcceptance.v1";
const stableRoutingDigest = new Uint8Array(32).fill(7);
const stableRoutingDigestText = Buffer.from(stableRoutingDigest).toString("base64url");

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

function acceptance(
  overrides: Partial<AcceptProtectedTaskHumanContinuationInput["acceptance"]>
    = {},
) {
  const base = {
    acceptedBy: { userId: ids.recipient, humanActorId: ids.humanActor },
    interrupt: { id: "interrupt:reply", kind: "await_reply" as const },
    response: { kind: "await_reply" as const, message: {
      roomId: ids.room,
      sessionId: ids.session,
      messageId: "41",
      editRevision: 2,
      cryptoObjectId: messageObjectId,
      namespaceId: ids.namespace,
      sourceUserId: ids.recipient,
    } },
    acceptedAt,
  };
  const value = { ...base, ...overrides };
  return {
    ...value,
    acceptanceId: overrides.acceptanceId
      ?? protectedTaskHumanContinuationAcceptanceId({
      taskId: ids.task,
      taskRunId: ids.run,
      priorJobId: ids.job,
      executionSegment: 1,
      acceptedBy: value.acceptedBy,
      interrupt: value.interrupt,
      response: value.response,
    }),
  } as AcceptProtectedTaskHumanContinuationInput["acceptance"];
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
    stableRoutingDigest: stableRoutingDigestText,
    ...overrides,
  };
}

function acceptanceReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    acceptanceId: acceptance().acceptanceId,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    nextExecutionSegment: 2,
    acceptedBy: acceptance().acceptedBy,
    interrupt: acceptance().interrupt,
    response: acceptance().response,
    acceptedAt: acceptedAt.toISOString(),
    ...overrides,
  };
}

function categoricalAcceptance(
  kind: "approval" | "prove_it" | "identity",
): AcceptProtectedTaskHumanContinuationInput["acceptance"] {
  const interrupt = kind === "approval"
    ? { id: "interrupt:approval", kind, requestId: "approval:1" }
    : { id: `interrupt:${kind}`, kind };
  const response = kind === "approval"
    ? { kind, verb: "deny" as const }
    : kind === "prove_it"
      ? { kind, approved: true }
      : { kind };
  const acceptedBy = {
    userId: ids.requestor,
    humanActorId: ids.requestorActor,
  };
  return {
    acceptanceId: protectedTaskHumanContinuationAcceptanceId({
      taskId: ids.task,
      taskRunId: ids.run,
      priorJobId: ids.job,
      executionSegment: 1,
      acceptedBy,
      interrupt,
      response,
    }),
    acceptedBy,
    interrupt,
    response,
    acceptedAt,
  };
}

function input(
  overrides: Partial<AcceptProtectedTaskHumanContinuationInput> = {},
): AcceptProtectedTaskHumanContinuationInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    priorJobId: ids.job,
    generation: 3,
    executionSegment: 1,
    interrupts: interrupts(),
    parkedAt,
    stableRoutingDigest,
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
    fundingMode: "legacy_server",
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
    fundingBinding: null,
    fundingPredecessorRunId: null,
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
  humanEnabled?: boolean;
  humanUserId?: string;
  humanActorId?: string;
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
  const selections: string[] = [];
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<Record<string, unknown>> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) return jobRow ? [jobRow] : [];
    if (table === sessionMessages) return messageRow ? [messageRow] : [];
    if (table === actors) return [{
      humanActorId: options.humanActorId ?? ids.humanActor,
      userId: options.humanUserId ?? ids.recipient,
      kind: "user",
      disabledAt: options.humanEnabled === false ? parkedAt : null,
    }];
    throw new Error("unexpected table");
  };
  const tx = {
    select: (selection?: unknown) => ({
      from: (table: unknown) => {
        if (selection !== undefined && [tasks, taskRuns, jobs].includes(table as typeof tasks)) selections.push(compileApprovalSelection(table, selection));
        const query = {
          innerJoin: (_joined: unknown, _condition: unknown) => query,
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table).map(row => projectApprovalRow(table, row, selection));
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
            writes.push(jobRow ? applyApprovalPatch(jobRow, patch) : patch);
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
  return { db, locks, writes, selections };
}

describe("protected Task Human continuation acceptance CAS", () => {
  test("derives stable identities from semantic fields instead of object insertion order", () => {
    const expectedAwaitReply = acceptance().acceptanceId;
    expect(protectedTaskHumanContinuationAcceptanceId({
      taskId: ids.task,
      taskRunId: ids.run,
      priorJobId: ids.job,
      executionSegment: 1,
      acceptedBy: {
        humanActorId: ids.humanActor,
        userId: ids.recipient,
      },
      interrupt: {
        kind: "await_reply",
        id: "interrupt:reply",
      },
      response: {
        message: {
          sourceUserId: ids.recipient,
          namespaceId: ids.namespace,
          cryptoObjectId: messageObjectId,
          editRevision: 2,
          messageId: "41",
          sessionId: ids.session,
          roomId: ids.room,
        },
        kind: "await_reply",
      },
    })).toBe(expectedAwaitReply);

    const approval = categoricalAcceptance("approval");
    expect(protectedTaskHumanContinuationAcceptanceId({
      taskId: ids.task,
      taskRunId: ids.run,
      priorJobId: ids.job,
      executionSegment: 1,
      acceptedBy: {
        humanActorId: ids.requestorActor,
        userId: ids.requestor,
      },
      interrupt: {
        requestId: "approval:1",
        kind: "approval",
        id: "interrupt:approval",
      },
      response: {
        verb: "deny",
        kind: "approval",
      },
    })).toBe(approval.acceptanceId);
  });

  test("locks Task, Run, and prior Job before accepting one protected Message", async () => {
    const fixture = harness();

    expect(await acceptProtectedTaskHumanContinuation(fixture.db, input())).toEqual({
      status: "accepted",
      acceptance: acceptance(),
    });
    assertApprovalSelectionsAreContentFree(fixture.selections);
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
      { table: actors, kind: "share" },
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

    expect(await acceptProtectedTaskHumanContinuation(fixture.db, input())).toEqual({
      status: "exact_replay",
      acceptance: acceptance(),
    });
    expect(fixture.locks).toHaveLength(3);
    expect(fixture.writes).toEqual([]);
  });

  test("returns the durable original timestamp when an HTTP retry arrives later", async () => {
    const retried = acceptance({
      acceptedAt: new Date("2026-09-28T12:36:00.000Z"),
    });
    const fixture = harness({
      job: job({
        metadata: {
          [parkKey]: parkReceipt(),
          [acceptanceKey]: acceptanceReceipt(),
        },
      }),
      message: undefined,
    });
    expect(await acceptProtectedTaskHumanContinuation(fixture.db, input({
      acceptance: retried,
    }))).toEqual({ status: "exact_replay", acceptance: acceptance() });
  });

  test("accepts bounded approval, prove-it, and identity decisions without content", async () => {
    for (const kind of ["approval", "prove_it", "identity"] as const) {
      const decision = categoricalAcceptance(kind);
      const fixture = harness({
        humanUserId: ids.requestor,
        humanActorId: ids.requestorActor,
        job: job({
          metadata: {
            [parkKey]: parkReceipt({ interrupts: [decision.interrupt] }),
          },
        }),
      });
      expect(await acceptProtectedTaskHumanContinuation(fixture.db, input({
        interrupts: [decision.interrupt],
        acceptance: decision,
      }))).toEqual({ status: "accepted", acceptance: decision });
      expect(JSON.stringify(fixture.writes)).not.toContain("prompt");
    }
  });

  test("rejects a disabled or swapped Human actor", async () => {
    for (const fixture of [
      harness({ humanEnabled: false }),
      harness({ humanActorId: ids.requestorActor }),
    ]) {
      expect(await acceptProtectedTaskHumanContinuation(
        fixture.db,
        input(),
      )).toEqual({ status: "rejected", reason: "stale" });
    }
  });

  test("accepts the requestor as the reply source without a target-user entry", async () => {
    const baseResponse = acceptance().response;
    if (baseResponse.kind !== "await_reply") throw new Error("invalid fixture");
    const response = {
      kind: "await_reply" as const,
      message: {
        ...baseResponse.message,
        sourceUserId: ids.requestor,
      },
    };
    const requestorAcceptance = acceptance({
      acceptedBy: { userId: ids.requestor, humanActorId: ids.requestorActor },
      response,
    });
    const fixture = harness({
      task: task({ targetUserIds: [] }),
      message: message({ sourceUserId: ids.requestor }),
      humanUserId: ids.requestor,
      humanActorId: ids.requestorActor,
    });

    expect(await acceptProtectedTaskHumanContinuation(fixture.db, input({
      acceptance: requestorAcceptance,
    }))).toEqual({ status: "accepted", acceptance: requestorAcceptance });
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
    const originalResponse = acceptance().response;
    if (originalResponse.kind !== "await_reply") throw new Error("invalid fixture");
    const changed = acceptance({
      response: {
        kind: "await_reply",
        message: {
          ...originalResponse.message,
          messageId: "42",
        },
      },
    });

    expect(await acceptProtectedTaskHumanContinuation(fixture.db, input({
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
      const result = await acceptProtectedTaskHumanContinuation(fixture.db, input());
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
      expect(await acceptProtectedTaskHumanContinuation(fixture.db, input())).toEqual({
        status: "rejected",
        reason: "stale",
      });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects an absent Message and malformed interrupt selection", async () => {
    expect(await acceptProtectedTaskHumanContinuation(
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
    expect(acceptProtectedTaskHumanContinuation(db, input({
      acceptance: {
        ...acceptance(),
        interrupt: {
          id: "interrupt:approval",
          kind: "approval",
          requestId: "approval:1",
        },
      },
    }))).rejects.toThrow("acceptance is malformed");
    expect(acceptProtectedTaskHumanContinuation(db, input({
      acceptance: acceptance({
        acceptedAt: new Date("2026-09-28T12:34:55.000Z"),
      }),
    }))).rejects.toThrow("acceptance is malformed");
    expect(acceptProtectedTaskHumanContinuation(db, input({
      acceptance: {
        ...acceptance(),
        hidden: "content",
      } as never,
    }))).rejects.toThrow("acceptance is malformed");
    expect(transactions).toBe(0);
  });

  test("throws so the transaction rolls back when the Job CAS loses its row", () => {
    expect(acceptProtectedTaskHumanContinuation(
      harness({ loseUpdate: true }).db,
      input(),
    )).rejects.toThrow("acceptance lost its Job");
  });

});


test("categorical acceptance denies malformed or extended stored input before writing", async () => {
  for (const stored of [null, { ...reference(), prompt: "private-canary" },
    { ...reference(), taskId: { prompt: "private-canary" } }]) {
    const fixture = harness({ job: job({ input: stored }) });
    expect((await acceptProtectedTaskHumanContinuation(fixture.db, input())).status).toBe("rejected");
    expect(fixture.writes).toEqual([]);
  }
});

test("acceptance patches its receipt without replacing unrelated durable metadata", async () => {
  const fixture = harness({ job: job({ metadata: { [parkKey]: parkReceipt(), unrelated: "private-canary" } }) });
  expect((await acceptProtectedTaskHumanContinuation(fixture.db, input())).status).toBe("accepted");
  expect(fixture.writes[0]).toEqual({ metadata: { [parkKey]: parkReceipt(),
    unrelated: "private-canary", [acceptanceKey]: acceptanceReceipt() } });
  assertApprovalSelectionsAreContentFree(fixture.selections);
});
