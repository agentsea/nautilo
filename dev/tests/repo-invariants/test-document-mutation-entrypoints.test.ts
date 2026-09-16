import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const manifestPath = join(import.meta.dir, "document-mutation-entrypoints.json");

type Disposition = "planner" | "coordinator_adapter" | "compatibility_only" | "excluded";
type Owner = "workspace_backend" | "desktop_backend" | "coordinator" | "importer" | "filesystem_ui";
type PrimitivePattern = { id: string; source: string; modules?: string[] };
type HitAllowance = { primitive: string; count: number };
type Entry = {
  id: string;
  module: string;
  symbols: string[];
  disposition: Disposition;
  owner: Owner;
  hits: HitAllowance[];
};
type Exclusion = { path: string; reason: string; optional?: boolean };
type Manifest = {
  schemaVersion: number;
  purpose: string;
  dispositions: Disposition[];
  owners: Owner[];
  scanRoots: string[];
  exclusions: Exclusion[];
  primitivePatterns: PrimitivePattern[];
  entries: Entry[];
};
type ObservedHit = { module: string; primitive: string; count: number };

const allowedDispositions: Disposition[] = ["planner", "coordinator_adapter", "compatibility_only", "excluded"];
const allowedOwners: Owner[] = ["workspace_backend", "desktop_backend", "coordinator", "importer", "filesystem_ui"];

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function filesUnder(root: string): string[] {
  const absolute = join(repoRoot, root);
  if (statSync(absolute).isFile()) return [portablePath(root)];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = portablePath(join(root, entry.name));
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(child);
  }
  return files;
}

function isExcluded(module: string, exclusions: Exclusion[]): boolean {
  return exclusions.some(({ path }) => module === path || module.startsWith(`${path}/`));
}

function executableSource(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function observedHits(manifest: Manifest): ObservedHit[] {
  const patterns = manifest.primitivePatterns.map((pattern) => ({
    ...pattern,
    regex: new RegExp(pattern.source, "g"),
  }));
  const modules = [...new Set(manifest.scanRoots.flatMap(filesUnder))]
    .map(portablePath)
    .filter((module) => !isExcluded(module, manifest.exclusions))
    .sort();
  const hits: ObservedHit[] = [];
  for (const module of modules) {
    const text = readFileSync(join(repoRoot, module), "utf8");
    for (const { id, regex, modules } of patterns) {
      if (modules !== undefined && !modules.includes(module)) continue;
      regex.lastIndex = 0;
      const count = [...executableSource(text).matchAll(regex)].length;
      if (count > 0) hits.push({ module, primitive: id, count });
    }
  }
  return hits.sort((a, b) => hitKey(a).localeCompare(hitKey(b)));
}

function hitKey(hit: Pick<ObservedHit, "module" | "primitive">): string {
  return `${portablePath(hit.module)}::${hit.primitive}`;
}

/** Pure classifier: an unmatched observed authority primitive is a bypass. */
function classifyHits(expected: ObservedHit[], actual: ObservedHit[]): { missing: string[]; unexpected: string[] } {
  const expectedByKey = new Map(expected.map((hit) => [hitKey(hit), hit.count]));
  const actualByKey = new Map(actual.map((hit) => [hitKey(hit), hit.count]));
  const missing = [...expectedByKey]
    .filter(([key, count]) => actualByKey.get(key) !== count)
    .map(([key, count]) => `${key} expected ${count}, found ${actualByKey.get(key) ?? 0}`)
    .sort();
  const unexpected = [...actualByKey]
    .filter(([key, count]) => expectedByKey.get(key) !== count)
    .map(([key, count]) => `${key} found ${count}, expected ${expectedByKey.get(key) ?? 0}`)
    .sort();
  return { missing, unexpected };
}

function expectedHits(manifest: Manifest): ObservedHit[] {
  return manifest.entries.flatMap((entry) => entry.hits.map((hit) => ({
    module: entry.module,
    primitive: hit.primitive,
    count: hit.count,
  }))).sort((a, b) => hitKey(a).localeCompare(hitKey(b)));
}

describe("D448 document mutation entrypoint inventory", () => {
  test("manifest schema is complete, unique, and points at live production symbols", () => {
    const manifest = readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.purpose.length).toBeGreaterThan(40);
    expect(manifest.dispositions).toEqual(allowedDispositions);
    expect(manifest.owners).toEqual(allowedOwners);
    expect(manifest.scanRoots.length).toBeGreaterThan(0);
    expect(new Set(manifest.scanRoots).size).toBe(manifest.scanRoots.length);
    expect(manifest.exclusions.length).toBeGreaterThan(0);

    for (const root of manifest.scanRoots) expect(existsSync(join(repoRoot, root))).toBe(true);
    for (const exclusion of manifest.exclusions) {
      expect(exclusion.reason.length).toBeGreaterThan(12);
      expect(existsSync(join(repoRoot, exclusion.path)) || exclusion.optional === true).toBe(true);
    }

    const ids = manifest.entries.map((entry) => entry.id);
    const modules = manifest.entries.map((entry) => entry.module);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(modules).size).toBe(modules.length - 1); // app-tool-host intentionally has adapter + compatibility entries.
    for (const entry of manifest.entries) {
      expect(entry.id).toMatch(/^[A-Z0-9-]+$/);
      expect(allowedDispositions).toContain(entry.disposition);
      expect(allowedOwners).toContain(entry.owner);
      expect(entry.symbols.length).toBeGreaterThan(0);
      const absolute = join(repoRoot, entry.module);
      expect(existsSync(absolute)).toBe(true);
      const source = readFileSync(absolute, "utf8");
      for (const symbol of entry.symbols) expect(source).toContain(symbol);
      const primitiveIds = entry.hits.map((hit) => hit.primitive);
      expect(new Set(primitiveIds).size).toBe(primitiveIds.length);
      for (const hit of entry.hits) {
        expect(hit.count).toBeGreaterThan(0);
        expect(manifest.primitivePatterns.some((pattern) => pattern.id === hit.primitive)).toBe(true);
      }
    }
  });

  test("every narrow authority hit is classified exactly and the inventory has no stale hit", () => {
    const manifest = readManifest();
    const expected = expectedHits(manifest);
    const expectedKeys = expected.map(hitKey);
    expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
    const result = classifyHits(expected, observedHits(manifest));
    expect(result).toEqual({ missing: [], unexpected: [] });
  });

  test("the classifier rejects a newly introduced unclassified authority primitive", () => {
    const expected: ObservedHit[] = [{ module: "packages/agent/src/tools/file/user-save.ts", primitive: "workspace_atomic_bytes", count: 1 }];
    const actual: ObservedHit[] = [
      ...expected,
      { module: "packages/agent/src/tools/file/new-direct-writer.ts", primitive: "workspace_atomic_bytes", count: 1 },
    ];
    expect(classifyHits(expected, actual)).toEqual({
      missing: [],
      unexpected: ["packages/agent/src/tools/file/new-direct-writer.ts::workspace_atomic_bytes found 1, expected 0"],
    });
  });
});
