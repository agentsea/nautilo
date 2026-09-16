import { describe, expect, test } from "bun:test";
import type {
  DirectDatabase,
  WorkspaceDocumentMutationOutboxRow,
  WorkspaceDocumentMutationTx,
} from "@nautilo/db";
import { deriveAtomicDocumentMutationBatchIdempotencyKey } from "@nautilo/document-mutations";
import {
  WorkspaceDocumentMutationOutboxRunner,
  workspaceOutboxRowsToAtomicBatch,
} from "../../src/document-mutations/workspace-document-mutation-outbox";

const operationId = "op-1";
const revisionGroupId = "group-1";
const artifactId = "11111111-1111-4111-8111-111111111111";
const batchKey = deriveAtomicDocumentMutationBatchIdempotencyKey(
  operationId,
  revisionGroupId,
);

function event(sequence: number) {
  const logicalPath = `note-${sequence}.md`;
  const identity = {
    kind: "workspace_artifact" as const,
    artifactId,
    logicalPath,
  };
  return {
    type: "document.mutation.committed" as const,
    operationId,
    revisionGroupId,
    sequence,
    outcome: "applied" as const,
    actor: { kind: "human" as const, humanId: "human-1" },
    mutation: "update" as const,
    path: { kind: "update" as const, before: identity, after: identity },
    before: {
      identity,
      backendVersion: { kind: "artifact_revision" as const, revision: sequence + 3 },
      sha256: "a".repeat(64),
    },
    after: {
      identity,
      backendVersion: { kind: "artifact_revision" as const, revision: sequence + 4 },
      sha256: "b".repeat(64),
    },
  };
}

function rows(count = 2): readonly WorkspaceDocumentMutationOutboxRow[] {
  return Array.from({ length: count }, (_, sequence) => ({
    id: `11111111-1111-4111-8111-${String(sequence + 10).padStart(12, "0")}`,
    mutationId: artifactId,
    sequence,
    batchIdempotencyKey: batchKey,
    eventType: "document.mutation.committed",
    payload: event(sequence),
    dispatchState: "claimed",
    claimedBy: "worker",
    claimedAt: new Date(0),
    dispatchedAt: null,
    dispatchAttempts: 1,
    nextAttemptAt: new Date(0),
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })) as unknown as readonly WorkspaceDocumentMutationOutboxRow[];
}

function fakeDb(): DirectDatabase {
  return {
    transaction: async (callback: (tx: WorkspaceDocumentMutationTx) => unknown) =>
      callback({} as WorkspaceDocumentMutationTx),
  } as unknown as DirectDatabase;
}

describe("WorkspaceDocumentMutationOutboxRunner", () => {
  test("validates and preserves one complete ordered multi-event batch", () => {
    expect(workspaceOutboxRowsToAtomicBatch(rows())).toEqual({
      operationId,
      revisionGroupId,
      idempotencyKey: batchKey,
      events: [event(0), event(1)],
    });
    expect(() => workspaceOutboxRowsToAtomicBatch([rows()[1]!, rows()[0]!]))
      .toThrow("complete, ordered, and contiguous");
  });

  test("publishes and finalizes every row in the exact claimed batch", async () => {
    const published: number[][] = [];
    const finalized: string[] = [];
    const runner = new WorkspaceDocumentMutationOutboxRunner({
      db: fakeDb(),
      workerId: "worker",
      now: () => new Date(100),
      publisher: {
        publishAtomic: async (batch) => {
          published.push(batch.events.map((item) => item.sequence));
          return { kind: "published" };
        },
      },
      helpers: {
        claim: async () => rows(),
        markDispatched: async (_tx, input) => {
          finalized.push(input.batchIdempotencyKey);
          return 2;
        },
      },
    });
    expect(await runner.runOnce()).toEqual({
      kind: "dispatched",
      batchIdempotencyKey: batchKey,
      count: 2,
    });
    expect(published).toEqual([[0, 1]]);
    expect(finalized).toEqual([batchKey]);
  });

  test("schedules the whole batch for retry on every unconfirmed publication result", async () => {
    for (const publication of ["not_published", "unknown", "throw"] as const) {
      const failed: Array<{ key: string; next: number }> = [];
      const runner = new WorkspaceDocumentMutationOutboxRunner({
        db: fakeDb(),
        workerId: "worker",
        now: () => new Date(100),
        publisher: {
          publishAtomic: async () => {
            if (publication === "throw") throw new Error("transport");
            return { kind: publication };
          },
        },
        helpers: {
          claim: async () => rows(),
          markFailed: async (_tx, input) => {
            failed.push({
              key: input.batchIdempotencyKey,
              next: input.nextAttemptAt.getTime(),
            });
            return 2;
          },
        },
      });
      expect(await runner.runOnce()).toEqual({
        kind: "retry_scheduled",
        batchIdempotencyKey: batchKey,
        count: 2,
      });
      expect(failed).toEqual([{ key: batchKey, next: 1_100 }]);
    }
  });

  test("clamps past, immediate, and invalid custom retry dates to the one-second floor", async () => {
    for (const proposed of [
      new Date(0),
      new Date(100),
      new Date(Number.NaN),
    ]) {
      let persisted = Number.NaN;
      const runner = new WorkspaceDocumentMutationOutboxRunner({
        db: fakeDb(),
        workerId: "worker",
        now: () => new Date(100),
        nextAttemptAt: () => proposed,
        publisher: { publishAtomic: async () => ({ kind: "unknown" }) },
        helpers: {
          claim: async () => rows(),
          markFailed: async (_tx, input) => {
            persisted = input.nextAttemptAt.getTime();
            return 2;
          },
        },
      });
      await runner.runOnce();
      expect(persisted).toBe(1_100);
    }
  });

  test("reports publication truth when durable finalization is unknown", async () => {
    for (const finalization of ["short", "throw"] as const) {
      const runner = new WorkspaceDocumentMutationOutboxRunner({
        db: fakeDb(),
        workerId: "worker",
        publisher: { publishAtomic: async () => ({ kind: "published" }) },
        helpers: {
          claim: async () => rows(),
          markDispatched: async () => {
            if (finalization === "throw") throw new Error("DB unavailable");
            return 1;
          },
        },
      });
      expect(await runner.runOnce()).toEqual({
        kind: "published_finalization_unknown",
        batchIdempotencyKey: batchKey,
      });
    }
  });

  test("never publishes a malformed durable batch and releases it whole", async () => {
    let publishes = 0;
    let failed = 0;
    const malformed = rows().map((row, index) =>
      index === 1 ? { ...row, sequence: 7 } : row) as readonly WorkspaceDocumentMutationOutboxRow[];
    const runner = new WorkspaceDocumentMutationOutboxRunner({
      db: fakeDb(),
      workerId: "worker",
      publisher: {
        publishAtomic: async () => {
          publishes += 1;
          return { kind: "published" };
        },
      },
      helpers: {
        claim: async () => malformed,
        markFailed: async () => {
          failed += 1;
          return 2;
        },
      },
    });
    expect(await runner.runOnce()).toEqual({
      kind: "invalid_batch_released",
      batchIdempotencyKey: batchKey,
    });
    expect(publishes).toBe(0);
    expect(failed).toBe(1);
  });

  test("discovers and releases every stale batch after restart with no known-key input", async () => {
    const released: string[] = [];
    let listedCutoff = Number.NaN;
    const runner = new WorkspaceDocumentMutationOutboxRunner({
      db: fakeDb(),
      workerId: "worker",
      now: () => new Date(500),
      publisher: { publishAtomic: async () => ({ kind: "published" }) },
      helpers: {
        listStaleBatchKeys: async (_tx, cutoff) => {
          listedCutoff = cutoff.getTime();
          return ["batch-a", "batch-b"];
        },
        releaseStale: async (_tx, input) => {
          released.push(input.batchIdempotencyKey);
          return input.batchIdempotencyKey === "batch-a" ? 2 : 3;
        },
      },
    });
    expect(await runner.recoverAllStaleClaims(new Date(250))).toBe(5);
    expect(listedCutoff).toBe(250);
    expect(released).toEqual(["batch-a", "batch-b"]);
  });

  test("does not hide a database failure during restart recovery", async () => {
    const runner = new WorkspaceDocumentMutationOutboxRunner({
      db: fakeDb(),
      workerId: "worker",
      publisher: { publishAtomic: async () => ({ kind: "published" }) },
      helpers: {
        listStaleBatchKeys: async () => ["batch-a"],
        releaseStale: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    expect(runner.recoverAllStaleClaims(new Date(250)))
      .rejects.toThrow("database unavailable");
  });
});
