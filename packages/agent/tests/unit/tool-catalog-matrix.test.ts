import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { TOOL_CATEGORIES } from "@nautilo/types";
import { buildToolCatalogMatrix } from "../../src/tools/catalog-matrix";
import { registerAllTools } from "../../src/tools/register-all";

describe("D570 generated tool catalogue matrix", () => {
  test("covers every built-in registration with canonical intent and separate authority axes", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    const entries = catalog.query({});
    const matrix = buildToolCatalogMatrix(entries);

    expect(matrix).toHaveLength(entries.length);
    expect(new Set(matrix.map((row) => row.name)).size).toBe(entries.length);
    for (const row of matrix) {
      expect(TOOL_CATEGORIES).toContain(row.category);
      expect(row.discoveryCategories).not.toContain(row.category);
      expect(new Set(row.discoveryCategories).size).toBe(row.discoveryCategories.length);
      expect(row.activeRetiredGates).toEqual([]);
      expect(row.requiredCapabilities).toBeArray();
      expect(row.conditionalCapabilities).toBeArray();
      expect(row.relayCapabilities).toBeArray();
      expect(["cloud", "relay", "local"]).toContain(row.executor);
      expect(["core", "discoverable"]).toContain(row.exposure);
    }
  });

  test("aligns peer contact and Artifact sharing without changing their gates", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    const matrix = buildToolCatalogMatrix(catalog.query({}));

    expect(matrix.find((row) => row.name === "ask_peer")).toMatchObject({
      category: "communication",
      discoveryCategories: ["automation", "documents"],
      family: "orchestration",
      requiredCapabilities: ["invoke_agents"],
      conditionalCapabilities: ["use_share_artifact"],
      approval: "hybrid",
    });
    expect(matrix.find((row) => row.name === "share_artifact")).toMatchObject({
      category: "documents",
      discoveryCategories: ["communication", "files"],
      family: "filesystem",
      requiredCapabilities: ["use_share_artifact"],
    });
    expect(matrix.find((row) => row.name === "list_my_users")).toMatchObject({
      category: "communication",
      requiredCapabilities: [],
    });
  });
});
