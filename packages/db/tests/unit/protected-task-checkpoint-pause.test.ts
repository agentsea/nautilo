import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  listProtectedTaskCheckpointPauseRecoveryCandidates,
  resumeProtectedTaskCheckpointPause,
} from
  "../../src/queries/protected-task-checkpoint-pause";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";

const TASK_A = "10000000-0000-4000-8000-000000000001";
const TASK_B = "20000000-0000-4000-8000-000000000002";
const REQUEST_A = "30000000-0000-4000-8000-000000000003";
const REQUEST_B = "40000000-0000-4000-8000-000000000004";

function resumeFixture(input: Readonly<{
  scheduleKind?: "now" | "cron";
  localExecutionDelegationIsNull?: boolean;
  lastErrorIsLocalRecapture?: boolean;
  fundingOutcomeUncertain?: boolean;
  runs?: readonly Record<string, unknown>[];
}>) {
  const lockedTask = {
    id: TASK_A,
    requestorId: TASK_B,
    agentId: "agent",
    status: "paused",
    contentNamespaceId: "50000000-0000-4000-8000-000000000005",
    scheduleKind: input.scheduleKind ?? "now",
    contentRepresentation: "protected",
    pauseRequestId: REQUEST_A,
    pauseRequestedAt: new Date("2030-01-01T08:00:00.000Z"),
    pauseReason: "manual_pause",
    localExecutionDelegationIsNull: input.localExecutionDelegationIsNull ?? false,
    lastErrorIsLocalRecapture: input.lastErrorIsLocalRecapture ?? false,
    fundingOutcomeUncertain: input.fundingOutcomeUncertain ?? false,
  };
  let updates = 0;
  const tx = {
    select() {
      let source: unknown;
      const query = {
        from(value: unknown) { source = value; return query; },
        where() { return query; },
        limit() { return query; },
        orderBy() { return query; },
        async for() {
          return source === tasks ? [lockedTask]
            : source === taskRuns ? [...(input.runs ?? [])]
              : [];
        },
      };
      return query;
    },
    update() {
      const query = {
        set() { return query; },
        where() { return query; },
        async returning() { updates += 1; return [{ id: TASK_A }]; },
      };
      return query;
    },
  };
  const db = {
    transaction: async (use: (value: typeof tx) => Promise<unknown>) => use(tx),
  } as unknown as DirectDatabase;
  return { db, updates: () => updates };
}

describe("protected Task checkpoint pause recovery discovery", () => {
  test("returns a stable content-free Task-id keyset page", async () => {
    let projection: Record<string, unknown> | undefined;
    let predicate: SQL | undefined;
    let orderedBy: unknown[] = [];
    let selectedLimit = 0;
    const query = {
      from() { return query; },
      where(value: SQL) { predicate = value; return query; },
      orderBy(...values: unknown[]) { orderedBy = values; return query; },
      async limit(value: number) {
        selectedLimit = value;
        return [
          { taskId: TASK_A, pauseRequestId: REQUEST_A },
          { taskId: TASK_B, pauseRequestId: REQUEST_B },
        ];
      },
    };
    const db = {
      select(value: Record<string, unknown>) { projection = value; return query; },
    } as unknown as DirectDatabase;

    const page = await listProtectedTaskCheckpointPauseRecoveryCandidates(db, {
      limit: 2,
      after: { taskId: TASK_A },
    });

    expect(Object.keys(projection!).sort()).toEqual(["pauseRequestId", "taskId"]);
    expect(selectedLimit).toBe(2);
    expect(orderedBy).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(predicate!).params).toContain(TASK_A);
    expect(page).toEqual({
      candidates: [
        { taskId: TASK_A, pauseRequestId: REQUEST_A },
        { taskId: TASK_B, pauseRequestId: REQUEST_B },
      ],
      next: { taskId: TASK_B },
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.candidates)).toBe(true);
    expect(Object.isFrozen(page.candidates[0])).toBe(true);
  });

  test("a short page terminates and malformed scans never enter the database", async () => {
    let calls = 0;
    const query = {
      from() { return query; }, where() { return query; }, orderBy() { return query; },
      async limit() { return [{ taskId: TASK_A, pauseRequestId: REQUEST_A }]; },
    };
    const db = { select() { calls += 1; return query; } } as unknown as DirectDatabase;
    expect(await listProtectedTaskCheckpointPauseRecoveryCandidates(db, { limit: 2 }))
      .toEqual({ candidates: [{ taskId: TASK_A, pauseRequestId: REQUEST_A }], next: null });
    for (const input of [
      { limit: 0 },
      { limit: 1.5 },
      { limit: 1, after: { taskId: "not-a-task-id" } },
    ]) {
      expect(listProtectedTaskCheckpointPauseRecoveryCandidates(db, input))
        .rejects.toThrow("recovery page is invalid");
    }
    expect(calls).toBe(1);
  });
});

describe("protected Task checkpoint resume controls", () => {
  const resume = (db: DirectDatabase) => resumeProtectedTaskCheckpointPause(db, {
    taskId: TASK_A,
    requesterUserId: TASK_B,
    pauseRequestId: REQUEST_A,
  });

  test("rechecks local recapture under the Task lock before clearing the pause intent", async () => {
    const fixture = resumeFixture({
      localExecutionDelegationIsNull: true,
      lastErrorIsLocalRecapture: true,
    });
    expect(await resume(fixture.db)).toBe("recapture_required");
    expect(fixture.updates()).toBe(0);
  });

  test("rechecks uncertain funding under the Task lock and preserves the cron exception", async () => {
    const rejected = resumeFixture({ fundingOutcomeUncertain: true });
    expect(await resume(rejected.db)).toBe("funding_uncertain");
    expect(rejected.updates()).toBe(0);

    const cron = resumeFixture({ scheduleKind: "cron", fundingOutcomeUncertain: true });
    expect(await resume(cron.db)).toBe("resumed");
    expect(cron.updates()).toBe(1);
  });

  test("an uncertain cron cannot resume a latest paused Run", async () => {
    const fixture = resumeFixture({
      scheduleKind: "cron",
      fundingOutcomeUncertain: true,
      runs: [{
        id: REQUEST_B,
        jobId: null,
        graphThreadId: "thread:paused",
        status: "paused",
        completedAt: null,
        modelId: null,
        fundingBinding: null,
        fundingPredecessorRunId: null,
        resultRepresentation: "ordinary",
        resultRevision: 0,
        resultContentNamespaceId: null,
        resultCryptoObjectId: null,
        resultCryptoAccessRevision: 0,
        resultCryptoRequiredNamespaceFingerprint: null,
        resultCryptoMappingState: "unmapped",
        resultTextIsNull: true,
        lastErrorIsNull: true,
      }],
    });
    expect(await resume(fixture.db)).toBe("funding_uncertain");
    expect(fixture.updates()).toBe(0);
  });
});
