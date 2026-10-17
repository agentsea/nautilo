import { describe, expect, test } from "bun:test";
import {
  PERSONAL_CAPABILITY_ROLES,
  parsePersonalCapabilityPreferenceOverrides,
} from "../../src/personal-capability-preferences";

describe("personal capability preference contract", () => {
  test("contains only the accepted non-embedding capability roles", () => {
    expect(PERSONAL_CAPABILITY_ROLES).toEqual([
      "webSearchSynthesis",
      "deepResearchSupervisor",
      "deepResearchResearcher",
      "deepResearchSummarization",
      "deepResearchCompression",
      "deepResearchFinalReport",
      "decision",
      "imageUnderstanding",
      "imageGeneration",
      "videoGeneration",
      "musicGeneration",
      "speech",
      "memoryReview",
      "memoryReflection",
      "memorySummarization",
    ]);
  });

  test("normalizes sparse overrides and rejects unknown or blank fields", () => {
    expect(parsePersonalCapabilityPreferenceOverrides({
      webSearchSynthesis: "  openrouter:model-a  ",
      imageUnderstanding: "  anthropic:claude-sonnet-4-6  ",
      speech: "elevenlabs:eleven_v3",
      memoryReview: "openrouter:review-model",
    })).toEqual({
      webSearchSynthesis: "openrouter:model-a",
      imageUnderstanding: "anthropic:claude-sonnet-4-6",
      speech: "elevenlabs:eleven_v3",
      memoryReview: "openrouter:review-model",
    });
    expect(parsePersonalCapabilityPreferenceOverrides({})).toEqual({});
    expect(parsePersonalCapabilityPreferenceOverrides({ embeddings: "openai:embedding" })).toBeNull();
    expect(parsePersonalCapabilityPreferenceOverrides({ decision: " " })).toBeNull();
    expect(parsePersonalCapabilityPreferenceOverrides([])).toBeNull();
  });
});
