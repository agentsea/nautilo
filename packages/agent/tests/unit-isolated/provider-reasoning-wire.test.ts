/** Real invocation/factory/serializer; only transport and DB configuration are hermetic. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAICompletions } from "@langchain/openai";
import { ChatFireworks } from "@langchain/fireworks";
import { ModelCatalogSchema, type ModelCatalogReasoningEffort } from "@nautilo/types";
import { configureRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resolveModelControlSelection, type ModelControlPolicy } from "../../src/config/model-control-selection";

const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({ ...actualTrust,
  assertCanUseServerProviderCredentials: mock(async (humanUserId: string) => {
    expect(humanUserId).toBe("owner");
  }),
}));

const MODELS = ["openrouter:deepseek/deepseek-v4-flash-0731", "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731"] as const;
const oldFetch = globalThis.fetch;
const keys = ["OPENROUTER_API_KEY", "FIREWORKS_API_KEY"] as const;
const oldKeys = keys.map((key) => process.env[key]);
const openAI = ChatOpenAICompletions.prototype as unknown as { completionWithRetry: unknown };
const fireworks = ChatFireworks.prototype as unknown as { completionWithRetry: unknown };
const oldOpenAI = openAI.completionWithRetry;
const oldFireworks = fireworks.completionWithRetry;
const oldFireworksTokens = ChatFireworks.prototype.getNumTokens;
const requests: Record<string, unknown>[] = [];
let invocation: typeof import("../../src/utils/chat-model-invocation");
let baseline: ReturnType<typeof getActiveModelCatalogSync>["catalog"];

beforeAll(async () => {
  for (const key of keys) process.env[key] = "synthetic-wire-test-key";
  globalThis.fetch = mock(async () => { throw new Error("Unexpected network in provider wire test"); }) as unknown as typeof fetch;
  mock.module("../../src/utils/resolve-fallback-policy", () => ({ resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }) }));
  const realDb = await import("@nautilo/db");
  mock.module("@nautilo/db", () => ({ ...realDb, getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {}, refreshServerModelConfigCache: async () => null, primeServerModelConfigCache: () => {} }));
  invocation = await import("../../src/utils/chat-model-invocation");
  baseline = getActiveModelCatalogSync().catalog;
  const transport = async (request: Record<string, unknown>) => {
    requests.push(request);
    if (request["stream"] === true) return (async function* () {
      yield { id: "wire", object: "chat.completion.chunk", model: request["model"], choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] };
      yield { id: "wire", object: "chat.completion.chunk", model: request["model"], choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
    })();
    return { id: "wire", object: "chat.completion", model: request["model"], choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
  };
  // The SDK estimates streaming usage after completion by downloading a
  // tokenizer. Keep that unrelated accounting hermetic; wire serialization and
  // real stream conversion remain intact.
  ChatFireworks.prototype.getNumTokens = async () => 1;
  openAI.completionWithRetry = transport;
  fireworks.completionWithRetry = transport;
});
afterAll(() => {
  openAI.completionWithRetry = oldOpenAI; fireworks.completionWithRetry = oldFireworks;
  ChatFireworks.prototype.getNumTokens = oldFireworksTokens;
  globalThis.fetch = oldFetch;
  keys.forEach((key, index) => { if (oldKeys[index] === undefined) delete process.env[key]; else process.env[key] = oldKeys[index]; });
  mock.restore(); resetRuntimeModelCatalog();
});

async function catalog(mode: "optional" | "mandatory" | "absent" = "optional") {
  const value = ModelCatalogSchema.parse({ ...baseline, catalogVersion: "2099.09.08.1", entries: baseline.entries.map((entry) => {
    if (!MODELS.some((id) => id === entry.id)) return entry;
    return { ...entry, defaultEnabled: true, limits: { contextTokens: 32768, outputTokens: 8192 }, controls: mode === "absent" ? undefined : { reasoning: {
      levels: ["low", "medium", "high", "max"], defaultLevel: "high", canDisable: mode === "optional", mandatory: mode === "mandatory",
      provenance: { kind: "provider-documentation", provider: entry.provider, verifiedAt: "2026-09-08T00:00:00Z" },
    } } };
  }) });
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog: value, source: "remote-fresh", stale: false, fetchedAt: "2099-09-08T00:00:00Z", originUrl: "https://catalog.invalid/wire", reason: "", catalogVersion: value.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog(); requests.length = 0;
}

function call(modelId: string, effort?: ModelCatalogReasoningEffort, policy?: ModelControlPolicy, rawControl = false, reasoningOutput = true) {
  return invocation.invokeChatModelWithFallback([new HumanMessage("Wire contract fixture")], [], modelId, "owner", "agent", null, { callbacks: [] }, {
    modelFallbackMode: "none", sameModelRetryMode: "none", reasoningOutput, fundingHumanUserId: "owner",
    ...(effort === undefined ? {} : { resolveForegroundControls: (id: string) => {
      if (rawControl) return { canonicalModelId: id, reasoningEffort: effort };
      const resolved = resolveModelControlSelection({ catalogByModelId: new Map(getActiveModelCatalogSync().catalog.entries.map((entry) => [entry.id, entry])),
        catalogDefaultModelId: id, turnOverride: { modelId: id, reasoningEffort: effort },
        ...(policy ? { policyByModelId: new Map([[id, policy]]) } : {}) });
      if (resolved.status !== "resolved") throw new Error(resolved.reason);
      return { canonicalModelId: id, ...(resolved.effective.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.effective.reasoningEffort }) };
    } }),
  });
}

for (const model of MODELS) {
  test(`${model}: explicit off reaches the serialized request despite invocation disabling reasoning output`, async () => {
    await catalog();
    expect((await call(model, "off")).response.content).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["model"]).toBe(model.slice(model.indexOf(":") + 1));
    if (model.startsWith("openrouter:")) {
      expect(requests[0]?.["reasoning"]).toEqual({ enabled: false });
      expect(requests[0]?.["reasoning_effort"]).toBeUndefined();
    } else {
      expect(requests[0]?.["reasoning_effort"]).toBe("none");
      expect(requests[0]?.["reasoning"]).toBeUndefined();
    }
  });
  test(`${model}: advertised max remains max on the wire`, async () => {
    await catalog(); await call(model, "max");
    expect(requests).toHaveLength(1);
    expect(model.startsWith("openrouter:") ? requests[0]?.["reasoning"] : requests[0]?.["reasoning_effort"])
      .toEqual(model.startsWith("openrouter:") ? { effort: "max", exclude: false } : "max");
  });
  test(`${model}: hiding output without an explicit off never sends disablement`, async () => {
    await catalog(); await call(model, undefined, undefined, false, false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["reasoning"]).toBeUndefined(); expect(requests[0]?.["reasoning_effort"]).toBeUndefined();
  });
  test(`${model}: absent/mandatory catalog controls reject off even if a caller bypasses selection`, async () => {
    for (const mode of ["absent", "mandatory"] as const) {
      await catalog(mode);
      const error: unknown = await call(model, "off", undefined, true).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("not supported by the catalog controls");
      expect(requests).toHaveLength(0);
    }
  });
  test(`${model}: canonical server policy still blocks explicit controls before provider dispatch`, async () => {
    await catalog();
    const off: unknown = await call(model, "off", { reasoningEnabled: false }).catch((error: unknown) => error);
    const max: unknown = await call(model, "max", { allowedReasoningEfforts: ["low"] }).catch((error: unknown) => error);
    expect(off).toBeInstanceOf(Error); expect((off as Error).message).toContain("reasoning-disabled-by-policy");
    expect(max).toBeInstanceOf(Error); expect((max as Error).message).toContain("reasoning-effort-not-allowed");
    expect(requests).toHaveLength(0);
  });
}
