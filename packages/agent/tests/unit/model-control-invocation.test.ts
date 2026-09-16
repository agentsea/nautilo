import { describe, expect, test } from "bun:test";
import { buildForegroundModelControlPlan } from "../../src/config/foreground-model-controls";
import type { ModelControlCatalogEntry } from "../../src/config/model-control-selection";

const KIMI = "fireworks:accounts/fireworks/models/kimi-k3";
const AGENT_MODEL = "anthropic:claude-sonnet-4-6";
const CATALOG_MODEL = "openai:gpt-5.5-2026-04-23";
const LEGACY = "google:gemini-2.5-pro";

const catalog = new Map<string, ModelControlCatalogEntry>([
  [KIMI, { id: KIMI, controls: { serving: { defaultProfile: "standard", profiles: [{ id: "standard" }, { id: "fast" }] } } }],
  [AGENT_MODEL, { id: AGENT_MODEL, controls: { reasoning: { levels: ["low", "high"], defaultLevel: "low", canDisable: true, mandatory: false } } }],
  [CATALOG_MODEL, { id: CATALOG_MODEL, controls: { reasoning: { levels: ["minimal", "medium"], defaultLevel: "minimal", canDisable: true, mandatory: false } } }],
  [LEGACY, { id: LEGACY }],
]);

describe("D462 foreground model-control precedence", () => {
  test("Room Kimi changes the initial model and its matching controls win", () => {
    const plan = buildForegroundModelControlPlan({ modelId: KIMI, servingProfileId: "fast" }, { modelId: KIMI, servingProfileId: "standard" }, AGENT_MODEL, catalog);
    expect(plan.initialModelId).toBe(KIMI);
    expect(plan.resolveForegroundControls?.(KIMI)).toEqual({ canonicalModelId: KIMI, servingProfileId: "fast" });
  });

  test("a fallback uses its own matching Agent bundle when Room selected another model", () => {
    const plan = buildForegroundModelControlPlan({ modelId: KIMI, servingProfileId: "fast" }, { modelId: AGENT_MODEL, reasoningEffort: "high" }, KIMI, catalog);
    expect(plan.resolveForegroundControls?.(AGENT_MODEL)).toEqual({ canonicalModelId: AGENT_MODEL, reasoningEffort: "high" });
  });

  test("server reasoning policy supplies effort when Agent has no explicit effort", () => {
    const plan = buildForegroundModelControlPlan(
      null,
      { modelId: AGENT_MODEL },
      AGENT_MODEL,
      catalog,
      { defaultEffort: "high", overrides: {} },
    );
    expect(plan.resolveForegroundControls?.(AGENT_MODEL)).toEqual({
      canonicalModelId: AGENT_MODEL,
      reasoningEffort: "high",
    });
  });

  test("global server effort yields to a model's catalog default when unsupported", () => {
    const plan = buildForegroundModelControlPlan(
      null,
      { modelId: CATALOG_MODEL },
      CATALOG_MODEL,
      catalog,
      { defaultEffort: "high", overrides: {} },
    );
    expect(plan.resolveForegroundControls?.(CATALOG_MODEL)).toEqual({
      canonicalModelId: CATALOG_MODEL,
      reasoningEffort: "minimal",
    });
  });

  test("an unrelated fallback uses only its catalog defaults", () => {
    const plan = buildForegroundModelControlPlan({ modelId: KIMI, servingProfileId: "fast" }, { modelId: AGENT_MODEL, reasoningEffort: "high" }, KIMI, catalog);
    expect(plan.resolveForegroundControls?.(CATALOG_MODEL)).toEqual({ canonicalModelId: CATALOG_MODEL, reasoningEffort: "minimal" });
  });

  test("no bundles retain model-only behavior for a catalog row without controls", () => {
    const plan = buildForegroundModelControlPlan(null, null, LEGACY, catalog);
    expect(plan.initialModelId).toBe(LEGACY);
    expect(plan.resolveForegroundControls?.(LEGACY)).toBeUndefined();
  });

  test("a stale matching bundle fails closed", () => {
    const plan = buildForegroundModelControlPlan({ modelId: "fireworks:accounts/fireworks/models/removed", servingProfileId: "fast" }, null, LEGACY, catalog);
    expect(() => plan.resolveForegroundControls?.("fireworks:accounts/fireworks/models/removed")).toThrow(/D462 model controls stale/);
  });
});


describe("M325 unavailable lower-priority defaults", () => {
  const unavailableDefault = () => { throw new Error("Default credential is missing"); };

  test("Room selection never resolves an unavailable fallback", () => {
    const plan = buildForegroundModelControlPlan(
      { modelId: KIMI }, null, unavailableDefault, catalog,
    );
    expect(plan.initialModelId).toBe(KIMI);
  });

  test("Agent selection never resolves an unavailable fallback", () => {
    const plan = buildForegroundModelControlPlan(
      null, { modelId: AGENT_MODEL }, unavailableDefault, catalog,
    );
    expect(plan.initialModelId).toBe(AGENT_MODEL);
  });

  test("an effective unavailable default still fails instead of silently substituting", () => {
    expect(() => buildForegroundModelControlPlan(
      null, null, unavailableDefault, catalog,
    )).toThrow("Default credential is missing");
  });
});


describe("M325 explicit turn precedence", () => {
  test("a turn model overrides both Room and Agent without resolving the server default", () => {
    const plan = buildForegroundModelControlPlan(
      { modelId: KIMI }, { modelId: AGENT_MODEL },
      () => { throw new Error("Unavailable default"); }, catalog, null, CATALOG_MODEL,
    );
    expect(plan.initialModelId).toBe(CATALOG_MODEL);
    expect(plan.resolveForegroundControls?.(CATALOG_MODEL)?.canonicalModelId).toBe(CATALOG_MODEL);
  });

  test("an unavailable explicit turn ID is preserved for strict admission, never replaced by Room", () => {
    const missing = "openai:removed-explicit-choice";
    const plan = buildForegroundModelControlPlan(
      { modelId: KIMI }, { modelId: AGENT_MODEL }, LEGACY, catalog, null, missing,
    );
    expect(plan.initialModelId).toBe(missing);
  });
});


test("an explicit turn selection does not inherit a lower-priority same-model control bundle", () => {
  const plan = buildForegroundModelControlPlan(
    { modelId: AGENT_MODEL, reasoningEffort: "high" },
    { modelId: AGENT_MODEL, reasoningEffort: "high" },
    LEGACY, catalog, null, AGENT_MODEL,
  );
  expect(plan.resolveForegroundControls?.(AGENT_MODEL)?.reasoningEffort).toBe("low");
});
