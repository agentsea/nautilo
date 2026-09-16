import { describe, expect, test } from "bun:test";
import {
  codexCapabilityModelId,
  createCodexModelOutputContract,
  parseCodexModelOutputContract,
} from "../../src/codex/model-output-contract";

describe("Codex model output contract", () => {
  test("binds an exact Codex API model to its signed Nautilo catalogue limits", () => {
    const contract = createCodexModelOutputContract("gpt-5.6-sol", {
      modelId: "openai:gpt-5.6-sol",
      catalogVersion: "2026-08-27",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(contract).toEqual({
      version: 1,
      capabilityModelId: "openai:gpt-5.6-sol",
      catalogVersion: "2026-08-27",
      contextTokens: 1_000_000,
      outputTokens: 128_000,
    });
    expect(parseCodexModelOutputContract(contract)).toEqual(contract);
  });

  test("rejects fuzzy provider mappings and incomplete capability facts", () => {
    expect(() => codexCapabilityModelId("openrouter:openai/gpt-5.6-sol")).toThrow();
    expect(() => createCodexModelOutputContract("gpt-5.6-sol", {
      modelId: "openrouter:openai/gpt-5.6-sol",
      catalogVersion: "2026-08-27",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    })).toThrow();
    expect(parseCodexModelOutputContract({
      version: 1,
      capabilityModelId: "openai:gpt-5.6-sol",
      catalogVersion: "2026-08-27",
      contextTokens: 100,
      outputTokens: 101,
    })).toBeNull();
  });
});
