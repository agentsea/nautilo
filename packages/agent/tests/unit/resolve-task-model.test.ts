import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resolveTaskModel,
  validateTaskModelSelection,
  ModelSelectionError,
} from "../../src/config/resolve-task-model";
import { INTELLIGENCE_RANK } from "../../src/config/model-selection";
import { resolveCatalogModel } from "../../src/config/resolved-catalog";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
  "VENICE_API_KEY",
  "NAUTILO_ALLOW_CHINA_UPSTREAM",
];
const saved: Record<string, string | undefined> = {};

function clearAllKeys() {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  clearAllKeys();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const BASE = "anthropic:claude-sonnet-4-6";

describe("resolveTaskModel (M152)", () => {
  test("balanced / no selection returns baseModelId without scanning", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    expect(resolveTaskModel({ baseModelId: BASE, profile: "balanced" }).modelId).toBe(BASE);
    expect(resolveTaskModel({ baseModelId: BASE }).modelId).toBe(BASE);
    expect(resolveTaskModel({ baseModelId: BASE, profile: null }).modelId).toBe(BASE);
  });

  test("balanced retains configured Sol even when a security-preferred GLM route is eligible", () => {
    process.env["OPENAI_API_KEY"] = "x";
    process.env["OPENROUTER_API_KEY"] = "x";
    expect(resolveTaskModel({ baseModelId: "openai:gpt-5.6-sol", profile: "balanced" }))
      .toEqual({ modelId: "openai:gpt-5.6-sol" });
  });

  test("balanced preserves explicit and operator routing consent without granting it", () => {
    process.env["VENICE_API_KEY"] = "x";
    const baseModelId = "venice:z-ai-glm-5-3";
    expect(() => resolveTaskModel({ baseModelId })).toThrow(/not runnable/);
    expect(resolveTaskModel({ baseModelId, allowChinaUpstream: true })).toEqual({ modelId: baseModelId });
    process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
    expect(resolveTaskModel({ baseModelId })).toEqual({ modelId: baseModelId });
    expect(() => resolveTaskModel({ baseModelId, allowChinaUpstream: false })).toThrow(/not runnable/);
  });

  test("security research prefers the highest-priority eligible catalog-tagged model", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["OPENROUTER_API_KEY"] = "x";

    expect(resolveTaskModel({
      baseModelId: BASE,
      profile: "balanced",
      taskPreference: "security_research",
    })).toEqual({
      modelId: "openrouter:z-ai/glm-5.3",
      taskPreferenceApplied: "security_research",
    });
  });

  test("an explicit non-balanced selection overrides the security preference", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["OPENROUTER_API_KEY"] = "x";

    const result = resolveTaskModel({
      baseModelId: BASE,
      profile: "smartest",
      taskPreference: "security_research",
    });
    expect(resolveCatalogModel(result.modelId).intelligenceTier).toBe("frontier");
    expect(result.taskPreferenceApplied).toBeUndefined();
  });

  test("security preference falls back to balanced when no preferred row is eligible", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";

    expect(resolveTaskModel({
      baseModelId: BASE,
      taskPreference: "security_research",
    })).toEqual({ modelId: BASE });
  });

  test("security preference can use a permitted Venice GLM catalog row", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["VENICE_API_KEY"] = "x";

    expect(resolveTaskModel({
      baseModelId: BASE,
      taskPreference: "security_research",
      allowChinaUpstream: true,
    })).toEqual({
      modelId: "venice:z-ai-glm-5-3",
      taskPreferenceApplied: "security_research",
    });
  });

  test("balanced no longer bypasses credentials or signed-catalog membership", () => {
    expect(() => resolveTaskModel({ baseModelId: BASE, profile: "balanced" })).toThrow(
      "Anthropic credential is not configured",
    );
    expect(() =>
      resolveTaskModel({ baseModelId: "openrouter:legacy/custom", profile: "balanced" }),
    ).toThrow("not present in the current signed catalog");
  });

  test("cheapest returns the lowest-cost configured model", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["OPENAI_API_KEY"] = "x";
    process.env["FIREWORKS_API_KEY"] = "x";
    process.env["OPENROUTER_API_KEY"] = "x";
    const { modelId } = resolveTaskModel({ baseModelId: BASE, profile: "cheapest" });
    // Fireworks DeepSeek V4 Flash 0731 is the cheapest configured model with
    // these keys in the audited release.
    expect(modelId).toBe("fireworks:accounts/fireworks/models/deepseek-v4-flash-0731");
  });

  test("most_private picks highest privacy grade among configured", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["FIREWORKS_API_KEY"] = "x";
    const { modelId } = resolveTaskModel({ baseModelId: BASE, profile: "most_private" });
    // fireworks open-weights = grade 4 (highest available without venice); anthropic = 1.
    expect(modelId.startsWith("fireworks:")).toBe(true);
  });

  test("smartest picks a frontier-tier configured model", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["FIREWORKS_API_KEY"] = "x";
    const { modelId } = resolveTaskModel({ baseModelId: BASE, profile: "smartest" });
    expect(resolveCatalogModel(modelId).intelligenceTier).toBe("frontier");
  });

  test("selection applies reviewed intelligence from newly released catalog rows", () => {
    process.env["OPENROUTER_API_KEY"] = "x";

    const { modelId } = resolveTaskModel({
      baseModelId: BASE,
      spec: {
        objective: "cheap",
        absoluteFloors: { intelligenceRank: INTELLIGENCE_RANK.strong },
      },
    });

    // This current release's cheapest strong OpenRouter task model is not in
    // MODEL_INTELLIGENCE_TIER. Its reviewed tier must still qualify.
    expect(modelId).toBe("openrouter:deepseek/deepseek-v4-flash");
    expect(resolveCatalogModel(modelId).intelligenceTier).toBe("strong");
  });

  test("private_cheap throws when no private model has credentials (only hyperscaler keys)", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["OPENAI_API_KEY"] = "x";
    expect(() => resolveTaskModel({ baseModelId: BASE, profile: "private_cheap" })).toThrow(
      ModelSelectionError,
    );
    const failure = validateTaskModelSelection({ baseModelId: BASE, profile: "private_cheap" });
    expect(failure).not.toBeNull();
    expect(failure!.reason).toBe("privacy_band_empty");
    expect(failure!.message).toContain("privacy grade");
  });

  test("private_cheap resolves to a grade>=4 model when fireworks key is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["FIREWORKS_API_KEY"] = "x";
    const { modelId } = resolveTaskModel({ baseModelId: BASE, profile: "private_cheap" });
    expect(modelId.startsWith("fireworks:")).toBe(true);
  });

  test("smart_cheap (relative bands) still resolves with only hyperscaler keys (never empty)", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    process.env["OPENAI_API_KEY"] = "x";
    const { modelId } = resolveTaskModel({ baseModelId: BASE, profile: "smart_cheap" });
    expect(modelId).toBeTruthy();
  });

  test("validateTaskModelSelection returns null for a satisfiable selection", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    expect(validateTaskModelSelection({ baseModelId: BASE, profile: "smartest" })).toBeNull();
  });

  test("Tier-2 spec overrides profile; unsatisfiable absolute floor errors", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    expect(() =>
      resolveTaskModel({ baseModelId: BASE, spec: { objective: "cheap", absoluteFloors: { privacy: 9 } } }),
    ).toThrow(ModelSelectionError);
  });
});
