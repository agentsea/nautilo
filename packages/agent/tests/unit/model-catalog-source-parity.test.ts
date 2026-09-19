import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelCatalogSchema } from "@nautilo/types";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import {
  getModelMaxOutputTokens,
  getModelTokenLimit,
} from "../../src/providers/models";

const RUNTIME_SEED_PATH = resolve(
  import.meta.dir,
  "../../src/config/model-catalog/seed/catalog.json",
);

const EXPECTED_AUDITED_LIMITS = {
  // Fireworks Get Model gives exact contextLength=1,048,576. Its documented
  // remaining-context completion policy supplies the request ceiling, supported
  // by a non-clamping 1,048,000-token request acceptance probe. This is not a
  // claim that a completed generation of that length was observed.
  "fireworks:accounts/fireworks/models/glm-5p3": {
    contextTokens: 1_048_576, outputTokens: 1_048_576,
  },
  "openrouter:moonshotai/kimi-k3": {
    contextTokens: 1_048_576,
    outputTokens: 1_048_576,
  },
  "openrouter:meta/muse-spark-1.2": {
    contextTokens: 1_048_576,
    outputTokens: 131_072,
  },
  "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731": {
    contextTokens: 1_040_000,
    outputTokens: 1_040_000,
  },
  // Context-derived request ceiling; execution subtracts the actual prompt.
  // This does not claim an observed million-token completion.
  "fireworks:accounts/fireworks/models/deepseek-v4p1-flash": {
    contextTokens: 1_048_576, outputTokens: 1_048_576,
  },
  "openrouter:deepseek/deepseek-v4.1-flash": {
    contextTokens: 1_048_576, outputTokens: 384_000,
  },
} as const;

describe("checked-in model catalog fallback", () => {
  test("pins the reviewed manifest bytes used for deterministic/offline startup", () => {
    const manifest: unknown = JSON.parse(readFileSync(RUNTIME_SEED_PATH, "utf8"));
    const parsed = ModelCatalogSchema.parse(manifest);
    // Match the canonical publisher's artifact serialization, before schema parsing.
    expect(createHash("sha256").update(`${JSON.stringify(manifest)}\n`).digest("hex"))
      .toBe("19cc7687c775b2bbcc33cbb9ed23f1e28d3f8a61a909864dc3828b77cde79fa2");

    expect(parsed).toEqual(localModelCatalog);
    expect(parsed).toMatchObject({
      version: 4,
      catalogVersion: "2026.09.18.2",
      publishedAt: "2026-09-18T15:17:12Z",
    });
    expect(parsed.entries).toHaveLength(87);
    expect(
      parsed.entries
        .filter((entry) =>
          "taskPreferences" in entry
          && entry.taskPreferences?.includes("security_research")
        )
        .map((entry) => entry.id),
    ).toEqual([
      "fireworks:accounts/fireworks/models/glm-5p3",
      "openrouter:z-ai/glm-5.3",
      "venice:z-ai-glm-5-3",
    ]);
  });

  test("includes the exact canonical Jev decision candidate", () => {
    const entry = localModelCatalog.entries.find(
      (candidate) => candidate.id === "openrouter:typesafe/jev-1.13",
    );

    expect(entry).toEqual({
      id: "openrouter:typesafe/jev-1.13",
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
    });
  });

  test("every bundled chat route has positive model-specific limits and non-chat routes omit them", () => {
    for (const entry of localModelCatalog.entries) {
      if ("workload" in entry && entry.workload !== undefined && entry.workload !== "chat") {
        expect(entry.limits, `${entry.id} must not declare chat token limits`).toBeUndefined();
        continue;
      }

      expect(entry.limits, `${entry.id} is missing model-specific limits`).toBeDefined();
      expect(entry.limits!.contextTokens).toBeGreaterThan(0);
      expect(entry.limits!.outputTokens).toBeGreaterThan(0);
      expect(entry.limits!.outputTokens).toBeLessThanOrEqual(entry.limits!.contextTokens);
    }
  });

  test("audited routes carry their reviewed exact limits", () => {
    const byId = new Map(localModelCatalog.entries.map((entry) => [entry.id, entry]));

    for (const [id, limits] of Object.entries(EXPECTED_AUDITED_LIMITS)) {
      expect(byId.get(id)?.limits, id).toEqual(limits);
    }
  });

  test("execution resolves every bundled chat row from the same catalog values without a global clamp", async () => {
    for (const entry of localModelCatalog.entries) {
      if ("workload" in entry && entry.workload !== undefined && entry.workload !== "chat") continue;
      const limits = entry.limits!;

      expect(getModelTokenLimit(entry.id), entry.id).toBe(limits.contextTokens);
      expect(await getModelMaxOutputTokens(entry.id), entry.id).toBe(limits.outputTokens);
      if (limits.outputTokens > 16_384) {
        expect(await getModelMaxOutputTokens(entry.id), `${entry.id} was globally clamped`)
          .toBeGreaterThan(16_384);
      }
    }
  });
});
