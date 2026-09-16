import { describe, test, expect } from "bun:test";
import {
  filterModels,
  formatModelCapabilityBadges,
  formatProviderGroupLabel,
  groupModelsByProvider,
  isSupportedCustomModelId,
  modelHasReasoningCapability,
  patchReasoningOutputMap,
  providerFromModelId,
  resolveStreamReasoningEnabled,
} from "../../src/pages/settings/sections/model-browser-helpers";
import type { AssistantModelSummary } from "@nautilo/api-client";

describe("providerFromModelId", () => {
  test("prefix before colon", () => {
    expect(providerFromModelId("anthropic:claude-sonnet")).toBe("anthropic");
    expect(providerFromModelId("openai:gpt-5")).toBe("openai");
  });

  test("no colon or empty → unknown (matches @nautilo/agent)", () => {
    expect(providerFromModelId("weird")).toBe("unknown");
    expect(providerFromModelId("")).toBe("unknown");
  });

  test("formats known routed providers", () => {
    expect(formatProviderGroupLabel("openrouter")).toBe("OpenRouter");
    expect(formatProviderGroupLabel("xai")).toBe("xAI");
    expect(formatProviderGroupLabel("together")).toBe("Together");
  });
});

describe("isSupportedCustomModelId", () => {
  test("accepts supported provider prefixes", () => {
    expect(isSupportedCustomModelId("openrouter:z-ai/glm-5.1")).toBe(true);
    expect(isSupportedCustomModelId("fireworks:accounts/fireworks/models/glm-5p1")).toBe(true);
    expect(isSupportedCustomModelId("anthropic:claude-sonnet-4-6")).toBe(true);
  });

  test("rejects ids that cannot route through the model factory", () => {
    expect(isSupportedCustomModelId("z-ai/glm-5.1")).toBe(false);
    expect(isSupportedCustomModelId("")).toBe(false);
    expect(isSupportedCustomModelId("not-a-provider:model")).toBe(false);
  });
});

describe("filterModels", () => {
  const models: AssistantModelSummary[] = [
    {
      id: "openai:gpt-5",
      displayName: "GPT-5",
      priority: 1,
      enabled: true,
      costCoefficient: 1,
    },
    {
      id: "anthropic:claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      priority: 2,
      enabled: true,
      costCoefficient: 1,
    },
  ];

  test("returns all when query empty", () => {
    expect(filterModels(models, "")).toHaveLength(2);
  });

  test("matches display name and provider label", () => {
    expect(filterModels(models, "claude").map((m) => m.id)).toEqual(["anthropic:claude-sonnet-4-6"]);
    expect(filterModels(models, "openai").map((m) => m.id)).toEqual(["openai:gpt-5"]);
  });
});

describe("formatModelCapabilityBadges", () => {
  test("includes routing and capability flags for Venice rows", () => {
    const m: AssistantModelSummary = {
      id: "venice:zai-org-glm-5-1",
      displayName: "GLM",
      priority: 1,
      enabled: true,
      costCoefficient: 1,
      routing: "western-anonymized",
      capabilities: {
        tools: true,
        vision: false,
        reasoning: true,
        e2ee: false,
        webSearch: false,
      },
    };
    expect(formatModelCapabilityBadges(m)).toEqual(["Western anonymized", "Tools", "Reasoning"]);
  });
});

describe("groupModelsByProvider", () => {
  const models: AssistantModelSummary[] = [
    {
      id: "openai:gpt",
      displayName: "GPT",
      priority: 2,
      enabled: true,
      costCoefficient: 1,
    },
    {
      id: "anthropic:opus",
      displayName: "Opus",
      priority: 1,
      enabled: true,
      costCoefficient: 1.6,
    },
    {
      id: "anthropic:sonnet",
      displayName: "Sonnet",
      priority: 3,
      enabled: true,
      costCoefficient: 1,
    },
  ];

  test("groups and sorts providers (known order first)", () => {
    const groups = groupModelsByProvider(models);
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "openai"]);
  });

  test("sorts models within provider by priority", () => {
    const groups = groupModelsByProvider(models);
    const anthropic = groups.find((g) => g.provider === "anthropic")!;
    expect(anthropic.items.map((m) => m.id)).toEqual([
      "anthropic:opus",
      "anthropic:sonnet",
    ]);
  });
});

describe("D331 stream reasoning helpers", () => {
  const reasoningModel = {
    id: "anthropic:sonnet",
    displayName: "Sonnet",
    priority: 1,
    costCoefficient: 1,
    capabilities: { reasoning: true },
  } satisfies AssistantModelSummary;

  test("modelHasReasoningCapability", () => {
    expect(modelHasReasoningCapability(reasoningModel)).toBe(true);
    expect(
      modelHasReasoningCapability({
        ...reasoningModel,
        capabilities: { reasoning: false },
      }),
    ).toBe(false);
  });

  test("resolveStreamReasoningEnabled defaults to on", () => {
    expect(resolveStreamReasoningEnabled({}, "anthropic:sonnet")).toBe(true);
    expect(
      resolveStreamReasoningEnabled({ "anthropic:sonnet": false }, "anthropic:sonnet"),
    ).toBe(false);
  });

  test("patchReasoningOutputMap removes key when re-enabled", () => {
    expect(
      patchReasoningOutputMap({ "anthropic:sonnet": false }, "anthropic:sonnet", true),
    ).toEqual({});
    expect(patchReasoningOutputMap({}, "anthropic:sonnet", false)).toEqual({
      "anthropic:sonnet": false,
    });
  });
});
