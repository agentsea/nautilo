import { describe, expect, mock, test } from "bun:test";
import {
  persistRevealProfile,
  VOICE_ASSIGNMENT_UNVERIFIED_NOTICE,
  VOICE_NOT_CHANGED_NOTICE,
} from "../src/screens/reveal-persistence";
import type { OnboardingAPI, ProfileWrite, VoiceSelection } from "../src/types";

const profile: ProfileWrite = {
  name: "Genie",
  language: "en",
  workLifeMode: null,
  privacySpectrum: 50,
  personalityPrompt: null,
  motherAnswer: null,
  voiceId: "stale-voice",
  voiceName: "Stale Voice",
  avatarUrl: null,
  soulFile: "# Soul",
  onboardingCompleted: true,
};

const replacement: VoiceSelection = {
  slug: "atlas",
  voiceId: "voice-atlas",
  profileVoiceName: "Atlas",
  soulLabel: "Atlas",
};

function apiForReveal(overrides: Partial<OnboardingAPI> = {}): OnboardingAPI {
  return {
    getServerUrl: async () => "",
    complete: async () => {},
    cancel: async () => {},
    loadExistingProfile: async () => ({ ok: true, data: null }),
    getConfigFlags: async () => ({ ok: true, data: { avatarGenAvail: false, motherEasterEgg: false } }),
    getStartAt: async () => null,
    getVoices: async () => ({ ok: true, data: { curated: [], voices: [], elevenLabsConfigured: false } }),
    previewVoice: mock(async () => ({ ok: true as const, data: { audioUrl: "blob:preview" } })),
    listVoiceCatalog: async () => ({ ok: true, data: { voices: [], languageGroups: [], page: 0, pageSize: 0, hasMore: false, totalCount: 0, elevenLabsConfigured: false, cachedAt: null } }),
    generateSoul: async () => ({ ok: true, data: { soulFile: "" } }),
    generateAvatar: async () => ({ ok: true, data: { target: { kind: "entry", entryId: "id" }, avatarUrl: "" } }),
    putProfile: mock(async () => ({ ok: true as const, data: { ok: true as const } })),
    upsertVoiceAssignment: mock(async () => ({ ok: true as const, data: { voices: {} } })),
    ...overrides,
  };
}

describe("Reveal voice persistence", () => {
  test("saves non-voice fields before previewing and only assigns after a successful preview", async () => {
    const api = apiForReveal();

    expect(await persistRevealProfile(api, profile, replacement)).toEqual({
      ok: true,
      voice: "assigned",
      notice: null,
      greetingAudioUrl: "blob:preview",
    });
    expect(api.putProfile).toHaveBeenCalledWith(expect.objectContaining({ voiceId: null, voiceName: null }));
    expect(api.previewVoice).toHaveBeenCalledWith({ voiceId: "voice-atlas", displayName: "Genie" });
    expect(api.upsertVoiceAssignment).toHaveBeenCalledWith("default", {
      voiceId: "voice-atlas",
      voiceName: "Atlas",
    });
  });

  test("keeps the existing assignment and leaves completion reachable when preview fails", async () => {
    const api = apiForReveal({
      previewVoice: mock(async () => ({ ok: false as const, error: "provider unavailable" })),
    });

    expect(await persistRevealProfile(api, profile, replacement)).toEqual({
      ok: true,
      voice: "unchanged",
      notice: VOICE_NOT_CHANGED_NOTICE,
      greetingAudioUrl: null,
    });
    expect(api.putProfile).toHaveBeenCalledTimes(1);
    expect(api.upsertVoiceAssignment).not.toHaveBeenCalled();
  });

  test("marks a voice assignment as unverified when its response fails after a successful preview", async () => {
    const api = apiForReveal({
      upsertVoiceAssignment: mock(async () => ({ ok: false as const, error: "assignment unavailable" })),
    });

    expect(await persistRevealProfile(api, profile, replacement)).toEqual({
      ok: true,
      voice: "unverified",
      notice: VOICE_ASSIGNMENT_UNVERIFIED_NOTICE,
      greetingAudioUrl: null,
    });
    expect(api.previewVoice).toHaveBeenCalledTimes(1);
    expect(api.upsertVoiceAssignment).toHaveBeenCalledTimes(1);
  });

  test("does not call the provider or assignment for a retained or skipped voice", async () => {
    const api = apiForReveal();

    expect(await persistRevealProfile(api, profile, null)).toEqual({
      ok: true,
      voice: "unchanged",
      notice: null,
      greetingAudioUrl: null,
    });
    expect(api.previewVoice).not.toHaveBeenCalled();
    expect(api.upsertVoiceAssignment).not.toHaveBeenCalled();
  });
});
