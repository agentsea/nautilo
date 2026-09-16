import { describe, expect, test } from "bun:test";
import {
  assertProfileDefaultModelAllowed,
  isSupportedRoutedModelId,
  normalizeProfileDefaultModel,
} from "../../src/config/model-id-validation";

describe("normalizeProfileDefaultModel", () => {
  test("trims and maps empty to null", () => {
    expect(normalizeProfileDefaultModel("  ")).toBe(null);
    expect(normalizeProfileDefaultModel("")).toBe(null);
    expect(normalizeProfileDefaultModel(null)).toBe(null);
    expect(normalizeProfileDefaultModel(undefined)).toBe(null);
  });

  test("preserves non-empty ids", () => {
    expect(normalizeProfileDefaultModel("  openrouter:z-ai/glm-5.1  ")).toBe("openrouter:z-ai/glm-5.1");
  });
});

describe("assertProfileDefaultModelAllowed", () => {
  const catalog = new Set(["anthropic:claude-sonnet-4-6"]);

  test("allows null", () => {
    expect(() => assertProfileDefaultModelAllowed(null, catalog)).not.toThrow();
  });

  test("allows catalog ids", () => {
    expect(() => assertProfileDefaultModelAllowed("anthropic:claude-sonnet-4-6", catalog)).not.toThrow();
  });

  test("rejects routed ids outside the signed catalog", () => {
    expect(() => assertProfileDefaultModelAllowed("openrouter:z-ai/glm-5.1", catalog)).toThrow(
      /active signed catalog/,
    );
    expect(() => assertProfileDefaultModelAllowed("venice:zai-org-glm-5-1", catalog)).toThrow(
      /active signed catalog/,
    );
  });

  test("rejects unknown prefixes", () => {
    expect(() => assertProfileDefaultModelAllowed("z-ai/glm-5.1", catalog)).toThrow(/Invalid defaultModel/);
  });
});

describe("isSupportedRoutedModelId", () => {
  test("matches known prefixes case-insensitively", () => {
    expect(isSupportedRoutedModelId("OpenRouter:z-ai/glm-5.1")).toBe(true);
    expect(isSupportedRoutedModelId("not-a-prefix:foo")).toBe(false);
  });
});
