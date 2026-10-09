import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  persistJobWithDatabase,
  startProtectedTaskJobWithDatabase,
  updateJobStatusWithDatabase,
} from "../../src/queries/jobs";

function fixture(
  mode = "encrypted_only",
  revision = 7,
  startRows: readonly Readonly<{ id: string }>[] = [{ id: "job-1" }],
) {
  const calls: string[] = [];
  let jobUpdateWhere: SQL | undefined;
  const tx = {
    execute: async () => { calls.push("policy-lock"); return []; },
    select: () => ({
      from: () => ({ where: async () => {
        calls.push("policy-read");
        return [{ mode, revision }];
      } }),
    }),
    insert: () => ({ values: () => ({ returning: async () => {
      calls.push("job-insert"); return [{ id: "job-1" }];
    } }) }),
    update: () => ({ set: () => ({ where: (predicate: SQL) => {
      calls.push("job-update");
      jobUpdateWhere = predicate;
      return { returning: async () => startRows };
    } }) }),
  };
  const database = {
    ...tx,
    transaction: async (run: (value: typeof tx) => Promise<unknown>) => {
      calls.push("transaction"); return run(tx);
    },
  } as unknown as DirectDatabase;
  return { database, calls, get jobUpdateWhere() { return jobUpdateWhere; } };
}

const policy = { expectedRevision: 7, representation: "protected_only" } as const;
const protectedTaskReference = {
  kind: "protected_task_run_v1",
  taskId: "10000000-0000-4000-8000-000000000001",
  taskRunId: "20000000-0000-4000-8000-000000000002",
  inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
  resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
  authorizationRequestId: "task-run-authorization:request-1",
  policyRevision: 7,
  executionSegment: 1,
} as const;

describe("Job publication fence", () => {
  test("ordinary insert gates current policy before inserting", async () => {
    const { database, calls } = fixture("shadow_encryption");
    await persistJobWithDatabase(database, {
      ownerId: "owner", requestorId: "requestor", laneKey: null,
      type: "foreground", input: { message: "ordinary" },
    });
    expect(calls).toEqual([
      "transaction", "policy-lock", "policy-read", "job-insert",
    ]);
    const full = fixture();
    const insertRejection = await persistJobWithDatabase(full.database, {
      ownerId: "owner", requestorId: "requestor", laneKey: null,
      type: "foreground", input: { message: "ordinary" },
    }).then(() => undefined, (error: unknown) => error);
    expect((insertRejection as Error).message).toContain("ordinary_forbidden");
    expect(full.calls).not.toContain("job-insert");
  });

  test("ordinary content-bearing status gates policy; structural status stays permissible", async () => {
    const ordinary = fixture("plaintext_only");
    await updateJobStatusWithDatabase(
      ordinary.database, "job-1", "failed", { message: "ordinary" },
    );
    expect(ordinary.calls).toEqual([
      "transaction", "policy-lock", "policy-read", "job-update",
    ]);
    const full = fixture();
    const updateRejection = await updateJobStatusWithDatabase(
      full.database, "job-1", "failed", { message: "ordinary" },
    ).then(() => undefined, (error: unknown) => error);
    expect((updateRejection as Error).message).toContain("ordinary_forbidden");
    expect(full.calls).not.toContain("job-update");
    const structural = fixture();
    await updateJobStatusWithDatabase(
      structural.database, "job-1", "running",
    );
    expect(structural.calls).toEqual(["job-update"]);
  });

  test("Full insert locks and reads policy before inserting", async () => {
    const { database, calls } = fixture();
    await persistJobWithDatabase(database, {
      ownerId: "owner", requestorId: "requestor", laneKey: null,
      roomId: "20000000-0000-4000-8000-000000000318",
      type: "foreground",
      input: {
        kind: "full_encryption_foreground_operation_v1",
        operationId: "operation", policyRevision: 7,
        sessionId: "10000000-0000-4000-8000-000000000318",
        roomId: "20000000-0000-4000-8000-000000000318",
      },
      publicationPolicy: policy,
    });
    expect(calls).toEqual([
      "transaction", "policy-lock", "policy-read", "job-insert",
    ]);
  });

  test("Full status locks and reads policy before updating", async () => {
    const { database, calls } = fixture();
    await updateJobStatusWithDatabase(
      database, "job-1", "completed", undefined, policy,
    );
    expect(calls).toEqual([
      "transaction", "policy-lock", "policy-read", "job-update",
    ]);
  });

  test("Full status rejects ordinary message/result before opening a transaction", async () => {
    for (const fields of [{ message: "secret" }, { result: { secret: true } }]) {
      const { database, calls } = fixture();
      const rejection = await updateJobStatusWithDatabase(
        database, "job-1", "failed", fields, policy,
      ).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(TypeError);
      expect((rejection as Error).message).toContain("forbids ordinary fields");
      expect(calls).toEqual([]);
    }
  });

  test("protected Task start fences and claims only one queued durable Job", async () => {
    const started = fixture();
    expect(await startProtectedTaskJobWithDatabase(
      started.database,
      "job-1",
      protectedTaskReference,
      policy,
    )).toBe("started");
    expect(started.calls).toEqual([
      "transaction", "policy-lock", "policy-read", "job-update",
    ]);
    const predicate = new PgDialect().sqlToQuery(started.jobUpdateWhere!);
    expect(predicate.sql).toBe(
      "(\"jobs\".\"id\" = $1 and \"jobs\".\"status\" = $2 and "
      + "\"jobs\".\"started_at\" is null and \"jobs\".\"completed_at\" is null "
      + "and \"jobs\".\"input\" = $3)",
    );
    expect(predicate.params).toEqual([
      "job-1",
      "queued",
      JSON.stringify(protectedTaskReference),
    ]);

    const rejected = fixture("encrypted_only", 7, []);
    expect(await startProtectedTaskJobWithDatabase(
      rejected.database,
      "job-1",
      protectedTaskReference,
      policy,
    )).toBe("rejected");
    expect(rejected.calls).toEqual([
      "transaction", "policy-lock", "policy-read", "job-update",
    ]);
  });

  test("protected Task start rejects mismatched identity before mutation", async () => {
    for (const [jobId, reference, candidatePolicy] of [
      ["", protectedTaskReference, policy],
      ["job-1", { ...protectedTaskReference, kind: "other" }, policy],
      [
        "job-1",
        protectedTaskReference,
        { expectedRevision: 8, representation: "protected_only" },
      ],
    ] as const) {
      const { database, calls } = fixture();
      const error = await startProtectedTaskJobWithDatabase(
        database,
        jobId,
        reference as typeof protectedTaskReference,
        candidatePolicy,
      ).then(
        () => undefined,
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain("start authority is invalid");
      expect(calls).toEqual([]);
    }
  });
});
