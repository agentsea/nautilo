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
      "imageGeneration",
      "videoGeneration",
      "musicGeneration",
      "speech",
    ]);
  });

  test("normalizes sparse overrides and rejects unknown or blank fields", () => {
    expect(parsePersonalCapabilityPreferenceOverrides({
      webSearchSynthesis: "  openrouter:model-a  ",
      speech: "elevenlabs:eleven_v3",
    })).toEqual({ webSearchSynthesis: "openrouter:model-a", speech: "elevenlabs:eleven_v3" });
    expect(parsePersonalCapabilityPreferenceOverrides({})).toEqual({});
    expect(parsePersonalCapabilityPreferenceOverrides({ embeddings: "openai:embedding" })).toBeNull();
    expect(parsePersonalCapabilityPreferenceOverrides({ decision: " " })).toBeNull();
    expect(parsePersonalCapabilityPreferenceOverrides([])).toBeNull();
  });
});
