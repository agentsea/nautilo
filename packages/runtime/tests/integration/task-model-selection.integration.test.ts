/**
 * Multi-axis model selection at the dispatch seam, against real Postgres
 * + a stub graph. The shared test bootstrap defaults to the disposable
 * `test-cruft` database:
 *
 *   bun test --timeout 120000 \
 *     packages/runtime/tests/integration/task-model-selection.integration.test.ts
 *
 * SAFETY: unlike the other task-observer suites, this does NOT wipe the `tasks`
 * table and does NOT tick the GLOBAL observer (which would claim + fire
 * unrelated pending tasks). It seeds ONE task owned by a throwaway fixture
 * user and dispatches THAT task directly via `dispatchTaskRun`, mirroring the
 * observer's own `try/catch → markTaskErrored` path (task-observer.ts) for the
 * error case. All fixture rows are cleaned up (cascade on user delete). Never
 * point this suite at the protected populated QA source or a default instance.
 *
 * The pure resolver is exhaustively unit-tested in `@nautilo/agent`
 * (`tests/unit/resolve-task-model.test.ts`). This suite proves the two
 * end-to-end signals the unit tests cannot:
 *
 *  - **modelId persistence**: a `cheapest` task's resolved model id is written
 *    onto the `task_runs.model_id` column the dispatch seam inserts.
 *  - **S5 (dispatch-time guard, A8)**: a task whose ABSOLUTE floor cannot be
 *    satisfied by any configured model is marked `status='errored'` with the
 *    clear `[task-model-selection] …` message, instead of silently running.
 *
 * Provider keys are pinned deterministically (ANTHROPIC + FIREWORKS) so the
 * eligible pool — and therefore the chosen model — is stable regardless of the
 * operator's real environment. NAUTILO_TEST_MODE=stub means no real provider
 * call is ever made; the pinned keys only shape `resolveTaskModel`'s pool.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  insertTaskRun,
  markTaskErrored,
  updateTask,
  upsertRoomAgentModelControlSelection,
  resetRoomAgentModelControlSelection,
  eq,
  jobs,
  profiles,
  type DirectDatabase,
  type NewTask,
} from "@nautilo/db";
import {
  __setStubModelForTests,
  getRelayRegistry,
  setAgentEventSink,
  setRelayRegistry,
  type RunScopeSubagentOpts,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import { eventBus } from "../../src/event-bus";
import { dispatchTaskRun, type TaskJobManager } from "../../src/tasks/dispatch-task-run";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";
import {
  taskRunExecutor,
  _setTaskRunExecutorRunnerForTests,
} from "../../src/tasks/task-run-executor";
import {
  SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT,
  SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT,
} from "../../src/tasks/report-back";
import {
  registerTaskReturnBinding,
  registerTaskLiveMiniAppBinding,
  registerTaskWriterReviewProposal,
  recordTaskWriterReviewReadCoverage,
  taskReturnBindingRegistryForTests,
} from "../../src/tasks/task-return-binding";
import {
  cleanupTestUser,
  closeDirectDb,
  createTestRoom,
  getDirectDb,
  setupTestDb,
} from "./helpers";
import {
  setupAgentTestEnv,
  closeAgentDb,
  registerIntegrationTestTool,
} from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

// With only ANTHROPIC + FIREWORKS credentials, the cheapest CONFIGURED model is
// Fireworks DeepSeek V4.1 Flash. Keep this assertion explicit: the integration
// contract is that the dispatch seam persists the resolver's selected route,
// not merely that it writes some Fireworks id.
const CHEAPEST_FIREWORKS_MODEL =
  "fireworks:accounts/fireworks/models/deepseek-v4p1-flash";
const WRITER_LIVE_TASK_TOOL_FIXTURES = [
  "edit-open-writer",
  "read-open-writer-range",
  "locate-open-writer-text",
] as const;
const WRITER_LIVE_TASK_ACTIVATION_FIXTURES = [
  "app_nautilo_writer__edit_open_writer",
  "app_nautilo_writer__read_open_writer_range",
  "app_nautilo_writer__locate_open_writer_text",
] as const;

const SELECTION_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
  "VENICE_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

let userId: string;
let agentId: string;
let db: DirectDatabase;
const stubJobManager: TaskJobManager = {
  createForegroundJob: async () => {
    const virtualJobId = `stub-job-${randomUUID()}`;
    return { id: virtualJobId, virtualJobId };
  },
};

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";

  // Pin the eligible pool deterministically: only ANTHROPIC (grade-1
  // hyperscaler) + FIREWORKS (grade-4 open-weights) have credentials.
  for (const k of SELECTION_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of SELECTION_ENV_KEYS) delete process.env[k];
  process.env["ANTHROPIC_API_KEY"] = "x";
  process.env["FIREWORKS_API_KEY"] = "x";
  process.env["NAUTILO_MODEL"] = "anthropic:claude-sonnet-4-6";

  await setupTestDb();
  const env = await setupAgentTestEnv("task-model-selection");
  for (const name of WRITER_LIVE_TASK_TOOL_FIXTURES) {
    registerIntegrationTestTool({
      name,
      factory: () => new DynamicStructuredTool({
        name,
        description: `Inert ${name} fixture; Task runner is intercepted before tool execution`,
        schema: z.object({}),
        func: async () => "unused",
      }),
      category: "documents",
      trustTier: "guest",
      impact: name.includes("read-open-writer-range") || name.includes("locate-open-writer-text")
        ? "read-only"
        : "high",
      exposure: "discoverable",
    });
  }
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  // Intentionally do not clear the shared table: cleanup stays fixture-scoped.
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  delete process.env["NAUTILO_MODEL"];
  for (const k of SELECTION_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setAgentEventSink(null);
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

afterEach(() => {
  taskReturnBindingRegistryForTests.clear();
  setRelayRegistry(null);
});

function stub(line: string, count = 4): void {
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
    prompt: "model-selection probe",
    scheduleKind: "now",
    targetChat: "orphan",
    toolsMode: "none",
    targetUserIds: [userId],
    nextFireAt: new Date(),
    status: "pending",
    ...overrides,
  });
  return row.id;
}

/** Mirror the observer's per-task dispatch (task-observer.ts): dispatch the
 *  ONE seeded task; on a throw, mark it errored with the message — exactly as
 *  the observer's catch does. Returns the caught error message, if any. */
async function dispatchOne(taskId: string): Promise<string | null> {
  const task = await getTaskById(db, taskId);
  if (!task) throw new Error("dispatchOne: task missing");
  try {
    await dispatchTaskRun(task, { db, jobManager: stubJobManager });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markTaskErrored(db, taskId, message);
    return message;
  }
}

describe("dispatch-seam model selection (stub graph, isolated scratch PG)", () => {
  test("'cheapest' resolves + persists the lowest-cost configured model on task_runs.model_id", async () => {
    stub("MODEL-SELECTION_CHEAPEST_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      selectionProfile: "cheapest",
    });

    const err = await dispatchOne(taskId);
    expect(err).toBeNull();

    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.modelId).toBe(CHEAPEST_FIREWORKS_MODEL);
  });

  test("'balanced' (default) runs on the agent default model, not a scanned model", async () => {
    stub("MODEL-SELECTION_BALANCED_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      // selectionProfile defaults to 'balanced'
    });

    const err = await dispatchOne(taskId);
    expect(err).toBeNull();

    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(1);
    // base model = NAUTILO_MODEL default (no profile row → getDefaultModel()).
    expect(runs[0]!.modelId).toBe("anthropic:claude-sonnet-4-6");
  });

  test("an omitted model ignores the Room override, then follows the server when the Agent follows default", async () => {
    stub("MODEL-SELECTION_INHERITANCE_STUB", 8);
    const { roomId } = await createTestRoom(userId);
    await db.insert(profiles).values({
      userId,
      agentId,
      name: "Genie",
      defaultModel: CHEAPEST_FIREWORKS_MODEL,
    });
    await upsertRoomAgentModelControlSelection({
      roomId,
      agentId,
      selection: { modelId: "fireworks:accounts/fireworks/models/kimi-k3" },
    }, db);

    try {
      const savedAgentTaskId = await insertTask({
        preset: "in_background",
        callingRoomId: roomId,
      });
      expect(await dispatchOne(savedAgentTaskId)).toBeNull();
      expect((await getTaskRuns(db, savedAgentTaskId))[0]?.modelId)
        .toBe(CHEAPEST_FIREWORKS_MODEL);

      await db
        .update(profiles)
        .set({ defaultModel: null })
        .where(eq(profiles.agentId, agentId));

      const followDefaultTaskId = await insertTask({
        preset: "in_background",
        callingRoomId: roomId,
      });
      expect(await dispatchOne(followDefaultTaskId)).toBeNull();
      expect((await getTaskRuns(db, followDefaultTaskId))[0]?.modelId)
        .toBe("anthropic:claude-sonnet-4-6");
    } finally {
      await resetRoomAgentModelControlSelection(roomId, agentId, db);
      await db.delete(profiles).where(eq(profiles.agentId, agentId));
    }
  });

  test("S5: an unsatisfiable absolute floor at dispatch time marks the task errored with the clear message", async () => {
    // No configured model meets privacy grade >= 9 (venice-only), so the
    // dispatch-time resolver throws before inserting a run row.
    const taskId = await insertTask({
      preset: "in_background",
      selectionProfile: "balanced",
      selectionSpec: { objective: "privacy", absoluteFloors: { privacy: 9 } },
    });

    const err = await dispatchOne(taskId);
    expect(err).toContain("[task-model-selection]");

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("errored");
    expect(task?.lastError).toContain("[task-model-selection]");

    // No run row was inserted — the guard throws before the task_runs insert.
    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(0);
  });
});

describe("exact model_id at the dispatch seam (stub graph, isolated scratch PG)", () => {
  // Capture the job input so we can assert the `exactModelSelection`
  // flag is set on an exact pin and absent on a profile/spec run.
  let capturedInput: Record<string, unknown> | null = null;
  const capturingJobManager: TaskJobManager = {
    createForegroundJob: async (
      _ownerId: string,
      _requestorId: string,
      _laneKey: string,
      input: Record<string, unknown>,
    ) => {
      capturedInput = input;
      const virtualJobId = `stub-job-${randomUUID()}`;
      return { id: virtualJobId, virtualJobId };
    },
  };

  async function dispatchCapturing(taskId: string): Promise<string | null> {
    const task = await getTaskById(db, taskId);
    if (!task) throw new Error("dispatchCapturing: task missing");
    try {
      await dispatchTaskRun(task, { db, jobManager: capturingJobManager });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markTaskErrored(db, taskId, message);
      return message;
    }
  }

  test("an exact requestedModelId pins the run model + sets the exactModelSelection job flag", async () => {
    stub("EXACT-MODEL_EXACT_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      requestedModelId: "anthropic:claude-sonnet-4-6",
    });

    const err = await dispatchCapturing(taskId);
    expect(err).toBeNull();

    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(1);
    // The pinned id reaches task_runs.model_id verbatim (same-model pin).
    expect(runs[0]!.modelId).toBe("anthropic:claude-sonnet-4-6");
    // Phase-4 flag is explicit so fallback policy is not inferred from ids.
    expect(capturedInput).toMatchObject({
      modelId: "anthropic:claude-sonnet-4-6",
      exactModelSelection: true,
    });
  });

  test("a profile/spec run does NOT set the exactModelSelection flag (regression guard)", async () => {
    stub("EXACT-MODEL_PROFILE_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      selectionProfile: "cheapest",
    });

    const err = await dispatchCapturing(taskId);
    expect(err).toBeNull();

    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.modelId).toBe(CHEAPEST_FIREWORKS_MODEL);
    // No exact pin → flag is false (not undefined-inferred).
    expect(capturedInput).toMatchObject({
      modelId: CHEAPEST_FIREWORKS_MODEL,
      exactModelSelection: false,
    });
  });

  test("revalidation failure: an exact id with no credentials at dispatch marks the task errored", async () => {
    stub("EXACT-MODEL_EXACT_MISSING_STUB");
    // openai:gpt-5.6-sol is curated but OPENAI_API_KEY is NOT pinned (only
    // ANTHROPIC + FIREWORKS are), so the dispatch-time revalidation throws
    // before inserting a run row — exactly the scheduled-task revalidation
    // failure path (a cron task whose key was revoked between fires).
    const taskId = await insertTask({
      preset: "in_background",
      requestedModelId: "openai:gpt-5.6-sol",
    });

    const err = await dispatchCapturing(taskId);
    expect(err).toContain("[task-model-selection]");
    expect(err).toContain("openai:gpt-5.6-sol");

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("errored");
    expect(task?.lastError).toContain("[task-model-selection]");

    const runs = await getTaskRuns(db, taskId);
    expect(runs.length).toBe(0);
  });
});

describe("exactModelSelection threads strict modelFallbackMode into the subagent runner", () => {
  // Capture the job input (dispatch seam) AND the RunScopeSubagentOpts
  // (executor → runner seam) so we can prove the `exactModelSelection`
  // job flag is converted to `modelFallbackMode: "none"` and threaded all the
  // way into `runScopeSubagentUntilPause` — without running the full graph.
  let capturedInput: Record<string, unknown> | null = null;
  let capturedRunnerOpts: RunScopeSubagentOpts | null = null;
  let runnerSideEffect: ((opts: RunScopeSubagentOpts) => void | Promise<void>) | null = null;
  const getCapturedInput = (): Record<string, unknown> | null => capturedInput;

  const capturingJobManager: TaskJobManager = {
    createForegroundJob: async (
      _ownerId: string,
      _requestorId: string,
      _laneKey: string,
      input: Record<string, unknown>,
    ) => {
      capturedInput = input;
      const virtualJobId = `stub-job-${randomUUID()}`;
      return { id: virtualJobId, virtualJobId };
    },
  };

  async function dispatchCapturing(taskId: string): Promise<string | null> {
    const task = await getTaskById(db, taskId);
    if (!task) throw new Error("dispatchCapturing: task missing");
    try {
      await dispatchTaskRun(task, { db, jobManager: capturingJobManager });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markTaskErrored(db, taskId, message);
      return message;
    }
  }

  beforeAll(() => {
    // Inject a capturing runner that short-circuits the subagent run and
    // records the opts the executor threaded through. Returns a completed
    // result so the executor proceeds to its (silent, orphan-task)
    // report-back path — no real graph, no provider calls.
    _setTaskRunExecutorRunnerForTests(async (opts) => {
      capturedRunnerOpts = opts;
      await runnerSideEffect?.(opts);
      return {
        status: "completed",
        threadId: "stub-thread-exact-model",
        finalText: "EXACT-MODEL_STRICT_MODE_STUB",
        finalResponseText: "EXACT-MODEL_STRICT_MODE_STUB",
      };
    });
  });

  afterAll(() => {
    // Module-level state shared across the whole runtime integration bun
    // process — MUST clear so executor-test (which drives the real executor) is
    // unaffected.
    _setTaskRunExecutorRunnerForTests(null);
  });

  beforeEach(() => {
    capturedInput = null;
    capturedRunnerOpts = null;
    runnerSideEffect = null;
  });

  async function runExecutorOnce(taskId: string): Promise<void> {
    const input = capturedInput;
    if (!input) throw new Error("runExecutorOnce: no captured job input");
    // `task_runs.job_id` is a UUID column with an FK to `jobs.id`; the
    // executor's `markTaskRunStatus(..., { jobId })` write requires a real
    // UUID that already exists in `jobs`. Seed it here, then drive the
    // executor directly with that job id.
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      ownerId: userId,
      requestorId: userId,
      type: "task",
      status: "queued",
      laneKey: `task:${taskId}`,
      input,
    });
    const gen = taskRunExecutor(
      input,
      jobId,
      `task:${taskId}`,
      new AbortController().signal,
    );
    for await (const _ev of gen) {
      // drain to completion (yields `worker.complete`)
    }
  }

  function installExactTaskRelay(input: {
    relaySessionId?: string;
    desktopSessionId?: string;
    pairingGeneration?: string;
  } = {}): void {
    const relaySessionId = input.relaySessionId ?? "task-relay-session";
    const desktopSessionId = input.desktopSessionId ?? "task-desktop-session";
    const pairingGeneration = input.pairingGeneration ?? "task-pairing-generation";
    // The task return binding and Task executor need only the narrow live
    // registry view below. The runner is intercepted before tool dispatch.
    setRelayRegistry({
      findByCapabilityForUser: () => ["task-relay"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canRunShell: true,
        canUseTerminal: true,
        canControlBrowser: false,
        currentFolderRoot: "/task-repo",
        workspaceRoot: "/task-workspace",
      }),
      getUserId: () => userId,
      getRelaySessionId: () => relaySessionId,
      getDesktopSessionId: () => desktopSessionId,
      getPairingGeneration: () => pairingGeneration,
      isRelayHeartbeatFresh: () => true,
    } as unknown as ToolRelayRegistry);
  }

  test("an exact requestedModelId run threads modelFallbackMode='none' into the runner", async () => {
    stub("EXACT-MODEL_PHASE4_EXACT_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      requestedModelId: "anthropic:claude-sonnet-4-6",
    });

    const err = await dispatchCapturing(taskId);
    expect(err).toBeNull();

    // The dispatch seam set the job flag.
    expect(capturedInput).toMatchObject({
      modelId: "anthropic:claude-sonnet-4-6",
      exactModelSelection: true,
    });

    await runExecutorOnce(taskId);

    // The executor converted the flag into the explicit strict
    // mode and threaded it into runScopeSubagentUntilPause.
    expect(capturedRunnerOpts?.modelFallbackMode).toBe("none");
  });

  test("the executor injects its server-authored TaskRun id and ignores a job-input spoof", async () => {
    stub("TASK-BINDING_TASK_RUN_IDENTITY_STUB");
    const taskId = await insertTask({ preset: "in_background" });

    expect(await dispatchCapturing(taskId)).toBeNull();
    if (!capturedInput) throw new Error("missing captured task job input");
    const taskRunId = capturedInput["taskRunId"];
    if (typeof taskRunId !== "string") throw new Error("missing server TaskRun id");

    // `currentTaskRunId` is not a dispatch or model argument. Even if an
    // untrusted coalesced job input tried to supply one, execution binds the
    // graph to the exact run id the server read before constructing the graph.
    capturedInput["currentTaskRunId"] = "spoofed-run-id";
    await runExecutorOnce(taskId);

    expect(capturedRunnerOpts?.currentTaskRunId).toBe(taskRunId);
    expect(capturedRunnerOpts?.currentTaskRunId).not.toBe("spoofed-run-id");
  });

  test("a live exact Task binding reaches the background run's host context", async () => {
    stub("TASK-BINDING_TASK_BINDING_LIVE_STUB");
    installExactTaskRelay();
    const taskId = await insertTask({ preset: "in_background" });
    const registry = getRelayRegistry();
    if (!registry) throw new Error("test relay registry missing");
    expect(registerTaskReturnBinding(taskId, {
      ownerId: userId,
      relayId: "task-relay",
      relaySessionId: "task-relay-session",
      desktopSessionId: "task-desktop-session",
      pairingGeneration: "task-pairing-generation",
      currentFolder: "/task-repo",
      workspacePath: "/task-workspace",
    }, registry as Parameters<typeof registerTaskReturnBinding>[2])).toBe(true);

    expect(await dispatchCapturing(taskId)).toBeNull();
    expect(capturedInput).toMatchObject({
      currentFolder: "/task-repo",
      workspacePath: "/task-workspace",
      taskReportBackContinuation: {
        status: "available",
        relayId: "task-relay",
        relaySessionId: "task-relay-session",
        desktopSessionId: "task-desktop-session",
        pairingGeneration: "task-pairing-generation",
      },
    });

    await runExecutorOnce(taskId);

    // `runScopeSubagentUntilPause` uses these opts to initialize graph state;
    // the existing host-admission path then revalidates this exact relay,
    // session, pairing generation, and folder for every host-scoped call.
    expect(capturedRunnerOpts).toMatchObject({
      currentFolder: "/task-repo",
      workspacePath: "/task-workspace",
      taskReportBackContinuation: {
        status: "available",
        relayId: "task-relay",
        currentFolder: "/task-repo",
        workspacePath: "/task-workspace",
      },
    });
  });

  test("missing or replaced Task bindings leave the background host context unavailable", async () => {
    stub("TASK-BINDING_TASK_BINDING_UNAVAILABLE_STUB");
    installExactTaskRelay();
    const replacedTaskId = await insertTask({ preset: "in_background" });
    const liveRegistry = getRelayRegistry();
    if (!liveRegistry) throw new Error("test relay registry missing");
    expect(registerTaskReturnBinding(replacedTaskId, {
      ownerId: userId,
      relayId: "task-relay",
      relaySessionId: "task-relay-session",
      desktopSessionId: "task-desktop-session",
      pairingGeneration: "task-pairing-generation",
      currentFolder: "/task-repo",
      workspacePath: "/task-workspace",
    }, liveRegistry as Parameters<typeof registerTaskReturnBinding>[2])).toBe(true);

    // Reconnecting a relay with the same opaque relay id but a new socket is
    // not a continuation. Dispatch must neither retain its old roots nor
    // substitute a new session.
    installExactTaskRelay({ relaySessionId: "replacement-session" });
    expect(await dispatchCapturing(replacedTaskId)).toBeNull();
    expect(capturedInput).not.toHaveProperty("currentFolder");
    expect(capturedInput).not.toHaveProperty("workspacePath");
    expect(capturedInput).not.toHaveProperty("taskReportBackContinuation");

    await runExecutorOnce(replacedTaskId);
    expect(capturedRunnerOpts).toMatchObject({
      currentFolder: "",
      workspacePath: "",
      taskReportBackContinuation: { status: "not_captured" },
    });

    const missingTaskId = await insertTask({ preset: "in_background" });
    expect(await dispatchCapturing(missingTaskId)).toBeNull();
    expect(capturedInput).not.toHaveProperty("currentFolder");
    expect(capturedInput).not.toHaveProperty("workspacePath");
    expect(capturedInput).not.toHaveProperty("taskReportBackContinuation");
  });

  test("a profile/spec run threads modelFallbackMode='agent_chain' (regression guard)", async () => {
    stub("EXACT-MODEL_PHASE4_PROFILE_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      selectionProfile: "cheapest",
    });

    const err = await dispatchCapturing(taskId);
    expect(err).toBeNull();

    expect(capturedInput).toMatchObject({
      exactModelSelection: false,
    });

    await runExecutorOnce(taskId);

    // Non-exact run stays on the default chain — fallback behavior unchanged.
    expect(capturedRunnerOpts?.modelFallbackMode).toBe("agent_chain");
  });

  test("a balanced-default run (no exact pin) defaults to agent_chain (backwards-compat)", async () => {
    stub("EXACT-MODEL_PHASE4_DEFAULT_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      // balanced default — no requestedModelId, no selectionProfile/spec.
    });

    const err = await dispatchCapturing(taskId);
    expect(err).toBeNull();

    // The dispatch seam writes the flag explicitly as `false`, so
    // the executor never sees `undefined` here — but the conversion still
    // maps false → agent_chain.
    expect(capturedInput).toMatchObject({ exactModelSelection: false });

    await runExecutorOnce(taskId);

    expect(capturedRunnerOpts?.modelFallbackMode).toBe("agent_chain");
  });

  test("a Writer live binding reaches runner opts but its token is absent from persisted Job input", async () => {
    stub("WRITER-SESSION_WRITER_LIVE_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      toolsMode: "whitelist",
      toolsWhitelist: ["read-open-writer-range"],
      metadata: { liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" } },
    });
    const context = {
      ownerId: userId,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "WRITER-SESSION_WRITER_TOKEN_MUST_NOT_PERSIST",
        sessionId: "writer-session-writer-session",
        documentVersion: { kind: "artifact_revision" as const, revision: 1 },
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(taskId, context, () => context.liveMiniAppSession)).toBe(true);
    expect(await dispatchCapturing(taskId)).toBeNull();
    expect(JSON.stringify(capturedInput)).not.toContain("WRITER-SESSION_WRITER_TOKEN_MUST_NOT_PERSIST");

    await runExecutorOnce(taskId);
    expect(capturedRunnerOpts).toMatchObject({
      activeMiniApp: { appId: "nautilo-writer" },
      liveMiniAppSession: { sessionToken: "WRITER-SESSION_WRITER_TOKEN_MUST_NOT_PERSIST" },
    });
  });

  test("an auto Writer binding seeds every admitted live schema without a whitelist", async () => {
    stub("WRITER-SESSION_WRITER_AUTO_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      toolsMode: "auto",
      metadata: { liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" } },
    });
    const context = {
      ownerId: userId,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "WRITER-SESSION_WRITER_AUTO_TOKEN_MUST_NOT_PERSIST",
        sessionId: "writer-session-writer-auto-session",
        documentVersion: { kind: "artifact_revision" as const, revision: 1 },
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(
      taskId,
      context,
      () => context.liveMiniAppSession,
      { initialActivatedToolNames: WRITER_LIVE_TASK_ACTIVATION_FIXTURES },
    )).toBe(true);
    expect(await dispatchCapturing(taskId)).toBeNull();
    expect(capturedInput).not.toHaveProperty("toolWhitelist");
    expect(JSON.stringify(capturedInput)).not.toContain("WRITER-SESSION_WRITER_AUTO_TOKEN_MUST_NOT_PERSIST");

    await runExecutorOnce(taskId);
    expect(capturedRunnerOpts?.toolWhitelist).toBeUndefined();
    expect(capturedRunnerOpts?.initialActivatedToolNames).toEqual(WRITER_LIVE_TASK_ACTIVATION_FIXTURES);
  });

  test("an accepted Writer review dispatches a bounded overall-Task verification instruction without receipt details", async () => {
    stub("WRITER-SESSION_WRITER_VERIFY_STUB");
    const taskId = await insertTask({
      prompt: "Correct every typo in the bound Writer document.",
      preset: "in_background",
      toolsMode: "whitelist",
      toolsWhitelist: ["read-open-writer-range", "edit-open-writer"],
      metadata: { liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" } },
    });

    const producingRun = await insertTaskRun(db, {
      taskId,
      graphThreadId: `writer-review-producing:${crypto.randomUUID()}`,
      status: "completed",
      resultText: "The reviewed Writer changes were accepted and saved to the document.",
      completedAt: new Date(),
    });
    await updateTask(db, taskId, {
      metadata: {
        liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
        writerReviewAcceptedReceipt: {
          version: 1,
          taskRunId: producingRun.id,
          proposalId: "WRITER-SESSION_PROPOSAL_RECEIPT_MUST_NOT_REACH_MODEL",
          acceptedResultRevision: {
            kind: "sha256",
            sha256: "WRITER-SESSION_REVISION_RECEIPT_MUST_NOT_REACH_MODEL",
          },
        },
      },
    });

    expect(await dispatchCapturing(taskId)).toBeNull();
    const messageValue = capturedInput?.["message"];
    expect(typeof messageValue).toBe("string");
    if (typeof messageValue !== "string") throw new Error("expected dispatched Task message");
    const message = messageValue;
    expect(message).toContain("Correct every typo in the bound Writer document.");
    expect(message).toContain("Human-accepted canonical Writer save");
    expect(message).toContain("report success for the overall Task");
    expect(message).not.toContain("WRITER-SESSION_RUN_RECEIPT_MUST_NOT_REACH_MODEL");
    expect(message).not.toContain("WRITER-SESSION_PROPOSAL_RECEIPT_MUST_NOT_REACH_MODEL");
    expect(message).not.toContain("WRITER-SESSION_REVISION_RECEIPT_MUST_NOT_REACH_MODEL");

    const afterVerification = await getTaskById(db, taskId);
    const acceptedReceipt = afterVerification?.metadata["writerReviewAcceptedReceipt"] as { verificationRunId?: unknown } | undefined;
    expect(typeof acceptedReceipt?.verificationRunId).toBe("string");

    await updateTask(db, taskId, { status: "pending" });
    capturedInput = null;
    expect(await dispatchCapturing(taskId)).toBeNull();
    const laterMessage = getCapturedInput()?.["message"];
    expect(typeof laterMessage).toBe("string");
    if (typeof laterMessage !== "string") throw new Error("expected later dispatched Task message");
    expect(laterMessage).toContain("Correct every typo in the bound Writer document.");
    expect(laterMessage).not.toContain("Human-accepted canonical Writer save");
  });

  async function seedAcceptedWriterVerification(): Promise<{
    taskId: string;
    documentVersion: { kind: "artifact_revision"; revision: number };
  }> {
    const documentVersion = { kind: "artifact_revision" as const, revision: 7 };
    const taskId = await insertTask({
      preset: "in_background",
      toolsMode: "whitelist",
      toolsWhitelist: ["read-open-writer-range"],
      metadata: { liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" } },
    });
    const producingRun = await insertTaskRun(db, {
      taskId,
      graphThreadId: `writer-review-producing:${crypto.randomUUID()}`,
      status: "completed",
      resultText: "accepted",
      completedAt: new Date(),
    });
    await updateTask(db, taskId, {
      metadata: {
        liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
        writerReviewAcceptedReceipt: {
          version: 1,
          taskRunId: producingRun.id,
          proposalId: `proposal:${taskId}`,
          acceptedResultRevision: documentVersion,
        },
      },
    });
    const context = {
      ownerId: userId,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: `writer-token:${taskId}`,
        sessionId: `writer-session:${taskId}`,
        documentVersion,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(taskId, context, () => context.liveMiniAppSession)).toBe(true);
    return { taskId, documentVersion };
  }

  async function seedInitialWriterRun(): Promise<{
    taskId: string;
    documentVersion: { kind: "artifact_revision"; revision: number };
    sessionId: string;
  }> {
    const documentVersion = { kind: "artifact_revision" as const, revision: 8 };
    const taskId = await insertTask({
      preset: "in_background",
      toolsMode: "whitelist",
      toolsWhitelist: ["read-open-writer-range", "edit-open-writer"],
      metadata: { liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" } },
    });
    const sessionId = `writer-initial-session:${taskId}`;
    const context = {
      ownerId: userId,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: `writer-initial-token:${taskId}`,
        sessionId,
        documentVersion,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(taskId, context, () => context.liveMiniAppSession)).toBe(true);
    return { taskId, documentVersion, sessionId };
  }

  test("an initial Writer run without a canonical reread cannot report ordinary Task success", async () => {
    stub("WRITER-SESSION_WRITER_INITIAL_NO_REREAD_STUB");
    const { taskId } = await seedInitialWriterRun();
    expect(await dispatchCapturing(taskId)).toBeNull();
    expect(capturedInput?.["writerReviewVerification"]).toBeUndefined();

    await runExecutorOnce(taskId);
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("errored");
    expect(task?.lastError).toBe("LIVE_WRITER_VERIFICATION_INCOMPLETE");
    const runs = await getTaskRuns(db, taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.resultText).toBe(SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT);
  });

  test("a complete initial Writer reread may take the ordinary no-review success path", async () => {
    stub("WRITER-SESSION_WRITER_INITIAL_FULL_REREAD_STUB");
    const { taskId, documentVersion } = await seedInitialWriterRun();
    expect(await dispatchCapturing(taskId)).toBeNull();
    runnerSideEffect = (opts) => {
      expect(recordTaskWriterReviewReadCoverage({
        taskId,
        taskRunId: opts.currentTaskRunId!,
        ownerId: userId,
        coverage: {
          kind: "block_range",
          documentVersion,
          blockCount: 2,
          blockIndexes: [0, 1],
        },
      })).toBe(true);
    };

    await runExecutorOnce(taskId);
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("completed");
  });

  test("an initial Writer proposal still parks for review rather than applying the no-review coverage gate", async () => {
    stub("WRITER-SESSION_WRITER_INITIAL_PROPOSAL_PARKS_STUB");
    const { taskId, documentVersion, sessionId } = await seedInitialWriterRun();
    expect(await dispatchCapturing(taskId)).toBeNull();
    runnerSideEffect = (opts) => {
      expect(registerTaskWriterReviewProposal({
        taskId,
        taskRunId: opts.currentTaskRunId!,
        ownerId: userId,
        sessionId,
        proposalId: `proposal:${taskId}`,
        documentVersion,
      })).toBe(true);
    };

    await runExecutorOnce(taskId);
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("awaiting");
    expect(task?.lastError).toBeNull();
  });

  test("an accepted Writer verification without a reread cannot report ordinary Task success", async () => {
    stub("WRITER-SESSION_WRITER_NO_REREAD_STUB");
    const { taskId } = await seedAcceptedWriterVerification();
    expect(await dispatchCapturing(taskId)).toBeNull();
    expect(capturedInput?.["writerReviewVerification"]).toBe(true);

    await runExecutorOnce(taskId);
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("errored");
    expect(task?.lastError).toBe("LIVE_WRITER_VERIFICATION_INCOMPLETE");
    const runs = await getTaskRuns(db, taskId);
    expect(runs).toHaveLength(2);
    expect(runs.at(-1)?.resultText).toBe(SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT);
  });

  test("only a full reread of the accepted version lets the same Task verification complete", async () => {
    stub("WRITER-SESSION_WRITER_FULL_REREAD_STUB");
    const { taskId, documentVersion } = await seedAcceptedWriterVerification();
    expect(await dispatchCapturing(taskId)).toBeNull();
    runnerSideEffect = (opts) => {
      expect(recordTaskWriterReviewReadCoverage({
        taskId,
        taskRunId: opts.currentTaskRunId!,
        ownerId: userId,
        coverage: {
          kind: "block_range",
          documentVersion,
          blockCount: 2,
          blockIndexes: [0, 1],
        },
      })).toBe(true);
    };

    await runExecutorOnce(taskId);
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("completed");
  });

  test("a partial or wrong-version reread remains a truthful verification failure", async () => {
    stub("WRITER-SESSION_WRITER_PARTIAL_REREAD_STUB");
    const { taskId, documentVersion } = await seedAcceptedWriterVerification();
    expect(await dispatchCapturing(taskId)).toBeNull();
    runnerSideEffect = (opts) => {
      expect(recordTaskWriterReviewReadCoverage({
        taskId,
        taskRunId: opts.currentTaskRunId!,
        ownerId: userId,
        coverage: {
          kind: "block_range",
          documentVersion: { ...documentVersion, revision: documentVersion.revision - 1 },
          blockCount: 2,
          blockIndexes: [0, 1],
        },
      })).toBe(false);
      expect(recordTaskWriterReviewReadCoverage({
        taskId,
        taskRunId: opts.currentTaskRunId!,
        ownerId: userId,
        coverage: { kind: "block_range", documentVersion, blockCount: 2, blockIndexes: [0] },
      })).toBe(true);
    };

    await runExecutorOnce(taskId);
    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe("errored");
    expect(task?.lastError).toBe("LIVE_WRITER_VERIFICATION_INCOMPLETE");
  });

  test("a closed Writer live binding reports safely without calling the runner", async () => {
    stub("WRITER-SESSION_WRITER_CLOSED_STUB");
    const taskId = await insertTask({
      preset: "in_background",
      toolsMode: "whitelist",
      toolsWhitelist: ["edit-open-writer"],
      metadata: { liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" } },
    });
    const context = {
      ownerId: userId,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: "closed-token",
        sessionId: "closed-session",
        documentVersion: { kind: "artifact_revision" as const, revision: 1 },
        instructions: "Writer",
      },
    };
    let open = true;
    expect(registerTaskLiveMiniAppBinding(taskId, context, () => open ? context.liveMiniAppSession : null)).toBe(true);
    expect(await dispatchCapturing(taskId)).toBeNull();
    open = false;

    await runExecutorOnce(taskId);
    expect(capturedRunnerOpts).toBeNull();
    const task = await getTaskById(db, taskId);
    expect(task?.lastError).toBe("LIVE_MINI_APP_SESSION_UNAVAILABLE");
  });
});
