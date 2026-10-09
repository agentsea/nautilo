import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  settleProtectedTaskJobTerminalWithDatabase,
  type ProtectedTaskJobTerminalRequest,
} from "../../src/queries/jobs";
import { jobs } from "../../src/schema/jobs";

const reference = {
  kind: "protected_task_run_v1",
  taskId: "10000000-0000-4000-8000-000000000001",
  taskRunId: "20000000-0000-4000-8000-000000000002",
  inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
  resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
  authorizationRequestId: "task-run-authorization:terminal-test",
  policyRevision: 7,
  executionSegment: 1,
} as const;
const policy = {
  expectedRevision: 7,
  representation: "protected_only",
} as const;

type ExistingRow = Readonly<{
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
}>;

function fixture(options: Readonly<{
  transition?: boolean;
  existing?: ExistingRow;
  policyMode?: string;
  policyRevision?: number;
}> = {}) {
  const calls: string[] = [];
  const updates: Array<Readonly<{ values: Record<string, unknown>; where: SQL }>> = [];
  const reads: SQL[] = [];
  const tx = {
    execute: async () => {
      calls.push("policy-lock");
      return [];
    },
    select: () => ({
      from: (table: unknown) => ({
        where: (where: SQL) => {
          if (table === jobs) {
            calls.push("terminal-read");
            reads.push(where);
            return {
              limit: async () => options.existing === undefined
                ? []
                : [options.existing],
            };
          }
          calls.push("policy-read");
          return Promise.resolve([{
            mode: options.policyMode ?? "encrypted_only",
            revision: options.policyRevision ?? 7,
          }]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            calls.push("terminal-update");
            updates.push({ values, where });
            return options.transition === true ? [{ id: "job-1" }] : [];
          },
        }),
      }),
    }),
  };
  const database = {
    transaction: async (use: (value: typeof tx) => Promise<unknown>) => {
      calls.push("transaction");
      return use(tx);
    },
  } as unknown as DirectDatabase;
  return { database, calls, updates, reads };
}

function render(value: SQL) {
  return new PgDialect().sqlToQuery(value);
}

describe("protected Task Job terminal CAS", () => {
  test("completes only an exact content-free running Job", async () => {
    const f = fixture({ transition: true });
    expect(await settleProtectedTaskJobTerminalWithDatabase(
      f.database, "job-1", reference, "completed", policy,
    )).toEqual({ kind: "transitioned", status: "completed" });
    expect(f.calls).toEqual([
      "transaction", "policy-lock", "policy-read", "terminal-update",
    ]);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]!.values).toEqual({
      status: "completed",
      completedAt: expect.any(Date),
    });
    expect(f.updates[0]!.values).not.toHaveProperty("message");
    expect(f.updates[0]!.values).not.toHaveProperty("result");
    const predicate = render(f.updates[0]!.where);
    for (const fragment of [
      '"jobs"."id" =',
      '"jobs"."input" =',
      '"jobs"."lane_key" =',
      '"jobs"."type" =',
      '"jobs"."result" is null',
      '"jobs"."message" is null',
      '"jobs"."completed_at" is null',
      '"jobs"."status" =',
      '"jobs"."started_at" is not null',
    ]) expect(predicate.sql).toContain(fragment);
    expect(predicate.params).toEqual([
      "job-1",
      JSON.stringify(reference),
      `task:${reference.taskId}`,
      "foreground",
      "running",
    ]);
  });

  test("failed and cancelled accept only lifecycle-real queued or running predecessors", async () => {
    for (const requested of ["failed", "cancelled"] as const) {
      const f = fixture({ transition: true });
      expect(await settleProtectedTaskJobTerminalWithDatabase(
        f.database, "job-1", reference, requested, policy,
      )).toEqual({ kind: "transitioned", status: requested });
      const predicate = render(f.updates[0]!.where);
      expect(predicate.sql).toContain(
        '(("jobs"."status" = $5 and "jobs"."started_at" is null) or '
        + '("jobs"."status" = $6 and "jobs"."started_at" is not null))',
      );
      expect(predicate.params.slice(-2)).toEqual(["queued", "running"]);
    }
  });

  test("returns the exact lifecycle-valid terminal status after a lost response or conflict", async () => {
    const started = new Date("2026-10-08T08:00:00.000Z");
    const completed = new Date("2026-10-08T08:01:00.000Z");
    for (const [requested, existing] of [
      ["completed", { status: "completed", startedAt: started, completedAt: completed }],
      ["failed", { status: "completed", startedAt: started, completedAt: completed }],
      ["cancelled", { status: "failed", startedAt: null, completedAt: completed }],
      ["completed", { status: "cancelled", startedAt: null, completedAt: completed }],
      ["failed", { status: "timed_out", startedAt: started, completedAt: completed }],
    ] as const satisfies readonly (readonly [ProtectedTaskJobTerminalRequest, ExistingRow])[]) {
      const f = fixture({ existing });
      expect(await settleProtectedTaskJobTerminalWithDatabase(
        f.database, "job-1", reference, requested, policy,
      )).toEqual({ kind: "existing_terminal", status: existing.status });
      expect(f.calls).toEqual([
        "transaction", "policy-lock", "policy-read", "terminal-update",
        "terminal-read",
      ]);
      const predicate = render(f.reads[0]!);
      expect(predicate.sql).toContain('"jobs"."result" is null');
      expect(predicate.sql).toContain('"jobs"."message" is null');
      expect(predicate.sql).toContain('"jobs"."completed_at" is not null');
      expect(predicate.params.slice(0, 4)).toEqual([
        "job-1", JSON.stringify(reference), `task:${reference.taskId}`,
        "foreground",
      ]);
    }
  });

  test("rejects missing, substituted, content-bearing, and malformed terminal rows", async () => {
    for (const existing of [
      undefined,
      { status: "completed", startedAt: null, completedAt: new Date() },
      { status: "completed", startedAt: new Date(), completedAt: null },
      { status: "running", startedAt: new Date(), completedAt: null },
    ] as const) {
      const f = fixture({ ...(existing === undefined ? {} : { existing }) });
      expect(await settleProtectedTaskJobTerminalWithDatabase(
        f.database, "job-1", reference, "failed", policy,
      )).toEqual({ kind: "rejected" });
    }
    const f = fixture();
    await settleProtectedTaskJobTerminalWithDatabase(
      f.database, "job-1", reference, "failed", policy,
    );
    const exactRead = render(f.reads[0]!);
    expect(exactRead.params).toContain(JSON.stringify(reference));
    expect(exactRead.sql).toContain('"jobs"."result" is null');
    expect(exactRead.sql).toContain('"jobs"."message" is null');
  });

  test("rejects invalid authority before mutation", async () => {
    for (const [jobId, expected, requested, candidatePolicy] of [
      ["", reference, "completed", policy],
      ["job-1", { ...reference, kind: "other" }, "completed", policy],
      ["job-1", reference, "timed_out", policy],
      ["job-1", reference, "completed", {
        expectedRevision: 8, representation: "protected_only",
      }],
    ] as const) {
      const f = fixture({ transition: true });
      const failure = await settleProtectedTaskJobTerminalWithDatabase(
        f.database,
        jobId,
        expected as typeof reference,
        requested as ProtectedTaskJobTerminalRequest,
        candidatePolicy,
      ).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(f.calls).toEqual([]);
    }
  });

  test("policy rejection rolls back before the terminal CAS", async () => {
    const stale = fixture({ transition: true, policyRevision: 8 });
    const staleFailure = await settleProtectedTaskJobTerminalWithDatabase(
      stale.database, "job-1", reference, "completed", policy,
    ).then(() => null, (error: unknown) => error);
    expect(staleFailure).toBeInstanceOf(Error);
    expect(stale.calls).toEqual(["transaction", "policy-lock", "policy-read"]);

    const ordinary = fixture({ transition: true, policyMode: "plaintext_only" });
    const modeFailure = await settleProtectedTaskJobTerminalWithDatabase(
      ordinary.database, "job-1", reference, "completed", policy,
    ).then(() => null, (error: unknown) => error);
    expect(modeFailure).toBeInstanceOf(Error);
    expect(ordinary.calls).toEqual(["transaction", "policy-lock", "policy-read"]);
  });
});
