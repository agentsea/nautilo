import {
  ModelCatalogSchema,
  type ModelCatalogRoutingClass,
} from "@nautilo/types";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";

type TestModelProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "openrouter"
  | "fireworks"
  | "together"
  | "gateway"
  | "venice";

function providerAndRouting(id: string): {
  provider: TestModelProvider;
  routing: ModelCatalogRoutingClass;
} {
  const provider = id.slice(0, id.indexOf(":"));
  switch (provider) {
    case "anthropic":
    case "openai":
    case "google":
    case "xai":
      return { provider, routing: "first-party" };
    case "openrouter":
      return { provider, routing: "openrouter" };
    case "fireworks":
      return { provider, routing: "fireworks" };
    case "together":
      return { provider, routing: "together" };
    case "gateway":
      return { provider, routing: "gateway" };
    case "venice":
      return { provider, routing: "venice-hosted" };
    default:
      throw new Error(`Unsupported test model provider for ${id}`);
  }
}

/**
 * Activate the checked-in catalog plus explicit model-specific rows needed by
 * a provider unit test. This never grants an uncatalogued test placeholder a
 * generic runtime fallback: every added ID receives a concrete bounded tuple.
 */
export interface TestModelCatalogRow {
  readonly id: string;
  readonly reasoning?: boolean;
}

export async function activateModelCatalogForTests(
  rows: readonly (string | TestModelCatalogRow)[],
): Promise<void> {
  const existing = new Set(localModelCatalog.entries.map((entry) => entry.id));
  const normalized = rows.map((row) => typeof row === "string" ? { id: row } : row);
  const additions = normalized
    .filter((row, index) => !existing.has(row.id) && normalized.findIndex((item) => item.id === row.id) === index)
    .map((row, index) => {
      const { id } = row;
      const { provider, routing } = providerAndRouting(id);
      return {
        id,
        displayName: `Test route ${id}`,
        provider,
        routing,
        priority: 900 + index,
        defaultEnabled: true,
        modalities: { input: ["text"], output: ["text"] },
        features: { tools: true, structuredOutputs: true, reasoning: row.reasoning ?? true },
        limits: { contextTokens: 131_072, outputTokens: 8_192 },
        cost: { coefficient: 1 },
        privacy: { grade: 2 },
        intelligence: { tier: "mid" },
      };
    });
  const catalog = ModelCatalogSchema.parse({
    ...localModelCatalog,
    catalogVersion: "2099.01.01.1",
    publishedAt: "2099-01-01T00:00:00Z",
    entries: [...localModelCatalog.entries, ...additions],
  });

  configureRuntimeModelCatalog({
    loader: {
      get: () => Promise.resolve({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2099-01-01T00:00:00Z",
        originUrl: "https://catalog.invalid/test-models.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: () => Promise.resolve(),
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}
