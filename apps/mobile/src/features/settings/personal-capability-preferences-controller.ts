import type {
  PersonalCapabilityPreferencesResponse,
  PersonalCapabilityRole,
  ReplacePersonalCapabilityPreferencesRequest,
} from "@nautilo/api-client/browser";
import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";

export interface PersonalCapabilityPreferencesApi {
  getPersonalCapabilityPreferences(): Promise<PersonalCapabilityPreferencesResponse>;
  replacePersonalCapabilityPreferences(
    input: ReplacePersonalCapabilityPreferencesRequest,
  ): Promise<PersonalCapabilityPreferencesResponse>;
}

export interface PersonalCapabilityPreferenceDraft {
  readonly role: PersonalCapabilityRole;
  readonly modelId: string | null;
}

export interface PersonalCapabilityPreferencesController {
  readonly data: SettingsDataStateController<
    PersonalCapabilityPreferencesResponse,
    PersonalCapabilityPreferenceDraft
  >;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<PersonalCapabilityPreferencesResponse>>;
  retry(): Promise<SettingsLoadResult<PersonalCapabilityPreferencesResponse>>;
  apply(
    role: PersonalCapabilityRole,
    modelId: string | null,
  ): Promise<SettingsMutationResult<PersonalCapabilityPreferencesResponse>>;
}

function statusOf(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

export function personalCapabilityPreferenceErrorMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 401) return "Your session expired. Sign in again before changing capability models.";
  if (status === 409) return "These preferences changed elsewhere. The current server choices were reloaded.";
  if (status === 422) return "That model is no longer compatible with this capability. Reload and choose another model.";
  return error instanceof Error && error.message
    ? error.message
    : "Capability model preferences could not be saved.";
}

export function createPersonalCapabilityPreferencesController(
  apiForScope: (scope: SettingsDataScope) => PersonalCapabilityPreferencesApi,
): PersonalCapabilityPreferencesController {
  const data = createSettingsDataState<
    PersonalCapabilityPreferencesResponse,
    PersonalCapabilityPreferenceDraft
  >();
  const load = (scope: SettingsDataScope) =>
    apiForScope(scope).getPersonalCapabilityPreferences();

  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    async apply(role, modelId) {
      const current = data.getState().data;
      if (!current || data.getState().mutating) return { status: "ignored" };
      if (modelId !== null
        && !current.capabilities.find((entry) => entry.role === role)
          ?.options.some((option) => option.modelId === modelId)) {
        return Promise.reject(Object.assign(new Error("This model is not offered for the selected capability."), { status: 422 }));
      }
      const overrides = { ...current.overrides };
      if (modelId === null) delete overrides[role];
      else overrides[role] = modelId;
      data.setDraft({ role, modelId });
      const result = await data.mutate(
        async (scope) => {
          await apiForScope(scope).replacePersonalCapabilityPreferences({
            expectedRevision: current.revision,
            overrides,
          });
        },
        load,
      );
      if (result.status === "applied") data.clearDraft();
      if (result.status === "failed" && statusOf(result.error) === 409) {
        await data.retryLoad(load);
      }
      return result;
    },
  };
}
