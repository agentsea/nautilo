import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ModelCatalogSchema } from "@nautilo/types";
import { buildForegroundModelControlPlan } from "../../src/nodes/agent";
import type { ModelControlCatalogEntry } from "../../src/config/model-control-selection";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import { createFireworks } from "../../src/providers/factory";
import {
  FIREWORKS_KIMI_K3_MODEL_ID,
  isFireworksKimiK3ServingProfileId,
} from "../../src/providers/serving-profile";

const CATALOG_FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/model-catalog-v2.json");
const SERVER_ENTRYPOINT_PATH = resolve(import.meta.dir, "../../../../bin/nautilo-server/src/index.ts");

beforeAll(() => {
  bootstrapTestDbInstance();
});

function requiredCallIndex(source: string, call: string): number {
  const index = source.indexOf(call);
  expect(index, `missing production call: ${call}`).toBeGreaterThanOrEqual(0);
  return index;
}

afterEach(() => {
  resetRuntimeModelCatalog();
});

describe("D462 production catalog wiring", () => {
  test("server boot hydrates and refreshes the catalog before database and listener startup", () => {
    const source = readFileSync(SERVER_ENTRYPOINT_PATH, "utf8");
    const hydrate = requiredCallIndex(
      source,
      "const catalogProvenance = await hydrateRuntimeModelCatalog();",
    );
    const refresh = requiredCallIndex(source, "startRuntimeModelCatalogRefreshLoop();");
    const database = requiredCallIndex(
      source,
      "await ensureDatabase((msg: string) => debug(`[db] ${msg}`));",
    );
    const listen = requiredCallIndex(source, "await app.listen({ port, host });");

    expect(hydrate).toBeLessThan(refresh);
    expect(refresh).toBeLessThan(database);
    expect(refresh).toBeLessThan(listen);
  });

  test("a remote-fresh v2 Kimi selection resolves into the reviewed Priority and Fast Fireworks requests", async () => {
    const catalog = ModelCatalogSchema.parse(
      JSON.parse(readFileSync(CATALOG_FIXTURE_PATH, "utf8")),
    );
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-28T00:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => undefined,
        clearCache: () => {},
      },
    });

    const provenance = await hydrateRuntimeModelCatalog();
    expect(provenance).toMatchObject({
      source: "remote-fresh",
      stale: false,
      catalogVersion: catalog.catalogVersion,
    });

    const snapshot = getActiveModelCatalogSync();
    const catalogByModelId = new Map<string, ModelControlCatalogEntry>(
      snapshot.catalog.entries.map((entry) => [entry.id, entry]),
    );
    const kimi = catalogByModelId.get(FIREWORKS_KIMI_K3_MODEL_ID);
    expect(kimi?.controls?.serving?.profiles.map((profile) => profile.id)).toEqual([
      "standard",
      "priority",
      "fast",
    ]);

    for (const expected of [
      {
        profileId: "priority",
        model: "accounts/fireworks/models/kimi-k3",
        modelKwargs: { service_tier: "priority" },
      },
      {
        profileId: "fast",
        model: "accounts/fireworks/routers/kimi-k3-fast",
        modelKwargs: {},
      },
    ] as const) {
      const plan = buildForegroundModelControlPlan(
        { modelId: FIREWORKS_KIMI_K3_MODEL_ID, servingProfileId: expected.profileId },
        null,
        FIREWORKS_KIMI_K3_MODEL_ID,
        catalogByModelId,
      );
      const controls = plan.resolveForegroundControls?.(FIREWORKS_KIMI_K3_MODEL_ID);
      expect(controls).toEqual({
        canonicalModelId: FIREWORKS_KIMI_K3_MODEL_ID,
        servingProfileId: expected.profileId,
      });
      if (!controls || !isFireworksKimiK3ServingProfileId(controls.servingProfileId)) {
        throw new Error("expected a reviewed Fireworks Kimi K3 serving profile");
      }

      const llm = await createFireworks({
        modelId: controls.canonicalModelId,
        apiKey: "test-key",
        maxTokens: 8192,
        fireworksServingProfileId: controls.servingProfileId,
      });
      expect(Reflect.get(llm, "model")).toBe(expected.model);
      expect(Reflect.get(llm, "modelKwargs")).toEqual(expected.modelKwargs);
    }
  });
});
