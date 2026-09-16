import { describe, expect, test } from "bun:test";
import { catalogVoiceToSelection } from "../src/screens/VoiceScreen";

describe("catalog voice selection", () => {
  test("uses the catalog voice identity instead of retaining the hydrated voice", () => {
    const selection = catalogVoiceToSelection({
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
      source: "provider",
    });

    expect(selection).toMatchObject({
      voiceId: "yoojin-voice-id",
      profileVoiceName: "Yoojin Kim - Bright, Clear & Friendly",
      soulLabel: "Yoojin Kim - Bright, Clear & Friendly",
    });
    expect(selection.voiceId).not.toBe("JSWO6cw2AyFE324d5kEr");
  });
});
