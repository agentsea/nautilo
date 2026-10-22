import { describe, expect, test } from "bun:test";

import type {
  DirectDatabase,
  ProtectedTaskCheckpointPauseRecoveryCandidate,
  ProtectedTaskCheckpointPauseRecoveryCursor,
} from "@nautilo/db";
import { createProtectedTaskCheckpointPauseRecovery } from
  "../../src/routes/protected-task-checkpoint-pause-recovery";

const TASK_A = "10000000-0000-4000-8000-000000000001";
const TASK_B = "20000000-0000-4000-8000-000000000002";
const TASK_C = "30000000-0000-4000-8000-000000000003";
const TASK_D = "40000000-0000-4000-8000-000000000004";
const REQUEST_A = "50000000-0000-4000-8000-000000000005";
const REQUEST_B = "60000000-0000-4000-8000-000000000006";
const REQUEST_C = "70000000-0000-4000-8000-000000000007";
const REQUEST_D = "80000000-0000-4000-8000-000000000008";
const db = {} as DirectDatabase;

function candidate(taskId: string, pauseRequestId: string): ProtectedTaskCheckpointPauseRecoveryCandidate {
  return Object.freeze({ taskId, pauseRequestId });
}

function policy(mode: "plaintext_only" | "shadow_encryption" | "encrypted_only") {
  return { mode, shadowBehavior: mode === "plaintext_only" ? "fallback" as const : "strict" as const,
    revision: 7, shadowEncryptionStartedAt: mode === "plaintext_only" ? null : new Date(0),
    updatedAt: new Date(0) };
}

describe("protected Task checkpoint pause restart recovery", () => {
  test("a pending restart scan becomes paused only through the durable finalizer", async () => {
    let finalizerResult: "pending" | "paused" = "pending";
    const finalized: unknown[] = [];
    const recovery = createProtectedTaskCheckpointPauseRecovery({ db }, {
      readPolicy: async () => policy("encrypted_only"),
      list: async () => ({ candidates: [candidate(TASK_A, REQUEST_A)], next: null }),
      finalize: async (_db, input) => {
        finalized.push(input);
        return finalizerResult;
      },
    });
    expect(await recovery.recoverPage({ limit: 10 })).toEqual({
      status: "ready", attempted: 1, paused: 0, pending: 1,
      inactiveIntents: 0, failures: 0, next: null,
    });
    finalizerResult = "paused";
    expect(await recovery.recoverPage({ limit: 10 })).toEqual({
      status: "ready", attempted: 1, paused: 1, pending: 0,
      inactiveIntents: 0, failures: 0, next: null,
    });
    expect(finalized).toEqual([
      { taskId: TASK_A, pauseRequestId: REQUEST_A },
      { taskId: TASK_A, pauseRequestId: REQUEST_A },
    ]);
  });

  test("exact replay is idempotent and candidate races or failures stay isolated", async () => {
    const candidates = [
      candidate(TASK_A, REQUEST_A), candidate(TASK_B, REQUEST_B),
      candidate(TASK_C, REQUEST_C), candidate(TASK_D, REQUEST_D),
    ];
    const outcomes = new Map<string, "exact_replay" | "pending" | "inactive">([
      [TASK_A, "exact_replay"],
      [TASK_B, "pending"],
      [TASK_C, "inactive"],
    ] as const);
    const recovery = createProtectedTaskCheckpointPauseRecovery({ db }, {
      readPolicy: async () => policy("shadow_encryption"),
      list: async () => ({ candidates, next: { taskId: TASK_D } }),
      finalize: async (_db, input) => {
        if (input.taskId === TASK_D) throw new Error("transient database error");
        return outcomes.get(input.taskId)!;
      },
    });
    expect(await recovery.recoverPage({ limit: 4 })).toEqual({
      status: "ready", attempted: 4, paused: 1, pending: 1,
      inactiveIntents: 1, failures: 1, next: { taskId: TASK_D },
    });
  });

  test("forwards the exact keyset cursor to bounded discovery", async () => {
    const after: ProtectedTaskCheckpointPauseRecoveryCursor = { taskId: TASK_B };
    const pages: unknown[] = [];
    const recovery = createProtectedTaskCheckpointPauseRecovery({ db }, {
      readPolicy: async () => policy("encrypted_only"),
      list: async (_db, options) => {
        pages.push(options);
        return { candidates: [], next: null };
      },
      finalize: async () => "inactive",
    });
    await recovery.recoverPage({ limit: 23, after });
    expect(pages).toEqual([{ limit: 23, after }]);
  });

  test("Plain mode returns inactive before discovery or authorization work", async () => {
    let discoveries = 0;
    let finalizers = 0;
    const recovery = createProtectedTaskCheckpointPauseRecovery({ db }, {
      readPolicy: async () => policy("plaintext_only"),
      list: async () => {
        discoveries += 1;
        return { candidates: [candidate(TASK_A, REQUEST_A)], next: null };
      },
      finalize: async () => { finalizers += 1; return "paused"; },
    });
    expect(await recovery.recoverPage({ limit: 10 })).toEqual({
      status: "inactive", attempted: 0, paused: 0, pending: 0,
      inactiveIntents: 0, failures: 0, next: null,
    });
    expect(discoveries).toBe(0);
    expect(finalizers).toBe(0);
  });
});
