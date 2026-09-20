import { afterEach, expect, test } from "bun:test";
import { ModelCatalogSchema } from "@nautilo/types";
import { listSpeechModels, getServerSpeechModel, estimateSpeechCostUsd } from "../../src/config/speech-models";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import { configureRuntimeModelCatalog, hydrateRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { resolveRetainedModels } from "../../src/config/eligible-models";
const env = { ELEVENLABS_API_KEY: "synthetic-test-key" };
afterEach(resetRuntimeModelCatalog);
test("catalog priority selects Conversational; explicit standard selection is respected", () => {
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  expect(getServerSpeechModel(null, env).id).toBe("elevenlabs:eleven_v3_conversational");
  expect(getServerSpeechModel("elevenlabs:eleven_v3", env).speech.transport).toBe("elevenlabs-tts-http");
  expect(estimateSpeechCostUsd("a".repeat(1000), getServerSpeechModel(null, env))).toBe("0.05000000");
  expect(() => getServerSpeechModel("elevenlabs:missing", env)).toThrow();
  expect(() => getServerSpeechModel(null, {})).toThrow();
  expect(listSpeechModels({}).every(model => !model.available)).toBe(true);
  expect(resolveRetainedModels(["elevenlabs:eleven_v3"], { purpose: "chat" })[0]!.availability).not.toBe("selectable");
});
test("new catalog model ids and priorities need no model-name switch in execution", async () => {
  const entries = localModelCatalog.entries.filter(entry => "speech" in entry && entry.speech).map(entry => ({ ...entry,
    id: "elevenlabs:synthetic-next-" + entry.priority, priority: 3 - entry.priority,
  }));
  const catalog = ModelCatalogSchema.parse({ ...localModelCatalog, entries });
  const result = { catalog, source: "remote-fresh" as const, stale: false, fetchedAt: "2099-01-01T00:00:00Z", originUrl: "https://catalog.invalid", reason: "test", catalogVersion: catalog.catalogVersion };
  configureRuntimeModelCatalog({ loader: { clearCache() {}, get: async () => result, refresh: async () => result } });
  await hydrateRuntimeModelCatalog();
  expect(getServerSpeechModel(null, env).id).toBe("elevenlabs:synthetic-next-2");
});
test("legacy schemas reject speech; speech cannot carry chat fields or transport URLs", () => {
  const entry = localModelCatalog.entries.find(entry => "workload" in entry && entry.workload === "speech")!;
  for (const version of [1, 2, 3, 4]) expect(ModelCatalogSchema.safeParse({ ...localModelCatalog, version, entries: [entry] }).success).toBe(false);
  expect(ModelCatalogSchema.safeParse({ ...localModelCatalog, entries: [{ ...entry, limits: { contextTokens: 100, outputTokens: 10 } }] }).success).toBe(false);
  expect(ModelCatalogSchema.safeParse({ ...localModelCatalog, entries: [{ ...entry, speech: { ...("speech" in entry ? entry.speech : {}), url: "https://untrusted.invalid" } }] }).success).toBe(false);
});
