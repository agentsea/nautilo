import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  parseParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskAdditionalAuthorityJobRow,
  type ParkedProtectedTaskAdditionalAuthorityRunRow,
  type ParkedProtectedTaskAdditionalAuthorityTaskRow,
  type ProtectedTaskDurableJobReference,
  type ProtectedTaskExecutionContinuationProof,
} from "@nautilo/db";

import {
  withCurrentAcceptedParkedTaskRuntimeAuthority,
} from "../../src/server/task/current-task-runtime-authority.ts";
import {
  withParkedTaskRuntimeRecipientAuthority,
} from "../../src/server/task/initial-task-runtime-namespace-authority.ts";
import {
  copyParkedTaskRuntimeAuthority,
  lockCurrentParkedTaskAdditionalAuthority,
  withParkedTaskRuntimeRestrictedAuthority,
} from "../../src/server/task/parked-task-runtime-authority.ts";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const JOB = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const AGENT = "50000000-0000-4000-8000-000000000005";
const NAMESPACE = "60000000-0000-4000-8000-000000000006";
const ROOM = "70000000-0000-4000-8000-000000000007";
const REQUEST = "authority-request:1";
const STARTED = new Date("2026-10-07T12:00:00.000Z");
const PARKED = new Date("2026-10-07T12:34:56.000Z");
const OBJECT = `task-definition:v1:${"a".repeat(64)}`;

const digest = (seed: number): Uint8Array => new Uint8Array(32).fill(seed);

function resultObjectId(): string {
  const value = createHash("sha256").update(
    `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
    "utf8",
  ).digest("hex");
  return `task-run-result:v1:${value}`;
}

function reference(): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: TASK,
    taskRunId: RUN,
    inputObjectId: OBJECT,
    resultObjectId: resultObjectId(),
    authorizationRequestId: "prior-request:1",
    policyRevision: 7,
    executionSegment: 1,
  };
}

function proof(): ProtectedTaskExecutionContinuationProof {
  return {
    segment: {
      taskRunId: RUN,
      executionSegment: 1,
      jobId: JOB,
      route: "native_langgraph_v1",
      transcriptContract: "protected_message_associations_v1",
      expectedTranscriptAssociationCount: 0,
      transcriptAssociationDigest: digest(2),
      checkpointContract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1,
      checkpointDigest: digest(3),
      expectedCheckpointBlobCount: 1,
      checkpointBlobDigest: digest(4),
      expectedPendingWriteCount: 0,
      pendingWriteDigest: digest(5),
      sealedAt: new Date(PARKED),
    },
    continuation: {
      taskRunId: RUN,
      executionSegment: 1,
      jobId: JOB,
      kind: "pre_effect_interrupt_v1",
      reason: "additional_authority",
      effectDisposition: "not_started_v1",
      interruptId: "interrupt:authority:1",
      operationId: "tool-call:1",
      requestDigest: digest(6),
      requiredAuthorityDigest: digest(7),
      sealedAt: new Date(PARKED),
    },
  };
}

function rows(): Readonly<{
  task: ParkedProtectedTaskAdditionalAuthorityTaskRow;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job: ParkedProtectedTaskAdditionalAuthorityJobRow;
  proof: ProtectedTaskExecutionContinuationProof;
}> {
  return {
    task: {
      id: TASK,
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      callingRoomId: ROOM,
      scheduleKind: "now",
      status: "awaiting",
      contentRepresentation: "protected",
      contentNamespaceId: NAMESPACE,
      contentRevision: 1,
      cryptoObjectId: OBJECT,
      cryptoAccessRevision: 2,
      cryptoRequiredNamespaceFingerprint: digest(1),
      cryptoMappingState: "verified",
      contentPristine: true,
    },
    run: {
      id: RUN,
      taskId: TASK,
      jobId: JOB,
      graphThreadId: `subagent:${TASK}:${RUN}`,
      status: "awaiting",
      startedAt: new Date(STARTED),
      pristine: true,
    },
    job: {
      id: JOB,
      ownerId: USER,
      requestorId: USER,
      laneKey: `task:${TASK}`,
      type: "foreground",
      status: "completed",
      startedAt: new Date(STARTED),
      completedAt: new Date(PARKED),
      reference: reference(),
      parkReceipt: {
        version: 1,
        taskId: TASK,
        taskRunId: RUN,
        jobId: JOB,
        graphThreadId: `subagent:${TASK}:${RUN}`,
        generation: 3,
        executionSegment: 1,
        interrupts: [{
          id: "interrupt:authority:1",
          kind: "additional_authority",
          requestId: REQUEST,
        }],
        parkedAt: PARKED.toISOString(),
      },
      pristine: true,
    },
    proof: proof(),
  };
}

function descriptor(): ParkedProtectedTaskAdditionalAuthority {
  const value = rows();
  const parsed = parseParkedProtectedTaskAdditionalAuthority({
    ...value,
    authorizationRequestId: REQUEST,
  });
  if (parsed === null) throw new Error("Parked fixture is invalid");
  return parsed;
}

function transactionRows(
  value: ReturnType<typeof rows>,
  events: string[],
) {
  const selected = [
    [value.task],
    [value.run],
    [value.job],
    [{ id: RUN, taskId: TASK }],
    [value.proof.segment],
    [value.proof.continuation],
  ];
  let index = 0;
  return {
    select: () => {
      const current = index++;
      const query: Record<string, unknown> = {};
      for (const method of ["from", "where"]) {
        query[method] = () => query;
      }
      query["limit"] = () => query;
      query["for"] = async () => {
        events.push(["task", "run", "job"][current] ?? "unexpected-lock");
        return selected[current];
      };
      query["then"] = (
        resolve: (rows: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => {
        events.push(["proof-run", "proof-segment", "proof-continuation"][
          current - 3
        ] ?? "unexpected-proof");
        return Promise.resolve(selected[current]).then(resolve, reject);
      };
      return query;
    },
  };
}

describe("parked Task Runtime authority", () => {
  test("copies the descriptor and rejects substituted derived coordinates", () => {
    const original = descriptor();
    const copy = copyParkedTaskRuntimeAuthority(original);
    original.proof.segment.checkpointDigest?.fill(0);
    original.occurrence.task.cryptoRequiredNamespaceFingerprint.fill(0);
    expect(copy.proof.segment.checkpointDigest).toEqual(digest(3));
    expect(copy.occurrence.task.cryptoRequiredNamespaceFingerprint)
      .toEqual(digest(1));

    expect(() => copyParkedTaskRuntimeAuthority({
      ...copy,
      continuationFingerprint: "x".repeat(43),
    })).toThrow("Parked Task Runtime authority descriptor is invalid");
    expect(() => copyParkedTaskRuntimeAuthority({
      ...copy,
      nextExecutionSegment: 3,
    })).toThrow("Parked Task Runtime authority descriptor is invalid");
  });

  test("locks Task, Run and prior Job before re-reading immutable proof", async () => {
    const value = rows();
    const events: string[] = [];
    const current = await lockCurrentParkedTaskAdditionalAuthority({
      transaction: transactionRows(value, events) as never,
      expected: descriptor(),
    });
    expect(current).not.toBeNull();
    expect(events).toEqual([
      "task",
      "run",
      "job",
      "proof-run",
      "proof-segment",
      "proof-continuation",
    ]);
  });

  test("pins caller-owned bytes before the first lock await", async () => {
    const expected = descriptor();
    const operation = lockCurrentParkedTaskAdditionalAuthority({
      transaction: transactionRows(rows(), []) as never,
      expected,
    });
    expected.proof.continuation.requestDigest?.fill(0);
    expected.occurrence.task.cryptoRequiredNamespaceFingerprint.fill(0);
    expect(await operation).not.toBeNull();
  });

  test("rejects stale lifecycle rows after the content-free locked proof", async () => {
    const cases = [
      { stage: "task", value: { ...rows(),
        task: { ...rows().task, status: "running" } } },
      { stage: "run", value: { ...rows(),
        run: { ...rows().run, status: "running" } } },
      { stage: "job", value: { ...rows(),
        job: { ...rows().job, status: "cancelled" } } },
    ];
    for (const currentCase of cases) {
      const events: string[] = [];
      expect(await lockCurrentParkedTaskAdditionalAuthority({
        transaction: transactionRows(currentCase.value, events) as never,
        expected: descriptor(),
      }), currentCase.stage).toBeNull();
      expect(events.slice(0, 3), currentCase.stage)
        .toEqual(["task", "run", "job"]);
    }
  });

  test("rejects cross-spliced recipient and accepted coordinates before SQL", async () => {
    const expected = descriptor();
    let transactions = 0;
    const runner = {
      transaction: async () => {
        transactions += 1;
        return null;
      },
    };
    const recipient = await withParkedTaskRuntimeRecipientAuthority({
      runner,
      expected,
      authorizationRequestId: expected.authorizationRequestId,
      taskId: USER,
      requesterUserId: USER,
      agentId: AGENT,
      contentNamespaceId: NAMESPACE,
    } as never);
    expect(recipient).toBeNull();

    const accepted = await withCurrentAcceptedParkedTaskRuntimeAuthority({
      runner,
      expected,
      subject: { userId: USER, humanActorId: USER, deviceId: "device" },
      accepted: {
        requestId: expected.authorizationRequestId,
        workId: expected.occurrence.run.id,
        workKind: "task.dispatch",
        workPurpose: "task.dispatch",
        namespaceRequirements: [{ namespaceId: NAMESPACE }],
      },
    } as never);
    expect(accepted).toBeNull();
    expect(transactions).toBe(0);
  });

  test("revokes retained restricted access after the callback", async () => {
    let queries = 0;
    let retained: {
      query(statement: string): Promise<readonly unknown[]>;
      transaction(
        use: () => Promise<unknown>,
        options: { isolationLevel: "read committed" },
      ): Promise<unknown>;
    } | undefined;
    const restricted = {
      query: async () => {
        queries += 1;
        return [];
      },
      transaction: async () => {
        throw new Error("unexpected transaction");
      },
      transactionOnce: async () => {
        throw new Error("unexpected transaction");
      },
    };
    expect(await withParkedTaskRuntimeRestrictedAuthority(
      restricted as never,
      async current => {
        retained = current;
        return "done";
      },
    )).toBe("done");
    expect(() => retained?.query("select 1"))
      .toThrow("Parked Task Runtime authority is not active");
    expect(() => retained?.transaction(
      async () => undefined,
      { isolationLevel: "read committed" },
    )).toThrow("Parked Task Runtime authority is not active");
    expect(queries).toBe(0);
  });

  test("drains escaped operations and rejects the authority scope", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let escaped: Promise<readonly unknown[]> | undefined;
    const restricted = {
      query: async () => {
        await blocked;
        return [];
      },
      transaction: async () => {
        throw new Error("unexpected transaction");
      },
      transactionOnce: async () => {
        throw new Error("unexpected transaction");
      },
    };
    let settled = false;
    const authority = withParkedTaskRuntimeRestrictedAuthority(
      restricted as never,
      async current => {
        escaped = current.query("select 1");
        return "unsafe-success";
      },
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await authority.catch((error: unknown) => error))
      .toBeInstanceOf(AggregateError);
    expect(await escaped?.catch((error: unknown) => error))
      .toBeInstanceOf(TypeError);
  });
});
