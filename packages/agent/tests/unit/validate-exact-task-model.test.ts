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
} from "../../src/config/validate-exact-task-model";
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
