import { ProviderCredentialApiError } from "@nautilo/api-client/browser";
import type { PersonalChatReadiness } from "../components/provider-setup-empty-state";

/** Reads current caller-scoped APIs; neither a server setup flag nor a saved secret is authority. */
export async function readPersonalChatReadiness(deps: {
  listCredentials: () => Promise<{
    allowPersonalProviderKeys?: boolean;
    credentials: readonly { provider?: string; requiresReplacement: boolean }[];
    providers?: readonly { id: string; personalCapabilities: readonly string[] }[];
  }>;
  getCallerModels: () => Promise<readonly { availability?: string }[]>;
}, options: { serverFallbackAvailable?: boolean } = {}): Promise<PersonalChatReadiness> {
  try {
    const { credentials, providers, allowPersonalProviderKeys } = await deps.listCredentials();
    if (allowPersonalProviderKeys === false) {
      return options.serverFallbackAvailable ? "ready" : "disabled";
    }
    const catalogProviders = providers?.length ? new Set(providers.map((provider) => provider.id)) : null;
    const chatProviders = catalogProviders && new Set((providers ?? [])
      .filter((provider) => provider.personalCapabilities.includes("chat"))
      .map((provider) => provider.id));
    const chatCredentials = chatProviders
      ? credentials.filter((credential) => credential.provider
        && (!catalogProviders?.has(credential.provider) || chatProviders.has(credential.provider)))
      : credentials;
    if (chatCredentials.some((credential) => credential.requiresReplacement)) {
      return "missing-key";
    }
    if (chatCredentials.length === 0) {
      return options.serverFallbackAvailable ? "ready" : "missing-key";
    }
    const models = await deps.getCallerModels();
    return models.some((model) => model.availability === "selectable")
      ? "ready"
      : "missing-model";
  } catch (error) {
    return error instanceof ProviderCredentialApiError
      && error.error === "personal_credentials_disabled"
      ? options.serverFallbackAvailable ? "ready" : "disabled"
      : "unavailable";
  }
}
