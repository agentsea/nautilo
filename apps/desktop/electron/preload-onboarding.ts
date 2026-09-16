/**
 * D091 — preload for the onboarding wizard window.
 *
 * Kept separate from `preload.ts` (the main workbench's broader
 * fs / workspace / relay surface) and `preload-first-run.ts` (the
 * narrow probe / commit / cancel set). The wizard's own surface
 * grew across Phase 1 → Phase 2 from 3 lifecycle channels to a
 * complete API-proxy set covering every server endpoint the
 * wizard touches: hydration, key validation, owner enrollment,
 * voice catalog + previews, soul + avatar generation, and final
 * profile write.
 *
 * Every API-proxy channel returns `IpcResult<T>` so transport /
 * HTTP errors surface uniformly as `{ ok: false, error }` —
 * renderer code never has to unwrap a thrown rejection. Main-side
 * handlers do the proxy + auth-header threading + error
 * normalization in one place.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
// Desktop's Node-only tsc program intentionally has no JSX support, while
// the package barrel also exports its React App. This type-only import is
// erased from the preload bundle and keeps Electron free of React runtime.
import type {
  AvatarGenerationEvent,
  AvatarSelectionTarget,
  CatalogResponse,
  IpcResult,
  OnboardingAPI,
  OnboardingConfigFlags,
  OnboardingStartAt,
  ProfileSnapshot,
  SoulGenerationEvent,
  VoiceSelection,
} from "@nautilo/genie-customization-ui/types";

const api: OnboardingAPI = {
  // Lifecycle
  getServerUrl: () =>
    ipcRenderer.invoke("onboarding:get-server-url") as Promise<string>,
  complete: () => ipcRenderer.invoke("onboarding:complete") as Promise<void>,
  cancel: () => ipcRenderer.invoke("onboarding:cancel") as Promise<void>,

  // Hydration
  loadExistingProfile: () =>
    ipcRenderer.invoke("onboarding:load-existing-profile") as Promise<
      IpcResult<ProfileSnapshot | null>
    >,
  getConfigFlags: () =>
    ipcRenderer.invoke("onboarding:get-config-flags") as Promise<
      IpcResult<OnboardingConfigFlags>
    >,
  getStartAt: () =>
    ipcRenderer.invoke("onboarding:get-start-at") as Promise<OnboardingStartAt | null>,

  // API proxy
  getVoices: () =>
    ipcRenderer.invoke("onboarding:get-voices") as Promise<
      IpcResult<{
        curated: VoiceSelection[];
        voices: Array<{ id: string; name: string }>;
        elevenLabsConfigured: boolean;
      }>
    >,
  previewVoice: (input) =>
    ipcRenderer.invoke("onboarding:preview-voice", input) as Promise<
      IpcResult<{ audioUrl: string }>
    >,
  listVoiceCatalog: (query) =>
    ipcRenderer.invoke("onboarding:list-voice-catalog", query) as Promise<
      IpcResult<CatalogResponse>
    >,
  generateSoul: (input) =>
    ipcRenderer.invoke("onboarding:generate-soul", input) as Promise<
      IpcResult<{ soulFile: string }>
    >,
  onSoulGenerationEvent: (handler) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      handler(payload as SoulGenerationEvent);
    };
    ipcRenderer.on("onboarding:soul-generation-event", listener);
    return () => ipcRenderer.off("onboarding:soul-generation-event", listener);
  },
  generateAvatar: (input) =>
    ipcRenderer.invoke("onboarding:generate-avatar", input) as Promise<
      IpcResult<{ target: AvatarSelectionTarget; avatarUrl: string }>
    >,
  onAvatarGenerationEvent: (handler) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      handler(payload as AvatarGenerationEvent);
    };
    ipcRenderer.on("onboarding:avatar-generation-event", listener);
    return () => ipcRenderer.off("onboarding:avatar-generation-event", listener);
  },
  putProfile: (input) =>
    ipcRenderer.invoke("onboarding:put-profile", input) as Promise<
      IpcResult<{ ok: true }>
    >,
  upsertVoiceAssignment: (language, ref) =>
    ipcRenderer.invoke("onboarding:upsert-voice", { language, ref }) as Promise<
      IpcResult<{ voices: Record<string, { voiceId: string; voiceName: string }> }>
    >,
};

contextBridge.exposeInMainWorld("nautiloOnboarding", api);
