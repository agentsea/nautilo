/**
 * Stack 208 P1 — terminal ephemeral-thread cleanup wiring in `taskRunExecutor`.
 *
 * The cleanup helper itself (`deleteEphemeralCheckpointThread` +
 * `isEphemeralCheckpointThread`) lives in `@nautilo/agent` and is unit-covered by
 * `packages/agent/tests/unit-isolated/checkpoint-compaction.test.ts`. This
 * file pins the CALL-SITE contract in `taskRunExecutor`:
 *
 *   1. On a completed run, cleanup runs with the runner result's authoritative
 *      `threadId` (a `subagent:` ephemeral thread) AFTER
 *      `reportBackTaskCompletion` — never before.
 *   2. On an `interrupted` run (awaiting / approval / PIN / identity),
 *      cleanup is NOT called — the parked checkpoint must survive resume.
 *   3. On an abort (pause/stop), cleanup is NOT called — the
 *      `signal.aborted` early-return skips report-back AND cleanup.
 *   4. On a runner error, cleanup is NOT called — only `reportBackTaskError`.
 *
 * ISOLATION: this file coexists with 71 other unit files in one `bun test`
 * process, so it does NOT `mock.module` any shared dependency. The runner is
 * short-circuited via `_setTaskRunExecutorRunnerForTests`; the cleanup via
 * `_setTaskRunCleanupFnForTests` (so no Postgres saver is constructed). The
 * Security export is intercepted at its existing test seam; the fake runner
 * does not create a real checkpoint. The production artifact builder and
 * real `reportBackTaskCompletion` run against a fake db + a silent task row
 * (`callingRoomId: null`) so no delivery / JobManager path is touched.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { tasks, taskRuns, type DirectDatabase, type Task } from "@nautilo/db";
import type { ServerEvent } from "@nautilo/types";

const { taskRunExecutor, _setTaskRunExecutorRunnerForTests, _setTaskRunCleanupFnForTests } =
  await import("../../src/tasks/task-run-executor");
const { _setSecurityReportArtifactWriterForTests, _setSecurityReportExporterForTests } =
  await import("../../src/tasks/security-report-artifact");
const { setTaskRunDb } = await import("../../src/tasks/task-runtime-context");

/** Ordered log shared with the cleanup seam + the fake db's `set` hook. */
let eventLog: string[];
let cleanupCalls: string[];
let cleanupShouldThrow: boolean;

let runnerResult:
  | { status: "completed"; threadId: string; finalText: string; finalResponseText: string; securityReportState?: "completed" | "partial" | null; securityResearchAppendix?: string | null }
  | { status: "interrupted"; threadId: string; interrupt: Record<string, unknown> };

afterAll(() => {
  _setTaskRunExecutorRunnerForTests(null);
  _setTaskRunCleanupFnForTests(null);
  _setSecurityReportArtifactWriterForTests(null);
  _setSecurityReportExporterForTests(null);
  setTaskRunDb(null);
});

beforeEach(() => {
  eventLog = [];
  cleanupCalls = [];
  cleanupShouldThrow = false;
  runnerResult = {
    status: "completed",
    threadId: "subagent:room:r1:bot:a1:run-1",
    finalText: "done",
    finalResponseText: "done",
  };
  _setTaskRunExecutorRunnerForTests(async () => runnerResult as never);
  _setTaskRunCleanupFnForTests(async (graphThreadId: string) => {
    cleanupCalls.push(graphThreadId);
    eventLog.push("cleanup");
    if (cleanupShouldThrow) throw new Error("simulated cleanup failure");
  });
  setTaskRunDb(fakeDb());
});

afterEach(() => {
  _setTaskRunExecutorRunnerForTests(null);
  _setTaskRunCleanupFnForTests(null);
  _setSecurityReportArtifactWriterForTests(null);
  _setSecurityReportExporterForTests(null);
  setTaskRunDb(null);
});

/** Fake db supporting both ordinary status writes and the serialized terminal
 *  transaction used by report-back. Records `task_runs` `completed` sets into
 *  `eventLog` so the test can assert report-back commits BEFORE cleanup. */
function fakeDb(taskRow: Task | undefined = baseTask()): DirectDatabase {
  const tableName = (t: unknown): "tasks" | "task_runs" | "other" =>
    t === tasks ? "tasks" : t === taskRuns ? "task_runs" : "other";
  const runRow = {
    id: "run-1",
    taskId: "task-1",
    graphThreadId: "subagent:room:r1:bot:a1:run-1",
    status: "running",
    jobId: "job-1",
    resultText: null,
  };
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: DirectDatabase) => Promise<unknown>) =>
      fn(db as unknown as DirectDatabase),
    update: (t: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        if (tableName(t) === "task_runs" && payload["status"] === "completed") {
          eventLog.push("reportBackCompletion");
        }
        return {
          where: () => ({
            returning: async () => [
              t === tasks ? { ...taskRow, ...payload } : { ...runRow, ...payload },
            ],
          }),
        };
      },
    }),
    select: () => ({
      from: (t: unknown) => {
        const rows = t === tasks ? (taskRow ? [taskRow] : []) : [runRow];
        const query = {
          innerJoin: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          for: async () => rows,
          then: <TResult1 = unknown, TResult2 = never>(
            onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve(rows).then(onfulfilled, onrejected),
        };
        return query;
      },
    }),
  };
  return db as unknown as DirectDatabase;
}

function baseTask(over: Partial<Task> = {}): Task {
  return ({
    id: "task-1",
    ownerId: "owner-1",
    requestorId: "owner-1",
    agentId: "agent-1",
    prompt: "do the thing",
    callingRoomId: null,
    resultDelivery: "wake",
    scheduleKind: "now",
    status: "running",
    ...over,
  }) as unknown as Task;
}

function baseInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "task-1",
    taskRunId: "run-1",
    scheduleKind: "now",
    ownerId: "owner-1",
    requestorId: "owner-1",
    agentId: "agent-1",
    roomId: "",
    graphThreadId: "subagent:room:r1:bot:a1:run-1",
    turnId: "run-1",
    parentThreadId: "task:task-1",
    modelId: "openai:stub",
    assistantName: "Genie",
    soulFile: "",
    subagentDepth: 1,
    subagentMaxDepth: 5,
    memoryAccessEnvelope: {
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    },
    ...over,
  };
}

async function drain(executor: AsyncGenerator<ServerEvent>): Promise<void> {
  for await (const _ev of executor) {
    void _ev;
  }
}

describe("taskRunExecutor — Stack 208 P1 terminal thread cleanup", () => {
  it("deletes the ephemeral subagent thread AFTER reportBackTaskCompletion on a completed run", async () => {
    await drain(taskRunExecutor(baseInput(), "job-1", "task:task-1", new AbortController().signal));

    expect(cleanupCalls).toEqual(["subagent:room:r1:bot:a1:run-1"]);
    // Ordering: report-back MUST commit before the checkpoint is deleted.
    expect(eventLog).toEqual(["reportBackCompletion", "cleanup"]);
  });

  it("writes a real security report artifact before the security Task can complete", async () => {
    runnerResult = { status: "completed", threadId: "subagent:room:r1:bot:a1:run-1", finalText: "done", finalResponseText: "done", securityReportState: "completed", securityResearchAppendix: "## Durable review log\n\nVerified accepted notes." };
    let artifactMarkdown = "";
    _setSecurityReportExporterForTests(async (input) => {
      expect(input).toMatchObject({ taskId: "task-1", taskRunId: "run-1", userId: "owner-1",
        threadId: "subagent:room:r1:bot:a1:run-1", modelId: "openai:stub" });
      await input.assertActive?.();
      eventLog.push("runtimeExport");
      return { reportState: "completed", researchAppendix: "## Durable review log\n\nVerified accepted notes." };
    });
    _setSecurityReportArtifactWriterForTests(async (input) => {
      eventLog.push("artifactWrite");
      artifactMarkdown = Buffer.from(input.bytes).toString("utf8");
      return {
        ok: true,
        artifactId: "external-report-1",
        artifactInternalId: "internal-report-1",
        displayPath: "artifacts/security-reports/security-scan-task-1-run-1.md",
        revision: 1,
        size: input.bytes.byteLength,
        sha256: "sha",
      };
    });

    await drain(taskRunExecutor(baseInput({
      toolWhitelist: ["file", "security_scan"],
      memoryAccessEnvelope: {
        ...baseInput()["memoryAccessEnvelope"] as object,
        readableNamespaces: ["room-ns"],
        mutableNamespaces: ["room-ns"],
        writableNamespaces: ["room-ns"],
      },
    }), "job-1", "task:task-1", new AbortController().signal));

    expect(artifactMarkdown).toContain("# Codebase security scan report");
    expect(artifactMarkdown).toContain("## Research report\n\ndone");
    expect(artifactMarkdown).toContain("Verified accepted notes.");
    expect(eventLog).toEqual(["runtimeExport", "artifactWrite", "reportBackCompletion", "cleanup"]);
  });

  it("fails a report-shaped refusal without writing a report or completing the scan Task", async () => {
    runnerResult = { status: "completed", threadId: "subagent:failed-scan", finalText: "blocked",
      finalResponseText: "# Security report\nPermission denied. No scan could start.", securityReportState: null };
    let writes = 0;
    _setSecurityReportExporterForTests(async () => { throw new Error("SECURITY_RESEARCH_EXPORT_NOT_SEALED"); });
    _setSecurityReportArtifactWriterForTests(async () => { writes++; throw new Error("must not write"); });
    const failure = await drain(taskRunExecutor(baseInput({ toolWhitelist: ["file", "security_scan"] }), "job-1", "task:task-1",
      new AbortController().signal)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("SECURITY_RESEARCH_EXPORT_NOT_SEALED");
    expect(writes).toBe(0);
    expect(eventLog).not.toContain("reportBackCompletion");
    expect(cleanupCalls).toEqual([]);
  });

  it("cleans the runner result thread when it differs from input.graphThreadId", async () => {
    runnerResult = {
      status: "completed",
      threadId: "subagent:generated:authoritative-thread",
      finalText: "done",
      finalResponseText: "done",
    };

    await drain(
      taskRunExecutor(
        baseInput({ graphThreadId: "subagent:input:fallback-thread" }),
        "job-1",
        "task:task-1",
        new AbortController().signal,
      ),
    );

    expect(cleanupCalls).toEqual(["subagent:generated:authoritative-thread"]);
    expect(cleanupCalls).not.toContain("subagent:input:fallback-thread");
    expect(eventLog).toEqual(["reportBackCompletion", "cleanup"]);
  });

  it("does NOT delete the checkpoint on an interrupted run (awaiting / approval / PIN / identity)", async () => {
    runnerResult = {
      status: "interrupted",
      threadId: "subagent:room:r1:bot:a1:run-1",
      // A non-approval interrupt → emitTaskInterruptEvent stays silent (null),
      // so this branch only writes the awaiting status via the fake db.
      interrupt: { type: "await_human_reply" },
    };
    await drain(taskRunExecutor(baseInput(), "job-1", "task:task-1", new AbortController().signal));

    expect(cleanupCalls).toHaveLength(0);
    expect(eventLog).not.toContain("reportBackCompletion");
  });

  it("does NOT delete the checkpoint on a pause/stop abort (signal.aborted)", async () => {
    const ac = new AbortController();
    ac.abort();
    await drain(taskRunExecutor(baseInput(), "job-1", "task:task-1", ac.signal));

    // The aborted early-return skips BOTH report-back and cleanup.
    expect(cleanupCalls).toHaveLength(0);
    expect(eventLog).not.toContain("reportBackCompletion");
  });

  it("does NOT delete the checkpoint on a runner error (only reportBackTaskError runs)", async () => {
    _setTaskRunExecutorRunnerForTests(async () => {
      throw new Error("runner exploded");
    });
    let threw: Error | undefined;
    try {
      await drain(taskRunExecutor(baseInput(), "job-1", "task:task-1", new AbortController().signal));
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(threw?.message).toBe("runner exploded");

    expect(cleanupCalls).toHaveLength(0);
    expect(eventLog).not.toContain("reportBackCompletion");
  });

  it("does NOT delete a non-ephemeral result thread (call-site guard refuses unknown shapes)", async () => {
    runnerResult = {
      status: "completed",
      threadId: "room:r1:bot:a1",
      finalText: "done",
      finalResponseText: "done",
    };
    await drain(
      taskRunExecutor(
        baseInput({ graphThreadId: "subagent:input:ephemeral" }),
        "job-1",
        "task:task-1",
        new AbortController().signal,
      ),
    );

    // report-back still ran (the task succeeded), but cleanup is refused for
    // the canonical foreground room thread returned by the runner.
    expect(eventLog).toContain("reportBackCompletion");
    expect(cleanupCalls).toHaveLength(0);
  });
});
