import { describe, expect, test } from "bun:test";
import { buildForegroundModelControlPlan } from "../../src/config/foreground-model-controls";
import { resolveModelRole } from "../../src/config/model-role-resolution";
import { resolveForegroundAgentModelId } from "../../src/nodes/agent";

const MODEL_ID = "venice:openai-gpt-55";
const ROUTE = {
  catalogModelId: MODEL_ID,
  surplusModelId: "gpt-5.5",
  providerPin: "venice" as const,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  maxContextTokens: 100_000,
  maxOutputTokens: 8_000,
  qualifiedAt: "2026-10-01",
};

const surplusOnly = {
  fundingKind: "server" as const,
  policyEnabled: true,
  keyConfigured: true,
  routes: [ROUTE],
  env: {},
};

describe("foreground agent model selection", () => {
  test("a selected Room model reaches the agent node selection without a direct credential", () => {
    const plan = buildForegroundModelControlPlan(
      { modelId: MODEL_ID },
      null,
      () => { throw new Error("Room selection must avoid the default resolver"); },
      new Map([[MODEL_ID, { id: MODEL_ID }]]),
    );
    expect(resolveForegroundAgentModelId(plan.initialModelId, surplusOnly)).toBe(MODEL_ID);
  });

  test("an unselected Room fallback can use the same foreground-only admission", () => {
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

  test("personal funding preserves its request-local signed-catalog projection", () => {
    expect(resolveForegroundAgentModelId(MODEL_ID, {
      fundingKind: "personal",
      policyEnabled: false,
      keyConfigured: false,
      routes: [],
    })).toBe(MODEL_ID);
  });
});
