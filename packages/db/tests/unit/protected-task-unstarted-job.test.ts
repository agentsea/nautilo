import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DirectDatabase } from "../../src/config/direct-database";
import { cancelUnstartedProtectedTaskJobWithDatabase } from "../../src/queries/jobs";

const reference = {
  kind: "protected_task_run_v1", taskId: "task", taskRunId: "run",
  inputObjectId: "input", resultObjectId: "result", authorizationRequestId: "request",
  policyRevision: 7, executionSegment: 1,
} as const;
function fixture(updated: boolean, replay: boolean) {
  const calls: string[] = [];
  const predicates: SQL[] = [];
  const tx = {
    execute: async () => { calls.push("policy-lock"); },
    select: () => ({ from: () => ({ where: (where: SQL) => {
      predicates.push(where);
      if (calls.includes("cancel")) {
        calls.push("replay");
        return { limit: async () => replay ? [{ id: "job" }] : [] };
      }
      calls.push("policy-read");
      return Promise.resolve([{ mode: "plaintext_only", shadowBehavior: "fallback", revision: 9 }]);
    } }) }),
    update: () => ({ set: (values: unknown) => ({ where: (where: SQL) => {
      calls.push("cancel"); predicates.push(where);
      expect(values).toHaveProperty("status", "cancelled");
      expect((values as { completedAt: unknown }).completedAt).toBeInstanceOf(Date);
      return { returning: async () => updated ? [{ id: "job" }] : [] };
    } }) }),
  };
  const database = { transaction: async (use: (t: typeof tx) => unknown) => use(tx) } as unknown as DirectDatabase;
  return { database, calls, predicates };
}

describe("protected unstarted Job cancellation", () => {
  test("cleans up after a policy change without overwriting a started or content-bearing Job", async () => {
    const f = fixture(true, false);
    expect(await cancelUnstartedProtectedTaskJobWithDatabase(f.database, "job", reference)).toBe("cancelled");
    expect(f.calls).toEqual(["policy-lock", "policy-read", "cancel"]);
    const query = new PgDialect().sqlToQuery(f.predicates[1]!);
    for (const field of ["started_at", "result", "message", "completed_at"]) {
      expect(query.sql).toContain(`"jobs"."${field}" is null`);
    }
    expect(query.params).toEqual(["job", JSON.stringify(reference), "queued"]);
  });
  test("only accepts a cancelled, completed, unstarted exact replay", async () => {
    const f = fixture(false, true);
    expect(await cancelUnstartedProtectedTaskJobWithDatabase(f.database, "job", reference)).toBe("exact_replay");
    const query = new PgDialect().sqlToQuery(f.predicates[2]!);
    expect(query.params).toEqual(["job", JSON.stringify(reference), "cancelled"]);
    expect(query.sql).toContain('"jobs"."started_at" is null');
    expect(query.sql).toContain('"jobs"."completed_at" is not null');
    expect(query.sql).toContain('"jobs"."result" is null');
    expect(query.sql).toContain('"jobs"."message" is null');
    const rejected = fixture(false, false);
    expect(await cancelUnstartedProtectedTaskJobWithDatabase(rejected.database, "job", reference)).toBe("ineligible");
  });
  test("rejects continuation recovery before taking any lock", async () => {
    const f = fixture(true, false);
    const error = await cancelUnstartedProtectedTaskJobWithDatabase(f.database, "job", {
      ...reference, executionSegment: 2, resumeAcceptanceId: "resume",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(f.calls).toEqual([]);
  });
});
