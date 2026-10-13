import { describe, expect, test } from "bun:test";
import { MemoryProviderOutcomeUnknownError } from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";

import { createStenographerMemoryFunding } from "../../src/lib/stenographer-memory-funding";
import { runWithProtectedMemoryEvidence } from "../../src/lib/protected-memory-model-evidence";

const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const BATCH = "30000000-0000-4000-8000-000000000001";
const LEASE = "40000000-0000-4000-8000-000000000001";

function database(replayRows: readonly Record<string, unknown>[]) {
  const results: unknown[][] = [
    [{ roomId: ROOM }],
    [{ roomId: ROOM, accepted: null, acceptedPlan: null }],
    [{ accepted: null }],
    [{ roomId: ROOM }],
    [...replayRows],
  ];
  const updates: Record<string, unknown>[] = [];
  const select = () => {
    const rows = results.shift() ?? [];
    const query = {
      from() { return this; },
      where() { return this; },
      for() { return this; },
      limit: () => Promise.resolve(rows),
    };
    return query;
  };
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push(values);
        return [];
      },
    }),
  });
  const db = {
    select,
    update,
    transaction: async <T>(run: (tx: { select: typeof select; update: typeof update }) => Promise<T>) =>
      run({ select, update }),
  } as unknown as DirectDatabase;
  return { db, updates, remaining: () => results.length };
}

function funding(db: DirectDatabase) {
  return createStenographerMemoryFunding({
    db,
    ports: {
      readRecord: () => Promise.resolve(null),
      readSource: () => Promise.resolve(null),
      readAudience: () => Promise.resolve(null),
    },
    budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    commitmentKey: new Uint8Array(32).fill(7),
    resolveServiceModel: () => "service:model",
    assertAvailable: () => Promise.resolve(),
  });
}

const protectedEvidence = {
  readRecord: () => Promise.resolve(null),
  readSource: () => Promise.resolve(null),
  readAudience: () => Promise.resolve(null),
};

describe("protected Stenographer Memory funding", () => {
  test("admits a durable binding when the exact operation has no wire evidence", async () => {
    const state = database([]);
    const admitted = await runWithProtectedMemoryEvidence(
      protectedEvidence,
      () => funding(state.db).admitProtectedExtractionModel({
        kind: "extraction",
        sourceBatchId: BATCH,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        leaseToken: LEASE,
      }, () => Promise.resolve(undefined)),
    );

    expect(admitted.modelId).toBe("service:model");
    expect(state.updates).toHaveLength(1);
    expect(state.remaining()).toBe(0);
  });

  test("quarantines an exact protected operation with prior wire evidence", async () => {
    const state = database([{
      id: "attempt-1",
      attemptOutcome: "succeeded",
      failureCode: null,
      metadata: { operationId: BATCH },
    }]);
    const result = await runWithProtectedMemoryEvidence(
      protectedEvidence,
      () => funding(state.db).admitProtectedExtractionModel({
        kind: "extraction",
        sourceBatchId: BATCH,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        leaseToken: LEASE,
      }, () => Promise.resolve(undefined)),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(MemoryProviderOutcomeUnknownError);
    expect(state.remaining()).toBe(0);
  });
});
