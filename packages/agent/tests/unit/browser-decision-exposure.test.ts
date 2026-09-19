import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { invalidateRuntimeConfigCache, setConfigOverrides } from "@nautilo/config";
import { z } from "zod";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resolveToolsForExposure } from "../../src/nodes/pre-model";
import { createBrowserSnapshotTool } from "../../src/tools/browser/browser-snapshot";
import { registerAllTools } from "../../src/tools/register-all";
import { buildSystemPrompt } from "../../src/prompts/templates";

const JEV_ID = "openrouter:typesafe/jev-1.13";
const context = { turnId: "browser-exposure-test", fullEncryptionOnly: false };

describe("live browser decision exposure", () => {
  let priorKey: string | undefined;
  let priorModel: string | undefined;

  beforeEach(() => {
    priorKey = process.env["OPENROUTER_API_KEY"];
    priorModel = process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    process.env["OPENROUTER_API_KEY"] = "synthetic-exposure-test";
    delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    setConfigOverrides({ nautilo_browser_decision_model: JEV_ID });
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    setConfigOverrides({});
    if (priorKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorKey;
    if (priorModel === undefined) delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    else process.env["NAUTILO_BROWSER_DECISION_MODEL"] = priorModel;
    invalidateRuntimeConfigCache();
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
    "disabled, unknown, and chat configuration cannot expose a decision route: %s",
    (modelId) => {
      setConfigOverrides({ nautilo_browser_decision_model: modelId });
      expectHidden();
    },
  );

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
      expect(snapshot.description).toContain("Favor delegation");
      expect(buildSystemPrompt({ assistantName: "Test", tools: [snapshot], isGuest: false })).toContain("runtime owns the observe/act loop");
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
      const ordinaryPrompt = buildSystemPrompt({ assistantName: "Test", tools: [...disabled], isGuest: false });
      expect(ordinaryPrompt).toContain("browser_snapshot / browser_click / browser_type / browser_press");
      expect(ordinaryPrompt).not.toContain("routine browser decision model is available");
    }
  });
});
