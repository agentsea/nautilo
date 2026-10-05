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
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";

export interface PersonalCredentialsData {
  readonly credentials: readonly CredentialMetadata[];
  readonly providers: readonly PersonalProviderCatalogEntry[];
}

export interface PersonalCredentialsDraft {
  readonly provider: string;
}

export interface PersonalAccountApi {
  listProviderCredentials(): Promise<{ credentials: CredentialMetadata[]; providers: PersonalProviderCatalogEntry[] }>;
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
  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    save(provider, apiKey, current) {
      const normalized = apiKey.trim();
      if (!normalized) return Promise.reject(new Error("Enter a provider API key."));
      data.setDraft({ provider });
      return mutate((api) => api.putProviderCredential(provider, {
        apiKey: normalized,
        ...(current ? { expectedRevision: current.revision } : {}),
      })).finally(() => data.clearDraft());
    },
    validate: (provider, current) => mutate((api) => api.validateProviderCredential(provider, { expectedRevision: current.revision })),
    remove: (provider, current) => mutate((api) => api.deleteProviderCredential(provider, { expectedRevision: current.revision })),
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
  const load = (scope: SettingsDataScope): Promise<PersonalCostsSummary> => apiForScope(scope).getPersonalCosts(range);
  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load(nextRange) {
      if (nextRange) range = nextRange;
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
    if (error.error === "credential_destination_unavailable") return "This provider destination is not configured on the server. Contact the Server operator.";
    if (error.error === "credential_destination_changed") return "The server's provider destination changed. Replace this key before using it again.";
    if (error.error === "credential_custody_unavailable") return "Your saved keys cannot be opened safely right now. Contact the Server operator.";
    if (error.error === "credential_reenrollment_required") return "This key must be replaced before it can be used again.";
    if (error.error === "personal_credentials_disabled") return "Personal keys are disabled on this server.";
    if (error.error === "personal_credentials_forbidden") return "You are not allowed to manage personal keys.";
  }
  const status = error !== null && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : null;
  if (status === 401) return "Your session ended. Sign in again.";
  if (status === 403) return "This server does not allow you to manage personal provider keys.";
  if (error instanceof Error && error.message) return error.message;
  return "This account information could not be loaded. Try again.";
}
