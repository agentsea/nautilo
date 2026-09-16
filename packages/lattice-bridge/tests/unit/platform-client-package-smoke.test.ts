import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function bundleAndLoad(input: {
  readonly name: string;
  readonly source: string;
}): Promise<{
  readonly source: string;
  readonly loaded: Readonly<Record<string, unknown>>;
}> {
  const directory = await mkdtemp(
    join(import.meta.dir, `.package-smoke-${input.name}-`),
  );
  temporaryDirectories.push(directory);
  const entrypoint = join(directory, "entry.ts");
  const outputPath = join(directory, "bundle.mjs");
  await writeFile(entrypoint, input.source, "utf8");
  // Bun.build shares resolver state with the surrounding Bun test process.
  // When another unit imports a workspace browser subpath concurrently, a
  // second platform bundle can misclassify that source file as a directory.
  // A child process is also the closer model of a real package build.
  const build = Bun.spawn({
    cmd: [
      process.execPath,
      "build",
      entrypoint,
      `--outfile=${outputPath}`,
      "--target=bun",
      "--format=esm",
      "--sourcemap=none",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  const bundledSource = await readFile(outputPath, "utf8");
  const loaded = await import(
    `${pathToFileURL(outputPath).href}?smoke=${crypto.randomUUID()}`
  ) as Readonly<Record<string, unknown>>;
  return { source: bundledSource, loaded };
}

function expectClientOnlyBundle(source: string): void {
  expect(source).not.toContain("@nautilo/db");
  expect(source).not.toContain("postgres");
  expect(source).not.toContain("crypto_delivery_operations");
  expect(source).not.toContain("human_crypto_custodies");
}

describe.serial("packaged platform client adapters", () => {
  test("loads the Workbench/browser protected Memory seam without server code", async () => {
    const result = await bundleAndLoad({
      name: "browser-memory-client",
      source: [
        "import {",
        "  createAuthorizedHumanMemoryClient,",
        "  createAuthorizedHumanArtifactClient,",
        "  createBrowserClientProfileVault,",
        "  createBrowserPreparedMutationJournalVault,",
        '} from "@nautilo/lattice-bridge/client/browser";',
        "export const adaptersLoaded =",
        '  typeof createAuthorizedHumanMemoryClient === "function"',
        '  && typeof createAuthorizedHumanArtifactClient === "function"',
        '  && typeof createBrowserClientProfileVault === "function"',
        '  && typeof createBrowserPreparedMutationJournalVault === "function";',
        "",
      ].join("\n"),
    });

    expect(result.loaded["adaptersLoaded"]).toBe(true);
    expectClientOnlyBundle(result.source);
  });

  test("loads the Electron subpath without pulling in server code", async () => {
    const result = await bundleAndLoad({
      name: "electron-vault",
      source: [
        "import {",
        "  createElectronClientProfileVault,",
        "  createElectronPreparedMutationJournalVault,",
        "  createAuthorizedHumanArtifactClient,",
        '} from "@nautilo/lattice-bridge/client/electron";',
        "export const adapterLoaded =",
        '  typeof createElectronClientProfileVault === "function"',
        '  && typeof createElectronPreparedMutationJournalVault === "function"',
        '  && typeof createAuthorizedHumanArtifactClient === "function";',
        "",
      ].join("\n"),
    });

    expect(result.loaded["adapterLoaded"]).toBe(true);
    expectClientOnlyBundle(result.source);
  });

});
