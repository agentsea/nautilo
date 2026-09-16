import { describe, expect, test } from "bun:test";
import { prepareOnboardingHydration } from "../src/App";
import type { OnboardingAPI } from "../src/types";

function apiForHydration(overrides: Partial<OnboardingAPI> = {}): OnboardingAPI {
  return {
    getServerUrl: async () => "http://localhost:3000",
    complete: async () => {},
    cancel: async () => {},
    loadExistingProfile: async () => ({ ok: true, data: null }),
    getConfigFlags: async () => ({ ok: true, data: { avatarGenAvail: true, motherEasterEgg: false } }),
    getStartAt: async () => null,
    getVoices: async () => ({ ok: true, data: { curated: [], voices: [], elevenLabsConfigured: false } }),
    previewVoice: async () => ({ ok: false, error: "" }),
    listVoiceCatalog: async () => ({ ok: true, data: { voices: [], languageGroups: [], page: 0, pageSize: 0, hasMore: false, totalCount: 0, elevenLabsConfigured: false, cachedAt: null } }),
    generateSoul: async () => ({ ok: false, error: "" }),
    generateAvatar: async () => ({ ok: false, error: "" }),
    putProfile: async () => ({ ok: true, data: { ok: true } }),
    upsertVoiceAssignment: async () => ({ ok: true, data: { voices: {} } }),
    ...overrides,
  };
}

describe("Genie customization hydration", () => {
  test("fails closed when profile hydration fails instead of preparing default state", async () => {
    const result = await prepareOnboardingHydration(apiForHydration({
      loadExistingProfile: async () => ({ ok: false, error: "Sign in again" }),
    }));

    expect(result).toEqual({ ok: false, error: "Sign in again" });
    expect(result.ok).toBe(false);
  });

  test("still treats a successful null profile as the only first-customization state", async () => {
    expect(await prepareOnboardingHydration(apiForHydration())).toMatchObject({
      ok: true,
      profile: null,
    });
  });
});
