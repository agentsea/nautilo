import { beforeEach, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";
import type { StreamEventProcessor } from "@nautilo/agent";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { readTaskPreparation, type ServerEvent } from "@nautilo/types";
import { createMaintenanceAcceptanceAuthority } from "../../src/maintenance-controller";
import { eventBus } from "../../src/event-bus";

// Exercise the real resume wrapper and real progress projection, replacing only
// graph/provider execution and persistence. This file runs in its own process.
const agent = await import("@nautilo/agent");
const dbModule = await import("@nautilo/db");
let stream: unknown[] = [];
const baseProcess = mock(async (_event: unknown) => {});
const completion = mock(async (..._args: unknown[]) => {});
const failure = mock(async (..._args: unknown[]) => {});
mock.module("@nautilo/db", () => ({ ...dbModule,
  transitionTaskApprovalExecution: async () => true,
}));
mock.module("@nautilo/agent", () => ({ ...agent,
  resumeGraphWithApproval: async (_thread: string, _approved: boolean, processor: StreamEventProcessor) => {
    for (const event of stream) await processor.process(event);
  },
  inspectTaskResumeOutcome: async () => ({ reparked: false, finalText: "Review remains recorded." }),
}));
mock.module("../../src/executors/persisting-processor", () => ({
  createPersistingProcessor: () => ({ process: baseProcess, flush: async () => {}, emit: () => {} }),
}));
mock.module("../../src/tasks/report-back", () => ({
  reportBackTaskCompletion: completion, reportBackTaskError: failure,
  SAFE_BACKGROUND_TASK_FAILURE_RESULT: "Task failed",
}));
const { runTaskApprovalResume } = await import("../../src/tasks/resume-task-approval");
const taskId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const research = { unitsTotal: 8, unitsCompleted: 2, unitsPending: 6, filesTotal: 80, filesAssigned: 40 };
const saved = { taskRunId: runId, updatedAt: "2026-09-07T12:00:00Z", stage: "waiting_model",
  activity: "checkpoint_saved", research, privateText: "MUST NOT PERSIST" };
const start = { event: "on_chat_model_start" };
const token = { event: "on_chat_model_stream" };

beforeEach(() => { stream = []; baseProcess.mockClear(); completion.mockClear(); failure.mockClear(); });

async function resume(preparation: unknown) {
  const events: Extract<ServerEvent, { type: "task.progress" }>[] = [];
  const listen = (event: ServerEvent) => { if (event.type === "task.progress") events.push(event); };
  eventBus.on(listen);
  try {
    await runTaskApprovalResume({
      task: { id: taskId, ownerId: "owner", requestorId: "owner", agentId: "agent", targetChat: "orphan",
        scheduleKind: "now", metadata: { preparation } } as unknown as Task,
      run: { id: runId, graphThreadId: "subagent:research", taskId } as TaskRun,
      kind: "prove_it", approved: true,
      invocationAuthority: createAcceptedInvocationAuthority("owner"),
      maintenanceAuthority: createMaintenanceAcceptanceAuthority(),
    }, { db: {} as DirectDatabase,
      assertInvocation: async () => {},
      assertServerFunding: async () => {},
    });
  } finally { eventBus.off(listen); }
  expect(failure).not.toHaveBeenCalled();
  expect(completion).toHaveBeenCalledTimes(1);
  expect(baseProcess.mock.calls.map(([event]) => event)).toEqual(stream);
  expect(events.every(event => event.taskId === taskId && event.taskRunId === runId && event.ownerId === "owner")).toBe(true);
  return events;
}

test("approval resume restores this run's durable work and deduplicates model chatter", async () => {
  stream = [start, token, token, token];
  const events = await resume(saved);
  expect(events).toHaveLength(2);
  expect(events[1]?.detail).toBe("Research checkpoint saved · 2/8 review units complete; 6 pending; 40/80 files assigned · Model response in progress");
  const durable = readTaskPreparation({ ...events[1]?.preparation, taskRunId: runId, updatedAt: saved.updatedAt });
  expect(durable).toMatchObject({ taskRunId: runId, activity: "checkpoint_saved", research });
  expect(JSON.stringify(durable)).not.toContain("MUST NOT PERSIST");
});

test("approval resume never adopts a different run's saved progress", async () => {
  stream = [start, token, token];
  const events = await resume({ ...saved, taskRunId: "previous-run" });
  expect(events).toHaveLength(2);
  expect(events[1]?.detail).toBe("The model is responding");
  expect(events[1]?.preparation).toEqual({ stage: "model_responding" });
});

test("accepted research receipts replace saved work and survive later model events", async () => {
  const author = { taskId, taskRunId: runId, modelId: null };
  const call = { id: "relay-checkpoint", name: "security_scan", args: { operation: "record" } };
  const messages = [new HumanMessage("Continue the audit"), new AIMessage({ content: "", tool_calls: [call] })];
  const result = new ToolMessage({ name: call.name, tool_call_id: call.id, content: JSON.stringify({
    ok: true, operation: "record", result: { codeEvidence: [], record: {
      id: "checkpoint-two", revision: 1, createdAt: saved.updatedAt, updatedAt: saved.updatedAt,
      createdBy: author, updatedBy: author, entry: { kind: "checkpoint", summary: "Export ownership traced; importer remains pending.",
        nextWork: "Trace importer", openRecordIds: ["importer"], evidenceRefs: [] },
    } },
  }) });
  stream = [{ event: "on_chain_end", name: "tools", data: {
    input: { messages, approvedToolCalls: [call] }, output: { messages: [...messages, result], approvedToolCalls: [] },
  } }, start, token, token];
  const events = await resume(saved);
  expect(events).toHaveLength(3);
  expect(events[2]?.detail).toBe("Research checkpoint saved: Model checkpoint: Export ownership traced; importer remains pending. · Model response in progress");
  expect(events[2]?.preparation).toEqual({ stage: "model_responding", activity: "checkpoint_saved", research });
  expect(JSON.stringify(events[2]?.preparation)).not.toContain("Export ownership");
});

test("resumed relay file calls expose source work before model chatter", async () => {
  stream = [{ event: "on_chain_start", name: "tools", data: { input: {
    approvedToolCalls: [{ id: "read", name: "file", args: { command: "read", path: "src/authorization.ts" } }],
  } } }, start, token, token];
  const events = await resume({ ...saved, taskRunId: "previous-run" });
  expect(events).toHaveLength(3);
  expect(events[2]?.detail).toBe("Reading source code: src/authorization.ts · Model response in progress");
  expect(events[2]?.preparation).toEqual({ stage: "model_responding", activity: "reading_source" });
});
