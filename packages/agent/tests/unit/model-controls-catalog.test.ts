import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelCatalogSchema } from "@nautilo/types";

const VALID_FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/model-catalog-controls-v2.json");
const INVALID_FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/model-catalog-controls-invalid.json");

type JsonObject = Record<string, unknown>;

function validFixture(): JsonObject {
  return JSON.parse(readFileSync(VALID_FIXTURE_PATH, "utf8")) as JsonObject;
}

function setAtPath(value: unknown, path: (string | number)[], replacement: unknown): void {
  let current = value as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string | number, unknown>;
  }
  current[path[path.length - 1]!] = replacement;
}

describe("D462 Phase 0/1 — strict reader-first Reasoning and Serving catalog contract", () => {
  test("parses provider-neutral controls while retaining model-only v2 rows", () => {
    const catalog = ModelCatalogSchema.parse(validFixture());
    expect(catalog.version).toBe(2);
    expect(catalog.entries).toHaveLength(6);
    if (catalog.version !== 2) throw new Error("expected v2 control fixture");

    const kimi = catalog.entries.find(
      (entry) => entry.id === "fireworks:accounts/fireworks/models/kimi-k3",
    );
    expect(kimi?.controls?.reasoning).toBeUndefined();
    expect(kimi?.controls?.serving?.profiles.map((profile) => profile.id)).toEqual([
      "standard",
      "priority",
      "fast",
    ]);
    expect(kimi?.controls?.serving?.profiles[2]?.selector).toEqual({
      kind: "model-override",
      modelId: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
    });
    expect(kimi?.controls?.serving?.profiles[1]?.pricing).toMatchObject({
      inputPerMtok: 3.75,
      cachedInputPerMtok: 0.375,
      outputPerMtok: 18.75,
    });
  });

  test("keeps strict v1/model-only last-known-good manifests readable but rejects v1 controls", () => {
    const v1 = validFixture();
    v1["version"] = 1;
    const entries = v1["entries"] as Record<string, unknown>[];
    for (const entry of entries) delete entry["controls"];
    expect(ModelCatalogSchema.parse(v1).version).toBe(1);

    v1["entries"] = [(validFixture()["entries"] as Record<string, unknown>[])[0]!];
    expect(() => ModelCatalogSchema.parse(v1)).toThrow();
  });

  test("rejects every negative Phase 0 fixture and unknown nested fields", () => {
    const invalidCases = JSON.parse(readFileSync(INVALID_FIXTURE_PATH, "utf8")) as {
      name: string;
      mutate: { entry: number; path: (string | number)[]; value: unknown };
    }[];
    for (const invalidCase of invalidCases) {
      const candidate = validFixture();
      const entries = candidate["entries"] as Record<string, unknown>[];
      setAtPath(entries[invalidCase.mutate.entry]!, invalidCase.mutate.path, invalidCase.mutate.value);
      expect(() => ModelCatalogSchema.parse(candidate), invalidCase.name).toThrow();
    }

    const candidate = validFixture();
    const entries = candidate["entries"] as Record<string, unknown>[];
    setAtPath(entries[4]!, ["controls", "serving", "profiles", 0, "selector", "requestBody"], { unsafe: true });
    expect(() => ModelCatalogSchema.parse(candidate)).toThrow();
  });

  test("keeps control snapshots serializable for atomic remote hydration", () => {
    const catalog = ModelCatalogSchema.parse(validFixture());
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });
});
