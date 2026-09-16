import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("package boundary", () => {
  test("default entry point bundles for browsers without Node built-ins", async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../src/index.ts")],
      target: "browser",
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(result.outputs).toHaveLength(1);
    expect(await result.outputs[0]!.text()).not.toMatch(/node:(?:fs|path|os|crypto)/);
  });
});
