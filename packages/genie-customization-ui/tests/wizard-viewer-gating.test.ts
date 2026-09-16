import { describe, expect, test } from "bun:test";
import {
  nextReachableForTests,
  shouldVisitGenieSubstep,
  shouldVisitOwnerScreen,
  wizardReducerForTests,
} from "../src/hooks/useWizardState";
import { shouldStartSoulGenerationAtReveal } from "../src/screens/RevealScreen";
import type { WizardState } from "../src/hooks/useWizardState";
import { DEFAULT_VIEWER_STATE } from "../src/types";

function baseState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    screen: 0,
    viewer: { ...DEFAULT_VIEWER_STATE },
    hydratedSnapshot: null,
    flags: { avatarGenAvail: false, motherEasterEgg: false },
    language: "en",
    privacySlider: 50,
    workLifeChoice: null,
    personalityPrompt: "",
    motherAnswer: "",
    compilingPhase: "idle",
    compilingGeneration: 0,
    soulFile: null,
    avatarSource: null,
    avatarChoice: null,
    avatarRef: null,
    avatarTarget: null,
    name: "",
    voiceSelection: null,
    voiceSkipped: false,
    voiceCapability: "unknown",
    errors: {},
    ...overrides,
  };
}

describe("wizard viewer gating", () => {
  test("fresh viewer skips the old English/Spanish language picker", () => {
    const state = baseState();
    expect(nextReachableForTests(state, 1)).toBe(2);
  });

  test("fresh viewer skips owner setup because it belongs to invite/admin setup surfaces", () => {
    const state = baseState();
    expect(shouldVisitOwnerScreen(state)).toBe(false);
  });

  test("fresh viewer advances from Work/Life directly to Personality", () => {
    const state = baseState({
      screen: 3,
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: false },
    });
    expect(nextReachableForTests(state, 4)).toBe(5);
  });

  test("pin-enrolled viewer skips owner screen", () => {
    const state = baseState({
      viewer: {
        ...DEFAULT_VIEWER_STATE,
        displayNameSet: true,
        pinEnrolled: true,
        recoveryCodesAcknowledged: true,
      },
    });
    expect(shouldVisitOwnerScreen(state)).toBe(false);
  });

  test("genie customized skips genie substeps unless re-customizing", () => {
    const customized = baseState({
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: true },
    });
    expect(shouldVisitGenieSubstep(customized)).toBe(false);

    const recustomize = baseState({
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: true },
      hydratedSnapshot: baseState({ name: "Genie" }),
    });
    expect(shouldVisitGenieSubstep(recustomize)).toBe(true);
  });

  test("uncustomized genie shows genie substeps", () => {
    const state = baseState({
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: false },
    });
    expect(shouldVisitGenieSubstep(state)).toBe(true);
  });

  test("material edits invalidate the old soul and compile after the name step", () => {
    const state = baseState({
      screen: 5,
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: false },
      personalityPrompt: "warm",
      compilingPhase: "done",
      compilingGeneration: 2,
      soulFile: "old generated soul",
    });

    const next = wizardReducerForTests(state, {
      type: "SET_PERSONALITY",
      value: "warm and direct",
    });

    expect(next.compilingPhase).toBe("idle");
    expect(next.compilingGeneration).toBe(3);
    expect(next.soulFile).toBeNull();
    expect(nextReachableForTests(next, 6)).toBe(6);
    expect(nextReachableForTests(next, 7)).toBe(7);
  });

  test("name is collected before compile so ordinary final save does not regenerate", () => {
    const beforeName = baseState({
      screen: 6,
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: false },
      personalityPrompt: "warm",
    });

    const renamed = wizardReducerForTests(beforeName, {
      type: "SET_NAME",
      value: "Nova",
    });

    expect(renamed.compilingPhase).toBe("idle");
    expect(renamed.compilingGeneration).toBe(1);
    expect(renamed.soulFile).toBeNull();
    expect(nextReachableForTests(renamed, 7)).toBe(7);

    const started = wizardReducerForTests(renamed, { type: "START_COMPILE" });
    const generated = wizardReducerForTests(started, {
      type: "FINISH_COMPILE",
      generation: started.compilingGeneration,
      soulFile: "Nova soul",
    });
    expect(generated.compilingPhase).toBe("done");
    expect(generated.soulFile).toBe("Nova soul");
    expect(shouldStartSoulGenerationAtReveal(generated)).toBe(false);
  });

  test("unchanged recustomize profile skips compile and keeps existing soul", () => {
    const snapshot = baseState({
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: true },
      personalityPrompt: "warm",
      soulFile: "existing soul",
    });
    const state = baseState({
      screen: 5,
      viewer: { ...DEFAULT_VIEWER_STATE, genieCustomized: true },
      hydratedSnapshot: snapshot,
      personalityPrompt: "warm",
      compilingPhase: "done",
      soulFile: "existing soul",
    });

    expect(nextReachableForTests(state, 7)).toBe(8);
  });
});
