import { expect, test } from "bun:test";
import { serverModelConfigSchema } from "../../src/client";

const base = {
  defaultChatModel: "provider:chat",
  conductorModel: "",
  stenographerModel: "provider:small",
  reflectionModel: "provider:small",
  memoryReviewModel: null,
  fallbackChain: [],
  reasoningOutput: {},
  reasoningPolicy: { defaultEffort: null, overrides: {} },
};

test("older model-config payloads leave catalogModels absent", () => {
  const parsed = serverModelConfigSchema.parse(base);
  expect(parsed.catalogModels).toBeUndefined();
});

test("catalog model rows retain safe forward-compatible display fields and strip extras", () => {
  const parsed = serverModelConfigSchema.parse({
    ...base,
    catalogModels: [{
      id: "future:decision",
      displayName: "Future Decision",
      provider: "future-provider",
      workload: "future-workload",
      availability: "policy_pending",
      unavailableReason: "Account policy does not permit this model.",
      input: ["text"],
      output: ["choice"],
      features: {
        tools: true,
        structuredOutputs: true,
        reasoning: null,
        visualGrounding: null,
        webSearch: false,
        e2ee: null,
      },
      decision: { operations: ["choice", "future-operation"] },
      providerCredential: "must-not-project",
      internalRouting: { pool: "private" },
    }],
  });

  expect(parsed.catalogModels).toEqual([{
    id: "future:decision",
    displayName: "Future Decision",
    provider: "future-provider",
    workload: "future-workload",
    availability: "policy_pending",
    unavailableReason: "Account policy does not permit this model.",
    input: ["text"],
    output: ["choice"],
    features: {
      tools: true,
      structuredOutputs: true,
      reasoning: null,
      visualGrounding: null,
      webSearch: false,
      e2ee: null,
    },
    decision: { operations: ["choice", "future-operation"] },
  }]);
});
