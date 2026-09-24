/** Real eligibility, task guards, graph node, invocation and provider construction; no network or database. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import { NautiloStateAnnotation } from "../../src/agent/state";
import { resolveCatalogModel, resolveChinaUpstreamConsent } from "../../src/config/resolved-catalog";
import { getEligibleModels, resolveRetainedModels } from "../../src/config/eligible-models";
import { resolveModelRole } from "../../src/config/model-role-resolution";
import { resolveTaskModel } from "../../src/config/resolve-task-model";
import { validateExactTaskModelSelection } from "../../src/config/validate-exact-task-model";
import { validateTaskModelSelectionForCreate } from "../../src/tools/tasks/selection-validation";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";
import { createUniversalModel } from "../../src/providers/universal";
import { hasStubModelForTests } from "../../src/providers/stub-model-state";

const MODEL = "venice:z-ai-glm-5-3";
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["VENICE_API_KEY", "NAUTILO_ALLOW_CHINA_UPSTREAM", "NAUTILO_SKIP_VENICE_REFRESH"];
const savedFetch = globalThis.fetch;
const proto = ChatOpenAI.prototype;
const savedGenerate = proto._generate;
const generations: string[] = [];
let agentNode: typeof import("../../src/nodes/agent")["agentNode"];

beforeAll(async () => {
  for (const key of envKeys) savedEnv[key] = process.env[key];
  process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
  globalThis.fetch = (() => { throw new Error("Network disabled in routing consent test"); }) as unknown as typeof fetch;
  const realDb = await import("@nautilo/db");
  const realTrust = await import("@nautilo/trust");
  mock.module("@nautilo/db", () => ({ ...realDb,
    getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {},
  }));
  mock.module("@nautilo/trust", () => ({
    ...realTrust,
    assertCanUseServerProviderCredentials: async (humanUserId: string) => {
      expect(humanUserId).toBe("routing-fixture");
    },
  }));
  mock.module("../../src/utils/resolve-fallback-policy", () => ({
    resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }),
  }));
  // Keep the production eligibility and provider-constructor gates. Replace
  // only generation, after the ordinary model instance has been constructed.
  proto._generate = async function () {
    generations.push(this.model);
    return { generations: [{ text: "consent-graph-ok", message: new AIMessage("consent-graph-ok") }], llmOutput: {} };
  };
  initToolCatalog(new ToolCatalog());
  ({ agentNode } = await import("../../src/nodes/agent"));
});

beforeEach(() => {
  resetRuntimeModelCatalog();
  resetVeniceCatalogCacheModuleForTests();
  resetModelCapabilitiesCacheForTests();
  process.env["VENICE_API_KEY"] = "routing-fixture";
  delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
  generations.length = 0;
});

afterAll(() => {
  proto._generate = savedGenerate;
  globalThis.fetch = savedFetch;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetRuntimeModelCatalog();
  resetVeniceCatalogCacheModuleForTests();
  resetModelCapabilitiesCacheForTests();
  mock.restore();
});

test("consent interpretation preserves accepted operator tokens, explicit false, and authoritative injected env", () => {
  for (const token of ["1", "true", "yes", " TRUE "]) {
    const env = { VENICE_API_KEY: "fixture", NAUTILO_ALLOW_CHINA_UPSTREAM: token };
    expect(resolveChinaUpstreamConsent(undefined, env)).toBe(true);
    expect(resolveCatalogModel(MODEL, { env }).availability).toBe("selectable");
    expect(resolveRetainedModels([MODEL], { env })[0]?.availability).toBe("selectable");
    expect(resolveModelRole("chat", { configuredId: MODEL, env })).toBe(MODEL);
    expect(validateExactTaskModelSelection({ requestedModelId: MODEL, env })).toBeNull();
    expect(validateTaskModelSelectionForCreate({ requestedModelId: MODEL, env })).toBeNull();
    expect(resolveCatalogModel(MODEL, { env, allowChinaUpstream: false }).availability).toBe("routing_filtered");
    expect(resolveRetainedModels([MODEL], { env, allowChinaUpstream: false })[0]?.availability).toBe("filtered");
    expect(() => resolveModelRole("chat", { configuredId: MODEL, env, allowChinaUpstream: false })).toThrow(/allowChinaUpstream/);
    expect(validateTaskModelSelectionForCreate({ requestedModelId: MODEL, env, allowChinaUpstream: false })).toMatch(/routing|allowChinaUpstream/);
  }
  process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
  for (const token of [undefined, "", "false", "0", "no", "perhaps"]) {
    const env = { VENICE_API_KEY: "fixture", ...(token === undefined ? {} : { NAUTILO_ALLOW_CHINA_UPSTREAM: token }) };
    expect(resolveChinaUpstreamConsent(undefined, env)).toBe(false);
    expect(resolveCatalogModel(MODEL, { env }).availability).toBe("routing_filtered");
    expect(getEligibleModels({ env }).some((row) => row.id === MODEL)).toBe(false);
    expect(validateExactTaskModelSelection({ requestedModelId: MODEL, env })?.code).toBe("routing_filtered");
    expect(resolveCatalogModel(MODEL, { env, allowChinaUpstream: true }).availability).toBe("selectable");
  }
});

test("operator consent does not bypass credentials, catalog membership, capabilities, or selection conflicts", () => {
  process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
  expect(resolveTaskModel({ baseModelId: MODEL }).modelId).toBe(MODEL);
  expect(() => resolveTaskModel({ baseModelId: MODEL, allowChinaUpstream: false })).toThrow(/allowChinaUpstream/);
  expect(resolveCatalogModel(MODEL, { env: { NAUTILO_ALLOW_CHINA_UPSTREAM: "true" } }).availability).toBe("missing_credentials");
  expect(resolveRetainedModels([MODEL], { purpose: "image-generation" })[0]?.availability).toBe("unsupported-capability");
  expect(validateTaskModelSelectionForCreate({ requestedModelId: "venice:unlisted-model" })).toMatch(/catalog|unknown/i);
  expect(validateExactTaskModelSelection({ requestedModelId: MODEL, profile: "cheapest" })?.code).toBe("conflict");
});

test("provider construction shares consent precedence and keeps policy off provider options", async () => {
  const absent = await createUniversalModel(MODEL).catch((error: unknown) => error);
  expect(absent).toBeInstanceOf(Error);
  expect(String(absent)).toMatch(/allowChinaUpstream|opt-in/);
  process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
  const model = await createUniversalModel(MODEL);
  expect(model).toBeDefined();
  const denied = await createUniversalModel(MODEL, { allowChinaUpstream: false }).catch((error: unknown) => error);
  expect(denied).toBeInstanceOf(Error);
  expect(String(denied)).toMatch(/allowChinaUpstream|opt-in/);
  expect((model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs?.["allowChinaUpstream"]).toBeUndefined();
  expect(generations).toHaveLength(0);
});

async function runGraph() {
  const graph = new StateGraph(NautiloStateAnnotation)
    .addNode("consent_agent", agentNode)
    .addEdge(START, "consent_agent")
    .addEdge("consent_agent", END)
    .compile();
  const prompt = new HumanMessage("Review the authorized source.");
  return graph.invoke({ model: MODEL, modelFallbackMode: "none", subagentDepth: 1, subagentRun: true,
    userId: "routing-fixture", causalHumanUserId: "routing-fixture", agentId: "routing-agent", turnId: "routing-turn", roomId: "", messages: [prompt], preparedMessages: [prompt] });
}

test("actual Task graph preserves an opted-in exact model through role, invocation and provider gates", async () => {
  expect(hasStubModelForTests()).toBe(false);
  process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
  const result = await runGraph();
  expect(result.model).toBe(MODEL);
  expect(result.messages.at(-1)?.content).toBe("consent-graph-ok");
  expect(generations).toEqual(["z-ai-glm-5-3"]);
});

test("actual Task graph denies absent or revoked operator consent before generation", async () => {
  for (const token of [undefined, "false"]) {
    if (token === undefined) delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
    else process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = token;
    const failure = await runGraph().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/allowChinaUpstream/);
  }
  expect(generations).toHaveLength(0);
});
