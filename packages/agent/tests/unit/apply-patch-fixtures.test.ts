/**
 * D448 reusable fixture corpus contract.
 *
 * These tests are intentionally pure. They exercise only the TypeScript
 * request/preflight/normalization boundary and never invoke a parser, spawn a
 * child, resolve a path, or mutate a fixture target. Codex grammar semantics
 * and on-disk effects remain assertions for the pinned native extraction.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  applyPatchChildExecutionReportSchema,
  applyPatchNormalizationMetadataSchema,
  applyPatchResultSchema,
  normalizeApplyPatchResult,
  validateApplyPatchPreflight,
  validateApplyPatchRequest,
} from "../../src/tools/apply-patch/contract";

const FIXTURE_ROOT = join(import.meta.dir, "../fixtures/apply-patch");

type Expected = { readonly result?: "accepted" | "accepted_envelope_only" | "applied" | "partial"; readonly error?: string };
type FixtureEntry = {
  readonly id: string;
  readonly kind: "request" | "preflight" | "normalization";
  readonly phase: string;
  readonly valid: boolean;
  readonly expected: Expected;
  readonly files: readonly string[];
};
type FixtureManifest = {
  readonly version: number;
  readonly nativeParserCorpusDeferred: readonly string[];
  readonly entries: readonly FixtureEntry[];
};

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), "utf8")) as unknown;
}

function collectFixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFixtureFiles(path) : [relative(FIXTURE_ROOT, path)];
  });
}

const manifest = readJson("manifest.json") as FixtureManifest;

function requireFile(entry: FixtureEntry, suffix: string): string {
  const file = entry.files.find((candidate) => candidate.endsWith(suffix));
  if (!file) throw new Error(`${entry.id} is missing a ${suffix} fixture.`);
  return file;
}

describe("D448 apply_patch fixture corpus integrity", () => {
  test("has a complete manifest with no orphaned or unlisted fixture file", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.nativeParserCorpusDeferred.length).toBeGreaterThan(0);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(new Set(manifest.entries.map((entry) => entry.id)).size).toBe(manifest.entries.length);

    const referenced = new Set<string>();
    for (const entry of manifest.entries) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(["request", "preflight", "normalization"]).toContain(entry.kind);
      expect(entry.phase.length).toBeGreaterThan(0);
      expect(entry.files.length).toBeGreaterThan(0);
      expect(Object.keys(entry.expected)).toHaveLength(1);
      for (const file of entry.files) {
        expect(file).not.toContain("\\");
        expect(file).not.toContain("..");
        expect(statSync(join(FIXTURE_ROOT, file)).size).toBeGreaterThan(0);
        referenced.add(file);
      }
    }

    const actual = collectFixtureFiles(FIXTURE_ROOT)
      .filter((file) => file !== "manifest.json")
      .sort();
    expect(actual).toEqual([...referenced].sort());
  });

  test("keeps JSON fixture bytes parseable and only declares deferred native parser work", () => {
    for (const file of collectFixtureFiles(FIXTURE_ROOT)) {
      if (file.endsWith(".json")) expect(() => readJson(file)).not.toThrow();
    }
    expect(manifest.nativeParserCorpusDeferred.join(" ")).toMatch(/native extraction/i);
  });
});

describe("D448 apply_patch fixture boundary validation", () => {
  for (const entry of manifest.entries) {
    test(entry.id, () => {
      if (entry.kind === "request") {
        const patch = readFileSync(join(FIXTURE_ROOT, requireFile(entry, ".patch")), "utf8");
        const result = validateApplyPatchRequest({ patch });
        if (entry.valid) {
          expect(result).toMatchObject({ ok: true });
          expect(entry.expected.result).toBe("accepted_envelope_only");
        } else {
          expect(result).toMatchObject({ ok: false, error: { code: entry.expected.error } });
        }
        return;
      }

      if (entry.kind === "preflight") {
        const result = validateApplyPatchPreflight(readJson(requireFile(entry, ".json")));
        if (entry.valid) {
          expect(result).toMatchObject({ ok: true });
          expect(entry.expected.result).toBe("accepted");
        } else {
          expect(result).toMatchObject({ ok: false, error: { code: entry.expected.error } });
        }
        return;
      }

      const child = readJson(requireFile(entry, ".child.json"));
      const metadata = readJson(requireFile(entry, ".metadata.json"));
      expect(applyPatchChildExecutionReportSchema.safeParse(child).success).toBe(true);
      const metadataParsed = applyPatchNormalizationMetadataSchema.safeParse(metadata);
      const result = normalizeApplyPatchResult(child, metadata);
      if (!entry.valid) {
        expect(metadataParsed.success).toBe(false);
        expect(result).toMatchObject({ ok: false, error: { code: entry.expected.error } });
        return;
      }

      expect(metadataParsed.success).toBe(true);
      expect(result).toMatchObject({ ok: true, result: { status: entry.expected.result } });
      if (!result.ok) throw new Error(`${entry.id} did not normalize.`);
      const expectedPublic = applyPatchResultSchema.safeParse(
        readJson(requireFile(entry, ".public.json")),
      );
      expect(expectedPublic.success).toBe(true);
      if (!expectedPublic.success) throw new Error(`${entry.id} has an invalid public fixture.`);
      expect(result.result).toEqual(expectedPublic.data);
    });
  }
});
