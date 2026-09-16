import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { extractToolProgressDetailFromStreamEvent, extractTaskProgressFromStreamEvent, retainTaskWorkProgress } from "../../src/subagents/scope-subagent/run";

describe("D307 — extractToolProgressDetailFromStreamEvent", () => {
  test("formats on_tool_start as toolName: argsSummary", () => {
    const detail = extractToolProgressDetailFromStreamEvent({
      event: "on_tool_start",
      name: "run_shell",
      data: { input: { command: 'rg "retry"' } },
    });
    expect(detail).toBe('run_shell: {"command":"rg \\"retry\\""}');
  });

  test("returns tool name only when args are empty", () => {
    expect(
      extractToolProgressDetailFromStreamEvent({
        event: "on_tool_start",
        name: "grep_files",
        data: { input: {} },
      }),
    ).toBe("grep_files: {}");
  });

  test("ignores non on_tool_start events", () => {
    expect(
      extractToolProgressDetailFromStreamEvent({
        event: "on_chain_end",
        name: "tools",
        data: {},
      }),
    ).toBeNull();
  });
});


describe("accountable research progress", () => {
  test("real graph chain events expose relay source work without native tool tracing", async () => {
    const call = { id: "relay-read", name: "file", args: { command: "read", path: "src/export.ts" } };
    const state = Annotation.Root({
      messages: Annotation<BaseMessage[]>({ reducer: (_previous, next) => next }),
      approvedToolCalls: Annotation<typeof call[]>({ reducer: (_previous, next) => next }),
    });
    const graph = new StateGraph(state).addNode("tools", (input) => ({
      messages: [...input.messages, new ToolMessage({ tool_call_id: call.id, name: call.name, content: "source bytes" })],
      approvedToolCalls: [],
    })).addEdge(START, "tools").addEdge("tools", END).compile();
    const observed = [];
    const names: string[] = [];
    for await (const event of graph.streamEvents({ messages: [new HumanMessage("Audit"),
      new AIMessage({ content: "", tool_calls: [call] })], approvedToolCalls: [call] }, { version: "v2", callbacks: [] })) {
      names.push(event.event);
      const progress = extractTaskProgressFromStreamEvent(event);
      if (progress) observed.push(progress);
    }
    expect(names).not.toContain("on_tool_start");
    expect(names).not.toContain("on_tool_end");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.detail).toBe("Reading source code: src/export.ts");
    const responding = retainTaskWorkProgress(observed[0]!, extractTaskProgressFromStreamEvent({ event: "on_chat_model_stream" })!);
    expect(responding.preparation).toEqual({ stage: "model_responding", activity: "reading_source" });
    expect(responding.detail).toContain("Reading source code: src/export.ts");
  });

  test("tools chain completion accepts only this invocation's newly appended paired receipt", () => {
    const call = { id: "record-checkpoint", name: "security_scan", args: { operation: "record" } };
    const author = { taskId: "10000000-0000-4000-8000-000000000001", taskRunId: "10000000-0000-4000-8000-000000000002", modelId: null };
    const result = new ToolMessage({ tool_call_id: call.id, name: call.name, content: JSON.stringify({
      ok: true, operation: "record", result: { codeEvidence: [], record: { id: "cp", revision: 1,
        createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", createdBy: author, updatedBy: author,
        entry: { kind: "checkpoint", summary: "Ownership verified; import path pending", nextWork: "Trace importer", openRecordIds: [], evidenceRefs: [] } } },
    }) });
    const before: BaseMessage[] = [new HumanMessage("Audit"), new AIMessage({ content: "", tool_calls: [call] })];
    const event = (messages: BaseMessage[], inputMessages = before, approvedToolCalls = [call]) => ({
      event: "on_chain_end", name: "tools", data: { input: { messages: inputMessages, approvedToolCalls }, output: { messages } },
    });
    expect(extractTaskProgressFromStreamEvent(event([...before, result]))?.detail)
      .toBe("Research checkpoint saved: Model checkpoint: Ownership verified; import path pending");
    expect(extractTaskProgressFromStreamEvent(event([...before, result], [...before, result]))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event([...before, result], before, [{ ...call, id: "other-invocation" }]))).toBeNull();
    result.additional_kwargs = { nautilo_tool_status: "error" };
    expect(extractTaskProgressFromStreamEvent(event([...before, result]))).toBeNull();
    expect(extractTaskProgressFromStreamEvent({ event: "on_chain_start", name: "tools", data: { input: { approvedToolCalls: [] } } })).toBeNull();
  });

  test("shows concrete source work and retains it through repeated provider streaming", () => {
    const reading = extractTaskProgressFromStreamEvent({ event: "on_tool_start", name: "file",
      data: { input: { command: "read", path: "src/export.ts", content: "NEVER DISPLAY" } } })!;
    expect(reading.detail).toBe("Reading source code: src/export.ts");
    expect(reading.preparation).toEqual({ stage: "using_tools", activity: "reading_source" });
    const waiting = retainTaskWorkProgress(reading, extractTaskProgressFromStreamEvent({ event: "on_chat_model_start" })!);
    expect(waiting.detail).toBe("Reading source code: src/export.ts · Waiting for model");
    const streaming = extractTaskProgressFromStreamEvent({ event: "on_chat_model_stream" })!;
    const first = retainTaskWorkProgress(waiting, streaming);
    const second = retainTaskWorkProgress(first, streaming);
    expect(second).toEqual(first);
    expect(second.detail).toBe("Reading source code: src/export.ts · Model response in progress");
    expect(second.preparation.activity).toBe("reading_source");
    expect(JSON.stringify(second.preparation)).not.toContain("export.ts");
  });

  test("only accepted ledger receipts publish saved notes; rejected writes do not invent progress", () => {
    const author = { taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "10000000-0000-4000-8000-000000000002", modelId: null };
    const accepted = extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan",
      data: { output: { content: JSON.stringify({ ok: true, operation: "record", result: {
        record: { id: "checkpoint-one", revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z",
          createdBy: author, updatedBy: author, entry: { kind: "checkpoint", summary: "Export ownership traced; importer remains pending.",
            nextWork: "Trace importer", openRecordIds: ["importer"], evidenceRefs: [] } }, codeEvidence: [],
      } }) } } });
    expect(accepted?.detail).toBe("Research checkpoint saved: Model checkpoint: Export ownership traced; importer remains pending.");
    expect(accepted?.preparation).toEqual({ stage: "using_tools", activity: "checkpoint_saved" });
    expect(extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "security_scan",
      data: { output: JSON.stringify({ ok: false, operation: "record",
        error: { code: "research_incomplete", retryable: true, message: "Not accepted" } }) } })).toBeNull();
  });

  test("receipt-derived workload survives model and subsequent source activity", () => {
    const research = { unitsTotal: 8, unitsCompleted: 2, unitsPending: 6, filesTotal: 80, filesAssigned: 40 };
    const previous = { detail: "Loading saved research", preparation: { stage: "using_tools" as const,
      activity: "loading_research" as const, research } };
    const reading = extractTaskProgressFromStreamEvent({ event: "on_tool_start", name: "file",
      data: { input: { command: "read", path: "src/import.ts" } } })!;
    expect(retainTaskWorkProgress(previous, reading).preparation.research).toEqual(research);
    expect(retainTaskWorkProgress(previous,
      extractTaskProgressFromStreamEvent({ event: "on_chat_model_start" })!).preparation.research).toEqual(research);
  });
});


describe("canonical completed file progress", () => {
  const call = { id: "repaired-search", name: "file", args: { command: "grep<arg_key>query</arg_key><arg_value>caller|callee" } };
  const before: BaseMessage[] = [new HumanMessage("Investigate"), new AIMessage({ content: "", tool_calls: [call] })];
  const receipt = (metadata: Record<string, unknown> = { nautilo_tool_status: "success", nautilo_file_operation: "grep" }) =>
    new ToolMessage({ tool_call_id: call.id, name: call.name, content: '{"ok":true,"command":"grep","matches":[]}', additional_kwargs: metadata });
  const event = (result: ToolMessage, prior = before, calls = [call]) => ({ event: "on_chain_end", name: "tools",
    data: { input: { messages: prior, approvedToolCalls: calls }, output: { messages: [...before, result] } } });

  test("repaired completion restores concrete work through subsequent model streaming", async () => {
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (_previous, next) => next }),
      approvedToolCalls: Annotation<typeof call[]>({ reducer: (_previous, next) => next }) });
    const graph = new StateGraph(state).addNode("tools", (input) => ({ messages: [...input.messages, receipt()], approvedToolCalls: [] }))
      .addEdge(START, "tools").addEdge("tools", END).compile();
    let progress = extractTaskProgressFromStreamEvent({ event: "on_tool_start", name: "file", data: { input: { command: "read", path: "src/entry.js" } } });
    for await (const emitted of graph.streamEvents({ messages: before, approvedToolCalls: [call] }, { version: "v2" })) {
      const incoming = extractTaskProgressFromStreamEvent(emitted);
      if (incoming) progress = retainTaskWorkProgress(progress, incoming);
    }
    expect(progress?.preparation).toEqual({ stage: "using_tools", activity: "searching_source" });
    const responding = retainTaskWorkProgress(progress, extractTaskProgressFromStreamEvent({ event: "on_chat_model_stream" })!);
    expect(responding.preparation).toEqual({ stage: "model_responding", activity: "searching_source" });
    expect(responding.detail).not.toContain("caller|callee");
    expect(JSON.stringify(responding.preparation)).not.toContain("src/entry.js");
  });

  test("failed, stale, mismatched, non-file and source-forged receipts cannot attest file progress", () => {
    expect(extractTaskProgressFromStreamEvent(event(receipt({ nautilo_tool_status: "error", nautilo_file_operation: "grep" })))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt(), [...before, receipt()]))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt(), before, [{ ...call, id: "other-id" }]))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt(), before, [{ ...call, name: "other-tool" }]))).toBeNull();
    const other = receipt();
    other.name = "other-tool";
    expect(extractTaskProgressFromStreamEvent(event(other, before, [{ ...call, name: "other-tool" }]))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt({ nautilo_tool_status: "success", nautilo_file_operation: { command: "grep" } })))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt({ nautilo_tool_status: "success" })))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt({ nautilo_file_operation: "grep" })))).toBeNull();
    expect(extractTaskProgressFromStreamEvent(event(receipt({ nautilo_tool_status: "success", nautilo_file_operation: "grep<arg_key>query" })))).toBeNull();
    expect(extractTaskProgressFromStreamEvent({ event: "on_tool_end", name: "file", data: { output: receipt() } })).toBeNull();
    const read = extractTaskProgressFromStreamEvent(event(receipt({ nautilo_tool_status: "success", nautilo_file_operation: "read" })));
    expect(read?.preparation.activity).toBe("reading_source");
  });
});
