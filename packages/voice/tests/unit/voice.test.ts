import { describe, expect, test } from "bun:test";
import { AVAILABLE_VOICES, ELEVENLABS_CURATED_VOICE_IDS, curatedVoiceDisplayNameForId } from "../../src/index";

describe("curated voice identities", () => {
  test("keeps saved voice IDs and canonical display names independent of synthesis", () => {
    expect(ELEVENLABS_CURATED_VOICE_IDS["jessica"]).toBe("cgSgspJ2msm6clMCkdW9");
    expect(curatedVoiceDisplayNameForId("JSWO6cw2AyFE324d5kEr")).toBe("Carolyn");
    expect(curatedVoiceDisplayNameForId("not-curated")).toBeNull();
    expect(AVAILABLE_VOICES).toEqual(Object.keys(ELEVENLABS_CURATED_VOICE_IDS));
  });
});
