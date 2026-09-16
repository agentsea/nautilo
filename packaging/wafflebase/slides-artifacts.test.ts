import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlidesArtifacts, fingerprintSlidesSource } from "./slides-artifacts.mjs";

async function filesBelow(root: string, path = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else files.push(child);
  }
  return files.sort();
}

describe("owned Slides compiled artifact", () => {
  test("assembles the complete standalone Core, Docs and Slides closure", async () => {
    const root = join(import.meta.dir, "../..");
    const destination = await mkdtemp(join(tmpdir(), "nautilo-slides-artifact-"));
    await rm(destination, { recursive: true });
    try {
      await buildSlidesArtifacts(root, destination, { build: false });
      const files = await filesBelow(destination);
      for (const path of [
        "browser.js",
        "node.js",
        "node.cjs",
        "index.d.ts",
        "view/editor/editor.d.ts",
        "dictionaries/en_US.aff",
        "dictionaries/en_US.dic",
        "dictionaries/DICTIONARY-LICENSE.txt",
        "node_modules/@nautilo/office-core/dist/geometry/index.d.ts",
        "node_modules/@nautilo/office-docs/dist/index.d.ts",
        "node_modules/@nautilo/office-docs/dist/model/types.d.ts",
        "LICENSE",
        "NOTICE.md",
        "THIRD_PARTY_NOTICES.md",
      ]) expect(files).toContain(path);
      expect(files.some(path => /^index-[A-Za-z0-9_-]+\.js$/.test(path))).toBe(true);
      expect(await readFile(join(destination, "node.js"), "utf8")).toBe(
        await readFile(join(root, "packages/office-slides/dist/node.js"), "utf8"),
      );
      expect(await readFile(join(destination, "browser.js"), "utf8")).toBe(
        'export * from "./wafflebase-slides.es.js";\n',
      );
      const provenance = JSON.parse(await readFile(join(destination, "provenance.json"), "utf8")) as {
        revision: unknown;
        artifactTransforms: unknown;
        inputs: unknown;
        sourceSha256: unknown;
        files: Record<string, unknown>;
      };
      expect(provenance.revision).toBe("acde58012910ec68645c65b6896d5408fad1645c");
      expect(provenance.artifactTransforms).toEqual([]);
      expect(provenance.inputs).toEqual([
        "packages/office-core",
        "packages/office-docs",
        "packages/office-slides",
      ]);
      expect(provenance.sourceSha256).toBe(await fingerprintSlidesSource(root));
      for (const path of ["browser.js", "node.js", "dictionaries/en_US.dic", "THIRD_PARTY_NOTICES.md"]) {
        expect(provenance.files[path]).toMatch(/^[a-f0-9]{64}$/);
      }
      const notices = await readFile(join(destination, "THIRD_PARTY_NOTICES.md"), "utf8");
      for (const dependency of [
        "@nautilo/office-core",
        "@nautilo/office-docs",
        "@nautilo/office-slides",
        "@pdf-lib/fontkit",
        "jszip",
        "nspell",
        "pdf-lib",
      ]) expect(notices).toContain(`## ${dependency}@`);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("bundles the real app from an isolated prepared root without workspace resolution", async () => {
    const root = join(import.meta.dir, "../..");
    const sandbox = await mkdtemp(join(tmpdir(), "nautilo-slides-standalone-"));
    const appRoot = join(sandbox, "nautilo-presentation");
    const output = join(sandbox, "dist");
    try {
      await mkdir(appRoot);
      for (const path of ["main.ts", "agent-tools.ts", "src"]) {
        await cp(join(root, "packages/first-party-apps/presentation", path), join(appRoot, path), { recursive: true });
      }
      await buildSlidesArtifacts(root, join(appRoot, "engine"), { build: false });
      const child = spawnSync("bun", ["build", "main.ts", "--target=browser", `--outdir=${output}`, "--splitting"], {
        cwd: appRoot,
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(0);
      const toolBuild = spawnSync("bun", ["build", "agent-tools.ts", "--target=bun", `--outfile=${join(output, "agent-tools.js")}`], {
        cwd: appRoot,
        encoding: "utf8",
      });
      expect(toolBuild.status, toolBuild.stderr).toBe(0);
      const outputFiles = await filesBelow(output);
      expect(outputFiles.length).toBeGreaterThan(1);
      const bundled = (await Promise.all(outputFiles.map(path => readFile(join(output, path), "utf8")))).join("\n");
      expect(bundled).not.toContain(root);
      expect(bundled).not.toMatch(/@nautilo\/office-(?:core|docs|slides)/);
      expect(bundled).not.toMatch(/packages\/office-(?:core|docs|slides)/);
      expect(bundled).not.toMatch(/(?:from\s+|import\()["'](?:@nautilo|\/)/);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
