import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path]);
  }));
  return nested.flat();
}

describe("Reflection Wave 3 boundaries", () => {
  test("production Reflection has no product, persistence, crypto, or provider dependency", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../src");
    const sources = (await filesUnder(sourceRoot)).filter((path) => extname(path) === ".ts");
    const content = await Promise.all(sources.map((path) => readFile(path, "utf8")));
    for (const forbidden of [
      "@nautilo/runtime",
      "@nautilo/server",
      "@nautilo/db",
      "@nautilo/trust",
      "@nautilo/lattice-bridge",
      "@nautilo/lattice-crypto",
      "@nautilo/agent",
    ]) expect(content.join("\n")).not.toContain(forbidden);
  });

  test("no production package imports the synthetic repository", async () => {
    const packagesRoot = resolve(import.meta.dir, "../../..");
    const files = (await filesUnder(packagesRoot)).filter((path) =>
      extname(path) === ".ts"
      && !path.includes("/tests/")
      && !path.includes("/packages/reflection/")
    );
    const content = await Promise.all(files.map((path) => readFile(path, "utf8")));
    expect(content.join("\n")).not.toContain("graph/in-memory-repository");
  });

  test("candidate policy and corpus have one Reflection owner", async () => {
    const workspaceRoot = resolve(import.meta.dir, "../../../..");
    const candidates = (await filesUnder(resolve(workspaceRoot, "packages"))).filter((path) =>
      path.includes("reflection-candidate-policy")
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((path) => path.includes("/packages/reflection/"))).toBe(true);
  });

  test("keeps the existing Stenographer public surface while limiting new exports", async () => {
    const index = await readFile(resolve(import.meta.dir, "../../src/index.ts"), "utf8");
    for (const existing of [
      "./stenographer/constants",
      "./stenographer/types",
      "./stenographer/evidence-projection",
      "./stenographer/output-validation",
      "./stenographer/compaction",
      "./stenographer/processor",
    ]) expect(index).toContain(existing);
    expect(index).not.toContain("in-memory-repository");
    expect(index).not.toContain("fixture-snapshots");
  });
});
