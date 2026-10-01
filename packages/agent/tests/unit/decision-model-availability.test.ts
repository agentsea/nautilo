import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolCatalog } from "@nautilo/catalog";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import { ModelCatalogV6Schema, type ModelCatalog } from "@nautilo/types";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  hasSelectableDecisionModel,
  listResolvedCatalogModels,
} from "../../src/config/resolved-catalog";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";
import { registerAllTools } from "../../src/tools/register-all";

const decision = {
  id: "openrouter:example/decision",
  displayName: "Example decision model",
  provider: "openrouter",
  routing: "openrouter",
  priority: 1,
  defaultEnabled: true,
  workload: "decision",
  capabilityProvenance: "override",
  modalities: { input: ["text"], output: ["text"] },
  cost: { coefficient: 1 },
  privacy: { grade: 4 },
  decision: { operations: ["choice"], inputTokens: 32_000, maxChoices: 255 },
};

const envKeys = [
  "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "VENICE_API_KEY",
  "NAUTILO_SKIP_VENICE_REFRESH",
  "NAUTILO_VENICE_MODELS_CACHE_PATH",
] as const;

describe("decision model availability", () => {
  let snapshot: ModelCatalog;
  let directory: string;
  let savedEnv: Array<string | undefined>;

  async function publish(entries: unknown[]): Promise<void> {
    snapshot = ModelCatalogV6Schema.parse({
      version: 6,
      catalogVersion: "2026.09.01.1",
      publishedAt: "2026-09-01T00:00:00Z",
      entries,
    });
    await hydrateRuntimeModelCatalog();
  }

  function fullListAvailable(env: NodeJS.ProcessEnv): boolean {
    return listResolvedCatalogModels({ env }).some((row) =>
      row.workload === "decision" && row.availability === "selectable",
    );
  }

  beforeEach(() => {
    savedEnv = envKeys.map((key) => process.env[key]);
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"];
    delete process.env["VENICE_API_KEY"];
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "decision-availability-"));
    process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = path.join(directory, "venice.json");
    resetModelCapabilitiesCacheForTests();
    resetVeniceCatalogCacheModuleForTests();
    snapshot = localModelCatalog;
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog: snapshot, source: "remote-fresh", stale: false,
          fetchedAt: "2026-09-01T00:00:00Z", originUrl: "https://catalog.example/models.json",
          reason: "", catalogVersion: snapshot.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    resetModelCapabilitiesCacheForTests();
    resetVeniceCatalogCacheModuleForTests();
    envKeys.forEach((key, index) => {
      const value = savedEnv[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each([
    {},
    { OPENROUTER_API_KEY: "synthetic-openrouter-key" },
    { TYPESAFE_API_KEY: "synthetic-typesafe-key" },
    { OPENROUTER_API_KEY: " ", TYPESAFE_API_KEY: " " },
  ])("matches full discovery for bundled models and explicit credentials %j", (env) => {
    expect(hasSelectableDecisionModel({ env })).toBe(fullListAvailable(env));
  });

  test.each([
    ["disabled", { ...decision, defaultEnabled: false }],
    ["unsupported provider", { ...decision, id: "google:example-decision", provider: "google", routing: "first-party" }],
    ["unsupported input", { ...decision, modalities: { input: ["image"], output: ["text"] } }],
  ])("preserves exact resolver denial for %s", async (_label, entry) => {
    await publish([entry]);
    const env = { OPENROUTER_API_KEY: "synthetic-key", GOOGLE_API_KEY: "synthetic-key" };
    expect(fullListAvailable(env)).toBe(false);
    expect(hasSelectableDecisionModel({ env })).toBe(false);
  });

  test("finds a later runnable model after an unavailable decision entry", async () => {
    await publish([
      { ...decision, defaultEnabled: false },
      { ...decision, id: "typesafe:example-decision", provider: "typesafe", routing: "first-party" },
    ]);
    const env = { TYPESAFE_API_KEY: "synthetic-typesafe-key" };
    expect(fullListAvailable(env)).toBe(true);
    expect(hasSelectableDecisionModel({ env })).toBe(true);
  });

  test("Venice decision availability still follows fresh provider removal and offline state", async () => {
    await publish([{
      ...decision, id: "venice:example-decision", provider: "venice", routing: "venice-hosted",
    }]);
    const env = { VENICE_API_KEY: "synthetic-venice-key" };
    const writeProviderState = (models: Record<string, unknown>) => fs.writeFileSync(
      process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"]!,
      JSON.stringify({ fetchedAt: new Date().toISOString(), complete: true, models }),
    );
    for (const [models, expected] of [
      [{ "example-decision": { type: "decision", offline: false } }, true],
      [{ "example-decision": { type: "decision", offline: true } }, false],
      [{ "another-decision": { type: "decision", offline: false } }, false],
      [{ "example-decision": { type: "decision", offline: false } }, true],
    ] as const) {
      writeProviderState(models);
      expect(fullListAvailable(env)).toBe(expected);
      expect(hasSelectableDecisionModel({ env })).toBe(expected);
    }
  });

  test("catalog binding observes credential revocation and snapshot replacement without re-registration", async () => {
    await publish([decision]);
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    const visible = () => catalog.query({ enabled: true }).some((tool) => tool.name === "evaluate_decisions");

    expect(visible()).toBe(false);
    process.env["OPENROUTER_API_KEY"] = "synthetic-key";
    expect(visible()).toBe(true);
    delete process.env["OPENROUTER_API_KEY"];
    expect(visible()).toBe(false);
    process.env["OPENROUTER_API_KEY"] = "synthetic-key";
    await publish([{ ...decision, defaultEnabled: false }]);
    expect(visible()).toBe(false);
    await publish([decision]);
    expect(visible()).toBe(true);
    await publish(localModelCatalog.entries.filter((entry) => !("workload" in entry && entry.workload === "decision")));
    expect(visible()).toBe(false);
  });

  test("policy catalogue reads do not read unrelated Venice metadata or fetch providers", async () => {
    // Retain Venice chat/media rows, but use only non-Venice decision models.
    // A Venice decision entry must still consult its own current provider state.
    await publish(localModelCatalog.entries.filter((entry) =>
      !(entry.provider === "venice" && "workload" in entry && entry.workload === "decision"),
    ));
    process.env["OPENROUTER_API_KEY"] = "synthetic-key";
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    const cachePath = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    const read = spyOn(fs, "readFileSync");
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("availability must not fetch a provider"),
    );
    try {
      expect(catalog.query({ enabled: true }).some((tool) => tool.name === "evaluate_decisions")).toBe(true);
      delete process.env["OPENROUTER_API_KEY"];
      expect(catalog.query({ enabled: true }).some((tool) => tool.name === "evaluate_decisions")).toBe(false);
      expect(read.mock.calls.filter(([file]) => file === cachePath)).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      fetch.mockRestore();
    }
  });
});
