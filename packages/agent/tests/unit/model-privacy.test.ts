import { describe, expect, test } from "bun:test";
import { ASSISTANT_MODELS } from "../../src/config/assistant-models";
import {
  DEFAULT_PRIVACY_GRADE,
  MODEL_PRIVACY_GRADE,
  privacyGradeOf,
} from "../../src/config/model-privacy";

describe("model-privacy", () => {
  test("every ASSISTANT_MODELS id has a privacy grade in [1,10]", () => {
    for (const m of ASSISTANT_MODELS) {
      const grade = MODEL_PRIVACY_GRADE[m.id];
      expect(grade).toBeDefined();
      expect(Number.isInteger(grade)).toBe(true);
      expect(grade).toBeGreaterThanOrEqual(1);
      expect(grade).toBeLessThanOrEqual(10);
    }
  });

  test("privacyGradeOf falls back to DEFAULT_PRIVACY_GRADE for unknown ids", () => {
    expect(privacyGradeOf("unknown:model")).toBe(DEFAULT_PRIVACY_GRADE);
    expect(DEFAULT_PRIVACY_GRADE).toBe(1);
  });

  test("anchor grades", () => {
    expect(privacyGradeOf("anthropic:claude-sonnet-4-6")).toBe(1);
    expect(privacyGradeOf("openai:gpt-5.5-2026-04-23")).toBe(1);
    expect(privacyGradeOf("google:gemini-2.5-pro")).toBe(1);
    expect(privacyGradeOf("venice:e2ee-deepseek-v4-flash")).toBe(10);
  });

  test("every hyperscaler first-party id (anthropic:/openai:/google: prefix) is graded 1", () => {
    const hyperscalerPrefixes = ["anthropic:", "openai:", "google:"] as const;
    for (const m of ASSISTANT_MODELS) {
      if (hyperscalerPrefixes.some((prefix) => m.id.startsWith(prefix))) {
        expect(privacyGradeOf(m.id)).toBe(1);
      }
    }
  });

  test("no orphan grade keys", () => {
    const assistantIds = new Set(ASSISTANT_MODELS.map((m) => m.id));
    for (const key of Object.keys(MODEL_PRIVACY_GRADE)) {
      expect(assistantIds.has(key)).toBe(true);
    }
  });
});
