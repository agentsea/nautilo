import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import * as resolvedCatalog from "../../src/config/resolved-catalog";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resolveToolsForExposure } from "../../src/nodes/pre-model";
import { createBrowserSnapshotTool, resolveBrowserDecisionModel } from "../../src/tools/browser/browser-snapshot";
import { registerAllTools } from "../../src/tools/register-all";
import { buildSystemPrompt } from "../../src/prompts/templates";

const context = { turnId: "browser-exposure-test", fullEncryptionOnly: false };

describe("live browser decision exposure", () => {
  let priorKey: string | undefined;

  beforeEach(() => {
    priorKey = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "synthetic-exposure-test";
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    if (priorKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorKey;
  });

  function expectHidden(tool = createBrowserSnapshotTool(context)) {
    expect(z.toJSONSchema(tool.schema).properties).not.toHaveProperty("decisionPlan");
    expect(tool.description).not.toMatch(/decisionPlan|Jev|delegat/i);
    expect(buildSystemPrompt({ assistantName: "Test", tools: [tool], isGuest: false })).not.toContain("routine browser decision model is available");
    expect(tool.schema.safeParse({}).success).toBe(true);
  }

  test("no context and protected turns never advertise delegation", () => {
    expectHidden(createBrowserSnapshotTool());
    expectHidden(createBrowserSnapshotTool({ ...context, fullEncryptionOnly: true }));
    expectHidden(createBrowserSnapshotTool({ turnId: context.turnId }));
  });

  test("missing or revoked credentials remove the argument and guidance on the next binding", () => {
    expect(z.toJSONSchema(createBrowserSnapshotTool(context).schema).properties).toHaveProperty("decisionPlan");
    delete process.env["OPENROUTER_API_KEY"];
    expectHidden();
    process.env["OPENROUTER_API_KEY"] = "   ";
    expectHidden();
  });

  test.each(["", "openrouter:missing-decision-model", "openai:gpt-5.6-sol"])(
    "an absent, unknown, or non-decision exact binding cannot expose a decision route: %s",
    (modelId) => {
      expect(resolveBrowserDecisionModel(context, modelId)).toBeNull();
    },
  );

  test("selects the first eligible implemented decision row in signed catalog order", () => {
    const eligible = resolvedCatalog.listResolvedCatalogModels().filter((row) => row.workload === "decision"
      && row.decision?.operations.includes("choice"));
    expect(eligible.length).toBeGreaterThan(0);
    expect(resolveBrowserDecisionModel(context)?.id).toBe(eligible[0]?.id);
    expect(resolveBrowserDecisionModel(context, eligible[0]?.id)?.id).toBe(eligible[0]?.id);
  });

  test("uses catalog order while skipping non-decision and unimplemented decision routes", () => {
    const actual = resolvedCatalog.listResolvedCatalogModels().find((row) => row.workload === "decision");
    if (!actual) throw new Error("expected a catalogued decision row");
    const selected = { ...actual, id: "openrouter:synthetic/non-jev-choice", displayName: "Synthetic Choice" };
    const unsupportedProvider = { ...actual, id: "synthetic:unimplemented-choice", provider: "synthetic" };
    const chat = { ...actual, id: "openrouter:synthetic/chat", workload: "chat" as const, decision: null };
    const list = spyOn(resolvedCatalog, "listResolvedCatalogModels")
      .mockReturnValue([chat, unsupportedProvider, selected, actual]);
    try {
      expect(resolveBrowserDecisionModel(context)?.id).toBe(selected.id);
      expect(resolveBrowserDecisionModel(context, unsupportedProvider.id)).toBeNull();
      expect(resolveBrowserDecisionModel(context, selected.id)?.id).toBe(selected.id);
    } finally {
      list.mockRestore();
    }
  });

  test("the actual catalog binding favors Jev only while eligible and preserves ordinary controls", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    for (const mode of ["progressive", "eager"] as const) {
      const bind = () => resolveToolsForExposure(catalog, mode, {
        context: { turnId: context.turnId },
        fullEncryptionOnly: false,
        relayCapabilities: { control_browser: true },
        toolNameWhitelist: ["browser_snapshot", "browser_click", "browser_type", "browser_press"],
      }).tools;
      process.env["OPENROUTER_API_KEY"] = "synthetic-exposure-test";
      const enabled = bind();
      const snapshot = enabled.find((tool) => tool.name === "browser_snapshot")!;
      expect(snapshot.description).toMatch(/Jev.*available now/);
      expect(snapshot.description).toContain("delegate one complete routine outcome");
      expect(buildSystemPrompt({ assistantName: "Test", tools: [snapshot], isGuest: false })).toContain("runtime observes and verifies each action without waking you");
      expect(snapshot.schema).toBeDefined();
      expect(JSON.stringify(z.toJSONSchema(snapshot.schema as z.ZodObject))).toContain('"decisionPlan"');
      expect(enabled.map((tool) => tool.name).sort()).toEqual([
        "browser_click", "browser_press", "browser_snapshot", "browser_type",
      ]);
      delete process.env["OPENROUTER_API_KEY"];
      const disabled = bind();
      const ordinary = disabled.find((tool) => tool.name === "browser_snapshot")!;
      expect(ordinary.description).not.toMatch(/decisionPlan|Jev|delegat/i);
      expect(JSON.stringify(z.toJSONSchema(ordinary.schema as z.ZodObject))).not.toContain('"decisionPlan"');
      expect(disabled.map((tool) => tool.name).sort()).toEqual([
        "browser_click", "browser_press", "browser_snapshot", "browser_type",
      ]);
      const byName = new Map(disabled.map((tool) => [tool.name, tool]));
      const schema = (name: string): z.ZodType => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`missing ordinary browser tool ${name}`);
        return tool.schema as z.ZodType;
      };
      expect(schema("browser_snapshot").safeParse({}).success).toBe(true);
      expect(schema("browser_click").safeParse({ ref: "@e1" }).success).toBe(true);
      expect(schema("browser_type").safeParse({ ref: "@e2", text: "exact text", clear: true }).success).toBe(true);
      expect(schema("browser_press").safeParse({ key: "Control+a" }).success).toBe(true);
      expect(schema("browser_press").safeParse({ key: "Enter", ref: "@e2" }).success).toBe(true);
      const ordinaryPrompt = buildSystemPrompt({ assistantName: "Test", tools: [...disabled], isGuest: false });
      expect(ordinaryPrompt).toContain("browser_snapshot / browser_click / browser_type / browser_press");
      expect(ordinaryPrompt).not.toContain("routine browser decision model is available");
      expect(ordinaryPrompt).not.toContain("decisionPlan");
    }
  });
});
