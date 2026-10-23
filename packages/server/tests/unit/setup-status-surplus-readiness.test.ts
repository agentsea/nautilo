import { describe, expect, mock, test } from "bun:test";
import type { QualifiedSurplusChatRoute } from "@nautilo/agent";
import { computeSetupHasLlm, hydrateSetupSurplusReadiness } from "../../src/routes/setup-status";

const QUALIFIED_TOOL_ROUTE: QualifiedSurplusChatRoute = {
  catalogModelId: "venice:openai-gpt-55",
  surplusModelId: "gpt-5.5",
  providerPin: "venice",
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  maxContextTokens: 100_000,
  maxOutputTokens: 8_000,
};

const NON_REASONING_TOOL_ROUTE: QualifiedSurplusChatRoute = {
  ...QUALIFIED_TOOL_ROUTE,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  maxContextTokens: 1_000_000,
  maxOutputTokens: 65_536,
};

const FULL_BUDGET_REASONING_ROUTE: QualifiedSurplusChatRoute = {
  ...QUALIFIED_TOOL_ROUTE,
  supportsReasoning: true,
  maxContextTokens: 1_000_000,
  maxOutputTokens: 131_072,
};

const QUALIFIED_SONNET_ROUTE: QualifiedSurplusChatRoute = {
  catalogModelId: "openrouter:anthropic/claude-sonnet-4.6",
  surplusModelId: "anthropic/claude-sonnet-4.6",
  providerPin: "openrouter",
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: true,
  maxContextTokens: 1_000_000,
  maxOutputTokens: 64_000,
};

const CLAIMED_AUTHENTICATED = {
  directProviderReady: false,
  authenticated: true,
  claimed: true,
} as const;

describe("Surplus setup readiness", () => {
  test("fails closed when vendor discovery confirms no exact route", () => {
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [],
    })).toBe(false);
  });

  test("hydrates only for an authenticated claimed server with active policy and credentials", async () => {
    const hydrate = mock(async () => {});
    await hydrateSetupSurplusReadiness(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      hydrateSurplusChatCatalog: hydrate,
    });
    expect(hydrate).toHaveBeenCalledTimes(1);
    await hydrateSetupSurplusReadiness({ ...CLAIMED_AUTHENTICATED, directProviderReady: true }, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      hydrateSurplusChatCatalog: hydrate,
    });
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  test("requires enabled policy and a configured server credential", () => {
    const routes = () => [NON_REASONING_TOOL_ROUTE];
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => false,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: routes,
    })).toBe(false);
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => false,
      getQualifiedSurplusChatRoutes: routes,
    })).toBe(false);
  });

  test("accepts a qualified lower output budget when it leaves input context", () => {
    const deps = {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [QUALIFIED_TOOL_ROUTE],
    };
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, deps)).toBe(true);
  });

  test("accepts a signed non-reasoning route with tools and the full default budget", () => {
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [NON_REASONING_TOOL_ROUTE],
    })).toBe(true);
  });

  test("looks past an unusable first route to a later usable route", () => {
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [{
        ...QUALIFIED_TOOL_ROUTE,
        supportsTools: false,
      }, QUALIFIED_SONNET_ROUTE],
    })).toBe(true);
  });

  test("accepts a reasoning-capable route without a separate output opt-out", () => {
    const deps = {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [FULL_BUDGET_REASONING_ROUTE],
    };
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, deps)).toBe(true);
  });

  test("accepts the exact Sonnet route at its qualified Surplus output budget", () => {
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [QUALIFIED_SONNET_ROUTE],
    })).toBe(true);
  });

  test("rejects a tool-unsupported route even when its budget fits", () => {
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [{
        ...NON_REASONING_TOOL_ROUTE,
        supportsTools: false,
      }],
    })).toBe(false);
  });

  test("accepts a positive route context when runtime clamps output to remaining context", () => {
    expect(computeSetupHasLlm(CLAIMED_AUTHENTICATED, {
      getPreferSurplus: () => true,
      getSurplusKeyConfigured: () => true,
      getQualifiedSurplusChatRoutes: () => [{
        ...NON_REASONING_TOOL_ROUTE,
        maxContextTokens: NON_REASONING_TOOL_ROUTE.maxOutputTokens,
      }],
    })).toBe(true);
  });

  test("does not inspect policy or provider keys for guests or unclaimed servers", () => {
    const getPreferSurplus = mock(() => true);
    const getSurplusKeyConfigured = mock(() => true);
    const deps = {
      getPreferSurplus,
      getSurplusKeyConfigured,
      getQualifiedSurplusChatRoutes: () => [QUALIFIED_TOOL_ROUTE],
    };

    expect(computeSetupHasLlm({
      directProviderReady: false,
      authenticated: false,
      claimed: true,
    }, deps)).toBe(false);
    expect(computeSetupHasLlm({
      directProviderReady: false,
      authenticated: true,
      claimed: false,
    }, deps)).toBe(false);
    expect(getPreferSurplus).not.toHaveBeenCalled();
    expect(getSurplusKeyConfigured).not.toHaveBeenCalled();
  });

  test("preserves direct-provider readiness without consulting Surplus", () => {
    const getSurplusKeyConfigured = mock(() => false);
    expect(computeSetupHasLlm({
      directProviderReady: true,
      authenticated: true,
      claimed: true,
    }, {
      getPreferSurplus: () => false,
      getSurplusKeyConfigured,
    })).toBe(true);
    expect(getSurplusKeyConfigured).not.toHaveBeenCalled();
  });
});
