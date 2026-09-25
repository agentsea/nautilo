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
  return { modelId: "openrouter:deepseek/deepseek-v4.1-flash", instructions: "Choose from current evidence.",
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
  expect(resolveNativeControllerModel("openrouter:qwen/qwen3.8-flash")).toBeNull();
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
  return { bindTools: () => { throw new Error("must not bind tools"); }, invoke: async () => response };
}
function response(choice = "a1_0") {
  return { content: choice,
    usage_metadata: { input_tokens: 90, output_tokens: 4, total_tokens: 94, input_token_details: { cache_read: 70 } } };
}
async function expectFailure(promise: Promise<unknown>, message?: string) {
  const error: unknown = await promise.then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (message) expect((error as Error).message).toBe(message);
}

test("real controller adapter returns only a validated ID and measured usage", async () => {
  const result = await invokeNativeController(input(), async (id, options) => {
    expect(id).toBe(input().modelId);
    expect(options).toEqual({ reasoningEffort: "off", reasoningOutput: false });
    return modelReturning(response());
  });
  expect(result).toMatchObject({ selectedId: "a1_0", usage: { inputTokens: 90, outputTokens: 4, cacheReadTokens: 70, actualCostUsd: null } });
  expect(Object.hasOwn(result, "args")).toBe(false);
});

test("instruction prefix stays fixed and no tool schema or generated JSON is needed", async () => {
  const messages: unknown[][] = [];
  const model: ChatModel = { bindTools: () => { throw new Error("must not bind tools"); },
    invoke: async (sent, config) => {
      messages.push(sent); expect(config?.["signal"]).toBeInstanceOf(AbortSignal);
      expect(config?.["metadata"]).toEqual({ nautilo_output_visibility: "internal_decision" });
      return response();
    } };
  const original = input();
  await invokeNativeController(original, async () => model);
  await invokeNativeController({ ...original, choices: [...original.choices, { id: "a2_1", description: "Another control" }] }, async () => model);
  expect(messages[0]![0]).toEqual(messages[1]![0]);
  const tail = messages[0]![1] as { content: string };
  expect(JSON.parse(tail.content)).toEqual({ state: original.state, choices: original.choices });
  expect(JSON.stringify(messages[0]![0])).not.toContain("a1_0");
});

test("rejects invented IDs, reconstructed inputs, prose and multiple selections", async () => {
  for (const invalid of [response("unissued"),
    { tool_calls: [{ name: "select_native_choice", args: { choice: "a1_0", text: "changed" } }] },
    { content: '{"choice":"a1_0"}' },
    { content: "a1_0 request_replan" },
    { content: "a1_0", invalid_tool_calls: [{ name: "invented" }] },
  ]) await expectFailure(invokeNativeController(input(), async () => modelReturning(invalid)), "invalid_native_controller_selection");
});

test("late cancellation and model removal cannot create a selection", async () => {
  const abort = new AbortController();
  await expectFailure(invokeNativeController(input(abort.signal), async () => ({
    invoke: async () => { abort.abort(); return response(); },
  })));
  let calls = 0;
  await expectFailure(invokeNativeController({ ...input(), modelId: "openrouter:removed/model" }, async () => {
    calls++; return modelReturning(response());
  }), "native_controller_unavailable");
  expect(calls).toBe(0);
});

test("unreported usage stays unknown rather than claiming zero tokens or free execution", async () => {
  const result = await invokeNativeController(input(), async () => modelReturning({ content: "a1_0" }));
  expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null });
});
