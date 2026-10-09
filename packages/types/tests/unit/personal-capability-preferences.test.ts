import { describe, expect, test } from "bun:test";
import {
  PERSONAL_CAPABILITY_ROLES,
  parsePersonalCapabilityPreferenceOverrides,
} from "../../src/personal-capability-preferences";

describe("personal capability preference contract", () => {
  test("contains only the accepted non-embedding research and decision roles", () => {
    expect(PERSONAL_CAPABILITY_ROLES).toEqual([
      "webSearchSynthesis",
      "deepResearchSupervisor",
      "deepResearchResearcher",
      "deepResearchSummarization",
      "deepResearchCompression",
      "deepResearchFinalReport",
      "decision",
    ]);
  });

  test("normalizes sparse overrides and rejects unknown or blank fields", () => {
    expect(parsePersonalCapabilityPreferenceOverrides({
      webSearchSynthesis: "  openrouter:model-a  ",
    })).toEqual({ webSearchSynthesis: "openrouter:model-a" });
    expect(parsePersonalCapabilityPreferenceOverrides({})).toEqual({});
    expect(parsePersonalCapabilityPreferenceOverrides({ embeddings: "openai:embedding" })).toBeNull();
    expect(parsePersonalCapabilityPreferenceOverrides({ decision: " " })).toBeNull();
    expect(parsePersonalCapabilityPreferenceOverrides([])).toBeNull();
  });
});
