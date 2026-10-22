import { describe, expect, test } from "bun:test";
import type { TaskFundingBinding } from "@nautilo/types";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  bindProtectedTaskRunFunding,
  type BindProtectedTaskRunFundingInput,
} from "../../src/queries/protected-task-funding";
import { jobs, type Job } from "../../src/schema/jobs";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
  credential: "60000000-0000-4000-8000-000000000006",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const objectId = `task-definition:v1:${"a".repeat(64)}`;
const fingerprint = new Uint8Array(32).fill(7);
const fundingBinding: TaskFundingBinding = Object.freeze({
  kind: "personal",
  providerRoute: "anthropic",
  credentialId: ids.credential,
  credentialRevision: 3,
});

function reference() {
  return {
    kind: "protected_task_run_v1" as const,
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: objectId,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
  };
}

function input(overrides: Partial<BindProtectedTaskRunFundingInput> = {}): BindProtectedTaskRunFundingInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    jobId: ids.job,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 2,
    cryptoObjectId: objectId,
    cryptoAccessRevision: 4,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    jobReference: reference(),
    modelId: "anthropic:claude-sonnet",
    fundingBinding,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    scheduleKind: "now",
    status: "running",
    fundingMode: "caller",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 2,
    cryptoObjectId: objectId,
    cryptoAccessRevision: 4,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "running",
    modelId: null,
    fundingBinding: null,
    fundingPredecessorRunId: null,
    resultText: null,
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
  } as TaskRun;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "running",
    input: reference(),
    result: null,
    message: null,
    startedAt: new Date("2026-10-12T10:00:00.000Z"),
    completedAt: null,
    ...overrides,
  } as Job;
}

function harness(overrides: Readonly<{
  task?: Task;
  run?: TaskRun;
  job?: Job;
  loseUpdate?: boolean;
}> = {}) {
  const taskRow = overrides.task ?? task();
  let runRow = overrides.run ?? run();
  const jobRow = overrides.job ?? job();
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Record<string, unknown>[] = [];
  const rows = (table: unknown) => table === tasks ? [taskRow]
    : table === taskRuns ? [runRow]
      : table === jobs ? [jobRow]
        : [];
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
            writes.push(patch);
            if (table !== taskRuns || overrides.loseUpdate) return [];
            runRow = { ...runRow, ...patch };
            return [runRow];
          },
        }),
      }),
    }),
  };
  return {
    db: { transaction: async <T>(work: (value: typeof tx) => Promise<T>) => work(tx) } as unknown as DirectDatabase,
    locks,
    writes,
  };
}

describe("protected Task caller funding binding", () => {
  test("locks Task, Run, and Job before atomically binding model and opaque funding", async () => {
    const fixture = harness();
    expect(await bindProtectedTaskRunFunding(fixture.db, input())).toEqual({ status: "attached" });
    expect(fixture.locks).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "share" },
    ]);
    expect(fixture.writes).toEqual([{ modelId: "anthropic:claude-sonnet", fundingBinding }]);
    expect(JSON.stringify(fixture.writes)).not.toContain("apiKey");
  });

  test("adopts only the exact immutable replay", async () => {
    const exact = harness({ run: run({ modelId: "anthropic:claude-sonnet", fundingBinding }) });
    expect(await bindProtectedTaskRunFunding(exact.db, input())).toEqual({ status: "same" });
    expect(exact.writes).toEqual([]);

    for (const changed of [
      harness({ task: task({ fundingMode: "legacy_server" }) }),
      harness({ task: task({ cryptoMappingState: "stale" }) }),
      harness({ run: run({ modelId: "anthropic:other", fundingBinding }) }),
      harness({ run: run({ modelId: "anthropic:claude-sonnet", fundingBinding: { kind: "server", providerRoute: "anthropic" } }) }),
      harness({ run: run({ fundingPredecessorRunId: ids.run }) }),
      harness({ job: job({ status: "completed", completedAt: new Date() }) }),
    ]) {
      expect(await bindProtectedTaskRunFunding(changed.db, input())).toEqual({ status: "stale" });
      expect(changed.writes).toEqual([]);
    }
  });

  test("rejects malformed binding before opening the transaction", async () => {
    let transactions = 0;
    const db = { transaction: async () => { transactions += 1; } } as unknown as DirectDatabase;
    const malformed = { ...input(), fundingBinding: {
      ...fundingBinding,
      apiKey: "must-not-cross",
    } } as unknown as BindProtectedTaskRunFundingInput;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(bindProtectedTaskRunFunding(db, malformed)).rejects.toThrow("malformed");
    expect(transactions).toBe(0);

    const wrongKind = {
      ...input(),
      jobReference: { ...reference(), kind: "ordinary_task_run" },
    } as unknown as BindProtectedTaskRunFundingInput;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(bindProtectedTaskRunFunding(db, wrongKind)).rejects.toThrow("malformed");
    expect(transactions).toBe(0);
  });
});
