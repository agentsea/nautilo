import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, type ToolRegistration } from "@nautilo/catalog";
import { z } from "zod";
import { resolveToolsForExposure } from "../../src/nodes/pre-model";

function register(
  catalog: ToolCatalog,
  name: string,
  overrides: Partial<ToolRegistration> = {},
): void {
  catalog.register({
    name,
    category: "meta",
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    factory: () =>
      new DynamicStructuredTool({
        name,
        description: name,
        schema: z.object({}),
        func: async () => "ok",
      }),
    ...overrides,
  });
}

function namesFor(mode: "progressive" | "eager"): string[] {
  const catalog = new ToolCatalog();
  register(catalog, "core", { exposure: "core" });
  register(catalog, "deferred");
  register(catalog, "forbidden");
  register(catalog, "relay_only", {
    executor: "relay",
    requiredCapabilities: ["desktop"],
  });
  register(catalog, "private_namespace", { namespaceId: "private" });
  register(catalog, "needs_image", { requiredModelCapabilities: ["image"] });
  register(catalog, "not_whitelisted");

  return resolveToolsForExposure(catalog, mode, {
    toolPolicy: { forbidden: "forbidden" },
    readableNamespaces: [],
    relayCapabilities: {},
    activeModelCapabilities: [],
    toolNameWhitelist: [
      "core",
      "deferred",
      "forbidden",
      "relay_only",
      "private_namespace",
      "needs_image",
    ],
  }).tools.map((tool) => tool.name);
}

describe("D419 tool exposure rollout", () => {
  test("defaults to progressive selection semantics", () => {
    expect(namesFor("progressive")).toEqual(["core"]);
  });

  test("eager rollback restores eligible deferred schemas without widening authorization", () => {
    expect(namesFor("eager")).toEqual(["core", "deferred"]);
  });
});
