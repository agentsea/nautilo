import { describe, expect, test } from "bun:test";
import {
  resolveModelControlSelection,
  type ModelControlCatalogEntry,
  type ResolveModelControlSelectionInput,
} from "../../src/config/model-control-selection";

const KIMI = "fireworks:accounts/fireworks/models/kimi-k3";
const LEGACY = "openai:gpt-legacy";

const catalog = new Map<string, ModelControlCatalogEntry>([
  [
    KIMI,
    {
      id: KIMI,
      controls: {
        reasoning: {
          levels: ["low", "medium", "high"],
          defaultLevel: "medium",
          canDisable: true,
          mandatory: false,
        },
        serving: {
          defaultProfile: "standard",
          profiles: [{ id: "standard" }, { id: "priority" }, { id: "fast" }],
        },
      },
    },
  ],
  [LEGACY, { id: LEGACY }],
]);

function resolve(overrides: Partial<ResolveModelControlSelectionInput> = {}) {
  return resolveModelControlSelection({ catalogByModelId: catalog, catalogDefaultModelId: KIMI, ...overrides });
}

describe("resolveModelControlSelection", () => {
  test("uses catalog defaults for a model-only legacy selection", () => {
    expect(resolve()).toEqual({
      status: "resolved",
      source: "catalog",
      requested: { modelId: KIMI },
      effective: { modelId: KIMI, reasoningEffort: "medium", servingProfileId: "standard" },
    });
  });

  test("locks scope precedence turn → room+agent → agent → server → catalog", () => {
    const result = resolve({
      serverDefault: { modelId: KIMI, reasoningEffort: "low" },
      agentDefault: { modelId: KIMI, reasoningEffort: "medium" },
      roomAgentOverride: { modelId: KIMI, reasoningEffort: "high" },
      turnOverride: { modelId: KIMI, reasoningEffort: "off" },
    });
    expect(result).toMatchObject({
      status: "resolved",
      source: "turn",
      effective: { modelId: KIMI, reasoningEffort: "off", servingProfileId: "standard" },
    });
  });

  test("isolates a reset room lane by accepting no Room+Agent override", () => {
    const result = resolve({ agentDefault: { modelId: KIMI, servingProfileId: "fast" } });
    expect(result).toMatchObject({
      status: "resolved",
      source: "agent",
      effective: { modelId: KIMI, reasoningEffort: "medium", servingProfileId: "fast" },
    });
  });

  test("returns stale instead of carrying incompatible controls across a model change", () => {
    expect(
      resolve({ roomAgentOverride: { modelId: LEGACY, servingProfileId: "fast" } }),
    ).toMatchObject({
      status: "stale",
      source: "room-agent",
      reason: "serving-not-supported",
      axis: "serving",
    });
  });

  test("resolves a fallback target from its own controls, not the prior Room choice", () => {
    const result = resolve({ catalogDefaultModelId: LEGACY });
    expect(result).toEqual({
      status: "resolved",
      source: "catalog",
      requested: { modelId: LEGACY },
      effective: { modelId: LEGACY },
    });
  });

  test("returns stale for removed models and unsupported catalog choices", () => {
    expect(resolve({ agentDefault: { modelId: "fireworks:removed" } })).toMatchObject({
      status: "stale",
      reason: "unknown-model",
    });
    expect(resolve({ agentDefault: { modelId: KIMI, reasoningEffort: "max" } })).toMatchObject({
      status: "stale",
      reason: "unsupported-reasoning-effort",
      axis: "reasoning",
    });
  });

  test("returns blocked when policy disables or narrows a valid catalog choice", () => {
    expect(
      resolve({
        agentDefault: { modelId: KIMI, reasoningEffort: "high" },
        policyByModelId: new Map([[KIMI, { reasoningEnabled: false }]]),
      }),
    ).toMatchObject({ status: "blocked", reason: "reasoning-disabled-by-policy", axis: "reasoning" });
    expect(
      resolve({
        agentDefault: { modelId: KIMI, servingProfileId: "fast" },
        policyByModelId: new Map([[KIMI, { allowedServingProfileIds: ["standard"] }]]),
      }),
    ).toMatchObject({ status: "blocked", reason: "serving-profile-not-allowed", axis: "serving" });
  });

  test("uses a policy default only when the selected scope omits that axis", () => {
    expect(
      resolve({
        agentDefault: { modelId: KIMI },
        policyByModelId: new Map([[KIMI, { defaultReasoningEffort: "high", defaultServingProfileId: "priority" }]]),
      }),
    ).toMatchObject({
      status: "resolved",
      effective: { modelId: KIMI, reasoningEffort: "high", servingProfileId: "priority" },
    });
  });
});
