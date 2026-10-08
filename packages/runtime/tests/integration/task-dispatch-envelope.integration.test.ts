/**
 * dispatch-seam envelope selection against real Postgres + a stub graph.
 *
 * exercises the envelope-selection branch in `dispatch-task-run.ts`.
 * The pure discriminator (`selectTaskEnvelopeMode`) and whitelist validation
 * (`resolveToolWhitelist`) are unit-tested DB-free in
 * `tests/unit/task-dispatch-whitelist.test.ts`. This suite proves the two
 * cleanly-observable end-to-end signals the unit tests cannot:
 *
 *  - **Scope branch**: an `in_scope` / `use_scope=true` task with no
 *    pre-set `scope_id` mints an ephemeral scope and PERSISTS it back onto
 *    `tasks.scope_id` (so a re-dispatch reuses it). A non-null `scope_id`
 *    after dispatch is direct proof the scope branch executed.
 *  - **Namespace branch**: a requester-only `in_background` task does NOT
 *    take the scope (or wide) branch — `scope_id` stays null — proving the
 *    discriminator keys on `use_scope`/`preset`, not `target_user_ids`.
 *
 * The `in_private_namespace` wide-envelope topology (bring_back return
 * namespace) is covered by focused tests; this suite verifies the
 * scope-vs-namespace split, which is the dominant seam risk.
 *
 * No API keys required: NAUTILO_TEST_MODE=stub + __setStubModelForTests.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  tasks,
  serverAdmission,
  taskRuns,
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  rooms,
  eq,
  type DirectDatabase,
  type NewTask,
} from "@nautilo/db";
import { __setStubModelForTests, setAgentEventSink, setRelayRegistry, type ToolRelayRegistry } from "@nautilo/agent";
import { setTaskLocalExecutionSourceComposition } from "../../src/tasks/local-execution-delegation";
import { eventBus } from "../../src/event-bus";
import { jobManager } from "../../src/job-manager";
import { TaskObserver } from "../../src/tasks/task-observer";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
  createTestRoom,
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
  await db.insert(serverAdmission).values({ userId: userId, admitted: true });
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

describe("dispatch seam envelope selection (stub graph, real PG)", () => {
  test("in_scope (use_scope, no scope_id) mints + persists tasks.scope_id", async () => {
    stub("TASK_SCOPE_STUB");
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

  test("in_background (requester-only) takes the namespace branch — scope_id stays null", async () => {
    stub("TASK_NAMESPACE_STUB");
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

test("delegation survives offline recovery on the same Run and subsequent Room and scope memoization", async () => {
  stub("DELEGATED_SCOPE_STUB");
  const id = randomUUID();
  const { roomId } = await createTestRoom(userId);
  const delegation = { version: 1 as const, humanUserId: userId, agentId, sourceRoomId: roomId,
    sourceConversationId: "source-conversation", rootTaskId: id, projectGrantId: "fixture-grant",
    target: { instanceId: "", relayId: "fixture-relay", pairingGeneration: "fixture-pairing",
      serverOrigin: "https://server.example", serverFingerprint: "fixture-fingerprint" },
    ceiling: "basic" as const, profile: null };
  await insertTask({ id, callingRoomId: roomId, resultDelivery: "raw", preset: "in_scope", useScope: true, localExecutionDelegation: delegation });
  let online = false;
  let sourceChecks = 0;
  // Inject only external authorization/transport discovery. Task lineage,
  // parking, rearming, graph execution, and bookkeeping use the real DB.
  setTaskLocalExecutionSourceComposition({
    assertSource: async task => {
      const [source] = await db.select({ ownerId: rooms.ownerId }).from(rooms).where(eq(rooms.id, roomId));
      expect(source?.ownerId).toBe(userId);
      expect(task.callingRoomId).toBe(roomId);
      expect(task.requestorId).toBe(userId);
      sourceChecks++;
    },
    subscribeChanges: () => () => {},
  });
  setRelayRegistry({
    findByCapabilityForUser: () => [],
    getCapabilities: () => online ? { profile: "desktop-agent", canExecuteLocal: true, canDelegateLocalExecution: true,
      localExecution: { version: 1, generation: "generation", pipe: true, pty: true, capacity: 1 } } : null,
    getProtocolVersion: () => 28, getUserId: () => userId, getPairingGeneration: () => "fixture-pairing",
    getDesktopSessionId: () => "fixture-desktop", getLocalExecutionPairingGeneration: () => "opaque-pairing",
    isRelayHeartbeatFresh: () => online,
  } as unknown as ToolRelayRegistry);
  const observer = new TaskObserver({ db, jobManager, batch: 20 });
  try {
    await observer.tick();
    const deadline = Date.now() + 20_000;
    while ((await getTaskById(db, id))?.status !== "paused") {
      if (Date.now() > deadline) throw new Error("Task did not park for the unavailable Desktop");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const parked = await getTaskRuns(db, id);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.status).toBe("paused");
    const parkedTask = await getTaskById(db, id);
    expect(parkedTask?.localExecutionDelegation).toEqual(delegation);
    online = true;
    await observer.tick();
    // Rearming stamps nextFireAt after this tick's claim cutoff. The next
    // normal observer tick claims that due occurrence.
    await observer.tick();
    const runs = await pollAllRunsTerminal(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(parked[0]?.id);
    expect(runs[0]?.status).toBe("completed");
    const saved = await getTaskById(db, id);
    expect(saved?.targetRoomId).toBeTruthy();
    expect(saved?.scopeId).toBeTruthy();
    expect(saved?.targetRoomId).toBe(parkedTask?.targetRoomId);
    expect(saved?.scopeId).toBe(parkedTask?.scopeId);
    expect(saved?.localExecutionDelegation).toEqual(delegation);
    expect(sourceChecks).toBeGreaterThan(0);
  } finally {
    await observer.stop();
    setTaskLocalExecutionSourceComposition(undefined);
    setRelayRegistry(null);
  }
});
