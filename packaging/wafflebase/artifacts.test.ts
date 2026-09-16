import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildArtifacts, fingerprintSource } from "./artifacts.mjs";

async function filesBelow(root: string, path = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else files.push(child);
  }
  return files.sort();
}

describe("owned Sheets compiled artifact", () => {
  test("fingerprints the production package closure rather than Docker-filtered tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-sheets-fingerprint-"));
    try {
      for (const path of ["package.json", "bun.lock", "turbo.json"]) {
        await writeFile(join(root, path), `${path}: production input\n`);
      }
      for (const packageName of ["office-core", "office-sheets"]) {
        const packageRoot = join(root, "packages", packageName);
        await mkdir(join(packageRoot, "src"), { recursive: true });
        await mkdir(join(packageRoot, "test", "fixtures"), { recursive: true });
        await mkdir(join(packageRoot, "tests", "helpers"), { recursive: true });
        await mkdir(join(packageRoot, ".cache"), { recursive: true });
        await writeFile(join(packageRoot, "package.json"), `{"name":"${packageName}"}\n`);
        await writeFile(join(packageRoot, "LICENSE"), "production license\n");
        await writeFile(join(packageRoot, "tsconfig.json"), "production config\n");
        await writeFile(join(packageRoot, "src", "index.ts"), "export const value = 1;\n");
        await writeFile(join(packageRoot, "test", "fixtures", "sample.parquet"), "fixture one\n");
        await writeFile(join(packageRoot, "tests", "helpers", "builder.ts"), "helper one\n");
        await writeFile(join(packageRoot, ".cache", "state"), "cache one\n");
      }

      const baseline = await fingerprintSource(root);
      await writeFile(
        join(root, "packages/office-sheets/test/fixtures/sample.parquet"),
        "fixture two\n",
      );
      await writeFile(
        join(root, "packages/office-core/tests/helpers/builder.ts"),
        "helper two\n",
      );
      await writeFile(
        join(root, "packages/office-sheets/.cache/state"),
        "cache two\n",
      );
      expect(await fingerprintSource(root)).toBe(baseline);

      await writeFile(
        join(root, "packages/office-sheets/src/index.ts"),
        "export const value = 2;\n",
      );
      const sourceChanged = await fingerprintSource(root);
      expect(sourceChanged).not.toBe(baseline);

      await writeFile(
        join(root, "packages/office-sheets/tsconfig.json"),
        "changed production config\n",
      );
      expect(await fingerprintSource(root)).not.toBe(sourceChanged);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("generated caches and TypeScript build metadata do not change the source fingerprint", async () => {
    const root = join(import.meta.dir, "../..");
    const before = await fingerprintSource(root);
    const generated = [
      join(root, "packages/office-core/.turbo/fingerprint-regression.log"),
      join(root, "packages/office-sheets/.cache/fingerprint-regression"),
      join(root, "packages/office-sheets/fingerprint-regression.tsbuildinfo"),
    ];
    try {
      for (const path of generated) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "generated and unstable\n");
      }
      expect(await fingerprintSource(root)).toBe(before);
    } finally {
      await Promise.all(generated.map(path => rm(path, { force: true })));
    }
  });

  test("assembles browser and headless entry points without rewriting compiled output", async () => {
    const root = join(import.meta.dir, "../..");
    const destination = await mkdtemp(join(tmpdir(), "nautilo-sheets-artifact-"));
    await rm(destination, { recursive: true });
    try {
      await buildArtifacts(root, destination, { build: false });
      const files = await filesBelow(destination);
      for (const path of ["browser.js", "node.js", "src/index.d.ts", "src/node.d.ts"]) expect(files).toContain(path);
      expect(await readFile(join(destination, "browser.js"), "utf8")).toBe(await readFile(join(root, "packages/office-sheets/dist/browser.js"), "utf8"));
      expect(await readFile(join(destination, "node.js"), "utf8")).toBe(await readFile(join(root, "packages/office-sheets/dist/node.js"), "utf8"));
      expect(await readFile(join(destination, "index.js"), "utf8")).toBe('export * from "./browser.js";\n');
      const provenance = JSON.parse(await readFile(join(destination, "provenance.json"), "utf8")) as {
        revision: unknown; artifactTransforms: unknown; inputs: unknown;
        sourceSha256: unknown; files: Record<string, unknown>;
      };
      expect(provenance.revision).toBe("acde58012910ec68645c65b6896d5408fad1645c");
      expect(provenance.artifactTransforms).toEqual([]);
      expect(provenance.inputs).toEqual(["packages/office-core", "packages/office-sheets"]);
      expect(provenance.sourceSha256).toBe(await fingerprintSource(root));
      for (const path of ["browser.js", "node.js", "THIRD_PARTY_NOTICES.md"]) expect(provenance.files[path]).toMatch(/^[a-f0-9]{64}$/);
      const notices = await readFile(join(destination, "THIRD_PARTY_NOTICES.md"), "utf8");
      for (const dependency of ["@nautilo/office-core", "@nautilo/office-sheets", "antlr4ts", "hyparquet", "hyparquet-compressors", "jszip"]) {
        expect(notices).toContain(`## ${dependency}@`);
      }
    } finally { await rm(destination, { recursive: true, force: true }); }
  });

  test("preserves existing output when a compiled entry is missing", async () => {
    const source = join(import.meta.dir, "../..");
    const root = await mkdtemp(join(tmpdir(), "nautilo-sheets-owned-fixture-"));
    const destination = join(root, "artifact");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "existing\n");
    for (const path of ["package.json", "bun.lock", "turbo.json"]) await cp(join(source, path), join(root, path));
    await mkdir(join(root, "packages"), { recursive: true });
    await cp(join(source, "packages/office-core"), join(root, "packages/office-core"), { recursive: true });
    await cp(join(source, "packages/office-sheets"), join(root, "packages/office-sheets"), { recursive: true });
    await rm(join(root, "packages/office-sheets/dist/node.js"));
    let failure: unknown;
    try { await buildArtifacts(root, destination, { build: false }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Incomplete @nautilo/office-sheets build");
    expect(await filesBelow(destination)).toEqual(["keep.txt"]);
    await rm(root, { recursive: true, force: true });
  });

  test("builds the actual seven-tool server bundle through the headless engine", async () => {
    const root = join(import.meta.dir, "../..");
    const appRoot = join(root, "packages/first-party-apps/spreadsheet");
    // Production tool caches are app-root descendants; keep the same relative
    // import geometry so this proves the actual build contract.
    await mkdir(join(appRoot, ".cache"), { recursive: true });
    const cacheRoot = await mkdtemp(join(appRoot, ".cache/agent-tools-test-"));
    try {
      const script = `import { buildAgentToolBundle } from "./packages/server/src/apps/app-agent-tool-build.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const [root, cacheDir] = process.argv.slice(1);
const appRoot = join(root, "packages/first-party-apps/spreadsheet");
const manifest = JSON.parse(await readFile(join(appRoot, "app.json"), "utf8"));
console.log(JSON.stringify(await buildAgentToolBundle({
  appId: "nautilo-spreadsheet",
  appRoot,
  appsRoot: join(root, "packages/first-party-apps"),
  cacheDir,
  tools: manifest.agent.tools,
  redactPaths: [root, cacheDir],
})));`;
      const child = spawnSync("bun", ["-e", script, root, cacheRoot], { cwd: root, encoding: "utf8" });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout.trim()) as { status?: unknown; toolNames?: unknown };
      expect(result).toMatchObject({ status: "ok", toolCount: 7 });
      if (result.status === "ok") {
        expect(result.toolNames).toEqual([
          "app_nautilo_spreadsheet__create_file",
          "app_nautilo_spreadsheet__inspect_document",
          "app_nautilo_spreadsheet__edit_document",
          "app_nautilo_spreadsheet__inspect_open_sheet",
          "app_nautilo_spreadsheet__edit_open_sheet",
          "app_nautilo_spreadsheet__import_xlsx",
          "app_nautilo_spreadsheet__export_xlsx",
        ]);
      }
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
