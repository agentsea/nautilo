import { describe, test, expect, beforeAll } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "@nautilo/agent";

let catalog: ToolCatalog;

beforeAll(() => {
  catalog = new ToolCatalog();
  registerAllTools(catalog);
});

describe("registerAllTools M088A", () => {
  test("registers share_artifact", () => {
    expect(catalog.get("share_artifact")).toBeDefined();
    expect(catalog.get("share_artifact")!.name).toBe("share_artifact");
  });

  test("does not register legacy flat artifact tool names", () => {
    for (const name of [
      "save_artifact",
      "read_artifact",
      "list_artifacts",
      "edit_artifact",
      "search_artifacts",
      "delete_artifact",
    ]) {
      expect(catalog.get(name)).toBeUndefined();
    }
  });

  test("admin snapshot includes file and share_artifact", () => {
    const snap = catalog.getFiltered(undefined, {
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
    });
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain("file");
    expect(names).toContain("share_artifact");
  });
});
