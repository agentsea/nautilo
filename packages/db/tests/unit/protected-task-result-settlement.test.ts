import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  settlePublishedProtectedTaskRunAuthorization,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import { encryptionTransitionPolicy } from
  "../../src/schema/encryption-transition";
import { jobs } from "../../src/schema/jobs";
import { protectedTaskRunOutputBindings } from
  "../../src/schema/protected-task-run-output-bindings";
import { taskDefinitionCryptoRevisions } from
  "../../src/schema/task-definition-crypto-revisions";
import { taskRunResultCryptoRevisions } from
  "../../src/schema/task-run-result-crypto-revisions";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  requestor: "40000000-0000-4000-8000-000000000004",
  requesterHuman: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
};
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId = `task-run-result:v1:${"b".repeat(64)}`;
const digest = new Uint8Array(32).fill(0x41);
const fingerprint = new Uint8Array(32).fill(0x52);
const acceptedAt = new Date("2026-10-08T08:00:00.000Z");
const completedAt = new Date("2026-10-08T08:01:00.000Z");
const cryptoCompletedAt = new Date("2026-10-08T08:00:59.000Z");
const jobFinishedAt = new Date("2026-10-08T08:01:01.000Z");

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 7,
    executionSegment: 1,
    ...overrides,
  };
}

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

function receipt(overrides: Record<string, unknown> = {}) {
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

type TaskRow = Readonly<{
  id: string;
  requestorId: string;
  /** Unselected current-definition fields model a later cron edit. */
  contentRepresentation?: string;
  contentNamespaceId?: string | null;
  cryptoObjectId?: string | null;
  cryptoRequiredNamespaceFingerprint?: Uint8Array | null;
}>;

type DefinitionRow = Readonly<{
  taskId: string;
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  representation: string;
  payloadVersion: number;
  cryptoAccessRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
  completion: string;
  disposition: string;
  failureCode: string | null;
}>;

type RunRow = Readonly<{
  id: string;
  taskId: string;
  jobId: string | null;
  status: string;
  completedAt: Date | null;
  resultRepresentation: string;
  resultContentNamespaceId: string | null;
  resultRevision: number;
  resultCryptoObjectId: string | null;
  resultCryptoAccessRevision: number;
  resultCryptoRequiredNamespaceFingerprint: Uint8Array | null;
  resultCryptoMappingState: string;
  resultTextIsNull: boolean;
  lastErrorIsNull: boolean;
}>;

type JobRow = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  type: string;
  status: string;
  input: unknown;
  terminalReceipt: unknown;
  resultIsNull: boolean;
  messageIsNull: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
}>;

type BindingRow = Readonly<{
  taskRunId: string;
  bindingId: string;
  deliveryMode: string;
  resultOperationId: string;
  resultObjectId: string;
  acceptedPolicyRevision: number;
  acceptedAt: Date;
  resultTerminalAt: Date | null;
  resultAttachedAt: Date | null;
  completedAt: Date | null;
}>;

type RevisionRow = Readonly<{
  taskId: string;
  taskRunId: string;
  contentNamespaceId: string;
  resultRevision: number;
  operationId: string;
  requestDigest: Uint8Array;
  requesterHumanId: string;
  anchorNamespaceId: string;
  cryptoObjectId: string;
  representation: string;
  payloadVersion: number;
  cryptoAccessRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
  completion: string;
  disposition: string;
  failureCode: string | null;
  cryptoCompletedAt: Date | null;
}>;

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: ids.task,
    requestorId: ids.requestor,
    ...overrides,
  };
}

function definition(overrides: Partial<DefinitionRow> = {}): DefinitionRow {
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
  };
}

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    status: "completed",
    completedAt,
    resultRepresentation: "protected",
    resultContentNamespaceId: ids.namespace,
    resultRevision: 1,
    resultCryptoObjectId: resultObjectId,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: fingerprint,
    resultCryptoMappingState: "verified",
    resultTextIsNull: true,
    lastErrorIsNull: true,
    ...overrides,
  };
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: ids.job,
    ownerId: ids.requestor,
    requestorId: ids.requestor,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "running",
    input: reference(),
    terminalReceipt: receipt(),
    resultIsNull: true,
    messageIsNull: true,
    startedAt: new Date("2026-10-08T07:59:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

function binding(overrides: Partial<BindingRow> = {}): BindingRow {
  return {
    taskRunId: ids.run,
    bindingId: `task-run-output:${ids.run}`,
    deliveryMode: "none",
    resultOperationId: `task-run-result:${ids.run}`,
    resultObjectId,
    acceptedPolicyRevision: 7,
    acceptedAt,
    resultTerminalAt: completedAt,
    resultAttachedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function revision(overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    contentNamespaceId: ids.namespace,
    resultRevision: 1,
    operationId: `task-run-result:${ids.run}`,
    requestDigest: digest,
    requesterHumanId: ids.requesterHuman,
    anchorNamespaceId: ids.namespace,
    cryptoObjectId: resultObjectId,
    representation: "protected",
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: fingerprint,
    completion: "complete",
    disposition: "mapped",
    failureCode: null,
    cryptoCompletedAt,
    ...overrides,
  };
}

type FixtureOptions = Readonly<{
  task?: TaskRow | undefined;
  run?: RunRow | undefined;
  job?: JobRow | undefined;
  binding?: BindingRow | undefined;
  revision?: RevisionRow | undefined;
  definition?: DefinitionRow | undefined;
  loseBindingUpdate?: boolean;
  loseJobUpdate?: boolean;
}>;

function fixture(options: FixtureOptions = {}) {
  const taskRow = Object.hasOwn(options, "task") ? options.task : task();
  const runRow = Object.hasOwn(options, "run") ? options.run : run();
  const jobRow = Object.hasOwn(options, "job") ? options.job : job();
  const bindingRow = Object.hasOwn(options, "binding")
    ? options.binding
    : binding();
  const revisionRow = Object.hasOwn(options, "revision")
    ? options.revision
    : revision();
  const definitionRow = Object.hasOwn(options, "definition")
    ? options.definition
    : definition();
  const locks: Array<Readonly<{ table: unknown; kind: string }>> = [];
  const projections: Array<Readonly<{
    table: unknown;
    keys: readonly string[];
  }>> = [];
  const writes: Array<Readonly<{
    table: unknown;
    patch: Readonly<Record<string, unknown>>;
    where: SQL;
  }>> = [];

  const rows = (table: unknown): readonly unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) return jobRow ? [jobRow] : [];
    if (table === protectedTaskRunOutputBindings) {
      return bindingRow ? [bindingRow] : [];
    }
    if (table === taskRunResultCryptoRevisions) {
      return revisionRow ? [revisionRow] : [];
    }
    if (table === taskDefinitionCryptoRevisions) {
      return definitionRow ? [definitionRow] : [];
    }
    throw new Error("unexpected table");
  };
  const tx = {
    select: (projection: Record<string, unknown>) => ({
      from: (table: unknown) => {
        projections.push({ table, keys: Object.keys(projection) });
        const query = {
          where: (_where: SQL) => query,
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
        where: (where: SQL) => ({
          returning: async () => {
            writes.push({ table, patch, where });
            if (table === protectedTaskRunOutputBindings) {
              return options.loseBindingUpdate ? [] : [{ taskRunId: ids.run }];
            }
            if (table === jobs) {
              return options.loseJobUpdate ? [] : [{ id: ids.job }];
            }
            throw new Error("unexpected update table");
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(use: (value: typeof tx) => Promise<T>) => use(tx),
  } as unknown as DirectDatabase;
  return { db, locks, projections, writes };
}

async function settle(
  f: ReturnType<typeof fixture>,
  completeAuthorization: (
    proof: Readonly<{ contentNamespaceId: string; requesterHumanId: string }>,
  ) => Promise<boolean>,
  jobReference = reference(),
) {
  return settlePublishedProtectedTaskRunAuthorization(f.db, {
    jobId: ids.job,
    reference: jobReference,
  }, completeAuthorization);
}

describe("published protected Task result settlement", () => {
  test("holds exact metadata locks before authorization and attaches the mapped result", async () => {
    const f = fixture();
    const proofs: unknown[] = [];
    const result = await settle(f, async proof => {
      proofs.push(proof);
      expect(f.locks).toEqual([
        { table: tasks, kind: "update" },
        { table: taskRuns, kind: "update" },
        { table: jobs, kind: "update" },
        { table: protectedTaskRunOutputBindings, kind: "update" },
        { table: taskRunResultCryptoRevisions, kind: "update" },
        { table: taskDefinitionCryptoRevisions, kind: "share" },
      ]);
      expect(f.writes).toEqual([]);
      return true;
    });

    expect(result).toBe(true);
    expect(proofs).toEqual([{
      contentNamespaceId: ids.namespace,
      requesterHumanId: ids.requesterHuman,
    }]);
    expect(f.writes.map(write => ({ table: write.table, patch: write.patch })))
      .toEqual([
        {
          table: protectedTaskRunOutputBindings,
          patch: { resultAttachedAt: completedAt, completedAt },
        },
        {
          table: jobs,
          patch: { status: "completed", completedAt: expect.any(Date) },
        },
      ]);
    for (const projection of f.projections) {
      expect(projection.keys).not.toContain("prompt");
      expect(projection.keys).not.toContain("expectedOutput");
      expect(projection.keys).not.toContain("resultText");
      expect(projection.keys).not.toContain("lastError");
      expect(projection.keys).not.toContain("result");
      expect(projection.keys).not.toContain("message");
      expect(projection.keys).not.toContain("metadata");
    }
  });

  test("corrects a proof-only failed Job without replacing its completion time", async () => {
    const f = fixture({
      binding: binding({ resultAttachedAt: completedAt, completedAt }),
      job: job({ status: "failed", completedAt: jobFinishedAt }),
    });
    expect(await settle(f, async () => true)).toBe(true);
    expect(f.writes.map(write => ({ table: write.table, patch: write.patch })))
      .toEqual([{ table: jobs, patch: { status: "completed" } }]);
  });

  test("accepts an exact completed Job replay and still adopts authorization success", async () => {
    const f = fixture({
      binding: binding({ resultAttachedAt: completedAt, completedAt }),
      job: job({ status: "completed", completedAt: jobFinishedAt }),
    });
    let callbacks = 0;
    expect(await settle(f, async () => {
      callbacks += 1;
      return true;
    })).toBe(true);
    expect(callbacks).toBe(1);
    expect(f.writes).toEqual([]);
  });

  test("completes an already-attached no-delivery binding after grant adoption", async () => {
    const f = fixture({
      binding: binding({ resultAttachedAt: completedAt, completedAt: null }),
      job: job({ status: "completed", completedAt: jobFinishedAt }),
    });
    expect(await settle(f, async () => true)).toBe(true);
    expect(f.writes.map(write => ({ table: write.table, patch: write.patch })))
      .toEqual([{
        table: protectedTaskRunOutputBindings,
        patch: { completedAt },
      }]);
  });

  test("does not mutate product state when authorization rejects or throws", async () => {
    const rejected = fixture();
    expect(await settle(rejected, async () => false)).toBe(false);
    expect(rejected.writes).toEqual([]);

    const failed = fixture();
    const error = new Error("authorization unavailable");
    expect(settle(failed, async () => { throw error; })).rejects.toBe(error);
    expect(failed.writes).toEqual([]);
  });

  test("rejects queued, cancelled, timed out, and malformed terminal times before callback", async () => {
    for (const candidate of [
      job({ status: "queued", startedAt: null }),
      job({ status: "cancelled", completedAt: jobFinishedAt }),
      job({ status: "timed_out", completedAt: jobFinishedAt }),
      job({
        status: "failed",
        startedAt: jobFinishedAt,
        completedAt: acceptedAt,
      }),
    ]) {
      const f = fixture({ job: candidate });
      let callbacks = 0;
      expect(await settle(f, async () => {
        callbacks += 1;
        return true;
      })).toBe(false);
      expect(callbacks).toBe(0);
      expect(f.writes).toEqual([]);
    }
  });

  test("rejects receipt, mapping, namespace, operation, object, and policy mismatches", async () => {
    const cases: FixtureOptions[] = [
      { job: job({ terminalReceipt: receipt({ requestDigest: "00".repeat(32) }) }) },
      { run: run({ resultCryptoMappingState: "unmapped" }) },
      { revision: revision({ disposition: "active" }) },
      { revision: revision({ completion: "pending", cryptoCompletedAt: null }) },
      { revision: revision({ contentNamespaceId: ids.requestor }) },
      { revision: revision({ operationId: "task-run-result:other" }) },
      { definition: definition({ cryptoObjectId: `${definitionObjectId}:other` }) },
      { definition: definition({ contentNamespaceId: ids.requestor }) },
      { run: run({ jobId: ids.requestor }) },
      { job: job({ requestorId: ids.requesterHuman }) },
      { job: job({ resultIsNull: false }) },
      { job: job({ input: reference({ authorizationRequestId: "other" }) }) },
      { binding: binding({ resultObjectId: `${resultObjectId}:other` }) },
      { binding: binding({ acceptedPolicyRevision: 8 }) },
      { binding: binding({ resultTerminalAt: jobFinishedAt }) },
    ];
    for (const options of cases) {
      const f = fixture(options);
      let callbacks = 0;
      expect(await settle(f, async () => {
        callbacks += 1;
        return true;
      })).toBe(false);
      expect(callbacks).toBe(0);
      expect(f.writes).toEqual([]);
    }
  });

  test("accepts the historically bound policy without reading current policy", async () => {
    const f = fixture({
      binding: binding({
        deliveryMode: "raw",
        resultAttachedAt: null,
        completedAt: null,
      }),
    });
    expect(await settle(f, async () => true)).toBe(true);
    expect(f.locks.map(lock => lock.table)).not.toContain(
      encryptionTransitionPolicy,
    );
    expect(f.writes[0]?.patch).toEqual({ resultAttachedAt: completedAt });
  });

  test("settles a dual result from nullness metadata without reading ordinary text", async () => {
    const f = fixture({
      run: run({
        resultRepresentation: "dual",
        resultTextIsNull: false,
      }),
      job: job({ terminalReceipt: receipt({ resultRepresentation: "dual" }) }),
      revision: revision({ representation: "dual" }),
      definition: definition({ representation: "dual" }),
    });
    expect(await settle(f, async () => true)).toBe(true);
    const runProjection = f.projections.find(item => item.table === taskRuns);
    expect(runProjection?.keys).toContain("resultTextIsNull");
    expect(runProjection?.keys).not.toContain("resultText");
  });

  test("settles an old cron Run after the pending Task definition advances", async () => {
    const f = fixture({
      task: task({
        contentRepresentation: "dual",
        contentNamespaceId: ids.requestor,
        cryptoObjectId: `task-definition:v1:${"c".repeat(64)}`,
        cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x7f),
      }),
      binding: binding({ resultAttachedAt: completedAt, completedAt: null }),
      job: job({ status: "completed", completedAt: jobFinishedAt }),
    });
    expect(await settle(f, async () => true)).toBe(true);
    const taskProjection = f.projections.find(item => item.table === tasks);
    expect(taskProjection?.keys).toEqual(["id", "requestorId"]);
    expect(f.writes.map(write => write.patch)).toEqual([{ completedAt }]);
  });

  test("does not compare Task receipt time with the Job owner's clock", async () => {
    const resultTime = new Date("2042-05-06T07:08:09.000Z");
    const f = fixture({
      run: run({ completedAt: resultTime }),
      job: job({
        startedAt: new Date("2026-10-08T07:59:00.000Z"),
        terminalReceipt: receipt({ completedAt: resultTime.toISOString() }),
      }),
      binding: binding({ resultTerminalAt: resultTime }),
    });
    expect(await settle(f, async () => true)).toBe(true);
    const jobWrite = f.writes.find(write => write.table === jobs);
    expect(jobWrite?.patch["completedAt"]).toBeInstanceOf(Date);
    expect(jobWrite?.patch["completedAt"]).not.toEqual(resultTime);
  });

  test("rejects malformed references before opening a transaction", async () => {
    for (const candidate of [
      reference({ taskId: "not-a-task" }),
      reference({ inputObjectId: "task-definition:other" }),
      reference({ executionSegment: 2 }),
      { ...reference(), extra: "forbidden" },
    ]) {
      const f = fixture();
      expect(settle(
        f,
        async () => true,
        candidate as ProtectedTaskDurableJobReference,
      )).rejects.toBeInstanceOf(TypeError);
      expect(f.locks).toEqual([]);
      expect(f.writes).toEqual([]);
    }
  });

  test("surfaces a lost product CAS after exact authorization completion", async () => {
    const bindingLost = fixture({ loseBindingUpdate: true });
    expect(settle(bindingLost, async () => true)).rejects.toThrow(
      "lost its binding",
    );

    const jobLost = fixture({ loseJobUpdate: true });
    expect(settle(jobLost, async () => true)).rejects.toThrow("lost its Job");
  });
});
