import { ProviderCredentialApiError } from "@nautilo/api-client/browser";
import type { PersonalChatReadiness } from "../components/provider-setup-empty-state";

/** Reads current caller-scoped APIs; neither a server setup flag nor a saved secret is authority. */
export async function readPersonalChatReadiness(deps: {
  listCredentials: () => Promise<{ credentials: readonly { requiresReplacement: boolean }[] }>;
  getCallerModels: () => Promise<readonly { availability?: string }[]>;
}, options: { serverFallbackAvailable?: boolean } = {}): Promise<PersonalChatReadiness> {
  try {
    const { credentials } = await deps.listCredentials();
    if (credentials.some((credential) => credential.requiresReplacement)) {
      return "missing-key";
    }
    if (credentials.length === 0) {
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
