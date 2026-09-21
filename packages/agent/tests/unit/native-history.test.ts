import { afterEach, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, mapStoredMessagesToChatMessages, type BaseMessage } from "@langchain/core/messages";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import { windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import { readNativeHistory, projectNativeHistory } from "../../src/tools/computer/native-history";
import { ToolCatalog, initToolCatalog, clearToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";
import { createNautiloToolInvocationSession, createServerToolInvocationContext, setRelayRegistry } from "../../src/tools/invocation-service";
import type { NautiloState } from "../../src/agent/state";
import { ChatAnthropic } from "@langchain/anthropic";
import { processHistory } from "../../src/utils/history-manager";
import { projectOpenAIMultimodalToolResults } from "../../src/nodes/pre-model";
import { createPostModelNode } from "../../src/nodes/post-model";
import type { PolicyResolver } from "@nautilo/trust";
import { createComputerHostContractTool } from "../../src/tools/computer/computer-host-contract";
import { resolveComputerUseHostToolRequest } from "../../src/config/computer-use-catalogue/host-tool-admission";

afterEach(() => { clearToolCatalog(); setRelayRegistry(null); });

const context = `dctx_${"a".repeat(43)}`;
const target = { version: 1, context, reference: `dtgt_${"b".repeat(43)}` };
function transcript(...segments: BaseMessage[][]): BaseMessage[] {
  return segments.reduce((messages, segment) => mergeMessagesPreservingInvariants(messages, segment), []);
}
function recovered(text: string) {
  const value = JSON.parse(text) as { historical: boolean; observation: unknown };
  return { historical: value.historical, observation: windowStateObservationSchema.parse(value.observation) };
}
function cycle(id: string, image = false, reference = target.reference): BaseMessage[] {
  const selected = { ...target, reference };
  const result = windowStateObservationSchema.parse({ version: 1, operation: "window_state", target: selected,
    evidence: { kind: "window", appLabel: "Fixture", windowLabel: "Draft" }, completeness: "partial",
    degraded: false, verification: "indeterminate",
    outcome: { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable",
      providerCondition: "ready", targetCondition: "current", recovery: [] },
    controlCollection: { completeness: "partial", received: 300, omitted: 0, controls: Array.from({ length: 300 }, (_, n) => ({
      id: `c${n}`, role: "text_area", label: `Field ${n}`, state: { completeness: "partial", value: `${id}: exact\n日本語 ${n}` },
    })) },
  });
  const text = JSON.stringify({ version: 1, ok: true, settlement: "completed", presentation: { label: "Observe", summary: "Observed" }, result });
  return [new AIMessage({ content: "", tool_calls: [{ id, name: "computer_observe", args: { operation: "window_state", target: selected } }] }),
    new ToolMessage({ id: `msg-${id}`, tool_call_id: id, name: "computer_observe", status: "success",
      additional_kwargs: { nautilo_tool_status: "success" }, response_metadata: { timing: 1 },
      content: image ? [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWxz" } }] : text })];
}

test("projects only superseded exact-window evidence; preserves canonical bytes and message envelopes", () => {
  const messages = transcript([new HumanMessage("Insert the exact supplied text")], cycle("old"), cycle("before"), cycle("now"));
  const bytes = JSON.stringify(messages);
  const projected = projectNativeHistory(messages);
  expect(projected.originals.size).toBe(1);
  expect(projected.originals.get("old")).toBe(messages[2] as ToolMessage);
  expect(projected.messages.slice(3)).toEqual(messages.slice(3));
  expect(projected.messages.map(m => [m.getType(), m.id])).toEqual(messages.map(m => [m.getType(), m.id]));
  expect((projected.messages[2] as ToolMessage).tool_call_id).toBe("old");
  expect((projected.messages[2] as ToolMessage).status).toBe("success");
  expect(projected.messages[2]!.response_metadata).toEqual({ timing: 1 });
  expect(JSON.stringify(projected.messages).length).toBeLessThan(bytes.length);
  expect(JSON.stringify(messages)).toBe(bytes);
  expect(projectNativeHistory(messages).messages).toEqual(projected.messages);
});

test("retrieves exact retained public evidence and PNG, never Host sidecars or recursive results", () => {
  const messages = cycle("source", true);
  messages[1]!.additional_kwargs["nautilo_host_computer_result_v1"] = "private transport";
  const read = readNativeHistory(messages, "source")!;
  expect(recovered(read.text).observation.controlCollection!.controls[299]!.state.value).toBe("source: exact\n日本語 299");
  expect(read.image).toEqual({ mime: "image/png", base64: "cGl4ZWxz" });
  expect(read.text).not.toContain("private transport");
  expect(recovered(read.text).historical).toBe(true);
  expect(readNativeHistory(messages, "missing")).toBeNull();
  expect(readNativeHistory([...messages, messages[1]!], "source")).toBeNull();
  expect(readNativeHistory([messages[1]!], "source")).toBeNull();
  expect(readNativeHistory([messages[1]!, messages[0]!], "source")).toBeNull();
});

test("same labels do not merge windows or cross Human boundaries", () => {
  const messages = transcript(cycle("old"), cycle("other", false, `dtgt_${"c".repeat(43)}`), cycle("now"));
  expect(projectNativeHistory(messages).messages).toEqual(messages);
  const boundary = transcript(cycle("old"), [new HumanMessage("New task")], cycle("before"), cycle("now"));
  expect(projectNativeHistory(boundary).messages).toEqual(boundary);
});

test("retains visual before/after evidence independently of later text-only observations", () => {
  const messages = transcript(cycle("picture", true), cycle("before"), cycle("now"));
  expect(projectNativeHistory(messages).messages).toEqual(messages);
  const repeated = transcript(cycle("old", true), cycle("before", true), cycle("now", true));
  expect(projectNativeHistory(repeated).originals.size).toBe(1);
  expect(readNativeHistory(repeated, "old")!.image).toBeDefined();
});

test("actions, unresolved effects, malformed sources and missing provenance are not erased", () => {
  const error = new ToolMessage({ name: "computer_do", tool_call_id: "write", status: "error",
    content: JSON.stringify({ settlement: "unknown_completion", exactInput: "do not repeat" }) });
  const messages = transcript(cycle("old"), [error], cycle("before"), cycle("now"));
  expect(projectNativeHistory(messages).messages).toEqual(messages);
  const bad = cycle("old");
  bad[1]!.content = "not json";
  expect(readNativeHistory(bad, "old")).toBeNull();
  expect(projectNativeHistory(transcript(bad, cycle("before"), cycle("now"))).messages[1]).toBe(bad[1]);
});

test.each([false, true])("ordinary invocation reads retained native evidence with image=%s without a Relay", async (image) => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  setRelayRegistry(null);
  const messages = cycle("source", image);
  const state = { messages, approvedToolCalls: [], actorRole: "owner", userId: "owner", personaId: "owner", turnId: "turn",
    agentId: "agent", roomId: "room", activatedToolNames: ["computer_observe"], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canUseComputer: true, control_desktop: true } } as unknown as NautiloState;
  const before = JSON.stringify(state);
  const session = createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => ({ status: "allowed" })));
  const call = { callId: "history", toolName: "computer_observe", authorityRef: "receipt-history", args: { historyToolCallId: "source" } };
  const result = await session.invoke(call);
  expect(result.status).toBe("success");
  const text = typeof result.content === "string" ? result.content
    : (result.content[0] as { text: string }).text;
  expect(recovered(text).historical).toBe(true);
  expect(recovered(text).observation.controlCollection!.controls).toHaveLength(300);
  expect(JSON.stringify(state)).toBe(before);
  if (image) expect(result.content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWxz" } });
  for (const args of [{ historyToolCallId: "absent" }, { historyToolCallId: "source", operation: "window_state" }]) {
    const missing = await session.invoke({ ...call, callId: `missing-${JSON.stringify(args)}`, args });
    expect(missing.status).toBe("error");
    expect(JSON.stringify(missing.content)).toContain("No");
  }
});

test("history budgeting restores canonical originals; unavailable retrieval disables projection", () => {
  const messages = transcript([new HumanMessage("Inspect")], cycle("old"), cycle("before"), cycle("now"));
  const config = { validationEnabled: true, pruningEnabled: true, tokenBudgetFraction: 0.9,
    windowKeepRecent: 100, modelId: "openai:gpt-5.6-sol", nativeHistoryAvailable: true };
  const before = JSON.stringify(messages);
  const processed = processHistory(messages, config);
  expect(JSON.stringify(processed.canonicalMessages)).toBe(before);
  expect(processed.messages[2]!.content).not.toBe(messages[2]!.content);
  expect(readNativeHistory(processed.canonicalMessages!, "old")).not.toBeNull();
  const resumed = mapStoredMessagesToChatMessages(processed.canonicalMessages!.map(message => message.toDict()));
  expect(readNativeHistory(resumed, "old")).toEqual(readNativeHistory(messages, "old"));
  expect(projectNativeHistory(resumed).messages.map(m => m.content)).toEqual(projectNativeHistory(messages).messages.map(m => m.content));
  expect(processHistory(messages, { ...config, nativeHistoryAvailable: false }).messages).toEqual(messages);
});

test("Anthropic wire retains every tool-use/result ID and fresh image in a parallel cycle", async () => {
  const before = cycle("before", true);
  const now = cycle("now", true);
  const calls = new AIMessage({ content: "", tool_calls: [
    ...(before[0] as AIMessage).tool_calls!, ...(now[0] as AIMessage).tool_calls!,
  ] });
  const messages = transcript([new HumanMessage("Inspect")], cycle("superseded", true), cycle("old", true), [calls, before[1]!, now[1]!]);
  const original = JSON.stringify(messages);
  const projected = projectNativeHistory(messages).messages;
  const model = new ChatAnthropic({ model: "claude-sonnet-4-6", apiKey: "synthetic-test-only", streaming: false, maxRetries: 0 });
  let wire: Record<string, unknown> | undefined;
  Object.defineProperty(model, "completionWithRetry", { value: async (request: Record<string, unknown>) => {
    wire = request;
    return { id: "reply", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Done" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  } });
  await model.bindTools([createComputerHostContractTool("computer_observe")]).invoke(projected);
  const rows = wire!["messages"] as Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  const blocks = rows.flatMap(row => typeof row.content === "string" ? [] : row.content);
  expect(blocks.filter(b => b["type"] === "tool_use").map(b => b["id"])).toEqual(["superseded", "old", "before", "now"]);
  expect(blocks.filter(b => b["type"] === "tool_result").map(b => b["tool_use_id"])).toEqual(["superseded", "old", "before", "now"]);
  expect(rows.at(-1)!.role).toBe("user");
  const tools = wire!["tools"] as Array<{ name: string; input_schema: { type: string; anyOf: unknown[] } }>;
  expect(tools[0]!.name).toBe("computer_observe");
  expect(tools[0]!.input_schema.type).toBe("object");
  expect(JSON.stringify(tools[0]!.input_schema)).toContain("historyToolCallId");
  expect(resolveComputerUseHostToolRequest("computer_observe", { historyToolCallId: "old" })).toBeNull();
  expect(JSON.stringify(wire).match(/cGl4ZWxz/g)).toHaveLength(3);
  expect(JSON.stringify(messages)).toBe(original);
  const openai = projectOpenAIMultimodalToolResults(projected, "openai:gpt-5.6-sol");
  expect(openai.map(m => m.getType())).toEqual(["human", "ai", "tool", "ai", "tool", "human", "ai", "tool", "tool", "human", "human"]);
});

test("post-model admits local history under ordinary policy without minting desktop authority", async () => {
  const catalog = new ToolCatalog(); registerAllTools(catalog); initToolCatalog(catalog);
  const call = { id: "history", name: "computer_observe", args: { historyToolCallId: "source" } };
  const state = { messages: [...cycle("source"), new AIMessage({ content: "", tool_calls: [call] })],
    model: "openai:gpt-5.6-sol", userId: "owner", agentId: "agent", roomId: "room", turnId: "turn", actorRole: "owner",
    toolNames: ["computer_observe"], activatedToolNames: ["computer_observe"], activatedToolLeases: [],
    engagedSkillNames: [], source: "desktop", relayCapabilities: { canUseComputer: true, control_desktop: true },
    approvedToolCalls: [], pendingApproval: [], requiredHostRelays: {}, computerUseInvocationBindings: {} } as unknown as NautiloState;
  const policy = { checkToolAccess: async () => ({ type: "read_only" }) } as unknown as PolicyResolver;
  const result = await createPostModelNode(policy, {
    resolveComputerUseAdmission: () => { throw new Error("History must not request desktop authority"); },
    matchCommandApproval: async () => null, createCommandApproval: async () => ({ id: "unused", created: true }),
  })(state);
  expect(result.approvedToolCalls).toEqual([call]);
  expect(result.computerUseInvocationBindings).toEqual({});
  const denied = await createPostModelNode({ checkToolAccess: async () => ({ type: "forbidden", reason: "Policy denies access" }) } as unknown as PolicyResolver)(state);
  expect(denied.approvedToolCalls).toHaveLength(0);
  expect(denied.approvalDenied).toBe(true);
});

test("later partial selector results cannot retire a full control collection", () => {
  const earlier = cycle("old");
  const later = cycle("now");
  const tool = later[1] as ToolMessage;
  const payload = JSON.parse(tool.content as string) as { result: { controlCollection?: unknown } };
  delete payload.result.controlCollection;
  tool.content = JSON.stringify(payload);
  const messages = transcript(earlier, cycle("before"), later);
  expect(projectNativeHistory(messages).messages).toEqual(messages);
});

test("Room evidence uses only its invocation capability and repeats admission at dispatch", async () => {
  const catalog = new ToolCatalog(); registerAllTools(catalog); initToolCatalog(catalog); setRelayRegistry(null);
  let active = true;
  const port = { project: () => null, read: (ref: string) => active && ref === "bound-reference"
    ? { text: JSON.stringify({ historical: true, exact: "first\nsecond  日本語" }) } : null };
  const call = { id: "room-read", name: "computer_observe", args: { historyRoomRef: "bound-reference" } };
  const state = { messages: [new AIMessage({ content: "", tool_calls: [call] })],
    model: "openai:gpt-5.6-sol", userId: "owner", agentId: "agent", roomId: "room", turnId: "turn", actorRole: "owner",
    toolNames: ["computer_observe"], activatedToolNames: ["computer_observe"], activatedToolLeases: [],
    engagedSkillNames: [], source: "desktop", relayCapabilities: { canUseComputer: true, control_desktop: true },
    approvedToolCalls: [], pendingApproval: [], requiredHostRelays: {}, computerUseInvocationBindings: {} } as unknown as NautiloState;
  const policy = { checkToolAccess: async () => ({ type: "read_only" }) } as unknown as PolicyResolver;
  const deps = { nativeRoomHistoryPortForState: () => port,
    resolveComputerUseAdmission: () => { throw new Error("No desktop authority for historical reads"); },
    matchCommandApproval: async () => null, createCommandApproval: async () => ({ id: "unused", created: true }) };
  expect((await createPostModelNode(policy, deps)(state)).approvedToolCalls).toEqual([call]);
  const session = createNautiloToolInvocationSession(createServerToolInvocationContext(state,
    () => ({ status: "allowed" }), { nativeRoomHistoryPort: port }));
  const request = { callId: "room-read", toolName: "computer_observe", args: call.args, authorityRef: "admitted" };
  expect((await session.invoke(request)).status).toBe("success");
  expect((await session.invoke({ ...request, callId: "mixed", args: { ...call.args, operation: "desktop_state" } })).status).toBe("error");
  active = false;
  expect((await session.invoke({ ...request, callId: "expired" })).status).toBe("error");
  expect((await createPostModelNode(policy, deps)(state)).approvedToolCalls).toHaveLength(0);
});
