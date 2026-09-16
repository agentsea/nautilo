import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  persistJobWithDatabase,
  updateJobStatusWithDatabase,
} from "../../src/queries/jobs";

function fixture(mode = "encrypted_only", revision = 7) {
  const calls: string[] = [];
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
    update: () => ({ set: () => ({ where: async () => {
      calls.push("job-update");
    } }) }),
  };
  const database = {
    ...tx,
    transaction: async (run: (value: typeof tx) => Promise<unknown>) => {
      calls.push("transaction"); return run(tx);
    },
  } as unknown as DirectDatabase;
  return { database, calls };
}

const policy = { expectedRevision: 7, representation: "protected_only" } as const;

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
});
