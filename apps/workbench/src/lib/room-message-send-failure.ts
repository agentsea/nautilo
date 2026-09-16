import {
  AgentInvocationRequiredError,
  StrictShadowProtectedContentRequiredError,
  type StrictShadowBoundaryReason,
} from "@nautilo/api-client/browser";

const INVOKE_AGENTS_REQUIRED_COPY =
  "You don’t have permission to ask Genie or other agents to respond.";

const REMOTE_ORDINARY_NORMALIZATION_REJECTION =
  /remote ordinary body normalization rejected (non-finite number|cyclic reference|unsupported object|nesting limit|undefined|function|symbol|bigint)(?: at |$)/;

function remoteOrdinaryNormalizationFailureCopy(valueClass: string): string {
  return `This message includes unsupported app/context data (${valueClass}). Change or close the active selection or context, then try again.`;
}

function strictShadowFailureCopy(reason: StrictShadowBoundaryReason): string {
  switch (reason) {
    case "device_membership_converging":
      return "This device is still receiving its encrypted access. It is safe to leave this page and retry after device setup finishes.";
    case "domain_authority_converging":
    case "namespace_authority_converging":
      return "Encrypted access for this room is still syncing. It is safe to leave this page and retry shortly.";
    case "device_not_enrolled":
    case "device_stale":
    case "device_removed":
    case "recovery_required":
      return "This device cannot use encrypted rooms yet. Open Settings → Encryption to connect or recover it.";
    case "unsupported_operation":
    case "unknown_boundary":
    case "unknown_result":
      return "This action is not yet available with the server’s current encryption settings. An owner can review Admin → Encryption.";
    default:
      return "Encryption verification failed, so this message was not sent. Retry once; if it continues, check Admin → Encryption.";
  }
}

/**
 * Translate stable transport denials at the final Human-facing boundary.
 * Electron IPC wraps main-process errors, so retain the typed check for the
 * browser path and recognize the same stable code inside the IPC envelope.
 */
export function roomMessageSendFailureReason(error: unknown): string {
  const message =
    typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  if (
    error instanceof AgentInvocationRequiredError ||
    message.includes("invoke_agents_required")
  ) {
    return INVOKE_AGENTS_REQUIRED_COPY;
  }
  if (error instanceof StrictShadowProtectedContentRequiredError) {
    return strictShadowFailureCopy(error.reason);
  }
  if (message.includes("strict_shadow_protected_content_required")) {
    const reason = message.match(
      /strict_shadow_protected_content_required:(?:verified|waiting_for_authority|repairing|unsupported|failed):([a-z_]+):(?:retryable|terminal)/u,
    )?.[1];
    return reason === undefined
      ? "This message is waiting for verified encryption. Check this device’s Encryption status, then retry."
      : strictShadowFailureCopy(reason as StrictShadowBoundaryReason);
  }
  const normalizationRejection = message.match(
    REMOTE_ORDINARY_NORMALIZATION_REJECTION,
  );
  if (normalizationRejection) {
    return remoteOrdinaryNormalizationFailureCopy(normalizationRejection[1]);
  }
  return message;
}
