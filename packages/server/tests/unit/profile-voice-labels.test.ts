import { describe, expect, test } from "bun:test";

import { canonicalizeProfileVoices } from "../../src/routes/profile";

describe("profile voice label projection", () => {
  test("preserves the empty voice-map contract for legacy or minimal profiles", () => {
    expect(canonicalizeProfileVoices(undefined)).toEqual({});
  });

  test("replaces stale provider aliases for curated voice ids", () => {
    expect(canonicalizeProfileVoices({
      default: {
        voiceId: "JSWO6cw2AyFE324d5kEr",
        voiceName: "stale provider alias",
      },
      es: {
        voiceId: "custom-voice",
        voiceName: "Mi voz",
      },
    })).toEqual({
      default: {
        voiceId: "JSWO6cw2AyFE324d5kEr",
        voiceName: "Carolyn",
      },
      es: {
        voiceId: "custom-voice",
        voiceName: "Mi voz",
      },
    });
  });
});
