import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildForegroundModelControlPlan } from "../../src/config/foreground-model-controls";
import { resolveModelRole } from "../../src/config/model-role-resolution";
import { resolveForegroundAgentModelId } from "../../src/nodes/agent";

import { installSurplusCatalogFixture } from "../helpers/surplus-catalog-fixture";
import { resetSurplusModelCatalog } from "../../src/providers/surplus-catalog";

beforeEach(installSurplusCatalogFixture);
afterEach(resetSurplusModelCatalog);

const MODEL_ID = "openrouter:openai/gpt-5.6-sol";
const ROUTE = {
  catalogModelId: MODEL_ID,
  surplusModelId: "gpt-5.6-sol",
  providerPin: "openrouter" as const,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: true,
  maxContextTokens: 1_050_000,
  maxOutputTokens: 128_000,
};

const surplusOnly = {
  fundingKind: "server" as const,
  policyEnabled: true,
  keyConfigured: true,
  env: {},
};

describe("foreground agent model selection", () => {
  test("automatic foreground chat can select a qualified server Surplus route", () => {
    const automaticRoute = {
      ...ROUTE,
      catalogModelId: "openrouter:minimax/minimax-m3",
      surplusModelId: "minimax/minimax-m3",
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
    };
    const automatic = { ...surplusOnly, routes: [automaticRoute] };
    expect(resolveForegroundAgentModelId(undefined, automatic)).toBe(automaticRoute.catalogModelId);
    expect(() => resolveForegroundAgentModelId(undefined, { ...automatic, policyEnabled: false })).toThrow();
    expect(() => resolveForegroundAgentModelId(undefined, { ...automatic, keyConfigured: false })).toThrow();
    expect(() => resolveForegroundAgentModelId(undefined, { ...automatic, routes: [] })).toThrow();
    expect(() => resolveForegroundAgentModelId(undefined, {
      ...automatic,
      routes: [{ ...automaticRoute, supportsTools: false }],
    })).toThrow();
  });

  test("a selected foreground model reaches the agent node without a direct credential", () => {
    const plan = buildForegroundModelControlPlan(
      { modelId: MODEL_ID },
      null,
      () => { throw new Error("Foreground selection must avoid the default resolver"); },
      new Map([[MODEL_ID, { id: MODEL_ID }]]),
    );
    expect(resolveForegroundAgentModelId(plan.initialModelId, surplusOnly)).toBe(MODEL_ID);
  });

  test("an unselected foreground fallback can use the same admission", () => {
    const plan = buildForegroundModelControlPlan(
      null,
      null,
      () => resolveForegroundAgentModelId(MODEL_ID, surplusOnly),
      new Map([[MODEL_ID, { id: MODEL_ID }]]),
    );
    expect(plan.initialModelId).toBe(MODEL_ID);
  });

  test("background role resolution remains direct-only", () => {
    expect(() => resolveModelRole("chat", { configuredId: MODEL_ID, env: {} }))
      .toThrow(/credential/i);
    expect(resolveForegroundAgentModelId(MODEL_ID, surplusOnly)).toBe(MODEL_ID);
  });

  test("an explicit server-funded role may resolve the same signed Surplus-only model", () => {
    expect(resolveModelRole("conductor", {
      configuredId: MODEL_ID,
      env: {},
      serverSurplus: { policyEnabled: true, keyConfigured: true, routes: [ROUTE] },
    })).toBe(MODEL_ID);
    expect(resolveModelRole("memoryReview", {
      configuredId: MODEL_ID,
      env: {},
      serverSurplus: { policyEnabled: true, keyConfigured: true, routes: [ROUTE] },
    })).toBe(MODEL_ID);
  });

  test("automatic server-funded role selection can choose a qualified Surplus-only candidate", () => {
    const automatic = {
      ...ROUTE,
      catalogModelId: "openrouter:minimax/minimax-m3",
      surplusModelId: "minimax/minimax-m3",
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
    };
    expect(resolveModelRole("conductor", {
      env: {},
      serverSurplus: { policyEnabled: true, keyConfigured: true, routes: [automatic] },
    })).toBe(automatic.catalogModelId);
  });

  test("server-funded role resolution preserves policy and tool capability gates", () => {
    expect(() => resolveModelRole("conductor", {
      configuredId: MODEL_ID,
      env: {},
      serverSurplus: { policyEnabled: false, keyConfigured: true, routes: [ROUTE] },
    })).toThrow(/credential/i);
    expect(() => resolveModelRole("memoryReview", {
      configuredId: MODEL_ID,
      env: {},
      serverSurplus: {
        policyEnabled: true,
        keyConfigured: true,
        routes: [{ ...ROUTE, supportsTools: false }],
      },
    })).toThrow(/credential/i);
  });

  test("policy-off, unqualified, and tool-unsupported routes remain unavailable", () => {
    expect(() => resolveForegroundAgentModelId(MODEL_ID, {
      ...surplusOnly,
      policyEnabled: false,
    })).toThrow(/credential/i);
    expect(() => resolveForegroundAgentModelId(MODEL_ID, {
      ...surplusOnly,
      routes: [],
    })).toThrow(/credential/i);
    expect(() => resolveForegroundAgentModelId(MODEL_ID, {
      ...surplusOnly,
      routes: [{ ...ROUTE, supportsTools: false }],
    })).toThrow(/credential/i);
  });

  test("disabled Surplus policy leaves the direct OpenRouter path available", () => {
    expect(resolveForegroundAgentModelId(MODEL_ID, {
      ...surplusOnly,
      policyEnabled: false,
      env: { OPENROUTER_API_KEY: "synthetic-direct-key" },
    })).toBe(MODEL_ID);
  });

  test("personal funding preserves its request-local signed-catalog projection", () => {
    expect(resolveForegroundAgentModelId(MODEL_ID, {
      fundingKind: "personal",
      policyEnabled: false,
      keyConfigured: false,
      routes: [],
    })).toBe(MODEL_ID);
  });
});
