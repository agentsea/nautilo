import type {
  CredentialMetadata,
  PersonalCostsRangeKey,
  PersonalCostsSummary,
  PersonalProviderCatalogEntry,
  ProviderCredentialRevisionInput,
  PutProviderCredentialInput,
} from "@nautilo/api-client/browser";
import { ProviderCredentialApiError } from "@nautilo/api-client/browser";

import {
  createSettingsDataState,
  sameSettingsDataScope,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";

export interface PersonalCredentialsData {
  readonly allowPersonalProviderKeys?: boolean;
  readonly credentials: readonly CredentialMetadata[];
  readonly providers: readonly PersonalProviderCatalogEntry[];
}

export interface PersonalCredentialsDraft {
  readonly provider: string;
}

export interface PersonalAccountApi {
  listProviderCredentials(): Promise<{ allowPersonalProviderKeys?: boolean; credentials: CredentialMetadata[]; providers: PersonalProviderCatalogEntry[] }>;
  putProviderCredential(provider: string, input: PutProviderCredentialInput): Promise<unknown>;
  validateProviderCredential(provider: string, input: ProviderCredentialRevisionInput): Promise<unknown>;
  deleteProviderCredential(provider: string, input: ProviderCredentialRevisionInput): Promise<unknown>;
  getPersonalCosts(range: PersonalCostsRangeKey): Promise<PersonalCostsSummary>;
}

export interface PersonalCredentialsController {
  readonly data: SettingsDataStateController<PersonalCredentialsData, PersonalCredentialsDraft>;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<PersonalCredentialsData>>;
  retry(): Promise<SettingsLoadResult<PersonalCredentialsData>>;
  save(provider: string, apiKey: string, current?: CredentialMetadata): Promise<SettingsMutationResult<PersonalCredentialsData>>;
  validate(provider: string, current: CredentialMetadata): Promise<SettingsMutationResult<PersonalCredentialsData>>;
  remove(provider: string, current: CredentialMetadata): Promise<SettingsMutationResult<PersonalCredentialsData>>;
}

export function createPersonalCredentialsController(
  apiForScope: (scope: SettingsDataScope) => PersonalAccountApi,
): PersonalCredentialsController {
  const data = createSettingsDataState<PersonalCredentialsData, PersonalCredentialsDraft>();
  const load = async (scope: SettingsDataScope): Promise<PersonalCredentialsData> =>
    apiForScope(scope).listProviderCredentials();
  const mutate = (action: (api: PersonalAccountApi) => Promise<unknown>) => data.mutate(
    async (scope) => { await action(apiForScope(scope)); },
    load,
  );
  const readyData = (): PersonalCredentialsData | null => {
    const state = data.getState();
    return state.data && !state.loading && !state.loadError && !state.mutating
      ? state.data
      : null;
  };
  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    save(provider, apiKey, current) {
      const currentData = readyData();
      if (!currentData || currentData.allowPersonalProviderKeys === false) {
        return Promise.resolve({ status: "ignored" });
      }
      const normalized = apiKey.trim();
      if (!normalized) return Promise.reject(new Error("Enter a provider API key."));
      data.setDraft({ provider });
      return mutate((api) => api.putProviderCredential(provider, {
        apiKey: normalized,
        ...(current ? { expectedRevision: current.revision } : {}),
      })).finally(() => data.clearDraft());
    },
    validate(provider, current) {
      const currentData = readyData();
      if (!currentData || currentData.allowPersonalProviderKeys === false) {
        return Promise.resolve({ status: "ignored" });
      }
      return mutate((api) => api.validateProviderCredential(provider, { expectedRevision: current.revision }));
    },
    remove(provider, current) {
      if (!readyData()) return Promise.resolve({ status: "ignored" });
      return mutate((api) => api.deleteProviderCredential(provider, { expectedRevision: current.revision }))
        .then(async (result) => {
          if (
            result.status !== "failed"
            || !(result.error instanceof ProviderCredentialApiError)
            || (result.error.repair !== "reread_metadata" && result.error.error !== "credential_not_found")
          ) {
            return result;
          }
          const refreshed = await data.load(load);
          return refreshed.status === "ignored" ? refreshed : result;
        });
    },
  };
}

export interface PersonalCostsController {
  readonly data: SettingsDataStateController<PersonalCostsSummary, { range: PersonalCostsRangeKey }>;
  setScope(scope: SettingsDataScope | null): void;
  load(range?: PersonalCostsRangeKey): Promise<SettingsLoadResult<PersonalCostsSummary>>;
  retry(): Promise<SettingsLoadResult<PersonalCostsSummary>>;
  setRange(range: PersonalCostsRangeKey): Promise<SettingsLoadResult<PersonalCostsSummary>>;
}

export function createPersonalCostsController(
  apiForScope: (scope: SettingsDataScope) => Pick<PersonalAccountApi, "getPersonalCosts">,
): PersonalCostsController {
  const data = createSettingsDataState<PersonalCostsSummary, { range: PersonalCostsRangeKey }>();
  let range: PersonalCostsRangeKey = "30d";
  let scope: SettingsDataScope | null = null;
  const load = (scope: SettingsDataScope): Promise<PersonalCostsSummary> => apiForScope(scope).getPersonalCosts(range);
  return {
    data,
    setScope(nextScope) {
      if (!sameSettingsDataScope(scope, nextScope)) range = "30d";
      scope = nextScope;
      data.setScope(nextScope);
    },
    load(nextRange) {
      if (nextRange) {
        range = nextRange;
        data.setDraft({ range });
      }
      return data.load(load);
    },
    retry: () => data.retryLoad(load),
    setRange(nextRange) {
      range = nextRange;
      data.setDraft({ range });
      return data.load(load);
    },
  };
}

export function personalAccountErrorMessage(error: unknown): string {
  if (error instanceof ProviderCredentialApiError) {
    switch (error.error) {
      case "authentication_required": return "Your session ended. Sign in again.";
      case "personal_credentials_forbidden": return "You are not allowed to manage personal keys.";
      case "personal_credentials_disabled": return "Personal API keys are disabled on this server.";
      case "personal_credentials_unavailable": return "Personal API keys are temporarily unavailable. Try again.";
      case "credential_custody_unavailable": return "Your saved keys cannot be opened safely right now. Contact the Server operator.";
      case "credential_reenrollment_required": return "This key must be replaced before it can be used again.";
      case "invalid_provider": return "This provider does not support personal API keys.";
      case "invalid_credential_request": return "This key request is invalid. Reload these settings and try again.";
      case "credential_conflict": return "This key changed elsewhere. Try again after current key details have loaded.";
      case "credential_not_found": return "This key no longer exists.";
      case "credential_destination_unavailable": return "This provider destination is not configured on the server. Contact the Server operator.";
      case "credential_destination_changed": return "The server's provider destination changed. Replace this key before using it again.";
    }
  }
  const status = error !== null && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : null;
  if (status === 401) return "Your session ended. Sign in again.";
  if (status === 403) return "This server does not allow you to manage personal provider keys.";
  if (error instanceof ProviderCredentialApiError) return "This provider key request could not be completed. Try again.";
  if (error instanceof Error && error.message) return error.message;
  return "This account information could not be loaded. Try again.";
}

export type PersonalCredentialLoadKind = "disabled" | "forbidden" | "signedOut" | "error";

export function personalCredentialLoadKind(error: unknown): PersonalCredentialLoadKind {
  if (error instanceof ProviderCredentialApiError) {
    if (error.error === "personal_credentials_disabled") return "disabled";
    if (error.error === "personal_credentials_forbidden") return "forbidden";
    if (error.status === 401) return "signedOut";
  }
  const status = error !== null && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : null;
  if (status === 401) return "signedOut";
  if (status === 403) return "forbidden";
  return "error";
}
