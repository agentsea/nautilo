import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const desktopRoot = join(import.meta.dir, "../..");
const requireDesktop = createRequire(join(desktopRoot, "package.json"));
const desktopPackage = JSON.parse(
  readFileSync(join(desktopRoot, "package.json"), "utf8"),
) as { devDependencies: { electron: string } };

test("native rebuild tooling recognizes the selected Electron runtime", async () => {
  const builder = requireDesktop.resolve("electron-builder");
  const appBuilder = createRequire(builder).resolve("app-builder-lib");
  const rebuildEntries = [
    requireDesktop.resolve("@electron/rebuild"),
    createRequire(appBuilder).resolve("@electron/rebuild"),
  ];

  for (const rebuild of rebuildEntries) {
    const abiPath = createRequire(rebuild).resolve("node-abi");
    const { getAbi } = await import(pathToFileURL(abiPath).href) as {
      getAbi: (version: string, runtime: string) => string;
    };
    expect(getAbi(desktopPackage.devDependencies.electron, "electron")).toMatch(/^[1-9]\d*$/);
  }
});
