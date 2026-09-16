import { expect, spyOn, test } from "bun:test";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { researchHandoffResultSchema, securityScanToolResultSchema, readTaskPreparation, taskPreparationText } from "@nautilo/types";
import { createTaskProgressTap, extractTaskProgressFromStreamEvent, retainTaskWorkProgress } from "../../src/subagents/scope-subagent/run";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
function event(role: "coordinator" | "investigator" | "reviewer", reviewDecision?: "accepted" | "follow_up") {
  const entry = { kind: "review_unit", summary: "Trace token revocation through access checks", surfaceKey: "identity", paths: ["identity/tokens.ts"],
    state: "unreviewed", trace: "Investigate issuance and consumption.", notes: "This is an assigned investigation, not verified coverage.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] };
  const saved = { ok: true, operation: "record", result: { codeEvidence: [], record: { id: "unit_identity", revision: 1, entry,
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", createdBy: author, updatedBy: author } } };
  securityScanToolResultSchema.parse(saved);
  const before = [new AIMessage({ content: "", tool_calls: [{ id: "save", name: "security_scan", args: { operation: "record", action: "append", entry } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "save", status: "success", content: JSON.stringify(saved), additional_kwargs: { hiddenReasoning: "SECRET_HIDDEN_BUFFER" } })];
  const args = { version: "security-scan-v1", operation: "handoff", role, handoffRecordId: "checkpoint_work" };
  const call = { id: "handoff", name: "security_scan", args };
  before.push(new AIMessage({ content: "", tool_calls: [call] }));
  const receipt = { ok: true, operation: "handoff", work: { taskId: author.taskId, taskRunId: author.taskRunId, role,
    unitRecordId: role === "coordinator" ? null : "unit_identity", handoffRecordId: "checkpoint_work", seedRecordIds: ["unit_identity"],
    ...(reviewDecision ? { reviewDecision, reviewedUnitRecordId: "unit_identity" } : {}) } };
  researchHandoffResultSchema.parse(receipt);
  const result = new ToolMessage({ name: "security_scan", tool_call_id: "handoff", status: "success", content: JSON.stringify(receipt) });
  return { event: "on_chain_end", name: "tools", data: { input: { currentTaskId: author.taskId, currentTaskRunId: author.taskRunId,
    approvedToolCalls: [call], messages: before }, output: { messages: [...before, result] } } };
}

test("accepted role changes show the concrete saved assignment, never internal IDs or hidden buffers", () => {
  for (const role of ["investigator", "reviewer"] as const) {
    const observed = extractTaskProgressFromStreamEvent(event(role));
    expect(observed?.preparation.researchWork).toEqual({ role, subject: "Trace token revocation through access checks" });
    expect(observed?.detail).toContain(role === "investigator" ? "Investigating" : "Reviewing");
    expect(observed?.detail).toContain("Model-assigned focus");
    expect(JSON.stringify(observed)).not.toContain("unit_identity");
    expect(JSON.stringify(observed)).not.toContain("SECRET_HIDDEN_BUFFER");
  }
});

test("review decisions are observed only from successful same-run paired handoffs", () => {
  for (const decision of ["accepted", "follow_up"] as const) {
    const fixture = event("coordinator", decision);
    expect(extractTaskProgressFromStreamEvent(fixture)?.preparation.researchWork?.reviewDecision).toBe(decision);
    const result = fixture.data.output.messages.at(-1)! as ToolMessage;
    expect(extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan", data: { output: result } })).toBeNull();
    result.status = "error";
    expect(extractTaskProgressFromStreamEvent(fixture)).toBeNull();
    result.status = "success";
    fixture.data.input.currentTaskRunId = "33333333-3333-4333-8333-333333333333";
    expect(extractTaskProgressFromStreamEvent(fixture)).toBeNull();
  }
});

test("provider waits, source activity and reconnect retain the assignment and identify model judgment", () => {
  const initial = extractTaskProgressFromStreamEvent(event("coordinator", "accepted"))!;
  let retained = retainTaskWorkProgress(initial, { detail: "Reading source code", preparation: { stage: "using_tools", activity: "reading_source" } });
  for (const stage of ["waiting_model", "model_responding"] as const) retained = retainTaskWorkProgress(retained,
    { detail: "Provider activity", preparation: { stage } });
  const durable = readTaskPreparation({ ...retained.preparation, taskRunId: author.taskRunId, updatedAt: "2026-09-07T00:00:00Z", sourceBuffer: "MUST_NOT_RECONNECT" });
  expect(durable).not.toBeNull();
  expect(taskPreparationText(durable!)).toContain("Trace token revocation through access checks");
  expect(taskPreparationText(durable!)).toContain("model judgment");
  expect(taskPreparationText(durable!)).toContain("Model response in progress");
  expect(JSON.stringify(durable)).not.toContain("MUST_NOT_RECONNECT");
  expect(retained.detail.match(/Model response in progress/g)).toHaveLength(1);
});

test("pressure recovery with remaining inputs survives the durable reconnect parser", () => {
  const durable = readTaskPreparation({ stage: "waiting_model", taskRunId: author.taskRunId, updatedAt: "2026-09-07T00:00:00Z",
    contextRecovery: { phase: "consolidation_required", pendingInputs: 7, recoveredInputBytes: 12000, retainedUnconsolidatedPages: 3 },
    researchWork: { role: "investigator", subject: "Trace token revocation" } });
  expect(durable?.contextRecovery?.pendingInputs).toBe(7);
  expect(taskPreparationText(durable!)).toContain("Trace token revocation");
  expect(taskPreparationText(durable!)).toContain("7 historical inputs");
});


test("a real checkpoint-resumed graph restores accepted work before its first model node", async () => {
  const fixture = event("investigator");
  const input = { ...fixture.data.input, messages: fixture.data.output.messages,
    taskRun: true, subagentRun: true, toolWhitelist: ["security_scan"] };
  const schema = Annotation.Root({
    currentTaskId: Annotation<string>(), currentTaskRunId: Annotation<string>(),
    taskRun: Annotation<boolean>(), subagentRun: Annotation<boolean>(), toolWhitelist: Annotation<string[]>(),
    messages: Annotation<BaseMessage[]>(),
    researchContextRecovery: Annotation<{ taskRunId: string; pendingRefs: string[]; consolidationRequired?: boolean } | null>(),
  });
  const graph = new StateGraph(schema)
    .addNode("pre_model", () => ({ researchContextRecovery: { taskRunId: author.taskRunId, pendingRefs: ["historical-input"], consolidationRequired: true } }))
    .addNode("agent", () => ({}))
    .addEdge(START, "pre_model").addEdge("pre_model", "agent").addEdge("agent", END)
    .compile({ checkpointer: new MemorySaver(), interruptBefore: ["pre_model"] });
  const config = { configurable: { thread_id: "research-progress-resume" } };
  await graph.invoke(input, config);
  const checkpoint = await graph.getState(config);
  const canonical = JSON.stringify((checkpoint.values as typeof input).messages);
  expect(checkpoint.next).toEqual(["pre_model"]);
  let latest: ReturnType<typeof extractTaskProgressFromStreamEvent> = null;
  let firstStartObserved = false;
  for await (const streamed of graph.streamEvents(null, { ...config, version: "v2" })) {
    const observed = extractTaskProgressFromStreamEvent(streamed);
    if (streamed.event === "on_chain_start" && streamed.name === "pre_model") {
      firstStartObserved = true;
      expect(observed?.preparation.researchWork).toEqual({ role: "investigator", subject: "Trace token revocation through access checks" });
    }
    if (observed) latest = retainTaskWorkProgress(latest, observed);
  }
  expect(firstStartObserved).toBe(true);
  latest = retainTaskWorkProgress(latest, extractTaskProgressFromStreamEvent({ event: "on_chat_model_stream" })!);
  const persisted = readTaskPreparation({ ...latest.preparation, taskRunId: author.taskRunId, updatedAt: "2026-09-08T00:00:00Z" });
  expect(persisted?.researchWork?.role).toBe("investigator");
  expect(persisted?.contextRecovery?.pendingInputs).toBe(1);
  expect(persisted?.contextRecovery?.phase).toBe("consolidation_required");
  expect(taskPreparationText(persisted!)).toContain("saving checkpoint; 1 historical inputs remain");
  expect(taskPreparationText(persisted!)).toContain("Model-assigned focus");
  expect(JSON.stringify(latest)).not.toContain("SECRET_HIDDEN_BUFFER");
  expect(JSON.stringify(((await graph.getState(config)).values as typeof input).messages)).toBe(canonical);
});

test("node work restoration rejects foreign scope, failed receipts and model prose", () => {
  const fixture = event("investigator");
  const input = { ...fixture.data.input, messages: fixture.data.output.messages,
    taskRun: true, subagentRun: true, toolWhitelist: ["security_scan"] };
  const observe = (value: Record<string, unknown>) => extractTaskProgressFromStreamEvent({ event: "on_chain_start", name: "pre_model", data: { input: value } });
  expect(observe(input)?.preparation.researchWork?.role).toBe("investigator");
  for (const changed of [{ taskRun: false }, { subagentRun: false }, { toolWhitelist: ["file"] },
    { currentTaskRunId: "33333333-3333-4333-8333-333333333333" }, { currentTaskId: "44444444-4444-4444-8444-444444444444" }]) {
    expect(observe({ ...input, ...changed })).toBeNull();
  }
  expect(observe({ ...input, messages: [new AIMessage("I am now investigating token revocation")], researchWorkEnabled: true })).toBeNull();
  const result = input.messages.at(-1)! as ToolMessage;
  result.status = "error";
  expect(observe(input)).toBeNull();
  result.status = "success";
  result.additional_kwargs["nautilo_tool_status"] = "error";
  expect(observe(input)).toBeNull();
});


test("disposed task progress clears its deferred timer without emitting stale progress", () => {
  const clear = spyOn(globalThis, "clearTimeout");
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const tap = createTaskProgressTap({ progressTaskId: author.taskId, progressTaskRunId: author.taskRunId, progressOwnerId: "owner" })!;
  try {
    const progress = extractTaskProgressFromStreamEvent(event("investigator"))!;
    tap.noteToolProgress(progress);
    tap.noteToolProgress({ ...progress, detail: "A later source result awaiting the deferred flush." });
    tap.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
    tap.flush();
    tap.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
  } finally { tap.dispose(); clear.mockRestore(); clock.mockRestore(); }
});
