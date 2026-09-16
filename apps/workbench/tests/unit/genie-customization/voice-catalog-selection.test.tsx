import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React, { useReducer } from "react";
import { reapplyHappyDomGlobals } from "../../bun-dom-preload";
import {
  wizardReducerForTests,
  type WizardState,
} from "../../../../../packages/genie-customization-ui/src/hooks/useWizardState";
import { VoiceScreen } from "../../../../../packages/genie-customization-ui/src/screens/VoiceScreen";
import type { OnboardingAPI } from "../../../../../packages/genie-customization-ui/src/types";

const CAROLYN = {
  slug: "carolyn",
  voiceId: "JSWO6cw2AyFE324d5kEr",
  profileVoiceName: "Carolyn",
  soulLabel: "Carolyn",
};

const YOOJIN = {
  voiceId: "yoojin-voice-id",
  name: "Yoojin Kim - Bright, Clear & Friendly",
  accent: "standard",
  gender: "female",
  age: "young",
  descriptive: "crisp",
  category: "professional",
  language: "ko",
  locale: "ko-KR",
  languageLabel: "Korean",
  previewUrl: "https://example.com/yoojin.mp3",
  verifiedLanguages: [],
  source: "provider" as const,
};

function initialState(): WizardState {
  const snapshot: WizardState = {
    screen: 9,
    viewer: { firstRunComplete: true, genieCustomized: true, groups: ["owners"] },
    hydratedSnapshot: null,
    flags: { avatarGenAvail: true, motherEasterEgg: false },
    language: "en",
    privacySlider: 50,
    workLifeChoice: "both",
    personalityPrompt: "",
    motherAnswer: "",
    compilingPhase: "done",
    compilingGeneration: 1,
    soulFile: "soul",
    avatarSource: "preset",
    avatarChoice: "/avatar.webp",
    avatarRef: null,
    avatarTarget: null,
    name: "Genie",
    voiceSelection: CAROLYN,
    voiceSkipped: false,
    voiceCapability: "configured",
    errors: {},
  };
  return { ...snapshot, hydratedSnapshot: snapshot };
}

const api = {
  getVoices: mock(async () => ({
    ok: true as const,
    data: {
      curated: [CAROLYN],
      voices: [],
      elevenLabsConfigured: true,
    },
  })),
  listVoiceCatalog: mock(async () => ({
    ok: true as const,
    data: {
      voices: [YOOJIN],
      languageGroups: [],
      page: 0,
      pageSize: 30,
      hasMore: false,
      totalCount: 1,
      elevenLabsConfigured: true,
      cachedAt: null,
    },
  })),
} as unknown as OnboardingAPI;

function Harness(): React.ReactElement {
  const [state, dispatch] = useReducer(wizardReducerForTests, undefined, initialState);
  return (
    <>
      <VoiceScreen state={state} dispatch={dispatch} api={api} serverUrl="http://localhost:4801" />
      <output aria-label="Active voice">{state.voiceSelection?.profileVoiceName}</output>
    </>
  );
}

afterEach(() => cleanup());

describe("catalog voice selection", () => {
  test("replaces a hydrated curated voice before the catalog closes", async () => {
    reapplyHappyDomGlobals();
    const view = render(<Harness />);

    const pickSomethingElse = await waitFor(() =>
      view.getByRole("button", { name: "Pick something else" }),
    );
    fireEvent.click(pickSomethingElse);
    fireEvent.click(view.getByRole("button", { name: "Browse more voices and languages" }));

    await waitFor(() => expect(view.getByText(YOOJIN.name)).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Use" }));

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
      expect(view.getByLabelText("Active voice").textContent).toBe(YOOJIN.name);
      expect(view.getByText("Selected from the full catalog")).toBeTruthy();
    });
    expect(view.getByRole("radio", { name: "Carolyn ▶" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});
