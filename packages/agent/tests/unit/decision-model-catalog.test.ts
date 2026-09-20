import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ModelCatalogSchema,
  ModelCatalogV1Schema,
  ModelCatalogV2Schema,
  ModelCatalogV3Schema,
  ModelCatalogV4Schema,
  type ModelCatalogEntry,
} from "@nautilo/types";
import { resolveCatalogModel } from "../../src/config/resolved-catalog";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";

const JEV_ID = "openrouter:typesafe/jev-1.13";

const jevEntry = {
  id: JEV_ID,
  displayName: "Jev 1.13 (OpenRouter)",
  provider: "openrouter",
  routing: "openrouter",
  priority: 999,
  defaultEnabled: true,
  workload: "decision",
  modalities: { input: ["text"], output: ["text"] },
  capabilityProvenance: "openrouter",
  cost: { coefficient: 0.014 },
  privacy: { grade: 4 },
  decision: {
    operations: ["choice"],
    inputTokens: 32_000,
    maxChoices: 255,
  },
} satisfies ModelCatalogEntry;

function v4Manifest(entry: unknown = jevEntry) {
  return {
    version: 4,
    catalogVersion: "2026.09.18.1",
    publishedAt: "2026-09-18T10:39:55Z",
    entries: [entry],
  };
}

function legacyCompatibleEntry(index: number) {
  return {
    id: `openrouter:test/model-${index}`,
    displayName: `Limit Test Model ${index}`,
    provider: "openrouter",
    routing: "openrouter",
    priority: 999,
    defaultEnabled: true,
    modalities: { input: ["text"], output: ["text"] },
    features: { tools: false, structuredOutputs: false, reasoning: false },
    capabilityProvenance: "override",
    limits: { contextTokens: 8_192, outputTokens: 1_024 },
    cost: { coefficient: 1 },
    privacy: { grade: 2 },
    intelligence: { tier: "small" },
  };
}

describe("v4 decision catalog contract", () => {
  test("removes the inherited entry ceiling only from v4", () => {
    const entries = Array.from({ length: 501 }, (_, index) => legacyCompatibleEntry(index));
    const manifest = { ...v4Manifest(), entries };

    expect(ModelCatalogV4Schema.safeParse(manifest).success).toBe(true);
    for (const [schema, version] of [
      [ModelCatalogV1Schema, 1],
      [ModelCatalogV2Schema, 2],
      [ModelCatalogV3Schema, 3],
    ] as const) {
      expect(schema.safeParse({ ...manifest, version }).success).toBe(false);
    }
    expect(ModelCatalogV4Schema.safeParse({
      ...manifest,
      entries: [entries[0], entries[0]],
    }).success).toBe(false);
  });

  test("matches the canonical Choice metadata in the latest entry type", () => {
    const parsed = ModelCatalogV4Schema.parse(v4Manifest());
    const latestEntry: ModelCatalogEntry = parsed.entries[0]!;

    expect(ModelCatalogSchema.parse(parsed)).toEqual(parsed);
    expect(latestEntry).toEqual(jevEntry);
    expect(latestEntry.decision).toEqual({
      operations: ["choice"],
      inputTokens: 32_000,
      maxChoices: 255,
    });
  });

  test("keeps the v3 reader closed to v4 decision metadata", () => {
    const parsed = ModelCatalogV4Schema.parse(v4Manifest());
    expect(() => ModelCatalogV3Schema.parse(parsed)).toThrow();
  });

  test("rejects unsupported operations, missing facts, and unknown executable fields", () => {
    const invalidEntries = [
      { ...jevEntry, decision: { ...jevEntry.decision, operations: ["score"] } },
      { ...jevEntry, decision: { operations: ["choice"], inputTokens: 32_000 } },
      { ...jevEntry, decision: { ...jevEntry.decision, maxChoices: 0 } },
      { ...jevEntry, endpoint: "https://example.invalid/decisions" },
      { ...jevEntry, adapter: "openrouter-choice" },
    ];

    for (const entry of invalidEntries) {
      expect(() => ModelCatalogV4Schema.parse(v4Manifest(entry))).toThrow();
    }
  });

  test("rejects chat, generation, intelligence, feature, control, and Task metadata", () => {
    const forbidden = [
      { limits: { contextTokens: 32_000, outputTokens: 1 } },
      { intelligence: { tier: "small" } },
      { features: { tools: false, structuredOutputs: true, reasoning: false } },
      {
        controls: {
          serving: {
            defaultProfile: "standard",
            profiles: [{
              id: "standard",
              label: "Standard",
              intent: "balanced",
              selector: { kind: "default" },
            }],
            provenance: {
              kind: "provider-documentation",
              provider: "openrouter",
              verifiedAt: "2026-09-18T00:00:00Z",
            },
          },
        },
      },
      { generation: { family: "image" } },
      { taskPreferences: ["security_research"] },
    ];

    for (const fields of forbidden) {
      expect(() => ModelCatalogV4Schema.parse(v4Manifest({ ...jevEntry, ...fields }))).toThrow();
    }
  });
});

describe("resolved decision projection", () => {
  beforeEach(() => resetRuntimeModelCatalog());
  afterEach(() => resetRuntimeModelCatalog());

  test("projects decision facts without chat limits, intelligence, or cached feature inheritance", () => {
    const row = resolveCatalogModel(JEV_ID, {
      env: { OPENROUTER_API_KEY: "test-openrouter-key" },
    });

    expect(row).toMatchObject({
      id: JEV_ID,
      workload: "decision",
      input: ["text"],
      output: ["text"],
      generation: null,
      decision: {
        operations: ["choice", "noul", "score"],
        inputTokens: 32_000,
        maxChoices: 255,
      },
      features: {
        tools: null,
        structuredOutputs: null,
        reasoning: null,
        webSearch: null,
        e2ee: null,
      },
      privacyGrade: 4,
      intelligenceTier: null,
      intelligenceRank: null,
      costCoefficient: 0.014,
      contextTokens: null,
      maxOutputTokens: null,
      provenance: "openrouter",
    });
  });

  test("keeps decision metadata null on existing chat and generation rows", () => {
    const chat = resolveCatalogModel("anthropic:claude-sonnet-4-6", {
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    });
    const generation = resolveCatalogModel("openrouter:openai/gpt-5.4-image-2", {
      env: { OPENROUTER_API_KEY: "test-openrouter-key" },
    });

    expect(chat.workload).toBe("chat");
    expect(chat.decision).toBeNull();
    expect(chat.contextTokens).toBeGreaterThan(0);
    expect(chat.maxOutputTokens).toBeGreaterThan(0);

    expect(generation.workload).toBe("generation");
    expect(generation.decision).toBeNull();
    expect(generation.contextTokens).toBeNull();
    expect(generation.maxOutputTokens).toBeNull();
  });
});
