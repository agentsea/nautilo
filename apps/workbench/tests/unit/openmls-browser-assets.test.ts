import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { includeOpenMlsBrowserAssets } from "../../vite.config";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = undefined;
  }
});

describe("OpenMLS Browser assets", () => {
  test("emits the exact verified JavaScript and WASM bytes at their runtime URLs", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "nautilo-openmls-browser-assets-"));
    const entryPath = join(temporaryDirectory, "entry.js");
    const outputDirectory = join(temporaryDirectory, "dist");
    await writeFile(entryPath, "export const ready = true;\n", "utf8");

    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [includeOpenMlsBrowserAssets()],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        rollupOptions: { input: entryPath },
      },
    });

    for (const filename of ["openmls_wasm.js", "openmls_wasm_bg.wasm"]) {
      const [emitted, verified] = await Promise.all([
        readFile(join(outputDirectory, "vendor/openmls-wasm", filename)),
        readFile(
          new URL(
            `../../../../packages/lattice-crypto/vendor/openmls-wasm/${filename}`,
            import.meta.url,
          ),
        ),
      ]);
      expect(emitted).toEqual(verified);
    }
  });
});
