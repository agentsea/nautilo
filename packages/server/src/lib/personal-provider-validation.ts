import type { PersonalProviderId } from "@nautilo/db";

export type PersonalProviderValidationResult = Readonly<{
  status: "accepted" | "rejected" | "unavailable" | "unverified";
  receiptReadStatus?: "available" | "unavailable" | "unknown";
}>;

type ProviderValidationRequest = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

const PROVIDER_VALIDATION_TIMEOUT_MS = 10_000;

// Look for Google's documented ErrorInfo reason without retaining or logging
// an untrusted provider response body. The request timeout also bounds reading.
async function hasGoogleInvalidKeyReason(response: Response): Promise<boolean> {
  if (!response.body) return false;
  const field = '"reason"';
  const value = '"API_KEY_INVALID"';
  const reader = response.body.getReader();
  let phase: "field" | "colon" | "value-start" | "value" = "field";
  let matched = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      for (const byte of chunk.value as Uint8Array) {
        const char = String.fromCharCode(byte);
        if (phase === "field") {
          matched = char === field[matched] ? matched + 1 : char === field[0] ? 1 : 0;
          if (matched === field.length) {
            phase = "colon";
            matched = 0;
          }
        } else if (phase === "colon") {
          if (char === ":") phase = "value-start";
          else if (!/\s/.test(char)) phase = "field";
        } else if (phase === "value-start") {
          if (char === value[0]) {
            phase = "value";
            matched = 1;
          } else if (!/\s/.test(char)) phase = "field";
        } else {
          matched = char === value[matched] ? matched + 1 : 0;
          if (matched === value.length) return true;
          if (matched === 0) phase = "field";
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function bearer(apiKey: string): Readonly<Record<string, string>> {
  return { Authorization: `Bearer ${apiKey}` };
}

function validationRequest(
  provider: PersonalProviderId,
  apiKey: string,
  destination?: string | null,
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
    case "surplus":
      return {
        url: "https://api.surplusintelligence.ai/v1/buyer/me",
        headers: bearer(apiKey),
      };
    case "gateway":
      return destination
        ? {
            url: `${destination}/models`,
            headers: bearer(apiKey),
          }
        : null;
    case "fireworks":
    case "together":
      // Their documented inference APIs do not expose a credential-only,
      // account-independent check that establishes authentication without a
      // paid request or extra caller-supplied account identity.
      return null;
    default:
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
  destination?: string | null,
): Promise<PersonalProviderValidationResult> {
  const request = validationRequest(provider, apiKey, destination);
  if (!request) return { status: "unverified", receiptReadStatus: "unknown" };

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
    if (response.ok) {
      void response.body?.cancel().catch(() => {});
      if (provider !== "surplus") {
        return { status: "accepted", receiptReadStatus: "unknown" };
      }
      try {
        const receiptResponse = await fetch(
          "https://api.surplusintelligence.ai/v1/requests",
          {
            method: "GET",
            headers: bearer(apiKey),
            redirect: "error",
            signal: boundedSignal,
          },
        );
        void receiptResponse.body?.cancel().catch(() => {});
        return {
          status: "accepted",
          receiptReadStatus: receiptResponse.ok
            ? "available"
            : receiptResponse.status === 401 || receiptResponse.status === 403
              ? "unavailable"
              : "unknown",
        };
      } catch {
        return { status: "accepted", receiptReadStatus: "unknown" };
      }
    }
    if (response.status === 401 || (
      provider === "google" && response.status === 400 && await hasGoogleInvalidKeyReason(response)
    )) {
      return { status: "rejected", receiptReadStatus: "unknown" };
    }
    return { status: "unavailable", receiptReadStatus: "unknown" };
  } catch {
    return { status: "unavailable", receiptReadStatus: "unknown" };
  }
}
