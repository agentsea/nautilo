/**
 * M144 — dispatch-seam envelope selection against real Postgres + a stub graph.
 *
 * Phase 3 fills the `SEAM(phase3)` envelope branch in `dispatch-task-run.ts`.
 * The pure discriminator (`selectTaskEnvelopeMode`) and whitelist validation
 * (`resolveToolWhitelist`) are unit-tested DB-free in
 * `tests/unit/task-dispatch-whitelist.test.ts`. This suite proves the two
 * cleanly-observable end-to-end signals the unit tests cannot:
 *
 *  - **S1 (scope branch)**: an `in_scope` / `use_scope=true` task with no
 *    pre-set `scope_id` mints an ephemeral scope and PERSISTS it back onto
 *    `tasks.scope_id` (so a re-dispatch reuses it). A non-null `scope_id`
 *    after dispatch is direct proof the scope branch executed.
 *  - **S3 (namespace branch)**: a requester-only `in_background` task does NOT
 *    take the scope (or wide) branch — `scope_id` stays null — proving the
 *    discriminator keys on `use_scope`/`preset`, not `target_user_ids`.
 *
 * The `in_private_namespace` wide-envelope topology (bring_back return
 * namespace) is asserted in the ported M137 suite; here we only need the
 * scope-vs-namespace split, which is the dominant seam risk.
 *
 * No API keys required: NAUTILO_TEST_MODE=stub + __setStubModelForTests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  tasks,
  taskRuns,
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  type DirectDatabase,
  type NewTask,
} from "@nautilo/db";
import { __setStubModelForTests, setAgentEventSink } from "@nautilo/agent";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { TaskObserver } from "../../src/tasks/task-observer";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

let userId: string;
let agentId: string;
let db: DirectDatabase;

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  await setupTestDb();
  const env = await setupAgentTestEnv("task-dispatch-envelope");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  await db.delete(taskRuns);
  await db.delete(tasks);
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

function stub(line: string, count = 1): void {
  __setStubModelForTests(
    createStubProvider({
      responses: Array.from({ length: count }, () => ({
        type: "text" as const,
        content: line,
      })),
    }).asChatModel(),
  );
}

async function insertTask(overrides: Partial<NewTask>): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: "envelope-seam probe",
    scheduleKind: "now",
    targetChat: "orphan",
    // `none` → empty tool whitelist → a single deterministic model.invoke,
    // matching the proven scope-subagent stub path. The envelope branch is
    // independent of tools_mode.
    toolsMode: "none",
    targetUserIds: [userId],
    nextFireAt: new Date(),
    status: "pending",
    ...overrides,
  });
  return row.id;
}

async function pollAllRunsTerminal(taskId: string, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const runs = await getTaskRuns(db, taskId);
    if (
      runs.length >= 1 &&
      runs.every((r) => ["completed", "errored", "cancelled"].includes(r.status))
    ) {
      return runs;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `pollAllRunsTerminal timeout for ${taskId}: ${JSON.stringify(
          runs.map((r) => r.status),
        )}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("M144 — dispatch seam envelope selection (stub graph, real PG)", () => {
  test("S1: in_scope (use_scope, no scope_id) mints + persists tasks.scope_id", async () => {
    stub("M144_SCOPE_STUB");
    const taskId = await insertTask({
      preset: "in_scope",
      useScope: true,
      // scope_id intentionally omitted → dispatch must mint an ephemeral scope.
    });

    const obs = new TaskObserver({ db, jobManager, batch: 20 });
    await obs.tick();

    const runs = await pollAllRunsTerminal(taskId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("completed");

    const task = await getTaskById(db, taskId);
    // The scope branch ran: an ephemeral scope was minted and persisted back.
    expect(task?.scopeId).toBeTruthy();

    await obs.stop();
  });

  test("S3: in_background (requester-only) takes the namespace branch — scope_id stays null", async () => {
    stub("M144_NS_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      useScope: false,
    });

    const obs = new TaskObserver({ db, jobManager, batch: 20 });
    await obs.tick();

    const runs = await pollAllRunsTerminal(taskId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("completed");

    const task = await getTaskById(db, taskId);
    // Namespace branch: no scope minted (the wide branch would not set scope_id
    // either, but the key regression is that a requester-only background task
    // is NOT mis-scoped into scope memory).
    expect(task?.scopeId).toBeNull();

    await obs.stop();
  });
});
