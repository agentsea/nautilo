/** Provider/DB mocks are isolated; graph, callback management and supervision are real. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { ensureConfig, type RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph } from "@langchain/langgraph";
import { runWithTurn } from "@nautilo/logger";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { ModelCatalogSchema } from "@nautilo/types";
import { configureRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import { getUsageContext } from "../../src/usage/usage-context";
import { bindModelAttemptProgressSinkByKey, clearAgentTurnContextByKey, getAgentTurnContextByKey, turnContextKey } from "../../src/runtime/turn-context";

const MODEL = "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731";
const originalKey = process.env["FIREWORKS_API_KEY"];
const oldFetch = globalThis.fetch;
let perform: (messages: BaseMessage[], config: RunnableConfig) => Promise<AIMessage>;
let invocation: typeof import("../../src/utils/chat-model-invocation");
let createHelper: typeof import("../../src/tools/security/research-note-draft").createResearchNoteDraft;
const createdModels: Array<{ id: string; options: { reasoningEffort?: string; reasoningOutput?: boolean } }> = [];
beforeAll(async () => {
  process.env["FIREWORKS_API_KEY"] = "synthetic-unit-test-key";
  globalThis.fetch = mock(async () => { throw new Error("Network is forbidden in this test"); }) as unknown as typeof fetch;
  mock.module("../../src/utils/resolve-fallback-policy", () => ({ resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }) }));
  const realDb = await import("@nautilo/db");
  mock.module("@nautilo/db", () => ({ ...realDb, getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {}, refreshServerModelConfigCache: async () => null, primeServerModelConfigCache: () => {} }));
  mock.module("../../src/providers/universal", () => ({ createUniversalModel: async (id: string, options: { reasoningEffort?: string; reasoningOutput?: boolean }) => {
    createdModels.push({ id, options });
    return { bindTools: (tools: unknown[]) => {
    expect(tools).toHaveLength(0);
    return { invoke: (messages: BaseMessage[], config: RunnableConfig) => perform(messages, ensureConfig(config)) };
  } }; } }));
  invocation = await import("../../src/utils/chat-model-invocation");
  createHelper = (await import("../../src/tools/security/research-note-draft")).createResearchNoteDraft;
});
afterAll(() => {
  invocation._setFirstTokenTimeoutMsForTests(undefined);
  if (originalKey === undefined) delete process.env["FIREWORKS_API_KEY"]; else process.env["FIREWORKS_API_KEY"] = originalKey;
  globalThis.fetch = oldFetch; mock.restore();
  resetRuntimeModelCatalog();
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const call = (signal?: AbortSignal) => invocation.invokeChatModelWithFallback([new HumanMessage("Visible source")], [], MODEL,
  "owner", "agent", null, { ...(signal ? { signal } : {}), callbacks: [] }, { modelFallbackMode: "none", sameModelRetryMode: "none", isolatedProgress: true });

test("isolated semantic progress outlives first-progress allowance without replacing the auditor sink", async () => {
  invocation._setFirstTokenTimeoutMsForTests(80);
  const key = turnContextKey("actual-user-turn", "agent");
  const main = { attemptId: "main-attempt", reportMeaningfulProgress: mock(() => true) };
  bindModelAttemptProgressSinkByKey(key, main);
  perform = async (messages, config) => {
    const [manager] = await CallbackManager.configure(config.callbacks)!.handleChatModelStart({ lc: 1, type: "not_implemented", id: ["synthetic-provider"] }, [messages]);
    for (let index = 0; index < 6; index++) {
      expect(getAgentTurnContextByKey(key)?.modelAttemptProgressSink).toBe(main);
      await manager!.handleLLMNewToken("", undefined, undefined, undefined, undefined, { chunk: new ChatGenerationChunk({ text: "",
        message: new AIMessageChunk({ content: "", additional_kwargs: { reasoning_content: "Private reasoning delta" } }) }) });
      await delay(25);
    }
    return new AIMessage("Draft ready");
  };
  try {
    expect((await runWithTurn("actual-user-turn", () => call())).response.content).toBe("Draft ready");
    expect(getAgentTurnContextByKey(key)?.modelAttemptProgressSink).toBe(main);
    expect(main.reportMeaningfulProgress).not.toHaveBeenCalled();
  } finally { clearAgentTurnContextByKey(key); }
});

test("empty heartbeats cannot extend an isolated attempt and parent cancellation still stops it", async () => {
  invocation._setFirstTokenTimeoutMsForTests(35);
  perform = async (messages, config) => {
    const [manager] = await CallbackManager.configure(config.callbacks)!.handleChatModelStart({ lc: 1, type: "not_implemented", id: ["synthetic-provider"] }, [messages]);
    while (!config.signal?.aborted) {
      await manager!.handleLLMNewToken("", undefined, undefined, undefined, undefined, { chunk: new ChatGenerationChunk({ text: "", message: new AIMessageChunk("") }) });
      await delay(5);
    }
    throw config.signal.reason;
  };
  const timedOut: unknown = await call().catch((error: unknown) => error);
  expect(timedOut).toBeInstanceOf(Error);
  expect((timedOut as Error).message).toContain("timed out");
  const controller = new AbortController();
  const reason = new Error("Task paused by owner");
  const pending = call(controller.signal).catch((error: unknown) => error);
  controller.abort(reason);
  expect(await pending).toBe(reason);
});

test("real graph callbacks do not inherit into the helper; Task usage and exact route are preserved", async () => {
  createdModels.length = 0;
  invocation._setFirstTokenTimeoutMsForTests(undefined);
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const observedMainTokens: string[] = [];
  perform = async (messages, config) => {
    expect(getUsageContext()).toMatchObject({ callType: "subagent", userId: "owner", metadata: { taskId: "task", taskRunId: "run", purpose: "research_note_draft" } });
    expect(config.configurable?.["thread_id"]).toBeUndefined();
    const [manager] = await CallbackManager.configure(config.callbacks)!.handleChatModelStart({ lc: 1, type: "not_implemented", id: ["synthetic-provider"] }, [messages]);
    await manager!.handleLLMNewToken("HELPER_PRIVATE_TOKEN");
    finished();
    return new AIMessage("Advice");
  };
  const helper = createHelper(undefined, { eligibleIds: () => [MODEL] });
  const messages = [new AIMessage({ content: "Read source", tool_calls: [{ id: "file", name: "file", args: { command: "read", path: "access.js" } }] }),
    new ToolMessage({ name: "file", tool_call_id: "file", status: "success", content: "export function access() {}" })];
  const graph = new StateGraph(NautiloStateAnnotation).addNode("prepare", async (state) => {
    helper.observePrepared({ ...state, preparedMessages: messages });
    await done;
    return {};
  }).addEdge(START, "prepare").addEdge("prepare", END).compile();
  const input: Partial<NautiloState> = { userId: "owner", agentId: "agent", currentTaskId: "task", currentTaskRunId: "run", model: MODEL,
    taskRun: true, subagentRun: true, researchWorkEnabled: true, toolWhitelist: ["security_scan"], messages,
    taskReportBackContinuation: { status: "available" } };
  try {
    for await (const event of graph.streamEvents(input, { configurable: { thread_id: "main-task-thread" }, version: "v2",
      callbacks: [{ handleLLMNewToken: (token: string) => { observedMainTokens.push(token); } }] })) {
      expect(event.event).not.toBe("on_chat_model_stream");
    }
    expect(observedMainTokens).toHaveLength(0);
    expect(createdModels).toHaveLength(1);
    expect(createdModels[0]).toMatchObject({ id: MODEL, options: { reasoningEffort: "off", reasoningOutput: false } });
  } finally { helper.dispose(); }
});

test("real agent invocation skips oversized advice and removes fitting advice before source recovery", async () => {
  initToolCatalog(new ToolCatalog());
  const baseline = getActiveModelCatalogSync().catalog;
  const catalog = ModelCatalogSchema.parse({ ...baseline, catalogVersion: "2099.09.08.1", entries: baseline.entries.map((entry) =>
    entry.id === MODEL ? { ...entry, limits: { contextTokens: 16000, outputTokens: 4000 } } : entry) });
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog, source: "remote-fresh", stale: false, fetchedAt: "2099-09-08T00:00:00Z", originUrl: "https://catalog.invalid/unit", reason: "", catalogVersion: catalog.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog();
  const { agentNode } = await import("../../src/nodes/agent");
  const source = new HumanMessage("Full unchanged source ".repeat(400));
  const input: Partial<NautiloState> = { userId: "owner", agentId: "agent", model: MODEL, modelFallbackMode: "none", subagentDepth: 1,
    currentTaskId: "task", currentTaskRunId: "run", taskRun: true, subagentRun: true, toolWhitelist: ["security_scan"], messages: [source], preparedMessages: [source] };
  for (const oversized of [true, false]) {
    createdModels.length = 0;
    const advice = new HumanMessage("OPTIONAL_ADVICE ".repeat(oversized ? 10000 : 2));
    const received: BaseMessage[][] = [];
    perform = async (messages) => {
      received.push(messages);
      if (!oversized && received.length === 1) throw new Error("context length exceeded");
      return new AIMessage("Main auditor saved its own notes");
    };
    const graph = new StateGraph(NautiloStateAnnotation).addNode("agent", (state) => agentNode(state, undefined, undefined, false, advice))
      .addEdge(START, "agent").addEdge("agent", END).compile({ checkpointer: new (await import("@langchain/langgraph")).MemorySaver() });
    const config = { configurable: { thread_id: `draft-fit-${oversized}` } };
    const result = await graph.invoke(input, config);
    expect(received).toHaveLength(oversized ? 1 : 2);
    expect(received.at(-1)).toEqual([source]);
    if (!oversized) expect(received[0]).toEqual([source, advice]);
    expect(result.model).toBe(MODEL);
    expect(createdModels.every((attempt) => attempt.id === MODEL && attempt.options.reasoningEffort === undefined && attempt.options.reasoningOutput === true)).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain("OPTIONAL_ADVICE");
    expect(result.researchContextRecovery).toBeNull();
    for await (const snapshot of graph.getStateHistory(config)) expect(JSON.stringify(snapshot.values)).not.toContain("OPTIONAL_ADVICE");
  }
});
