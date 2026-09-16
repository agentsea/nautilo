import {
  DEFAULT_VOICE_KEY,
  type AgentProfileFull,
  type AgentProfileMutation,
  type AgentProfileResponse,
  type AvatarRef,
} from "@nautilo/types";
import type {
  AvatarSelectionTarget,
  IpcResult,
  OnboardingAPI,
  OnboardingConfigFlags,
  OnboardingStartAt,
  ProfileSnapshot,
  ProfileWrite,
  SoulGenerationEvent,
} from "@nautilo/genie-customization-ui";
import { workbenchFetch } from "../lib/admission-fetch";
import { apiClient } from "../lib/api";
import { readSoulGenerationStream } from "./soul-stream";

const SESSION_ERROR = "Your session is no longer authorized. Sign in again to customize your Genie.";
const GENERIC_ERROR = "Couldn’t complete that step. Please try again.";
const PROFILE_ACCESS_ERROR = "Only the workspace owner can customize the Genie.";
const PARTIAL_PHOTO_SAVE_ERROR =
  "Your profile was saved, but the photo could not be changed. Refresh and try again.";

class SafeOnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeOnboardingError";
  }
}

export type WorkbenchOnboardingApiOptions = {
  getAccessToken: () => Promise<string | null>;
  /** Canonical ProfileProvider projection; this adapter never fetches /api/profile itself. */
  getCanonicalProfile: () => IpcResult<AgentProfileResponse | null>;
  startAt: OnboardingStartAt | null;
  onComplete: () => Promise<void> | void;
  onCancel: () => void;
};

export type WorkbenchOnboardingApi = {
  api: OnboardingAPI;
  dispose: () => void;
};

function safeError(error: unknown): string {
  if (error instanceof SafeOnboardingError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The request was cancelled.";
  }
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 401 || status === 403) return SESSION_ERROR;
  return GENERIC_ERROR;
}

async function asResult<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

function toSnapshot(profile: AgentProfileFull, avatarUrl: string | null): ProfileSnapshot {
  const language = profile.language === "es" ? "es" : "en";
  return {
    name: profile.name,
    language,
    workLifeMode: profile.workLifeMode,
    privacySpectrum: profile.privacySpectrum ?? 50,
    personalityPrompt: profile.personality.prompt,
    motherAnswer: profile.personality.motherAnswer,
    defaultVoice: profile.voices[DEFAULT_VOICE_KEY] ?? null,
    avatar: profile.avatar,
    avatarUrl,
    soulFile: profile.soulFile,
  };
}

function onboardingAvatarUrl(avatar: AvatarRef): string | null {
  return avatar.kind === "preset"
    ? `/api/onboarding/images/avatars/${encodeURIComponent(avatar.id)}.webp`
    : null;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `web-customize-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function profileMutation(input: ProfileWrite): AgentProfileMutation {
  return {
    name: input.name,
    language: input.language,
    workLifeMode: input.workLifeMode,
    privacySpectrum: input.privacySpectrum,
    personalityPrompt: input.personalityPrompt,
    motherAnswer: input.motherAnswer,
    soulFile: input.soulFile,
    onboardingCompleted: input.onboardingCompleted,
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
}

async function selectAvatar(target: AvatarSelectionTarget): Promise<void> {
  const current = await apiClient.getAgentPhotoLibraryCurrent();
  await apiClient.selectAgentPhotoLibraryEntry(
    { target, expectedSelectionRevision: current.scope.selectionRevision },
    { idempotencyKey: newIdempotencyKey(), origin: "workbench" },
  );
}

export function createWorkbenchOnboardingApi(
  options: WorkbenchOnboardingApiOptions,
): WorkbenchOnboardingApi {
  const soulHandlers = new Set<(event: SoulGenerationEvent) => void>();
  const controllers = new Set<AbortController>();
  const objectUrls = new Set<string>();

  const abortOperations = (): void => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const emitSoulEvent = (event: SoulGenerationEvent): void => {
    for (const handler of soulHandlers) handler(event);
  };
  const authorizationHeaders = async (): Promise<Record<string, string>> => {
    const token = await options.getAccessToken();
    if (!token) throw new Error(SESSION_ERROR);
    return { Authorization: `Bearer ${token}` };
  };

  const api: OnboardingAPI = {
    getServerUrl: () => Promise.resolve(window.location.origin),
    complete: async () => {
      abortOperations();
      await options.onComplete();
    },
    cancel: () => {
      abortOperations();
      options.onCancel();
      return Promise.resolve();
    },
    loadExistingProfile: () => {
      const profile = options.getCanonicalProfile();
      if (!profile.ok) return Promise.resolve(profile);
      const response = profile.data;
      if (response === null) return Promise.resolve({ ok: true, data: null });
      if (response.viewerRole !== "owner") {
        return Promise.resolve({ ok: false, error: PROFILE_ACCESS_ERROR });
      }
      return asResult(async () => {
        const staticUrl = onboardingAvatarUrl(response.agent.avatar);
        if (staticUrl) return toSnapshot(response.agent, staticUrl);
        const headers = await authorizationHeaders();
        const avatarResponse = await workbenchFetch("/api/profile/avatar", { headers });
        if (!avatarResponse.ok) return toSnapshot(response.agent, null);
        const blob = await avatarResponse.blob();
        if (blob.size === 0) return toSnapshot(response.agent, null);
        const avatarUrl = URL.createObjectURL(blob);
        objectUrls.add(avatarUrl);
        return toSnapshot(response.agent, avatarUrl);
      });
    },
    getConfigFlags: async () => {
      try {
        const response = await fetch("/api/config/setup-flags");
        if (!response.ok) return { ok: true, data: { avatarGenAvail: false, motherEasterEgg: false } };
        const payload: unknown = await response.json();
        const flags = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        return {
          ok: true,
          data: {
            avatarGenAvail: flags["avatarGenAvail"] === true,
            motherEasterEgg: flags["motherEasterEgg"] === true,
          } satisfies OnboardingConfigFlags,
        };
      } catch {
        return { ok: true, data: { avatarGenAvail: false, motherEasterEgg: false } };
      }
    },
    getStartAt: () => Promise.resolve(options.startAt),
    getVoices: () => asResult(async () => {
      const response = await apiClient.getVoiceCustomizationHydration();
      if (response.error) throw new Error(response.error);
      return {
        curated: response.curated.map((voice) => ({
          slug: voice.slug,
          voiceId: voice.voiceId,
          profileVoiceName: voice.label,
          soulLabel: voice.label,
          previewUrl: voice.previewUrl,
        })),
        voices: response.voices.map((voice) => ({ id: voice.voiceId, name: voice.name })),
        elevenLabsConfigured: response.elevenLabsConfigured,
      };
    }),
    previewVoice: (input) => asResult(async () => {
      const audio = await apiClient.previewVoice(input.voiceId, input.text ? { text: input.text } : undefined);
      const audioUrl = URL.createObjectURL(audio);
      objectUrls.add(audioUrl);
      return { audioUrl };
    }),
    listVoiceCatalog: (query) => asResult(() => apiClient.listVoiceCatalog(query)),
    generateSoul: (input) => asResult(async () => {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const headers = await authorizationHeaders();
        if (controller.signal.aborted) {
          throw new DOMException("Soul generation cancelled", "AbortError");
        }
        const response = await workbenchFetch("/api/profile/generate-soul/stream", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        return { soulFile: await readSoulGenerationStream(response, { onEvent: emitSoulEvent }) };
      } finally {
        controllers.delete(controller);
      }
    }),
    onSoulGenerationEvent: (handler) => {
      soulHandlers.add(handler);
      return () => soulHandlers.delete(handler);
    },
    generateAvatar: (input) => asResult(async () => {
      const created = await apiClient.generateAgentPhotoLibraryEntries(
        { prompt: input.prompt, count: 1 },
        { idempotencyKey: newIdempotencyKey(), origin: "workbench" },
      );
      const entry = created.entries[0];
      if (!entry) throw new Error("No generated avatar returned");
      const media = await apiClient.getAgentPhotoLibraryMedia(entry.id, "full");
      const avatarUrl = URL.createObjectURL(media.blob);
      objectUrls.add(avatarUrl);
      return { target: { kind: "entry", entryId: entry.id }, avatarUrl };
    }),
    putProfile: (input) => asResult(async () => {
      await apiClient.updateProfile(profileMutation(input));
      if (input.avatarTarget) {
        try {
          await selectAvatar(input.avatarTarget);
        } catch {
          throw new SafeOnboardingError(PARTIAL_PHOTO_SAVE_ERROR);
        }
      }
      // Voice is deliberately not persisted by this composite operation. The
      // shared Reveal flow validates synthesis first, then performs the
      // assignment as an independently classified optional step.
      return { ok: true };
    }),
    upsertVoiceAssignment: (language, ref) => asResult(() => apiClient.upsertVoiceAssignment(language, ref)),
  };

  return {
    api,
    dispose: () => {
      abortOperations();
      soulHandlers.clear();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
    },
  };
}
