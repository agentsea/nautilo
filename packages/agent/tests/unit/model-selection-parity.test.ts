import { describe, expect, test } from "bun:test";
import { ASSISTANT_MODELS } from "../../src/config/assistant-models";
import {
  MODEL_INTELLIGENCE_TIER,
  INTELLIGENCE_RANK,
  intelligenceRankOf,
  modelAxesOf,
  DEFAULT_INTELLIGENCE_TIER,
  type IntelligenceTier,
} from "../../src/config/model-selection";
import { resolveCatalogModel } from "../../src/config/resolved-catalog";

const TIERS: IntelligenceTier[] = ["frontier", "strong", "mid", "small"];

describe("model-selection intelligence tiers (M152)", () => {
  test("every ASSISTANT_MODELS id has a tier in one of the four buckets", () => {
    for (const m of ASSISTANT_MODELS) {
      const tier = MODEL_INTELLIGENCE_TIER[m.id];
      expect(tier).toBeDefined();
      expect(TIERS).toContain(tier!);
    }
  });

  test("no orphan tier keys", () => {
    const ids = new Set(ASSISTANT_MODELS.map((m) => m.id));
    for (const key of Object.keys(MODEL_INTELLIGENCE_TIER)) {
      expect(ids.has(key)).toBe(true);
    }
  });

  test("INTELLIGENCE_RANK orders small<mid<strong<frontier", () => {
    expect(INTELLIGENCE_RANK.small).toBeLessThan(INTELLIGENCE_RANK.mid);
    expect(INTELLIGENCE_RANK.mid).toBeLessThan(INTELLIGENCE_RANK.strong);
    expect(INTELLIGENCE_RANK.strong).toBeLessThan(INTELLIGENCE_RANK.frontier);
  });

  test("intelligenceRankOf falls back to DEFAULT_INTELLIGENCE_TIER for unknown ids", () => {
    expect(intelligenceRankOf("unknown:model")).toBe(INTELLIGENCE_RANK[DEFAULT_INTELLIGENCE_TIER]);
  });

  test("resolved catalog intelligence supersedes the legacy static compatibility map", () => {
    const id = "openrouter:z-ai/glm-5.3";
    const resolved = resolveCatalogModel(id, { env: {} });

    expect(MODEL_INTELLIGENCE_TIER[id]).toBeUndefined();
    expect(resolved.intelligenceTier).toBe("strong");
    expect(modelAxesOf(id, resolved).smart).toBe(INTELLIGENCE_RANK.strong);
  });
});
