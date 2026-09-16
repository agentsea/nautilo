import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { SECURITY_SCAN_INITIAL_LANES } from "@nautilo/types";
import { serializeNoProgressKey } from "../../src/graph/no-progress";
import { isRecoverableResearchContextBudgetStop } from "../../src/runtime/research-context-budget-recovery";
import type { NautiloState } from "../../src/agent/state";
import { taskContinuationResumeCommand } from "../../src/runtime/task-continuation-resume";
import type { TaskReportBackContinuation } from "../../src/runtime/task-report-back-continuation";

const original = { status: "available" as const, relayId: "relay", relaySessionId: "old-socket", desktopSessionId: "desktop",
  pairingGeneration: "pair", currentFolder: "/repo", workspacePath: "/workspace", bindingCapturedAt: 1000 };
const expected = { taskId: "task", taskRunId: "run", ownerId: "owner", graphThreadId: "graph",
  continuation: { ...original, relaySessionId: "new-socket" } };
const identity = { taskRun: true, currentTaskId: "task", currentTaskRunId: "run", userId: "owner", langgraphThreadId: "graph",
  taskReportBackContinuation: original };

test("transport-only Command resumes pending tool work after graph reconstruction without replay or message replacement", async () => {
  const State = Annotation.Root({
    state: Annotation<Partial<NautiloState>>({ reducer: (_, next) => next }),
    taskReportBackContinuation: Annotation<TaskReportBackContinuation>({ reducer: (_, next) => next }),
    completed: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  });
  const saver = new MemorySaver();
  let starts = 0; let firstCalls = 0; let secondCalls = 0; let stopBeforeSecond = true;
  const messages = [new HumanMessage("Audit the repository completely."), new AIMessage({ content: "Saved investigation notes.",
    tool_calls: [{ id: "first", name: "file", args: { command: "read", path: "one.ts" } },
      { id: "second", name: "file", args: { command: "read", path: "two.ts" } }] })];
  const makeGraph = () => new StateGraph(State)
    .addNode("begin", () => { starts++; return {}; })
    .addNode("tools", (state) => {
      if (!state.completed.includes("first")) {
        firstCalls++;
        return { completed: ["first"], state: { ...state.state, messages: [...state.state.messages!,
          new ToolMessage({ tool_call_id: "first", name: "file", content: "EXACT SOURCE 🦀" })] } };
      }
      if (stopBeforeSecond) throw new Error("server-stopped-before-second-dispatch");
      expect(state.taskReportBackContinuation.relaySessionId).toBe("new-socket");
      secondCalls++;
      return { completed: ["first", "second"], state: { ...state.state, messages: [...state.state.messages!,
        new ToolMessage({ tool_call_id: "second", name: "file", content: "SECOND EXACT SOURCE" })] } };
    }).addEdge(START, "begin").addEdge("begin", "tools")
    .addConditionalEdges("tools", (state) => state.completed.length === 2 ? END : "tools")
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: "graph" } };
  const failure: unknown = await makeGraph().invoke({ state: { ...identity, messages }, taskReportBackContinuation: original }, config).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("server-stopped-before-second-dispatch");
  const restarted = makeGraph();
  const parked = await restarted.getState(config);
  const parkedValues = parked.values as typeof State.State;
  const canonical = JSON.stringify(parkedValues.state.messages);
  expect(parked.next).toEqual(["tools"]);
  expect(() => taskContinuationResumeCommand(parkedValues.state, { ...expected, continuation: { status: "relay_disconnected" } }))
    .toThrow("TASK_CONTINUATION_UNAVAILABLE");
  expect(JSON.stringify((await restarted.getState(config)).values)).toBe(JSON.stringify(parked.values));
  expect((await restarted.getState(config)).next).toEqual(["tools"]);
  const command = taskContinuationResumeCommand(parkedValues.state, expected);
  expect(Object.keys(command.update!)).toEqual(["taskReportBackContinuation"]);
  stopBeforeSecond = false;
  const result = await restarted.invoke(command, config);
  expect(starts).toBe(1); expect(firstCalls).toBe(1); expect(secondCalls).toBe(1);
  expect(JSON.stringify(result.state.messages!.slice(0, -1))).toBe(canonical);
  expect(result.taskReportBackContinuation).toEqual(expected.continuation);
});

test("a continuation update does not answer an outstanding human approval", async () => {
  const State = Annotation.Root({ taskReportBackContinuation: Annotation<TaskReportBackContinuation>({ reducer: (_, next) => next }) });
  let executed = 0;
  const saver = new MemorySaver();
  const makeGraph = () => new StateGraph(State).addNode("approval", () => {
    interrupt("Human approval is required."); executed++; return {};
  }).addEdge(START, "approval").addEdge("approval", END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: "approval" } };
  await makeGraph().invoke({ taskReportBackContinuation: original }, config);
  await makeGraph().invoke(taskContinuationResumeCommand(identity, expected), config);
  expect(executed).toBe(0);
  expect((await makeGraph().getState(config)).tasks[0]?.interrupts).toHaveLength(1);
  await makeGraph().invoke(new Command({ resume: true }), config);
  expect(executed).toBe(1);
});

test.each(["userId", "currentTaskId", "currentTaskRunId", "langgraphThreadId"] as const)("checkpoint %s mismatch cannot receive a refreshed grant", (key) => {
  expect(() => taskContinuationResumeCommand({ ...identity, [key]: "foreign" }, expected)).toThrow("CHECKPOINT_BINDING_MISMATCH");
});

test.each(["relayId", "desktopSessionId", "pairingGeneration", "currentFolder", "workspacePath", "bindingCapturedAt"] as const)("authority %s cannot change during graph resume", (key) => {
  expect(() => taskContinuationResumeCommand(identity, { ...expected, continuation: { ...expected.continuation,
    [key]: key === "bindingCapturedAt" ? 2000 : "foreign" } })).toThrow("AUTHORITY_CHANGED");
});


function contextFailure(): Partial<NautiloState> {
  return { ...identity, subagentRun: true, trustedExecutionEntrypoint: "background.task", toolWhitelist: ["security_scan", "file"],
    noProgressPendingStop: { toolName: "security_scan", operationDiscriminator: "context",
      normalizedError: JSON.stringify({ code: "context_budget_unavailable", message: "Local page framing cannot fit.", retryable: false }) },
    noProgressStreaks: new Map([["context", { count: 4, correctiveTurnIssued: true }]]),
    messages: [new HumanMessage("Retain this audit and its exact notes."),
      new AIMessage({ content: "", tool_calls: [{ id: "status", name: "security_scan", args: { operation: "status" } }] }),
      new ToolMessage({ name: "security_scan", tool_call_id: "status", content: JSON.stringify({ ok: true, operation: "status", result: {
        version: "security-scan-v1", scanId: "scan_test", state: "active", phase: "researching", terminalState: null,
        mode: "deep_research", modelId: "anthropic:claude-sonnet-4-6", modelState: "running", completedSteps: 1, totalSteps: 2,
        lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] } }) })] };
}

test("exact local context failure resets only its episode after continuation validation", async () => {
  const state = contextFailure();
  const before = JSON.stringify(state.messages);
  state.noProgressStreaks = new Map([[serializeNoProgressKey(state.noProgressPendingStop!), { count: 4, correctiveTurnIssued: true }],
    ["unrelated", { count: 2, correctiveTurnIssued: false }]]);
  expect(isRecoverableResearchContextBudgetStop(state)).toBe(true);
  expect(() => taskContinuationResumeCommand(state, { ...expected, continuation: { ...expected.continuation, currentFolder: "/other" } })).toThrow("AUTHORITY_CHANGED");
  const update = taskContinuationResumeCommand(state, expected).update;
  expect(update).toEqual({ taskReportBackContinuation: expected.continuation,
    noProgressStreaks: new Map([["unrelated", { count: 2, correctiveTurnIssued: false }]]), noProgressPendingCorrection: null, noProgressPendingStop: null });
  const unrelatedCorrection = { toolName: "file", operationDiscriminator: "read", normalizedError: "different" };
  expect(taskContinuationResumeCommand({ ...state, noProgressPendingCorrection: unrelatedCorrection }, expected).update).not.toHaveProperty("noProgressPendingCorrection");
  expect(JSON.stringify(state.messages)).toBe(before);
  expect(state.noProgressPendingStop).not.toBeNull();
  // Exercise the real Command against a failed pending node, without replaying START.
  const Channels = Annotation.Root({
    noProgressPendingStop: Annotation<NautiloState["noProgressPendingStop"]>({ reducer: (_, next) => next }),
    noProgressPendingCorrection: Annotation<NautiloState["noProgressPendingCorrection"]>({ reducer: (_, next) => next }),
    noProgressStreaks: Annotation<NautiloState["noProgressStreaks"]>({ reducer: (_, next) => next }),
    taskReportBackContinuation: Annotation<TaskReportBackContinuation>({ reducer: (_, next) => next }),
  });
  const saver = new MemorySaver(); let starts = 0; let continued = 0;
  const make = () => new StateGraph(Channels).addNode("start", () => { starts++; return {}; })
    .addNode("pre_model", (saved) => { if (saved.noProgressPendingStop) throw Error("no_progress"); continued++; return {}; })
    .addEdge(START, "start").addEdge("start", "pre_model").addEdge("pre_model", END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: "exact_context_failure" } };
  const failure: unknown = await make().invoke({ noProgressPendingStop: state.noProgressPendingStop }, config).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("no_progress");
  await make().invoke(taskContinuationResumeCommand(state, expected), config);
  expect(starts).toBe(1); expect(continued).toBe(1);
});

test("ordinary failures, foreign entrypoints and finalized research cannot reset the breaker", () => {
  const originalState = contextFailure();
  for (const patch of [
    { trustedExecutionEntrypoint: "foreground.chat" }, { subagentRun: false }, { toolWhitelist: ["file"] },
    { noProgressPendingStop: { ...originalState.noProgressPendingStop!, operationDiscriminator: "record" } },
    { noProgressPendingStop: { ...originalState.noProgressPendingStop!, normalizedError: JSON.stringify({ code: "authorization_denied" }) } },
    { noProgressPendingStop: { ...originalState.noProgressPendingStop!, normalizedError: "context_budget_unavailable" } },
    { messages: [] },
  ]) {
    const saved = { ...originalState, ...patch } as Partial<NautiloState>;
    expect(isRecoverableResearchContextBudgetStop(saved)).toBe(false);
    expect(Object.keys(taskContinuationResumeCommand(saved, expected).update!)).toEqual(["taskReportBackContinuation"]);
  }
  const finalized = contextFailure();
  const message = finalized.messages!.at(-1)!;
  message.content = (message.content as string).replace('"state":"active"', '"state":"completed"');
  expect(isRecoverableResearchContextBudgetStop(finalized)).toBe(false);
  expect(Object.keys(taskContinuationResumeCommand(finalized, expected).update!)).toEqual(["taskReportBackContinuation"]);
});
