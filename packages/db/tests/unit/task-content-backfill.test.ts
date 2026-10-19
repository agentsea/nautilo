import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import type { Database } from "../../src/config/database";
import {
  acknowledgeTaskContentBackfill,
  claimTaskContentBackfill,
  discoverTaskContentBackfill,
  lockCurrentTaskContentBackfillClaim,
  readTaskContentBackfillProgress,
  readCurrentTaskContentBackfillClaim,
  releaseTaskContentBackfillLease,
  renewTaskContentBackfillLease,
  type TaskContentBackfillCandidate,
  type TaskContentBackfillClaim,
} from "../../src/queries/task-content-backfill";
import {
  taskContentBackfillFailures,
  taskContentBackfillScans,
} from "../../src/schema/task-content-backfill";

const ids = {
  human: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000002",
  task1: "30000000-0000-4000-8000-000000000003",
  task2: "30000000-0000-4000-8000-000000000004",
  run1: "40000000-0000-4000-8000-000000000005",
  run2: "40000000-0000-4000-8000-000000000006",
  claim: "50000000-0000-4000-8000-000000000007",
};
const compatibleIds = {
  definitionV8: "836a18fb-2373-8420-a6c3-69213687b35e",
  resultTaskV7: "018f3df1-8d42-7c59-a112-17d92f9aa110",
  resultRunV8: "8f46dca1-2ab3-8c4d-9e5f-1029384756ab",
};
const now = new Date("2026-10-12T12:00:00.000Z");
const later = new Date("2026-10-12T12:05:00.000Z");
const created = new Date("2026-10-11T09:00:00.000Z");
const updated = new Date("2026-10-11T10:00:00.000Z");
const completed = new Date("2026-10-11T11:00:00.000Z");

type HarnessInput = Readonly<{
  selects: readonly (readonly unknown[])[];
  returning?: readonly (readonly unknown[])[];
}>;

function harness(input: HarnessInput) {
  const selects = [...input.selects];
  const returning = [...(input.returning ?? [])];
  const selectedKeys: string[][] = [];
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const deletes: unknown[] = [];

  const select = (projection?: Record<string, unknown>) => {
    selectedKeys.push(projection === undefined ? ["*"] : Object.keys(projection));
    let consumed = false;
    const consume = () => {
      if (consumed) throw new Error("Selection consumed twice");
      consumed = true;
      const rows = selects.shift();
      if (rows === undefined) throw new Error("Unexpected selection");
      return rows;
    };
    const query: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin", "limit", "for"]) {
      query[method] = () => query;
    }
    query["then"] = (
      resolve: (value: readonly unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve().then(consume).then(resolve, reject);
    return query;
  };

  const tx = {
    execute: async () => [],
    select,
    insert: (_table: unknown) => ({
      values: (value: unknown) => {
        inserts.push(value);
        return {
          onConflictDoNothing: async () => [],
          onConflictDoUpdate: async () => [],
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (value: unknown) => {
        updates.push(value);
        const query = {
          where: () => query,
          returning: async () => returning.shift() ?? [],
          then: (
            resolve: (value: readonly unknown[]) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return query;
      },
    }),
    delete: (_table: unknown) => ({
      where: async (value: unknown) => {
        deletes.push(value);
        return [];
      },
    }),
  };
  const database = {
    transaction: async (use: (value: typeof tx) => unknown) => use(tx),
  } as unknown as Database;
  return { database, selectedKeys, inserts, updates, deletes, remaining: () => selects.length };
}

function scan(overrides: Record<string, unknown> = {}) {
  return {
    humanActorId: ids.human,
    phase: "definition",
    cursorAt: null,
    cursorTaskId: null,
    cursorTaskRunId: null,
    throughAt: null,
    throughTaskId: null,
    throughTaskRunId: null,
    sweepStartedAt: now,
    lastSweepAt: null,
    lastActiveAt: now,
    resumeAt: null,
    leaseToken: null,
    leaseDeviceId: null,
    leaseExpiresAt: null,
    claim: null,
    ...overrides,
  };
}

function resultCandidate(overrides: Partial<Extract<TaskContentBackfillCandidate, { kind: "result" }>> = {}) {
  return {
    kind: "result" as const,
    taskId: ids.task2,
    taskRunId: ids.run2,
    sourceUpdatedAt: updated,
    sourceStartedAt: created,
    sourceCompletedAt: completed,
    sourceRevision: 0,
    sourceStatus: "completed" as const,
    ...overrides,
  };
}

function claim(candidate: TaskContentBackfillCandidate = resultCandidate()): TaskContentBackfillClaim {
  return {
    claimId: ids.claim,
    humanActorId: ids.human,
    requesterUserId: ids.user,
    deviceId: "device-a",
    policyRevision: 9,
    expiresAt: later,
    candidate,
  };
}

function encodedClaim(value: TaskContentBackfillClaim) {
  const candidate = value.candidate.kind === "definition" ? {
    ...value.candidate,
    sourceCreatedAt: value.candidate.sourceCreatedAt.toISOString(),
    sourceUpdatedAt: value.candidate.sourceUpdatedAt.toISOString(),
  } : {
    ...value.candidate,
    sourceUpdatedAt: value.candidate.sourceUpdatedAt.toISOString(),
    sourceStartedAt: value.candidate.sourceStartedAt.toISOString(),
    sourceCompletedAt: value.candidate.sourceCompletedAt.toISOString(),
  };
  return {
    ...value,
    expiresAt: value.expiresAt.toISOString(),
    candidate,
  };
}

describe("Task content backfill persistence", () => {
  test("schema stores one structural claim per Human and sparse exact-coordinate failures", () => {
    const scans = getTableConfig(taskContentBackfillScans);
    const failures = getTableConfig(taskContentBackfillFailures);
    const scanColumns = scans.columns.map((column) => column.name);
    const failureColumns = failures.columns.map((column) => column.name);
    for (const column of [
      "human_actor_id", "phase", "cursor_at", "cursor_task_id", "cursor_task_run_id",
      "through_at", "through_task_id", "through_task_run_id", "lease_token",
      "lease_device_id", "lease_expires_at", "claim",
    ]) expect(scanColumns).toContain(column);
    for (const column of [
      "kind", "entity_id", "task_id", "task_run_id", "source_revision",
      "source_updated_at", "source_status", "source_completed_at", "policy_revision", "reason",
    ]) expect(failureColumns).toContain(column);
    expect(scans.columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      "prompt", "result_text", "last_error", "ciphertext", "key",
    ]));
  });

  test("Plain and Full exit before actor, scan, or custody queries", async () => {
    for (const [mode, expected] of [
      ["plaintext_only", "disabled"],
      ["encrypted_only", "full_wait"],
    ] as const) {
      const fixture = harness({ selects: [[{ mode, shadowBehavior: "retain", revision: 9 }]] });
      const outcome = await discoverTaskContentBackfill(fixture.database, {
        humanActorId: ids.human,
        deviceId: "device-a",
        now,
        pageLimit: 4,
        resumeAt: later,
      });
      expect(outcome.status).toBe(expected);
      expect(fixture.selectedKeys).toHaveLength(1);
      expect(fixture.inserts).toHaveLength(0);
      expect(fixture.remaining()).toBe(0);
    }
  });

  test.each([
    { preset: "ask_peer" },
    { preset: "ping" },
    { preset: "repo_docs" },
    { depth: 1 },
    { ownerId: "other-owner" },
  ])("unsupported definition routing %j advances before a later eligible definition", async unsupported => {
    const row = { taskId: ids.task1, ownerId: ids.user, preset: "task", depth: 0,
      createdAt: created, updatedAt: updated, status: "paused", contentRevision: 0,
      parentTaskId: null, failureReason: null, failureSourceRevision: null,
      failureSourceUpdatedAt: null, failureSourceStatus: null, failurePolicyRevision: null };
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", revision: 9 }], [{ ownerId: ids.user }],
      [scan({ throughAt: created, throughTaskId: ids.task2 })],
      [{ ...row, ...unsupported }, { ...row, taskId: ids.task2 }],
    ] });
    const found = await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 4, resumeAt: later,
    });
    expect(found).toMatchObject({ status: "candidate", candidate: { taskId: ids.task2 } });
    expect(fixture.inserts).toContainEqual(expect.objectContaining({ entityId: ids.task1, reason: "unsupported" }));
    expect(fixture.updates).toContainEqual(expect.objectContaining({ cursorTaskId: ids.task1 }));
  });

  test.each(["in_background", "schedule"])("%s definition is eligible for repair", async preset => {
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [scan({ throughAt: created, throughTaskId: ids.task1 })],
      [{
        taskId: ids.task1, ownerId: ids.user, preset, depth: 0,
        createdAt: created, updatedAt: updated, status: "pending", contentRevision: 0,
        parentTaskId: null, failureReason: null, failureSourceRevision: null,
        failureSourceUpdatedAt: null, failureSourceStatus: null, failurePolicyRevision: null,
      }],
    ] });
    expect(await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 4, resumeAt: later,
    })).toMatchObject({
      status: "candidate",
      candidate: { kind: "definition", taskId: ids.task1 },
    });
    expect(fixture.inserts).toHaveLength(1); // scan row only; no failure row
  });

  test("an exact cached failure survives within one policy revision and retries after revision change", async () => {
    const row = {
      taskId: ids.task1, ownerId: ids.user, preset: "in_background", depth: 0,
      createdAt: created, updatedAt: updated, status: "paused", contentRevision: 0,
      parentTaskId: null, failureReason: "unsupported", failureSourceRevision: 0,
      failureSourceUpdatedAt: updated, failureSourceStatus: "paused",
      failurePolicyRevision: 9,
    };
    const retained = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [scan({ throughAt: created, throughTaskId: ids.task2 })],
      [row, { ...row, taskId: ids.task2, failureReason: null,
        failureSourceRevision: null, failureSourceUpdatedAt: null,
        failureSourceStatus: null, failurePolicyRevision: null }],
    ] });
    expect(await discoverTaskContentBackfill(retained.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 4, resumeAt: later,
    })).toMatchObject({ status: "candidate", candidate: { taskId: ids.task2 } });

    const changed = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 10 }],
      [{ ownerId: ids.user }],
      [scan({ throughAt: created, throughTaskId: ids.task1 })],
      [row],
    ] });
    expect(await discoverTaskContentBackfill(changed.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 4, resumeAt: later,
    })).toMatchObject({ status: "candidate", policyRevision: 10,
      candidate: { taskId: ids.task1 } });
  });

  test("definition discovery returns only structural coordinates and fences ordinary source drift with updatedAt", async () => {
    const initial = scan();
    const withThrough = scan({ throughAt: created, throughTaskId: ids.task1 });
    const fixture = harness({
      selects: [
        [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
        [{ ownerId: ids.user }],
        [initial],
        [{ at: created, taskId: ids.task1 }],
        [{
          taskId: ids.task1,
          ownerId: ids.user,
          preset: "task",
          depth: 0,
          createdAt: created,
          updatedAt: updated,
          status: "pending",
          contentRevision: 0,
          parentTaskId: null,
          failureReason: null,
          failureSourceRevision: null,
          failureSourceUpdatedAt: null,
          failureSourceStatus: null,
          failurePolicyRevision: null,
        }],
      ],
      returning: [[withThrough]],
    });
    const outcome = await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 4, resumeAt: later,
    });
    expect(outcome).toEqual({
      status: "candidate",
      policyRevision: 9,
      requesterUserId: ids.user,
      candidate: {
        kind: "definition",
        taskId: ids.task1,
        sourceCreatedAt: created,
        sourceUpdatedAt: updated,
        sourceRevision: 0,
        sourceStatus: "pending",
      },
    });
    const projected = fixture.selectedKeys.flat();
    for (const forbidden of ["prompt", "expectedOutput", "metadata", "resultText", "lastError"]) {
      expect(projected).not.toContain(forbidden);
    }
  });

  test("an unsupported first parent is durably accounted and does not starve a later eligible result", async () => {
    const firstCompleted = new Date(completed.getTime() - 1_000);
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [scan({
        phase: "result",
        throughAt: completed,
        throughTaskId: ids.task2,
        throughTaskRunId: ids.run2,
      })],
      [
        {
          taskId: ids.task1,
          taskRunId: ids.run1,
          taskUpdatedAt: updated,
          startedAt: created,
          completedAt: firstCompleted,
          status: "errored",
          resultRevision: 0,
          parentRepresentation: "ordinary",
          parentMappingState: "unmapped",
          parentStatus: "errored",
          parentFailureReason: "unsupported",
          parentFailureRevision: 0,
          parentFailureUpdatedAt: updated,
          parentFailureStatus: "errored",
          parentFailurePolicyRevision: 9,
          failureReason: null,
          failureSourceRevision: null,
          failureSourceUpdatedAt: null,
          failureSourceStatus: null,
          failureSourceCompletedAt: null,
          failurePolicyRevision: null,
        },
        {
          taskId: ids.task2,
          taskRunId: ids.run2,
          taskUpdatedAt: updated,
          startedAt: created,
          completedAt: completed,
          status: "completed",
          resultRevision: 0,
          parentRepresentation: "dual",
          parentMappingState: "verified",
          parentStatus: "completed",
          parentFailureReason: null,
          parentFailureRevision: null,
          parentFailureUpdatedAt: null,
          parentFailureStatus: null,
          parentFailurePolicyRevision: null,
          failureReason: null,
          failureSourceRevision: null,
          failureSourceUpdatedAt: null,
          failureSourceStatus: null,
          failureSourceCompletedAt: null,
          failurePolicyRevision: null,
        },
      ],
    ] });
    const outcome = await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 4, resumeAt: later,
    });
    expect(outcome.status).toBe("candidate");
    if (outcome.status !== "candidate") throw new Error("Expected candidate");
    expect(outcome.candidate).toEqual(resultCandidate());
    expect(fixture.inserts).toContainEqual(expect.objectContaining({
      kind: "result",
      entityId: ids.run1,
      taskId: ids.task1,
      taskRunId: ids.run1,
      reason: "unsupported",
    }));
    expect(fixture.updates).toContainEqual(expect.objectContaining({
      cursorTaskId: ids.task1,
      cursorTaskRunId: ids.run1,
      cursorAt: firstCompleted,
    }));
  });

  test("a temporary parent wait advances the current sweep and stays separately accounted", async () => {
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [scan({ phase: "result", throughAt: completed, throughTaskId: ids.task1, throughTaskRunId: ids.run1 })],
      [{
        taskId: ids.task1,
        taskRunId: ids.run1,
        taskUpdatedAt: updated,
        startedAt: created,
        completedAt: completed,
        status: "cancelled",
        resultRevision: 0,
        parentRepresentation: "ordinary",
        parentMappingState: "unmapped",
        parentStatus: "cancelled",
        parentFailureReason: null,
        parentFailureRevision: null,
        parentFailureUpdatedAt: null,
        parentFailureStatus: null,
        parentFailurePolicyRevision: null,
        failureReason: null,
        failureSourceRevision: null,
        failureSourceUpdatedAt: null,
        failureSourceStatus: null,
        failureSourceCompletedAt: null,
        failurePolicyRevision: null,
      }],
    ] });
    expect((await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 1, resumeAt: later,
    })).status).toBe("more");
    expect(fixture.inserts).toContainEqual(expect.objectContaining({
      entityId: ids.run1,
      reason: "waiting_parent",
      sourceStatus: "cancelled",
      sourceCompletedAt: completed,
    }));
  });

  test("a cached parent wait is reconsidered when the parent becomes verified", async () => {
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [scan({ phase: "result", throughAt: completed, throughTaskId: ids.task2, throughTaskRunId: ids.run2 })],
      [{
        taskId: ids.task2,
        taskRunId: ids.run2,
        taskUpdatedAt: updated,
        startedAt: created,
        completedAt: completed,
        status: "completed",
        resultRevision: 0,
        parentRepresentation: "dual",
        parentMappingState: "verified",
        parentStatus: "completed",
        parentFailureReason: null,
        parentFailureRevision: null,
        parentFailureUpdatedAt: null,
        parentFailureStatus: null,
        parentFailurePolicyRevision: null,
        failureReason: "waiting_parent",
        failureSourceRevision: 0,
        failureSourceUpdatedAt: updated,
        failureSourceStatus: "completed",
        failureSourceCompletedAt: completed,
        failurePolicyRevision: 9,
      }],
    ] });
    const outcome = await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", now, pageLimit: 2, resumeAt: later,
    });
    expect(outcome.status).toBe("candidate");
    expect(fixture.deletes).toHaveLength(1);
  });

  test("a live lease is retained for its exact device and blocks a second device", async () => {
    const retained = claim();
    const active = scan({
      phase: "result",
      throughAt: completed,
      throughTaskId: ids.task2,
      throughTaskRunId: ids.run2,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: retained.expiresAt,
      claim: encodedClaim(retained),
    });
    for (const [deviceId, expected] of [["device-a", "claimed"], ["device-b", "waiting"]] as const) {
      const fixture = harness({ selects: [
        [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
        [{ ownerId: ids.user }],
        [active],
      ] });
      const outcome = await discoverTaskContentBackfill(fixture.database, {
        humanActorId: ids.human, deviceId, now, pageLimit: 2, resumeAt: later,
      });
      expect(outcome.status).toBe(expected);
    }
  });

  test("an expired lease advances its exact coordinate before selecting later work", async () => {
    const expired = { ...claim(), expiresAt: new Date(now.getTime() - 1) };
    const advanced = scan({
      phase: "result",
      cursorAt: completed,
      cursorTaskId: ids.task2,
      cursorTaskRunId: ids.run2,
      throughAt: completed,
      throughTaskId: ids.task2,
      throughTaskRunId: ids.run2,
    });
    const fixture = harness({
      selects: [
        [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
        [{ ownerId: ids.user }],
        [scan({
          phase: "result",
          throughAt: completed,
          throughTaskId: ids.task2,
          throughTaskRunId: ids.run2,
          leaseToken: expired.claimId,
          leaseDeviceId: expired.deviceId,
          leaseExpiresAt: expired.expiresAt,
          claim: encodedClaim(expired),
        })],
        [],
      ],
      returning: [[advanced]],
    });
    const outcome = await discoverTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, deviceId: "device-b", now, pageLimit: 2, resumeAt: later,
    });
    expect(outcome.status).toBe("swept");
    expect(fixture.updates[0]).toEqual(expect.objectContaining({
      leaseToken: null,
      cursorTaskRunId: ids.run2,
    }));
  });

  test("claim installation is single-winner and binds exact device coordinates", async () => {
    const candidate = resultCandidate();
    const unclaimed = scan({
      phase: "result",
      throughAt: completed,
      throughTaskId: ids.task2,
      throughTaskRunId: ids.run2,
    });
    const first = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [unclaimed],
      [{ taskId: ids.task2, updatedAt: updated, requestorId: ids.user,
        representation: "dual", mappingState: "verified" }],
      [{ taskId: ids.task2, taskRunId: ids.run2, startedAt: created,
        completedAt: completed, status: "completed", resultRevision: 0,
        representation: "ordinary" }],
      [unclaimed],
    ] });
    const won = await claimTaskContentBackfill(first.database, {
      humanActorId: ids.human,
      requesterUserId: ids.user,
      deviceId: "device-a",
      claimId: ids.claim,
      policyRevision: 9,
      candidate,
      now,
      expiresAt: later,
    });
    expect(won.status).toBe("claimed");
    expect(first.updates).toContainEqual(expect.objectContaining({
      leaseToken: ids.claim,
      leaseDeviceId: "device-a",
    }));

    const second = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [scan({ ...unclaimed, leaseToken: ids.claim, leaseDeviceId: "device-a",
        leaseExpiresAt: later, claim: encodedClaim(claim(candidate)) })],
    ] });
    expect((await claimTaskContentBackfill(second.database, {
      humanActorId: ids.human,
      requesterUserId: ids.user,
      deviceId: "device-b",
      claimId: "60000000-0000-4000-8000-000000000008",
      policyRevision: 9,
      candidate,
      now,
      expiresAt: later,
    })).status).toBe("held");
    expect(second.updates).toHaveLength(0);
  });

  test("claim accepts a deterministic UUIDv8 definition coordinate", async () => {
    const candidate: TaskContentBackfillCandidate = {
      kind: "definition",
      taskId: compatibleIds.definitionV8,
      sourceCreatedAt: created,
      sourceUpdatedAt: updated,
      sourceRevision: 0,
      sourceStatus: "pending",
    };
    const unclaimed = scan({
      throughAt: created,
      throughTaskId: compatibleIds.definitionV8,
    });
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [unclaimed],
      [{
        taskId: compatibleIds.definitionV8,
        createdAt: created,
        updatedAt: updated,
        status: "pending",
        contentRevision: 0,
        representation: "ordinary",
        requestorId: ids.user,
        parentTaskId: null,
      }],
      [unclaimed],
    ] });

    const outcome = await claimTaskContentBackfill(fixture.database, {
      humanActorId: ids.human,
      requesterUserId: ids.user,
      deviceId: "device-a",
      claimId: ids.claim,
      policyRevision: 9,
      candidate,
      now,
      expiresAt: later,
    });

    expect(outcome).toMatchObject({
      status: "claimed",
      claim: { candidate: { kind: "definition", taskId: compatibleIds.definitionV8 } },
    });
  });

  test("claim accepts UUIDv7 and UUIDv8 result coordinates", async () => {
    const candidate = resultCandidate({
      taskId: compatibleIds.resultTaskV7,
      taskRunId: compatibleIds.resultRunV8,
    });
    const unclaimed = scan({
      phase: "result",
      throughAt: completed,
      throughTaskId: compatibleIds.resultTaskV7,
      throughTaskRunId: compatibleIds.resultRunV8,
    });
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [unclaimed],
      [{
        taskId: compatibleIds.resultTaskV7,
        updatedAt: updated,
        requestorId: ids.user,
        representation: "dual",
        mappingState: "verified",
      }],
      [{
        taskId: compatibleIds.resultTaskV7,
        taskRunId: compatibleIds.resultRunV8,
        startedAt: created,
        completedAt: completed,
        status: "completed",
        resultRevision: 0,
        representation: "ordinary",
      }],
      [unclaimed],
    ] });

    const outcome = await claimTaskContentBackfill(fixture.database, {
      humanActorId: ids.human,
      requesterUserId: ids.user,
      deviceId: "device-a",
      claimId: ids.claim,
      policyRevision: 9,
      candidate,
      now,
      expiresAt: later,
    });

    expect(outcome).toMatchObject({
      status: "claimed",
      claim: {
        candidate: {
          kind: "result",
          taskId: compatibleIds.resultTaskV7,
          taskRunId: compatibleIds.resultRunV8,
        },
      },
    });
  });

  test("claim still rejects malformed UUID versions, variants, and shapes", async () => {
    const invalidTaskIds = [
      "836a18fb-2373-9420-a6c3-69213687b35e",
      "836a18fb-2373-8420-76c3-69213687b35e",
      "836a18fb-2373-8420-a6c3-69213687b35",
    ];

    for (const taskId of invalidTaskIds) {
      const candidate: TaskContentBackfillCandidate = {
        kind: "definition",
        taskId,
        sourceCreatedAt: created,
        sourceUpdatedAt: updated,
        sourceRevision: 0,
        sourceStatus: "pending",
      };
      const rejection = await claimTaskContentBackfill({} as Database, {
        humanActorId: ids.human,
        requesterUserId: ids.user,
        deviceId: "device-a",
        claimId: ids.claim,
        policyRevision: 9,
        candidate,
        now,
        expiresAt: later,
      }).then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(TypeError);
      expect(rejection).toHaveProperty("message", "Task content backfill claim is invalid");
    }
  });

  test("acknowledgement rejects source drift before recording a proxy disposition", async () => {
    const retained = claim();
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [scan({
        phase: "result",
        throughAt: completed,
        throughTaskId: ids.task2,
        throughTaskRunId: ids.run2,
        leaseToken: retained.claimId,
        leaseDeviceId: retained.deviceId,
        leaseExpiresAt: retained.expiresAt,
        claim: encodedClaim(retained),
      })],
      [{ taskId: ids.task2, updatedAt: new Date(updated.getTime() + 1), requestorId: ids.user,
        representation: "dual", mappingState: "verified" }],
      [{
        taskId: ids.task2,
        taskRunId: ids.run2,
        startedAt: created,
        completedAt: completed,
        status: "completed",
        resultRevision: 0,
        representation: "ordinary",
      }],
    ] });
    expect(await acknowledgeTaskContentBackfill(fixture.database, {
      claim: retained,
      outcome: "no_content",
      now,
    })).toBe("source_changed");
    expect(fixture.inserts).toHaveLength(0);
    expect(fixture.updates).toHaveLength(0);
  });

  test("mapped acknowledgement requires the immutable ledger callback before advancing", async () => {
    const retained = claim();
    const active = scan({
      phase: "result",
      throughAt: completed,
      throughTaskId: ids.task2,
      throughTaskRunId: ids.run2,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: retained.expiresAt,
      claim: encodedClaim(retained),
    });
    const mappedRun = {
      taskId: ids.task2,
      taskRunId: ids.run2,
      startedAt: created,
      completedAt: completed,
      status: "completed",
      resultRevision: 1,
      representation: "dual",
    };
    const mappedState = {
      taskId: ids.task2,
      representation: "dual",
      revision: 1,
      mappingState: "verified",
      status: "completed",
      completedAt: completed,
    };
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [active],
      [{ taskId: ids.task2, updatedAt: updated, requestorId: ids.user,
        representation: "dual", mappingState: "verified" }],
      [mappedRun],
      [mappedState],
      [active],
    ] });
    const callbackClaims: TaskContentBackfillClaim[] = [];
    expect(await acknowledgeTaskContentBackfill(fixture.database, {
      claim: retained,
      outcome: "mapped",
      now,
      assertMapped: async (_tx, current) => {
        callbackClaims.push(current);
        return true;
      },
    })).toBe("acknowledged");
    expect(callbackClaims).toEqual([retained]);
    expect(fixture.updates).toContainEqual(expect.objectContaining({
      leaseToken: null,
      cursorTaskRunId: ids.run2,
    }));
  });

  test("caller-owned lock rereads Task then Run and rejects an expired or substituted claim", async () => {
    const retained = claim();
    const active = scan({
      phase: "result",
      throughAt: completed,
      throughTaskId: ids.task2,
      throughTaskRunId: ids.run2,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: retained.expiresAt,
      claim: encodedClaim(retained),
    });
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [active],
      [{ ownerId: ids.user }],
      [{ taskId: ids.task2, updatedAt: updated, requestorId: ids.user,
        representation: "dual", mappingState: "verified" }],
      [{
        taskId: ids.task2,
        taskRunId: ids.run2,
        startedAt: created,
        completedAt: completed,
        status: "completed",
        resultRevision: 0,
        representation: "ordinary",
      }],
      [active],
    ] });
    const locked = await (fixture.database.transaction(async (tx) =>
      lockCurrentTaskContentBackfillClaim(tx, {
        humanActorId: ids.human,
        deviceId: "device-a",
        claimId: ids.claim,
        now,
      })));
    expect(locked).toEqual(retained);
    expect(fixture.selectedKeys).toEqual([
      ["mode", "shadowBehavior", "revision"],
      ["*"],
      ["ownerId"],
      ["taskId", "updatedAt", "requestorId", "representation", "mappingState"],
      ["taskId", "taskRunId", "startedAt", "completedAt", "status", "resultRevision", "representation"],
      ["*"],
    ]);
  });

  test("lease renewal binds the closed JSON claim to every lease column", async () => {
    const retained = claim();
    const active = scan({
      phase: "result",
      throughAt: completed,
      throughTaskId: ids.task2,
      throughTaskRunId: ids.run2,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: retained.expiresAt,
      claim: encodedClaim(retained),
    });
    const renewedUntil = new Date(later.getTime() + 60_000);
    const valid = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [active],
    ] });
    expect(await renewTaskContentBackfillLease(valid.database, {
      claim: retained, now, expiresAt: renewedUntil,
    })).toEqual({ ...retained, expiresAt: renewedUntil });
    expect(valid.updates).toContainEqual(expect.objectContaining({ leaseExpiresAt: renewedUntil }));

    const malformed = [
      { ...active, leaseToken: "60000000-0000-4000-8000-000000000008" },
      { ...active, leaseDeviceId: "device-b" },
      { ...active, leaseExpiresAt: renewedUntil },
      { ...active, humanActorId: "60000000-0000-4000-8000-000000000008" },
      { ...active, claim: { ...encodedClaim(retained), unexpected: true } },
      { ...active, claim: { ...encodedClaim(retained), candidate: {
        ...(encodedClaim(retained).candidate as Record<string, unknown>), unexpected: true,
      } } },
    ];
    for (const row of malformed) {
      const fixture = harness({ selects: [
        [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
        [row],
      ] });
      expect(await renewTaskContentBackfillLease(fixture.database, {
        claim: retained, now, expiresAt: renewedUntil,
      })).toBeNull();
      expect(fixture.updates).toHaveLength(0);
    }
  });

  test("release is policy-fenced before scan access and rejects stale policy claims", async () => {
    const retained = claim();
    for (const mode of ["plaintext_only", "encrypted_only"] as const) {
      const fixture = harness({ selects: [[{ mode, shadowBehavior: "retain", revision: 9 }]] });
      expect(await releaseTaskContentBackfillLease(fixture.database, {
        claim: retained, now, advance: false,
      })).toBeFalse();
      expect(fixture.selectedKeys).toEqual([["mode", "shadowBehavior", "revision"]]);
      expect(fixture.updates).toHaveLength(0);
    }

    const active = scan({
      phase: "result", throughAt: completed, throughTaskId: ids.task2, throughTaskRunId: ids.run2,
      leaseToken: retained.claimId, leaseDeviceId: retained.deviceId,
      leaseExpiresAt: retained.expiresAt, claim: encodedClaim(retained),
    });
    const stale = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 10 }], [active],
    ] });
    expect(await releaseTaskContentBackfillLease(stale.database, {
      claim: retained, now, advance: true,
    })).toBeFalse();
    expect(stale.updates).toHaveLength(0);

    const current = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }], [active],
    ] });
    expect(await releaseTaskContentBackfillLease(current.database, {
      claim: retained, now, advance: true,
    })).toBeTrue();
    expect(current.updates).toContainEqual(expect.objectContaining({
      leaseToken: null, cursorTaskRunId: ids.run2,
    }));
  });

  test("claim revalidates Task and Run before the final scan CAS", async () => {
    const candidate = resultCandidate();
    const detached = scan({
      phase: "result", throughAt: completed, throughTaskId: ids.task2, throughTaskRunId: ids.run2,
    });
    const advanced = scan({
      phase: "result", cursorAt: completed, cursorTaskId: ids.task2, cursorTaskRunId: ids.run2,
      throughAt: completed, throughTaskId: ids.task2, throughTaskRunId: ids.run2,
    });
    const fixture = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [detached],
      [{ taskId: ids.task2, updatedAt: updated, requestorId: ids.user,
        representation: "dual", mappingState: "verified" }],
      [{ taskId: ids.task2, taskRunId: ids.run2, startedAt: created,
        completedAt: completed, status: "completed", resultRevision: 0,
        representation: "ordinary" }],
      [advanced],
    ] });
    expect((await claimTaskContentBackfill(fixture.database, {
      humanActorId: ids.human, requesterUserId: ids.user, deviceId: "device-a",
      claimId: ids.claim, policyRevision: 9, candidate, now, expiresAt: later,
    })).status).toBe("stale");
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.selectedKeys).toEqual([
      ["mode", "shadowBehavior", "revision"],
      ["ownerId"],
      ["*"],
      ["taskId", "updatedAt", "requestorId", "representation", "mappingState"],
      ["taskId", "taskRunId", "startedAt", "completedAt", "status", "resultRevision", "representation"],
      ["*"],
    ]);
  });

  test("a result claim is unavailable when its parent definition is no longer verified", async () => {
    const retained = claim();
    const active = scan({
      phase: "result", throughAt: completed, throughTaskId: ids.task2, throughTaskRunId: ids.run2,
      leaseToken: retained.claimId, leaseDeviceId: retained.deviceId,
      leaseExpiresAt: retained.expiresAt, claim: encodedClaim(retained),
    });
    for (const parent of [
      { representation: "ordinary", mappingState: "unmapped" },
      { representation: "dual", mappingState: "stale" },
    ]) {
      const fixture = harness({ selects: [
        [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
        [active],
        [{ ownerId: ids.user }],
        [{ taskId: ids.task2, updatedAt: updated, requestorId: ids.user, ...parent }],
      ] });
      expect(await fixture.database.transaction(async (tx) => lockCurrentTaskContentBackfillClaim(tx, {
        humanActorId: ids.human, deviceId: retained.deviceId, claimId: retained.claimId, now,
      }))).toBeNull();
      expect(fixture.remaining()).toBe(0);
    }
  });

  test("progress is content-free and Plain returns before actor or scan access", async () => {
    const plain = harness({ selects: [[{
      mode: "plaintext_only", shadowBehavior: "retain", revision: 9,
    }]] });
    expect(await readTaskContentBackfillProgress(plain.database, {
      humanActorId: ids.human, now,
    })).toBeNull();
    expect(plain.selectedKeys).toEqual([["mode", "shadowBehavior", "revision"]]);

    const shadow = harness({ selects: [
      [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
      [{ ownerId: ids.user }],
      [{ eligible: 2, mapped: 1, waiting: 0, unsupported: 1, failed: 0, noContent: 0 }],
      [{ eligible: 3, mapped: 1, waiting: 1, unsupported: 0, failed: 0, noContent: 1 }],
      [{ claim: encodedClaim(claim()), leaseExpiresAt: later }],
    ] });
    expect(await readTaskContentBackfillProgress(shadow.database, {
      humanActorId: ids.human, now,
    })).toEqual({
      eligibleDefinitions: 2, mappedDefinitions: 1,
      eligibleResults: 3, mappedResults: 1,
      claimedRepairing: 1, waiting: 1, unsupported: 1, failed: 0, noContent: 1, pending: 1,
    });
    const projected = shadow.selectedKeys.flat();
    for (const forbidden of ["prompt", "expectedOutput", "metadata", "resultText", "lastError"]) {
      expect(projected).not.toContain(forbidden);
    }
  });
});


test("current historical claim lookup is content-free and keeps a mapped lease readable", async () => {
  const retained = claim();
  const active = scan({ leaseToken: retained.claimId, leaseDeviceId: retained.deviceId,
    leaseExpiresAt: retained.expiresAt, claim: encodedClaim(retained) });
  const fixture = harness({ selects: [
    [{ mode: "shadow_encryption", shadowBehavior: "retain", revision: 9 }],
    [active], [{ ownerId: ids.user }],
  ] });
  expect(await readCurrentTaskContentBackfillClaim(fixture.database, {
    humanActorId: ids.human, deviceId: "device-a", claimId: ids.claim, now,
  })).toEqual(retained);
  expect(fixture.selectedKeys).toEqual([["mode", "shadowBehavior", "revision"], ["*"], ["ownerId"]]);
  expect(fixture.updates).toHaveLength(0);
  expect(fixture.inserts).toHaveLength(0);
  expect(fixture.remaining()).toBe(0);
});

for (const mode of ["plaintext_only", "encrypted_only"] as const) {
  test(`current historical claim lookup exits in ${mode} without scan access`, async () => {
    const fixture = harness({ selects: [[{ mode, shadowBehavior: "retain", revision: 9 }]] });
    expect(await readCurrentTaskContentBackfillClaim(fixture.database, {
      humanActorId: ids.human, deviceId: "device-a", claimId: ids.claim, now,
    })).toBeNull();
    expect(fixture.selectedKeys).toHaveLength(1);
    expect(fixture.remaining()).toBe(0);
  });
}
