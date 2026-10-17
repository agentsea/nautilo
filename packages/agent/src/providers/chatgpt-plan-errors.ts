/** Closed, content-free failure vocabulary shared by transport and chat presentation. */
export type ChatGPTSubscriptionFailure =
  | "subscription_limit"
  | "subscription_unavailable"
  | "subscription_ineligible"
  | "reconnect_required"
  | "response_incomplete"
  | "stream_interrupted"
  | "unsupported_input"
  | "provider_unavailable";

export class ChatGPTSubscriptionError extends Error {
  constructor(readonly code: ChatGPTSubscriptionFailure) {
    super(code);
    this.name = "ChatGPTSubscriptionError";
  }
}

/** Inspect structured provider codes only; never retain response bodies or messages. */
export function subscriptionFailure(error: unknown): ChatGPTSubscriptionFailure {
  if (typeof error !== "object" || error === null) return "provider_unavailable";
  const code = "code" in error ? error.code : undefined;
  if (code === "subscription_sharing_usage_limit_exceeded") return "subscription_limit";
  if (code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable") return "subscription_unavailable";
  if (code === "subscription_sharing_user_not_eligible") return "subscription_ineligible";
  if (code === "subscription_sharing_unsupported_capability") return "unsupported_input";
  if (code === "chatpass_v2_scope_not_authorized" || code === "chatpass_v2_invalid_authorization_context") return "reconnect_required";
  if ("status" in error && error.status === 401) return "reconnect_required";
  return "provider_unavailable";
}

/** Attempt wrappers preserve their cause; cyclic wrappers must not loop forever. */
export function findChatGPTSubscriptionError(error: unknown): ChatGPTSubscriptionError | undefined {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof ChatGPTSubscriptionError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}
