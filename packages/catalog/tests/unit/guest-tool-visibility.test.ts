import { describe, test, expect, beforeAll } from "bun:test";
import { ToolCatalog } from "../../src/tool-catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function makeTool(name: string, desc: string) {
  return new DynamicStructuredTool({
    name,
    description: desc,
    schema: z.object({}),
     
    func: async () => "ok",
  });
}

/**
 * M133 — trust tier is metadata only; toolPolicy (envelope capabilities)
 * is the authorization axis. Without toolPolicy, all enabled tools are visible.
 */
describe("guest tool visibility", () => {
  let catalog: ToolCatalog;

  beforeAll(() => {
    catalog = new ToolCatalog();

    catalog.register({
      name: "verify_identity",
      factory: () => makeTool("verify_identity", "Verify identity via PIN"),
      category: "administration",
      trustTier: "guest",
      impact: "high",
    });

    catalog.register({
      name: "discover_tools",
      factory: () => makeTool("discover_tools", "Search tool catalog"),
      category: "meta",
      trustTier: "guest",
      impact: "read-only",
    });

    catalog.register({
      name: "run_shell",
      factory: () => makeTool("run_shell", "Execute shell command"),
      category: "development",
      trustTier: "admin",
      impact: "destructive",
      requiresApproval: true,
    });

    catalog.register({
      name: "search_memory",
      factory: () => makeTool("search_memory", "Search memories"),
      category: "knowledge",
      trustTier: "standard",
      impact: "read-only",
    });

    catalog.register({
      name: "update_config",
      factory: () => makeTool("update_config", "Update config"),
      category: "files",
      trustTier: "high",
      impact: "destructive",
    });

    catalog.register({
      name: "apply_patch",
      factory: () => makeTool("apply_patch", "Apply one trusted multi-file patch"),
      category: "files",
      trustTier: "admin",
      impact: "destructive",
      requiredCapabilities: ["use_high_impact_tools"],
      exposure: "core",
      resultScanPolicy: "always",
    });
  });

  test("without toolPolicy all tools are visible regardless of trustTier", () => {
    const snap = catalog.getFiltered();
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain("verify_identity");
    expect(names).toContain("discover_tools");
    expect(names).toContain("run_shell");
    expect(names).toContain("search_memory");
    expect(names).toContain("update_config");
    expect(names).toContain("apply_patch");
  });

  test("toolPolicy forbidden excludes admin-tier tool for any actor", () => {
    const snap = catalog.getFiltered({ run_shell: "forbidden", apply_patch: "forbidden" });
    const names = snap.entries.map((e) => e.name);
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("apply_patch");
    expect(names).toContain("discover_tools");
  });

  test("verify_identity trustTier metadata remains guest (not used for gating)", () => {
    expect(catalog.get("verify_identity")?.trustTier).toBe("guest");
    const adminTierTools = catalog.getFiltered().entries
      .filter((e) => e.trustTier === "admin")
      .map((e) => e.name);
    expect(adminTierTools).toContain("run_shell");
    expect(adminTierTools).not.toContain("verify_identity");
  });
});
