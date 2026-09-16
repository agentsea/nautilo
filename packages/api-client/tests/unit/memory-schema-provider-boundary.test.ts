import { expect, test } from "bun:test";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "../..");

test("Memory DTO bounds do not pull MLS providers into Mobile Web", async () => {
  const result = await Bun.build({
    entrypoints: [
      join(packageRoot, "src/schemas/protected-memory.ts"),
      join(packageRoot, "src/schemas/human-memory-read-observation.ts"),
    ],
    target: "browser",
    plugins: [{
      name: "reject-provider-in-data-only-dto",
      setup(build) {
        // Inspect the traversed graph, not tree-shaken output: Metro resolves
        // unused barrel exports too, including the unsupported WASM import.
        build.onLoad({ filter: /lattice-crypto\/src\/group\// }, ({ path }) => {
          throw new Error(`Data-only Memory DTO loaded a crypto provider: ${path}`);
        });
      },
    }],
  });
  expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
  expect(result.success).toBe(true);
});
