import { describe, expect, test } from "bun:test";
import {
  usableNewVoiceSelection,
  voicePersistenceIntent,
  voiceProfileWriteFields,
  wizardReducerForTests,
  type WizardState,
} from "../src/hooks/useWizardState";
import { canUseVoiceProvider, voiceViewStateForCatalog } from "../src/screens/VoiceScreen";
import { DEFAULT_VIEWER_STATE, type ProfileSnapshot, type VoiceSelection } from "../src/types";

const VOICE: VoiceSelection = {
  slug: "atlas",
  profileVoiceName: "Atlas",
  voiceId: "voice-atlas",
  soulLabel: "Atlas",
};

const EXISTING_PROFILE: ProfileSnapshot = {
  name: "Aster",
  language: "en",
  workLifeMode: "both",
  privacySpectrum: 50,
  personalityPrompt: "clear and kind",
  motherAnswer: null,
  defaultVoice: { voiceId: VOICE.voiceId, voiceName: VOICE.profileVoiceName },
  avatar: null,
  avatarUrl: null,
  soulFile: "existing soul",
};

function baseState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    screen: 9,
    viewer: { ...DEFAULT_VIEWER_STATE },
    hydratedSnapshot: null,
    flags: { avatarGenAvail: false, motherEasterEgg: false },
    language: "en",
    privacySlider: 50,
    workLifeChoice: null,
    personalityPrompt: "",
    motherAnswer: "",
    compilingPhase: "done",
    compilingGeneration: 1,
    soulFile: "soul",
    avatarSource: null,
    avatarChoice: null,
    avatarRef: null,
    avatarTarget: null,
    name: "Genie",
    voiceSelection: null,
    voiceSkipped: false,
    voiceCapability: "unknown",
    errors: {},
    ...overrides,
  };
}

function hydratedExistingState(): WizardState {
  return wizardReducerForTests(baseState(), {
    type: "HYDRATE",
    profile: EXISTING_PROFILE,
    flags: { avatarGenAvail: false, motherEasterEgg: false },
  });
}

describe("D510 optional voice", () => {
  test("no-key hydration is unconfigured and a first customization skips without a usable voice", () => {
    const noKeyCatalog = {
      loading: false,
      curated: [],
      error: null,
      elevenLabsConfigured: false,
    };
    expect(voiceViewStateForCatalog(noKeyCatalog)).toBe("unconfigured");
    expect(canUseVoiceProvider(noKeyCatalog)).toBe(false);

    const unavailable = wizardReducerForTests(baseState(), {
      type: "SET_VOICE_CAPABILITY",
      capability: "unconfigured",
    });
    const skipped = wizardReducerForTests(unavailable, { type: "SKIP_VOICE" });

    expect(voicePersistenceIntent(skipped)).toBe("skip");
    expect(voiceProfileWriteFields(skipped)).toEqual({ voiceName: null, voiceId: null });
    expect(usableNewVoiceSelection(skipped)).toBeNull();
  });

  test("runtime provider failure preserves the selected voice but makes it unusable until retry", () => {
    const selected = wizardReducerForTests(baseState(), {
      type: "SET_VOICE",
      selection: VOICE,
    });
    const failed = wizardReducerForTests(selected, {
      type: "SET_VOICE_CAPABILITY",
      capability: "runtime-unavailable",
    });

    expect(failed.voiceSelection).toEqual(VOICE);
    expect(usableNewVoiceSelection(failed)).toBeNull();
    expect(
      voiceViewStateForCatalog({
        loading: false,
        curated: [],
        error: "sanitized",
        elevenLabsConfigured: true,
      }),
    ).toBe("runtime-unavailable");

    const recovered = wizardReducerForTests(failed, {
      type: "SET_VOICE_CAPABILITY",
      capability: "configured",
    });
    expect(usableNewVoiceSelection(recovered)).toEqual(VOICE);
  });

  test("an existing voice is retained on unrelated re-customization and never rewritten", () => {
    const retained = wizardReducerForTests(hydratedExistingState(), {
      type: "SET_VOICE_CAPABILITY",
      capability: "configured",
    });

    expect(voicePersistenceIntent(retained)).toBe("retain");
    expect(voiceProfileWriteFields(retained)).toEqual({ voiceName: null, voiceId: null });
    expect(usableNewVoiceSelection(retained)).toBeNull();
  });

  test("skipping an existing voice retains it and survives Voice → Reveal → Back", () => {
    const skipped = wizardReducerForTests(hydratedExistingState(), { type: "SKIP_VOICE" });
    const reveal = wizardReducerForTests(skipped, { type: "NEXT" });
    const returned = wizardReducerForTests(reveal, { type: "BACK" });

    expect(voicePersistenceIntent(skipped)).toBe("retain");
    expect(returned.screen).toBe(9);
    expect(returned.voiceSkipped).toBe(true);
    expect(returned.voiceSelection).toBeNull();
  });

  test("a configured new voice is the only path that writes and greets", () => {
    const selected = wizardReducerForTests(baseState(), {
      type: "SET_VOICE",
      selection: VOICE,
    });
    const configured = wizardReducerForTests(selected, {
      type: "SET_VOICE_CAPABILITY",
      capability: "configured",
    });

    expect(voicePersistenceIntent(configured)).toBe("replace");
    expect(usableNewVoiceSelection(configured)).toEqual(VOICE);
    expect(voiceProfileWriteFields(configured)).toEqual({
      voiceName: "Atlas",
      voiceId: "voice-atlas",
    });

    const skipped = wizardReducerForTests(configured, { type: "SKIP_VOICE" });
    expect(usableNewVoiceSelection(skipped)).toBeNull();
  });
});
