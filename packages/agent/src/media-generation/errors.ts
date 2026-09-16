export type MediaGenerationPhase = "validation" | "quote" | "admission" | "retrieve" | "download" | "persistence" | "cleanup";
export type CompletionCertainty = "not_started" | "accepted" | "unknown" | "unavailable";
export type ChargeCertainty = "not_charged" | "charged_or_committed" | "unknown" | "refunded";
export type MediaGenerationRecoveryAction =
  | "revise_request" | "refresh_catalog" | "repair_credentials" | "repair_billing" | "review_access"
  | "provider_consent" | "switch_model" | "retry_admission" | "retry_retrieval" | "retry_download"
  | "retry_persistence" | "retry_cleanup" | "start_new_generation" | "wait" | "contact_support";

export type VeniceFailureInput = Readonly<{
  phase: MediaGenerationPhase;
  status?: number;
  code?: string;
  acceptedReceipt?: boolean;
  transportFailure?: boolean;
  /** Provider-issued delivery URL failed Nautilo's server-only SSRF policy. */
  unsafeDeliveryUrl?: boolean;
  creditsRefunded?: boolean;
}>;

export type MediaGenerationFailure = Readonly<{
  code: string;
  phase: MediaGenerationPhase;
  retrySafe: boolean;
  stateChanged: boolean;
  completionCertainty: CompletionCertainty;
  chargeCertainty: ChargeCertainty;
  creditsRefunded?: boolean;
  recoveryActions: readonly MediaGenerationRecoveryAction[];
  message: string;
}>;

const providerCodes = new Set(["needs_consent", "invalid_request", "invalid_model", "content_policy", "content_policy_violation", "media_not_found"]);

/**
 * Provider messages can echo prompts, lyrics, signed URLs, and credentials.
 * Persist and show only this stable classifier, never the raw response body.
 */
export function sanitizeVeniceProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return providerCodes.has(normalized) ? normalized : undefined;
}

function failure(input: VeniceFailureInput, overrides: Omit<MediaGenerationFailure, "phase">): MediaGenerationFailure {
  return Object.freeze({ phase: input.phase, ...overrides });
}

function accepted(input: VeniceFailureInput): boolean {
  return input.acceptedReceipt === true || input.phase === "retrieve" || input.phase === "download" || input.phase === "persistence" || input.phase === "cleanup";
}

function retryAcceptedWork(input: VeniceFailureInput): MediaGenerationFailure {
  const action = input.phase === "download" ? "retry_download" : input.phase === "persistence" ? "retry_persistence" : input.phase === "cleanup" ? "retry_cleanup" : "retry_retrieval";
  return failure(input, {
    code: `VENICE_${input.status ?? "TRANSPORT"}_RESUME_RECEIPT`, retrySafe: true, stateChanged: true,
    completionCertainty: input.phase === "cleanup" ? "accepted" : "accepted", chargeCertainty: "charged_or_committed",
    recoveryActions: [action], message: "Your existing generation is safe to resume; Nautilo will not start another paid generation.",
  });
}

export function classifyVeniceMediaFailure(input: VeniceFailureInput): MediaGenerationFailure {
  const namedCode = sanitizeVeniceProviderCode(input.code);
  const status = input.status;

  if (input.phase === "download" && input.unsafeDeliveryUrl) return failure(input, {
    code: "VENICE_SIGNED_DELIVERY_REJECTED", retrySafe: false, stateChanged: true,
    completionCertainty: "accepted", chargeCertainty: "charged_or_committed",
    recoveryActions: ["contact_support"], message: "Nautilo rejected an unsafe provider delivery route and did not download the media.",
  });
  if (input.phase === "persistence" || input.phase === "cleanup") return retryAcceptedWork(input);
  if (accepted(input) && (input.transportFailure || status === 429 || status === 500 || status === 502 || status === 503 || status === 504)) return retryAcceptedWork(input);

  if (input.phase === "quote" &&
      (input.transportFailure || status === 429 || status === 500 || status === 502 || status === 503 || status === 504)) {
    return failure(input, {
      code: status === 429 ? "VENICE_RATE_LIMITED" : "VENICE_QUOTE_UNAVAILABLE",
      retrySafe: true,
      stateChanged: false,
      completionCertainty: "not_started",
      chargeCertainty: "not_charged",
      recoveryActions: ["wait"],
      message: "Venice could not provide an exact quote after safe retries. Wait a moment and try again; no generation was started.",
    });
  }

  if (namedCode === "needs_consent" || status === 409) return failure(input, {
    code: "VENICE_NEEDS_CONSENT", retrySafe: false, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
    recoveryActions: ["provider_consent", "switch_model"], message: "Venice requires a consent step. Nautilo cannot attest consent for you.",
  });
  if (status === 422 || namedCode === "content_policy" || namedCode === "content_policy_violation") return failure(input, {
    code: "VENICE_CONTENT_POLICY", retrySafe: false, stateChanged: false, completionCertainty: "not_started",
    chargeCertainty: input.creditsRefunded ? "refunded" : "unknown", ...(input.creditsRefunded === undefined ? {} : { creditsRefunded: input.creditsRefunded }),
    recoveryActions: ["revise_request", "switch_model"], message: "Venice refused this request. Preserve it, revise it, or choose another model; Nautilo will not repeat it unchanged.",
  });
  if (status === 400 || status === 413 || status === 415 || namedCode === "invalid_request" || namedCode === "invalid_model") return failure(input, {
    code: status === 413 ? "VENICE_PAYLOAD_TOO_LARGE" : status === 415 ? "VENICE_UNSUPPORTED_MEDIA" : "VENICE_INVALID_REQUEST",
    retrySafe: false, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
    recoveryActions: ["refresh_catalog", "revise_request"], message: "Venice rejected these settings. Refresh the available choices and correct the request before trying again.",
  });
  if (status === 401) return failure(input, {
    code: "VENICE_AUTHENTICATION", retrySafe: true, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
    recoveryActions: ["repair_credentials"], message: "Venice credentials need attention before this generation can be retried.",
  });
  if (status === 402) return failure(input, {
    code: "VENICE_BILLING", retrySafe: true, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
    recoveryActions: ["repair_billing"], message: "Venice could not authorize this spend. Update billing or the key spend limit, then request a fresh quote.",
  });
  if (status === 403) return failure(input, {
    code: "VENICE_ACCESS", retrySafe: false, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
    recoveryActions: ["review_access", "switch_model"], message: "Venice does not permit this generation for the configured account or region.",
  });
  if (status === 404 || namedCode === "media_not_found") return failure(input, {
    code: "VENICE_MEDIA_EXPIRED", retrySafe: false, stateChanged: accepted(input), completionCertainty: "unavailable", chargeCertainty: accepted(input) ? "charged_or_committed" : "not_charged",
    recoveryActions: ["start_new_generation"], message: "Venice no longer has this media. Starting again requires an explicit new paid generation.",
  });
  if (status === 429 || (input.phase === "admission" && status === 503)) return failure(input, {
    code: status === 503 ? "VENICE_CAPACITY" : "VENICE_RATE_LIMITED", retrySafe: true, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
    recoveryActions: ["wait", "retry_admission"], message: "Venice is busy. Wait, then retry admission; no generation has been started.",
  });
  if (input.phase === "admission" && (input.transportFailure || status === 500 || status === 502 || status === 503 || status === 504 || status === undefined)) return failure(input, {
    code: "VENICE_QUEUE_COMPLETION_UNKNOWN", retrySafe: false, stateChanged: true, completionCertainty: "unknown", chargeCertainty: "unknown",
    recoveryActions: ["contact_support"], message: "It is unknown whether Venice accepted this paid request. Nautilo will not queue it again automatically.",
  });
  return failure(input, {
    code: `VENICE_${status ?? "UNKNOWN"}`, retrySafe: false, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "unknown",
    recoveryActions: ["contact_support"], message: "Venice returned an unexpected response. No unsafe retry will be suggested.",
  });
}
