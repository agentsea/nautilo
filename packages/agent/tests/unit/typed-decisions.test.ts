import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as usageRecorder from "../../src/usage/record-usage";
import { invokeDecision } from "../../src/providers/decision-driver";
import { invokeProviderChoice } from "../../src/providers/provider-choice";
import { decisionQuestionSchema, type DecisionQuestion, type DecisionAnswer, type DecisionInput } from "../../src/providers/decision";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import { resolveCatalogModel } from "../../src/config/resolved-catalog";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import { ModelCatalogV5Schema, ModelCatalogV6Schema } from "@nautilo/types";
import { resolveModelPrice } from "../../src/config/model-pricing";
import { decisionToolUnavailable, createEvaluateDecisionsTool } from "../../src/tools/meta/evaluate-decisions";
import type { RecordUsageInput } from "../../src/usage/record-usage";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

const questions = {
  department: { type: "choice", instructions: "Select department", criteria: { billing: "Payments", other: null } },
  refund: { type: "noul", instructions: "Does the customer request a refund?" },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["Not urgent", "Emergency"] },
} satisfies Record<string, DecisionQuestion>;
const answers = {
  department: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, other: 0.1 } },
  refund: { type: "noul", noul: 0.99 },
  urgency: { type: "score", score: 0.1, confidence: 0.9, legend: { "0": "Not urgent", "1": "Emergency" }, probabilities: { "0": 0.9, "1": 0.1 } },
} satisfies Record<string, DecisionAnswer>;
const routes = [
  ["typesafe", "typesafe:jev-1.13.0", "https://api.typesafe.ai/v1/systemone", "TYPESAFE_API_KEY"],
  ["venice", "venice:jev-latest", "https://api.venice.ai/api/v1/decisions", "VENICE_API_KEY"],
  ["openrouter", "openrouter:typesafe/jev-1.13", "https://openrouter.ai/api/alpha/decisions", "OPENROUTER_API_KEY"],
] as const;
const input = (modelId: string = routes[0][1]) => ({ modelId, state: "Refund the duplicate payment. No rush.", questions: structuredClone(questions), signal: new AbortController().signal });
const payload = (result: unknown = answers) => ({ model: "jev-1.13.0", answers: result, usage: { input_tokens: 395, output_tokens: 69 } });
const mockFetch = (value: unknown) => (async () => Response.json(value)) as unknown as typeof fetch;
const funded = {
  fundingHumanUserId: "synthetic-human",
  assertCanUseServerProviderCredentials: async () => {},
} as const;
let previousSkip: string | undefined;
beforeEach(() => { previousSkip = process.env["NAUTILO_SKIP_VENICE_REFRESH"]; process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1"; resetRuntimeModelCatalog(); resetVeniceCatalogCacheModuleForTests(); resetModelCapabilitiesCacheForTests(); });
afterEach(() => { if (previousSkip === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"]; else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = previousSkip; resetRuntimeModelCatalog(); });

describe("typed decision adapters", () => {
  for (const [provider, modelId, endpoint, envKey] of routes) {
    test(`${provider}: one batch, exact route, caller signal, one attributed usage record`, async () => {
      const request = input(modelId); const records: RecordUsageInput[] = []; let calls = 0;
      const result = await invokeDecision(request, { ...funded, apiKey: "synthetic-key", recordUsage: (record) => records.push(record), fetch: (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        calls++; expect(url).toBe(endpoint); expect(init?.signal).toBe(request.signal); expect(init?.redirect).toBe("error");
        expect(JSON.parse(init!.body as string)).toEqual({ model: modelId.slice(provider.length + 1), state: request.state, questions });
        return Response.json(payload());
      }) as unknown as typeof fetch });
      expect(calls).toBe(1); expect(result.answers).toEqual(answers); expect(result.usage.actualCostUsd).toBeNull();
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ model: modelId, inputTokens: 395, outputTokens: 69, metadata: { operation: "decision" } });
      expect(JSON.stringify(records)).not.toContain(request.state); expect(result.requestedModelId).toBe(modelId);
      expect(resolveCatalogModel(modelId, { env: {} }).availability).toBe("missing_credentials");
      expect(resolveCatalogModel(modelId, { env: { [envKey]: "synthetic-key" } }).availability).toBe("selectable");
    });
    test(`${provider}: compatibility Choice remains usable`, async () => {
      const result = await invokeProviderChoice(provider, { modelId, state: "Refund", instructions: "Select", choices: [{ id: "billing", description: "Payments" }], signal: new AbortController().signal }, { ...funded, apiKey: "synthetic-key", recordUsage: () => {}, fetch: mockFetch(payload({ candidate: { type: "choice", choice: "billing" } })) });
      expect(result.selectedId).toBe("billing");
    });
  }
  test("rejects incomplete, extra, mismatched and malformed answers but records consumed usage", async () => {
    for (const result of [
      { ...answers, refund: undefined }, { ...answers, extra: answers.refund },
      { ...answers, refund: { type: "noul", noul: 1.01 } },
      { ...answers, refund: { type: "noul", noul: 0.8, confidence: 1 } },
      { ...answers, department: { ...answers.department, choice: "unknown" } },
      { ...answers, department: { ...answers.department, probabilities: { billing: 0.1, other: 0.9 } } },
      { ...answers, urgency: { ...answers.urgency, score: 2 } },
      { ...answers, urgency: { ...answers.urgency, legend: { "0": "Reversed", "1": "Emergency" } } },
      { ...answers, urgency: { ...answers.urgency, probabilities: { "0": 0, "1": 0 } } },
    ]) {
      const records: RecordUsageInput[] = [];
      expect(await invokeDecision(input(), { ...funded, apiKey: "synthetic-key", fetch: mockFetch(payload(result)), recordUsage: (r) => records.push(r) }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_response" });
      expect(records).toHaveLength(1);
    }
  });
  test("cancellation before dispatch makes no call; cancellation after usage never returns results", async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    expect(await invokeDecision({ ...input(), signal: controller.signal }, { fetch: (async () => { calls++; return Response.json(payload()); }) as unknown as typeof fetch }).catch((error: unknown) => error)).toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
    const late = new AbortController(); const records: RecordUsageInput[] = [];
    expect(await invokeDecision({ ...input(), signal: late.signal }, { ...funded, apiKey: "synthetic-key", fetch: mockFetch(payload()), recordUsage: (r) => { records.push(r); late.abort(); } }).catch((error: unknown) => error)).toMatchObject({ code: "cancelled" });
    expect(records).toHaveLength(1);
  });
  test("rejects provider bounds without truncation or network IO", async () => {
    let calls = 0; const fetch = (async () => { calls++; return Response.json(payload()); }) as unknown as typeof globalThis.fetch;
    for (const questions of [{ q: { type: "choice", instructions: "Choose", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])) } }, { q: { type: "score", instructions: "Rate", criteria: Array(11).fill("level") } }]) {
      expect(await invokeDecision({ ...input(), questions } as DecisionInput, { apiKey: "synthetic-key", fetch }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_request" });
    }
    expect(calls).toBe(0);
  });
  test("checks the exact causal Human before provider network IO", async () => {
    let fetchCalls = 0;
    const seen: Array<[string, string | undefined]> = [];
    const result = await invokeDecision(input(), {
      apiKey: "synthetic-key",
      fundingHumanUserId: "human-denied",
      assertCanUseServerProviderCredentials: async (humanUserId, origin) => {
        seen.push([humanUserId, origin]);
        throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
      },
      fetch: (async () => {
        fetchCalls += 1;
        return Response.json(payload());
      }) as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: "server_provider_credentials_required",
      humanUserId: "human-denied",
      origin: "decision_model",
    });
    expect(seen).toEqual([["human-denied", "decision_model"]]);
    expect(fetchCalls).toBe(0);
  });
});

describe("catalog and admitted tool", () => {
  test("strict old reader rejects new typed metadata; unknown extraction cannot invent execution", () => {
    expect(ModelCatalogV6Schema.safeParse(localModelCatalog).success).toBe(true);
    expect(ModelCatalogV5Schema.safeParse({ ...localModelCatalog, version: 5 }).success).toBe(false);
    const source = localModelCatalog.entries.find((r) => r.id === routes[0][1])!;
    expect(ModelCatalogV6Schema.safeParse({ ...localModelCatalog, entries: [{ ...source, decision: { operations: ["extraction"], inputTokens: 32000, maxChoices: 255 } }] }).success).toBe(false);
    expect(resolveCatalogModel("typesafe:nonexistent", { env: { TYPESAFE_API_KEY: "synthetic-key" } }).availability).toBe("unknown_model");
  });
  test("catalog pricing preserves free promotions and output rates", () => {
    expect(resolveModelPrice("venice:jev-latest")).toMatchObject({ source: "catalog_decision", price: { inputPerMtok: 0, outputPerMtok: 0 } });
    expect(resolveModelPrice("typesafe:jev-1.13.0")).toMatchObject({ source: "catalog_decision", price: { inputPerMtok: 0.042, outputPerMtok: 0 } });
  });
  test("probability instructions and typed schemas are required", () => {
    expect(decisionQuestionSchema.safeParse({ type: "noul", criteria: {} }).success).toBe(false);
    expect(decisionQuestionSchema.safeParse(questions.refund).success).toBe(true);
  });
  test("direct tool invocation fails closed outside an admitted non-encrypted turn", async () => {
    for (const context of [undefined, {}, { turnId: "synthetic" }, { turnId: "synthetic", fullEncryptionOnly: true }]) {
      expect(decisionToolUnavailable(context)).not.toBeNull();
      expect(JSON.parse(await createEvaluateDecisionsTool(context).invoke({ model_id: routes[0][1], state: "Synthetic", questions })) as unknown).toMatchObject({ error: "unavailable" });
    }
    expect(decisionToolUnavailable({ turnId: "synthetic", fullEncryptionOnly: false })).toBeNull();
  });
  test("the admitted tool records its server-authored user, room and turn without ambient attribution", async () => {
    const previousKey = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "synthetic-key";
    const record = spyOn(usageRecorder, "recordLlmUsage").mockImplementation(() => {});
    const fetch = spyOn(globalThis, "fetch").mockImplementation(mockFetch(payload()));
    try {
      const tool = createEvaluateDecisionsTool({ turnId: "synthetic-turn", userId: "agent-owner", causalHumanUserId: "synthetic-user", roomId: "synthetic-room", agentId: "synthetic-agent", fullEncryptionOnly: false }, {
        assertCanUseServerProviderCredentials: async () => {},
      });
      const result: unknown = JSON.parse(await tool.invoke({ model_id: routes[0][1], state: "Synthetic", questions }, { signal: new AbortController().signal }));
      expect(result).toMatchObject({ answers });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]?.[0]).toMatchObject({ userId: "synthetic-user", roomId: "synthetic-room", metadata: { turnId: "synthetic-turn", agentId: "synthetic-agent", tool: "evaluate_decisions" } });
    } finally {
      record.mockRestore(); fetch.mockRestore();
      if (previousKey === undefined) delete process.env["TYPESAFE_API_KEY"]; else process.env["TYPESAFE_API_KEY"] = previousKey;
    }
  });
  test("the admitted tool preserves a server-funding denial", async () => {
    const previousKey = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "synthetic-key";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(mockFetch(payload()));
    try {
      const tool = createEvaluateDecisionsTool({
        turnId: "synthetic-turn",
        userId: "agent-owner",
        causalHumanUserId: "human-denied",
        fullEncryptionOnly: false,
      }, {
        assertCanUseServerProviderCredentials: async (humanUserId, origin) => {
          throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      });
      const error = await tool.invoke(
        { model_id: routes[0][1], state: "Synthetic", questions },
        { signal: new AbortController().signal },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "server_provider_credentials_required",
        humanUserId: "human-denied",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      if (previousKey === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = previousKey;
    }
  });
});
