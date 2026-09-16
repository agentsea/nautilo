import type {
  AgentAvatarUploadInput,
  AgentPhotoLibraryFence,
} from "@nautilo/api-client/browser";
import type {
  AgentPhotoLibraryCreateResponse,
  AgentPhotoLibraryCurrentResponse,
  AgentPhotoLibrarySelectionResponse,
} from "@nautilo/types";
import type { AgentProfileFull, AgentProfileMutation, AgentProfileResponse } from "@nautilo/types";

import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
} from "./settings-data-state";
import { isAgentProfileRequiredError, requireAgentProfile } from "./agent-profile-access";

export type AgentProfileDraft = { name: string; handle: string; soulFile: string };

export type AgentProfileApi = {
  getProfile(options?: { fresh?: boolean }): Promise<AgentProfileResponse>;
  updateProfile(data: AgentProfileMutation): Promise<AgentProfileResponse>;
  updateAgentHandle(handle: string): Promise<{ handle: string }>;
  getAgentPhotoLibraryCurrent(): Promise<AgentPhotoLibraryCurrentResponse>;
  uploadAgentPhotoLibraryEntry(
    file: AgentAvatarUploadInput,
    options: { idempotencyKey: string; origin: "mobile"; fence: AgentPhotoLibraryFence },
  ): Promise<AgentPhotoLibraryCreateResponse>;
  selectAgentPhotoLibraryEntry(
    input: { target: { kind: "entry"; entryId: string } | { kind: "preset"; presetId: string }; expectedSelectionRevision: string },
    options: { idempotencyKey: string; origin: "mobile"; fence: AgentPhotoLibraryFence },
  ): Promise<AgentPhotoLibrarySelectionResponse>;
  generateSoul(input: Record<string, unknown>): Promise<{ soulFile: string }>;
};

export type AgentProfileMutationOutcome =
  | { status: "applied" }
  | { status: "partial"; message: string }
  | { status: "failed"; message: string }
  | { status: "ignored" };

export interface AgentProfileController {
  readonly data: SettingsDataStateController<AgentProfileFull, AgentProfileDraft>;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<AgentProfileFull>>;
  save(draft: AgentProfileDraft): Promise<AgentProfileMutationOutcome>;
  uploadAvatar(file: AgentAvatarUploadInput): Promise<AgentProfileMutationOutcome>;
  selectPreset(id: string): Promise<AgentProfileMutationOutcome>;
  generateSoul(): Promise<AgentProfileMutationOutcome>;
}

export function profileDraft(profile: AgentProfileFull): AgentProfileDraft {
  return { name: profile.name, handle: profile.handle, soulFile: profile.soulFile ?? "" };
}

export function agentProfileErrorMessage(error: unknown, action: "save" | "handle" | "avatar" | "soul" = "save"): string {
  if (isAgentProfileRequiredError(error)) return "This signed-in account does not have an Agent profile on this server.";
  const status = statusOf(error);
  if (status === 409 && action === "handle") return "That handle is already in use. Choose a different handle and save again.";
  if (status === 409) return "Your Agent profile changed on the server. Review the refreshed profile and try again.";
  if (status === 400 && action === "handle") return "Use a valid handle without @. Check the format and try again.";
  if (status === 400 && action === "avatar") return "This image was not accepted. Choose a PNG, JPEG, or WebP image under 5 MiB.";
  if (status === 413 && action === "avatar") return "This image is too large. Choose an image smaller than 5 MiB.";
  if (status === 401) return "Your session has expired. Sign in again before changing your Agent.";
  if (action === "soul") return "Could not generate Soul instructions. Your current instructions were not replaced.";
  return error instanceof Error && error.message ? error.message : "Could not save your Agent profile.";
}

/**
 * A self-profile coordinator over the shared Settings ownership fence. Every
 * successful write is followed by a canonical GET; a staged name/Soul +
 * handle save also reloads after a handle failure so the UI never guesses
 * which first-stage fields reached the server.
 */
export function createAgentProfileController(
  apiForScope: (scope: SettingsDataScope) => AgentProfileApi,
  randomUuid: () => string,
): AgentProfileController {
  const data = createSettingsDataState<AgentProfileFull, AgentProfileDraft>();
  let activeScope: SettingsDataScope | null = null;
  let photoRequestGeneration = 0;
  const currentPhotoGeneration = (): number => photoRequestGeneration;
  const loadProfile = async (scope: SettingsDataScope): Promise<AgentProfileFull> => {
    const response = await apiForScope(scope).getProfile({ fresh: true });
    return requireAgentProfile(response);
  };
  const mutate = async (
    action: (api: AgentProfileApi) => Promise<void>,
    kind: "save" | "handle" | "avatar" | "soul",
  ): Promise<AgentProfileMutationOutcome> => {
    const result = await data.mutate(async (scope) => action(apiForScope(scope)), loadProfile);
    if (result.status === "applied") return { status: "applied" };
    if (result.status === "ignored") return { status: "ignored" };
    return { status: "failed", message: agentProfileErrorMessage(result.error, kind) };
  };

  return {
    data,
    setScope: (scope) => {
      if (!sameScope(activeScope, scope)) photoRequestGeneration += 1;
      activeScope = scope;
      data.setScope(scope);
    },
    load: () => data.load(loadProfile),

    async save(draft) {
      const current = data.getState().data;
      if (!current) return { status: "ignored" };
      let profileStageCompleted = false;
      const result = await data.mutate(async (scope) => {
        const api = apiForScope(scope);
        const profilePatch: AgentProfileMutation = {};
        if (draft.name.trim() !== current.name) profilePatch.name = draft.name.trim();
        if (draft.soulFile !== (current.soulFile ?? "")) profilePatch.soulFile = draft.soulFile;
        if (Object.keys(profilePatch).length > 0) {
          await api.updateProfile(profilePatch);
          profileStageCompleted = true;
        }
        if (draft.handle.trim().replace(/^@/, "") !== current.handle) {
          await api.updateAgentHandle(draft.handle.trim().replace(/^@/, ""));
        }
      }, loadProfile);
      if (result.status === "applied") {
        data.clearDraft();
        return { status: "applied" };
      }
      if (result.status === "ignored") return { status: "ignored" };
      if (profileStageCompleted) {
        const refreshed = await data.retryLoad(loadProfile);
        if (refreshed.status === "applied") {
          return { status: "partial", message: `${agentProfileErrorMessage(result.error, "handle")} Name and Soul instructions were saved; the handle was not.` };
        }
      }
      return { status: "failed", message: agentProfileErrorMessage(result.error, profileStageCompleted ? "handle" : "save") };
    },

    uploadAvatar: (file) => mutate(async (api) => {
      const requestGeneration = photoRequestGeneration;
      const before = await api.getAgentPhotoLibraryCurrent();
      const upload = await api.uploadAgentPhotoLibraryEntry(file, {
        idempotencyKey: randomUuid(),
        origin: "mobile",
        fence: photoFence(before, requestGeneration, currentPhotoGeneration),
      });
      const entryId = upload.entryIds[0];
      if (!entryId) throw new Error("Nautilo did not return the uploaded photo.");
      await api.selectAgentPhotoLibraryEntry({
        target: { kind: "entry", entryId },
        expectedSelectionRevision: upload.scope.selectionRevision,
      }, {
        idempotencyKey: randomUuid(),
        origin: "mobile",
        fence: photoFence(
          { current: { ...before.current, scope: upload.scope }, scope: upload.scope },
          requestGeneration,
          currentPhotoGeneration,
        ),
      });
    }, "avatar"),
    selectPreset: (id) => mutate(async (api) => {
      const requestGeneration = photoRequestGeneration;
      const before = await api.getAgentPhotoLibraryCurrent();
      await api.selectAgentPhotoLibraryEntry({
        target: { kind: "preset", presetId: id },
        expectedSelectionRevision: before.scope.selectionRevision,
      }, {
        idempotencyKey: randomUuid(),
        origin: "mobile",
        fence: photoFence(before, requestGeneration, currentPhotoGeneration),
      });
    }, "avatar"),
    generateSoul: () => mutate((api) => api.generateSoul({}).then(() => undefined), "soul"),
  };
}

function photoFence(
  response: AgentPhotoLibraryCurrentResponse,
  requestGeneration: number,
  getCurrentGeneration: () => number,
): AgentPhotoLibraryFence {
  return {
    serverInstanceId: response.scope.serverInstanceId,
    viewerUserId: response.scope.viewerUserId,
    agentId: response.scope.agentId,
    selectionRevision: response.scope.selectionRevision,
    libraryRevision: response.scope.libraryRevision,
    requestGeneration,
    getCurrentGeneration,
  };
}

function sameScope(left: SettingsDataScope | null, right: SettingsDataScope | null): boolean {
  return left?.serverId === right?.serverId
    && left?.userId === right?.userId
    && left?.actorId === right?.actorId;
}

function statusOf(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}
