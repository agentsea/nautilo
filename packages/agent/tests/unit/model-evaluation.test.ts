import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("unmetered exact-model evaluation seam", () => {
  test("uses the universal provider factory without the normal usage callback", async () => {
    const universal = await readFile(resolve(
      import.meta.dir,
      "../../src/providers/universal.ts",
    ), "utf8");
    const start = universal.indexOf("export async function createUnmeteredEvaluationModel");
    const end = universal.indexOf("async function createUniversalModelInternal", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const implementation = universal.slice(start, end);
    expect(implementation).toContain("createUniversalModelInternal(modelId, options)");
    expect(implementation).not.toContain("createUsageCallbackHandler");
    expect(implementation).not.toContain("usageCallback");
    expect(implementation).not.toContain("fallback");
  });

  test("is available only through the dedicated package subpath", async () => {
    const packageJson = JSON.parse(await readFile(resolve(
      import.meta.dir,
      "../../package.json",
    ), "utf8")) as { exports: Record<string, string> };
    const root = await readFile(resolve(import.meta.dir, "../../src/index.ts"), "utf8");
    expect(packageJson.exports["./model-evaluation"]).toBe(
      "./src/providers/model-evaluation.ts",
    );
    expect(root).not.toContain("createUnmeteredEvaluationModel");
    expect(root).not.toContain("createEvaluationModel");
  });
});
