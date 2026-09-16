import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ModelCatalogSchema } from "@nautilo/types";
import { getEligibleModels } from "../../src/config/eligible-models";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import { createUniversalModel } from "../../src/providers/universal";
import { resolveModelRole } from "../../src/config/model-role-resolution";
import { MODEL_ROLE_CANDIDATES } from "@nautilo/config";

async function activateCandidateCatalog() {
  const catalog = ModelCatalogSchema.parse(JSON.parse(await readFile(
    new URL("../fixtures/m252-routed-model-candidates.json", import.meta.url),
    "utf8",
  )));
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-08-12T00:00:00.000Z",
        originUrl: "https://catalog.invalid/m252-candidates.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
  return catalog;
}

describe("M252 unpublished routed candidate qualification", () => {
  afterEach(() => resetRuntimeModelCatalog());

  test("qualifies OpenAI, Anthropic, and Google family routes for tool chat", async () => {
    const catalog = await activateCandidateCatalog();
    for (const provider of ["openrouter", "venice"] as const) {
      const env = provider === "openrouter"
        ? { OPENROUTER_API_KEY: "test-key" }
        : { VENICE_API_KEY: "test-key" };
      const rows = getEligibleModels({ purpose: "chat-tools", env });
      const expected = catalog.entries.filter(
        (entry) => entry.provider === provider && entry.modalities?.output.includes("text"),
      );
      expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
      expect(rows.every((row) => row.capabilities.tools)).toBe(true);
    }
  });

  test("keeps routed image candidates out of chat and in image generation", async () => {
    const catalog = await activateCandidateCatalog();
    const imageIds = catalog.entries
      .filter((entry) => entry.modalities?.output.includes("image"))
      .map((entry) => entry.id);
    const env = { OPENROUTER_API_KEY: "or", VENICE_API_KEY: "vk" };
    expect(getEligibleModels({ purpose: "chat-tools", env }).map((row) => row.id))
      .not.toEqual(expect.arrayContaining(imageIds));
    expect(getEligibleModels({ purpose: "image-generation", env }).map((row) => row.id))
      .toEqual(imageIds);
  });

  test("qualifies embeddings independently and resolves each credentialed route", async () => {
    const catalog = await activateCandidateCatalog();
    const embeddingIds = catalog.entries
      .filter((entry) => entry.modalities?.output.includes("embedding"))
      .map((entry) => entry.id);
    const env = { OPENROUTER_API_KEY: "or", VENICE_API_KEY: "vk" };

    expect(getEligibleModels({ purpose: "embeddings", env }).map((row) => row.id))
      .toEqual(embeddingIds);
    expect(getEligibleModels({ purpose: "chat", env }).map((row) => row.id))
      .not.toEqual(expect.arrayContaining(embeddingIds));
    expect(resolveModelRole("embeddings", { env: { OPENROUTER_API_KEY: "or" } }))
      .toBe("openrouter:openai/text-embedding-3-small");
    expect(resolveModelRole("embeddings", { env: { VENICE_API_KEY: "vk" } }))
      .toBe("venice:text-embedding-3-small");
  });

  test("resolves every essential built-in role with either routed-provider key alone", async () => {
    await activateCandidateCatalog();
    for (const role of Object.keys(MODEL_ROLE_CANDIDATES) as Array<
      keyof typeof MODEL_ROLE_CANDIDATES
    >) {
      expect(
        resolveModelRole(role, { env: { OPENROUTER_API_KEY: "or" } }),
        role,
      ).toStartWith("openrouter:");
      expect(
        resolveModelRole(role, { env: { VENICE_API_KEY: "vk" } }),
        role,
      ).toStartWith("venice:");
    }
  });

  test("constructs every candidate chat route through its route adapter with tool binding", async () => {
    const catalog = await activateCandidateCatalog();
    const chatIds = catalog.entries
      .filter((entry) => entry.modalities?.output.includes("text"))
      .map((entry) => entry.id);
    for (const id of chatIds) {
      const model = await createUniversalModel(id, {
        apiKey: "test-key",
        maxTokens: 64,
      });
      expect(model.bindTools).toBeFunction();
      expect(() => model.bindTools?.([])).not.toThrow();
    }
  });
});
