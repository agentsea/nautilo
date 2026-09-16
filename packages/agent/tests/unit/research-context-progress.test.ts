import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { extractTaskProgressFromStreamEvent, retainTaskWorkProgress } from "../../src/subagents/scope-subagent/run";
import { readTaskPreparation, taskPreparationText } from "@nautilo/types";

const identity = { subagentRun: true, currentTaskId: "task", currentTaskRunId: "run", toolWhitelist: ["security_scan", "file"] };
const recovery = { taskRunId: "run", throughIndex: 12, indexRef: "private-history-index", pendingRefs: ["private-source-one", "private-source-two"] };
const event = (output: unknown, input: unknown = identity) => ({ event: "on_chain_end", name: "pre_model", data: { input, output } });

describe("D581 content-free context recovery progress", () => {
  test("real pre-model chain output becomes durable recovery phase and pending input counts", async () => {
    const shape = Annotation.Root({
      subagentRun: Annotation<boolean>, currentTaskId: Annotation<string>, currentTaskRunId: Annotation<string>, toolWhitelist: Annotation<string[]>,
      researchContextRecovery: Annotation<typeof recovery | null>,
    });
    const graph = new StateGraph(shape).addNode("pre_model", () => ({ researchContextRecovery: recovery }))
      .addEdge(START, "pre_model").addEdge("pre_model", END).compile();
    const observed = [];
    for await (const entry of graph.streamEvents({ ...identity, researchContextRecovery: null }, { version: "v2", callbacks: [] })) {
      const progress = extractTaskProgressFromStreamEvent(entry);
      if (progress) observed.push(progress);
    }
    expect(observed).toHaveLength(1);
    const progress = observed[0]!;
    expect(progress.preparation).toEqual({ stage: "preparing_model", activity: "recovering_context", contextRecovery: { pendingInputs: 2, phase: "reading" } });
    expect(progress.detail).toContain("2 historical inputs await recovery");
    const responding = retainTaskWorkProgress(progress, extractTaskProgressFromStreamEvent({ event: "on_chat_model_stream" })!);
    const durable = readTaskPreparation({ ...responding.preparation, taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z", source: "private-source" });
    expect(durable).not.toBeNull();
    expect(taskPreparationText(durable!)).toContain("2 historical inputs await recovery");
    expect(JSON.stringify(durable)).not.toContain("private");
  });

  test("recovery completion and another Task's output cannot leave false active recovery", () => {
    expect(extractTaskProgressFromStreamEvent(event({ researchContextRecovery: recovery }, { ...identity, currentTaskRunId: "other" }))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event({ researchContextRecovery: recovery }, { ...identity, subagentRun: false }))).toBeNull();
    const active = extractTaskProgressFromStreamEvent(event({ researchContextRecovery: recovery }))!;
    const completed = extractTaskProgressFromStreamEvent(event({ researchContextRecovery: null }, { ...identity, researchContextRecovery: recovery }))!;
    const next = retainTaskWorkProgress(active, completed);
    expect(next.detail).toContain("continuing the audit");
    expect(next.preparation.contextRecovery).toEqual({ pendingInputs: 0, phase: "inactive" });
  });

  test("accepted historical page gives exact range progress without text or references", () => {
    const receipt = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-reference", sha256: "a".repeat(64),
      serialization: "visible-message-json-utf8", startByte: 100, endByte: 108, totalBytes: 200, text: "private!", complete: false, nextCursor: "private-cursor" } };
    const progress = extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: JSON.stringify(receipt) } });
    expect(progress?.preparation.contextPage).toEqual({ startByte: 100, endByte: 108, totalBytes: 200 });
    expect(progress?.detail).toContain("Historical bytes 100–108 of 200");
    expect(JSON.stringify(progress)).not.toContain("private");
    const durable = readTaskPreparation({ ...progress!.preparation, taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" });
    expect(durable?.contextPage).toEqual(progress?.preparation.contextPage);
    expect(extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: { ...receipt, result: { ...receipt.result, endByte: 109 } } } })).toBeNull();
  });

  test("durable projection rejects invalid counts and strips raw recovery material", () => {
    const base = { stage: "preparing_model", activity: "recovering_context", taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" };
    expect(readTaskPreparation({ ...base, contextRecovery: { pendingInputs: -1 } })).toBeNull();
    expect(readTaskPreparation({ ...base, contextPage: { startByte: 2, endByte: 1, totalBytes: 3 } })).toBeNull();
    const saved = readTaskPreparation({ ...base, contextRecovery: { pendingInputs: 0, pendingRefs: ["private"] } })!;
    expect(taskPreparationText(saved)).toContain("saving checkpoint before continuing");
    expect(JSON.stringify(saved)).not.toContain("private");
  });

  test("saved-note index lookup does not claim historical source recovery or retain its byte progress", () => {
    const start = extractTaskProgressFromStreamEvent({ event: "on_tool_start", name: "security_scan", data: { input: {
      operation: "context", contextRef: "research-records:3:private-reference",
    } } })!;
    expect(start.preparation.activity).toBe("loading_research");
    const receipt = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-reference", sha256: "a".repeat(64),
      serialization: "saved-record-index-json-utf8", startByte: 0, endByte: 8, totalBytes: 8, text: "private!", complete: true, nextCursor: null } };
    const lookup = extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: JSON.stringify(receipt) } })!;
    expect(lookup.preparation).toEqual({ stage: "using_tools", activity: "loading_research" });
    expect(lookup.detail).toBe("Looking up saved research notes; lookup is not source inspection");
    const active = extractTaskProgressFromStreamEvent(event({ researchContextRecovery: recovery }))!;
    const next = retainTaskWorkProgress(active, lookup);
    expect(next.preparation.contextPage).toBeUndefined();
    expect(next.preparation.contextRecovery).toEqual({ pendingInputs: 2, phase: "reading" });
    expect(JSON.stringify(next)).not.toContain("private");
    expect(readTaskPreparation({ ...next.preparation, taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" })?.activity).toBe("loading_research");
  });
});


test("historical message indexes use lookup activity and never add source-recovery bytes", () => {
  const start = extractTaskProgressFromStreamEvent({ event: "on_tool_start", name: "security_scan", data: { input: {
    operation: "context", contextRef: "research-index:3:private-reference",
  } } })!;
  expect(start.preparation.activity).toBe("loading_research");
  const receipt = { ok: true, operation: "context", result: { version: "research-context-v1", contextRef: "private-reference", sha256: "a".repeat(64),
    serialization: "visible-message-index-json-utf8", startByte: 0, endByte: 8, totalBytes: 8, text: "private!", complete: true, nextCursor: null } };
  const lookup = extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: JSON.stringify(receipt) } })!;
  expect(lookup.preparation).toEqual({ stage: "using_tools", activity: "loading_research" });
  expect(lookup.detail).toBe("Looking up saved messages; lookup is not source inspection");
  expect(lookup.preparation.contextPage).toBeUndefined();
  expect(taskPreparationText(readTaskPreparation({ ...lookup.preparation, taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" })!)).not.toContain("Historical bytes");
});


const runtimeRecovery = { phase: "reading", pendingInputCount: 2, recoveredInputBytes: 4300,
  retainedUnconsolidatedPages: 3, asOfMessageIndex: 52, nextContextRef: "private-runtime-reference" };

test("a paired failed context receipt reports runtime pending work without claiming tool success", () => {
  const receipt = { ok: false, operation: "context", error: { code: "context_cursor_stale", message: "Use the current saved input.", retryable: false }, runtimeRecovery };
  const message = new ToolMessage({ content: JSON.stringify(receipt), tool_call_id: "call", name: "security_scan", status: "error" });
  const progress = extractTaskProgressFromStreamEvent({ event: "on_chain_end", name: "tools", data: {
    input: { messages: [], approvedToolCalls: [{ id: "call", name: "security_scan", args: { operation: "context" } }] }, output: { messages: [message] },
  } })!;
  expect(progress.detail).toContain("Runtime recovery: 2 historical inputs await recovery");
  expect(progress.preparation.contextRecovery).toEqual({ phase: "reading", pendingInputs: 2, recoveredInputBytes: 4300, retainedUnconsolidatedPages: 3 });
  expect(progress.preparation.contextPage).toBeUndefined();
  expect(progress.detail).not.toContain("saved successfully");
  expect(JSON.stringify(progress)).not.toContain("private");
  const durable = readTaskPreparation({ ...progress.preparation, taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" })!;
  expect(durable.contextRecovery).toEqual(progress.preparation.contextRecovery);
  const wrong = new ToolMessage({ content: JSON.stringify(receipt), tool_call_id: "other", name: "security_scan", status: "error" });
  expect(extractTaskProgressFromStreamEvent({ event: "on_chain_end", name: "tools", data: {
    input: { messages: [], approvedToolCalls: [{ id: "call", name: "security_scan", args: {} }] }, output: { messages: [wrong] },
  } })).toBeNull();
});

test("optional lookup retains authoritative runtime pending facts without acquiring source-byte credit", () => {
  const receipt = { ok: true, operation: "context", runtimeRecovery, result: { version: "research-context-v1", contextRef: "private-reference", sha256: "a".repeat(64),
    serialization: "visible-message-index-json-utf8", startByte: 0, endByte: 8, totalBytes: 8, text: "private!", complete: true, nextCursor: null } };
  const lookup = extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: JSON.stringify(receipt) } })!;
  expect(lookup.preparation.activity).toBe("loading_research");
  expect(lookup.preparation.contextRecovery?.recoveredInputBytes).toBe(4300);
  expect(lookup.preparation.contextPage).toBeUndefined();
  expect(lookup.detail).toContain("lookup is not source inspection");
  expect(lookup.detail).toContain("2 historical inputs await recovery");
  const saving = retainTaskWorkProgress(lookup, extractTaskProgressFromStreamEvent({ event: "on_tool_start", name: "security_scan", data: { input: { operation: "record" } } })!);
  const durable = readTaskPreparation({ ...saving.preparation, taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" })!;
  expect(taskPreparationText(durable)).toContain("Runtime recovery: 2 historical inputs await recovery");
  expect(durable.activity).toBe("saving_research");
  expect(saving.detail).toContain("Runtime recovery: 2 historical inputs await recovery");
  expect(JSON.stringify(durable)).not.toContain("private");
});

test("runtime progress validation rejects contradictory phases and unsafe counters beside a checkpoint", () => {
  const base = { stage: "using_tools", activity: "checkpoint_saved", taskRunId: "run", updatedAt: "2026-09-07T12:00:00Z" };
  for (const contextRecovery of [{ pendingInputs: 2, phase: "inactive" }, { pendingInputs: 0, phase: "reading" },
    { pendingInputs: 0, phase: "consolidation_required", recoveredInputBytes: -1 }, { pendingInputs: 1, retainedUnconsolidatedPages: Infinity }]) {
    expect(readTaskPreparation({ ...base, contextRecovery })).toBeNull();
  }
  const saved = readTaskPreparation({ ...base, contextRecovery: { pendingInputs: 0, phase: "consolidation_required", recoveredInputBytes: 4300, retainedUnconsolidatedPages: 3, asOfMessageIndex: 52, nextContextRef: "private" } })!;
  expect(taskPreparationText(saved)).toContain("Runtime recovery: saving checkpoint; 0 historical inputs remain");
  // Workspace pressure can require consolidation before the remaining source is read.
  const pressure = readTaskPreparation({ ...base, contextRecovery: { ...saved.contextRecovery, pendingInputs: 2 } })!;
  expect(pressure.contextRecovery?.phase).toBe("consolidation_required");
  expect(taskPreparationText(pressure)).toContain("Runtime recovery: saving checkpoint; 2 historical inputs remain");
  expect(JSON.stringify(saved)).not.toContain("private");
});


test("native tool failure overrides success-shaped historical content and keeps only runtime facts", () => {
  const receipt = { ok: true, operation: "context", runtimeRecovery, result: { version: "research-context-v1", contextRef: "private-reference", sha256: "a".repeat(64),
    serialization: "visible-message-json-utf8", startByte: 0, endByte: 8, totalBytes: 8, text: "private!", complete: true, nextCursor: null } };
  const message = new ToolMessage({ content: JSON.stringify(receipt), tool_call_id: "call", name: "security_scan", status: "error" });
  const progress = extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: message } })!;
  expect(progress.preparation.contextPage).toBeUndefined();
  expect(progress.detail).toContain("Runtime recovery: 2 historical inputs await recovery");
  expect(progress.detail).not.toContain("Historical bytes");
  const { runtimeRecovery: _facts, ...withoutFacts } = receipt;
  expect(extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: new ToolMessage({
    content: JSON.stringify(withoutFacts), tool_call_id: "call", name: "security_scan", status: "error",
  }) } })).toBeNull();
});
