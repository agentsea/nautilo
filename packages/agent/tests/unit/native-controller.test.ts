import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ChatModel } from "../../src/providers/types";
import type { ChoiceInput } from "../../src/providers/choice";
import { invokeNativeController } from "../../src/providers/native-controller";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resolveNativeControllerModel } from "../../src/config/native-decision-model";

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "synthetic-controller-test";
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
});
afterEach(() => {
  if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]; else process.env["OPENROUTER_API_KEY"] = previousKey;
  resetRuntimeModelCatalog();
});
function input(signal = new AbortController().signal): ChoiceInput {
  return { modelId: "openrouter:qwen/qwen3.8-flash", instructions: "Choose from current evidence.",
    state: { goal: "Insert the supplied value", values: { content: "Unchanged 🌊\ncontent" } },
    choices: [{ id: "a1_0", description: "Insert content into observed editor" }, { id: "request_replan", description: "Return for replanning" }], signal };
}

test("prototype controller remains pinned while catalogue withdrawal, capabilities and credentials stay authoritative", async () => {
  const catalog = structuredClone(getActiveModelCatalogSync().catalog);
  const template = catalog.entries.find(entry => entry.id === input().modelId)!;
  catalog.entries = [
    { ...template, priority: 20 },
    { ...template, id: "openrouter:example/general-chat", priority: 1 },
  ];
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog, source: "remote-fresh", stale: false,
      fetchedAt: "2026-09-20T00:00:00.000Z", originUrl: "https://catalog.invalid/controller.json",
      reason: "", catalogVersion: catalog.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog();
  expect(resolveNativeControllerModel()?.id).toBe(input().modelId);
  expect(resolveNativeControllerModel("openrouter:example/general-chat")).toBeNull();
  catalog.entries[0]!.defaultEnabled = false;
  await hydrateRuntimeModelCatalog();
  expect(resolveNativeControllerModel()).toBeNull();
  expect(resolveNativeControllerModel(input().modelId)).toBeNull();
  catalog.entries[0]!.defaultEnabled = true;
  catalog.entries[0]!.features!.tools = false;
  await hydrateRuntimeModelCatalog();
  expect(resolveNativeControllerModel()).toBeNull();
  catalog.entries[0]!.features!.tools = true;
  await hydrateRuntimeModelCatalog();
  delete process.env["OPENROUTER_API_KEY"];
  expect(resolveNativeControllerModel()).toBeNull();
});
function modelReturning(response: unknown): ChatModel {
  return { bindTools: () => ({ invoke: async () => response }), invoke: async () => { throw new Error("must bind"); } };
}
function response(choice = "a1_0") {
  return { content: "", tool_calls: [{ id: "pick", name: "select_native_choice", args: { choice } }],
    usage_metadata: { input_tokens: 90, output_tokens: 4, total_tokens: 94, input_token_details: { cache_read: 70 } } };
}
async function expectFailure(promise: Promise<unknown>, message?: string) {
  const error: unknown = await promise.then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (message) expect((error as Error).message).toBe(message);
}

test("real controller adapter returns only a validated ID and measured usage", async () => {
  const result = await invokeNativeController(input(), async () => modelReturning(response()));
  expect(result).toMatchObject({ selectedId: "a1_0", usage: { inputTokens: 90, outputTokens: 4, cacheReadTokens: 70, actualCostUsd: null } });
  expect(Object.hasOwn(result, "args")).toBe(false);
});

test("schema and instruction prefix stay fixed while exact content and changing choices remain in the tail", async () => {
  const tools: unknown[] = [];
  const messages: unknown[][] = [];
  const model: ChatModel = { bindTools: (definitions, options) => {
    tools.push(definitions);
    expect(options).toEqual({ tool_choice: "auto", parallel_tool_calls: false });
    return { invoke: async (sent, config) => {
      messages.push(sent); expect(config?.["signal"]).toBeInstanceOf(AbortSignal);
      return response();
    } };
  }, invoke: async () => { throw new Error("must bind"); } };
  const original = input();
  await invokeNativeController(original, async () => model);
  await invokeNativeController({ ...original, choices: [...original.choices, { id: "a2_1", description: "Another control" }] }, async () => model);
  expect(tools[0]).toEqual(tools[1]);
  expect(messages[0]![0]).toEqual(messages[1]![0]);
  const tail = messages[0]![1] as { content: string };
  expect(JSON.parse(tail.content)).toEqual({ state: original.state, choices: original.choices });
  expect(JSON.stringify(tools[0])).not.toContain("a1_0");
});

test("rejects invented IDs, reconstructed inputs, prose and multiple selections", async () => {
  for (const invalid of [response("unissued"),
    { tool_calls: [{ name: "select_native_choice", args: { choice: "a1_0", text: "changed" } }] },
    { content: '{"choice":"a1_0"}' },
    { tool_calls: [...response().tool_calls, ...response().tool_calls] },
    { tool_calls: response().tool_calls, invalid_tool_calls: [{ name: "invented" }] },
  ]) await expectFailure(invokeNativeController(input(), async () => modelReturning(invalid)), "invalid_native_controller_selection");
});

test("late cancellation and model removal cannot create a selection", async () => {
  const abort = new AbortController();
  await expectFailure(invokeNativeController(input(abort.signal), async () => ({
    bindTools: () => ({ invoke: async () => { abort.abort(); return response(); } }), invoke: async () => null,
  })));
  let calls = 0;
  await expectFailure(invokeNativeController({ ...input(), modelId: "openrouter:removed/model" }, async () => {
    calls++; return modelReturning(response());
  }), "native_controller_unavailable");
  expect(calls).toBe(0);
});

test("unreported usage stays unknown rather than claiming zero tokens or free execution", async () => {
  const result = await invokeNativeController(input(), async () => modelReturning({ tool_calls: response().tool_calls }));
  expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null });
});
