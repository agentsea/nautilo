import { describe, test, expect } from "bun:test";
import type { AIMessage } from "@langchain/core/messages";
import { appendTranscriptMessages } from "@nautilo/agent";
import { tasks, taskRuns, type DirectDatabase, type Task } from "@nautilo/db";
import type { ServerEvent } from "@nautilo/types";
import { stopTask } from "../../src/tasks/lifecycle";
import {
  renderDelegatedTaskFailureReceipt,
  reportBackTaskCancellation,
  reportBackTaskCompletion,
  reportBackTaskDispatchError,
  reportBackTaskError,
  shouldSpeakTaskReportBack,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT,
  SAFE_DELEGATED_TASK_FAILURE_RESULT,
  SAFE_TASK_CANCELLED_RESULT,
  type ReportBackDeps,
  SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT,
  SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT,
  SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT,
} from "../../src/tasks/report-back";

/**
 * DB-free unit coverage for the M143 report-back finalizer's status-routing +
 * event-emission contract. The `wake` / `raw` delivery branches (which hit
 * `appendTranscriptMessages` / `JobManager`) are exercised by the live-PG
 * integration suite; here `calling_room_id` is null (silent task) so the
 * finalizer never touches the delivery path — letting us assert the terminal
 * status writes + owner-scoped `task.*` events with only a fake `db`.
 */

interface SetCall {
  table: "tasks" | "task_runs" | "other";
  payload: Record<string, unknown>;
}

function fakeDb(
  taskRow: Task | undefined,
  runStatus = "running",
  runResultText: string | null = null,
  runLastError: string | null = null,
  hasRun = true,
): {
  db: DirectDatabase;
  setCalls: SetCall[];
} {
  const setCalls: SetCall[] = [];
  const runRow = {
    id: "run-1",
    taskId: "task-1",
    graphThreadId: "subagent:task:unit",
    status: runStatus,
    jobId: null,
    resultText: runResultText,
    lastError: runLastError,
  };
  const tableName = (t: unknown): SetCall["table"] =>
    t === tasks ? "tasks" : t === taskRuns ? "task_runs" : "other";
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: DirectDatabase) => Promise<unknown>) =>
      fn(db as unknown as DirectDatabase),
    update: (t: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        setCalls.push({ table: tableName(t), payload });
        return {
          where: () => ({
            returning: async () => [
              t === tasks
                ? { ...taskRow, ...payload }
                : { ...runRow, ...payload },
            ],
          }),
        };
      },
    }),
    select: () => ({
      from: (t: unknown) => {
        const rows = t === tasks
          ? (taskRow ? [taskRow] : [])
          : hasRun
            ? [runRow]
            : [];
        const query = {
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          for: async () => rows,
        };
        return query;
      },
    }),
  };
  return { db: db as unknown as DirectDatabase, setCalls };
}

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
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

describe("M143 — report-back finalizer (silent + event routing)", () => {
  const resolveCallingRoomGraphThreadId = async (): Promise<string> =>
    "room:room-1";

  test("only ask_peer report-back is TTS-eligible", () => {
    expect(shouldSpeakTaskReportBack(baseTask({
      preset: "ask_peer",
    }))).toBe(true);
    expect(shouldSpeakTaskReportBack(baseTask({
      preset: "in_background",
    }))).toBe(false);
  });

  test("completion (non-cron, silent): run + task marked completed, task.completed owner-scoped", async () => {
    const { db, setCalls } = fakeDb(baseTask());
    const events: ServerEvent[] = [];
    await reportBackTaskCompletion(
      { db, emit: (e) => events.push(e) },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        resultText: "result text",
      },
    );

    // run row → completed (with resultText), task row → completed.
    const runStatus = setCalls.find((c) => c.table === "task_runs");
    const taskStatus = setCalls.find((c) => c.table === "tasks");
    expect(runStatus?.payload["status"]).toBe("completed");
    expect(runStatus?.payload["resultText"]).toBe("result text");
    expect(taskStatus?.payload["status"]).toBe("completed");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task.completed",
      taskId: "task-1",
      taskRunId: "run-1",
      status: "completed",
      ownerId: "owner-1",
    });
  });

  test("completion (cron): task NOT marked completed, event status pending", async () => {
    const { db, setCalls } = fakeDb(baseTask({ scheduleKind: "cron" }));
    const events: ServerEvent[] = [];
    await reportBackTaskCompletion(
      { db, emit: (e) => events.push(e) },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "cron",
        resultText: "x",
      },
    );
    // No write to the tasks table (the observer reschedules cron rows).
    expect(setCalls.some((c) => c.table === "tasks")).toBe(false);
    expect(events[0]).toMatchObject({
      type: "task.completed",
      status: "pending",
    });
  });

  test("identical silent same-terminal retry does not duplicate the terminal event", async () => {
    const { db, setCalls } = fakeDb(
      baseTask({ status: "completed" }),
      "completed",
      "retry",
    );
    const events: ServerEvent[] = [];
    await reportBackTaskCompletion(
      { db, emit: (e) => events.push(e) },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        resultText: "retry",
      },
    );

    // The exact durable terminal pair is accepted without rewriting status,
    // but a successful prior terminalization does not emit again.
    expect(setCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("completion suppresses a cancelled Task + run pair", async () => {
    const { db, setCalls } = fakeDb(
      baseTask({ status: "cancelled" }),
      "cancelled",
    );
    const events: ServerEvent[] = [];
    await reportBackTaskCompletion(
      { db, emit: (e) => events.push(e) },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        resultText: "stale",
      },
    );

    expect(setCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("stable raw delivery emits one Room row and dedupes a same-terminal retry", async () => {
    const messageIds: Array<string | undefined> = [];
    const appendMetadata: unknown[] = [];
    let inserted = false;
    const append = (async (
      ...args: Parameters<typeof appendTranscriptMessages>
    ) => {
      const message = args[3][0] as AIMessage;
      messageIds.push(message.id);
      appendMetadata.push(args[4]?.metadata);
      if (inserted)
        return { failedIndices: [], insertedCount: 0, insertedRows: [] };
      inserted = true;
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [
          {
            id: "91",
            role: "assistant",
            content: "Codex result",
            fingerprint: null,
            replyToMessageId: null,
          },
        ],
      };
    }) as typeof appendTranscriptMessages;
    const rawTask = baseTask({
      callingRoomId: "room-1",
      resultDelivery: "raw",
      metadata: { execution: { harnessId: "codex" } },
    });
    const first = fakeDb(rawTask);
    const retry = fakeDb(
      { ...rawTask, status: "completed" } as Task,
      "completed",
      "Codex result",
    );
    const events: ServerEvent[] = [];
    const args = {
      taskId: "task-1",
      runId: "run-1",
      scheduleKind: "now",
      resultText: "Codex result",
    } as const;

    await reportBackTaskCompletion(
      {
        db: first.db,
        append,
        emit: (e) => events.push(e),
        resolveCallingRoomGraphThreadId,
      },
      args,
    );
    await reportBackTaskCompletion(
      {
        db: retry.db,
        append,
        emit: (e) => events.push(e),
        resolveCallingRoomGraphThreadId,
      },
      args,
    );

    expect(messageIds).toEqual(["task-result:run-1", "task-result:run-1"]);
    expect(appendMetadata[0]).toEqual({
      originatedBy: "harness_task_result",
      taskId: "task-1",
      taskRunId: "run-1",
      authorHarnessId: "codex",
      delegatedByAgentId: "agent-1",
    });
    expect(events.filter((event) => event.type === "message.new")).toEqual([
      {
        type: "message.new",
        laneKey: "room:room-1",
        messageId: "91",
        role: "ai",
        content: "Codex result",
        authorAgentId: "agent-1",
        authorHarnessId: "codex",
      },
    ]);
    expect(
      first.setCalls.find((call) => call.table === "task_runs")?.payload[
        "resultText"
      ],
    ).toBe("Codex result");
    expect(
      events.filter((event) => event.type === "task.completed"),
    ).toHaveLength(1);
  });

  test("same-terminal retry with conflicting text fails closed", async () => {
    const rawTask = baseTask({
      callingRoomId: "room-1",
      resultDelivery: "raw",
      status: "completed",
    });
    const retry = fakeDb(rawTask, "completed", "durable result");
    let appendCalls = 0;
    const append = (async () => {
      appendCalls += 1;
      return { failedIndices: [], insertedCount: 0, insertedRows: [] };
    }) as typeof appendTranscriptMessages;
    const events: ServerEvent[] = [];

    await reportBackTaskCompletion(
      { db: retry.db, append, emit: (event) => events.push(event) },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        resultText: "conflicting result",
      },
    );

    expect(appendCalls).toBe(0);
    expect(events).toEqual([]);
  });

  test("error (non-cron): run errored + task errored, task.errored owner-scoped", async () => {
    const { db, setCalls } = fakeDb(baseTask());
    const events: ServerEvent[] = [];
    await reportBackTaskError(
      { db, emit: (e) => events.push(e) },
      { taskId: "task-1", runId: "run-1", scheduleKind: "now", error: "boom" },
    );
    const runStatus = setCalls.find((c) => c.table === "task_runs");
    const taskStatus = setCalls.find((c) => c.table === "tasks");
    expect(runStatus?.payload["status"]).toBe("errored");
    expect(runStatus?.payload["lastError"]).toBe("boom");
    expect(taskStatus?.payload["status"]).toBe("errored");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task.errored",
      taskId: "task-1",
      taskRunId: "run-1",
      status: "errored",
      ownerId: "owner-1",
    });
  });

  test("error (cron): task NOT marked errored, event status pending", async () => {
    const { db, setCalls } = fakeDb(baseTask({ scheduleKind: "cron" }));
    const events: ServerEvent[] = [];
    await reportBackTaskError(
      { db, emit: (e) => events.push(e) },
      { taskId: "task-1", runId: "run-1", scheduleKind: "cron", error: "boom" },
    );
    expect(setCalls.some((c) => c.table === "tasks")).toBe(false);
    expect(events[0]).toMatchObject({
      type: "task.errored",
      status: "pending",
    });
  });

  test("legacy error report-back with a calling Room remains byte-for-byte terminal-only", async () => {
    const rawTask = baseTask({
      callingRoomId: "room-1",
      resultDelivery: "raw",
    });
    const { db, setCalls } = fakeDb(rawTask);
    const events: ServerEvent[] = [];
    let appendCalls = 0;
    const append = (async () => {
      appendCalls += 1;
      return { failedIndices: [], insertedCount: 0, insertedRows: [] };
    }) as typeof appendTranscriptMessages;

    await reportBackTaskError(
      { db, append, emit: (event) => events.push(event) },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "LEGACY_FAILURE",
      },
    );

    expect(appendCalls).toBe(0);
    expect(events).toEqual([
      {
        type: "task.errored",
        taskId: "task-1",
        taskRunId: "run-1",
        status: "errored",
        ownerId: "owner-1",
      },
    ]);
    expect(setCalls.map((call) => call.payload["lastError"])).toContain(
      "LEGACY_FAILURE",
    );
  });

  test("opt-in safe raw failure posts one fixed assistant receipt after terminalization without changing the durable error", async () => {
    const rawTask = baseTask({
      callingRoomId: "room-1",
      resultDelivery: "raw",
    });
    const { db, setCalls } = fakeDb(rawTask);
    const events: ServerEvent[] = [];
    const messages: string[] = [];
    const append = (async (
      ...args: Parameters<typeof appendTranscriptMessages>
    ) => {
      const content = (args[3][0] as AIMessage).content;
      if (typeof content !== "string")
        throw new Error("expected fixed string failure receipt");
      messages.push(content);
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [
          {
            id: "failure-row",
            role: "assistant",
            content: SAFE_DELEGATED_TASK_FAILURE_RESULT,
            fingerprint: null,
            replyToMessageId: null,
          },
        ],
      };
    }) as typeof appendTranscriptMessages;

    await reportBackTaskError(
      {
        db,
        append,
        emit: (event) => events.push(event),
        resolveCallingRoomGraphThreadId,
      },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "ACP_EXECUTION_FAILED",
        failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT,
      },
    );

    expect(messages).toEqual([SAFE_DELEGATED_TASK_FAILURE_RESULT]);
    expect(
      setCalls.find((call) => call.table === "tasks")?.payload,
    ).toMatchObject({ status: "errored", lastError: "ACP_EXECUTION_FAILED" });
    expect(
      setCalls.find((call) => call.table === "task_runs")?.payload,
    ).toMatchObject({ status: "errored", lastError: "ACP_EXECUTION_FAILED" });
    expect(events).toEqual([
      {
        type: "message.new",
        laneKey: "room:room-1",
        messageId: "failure-row",
        role: "ai",
        content: SAFE_DELEGATED_TASK_FAILURE_RESULT,
        authorAgentId: "agent-1",
      },
      {
        type: "task.errored",
        taskId: "task-1",
        taskRunId: "run-1",
        status: "errored",
        ownerId: "owner-1",
      },
    ]);
  });

  test("Writer session admission failure is an allowed fixed raw receipt", async () => {
    const { db } = fakeDb(baseTask({
      callingRoomId: "room-1",
      resultDelivery: "raw",
    }));
    const messages: string[] = [];
    const append = (async (...args: Parameters<typeof appendTranscriptMessages>) => {
      const content = (args[3][0] as AIMessage).content;
      if (typeof content === "string") messages.push(content);
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [{
          id: "writer-session-failure-row",
          role: "assistant",
          content,
          fingerprint: null,
          replyToMessageId: null,
        }],
      };
    }) as typeof appendTranscriptMessages;

    await reportBackTaskError(
      { db, append, resolveCallingRoomGraphThreadId },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "LIVE_MINI_APP_SESSION_UNAVAILABLE",
        failureResultText: SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT,
      },
    );

    expect(messages).toEqual([SAFE_LIVE_MINI_APP_SESSION_UNAVAILABLE_RESULT]);
  });

  test("Writer reread-gate failures deliver their fixed raw receipt and preserve the exact durable error", async () => {
    for (const failureResultText of [
      SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT,
      SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT,
    ] as const) {
      const { db, setCalls } = fakeDb(baseTask({
        callingRoomId: "room-1",
        resultDelivery: "raw",
      }));
      const messages: string[] = [];
      const append = (async (...args: Parameters<typeof appendTranscriptMessages>) => {
        const content = (args[3][0] as AIMessage).content;
        if (typeof content === "string") messages.push(content);
        return {
          failedIndices: [],
          insertedCount: 1,
          insertedRows: [{
            id: `writer-reread-raw-${messages.length}`,
            role: "assistant",
            content,
            fingerprint: null,
            replyToMessageId: null,
          }],
        };
      }) as typeof appendTranscriptMessages;

      await reportBackTaskError(
        { db, append, resolveCallingRoomGraphThreadId },
        {
          taskId: "task-1",
          runId: "run-1",
          scheduleKind: "now",
          error: "LIVE_WRITER_VERIFICATION_INCOMPLETE",
          failureResultText,
        },
      );

      expect(messages).toEqual([failureResultText]);
      expect(setCalls.find((call) => call.table === "tasks")?.payload).toMatchObject({
        status: "errored",
        lastError: "LIVE_WRITER_VERIFICATION_INCOMPLETE",
      });
      expect(setCalls.find((call) => call.table === "task_runs")?.payload).toMatchObject({
        status: "errored",
        lastError: "LIVE_WRITER_VERIFICATION_INCOMPLETE",
        resultText: failureResultText,
      });
    }
  });

  test("renders and durably stores a bounded OpenCode outcome with recovery guidance", async () => {
    const receipt = {
      provider: "OpenCode",
      reason: "desktop_disconnected",
      phase: "running",
      processStarted: true,
      commandActivityCount: 2,
      outputObserved: true,
      containmentRequested: true,
    } as const;
    const expected =
      "OpenCode failed because the paired desktop connection closed. OpenCode reported that its task process started. Nautilo requested containment of the task process. 2 command activity items were observed, with streamed output, and no final answer was produced. The workspace may contain partial changes; review it before retrying as a new task.";
    expect(renderDelegatedTaskFailureReceipt(receipt)).toBe(expected);
    const { db, setCalls } = fakeDb(
      baseTask({ callingRoomId: "room-1", resultDelivery: "raw" }),
    );
    const messages: string[] = [];
    const append = (async (
      ...args: Parameters<typeof appendTranscriptMessages>
    ) => {
      const content = (args[3][0] as AIMessage).content;
      if (typeof content !== "string")
        throw new Error("expected bounded outcome");
      messages.push(content);
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [
          {
            id: "failure-row",
            role: "assistant",
            content,
            fingerprint: null,
            replyToMessageId: null,
          },
        ],
      };
    }) as typeof appendTranscriptMessages;

    await reportBackTaskError(
      { db, append, resolveCallingRoomGraphThreadId },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "ACP_EXECUTION_FAILED",
        failureReceipt: receipt,
      },
    );

    expect(messages).toEqual([expected]);
    expect(
      setCalls.find((call) => call.table === "task_runs")?.payload,
    ).toMatchObject({
      status: "errored",
      lastError: "ACP_EXECUTION_FAILED",
      resultText: expected,
    });
  });

  test("rejects malformed or ambiguous delegated failure receipts before a durable write", async () => {
    const { db, setCalls } = fakeDb(baseTask());
    const valid = {
      provider: "OpenCode",
      reason: "internal_failure",
      phase: "setup",
      processStarted: false,
      commandActivityCount: 0,
      outputObserved: false,
      containmentRequested: false,
    } as const;
    expect(() =>
      renderDelegatedTaskFailureReceipt({
        ...valid,
        processStarted: "yes",
      } as never),
    ).toThrow("DELEGATED_TASK_FAILURE_RECEIPT_INVALID");
    expect(() =>
      renderDelegatedTaskFailureReceipt({ ...valid, commandActivityCount: -1 }),
    ).toThrow("DELEGATED_TASK_FAILURE_RECEIPT_INVALID");
    expect(() =>
      renderDelegatedTaskFailureReceipt({ ...valid, outputObserved: true }),
    ).toThrow("DELEGATED_TASK_FAILURE_RECEIPT_INVALID");
    expect(() =>
      renderDelegatedTaskFailureReceipt({ ...valid, phase: "running" }),
    ).toThrow("DELEGATED_TASK_FAILURE_RECEIPT_INVALID");
    let ambiguity: unknown;
    try {
      await reportBackTaskError(
        { db },
        {
          taskId: "task-1",
          runId: "run-1",
          scheduleKind: "now",
          error: "ACP_EXECUTION_FAILED",
          failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT,
          failureReceipt: valid,
        },
      );
    } catch (error) {
      ambiguity = error;
    }
    expect(ambiguity).toMatchObject({
      message: "TASK_FAILURE_DELIVERY_AMBIGUOUS",
    });
    expect(setCalls).toEqual([]);
  });

  test("opt-in safe failure stays silent without a calling Room and retries an identical raw delivery with its stable transcript identity", async () => {
    let appendCalls = 0;
    const messageIds: Array<string | undefined> = [];
    const append = (async (
      ...args: Parameters<typeof appendTranscriptMessages>
    ) => {
      appendCalls += 1;
      messageIds.push((args[3][0] as AIMessage).id);
      if (appendCalls === 1) throw new Error("transient delivery failure");
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [
          {
            id: "retried-failure-row",
            role: "assistant",
            content: SAFE_DELEGATED_TASK_FAILURE_RESULT,
            fingerprint: null,
            replyToMessageId: null,
          },
        ],
      };
    }) as typeof appendTranscriptMessages;
    const silent = fakeDb(baseTask());
    await reportBackTaskError(
      { db: silent.db, append },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "ACP_EXECUTION_FAILED",
        failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT,
      },
    );
    expect(appendCalls).toBe(0);
    const first = fakeDb(
      baseTask({ callingRoomId: "room-1", resultDelivery: "raw" }),
    );
    const args = {
      taskId: "task-1",
      runId: "run-1",
      scheduleKind: "now",
      error: "ACP_EXECUTION_FAILED",
      failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT,
    } as const;
    let deliveryFailure: unknown;
    try {
      await reportBackTaskError(
        { db: first.db, append, resolveCallingRoomGraphThreadId },
        args,
      );
    } catch (error) {
      deliveryFailure = error;
    }
    expect(deliveryFailure).toMatchObject({
      message: "transient delivery failure",
    });
    const retry = fakeDb(
      baseTask({
        callingRoomId: "room-1",
        resultDelivery: "raw",
        status: "errored",
      }),
      "errored",
      SAFE_DELEGATED_TASK_FAILURE_RESULT,
      "ACP_EXECUTION_FAILED",
    );
    await reportBackTaskError(
      { db: retry.db, append, resolveCallingRoomGraphThreadId },
      {
        ...args,
      },
    );
    expect(appendCalls).toBe(2);
    expect(messageIds).toEqual(["task-result:run-1", "task-result:run-1"]);
  });

  test("opt-in safe failure suppresses a conflicting same-terminal retry", async () => {
    const retry = fakeDb(
      baseTask({
        callingRoomId: "room-1",
        resultDelivery: "raw",
        status: "errored",
      }),
      "errored",
      null,
      "ACP_EXECUTION_FAILED",
    );
    let appendCalls = 0;
    const append = (async () => {
      appendCalls += 1;
      return { failedIndices: [], insertedCount: 0, insertedRows: [] };
    }) as typeof appendTranscriptMessages;
    await reportBackTaskError(
      { db: retry.db, append },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "CONFLICTING_FAILURE",
        failureResultText: SAFE_DELEGATED_TASK_FAILURE_RESULT,
      },
    );
    expect(appendCalls).toBe(0);
  });

  test("safe worker failure honors wake delivery and identifies the terminal outcome", async () => {
    const { db } = fakeDb(baseTask({ callingRoomId: "room-1" }));
    const wakes: Array<{
      text: string;
      kind: string;
      visible: boolean;
      taskRunId: string | undefined;
    }> = [];
    const wake: NonNullable<ReportBackDeps["wake"]> = async (
      _task,
      _deliveryId,
      text,
      _threadId,
      kind,
      _continuation,
      visible,
      taskRunId,
    ) => {
      wakes.push({
        text,
        kind: kind ?? "result",
        visible: visible === true,
        taskRunId,
      });
    };

    await reportBackTaskError(
      { db, wake, resolveCallingRoomGraphThreadId },
      {
        taskId: "task-1",
        runId: "run-1",
        scheduleKind: "now",
        error: "WORKER_FAILED",
        failureResultText: SAFE_BACKGROUND_TASK_FAILURE_RESULT,
      },
    );

    expect(wakes).toEqual([
      {
        text: SAFE_BACKGROUND_TASK_FAILURE_RESULT,
        kind: "failure",
        visible: false,
        taskRunId: "run-1",
      },
    ]);
  });

  test("Writer reread-gate failures wake with only their fixed receipt after durable terminalization", async () => {
    for (const failureResultText of [
      SAFE_WRITER_REVIEW_INITIAL_READ_INCOMPLETE_RESULT,
      SAFE_WRITER_REVIEW_VERIFICATION_INCOMPLETE_RESULT,
    ] as const) {
      const { db, setCalls } = fakeDb(baseTask({ callingRoomId: "room-1", resultDelivery: "wake" }));
      const wakes: Array<{ text: string; kind: string; taskRunId: string | undefined }> = [];
      const wake: NonNullable<ReportBackDeps["wake"]> = async (
        _task,
        _deliveryId,
        text,
        _threadId,
        kind,
        _continuation,
        _visible,
        taskRunId,
      ) => {
        wakes.push({ text, kind: kind ?? "result", taskRunId });
      };

      await reportBackTaskError(
        { db, wake, resolveCallingRoomGraphThreadId },
        {
          taskId: "task-1",
          runId: "run-1",
          scheduleKind: "now",
          error: "LIVE_WRITER_VERIFICATION_INCOMPLETE",
          failureResultText,
        },
      );

      expect(wakes).toEqual([{
        text: failureResultText,
        kind: "failure",
        taskRunId: "run-1",
      }]);
      expect(setCalls.find((call) => call.table === "task_runs")?.payload).toMatchObject({
        lastError: "LIVE_WRITER_VERIFICATION_INCOMPLETE",
        resultText: failureResultText,
      });
    }
  });

  test("cancellation applies raw, wake, and raw_and_wake delivery consistently", async () => {
    const rawMessages: Array<{ id: string | undefined; content: unknown }> = [];
    const append = (async (...args: Parameters<typeof appendTranscriptMessages>) => {
      const message = args[3][0] as AIMessage;
      rawMessages.push({ id: message.id, content: message.content });
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [{
          id: `row-${rawMessages.length}`,
          role: "assistant",
          content: SAFE_TASK_CANCELLED_RESULT,
          fingerprint: null,
          replyToMessageId: null,
        }],
      };
    }) as typeof appendTranscriptMessages;
    const wakes: Array<{ delivery: string; kind: string; visible: boolean }> = [];
    const wake: NonNullable<ReportBackDeps["wake"]> = async (
      task,
      _deliveryId,
      _text,
      _threadId,
      kind,
      _continuation,
      visible,
    ) => {
      wakes.push({
        delivery: task.resultDelivery,
        kind: kind ?? "result",
        visible: visible === true,
      });
    };

    for (const resultDelivery of ["raw", "wake", "raw_and_wake"] as const) {
      const task = baseTask({
        id: `task-${resultDelivery}`,
        callingRoomId: "room-1",
        resultDelivery,
        status: "cancelled",
      });
      await reportBackTaskCancellation(
        {
          db: fakeDb(task, "cancelled").db,
          append,
          wake,
          resolveCallingRoomGraphThreadId,
        },
        task,
        `run-${resultDelivery}`,
      );
    }
    const silentTask = baseTask({ id: "task-silent", status: "cancelled" });
    await reportBackTaskCancellation(
      {
        db: fakeDb(silentTask, "cancelled").db,
        append,
        wake,
        resolveCallingRoomGraphThreadId,
      },
      silentTask,
      "run-silent",
    );

    expect(rawMessages).toEqual([
      {
        id: "task-result:cancelled:task-raw",
        content: SAFE_TASK_CANCELLED_RESULT,
      },
      {
        id: "task-result:cancelled:task-raw_and_wake",
        content: SAFE_TASK_CANCELLED_RESULT,
      },
    ]);
    expect(wakes).toEqual([
      { delivery: "wake", kind: "cancellation", visible: false },
      { delivery: "raw_and_wake", kind: "cancellation", visible: true },
    ]);
  });

  test("Stop delivers cancellation after winning the terminal transition", async () => {
    const task = baseTask({ callingRoomId: "room-1" });
    const { db } = fakeDb(task);
    const aborts: Array<{ jobId: string; reason: string | undefined; taskRun: { taskId: string; taskRunId: string } | undefined }> = [];
    const deliveries: Array<{ status: string; runId: string | undefined }> = [];

    const result = await stopTask(
      {
        db,
        jobManager: {
          abortJob: (jobId, reason, taskRun) => {
            aborts.push({ jobId, reason, taskRun });
            return true;
          },
        },
        reportBackCancellation: async (_deps, cancelledTask, runId) => {
          deliveries.push({ status: cancelledTask.status, runId });
        },
      },
      task.id,
    );

    expect(result).toMatchObject({ ok: true, status: "cancelled" });
    expect(aborts).toEqual([{ jobId: "", reason: "stop", taskRun: { taskId: task.id, taskRunId: "run-1" } }]);
    expect(deliveries).toEqual([{ status: "cancelled", runId: "run-1" }]);
  });

  test("pre-run dispatch failure terminalizes the Task and honors raw_and_wake", async () => {
    const task = baseTask({
      callingRoomId: "room-1",
      resultDelivery: "raw_and_wake",
    });
    const { db, setCalls } = fakeDb(task, "running", null, null, false);
    const messages: string[] = [];
    const wakes: string[] = [];
    const append = (async (...args: Parameters<typeof appendTranscriptMessages>) => {
      const content = (args[3][0] as AIMessage).content;
      if (typeof content !== "string") throw new Error("expected safe dispatch receipt");
      messages.push(content);
      return {
        failedIndices: [],
        insertedCount: 1,
        insertedRows: [{
          id: "dispatch-failure-row",
          role: "assistant",
          content,
          fingerprint: null,
          replyToMessageId: null,
        }],
      };
    }) as typeof appendTranscriptMessages;
    const wake: NonNullable<ReportBackDeps["wake"]> = async (
      _task,
      _deliveryId,
      text,
    ) => {
      wakes.push(text);
    };

    await reportBackTaskDispatchError(
      { db, append, wake, resolveCallingRoomGraphThreadId },
      { taskId: task.id, error: "MODEL_UNAVAILABLE" },
    );

    expect(messages).toEqual([SAFE_BACKGROUND_TASK_FAILURE_RESULT]);
    expect(wakes).toEqual([SAFE_BACKGROUND_TASK_FAILURE_RESULT]);
    expect(setCalls.find((call) => call.table === "tasks")?.payload).toMatchObject({
      status: "errored",
      lastError: "MODEL_UNAVAILABLE",
    });
    expect(setCalls.some((call) => call.table === "task_runs")).toBe(false);
  });
});
