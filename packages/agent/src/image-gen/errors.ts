export type DirectImageAttemptOutcome = "failed" | "unknown";

/**
 * Stable, content-free execution certainty for direct image providers.
 * Monetary evidence remains independent: a deterministic refusal does not
 * prove that the provider charged zero.
 */
export class DirectImageAttemptError extends Error {
  constructor(
    message: string,
    readonly attemptOutcome: DirectImageAttemptOutcome,
    readonly failureCode: string,
  ) {
    super(message);
    this.name = "DirectImageAttemptError";
  }
}

export function directImageHttpError(provider: string, status: number): DirectImageAttemptError {
  const label = provider === "openai" ? "OpenAI"
    : provider === "openrouter" ? "OpenRouter"
      : provider === "google" ? "Google"
        : provider === "venice" ? "Venice"
          : "Image provider";
  const deterministicRefusal = new Set([
    400, 401, 402, 403, 404, 405, 409, 413, 415, 422, 429,
  ]).has(status);
  const message = status === 401 || status === 403
    ? `${label} rejected the image-generation credential.`
    : status === 402
      ? `${label} has insufficient credits for image generation.`
      : status === 429
        ? `${label} rate-limited image generation. Retry shortly.`
        : `${label} image generation failed (HTTP ${status}).`;
  return new DirectImageAttemptError(
    message,
    deterministicRefusal ? "failed" : "unknown",
    deterministicRefusal ? "provider_refused" : "provider_http_unknown",
  );
}

export function directImageTransportError(provider: string): DirectImageAttemptError {
  return new DirectImageAttemptError(
    `${provider} image generation transport failed; the request outcome is unknown.`,
    "unknown",
    "provider_transport_unknown",
  );
}

export function directImageInvalidResponse(provider: string, detail: string): DirectImageAttemptError {
  return new DirectImageAttemptError(
    `${provider} image generation failed: ${detail}`,
    "unknown",
    "invalid_provider_response",
  );
}

export function directImageAdmissionError(message: string): DirectImageAttemptError {
  return new DirectImageAttemptError(message, "failed", "unsupported_provider_request");
}
