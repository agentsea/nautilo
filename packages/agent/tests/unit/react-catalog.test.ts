import { describe, expect, test, beforeAll } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";

let catalog: ToolCatalog;

beforeAll(() => {
  catalog = new ToolCatalog();
  registerAllTools(catalog);
});

describe("react tool catalog registration (M121)", () => {
  test("react policy: low impact, cloud executor, never scan", () => {
    const entry = catalog.get("react");
    expect(entry).toBeDefined();
    expect(entry!.impact).toBe("low");
    expect(entry!.executor).toBe("cloud");
    expect(entry!.resultScanPolicy).toBe("never");
  });
});
