import { beforeEach, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";
import type { StreamEventProcessor } from "@nautilo/agent";
import type { ServerEvent } from "@nautilo/types";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { createMaintenanceAcceptanceAuthority } from "../../src/maintenance-controller";
import { eventBus } from "../../src/event-bus";

// Real Task resume, stream projection and durable append handling; only the
// provider/checkpoint and database boundary are replaced. Isolated Bun process.
const agent = await import("@nautilo/agent");
const database = await import("@nautilo/db");
const memoryAdmission = await import("../../src/memory-review/admission");
let stream: unknown[] = [];
let appendMode: "insert" | "dedup" | "partial" | "throw" = "insert";
let beforeAppendReturn: (() => void) | undefined;
let writes = 0;
const completion = mock(async (..._args: unknown[]) => {});
const failure = mock(async (..._args: unknown[]) => {});
mock.module("@nautilo/db", () => ({ ...database, transitionTaskApprovalExecution: async () => true }));
mock.module("@nautilo/agent", () => ({ ...agent,
  appendTranscriptMessages: async (_thread: string, _owner: string, _persona: string,
    messages: BaseMessage[], options: { humanTurnId?: string }) => {
    writes++;
    if (appendMode === "throw") throw new Error("synthetic append failure");
    const inserted = appendMode === "dedup" ? [] : messages.filter((_message, index) => appendMode !== "partial" || index === 0);
    beforeAppendReturn?.();
    return { failedIndices: appendMode === "partial" ? [1] : [], insertedCount: inserted.length,
      insertedRows: inserted.map((message, index) => ({ id: String(index + 1), role: AIMessage.isInstance(message) ? "assistant" : "tool", content: message.content,
        fingerprint: agent.computeMessageFingerprint(message, options.humanTurnId ? { humanTurnId: options.humanTurnId } : {}) })) };
  },
  resumeGraphWithApproval: async (_thread: string, _approved: boolean, processor: StreamEventProcessor) => {
    for (const event of stream) await processor.process(event);
  },
  inspectTaskResumeOutcome: async () => ({ reparked: false, finalText: "Confirmed Task completion" }),
}));
mock.module("../../src/memory-review/admission", () => ({
  ...memoryAdmission,
  findResumedMemoryReviewAdmission: async () => undefined,
  finishMemoryReviewTurn: async () => {}, memoryReviewCompletionState: () => "completed",
}));
mock.module("../../src/tasks/report-back", () => ({ reportBackTaskCompletion: completion,
  reportBackTaskError: failure, SAFE_BACKGROUND_TASK_FAILURE_RESULT: "Task failed" }));
const { runTaskApprovalResume } = await import("../../src/tasks/resume-task-approval");
const { createPersistingProcessor } = await import("../../src/executors/persisting-processor");
const task = { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", targetChat: "last_dm",
  targetRoomId: "room", status: "awaiting", contentRepresentation: "ordinary",
  scheduleKind: "one_shot", fundingMode: "legacy_server", metadata: {} } as Task;
const run = { id: "run", taskId: "task", graphThreadId: "subagent:checkpoint", status: "awaiting",
  fundingBinding: null, fundingPredecessorRunId: null } as TaskRun;
const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ownerId: "owner", kind: "dm" }] }) }) }) } as unknown as DirectDatabase;
const receipt = JSON.stringify({ executionId: "execution", session_id: "execution", generation: "generation",
  state: "completed", tty: false, pid: 42, exitCode: 0, signal: null, terminationScope: "owned_process_group",
  failureCode: null, expiresAt: null, resources: "released",
  output: { data: "SCHEDULED_LOCAL_OK\n", cursor: 0, nextCursor: 19, availableFrom: 0, produced: 19, gap: false, hasMore: false } });
function nodeEnd(overrides: Record<string, unknown> = {}, messages: BaseMessage[] = [new ToolMessage({
  name: "exec_command", tool_call_id: "scheduled-command", content: receipt, status: "success" })]) {
  const prior = new HumanMessage("Continue original approved Task");
  return { event: "on_chain_end", name: "tools", data: {
    input: { messages: [prior], taskRun: true, subagentRun: true, suppressToolLifecycleEvents: true,
      currentTaskId: "task", currentTaskRunId: "run", roomId: "room", agentId: "agent", turnId: "original-turn", ...overrides },
    output: { messages: [prior, ...messages] },
  } };
}
beforeEach(() => { stream = []; appendMode = "insert"; beforeAppendReturn = undefined; writes = 0;
  completion.mockClear(); failure.mockClear(); });
async function resume(taskOverride: Partial<Task> = {}, controller = new AbortController(), includeStarts = false) {
  const events: ServerEvent[] = [];
  const listen = (event: ServerEvent) => events.push(event);
  eventBus.on(listen);
  try {
    await runTaskApprovalResume({ task: { ...task, ...taskOverride }, run, kind: "prove_it", approved: true,
      invocationAuthority: createAcceptedInvocationAuthority("owner"), maintenanceAuthority: createMaintenanceAcceptanceAuthority() },
    { db, assertInvocation: async () => {}, assertServerFunding: async () => {},
      jobManager: { runResumeJobLifecycle: async (_input, work) => { await work(controller.signal); } } });
  } finally { eventBus.off(listen); }
  expect(failure).not.toHaveBeenCalled();
  return events.filter((event): event is Extract<ServerEvent, { type: "tool.start" | "tool.end" }> =>
    event.type === "tool.end" || (includeStarts && event.type === "tool.start"));
}
test("scheduled approval resume emits the exact durable command result on its original Room and turn once", async () => {
  const event = nodeEnd(); stream = [event, event];
  const ends = await resume();
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ type: "tool.end", laneKey: "room:room", authorAgentId: "agent",
    turnId: "original-turn", toolCallId: "scheduled-command", toolName: "exec_command", status: "success", result: receipt });
  expect(writes).toBe(1);
  expect(completion).toHaveBeenCalledTimes(1);
});
function assistantCalls() {
  return new AIMessage({ content: "", tool_calls: [
    { id: "later-command", name: "exec_command", args: { cmd: "python3 synthetic.py", token: "private-value" } },
    { id: "later-read", name: "write_stdin", args: { session_id: "execution" } },
  ] });
}
test("later resumed calls publish durable starts once before their exact terminal results", async () => {
  const start = { ...nodeEnd({}, [assistantCalls()]), name: "agent" };
  const end = nodeEnd({}, [new ToolMessage({ name: "exec_command", tool_call_id: "later-command", content: receipt }),
    new ToolMessage({ name: "write_stdin", tool_call_id: "later-read", content: receipt })]);
  stream = [start, start, end, end];
  const events = await resume({}, new AbortController(), true);
  expect(events.map((event) => [event.type, event.toolCallId])).toEqual([
    ["tool.start", "later-command"], ["tool.start", "later-read"],
    ["tool.end", "later-command"], ["tool.end", "later-read"],
  ]);
  expect(events.every((event) => event.laneKey === "room:room" && event.authorAgentId === "agent" && event.turnId === "original-turn")).toBe(true);
  const first = events[0];
  if (first?.type !== "tool.start") throw new Error("Missing durable start");
  expect(JSON.parse(first.argsSummary ?? "{}")).toEqual({ cmd: "python3 synthetic.py" });
  expect(first.argsSummary).not.toContain("private-value");
});
test("same durable batch preserves start-before-end order and refuses rejected assistant rows", async () => {
  const result = new ToolMessage({ name: "exec_command", tool_call_id: "later-command", content: receipt });
  stream = [nodeEnd({}, [assistantCalls(), result])];
  expect((await resume({}, new AbortController(), true)).map((event) => event.type)).toEqual(["tool.start", "tool.start", "tool.end"]);
  appendMode = "partial";
  stream = [nodeEnd({}, [result, assistantCalls()])];
  expect((await resume({}, new AbortController(), true)).map((event) => event.type)).toEqual(["tool.end"]);
});
test("assistant-call append dedup, failure, abort and foreign graph input never publish starts", async () => {
  for (const mode of ["dedup", "throw"] as const) {
    appendMode = mode; stream = [{ ...nodeEnd({}, [assistantCalls()]), name: "agent" }];
    expect(await resume({}, new AbortController(), true)).toEqual([]);
  }
  appendMode = "insert";
  for (const patch of [{ currentTaskId: "other" }, { currentTaskRunId: "other" }, { roomId: "other" },
    { agentId: "other" }, { suppressToolLifecycleEvents: false }]) {
    stream = [{ ...nodeEnd(patch, [assistantCalls()]), name: "agent" }];
    expect(await resume({}, new AbortController(), true)).toEqual([]);
  }
  stream = [{ ...nodeEnd({}, [assistantCalls()]), name: "agent" }];
  const controller = new AbortController(); beforeAppendReturn = () => controller.abort();
  expect(await resume({}, controller, true)).toEqual([]);
});
test("resumed command domain failure preserves its receipt and error status", async () => {
  const error = new ToolMessage({ name: "exec_command", tool_call_id: "failed-command", content: receipt, status: "error" });
  stream = [nodeEnd({}, [error])];
  expect((await resume())[0]).toMatchObject({ toolCallId: "failed-command", status: "error", result: receipt });
});
test("deduped, failed and cancelled durable appends cannot publish completion", async () => {
  for (const mode of ["dedup", "throw"] as const) {
    appendMode = mode; stream = [nodeEnd()];
    expect(await resume()).toEqual([]);
  }
  appendMode = "insert";
  const controller = new AbortController(); beforeAppendReturn = () => controller.abort();
  expect(await resume({}, controller)).toEqual([]);
});
test("partial append emits only inserted tool rows", async () => {
  appendMode = "partial";
  stream = [nodeEnd({}, [new ToolMessage({ name: "exec_command", tool_call_id: "inserted", content: receipt }),
    new ToolMessage({ name: "write_stdin", tool_call_id: "failed", content: receipt })])];
  const ends = await resume();
  expect(ends.map((event) => event.toolCallId)).toEqual(["inserted"]);
});
test("another Task, Run, Agent, Room or unsuppressed graph cannot borrow the Task terminal publisher", async () => {
  for (const patch of [{ currentTaskId: "other" }, { currentTaskRunId: "other" }, { agentId: "other" },
    { roomId: "other" }, { suppressToolLifecycleEvents: false }, { taskRun: false }, { subagentRun: false }, { turnId: "" }]) {
    stream = [nodeEnd(patch)]; expect(await resume()).toEqual([]);
  }
});
test("orphan and protected Tasks do not gain plaintext Room lifecycle fanout", async () => {
  stream = [{ ...nodeEnd({}, [assistantCalls()]), name: "agent" }, nodeEnd()];
  expect(await resume({ targetChat: "orphan", targetRoomId: null }, new AbortController(), true)).toEqual([]);
  expect(await resume({ contentRepresentation: "protected" }, new AbortController(), true)).toEqual([]);
  expect(await resume({ contentRepresentation: "dual" }, new AbortController(), true)).toEqual([]);
});
test("ordinary foreground processors retain existing direct invocation lifecycle without synthesis", async () => {
  const events: ServerEvent[] = [];
  const processor = createPersistingProcessor({ threadId: "foreground", ownerId: "owner", agentId: "agent",
    roomId: "room", laneKey: "room:room", eventBus: { emit: (event) => events.push(event) } });
  await processor.process({ ...nodeEnd({}, [assistantCalls()]), name: "agent" });
  await processor.process(nodeEnd());
  expect(events.filter((event) => event.type === "tool.end" || event.type === "tool.start")).toEqual([]);
});

test("Room-backed Task processors do not acquire foreground context refresh", () => {
  const processor = createPersistingProcessor({ threadId: "subagent:checkpoint", ownerId: "owner",
    agentId: "agent", roomId: "room", laneKey: "room:room", eventBus: { emit: () => {} },
    taskToolLifecycle: { taskId: "task", taskRunId: "run", isCurrent: () => true } });
  expect(processor.rebuildForegroundContext).toBeUndefined();
});
