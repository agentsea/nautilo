import type { PersonalProviderId } from "@nautilo/db";

export type PersonalProviderValidationResult = Readonly<{
  status: "accepted" | "rejected" | "unavailable" | "unverified";
}>;

type ProviderValidationRequest = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

const PROVIDER_VALIDATION_TIMEOUT_MS = 5_000;

function bearer(apiKey: string): Readonly<Record<string, string>> {
  return { Authorization: `Bearer ${apiKey}` };
}

function validationRequest(
  provider: PersonalProviderId,
  apiKey: string,
): ProviderValidationRequest | null {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/models",
        headers: bearer(apiKey),
      };
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/key",
        headers: bearer(apiKey),
      };
    case "google":
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        headers: { "x-goog-api-key": apiKey },
      };
    case "xai":
      return {
        url: "https://api.x.ai/v1/models",
        headers: bearer(apiKey),
      };
    case "venice":
      return {
        url: "https://api.venice.ai/api/v1/api_keys/rate_limits",
        headers: bearer(apiKey),
      };
    case "fireworks":
    case "together":
      // Their documented inference APIs do not expose a credential-only,
      // account-independent check that establishes authentication without a
      // paid request or extra caller-supplied account identity.
      return null;
  }
}

/**
 * Checks one submitted personal key against a fixed, read-only provider API.
 * The result deliberately carries no provider response body or error detail.
 */
export async function validatePersonalProviderCredential(
  provider: PersonalProviderId,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PersonalProviderValidationResult> {
  const request = validationRequest(provider, apiKey);
  if (!request) return { status: "unverified" };

  const timeoutSignal = AbortSignal.timeout(PROVIDER_VALIDATION_TIMEOUT_MS);
  const boundedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "error",
      signal: boundedSignal,
    });
    if (response.ok) return { status: "accepted" };
    if (response.status === 401 || (provider === "google" && response.status === 400)) {
      return { status: "rejected" };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
