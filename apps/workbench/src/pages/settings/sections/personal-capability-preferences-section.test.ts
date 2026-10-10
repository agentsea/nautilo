import { describe, expect, test } from "bun:test";
import { nextPersonalCapabilityOverrides } from "./personal-capability-preferences-section";

describe("personal capability preference editing", () => {
  test("changes one role without copying inherited defaults", () => {
    expect(nextPersonalCapabilityOverrides(
      { decision: "typesafe:jev-1.13.0" },
      "webSearchSynthesis",
      "openrouter:model-a",
    )).toEqual({
      decision: "typesafe:jev-1.13.0",
      webSearchSynthesis: "openrouter:model-a",
    });
  });

  test("reset removes the explicit role instead of writing an effective default", () => {
    expect(nextPersonalCapabilityOverrides({
      decision: "typesafe:jev-1.13.0",
      webSearchSynthesis: "openrouter:model-a",
    }, "webSearchSynthesis", null)).toEqual({
      decision: "typesafe:jev-1.13.0",
    });
  });
});
