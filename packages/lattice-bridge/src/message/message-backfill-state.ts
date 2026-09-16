export type MessageBackfillRole = "user" | "assistant" | "tool" | "system";

export interface MessageBackfillStructuralCoordinate {
  readonly messageId: number;
  readonly sessionId: string;
  readonly revision: number;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly role: MessageBackfillRole;
  readonly ordinaryPresent: boolean;
  readonly cryptoObjectId: string | null;
}

export interface MessageBackfillExactLifecycle {
  readonly sessionId: string;
  readonly messageId: number;
  readonly revision: number;
  readonly cryptoObjectId: string;
  readonly keyClass: "ai" | "human";
  readonly completion: "pending" | "complete";
  readonly disposition: string;
  readonly parityStatus: string;
  readonly repairIdentityPresent: boolean;
}

export type MessageBackfillAction =
  | "none"
  | "encrypt"
  | "verify"
  | "restore"
  | "failed"
  | "unsupported";

export type MessageBackfillEvidence =
  | "none"
  | "authenticated"
  | "independent_parity";

export type MessageBackfillFailureReason =
  | "neither_present"
  | "stale_mapping";

export type MessageBackfillUnsupportedReason = "unsupported_topology";

export type MessageBackfillState =
  | Readonly<{
      action: "none" | "encrypt" | "verify" | "restore";
      evidence: MessageBackfillEvidence;
      reason: null;
    }>
  | Readonly<{
      action: "failed";
      evidence: "none";
      reason: MessageBackfillFailureReason;
    }>
  | Readonly<{
      action: "unsupported";
      evidence: "none";
      reason: MessageBackfillUnsupportedReason;
    }>;

const noWork = (evidence: MessageBackfillEvidence): MessageBackfillState =>
  Object.freeze({ action: "none" as const, evidence, reason: null });

const work = (
  action: "encrypt" | "verify" | "restore",
  evidence: MessageBackfillEvidence,
): MessageBackfillState => Object.freeze({ action, evidence, reason: null });

const failed = (reason: MessageBackfillFailureReason): MessageBackfillState =>
  Object.freeze({ action: "failed" as const, evidence: "none" as const, reason });

function sameCurrentRevision(
  message: MessageBackfillStructuralCoordinate,
  lifecycle: MessageBackfillExactLifecycle,
): boolean {
  return lifecycle.sessionId === message.sessionId
    && lifecycle.messageId === message.messageId
    && lifecycle.revision === message.revision;
}

/**
 * Derive current repair work only from the canonical Message pointer and its
 * exact revision lifecycle. Claims, acknowledgements, counters and attempts
 * are deliberately absent: none of them can prove a representation exists.
 */
export function classifyMessageBackfillState(input: Readonly<{
  message: MessageBackfillStructuralCoordinate;
  lifecycle?: MessageBackfillExactLifecycle | null;
  supportedTopology: boolean;
  ordinaryRestorationAccepted?: boolean;
}>): MessageBackfillState {
  if (!input.supportedTopology) {
    return Object.freeze({
      action: "unsupported" as const,
      evidence: "none" as const,
      reason: "unsupported_topology" as const,
    });
  }

  const { message } = input;
  const lifecycle = input.lifecycle ?? null;
  if (lifecycle !== null && !sameCurrentRevision(message, lifecycle)) {
    return failed("stale_mapping");
  }

  if (message.cryptoObjectId === null) {
    if (!message.ordinaryPresent) return failed("neither_present");
    if (lifecycle === null) return work("encrypt", "none");
    return lifecycle.completion === "pending"
        && lifecycle.disposition === "active"
        && lifecycle.repairIdentityPresent
      ? work("encrypt", "none")
      : failed("stale_mapping");
  }

  if (
    lifecycle === null
    || lifecycle.cryptoObjectId !== message.cryptoObjectId
    || lifecycle.completion !== "complete"
    || lifecycle.disposition !== "mapped"
  ) return failed("stale_mapping");

  const evidence: MessageBackfillEvidence =
    lifecycle.parityStatus === "server_verified"
      || lifecycle.parityStatus === "client_verified"
      ? "independent_parity"
      : lifecycle.parityStatus === "server_authenticated"
          || lifecycle.parityStatus === "client_authenticated"
        ? "authenticated"
        : "none";
  if (evidence === "none") return failed("stale_mapping");
  if (!message.ordinaryPresent) return work("restore", evidence);
  if (input.ordinaryRestorationAccepted === true) return noWork(evidence);
  if (evidence === "authenticated") return work("verify", evidence);
  return noWork(evidence);
}
