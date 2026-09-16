import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import type { AgentProfileMutation, AgentProfileResponse } from "@nautilo/types";

import {
  isSelectableModel,
  modelDefaultDisplay,
  type ModelDefaultDisplay,
} from "./model-default-presentation";
import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";
import { isAgentProfileRequiredError, requireAgentProfile } from "./agent-profile-access";

export interface ModelDefaultData {
  readonly defaultModel: string | null;
  readonly models: readonly AssistantModelSummary[];
}

export interface ModelDefaultDraft {
  readonly modelId: string | null;
}

/** Deliberately narrow to the two canonical Agent-default endpoints. */
export interface ModelDefaultApi {
  getProfile(options?: { fresh?: boolean }): Promise<AgentProfileResponse>;
  getModels(query?: { includeUnavailable?: boolean }): Promise<AssistantModelSummary[]>;
  resolveRetainedModels(ids: readonly string[]): Promise<AssistantModelSummary[]>;
  updateProfile(data: Pick<AgentProfileMutation, "defaultModel">): Promise<AgentProfileResponse>;
}

export interface ModelDefaultController {
  readonly data: SettingsDataStateController<ModelDefaultData, ModelDefaultDraft>;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<ModelDefaultData>>;
  retry(): Promise<SettingsLoadResult<ModelDefaultData>>;
  apply(modelId: string): Promise<SettingsMutationResult<ModelDefaultData>>;
  reset(): Promise<SettingsMutationResult<ModelDefaultData>>;
}

export function modelDefaultErrorMessage(error: unknown): string {
  if (isAgentProfileRequiredError(error)) return "This signed-in account does not have an Agent profile on this server.";
  const status = statusOf(error);
  if (status === 401) return "Your session has expired. Sign in again before changing your Agent default.";
  if (status === 403) return "This server no longer allows you to change your Agent default.";
  if (status === 400) return "That model is no longer accepted by this server. Refresh the catalogue and choose an available model.";
  return error instanceof Error && error.message
    ? error.message
    : "Could not save your Agent default. Your current default was not changed.";
}

/**
 * Keeps the profile and eligible catalogue as one canonical Settings read.
 * It intentionally has no Room-override or server/admin-model methods: those
 * routes describe a different scope and cannot substitute for an Agent default.
 */
export function createModelDefaultController(
  apiForScope: (scope: SettingsDataScope) => ModelDefaultApi,
): ModelDefaultController {
  const data = createSettingsDataState<ModelDefaultData, ModelDefaultDraft>();
  const load = async (scope: SettingsDataScope): Promise<ModelDefaultData> => {
    const api = apiForScope(scope);
    const profile = await api.getProfile({ fresh: true });
    const agent = requireAgentProfile(profile);
    const [models, retained] = await Promise.all([
      api.getModels(),
      agent.defaultModel
        ? api.resolveRetainedModels([agent.defaultModel])
        : Promise.resolve([]),
    ]);
    const byId = new Map(models.map((model) => [model.id, model]));
    for (const model of retained) byId.set(model.id, model);
    return { defaultModel: agent.defaultModel, models: Array.from(byId.values()) };
  };
  const mutate = (modelId: string | null): Promise<SettingsMutationResult<ModelDefaultData>> =>
    data.mutate(
      async (scope) => {
        await apiForScope(scope).updateProfile({ defaultModel: modelId });
      },
      load,
    );

  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    async apply(modelId) {
      const current = data.getState().data;
      const model = current?.models.find((candidate) => candidate.id === modelId);
      if (!current || !model || !isSelectableModel(model)) {
        return Promise.reject(Object.assign(new Error("Unavailable models cannot be saved as your Agent default."), { status: 400 }));
      }
      if (data.getState().mutating || current.defaultModel === modelId) return { status: "ignored" };
      data.setDraft({ modelId });
      const result = await mutate(modelId);
      // Immediate radio selection is not a retry form. On failure the server's
      // prior canonical default remains selected; the error stays available.
      data.clearDraft();
      return result;
    },
    async reset() {
      const result = await mutate(null);
      if (result.status === "applied") data.clearDraft();
      return result;
    },
  };
}

/** The route uses this for a truthful current-value disclosure. */
export function currentModelDefault(data: ModelDefaultData | null): ModelDefaultDisplay | null {
  return data ? modelDefaultDisplay(data.defaultModel, data.models) : null;
}

function statusOf(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}
