import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  terminalizeDualTaskRunResult,
  terminalizeProtectedTaskRunResult,
  type DualTaskRunTerminalInput,
  type ProtectedTaskRunTerminalInput,
} from "../../src/queries/tasks";
import {
  encryptionTransitionPolicy,
  type EncryptionTransitionPolicyRow,
} from "../../src/schema/encryption-transition";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import {
  taskDefinitionCryptoRevisions,
  type TaskDefinitionCryptoRevision,
} from "../../src/schema/task-definition-crypto-revisions";
import {
  taskRunResultCryptoRevisions,
  type TaskRunResultCryptoRevision,
} from "../../src/schema/task-run-result-crypto-revisions";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
};
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId = `task-run-result:v1:${"b".repeat(64)}`;
const fingerprint = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const digest = new Uint8Array(32).fill(0x41);
const completedAt = new Date("2026-09-25T12:34:56.000Z");
const receiptKey = "nautilo.protectedTaskRunTerminal.v1";

function input(
  overrides: Partial<ProtectedTaskRunTerminalInput> = {},
): ProtectedTaskRunTerminalInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    scheduleKind: "one_shot",
    operationId: `task-run-result:${ids.run}`,
    requestDigest: digest,
    resultObjectId,
    resultRevision: 1,
    resultRepresentation: "protected",
    outcome: "completed",
    completedAt,
    requiredRunStatus: "running",
    ...overrides,
  };
}

function dualInput(
  overrides: Partial<DualTaskRunTerminalInput> = {},
): DualTaskRunTerminalInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    scheduleKind: "one_shot",
    operationId: `task-run-result:${ids.run}`,
    requestDigest: digest,
    resultObjectId,
    resultRevision: 1,
    resultRepresentation: "dual",
    outcome: "completed",
    completedAt,
    requiredRunStatus: "running",
    ordinaryResult: {
      formatVersion: 1,
      resultText: "canonical dual result",
      lastError: null,
    },
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    prompt: "",
    expectedOutput: null,
    scheduleKind: "one_shot",
    status: "running",
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: fingerprint,
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
    graphThreadId: `subagent:${ids.task}:${ids.run}`,
    status: "running",
    modelId: null,
    resultText: null,
    startedAt: new Date("2026-09-25T12:00:00.000Z"),
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

function jobReference() {
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

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "running",
    input: jobReference(),
    result: null,
    message: null,
    createdAt: new Date("2026-09-25T12:00:01.000Z"),
    startedAt: new Date("2026-09-25T12:00:02.000Z"),
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

function definitionRevision(
  overrides: Partial<TaskDefinitionCryptoRevision> = {},
): TaskDefinitionCryptoRevision {
  return {
    taskId: ids.task,
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: definitionObjectId,
    representation: "protected",
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: fingerprint,
    completion: "complete",
    disposition: "mapped",
    failureCode: null,
    ...overrides,
  } as TaskDefinitionCryptoRevision;
}

function resultRevision(
  overrides: Partial<TaskRunResultCryptoRevision> = {},
): TaskRunResultCryptoRevision {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    contentNamespaceId: ids.namespace,
    resultRevision: 1,
    operationId: `task-run-result:${ids.run}`,
    requestDigest: digest,
    requesterHumanId: ids.owner,
    anchorNamespaceId: ids.namespace,
    cryptoObjectId: resultObjectId,
    representation: "protected",
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: fingerprint,
    completion: "pending",
    disposition: "active",
    failureCode: null,
    ...overrides,
  } as TaskRunResultCryptoRevision;
}

function policy(
  overrides: Partial<EncryptionTransitionPolicyRow> = {},
): EncryptionTransitionPolicyRow {
  return {
    id: "server",
    mode: "encrypted_only",
    revision: 9,
    ...overrides,
  } as EncryptionTransitionPolicyRow;
}

function outputBinding(
  overrides: Partial<ProtectedTaskRunOutputBinding> = {},
): ProtectedTaskRunOutputBinding {
  return {
    taskRunId: ids.run,
    bindingId: `task-run-output:${ids.run}`,
    deliveryMode: "none",
    destinationRoomId: null,
    destinationNamespaceId: null,
    resultOperationId: `task-run-result:${ids.run}`,
    resultObjectId,
    messageOperationId: null,
    wakeOperationId: null,
    acceptedPolicyRevision: 9,
    acceptedAt: new Date("2026-09-25T12:00:03.000Z"),
    resultTerminalAt: null,
    resultAttachedAt: null,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
    ...overrides,
  };
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    operationId: `task-run-result:${ids.run}`,
    requestDigest: hex(digest),
    resultObjectId,
    resultRevision: 1,
    resultRepresentation: "protected",
    outcome: "completed",
    completedAt: completedAt.toISOString(),
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  job?: Job | undefined;
  definitionRevision?: TaskDefinitionCryptoRevision | undefined;
  resultRevision?: TaskRunResultCryptoRevision | undefined;
  policy?: EncryptionTransitionPolicyRow | undefined;
  outputBinding?: ProtectedTaskRunOutputBinding | undefined;
  loseJobUpdate?: boolean;
  loseRunUpdate?: boolean;
  loseTaskUpdate?: boolean;
  loseOutputBindingUpdate?: boolean;
}>;

function harness(options: FixtureOptions = {}) {
  let taskRow = Object.prototype.hasOwnProperty.call(options, "task")
    ? options.task
    : task();
  let runRow = Object.prototype.hasOwnProperty.call(options, "run")
    ? options.run
    : run();
  let jobRow = Object.prototype.hasOwnProperty.call(options, "job")
    ? options.job
    : job();
  const definitionRow = Object.prototype.hasOwnProperty.call(
    options,
    "definitionRevision",
  ) ? options.definitionRevision : definitionRevision();
  const resultRow = Object.prototype.hasOwnProperty.call(options, "resultRevision")
    ? options.resultRevision
    : resultRevision();
  const policyRow = Object.prototype.hasOwnProperty.call(options, "policy")
    ? options.policy
    : policy();
  let outputBindingRow = Object.prototype.hasOwnProperty.call(
    options,
    "outputBinding",
  ) ? options.outputBinding : outputBinding({
    resultTerminalAt: runRow?.completedAt ?? null,
  });
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) return jobRow ? [jobRow] : [];
    if (table === taskDefinitionCryptoRevisions) {
      return definitionRow ? [definitionRow] : [];
    }
    if (table === taskRunResultCryptoRevisions) return resultRow ? [resultRow] : [];
    if (table === encryptionTransitionPolicy) return policyRow ? [policyRow] : [];
    if (table === protectedTaskRunOutputBindings) {
      return outputBindingRow ? [outputBindingRow] : [];
    }
    throw new Error("unexpected table");
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
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
            writes.push({ table, patch });
            if (table === jobs) {
              if (options.loseJobUpdate || !jobRow) return [];
              jobRow = { ...jobRow, ...patch } as Job;
              return [jobRow];
            }
            if (table === taskRuns) {
              if (options.loseRunUpdate || !runRow) return [];
              runRow = { ...runRow, ...patch } as TaskRun;
              return [runRow];
            }
            if (table === tasks) {
              if (options.loseTaskUpdate || !taskRow) return [];
              taskRow = { ...taskRow, ...patch } as Task;
              return [taskRow];
            }
            if (table === protectedTaskRunOutputBindings) {
              if (options.loseOutputBindingUpdate || !outputBindingRow) return [];
              outputBindingRow = {
                ...outputBindingRow,
                ...patch,
              } as ProtectedTaskRunOutputBinding;
              return [outputBindingRow];
            }
            throw new Error("unexpected update table");
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

describe("protected TaskRun result terminal CAS", () => {
  test("locks exact authority and writes only a receipt and terminal facts", async () => {
    const fixture = harness();

    expect(await terminalizeProtectedTaskRunResult(fixture.db, input()))
      .toEqual({ status: "transitioned" });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
      { table: taskDefinitionCryptoRevisions, kind: "share" },
      { table: taskRunResultCryptoRevisions, kind: "share" },
      { table: encryptionTransitionPolicy, kind: "share" },
      { table: protectedTaskRunOutputBindings, kind: "update" },
    ]);
    expect(fixture.writes).toHaveLength(4);
    expect(fixture.writes[0]?.table).toBe(jobs);
    expect(fixture.writes[0]?.patch).toEqual({
      metadata: { [receiptKey]: exactReceipt() },
    });
    expect(fixture.writes[1]).toEqual({
      table: taskRuns,
      patch: { status: "completed", completedAt },
    });
    expect(fixture.writes[2]).toEqual({
      table: tasks,
      patch: { status: "completed", updatedAt: completedAt },
    });
    expect(fixture.writes[3]).toEqual({
      table: protectedTaskRunOutputBindings,
      patch: { resultTerminalAt: completedAt },
    });
    const patches = JSON.stringify(fixture.writes.map((write) => write.patch));
    expect(patches).not.toContain("resultText");
    expect(patches).not.toContain("lastError");
  });

  test("terminalizes a cron run while its already-advanced Task stays pending", async () => {
    const fixture = harness({
      task: task({ scheduleKind: "cron", status: "pending" }),
    });
    const result = await terminalizeProtectedTaskRunResult(fixture.db, input({
      scheduleKind: "cron",
      outcome: "errored",
    }));

    expect(result).toEqual({ status: "transitioned" });
    expect(fixture.writes.map((write) => write.table)).toEqual([
      jobs,
      taskRuns,
      protectedTaskRunOutputBindings,
    ]);
    expect(fixture.writes[1]?.patch).toEqual({
      status: "errored",
      completedAt,
    });
  });

  test("terminalizes an immediate run only while its Task is running", async () => {
    const fixture = harness({ task: task({ scheduleKind: "now" }) });
    expect(await terminalizeProtectedTaskRunResult(fixture.db, input({
      scheduleKind: "now",
    }))).toEqual({ status: "transitioned" });
    expect(fixture.writes.at(-2)).toEqual({
      table: tasks,
      patch: { status: "completed", updatedAt: completedAt },
    });

    const stale = harness({
      task: task({ scheduleKind: "now", status: "awaiting" }),
    });
    expect(await terminalizeProtectedTaskRunResult(stale.db, input({
      scheduleKind: "now",
    }))).toEqual({ status: "rejected", reason: "not_running" });
    expect(stale.writes).toEqual([]);
  });

  test("accepts replay only with the exact Job receipt and mapped ledger", async () => {
    const fixture = harness({
      task: task({ status: "completed" }),
      run: run({
        status: "completed",
        completedAt,
        resultRepresentation: "protected",
        resultContentNamespaceId: ids.namespace,
        resultRevision: 1,
        resultCryptoObjectId: resultObjectId,
        resultCryptoAccessRevision: 0,
        resultCryptoRequiredNamespaceFingerprint: fingerprint,
        resultCryptoMappingState: "verified",
      }),
      job: job({
        status: "completed",
        completedAt,
        metadata: { [receiptKey]: exactReceipt() },
      }),
      resultRevision: resultRevision({ completion: "complete", disposition: "mapped" }),
    });

    expect(await terminalizeProtectedTaskRunResult(fixture.db, input()))
      .toEqual({ status: "exact_replay" });
    expect(fixture.writes).toEqual([]);
  });

  test("replays the receipt window before protected result mapping completes", async () => {
    const fixture = harness({
      task: task({ status: "completed" }),
      run: run({ status: "completed", completedAt }),
      job: job({ metadata: { [receiptKey]: exactReceipt() } }),
    });

    expect(await terminalizeProtectedTaskRunResult(fixture.db, input()))
      .toEqual({ status: "exact_replay" });
    expect(fixture.writes).toEqual([]);
  });

  test("same-terminal state without a closed exact receipt fails conflict", async () => {
    for (const metadata of [
      {},
      { [receiptKey]: exactReceipt({ extra: "forbidden" }) },
      { [receiptKey]: exactReceipt({ requestDigest: "00".repeat(32) }) },
    ]) {
      const fixture = harness({
        task: task({ status: "completed" }),
        run: run({ status: "completed", completedAt }),
        job: job({ metadata }),
      });
      expect(await terminalizeProtectedTaskRunResult(fixture.db, input()))
        .toEqual({ status: "rejected", reason: "conflict" });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("fails closed on changed mapping, result reservation, Job, or policy", async () => {
    const cases: FixtureOptions[] = [
      { task: task({ prompt: "plaintext" }) },
      { task: task({ scheduleKind: "now" }) },
      { definitionRevision: definitionRevision({ disposition: "active" }) },
      { resultRevision: resultRevision({ requestDigest: new Uint8Array(32) }) },
      { job: job({ status: "queued" }) },
      { job: job({ input: { ...jobReference(), resultObjectId: `${resultObjectId}:other` } }) },
      { policy: policy({ revision: 10 }) },
      { policy: policy({ mode: "shadow_encryption" }) },
      { outputBinding: undefined },
      { outputBinding: outputBinding({ acceptedPolicyRevision: 10 }) },
    ];

    for (const options of cases) {
      const fixture = harness(options);
      const result = await terminalizeProtectedTaskRunResult(fixture.db, input());
      expect(result.status).toBe("rejected");
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects malformed requests before opening a transaction", () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;

    expect(terminalizeProtectedTaskRunResult(db, input({
      requestDigest: new Uint8Array(31),
    }))).rejects.toThrow("binding is malformed");
    expect(terminalizeProtectedTaskRunResult(db, {
      ...input(),
      resultRepresentation: "dual",
    } as unknown as ProtectedTaskRunTerminalInput)).rejects.toThrow(
      "binding is malformed",
    );
    expect(transactions).toBe(0);
  });

  test("throws to roll back if a locked write unexpectedly loses its CAS", () => {
    expect(terminalizeProtectedTaskRunResult(
      harness({ loseJobUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its Job");
    expect(terminalizeProtectedTaskRunResult(
      harness({ loseRunUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its TaskRun");
    expect(terminalizeProtectedTaskRunResult(
      harness({ loseTaskUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its Task");
    expect(terminalizeProtectedTaskRunResult(
      harness({ loseOutputBindingUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its output binding");
  });

  test("writes Shadow ordinary result content in the same dual terminal CAS", async () => {
    const fixture = harness({
      task: task({
        contentRepresentation: "dual",
        prompt: "ordinary task definition",
        expectedOutput: "ordinary expectation",
      }),
      definitionRevision: definitionRevision({ representation: "dual" }),
      resultRevision: resultRevision({ representation: "dual" }),
      policy: policy({ mode: "shadow_encryption" }),
    });
    const ordinaryResult = {
      formatVersion: 1 as const,
      resultText: "canonical dual result",
      lastError: null,
    };

    expect(await terminalizeDualTaskRunResult(fixture.db, dualInput({
      ordinaryResult,
    }))).toEqual({ status: "transitioned" });
    expect(fixture.writes[0]?.patch).toEqual({
      metadata: {
        [receiptKey]: exactReceipt({ resultRepresentation: "dual" }),
      },
    });
    expect(fixture.writes[1]).toEqual({
      table: taskRuns,
      patch: {
        status: "completed",
        completedAt,
        resultText: ordinaryResult.resultText,
        lastError: ordinaryResult.lastError,
      },
    });
    expect(fixture.writes[2]?.table).toBe(tasks);
    expect(fixture.writes[3]?.table).toBe(protectedTaskRunOutputBindings);
    expect(JSON.stringify(fixture.writes[0]?.patch)).not.toContain(
      ordinaryResult.resultText,
    );
  });

  test("keeps cron pending while atomically storing a dual error", async () => {
    const fixture = harness({
      task: task({
        scheduleKind: "cron",
        status: "pending",
        contentRepresentation: "dual",
        prompt: "ordinary cron definition",
      }),
      definitionRevision: definitionRevision({ representation: "dual" }),
      resultRevision: resultRevision({ representation: "dual" }),
      policy: policy({ mode: "shadow_encryption" }),
    });
    const ordinaryResult = {
      formatVersion: 1 as const,
      resultText: null,
      lastError: "canonical dual error",
    };

    expect(await terminalizeDualTaskRunResult(fixture.db, dualInput({
      scheduleKind: "cron",
      outcome: "errored",
      ordinaryResult,
    }))).toEqual({ status: "transitioned" });
    expect(fixture.writes.map((write) => write.table)).toEqual([
      jobs,
      taskRuns,
      protectedTaskRunOutputBindings,
    ]);
    expect(fixture.writes[1]?.patch).toMatchObject({
      status: "errored",
      resultText: null,
      lastError: ordinaryResult.lastError,
    });
  });

  test("dual replay requires the exact ordinary values and mapped receipt", async () => {
    const ordinaryResult = dualInput().ordinaryResult;
    const fixture = harness({
      task: task({
        status: "completed",
        contentRepresentation: "dual",
        prompt: "ordinary task definition",
      }),
      run: run({
        status: "completed",
        completedAt,
        resultText: ordinaryResult.resultText,
        lastError: ordinaryResult.lastError,
        resultRepresentation: "dual",
        resultContentNamespaceId: ids.namespace,
        resultRevision: 1,
        resultCryptoObjectId: resultObjectId,
        resultCryptoAccessRevision: 0,
        resultCryptoRequiredNamespaceFingerprint: fingerprint,
        resultCryptoMappingState: "verified",
      }),
      job: job({
        status: "completed",
        completedAt,
        metadata: {
          [receiptKey]: exactReceipt({ resultRepresentation: "dual" }),
        },
      }),
      definitionRevision: definitionRevision({ representation: "dual" }),
      resultRevision: resultRevision({
        representation: "dual",
        completion: "complete",
        disposition: "mapped",
      }),
      policy: policy({ mode: "shadow_encryption" }),
    });

    expect(await terminalizeDualTaskRunResult(fixture.db, dualInput()))
      .toEqual({ status: "exact_replay" });
    expect(await terminalizeDualTaskRunResult(fixture.db, dualInput({
      ordinaryResult: {
        formatVersion: 1,
        resultText: "different result",
        lastError: null,
      },
    }))).toEqual({ status: "rejected", reason: "conflict" });
    expect(fixture.writes).toEqual([]);
  });

  test("dual publication requires dual ledgers and the current Shadow fence", async () => {
    const base = {
      task: task({
        contentRepresentation: "dual",
        prompt: "ordinary task definition",
      }),
      definitionRevision: definitionRevision({ representation: "dual" }),
      resultRevision: resultRevision({ representation: "dual" }),
      policy: policy({ mode: "shadow_encryption" }),
    } as const;
    for (const options of [
      { ...base, definitionRevision: definitionRevision() },
      { ...base, resultRevision: resultRevision() },
      { ...base, policy: policy({ mode: "encrypted_only" }) },
    ]) {
      const fixture = harness(options);
      expect(await terminalizeDualTaskRunResult(fixture.db, dualInput()))
        .toMatchObject({ status: "rejected" });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("validates and snapshots canonical dual payload before transaction", async () => {
    let transactions = 0;
    const closedDb = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;
    expect(terminalizeDualTaskRunResult(closedDb, dualInput({
      ordinaryResult: {
        formatVersion: 1,
        resultText: null,
        lastError: null,
      },
    }))).rejects.toThrow("payload is invalid");
    expect(terminalizeDualTaskRunResult(closedDb, dualInput({
      ordinaryResult: {
        formatVersion: 1,
        resultText: "result",
        lastError: null,
        extra: "plaintext",
      } as unknown as DualTaskRunTerminalInput["ordinaryResult"],
    }))).rejects.toThrow("field set");
    expect(transactions).toBe(0);

    const ordinaryResult = {
      formatVersion: 1 as const,
      resultText: "snapshotted result",
      lastError: null,
    };
    const fixture = harness({
      task: task({
        contentRepresentation: "dual",
        prompt: "ordinary task definition",
      }),
      definitionRevision: definitionRevision({ representation: "dual" }),
      resultRevision: resultRevision({ representation: "dual" }),
      policy: policy({ mode: "shadow_encryption" }),
    });
    const publication = terminalizeDualTaskRunResult(fixture.db, dualInput({
      ordinaryResult,
    }));
    ordinaryResult.resultText = "mutated result";
    expect(await publication).toEqual({ status: "transitioned" });
    expect(fixture.writes[1]?.patch["resultText"]).toBe("snapshotted result");
  });
});
