/**
 * D429 Phase 3 — table-driven unit tests for the shared exact-task-model
 * selection validator (`validateExactTaskModelSelection`).
 *
 * Exercises the locked v1 contract:
 *   - valid curated id (selectable + confirmed tools) → no failure
 *   - dynamic openrouter:/gateway: ids are REJECTED as unknown_model (v1:
 *     exact calls only accept curated ids returned by listResolvedCatalogModels)
 *   - exact id + profile/spec together → conflict (mutually exclusive)
 *   - exact id + `balanced` (the default no-op) → NOT a conflict
 *   - missing credentials → missing_credentials
 *   - china-routed venice SKU without opt-in → routing_filtered
 *   - tool-USING task on a model with unknown (null) tools → capability_mismatch
 *   - tool-FREE task on the same null-tools model → allowed
 *
 * All cases inject `env` explicitly (no process.env mutation) and reset the
 * venice + capabilities caches so the rows are deterministic. The validator
 * is pure / cache-backed — it never awaits a fetch (Phase 0).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import {
  validateExactTaskModelSelection,
  assertExactTaskModelSelection,
  resolveExactTaskModelId,
} from "../../src/config/validate-exact-task-model";
import type { QualifiedSurplusChatRoute } from "../../src/providers/surplus-route";
import { validateTaskModelSelectionForCreate } from "../../src/tools/tasks/selection-validation";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";

const FULL_ENV: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "x",
  OPENAI_API_KEY: "x",
  GOOGLE_API_KEY: "x",
  FIREWORKS_API_KEY: "x",
  OPENROUTER_API_KEY: "x",
  VENICE_API_KEY: "x",
  XAI_API_KEY: "x",
  TOGETHER_API_KEY: "x",
};

const ANTHROPIC_ONLY: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "x" };
const NO_ENV: NodeJS.ProcessEnv = {};
const SURPLUS_ONLY_MODEL = "google:gemini-2.5-pro";
const QUALIFIED_SURPLUS_ROUTE: QualifiedSurplusChatRoute = {
  catalogModelId: SURPLUS_ONLY_MODEL,
  surplusModelId: "google/gemini-2.5-pro",
  providerPin: "google-ai-studio",
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  maxContextTokens: 1_000_000,
  maxOutputTokens: 65_536,
};

beforeEach(() => {
  resetVeniceCatalogCacheModuleForTests();
  resetModelCapabilitiesCacheForTests();
  process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
});

describe("validateExactTaskModelSelection (D429 Phase 3) — no exact id", () => {
  test("returns null when no requestedModelId is supplied (caller falls back to profile/spec)", () => {
    expect(validateExactTaskModelSelection({ env: FULL_ENV })).toBeNull();
    expect(
      validateExactTaskModelSelection({
        requestedModelId: null,
        env: FULL_ENV,
      }),
    ).toBeNull();
    expect(
      validateExactTaskModelSelection({
        requestedModelId: "   ",
        env: FULL_ENV,
      }),
    ).toBeNull();
  });

  test("does NOT run the profile/spec resolver when an id is absent (that is the caller's job)", () => {
    // An unsatisfiable profile with no id is not this validator's concern.
    expect(
      validateExactTaskModelSelection({
        profile: "private_cheap",
        env: ANTHROPIC_ONLY,
      }),
    ).toBeNull();
  });
});

describe("validateExactTaskModelSelection (D429 Phase 3) — conflict", () => {
  test("exact id + a non-default profile → conflict", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "anthropic:claude-sonnet-4-6",
      profile: "cheapest",
      env: FULL_ENV,
    });
    expect(f?.code).toBe("conflict");
    expect(f?.message).toContain("model_id");
    expect(f?.modelId).toBe("anthropic:claude-sonnet-4-6");
  });

  test("exact id + a spec → conflict", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "anthropic:claude-sonnet-4-6",
      spec: { objective: "cheap" },
      env: FULL_ENV,
    });
    expect(f?.code).toBe("conflict");
  });

  test("exact id + `balanced` (the default no-op) is NOT a conflict", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "anthropic:claude-sonnet-4-6",
      profile: "balanced",
      env: FULL_ENV,
    });
    // Falls through to availability/capability; the model is selectable + tools=true.
    expect(f).toBeNull();
  });
});

describe("validateExactTaskModelSelection (D429 Phase 3) — membership / availability", () => {
  test("valid curated id with credentials + confirmed tools → null (satisfiable)", () => {
    expect(
      validateExactTaskModelSelection({
        requestedModelId: "anthropic:claude-sonnet-4-6",
        env: ANTHROPIC_ONLY,
        toolsMode: "auto",
      }),
    ).toBeNull();
  });

  test("dynamic openrouter: id is rejected as unknown_model (v1: curated ids only)", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "openrouter:somevendor/unknown-model-v1",
      env: { OPENROUTER_API_KEY: "x" },
    });
    expect(f?.code).toBe("unknown_model");
    expect(f?.message).toContain("curated");
  });

  test("dynamic gateway: id is rejected as unknown_model", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "gateway:some-vendor/model-x",
      env: { NAUTILO_GATEWAY_API_KEY: "x", NAUTILO_GATEWAY_BASE_URL: "https://gw" },
    });
    expect(f?.code).toBe("unknown_model");
  });

  test("truly unknown id is rejected as unknown_model", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "newprovider:vortex-99",
      env: NO_ENV,
    });
    expect(f?.code).toBe("unknown_model");
  });

  test("missing credentials → missing_credentials with the provider reason", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "anthropic:claude-sonnet-4-6",
      env: NO_ENV,
    });
    expect(f?.code).toBe("missing_credentials");
    expect(f?.message).toContain("Anthropic credential is not configured");
  });

  test("china-routed venice SKU without allowChinaUpstream → routing_filtered", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: "venice:qwen-3-8-max",
      env: { VENICE_API_KEY: "vk" },
      allowChinaUpstream: false,
    });
    expect(f?.code).toBe("routing_filtered");
  });

  test("china-routed venice SKU WITH allowChinaUpstream + key → null (selectable)", () => {
    expect(
      validateExactTaskModelSelection({
        requestedModelId: "venice:qwen-3-8-max",
        env: { VENICE_API_KEY: "vk" },
        allowChinaUpstream: true,
        // venice qwen has confirmed tools in the cache; tool-using is fine.
        toolsMode: "auto",
      }),
    ).toBeNull();
  });
});

describe("validateExactTaskModelSelection (D429 Phase 3) — strict tool-capability truth", () => {
  // google:gemini-2.5-pro is curated, selectable with GOOGLE_API_KEY, and has
  // features.tools === null (unknown) in a cold cache.
  const NULL_TOOLS_ID = "google:gemini-2.5-pro";
  const env = { GOOGLE_API_KEY: "x" };

  test("tool-USING task (auto) on a null-tools model → capability_mismatch", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: NULL_TOOLS_ID,
      env,
      toolsMode: "auto",
    });
    expect(f?.code).toBe("capability_mismatch");
    expect(f?.message).toContain("tool");
  });

  test("tool-USING task (non-empty whitelist) on a null-tools model → capability_mismatch", () => {
    const f = validateExactTaskModelSelection({
      requestedModelId: NULL_TOOLS_ID,
      env,
      toolsMode: "whitelist",
      toolsWhitelist: ["search_memory"],
    });
    expect(f?.code).toBe("capability_mismatch");
  });

  test("tool-FREE task (tools_mode none) on a null-tools model → allowed (null ok)", () => {
    expect(
      validateExactTaskModelSelection({
        requestedModelId: NULL_TOOLS_ID,
        env,
        toolsMode: "none",
      }),
    ).toBeNull();
  });

  test("tool-FREE task (empty whitelist) on a null-tools model → allowed", () => {
    expect(
      validateExactTaskModelSelection({
        requestedModelId: NULL_TOOLS_ID,
        env,
        toolsMode: "whitelist",
        toolsWhitelist: [],
      }),
    ).toBeNull();
  });

  test("tool-USING task on a confirmed-tools model → null", () => {
    expect(
      validateExactTaskModelSelection({
        requestedModelId: "anthropic:claude-sonnet-4-6",
        env: { ANTHROPIC_API_KEY: "x" },
        toolsMode: "auto",
      }),
    ).toBeNull();
  });
});

describe("validateExactTaskModelSelection — qualified server-funded exact Tasks", () => {
  test("admits a signed tool-capable default route without an injected route allowlist", () => {
    expect(validateExactTaskModelSelection({
      requestedModelId: "anthropic:claude-sonnet-4-6",
      env: NO_ENV,
      toolsMode: "auto",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
      },
    })).toBeNull();
  });

  test("admits a qualified tool-free exact pin without the original provider credential", () => {
    expect(validateExactTaskModelSelection({
      requestedModelId: SURPLUS_ONLY_MODEL,
      env: NO_ENV,
      toolsMode: "none",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [QUALIFIED_SURPLUS_ROUTE],
      },
    })).toBeNull();
    expect(resolveExactTaskModelId({
      requestedModelId: `  ${SURPLUS_ONLY_MODEL}  `,
      env: NO_ENV,
      toolsMode: "none",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [QUALIFIED_SURPLUS_ROUTE],
      },
    })).toBe(SURPLUS_ONLY_MODEL);
    expect(validateTaskModelSelectionForCreate({
      requestedModelId: SURPLUS_ONLY_MODEL,
      env: NO_ENV,
      toolsMode: "none",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [QUALIFIED_SURPLUS_ROUTE],
      },
    })).toBeNull();
  });

  test.each([
    ["policy off", false, true, [QUALIFIED_SURPLUS_ROUTE]],
    ["Surplus key missing", true, false, [QUALIFIED_SURPLUS_ROUTE]],
    ["model unqualified", true, true, []],
  ] as const)("rejects a Surplus-only pin when %s", (_label, policyEnabled, keyConfigured, routes) => {
    expect(validateExactTaskModelSelection({
      requestedModelId: SURPLUS_ONLY_MODEL,
      env: NO_ENV,
      toolsMode: "none",
      surplus: { policyEnabled, keyConfigured, routes },
    })?.code).toBe("missing_credentials");
  });

  test("keeps a direct provider credential runnable when Surplus policy is off", () => {
    expect(validateExactTaskModelSelection({
      requestedModelId: SURPLUS_ONLY_MODEL,
      env: { GOOGLE_API_KEY: "x" },
      toolsMode: "none",
      surplus: {
        policyEnabled: false,
        keyConfigured: false,
        routes: [],
      },
    })).toBeNull();
  });

  test("rejects tool use outside the qualified route envelope", () => {
    expect(validateExactTaskModelSelection({
      requestedModelId: SURPLUS_ONLY_MODEL,
      env: NO_ENV,
      toolsMode: "auto",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [QUALIFIED_SURPLUS_ROUTE],
      },
    })?.code).toBe("capability_mismatch");
  });

  test("rejects a route narrower than the signed Task output budget", () => {
    expect(validateExactTaskModelSelection({
      requestedModelId: SURPLUS_ONLY_MODEL,
      env: NO_ENV,
      toolsMode: "none",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [{ ...QUALIFIED_SURPLUS_ROUTE, maxOutputTokens: 8_000 }],
      },
    })?.code).toBe("capability_mismatch");
  });

  test.each([
    ["reasoning-capable Anthropic", "anthropic:claude-sonnet-4-6"],
    ["OpenAI", "openai:gpt-5.5-2026-04-23"],
  ] as const)("admits the derived signed %s route without transport-shape vetoes", (_label, modelId) => {
    expect(validateExactTaskModelSelection({
      requestedModelId: modelId,
      env: NO_ENV,
      toolsMode: "none",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
      },
    })).toBeNull();
  });

  test("does not admit a default-off catalog row through an injected route", () => {
    const disabledModel = "fireworks:accounts/fireworks/models/deepseek-v4-pro";
    const failure = validateExactTaskModelSelection({
      requestedModelId: disabledModel,
      env: NO_ENV,
      toolsMode: "none",
      surplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [{
          ...QUALIFIED_SURPLUS_ROUTE,
          catalogModelId: disabledModel,
          surplusModelId: "accounts/fireworks/models/deepseek-v4-pro",
          providerPin: "fireworks",
        }],
      },
    });
    expect(failure).not.toBeNull();
    expect(["unknown_model", "disabled"]).toContain(failure?.code ?? "");
  });
});

describe("assertExactTaskModelSelection (D429 Phase 3) — dispatch seam", () => {
  test("throws a stable, prefixed error the observer records verbatim", () => {
    expect(() =>
      assertExactTaskModelSelection({
        requestedModelId: "newprovider:vortex-99",
        env: NO_ENV,
      }),
    ).toThrow(/\[task-model-selection\] exact model_id "newprovider:vortex-99" rejected/);
  });

  test("throws the conflict prefix when id + profile are combined", () => {
    expect(() =>
      assertExactTaskModelSelection({
        requestedModelId: "anthropic:claude-sonnet-4-6",
        profile: "cheapest",
        env: FULL_ENV,
      }),
    ).toThrow(/\[task-model-selection\] exact model_id .* rejected: .*combine/);
  });

  test("does not throw when the exact selection is satisfiable", () => {
    expect(() =>
      assertExactTaskModelSelection({
        requestedModelId: "anthropic:claude-sonnet-4-6",
        env: ANTHROPIC_ONLY,
      }),
    ).not.toThrow();
  });
});
