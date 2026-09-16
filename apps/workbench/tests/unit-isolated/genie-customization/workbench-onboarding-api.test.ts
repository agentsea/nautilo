import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentProfileResponse } from "@nautilo/types";

const profileWrite = {
  name: "Genie",
  language: "en" as const,
  workLifeMode: null,
  privacySpectrum: 50,
  personalityPrompt: null,
  motherAnswer: null,
  avatarUrl: null,
  soulFile: null,
  onboardingCompleted: true as const,
};

const PROFILE_RESPONSE: AgentProfileResponse = {
  viewerRole: "owner",
  agent: {
    name: "Genie",
    language: "en",
    workLifeMode: null,
    privacySpectrum: 50,
    personality: { prompt: null, motherAnswer: null },
    voices: {},
    avatar: { kind: "preset", id: "avatar-01" },
    soulFile: null,
    onboardingCompleted: false,
  },
};

const apiClient = {
  getVoiceCustomizationHydration: mock(async () => ({
    curated: [{ slug: "calm", label: "Calm", voiceId: "voice-1", language: "en", description: "Warm", previewUrl: "/voice.mp3" }],
    voices: [],
    elevenLabsConfigured: true,
    cachedAt: null,
  })),
  previewVoice: mock(async () => new Blob(["audio"], { type: "audio/mpeg" })),
  listVoiceCatalog: mock(async () => ({ voices: [], languageGroups: [], page: 0, pageSize: 10, hasMore: false, totalCount: 0, elevenLabsConfigured: true, cachedAt: null })),
  generateAgentPhotoLibraryEntries: mock(async () => ({ entries: [{ id: "photo-1" }] })),
  getAgentPhotoLibraryMedia: mock(async () => ({ blob: new Blob(["image"], { type: "image/png" }) })),
  updateProfile: mock(async () => ({})),
  getAgentPhotoLibraryCurrent: mock(async () => ({ scope: { selectionRevision: "r1" } })),
  selectAgentPhotoLibraryEntry: mock(async () => ({})),
  upsertVoiceAssignment: mock(async () => ({ voices: {} })),
};

mock.module("../../../src/lib/api", () => ({ apiClient }));
const { createWorkbenchOnboardingApi } = await import("../../../src/genie-customization/workbench-onboarding-api");

const originalFetch = globalThis.fetch;

function adapterOptions(overrides: Partial<Parameters<typeof createWorkbenchOnboardingApi>[0]> = {}) {
  return {
    getAccessToken: async () => "token",
    getCanonicalProfile: () => ({ ok: true as const, data: PROFILE_RESPONSE }),
    startAt: null,
    onComplete: () => {},
    onCancel: () => {},
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const operation of Object.values(apiClient)) operation.mockClear();
});

describe("Workbench onboarding adapter", () => {
  test("hydrates safe voice data and relays the browser soul stream", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("setup-flags")) {
        return new Response(JSON.stringify({ avatarGenAvail: true, motherEasterEgg: false }));
      }
      return new Response('event: soul.started\ndata: {}\n\nevent: soul.completed\ndata: {"soulFile":"# Genie"}\n\n');
    }) as typeof fetch;
    const adapter = createWorkbenchOnboardingApi(adapterOptions({ startAt: "personality" }));
    const events: string[] = [];
    const unsubscribe = adapter.api.onSoulGenerationEvent?.((event) => events.push(event.type));

    await expect(adapter.api.getVoices()).resolves.toEqual({
      ok: true,
      data: {
        curated: [{ slug: "calm", voiceId: "voice-1", profileVoiceName: "Calm", soulLabel: "Calm", previewUrl: "/voice.mp3" }],
        voices: [],
        elevenLabsConfigured: true,
      },
    });
    await expect(adapter.api.generateSoul({ language: "en" })).resolves.toEqual({
      ok: true,
      data: { soulFile: "# Genie" },
    });
    expect(events).toEqual(["started", "completed"]);
    unsubscribe?.();
    adapter.dispose();
  });

  test("normalizes unauthorized hydration and aborts an in-flight generation on dispose", async () => {
    apiClient.getVoiceCustomizationHydration.mockRejectedValueOnce({ status: 401 });
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let streamSignal: AbortSignal | undefined;
    const fetchStub = mock((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      streamSignal = init?.signal ?? undefined;
      started();
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    }));
    globalThis.fetch = fetchStub as typeof fetch;
    const adapter = createWorkbenchOnboardingApi(adapterOptions());

    await expect(adapter.api.getVoices()).resolves.toEqual({
      ok: false,
      error: "Your session is no longer authorized. Sign in again to customize your Genie.",
    });
    const generation = adapter.api.generateSoul({ language: "en" });
    await fetchStarted;
    adapter.dispose();
    await expect(generation).resolves.toEqual({ ok: false, error: "The request was cancelled." });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(streamSignal?.aborted).toBe(true);
  });

  test("hydrates an existing incomplete profile and leaves voice assignment to Reveal", async () => {
    const adapter = createWorkbenchOnboardingApi(adapterOptions());

    await expect(adapter.api.loadExistingProfile()).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        name: "Genie",
        avatar: { kind: "preset", id: "avatar-01" },
        avatarUrl: "/api/onboarding/images/avatars/avatar-01.webp",
        soulFile: null,
      }),
    });

    await expect(adapter.api.putProfile({
      ...profileWrite,
      voiceId: "voice-replacement",
      voiceName: "Replacement",
    })).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(apiClient.upsertVoiceAssignment).toHaveBeenCalledTimes(0);

    apiClient.upsertVoiceAssignment.mockClear();
    await expect(adapter.api.putProfile({
      ...profileWrite,
      voiceId: null,
      voiceName: null,
    })).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(apiClient.upsertVoiceAssignment).toHaveBeenCalledTimes(0);
    adapter.dispose();
  });

  test("rejects a public profile projection instead of treating it as a blank profile", async () => {
    const adapter = createWorkbenchOnboardingApi(adapterOptions({
      getCanonicalProfile: () => ({
        ok: true,
        data: { ...PROFILE_RESPONSE, viewerRole: "public" },
      }),
    }));

    await expect(adapter.api.loadExistingProfile()).resolves.toEqual({
      ok: false,
      error: "Only the workspace owner can customize the Genie.",
    });
    adapter.dispose();
  });

  test("honors a canonical no-profile result without issuing a second profile request", async () => {
    const adapter = createWorkbenchOnboardingApi(adapterOptions({
      getCanonicalProfile: () => ({ ok: true, data: null }),
    }));

    await expect(adapter.api.loadExistingProfile()).resolves.toEqual({ ok: true, data: null });
    adapter.dispose();
  });

  test("returns allowlisted refresh guidance after a photo failure following a saved profile", async () => {
    apiClient.selectAgentPhotoLibraryEntry.mockRejectedValueOnce(new Error("provider detail"));
    const adapter = createWorkbenchOnboardingApi(adapterOptions());

    await expect(adapter.api.putProfile({
      ...profileWrite,
      avatarTarget: { kind: "entry", entryId: "photo-1" },
      voiceId: null,
      voiceName: null,
    })).resolves.toEqual({
      ok: false,
      error: "Your profile was saved, but the photo could not be changed. Refresh and try again.",
    });
    expect(apiClient.updateProfile).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});
