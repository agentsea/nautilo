import {
  selectLiveShadowEncryptionTransitionPolicy,
  type LiveShadowEncryptionTransitionPolicy,
} from "./encryption-transition-policy.ts";

export type ShadowContentFamily = "message" | "memory" | "artifact";

export type ShadowTransitionTrigger = "ordinary_write" | "read_repair";

export type ShadowTransitionOperation =
  | "create"
  | "update"
  | "access_change"
  | "read_repair"
  | "unsupported_operation";

export type ShadowTransitionOutcome =
  | "verified"
  | "pending"
  | "response_lost_reconciling"
  | "unmigrated"
  | "unsupported_operation"
  | "client_crypto_unavailable"
  | "namespace_encryption_not_ready"
  | "stale_authority"
  | "stale_product"
  | "parity_mismatch"
  | "integrity_failure"
  | "publication_failure";

export type ShadowTransitionCurrentVerification =
  | "current"
  | "stale_authority"
  | "stale_product"
  | "integrity_failure";

export type ShadowTransitionMappingInvalidation =
  | "invalidated"
  | "already_invalid"
  | "conflict";

export type ShadowTransitionObservation = Readonly<{
  family: ShadowContentFamily;
  trigger: ShadowTransitionTrigger;
  operation: ShadowTransitionOperation;
  outcome: ShadowTransitionOutcome;
}>;

export type ShadowTransitionCandidate<Opaque> = Readonly<{
  family: ShadowContentFamily;
  operation: ShadowTransitionOperation;
  productRevision: number;
  audienceFingerprint: Uint8Array;
  /**
   * Access changes must prove the authoritative product transaction already
   * made the previous audience mapping unselectable.
   */
  audienceMappingInvalidated: boolean;
  /** Callback-local family adapter state; never copied into observations. */
  opaque: Opaque;
}>;

export type ShadowTransitionTask = () => Promise<void>;

type ShadowTransitionPorts<Opaque> = Readonly<{
  verifyCurrent(
    candidate: ShadowTransitionCandidate<Opaque>,
  ): Promise<ShadowTransitionCurrentVerification>;
  publishExisting(
    candidate: ShadowTransitionCandidate<Opaque>,
  ): Promise<ShadowTransitionOutcome>;
  invalidateMapping?(
    candidate: ShadowTransitionCandidate<Opaque>,
  ): Promise<ShadowTransitionMappingInvalidation>;
  reconcileExisting?(
    candidate: ShadowTransitionCandidate<Opaque>,
  ): Promise<void>;
}>;

export type ShadowTransitionCoordinator = Readonly<{
  runOrdinaryWrite<Result, Opaque>(
    input: ShadowTransitionPorts<Opaque> & Readonly<{
      family: ShadowContentFamily;
      operation: ShadowTransitionOperation;
      ordinary(): Promise<Result>;
      selectCandidate(result: Result): ShadowTransitionCandidate<Opaque>;
    }>,
  ): Promise<Result>;
  runOrdinaryReadRepair<Result, Opaque>(
    input: ShadowTransitionPorts<Opaque> & Readonly<{
      family: ShadowContentFamily;
      /** Bound inherited from the already-completed ordinary page/range. */
      ordinaryBound: number;
      ordinary(): Promise<Result>;
      selectCompleteCandidates(
        result: Result,
      ): readonly ShadowTransitionCandidate<Opaque>[];
    }>,
  ): Promise<Result>;
}>;

const FAMILIES = new Set<ShadowContentFamily>([
  "message",
  "memory",
  "artifact",
]);
const OPERATIONS = new Set<ShadowTransitionOperation>([
  "create",
  "update",
  "access_change",
  "read_repair",
  "unsupported_operation",
]);
const VERIFICATIONS = new Set<ShadowTransitionCurrentVerification>([
  "current",
  "stale_authority",
  "stale_product",
  "integrity_failure",
]);
const OUTCOMES = new Set<ShadowTransitionOutcome>([
  "verified",
  "pending",
  "response_lost_reconciling",
  "unmigrated",
  "unsupported_operation",
  "client_crypto_unavailable",
  "namespace_encryption_not_ready",
  "stale_authority",
  "stale_product",
  "parity_mismatch",
  "integrity_failure",
  "publication_failure",
]);
const INVALIDATIONS = new Set<ShadowTransitionMappingInvalidation>([
  "invalidated",
  "already_invalid",
  "conflict",
]);
const CANDIDATE_KEYS = Object.freeze([
  "audienceFingerprint",
  "audienceMappingInvalidated",
  "family",
  "opaque",
  "operation",
  "productRevision",
] as const);

function normalizeCandidate<Opaque>(
  candidate: ShadowTransitionCandidate<Opaque>,
): ShadowTransitionCandidate<Opaque> | null {
  if (
    typeof candidate !== "object"
    || candidate === null
    || Object.keys(candidate).sort().join("\0") !== CANDIDATE_KEYS.join("\0")
    || !FAMILIES.has(candidate.family)
    || !OPERATIONS.has(candidate.operation)
    || !Number.isSafeInteger(candidate.productRevision)
    || candidate.productRevision < 0
    || !(candidate.audienceFingerprint instanceof Uint8Array)
    || candidate.audienceFingerprint.length !== 32
    || typeof candidate.audienceMappingInvalidated !== "boolean"
    || !("opaque" in candidate)
  ) return null;
  return Object.freeze({
    family: candidate.family,
    operation: candidate.operation,
    productRevision: candidate.productRevision,
    audienceFingerprint: candidate.audienceFingerprint.slice(),
    audienceMappingInvalidated: candidate.audienceMappingInvalidated,
    opaque: candidate.opaque,
  });
}

function observeClosed(
  observe: (observation: ShadowTransitionObservation) => void,
  candidate: Pick<ShadowTransitionCandidate<unknown>, "family" | "operation">,
  trigger: ShadowTransitionTrigger,
  outcome: ShadowTransitionOutcome,
): void {
  try {
    observe(Object.freeze({
      family: candidate.family,
      trigger,
      operation: candidate.operation,
      outcome,
    }));
  } catch {
    // Non-authoritative observations cannot change product/crypto behavior.
  }
}

async function runCandidate<Opaque>(input: Readonly<{
  candidate: ShadowTransitionCandidate<Opaque>;
  trigger: ShadowTransitionTrigger;
  ports: ShadowTransitionPorts<Opaque>;
  expected?: Readonly<{
    family: ShadowContentFamily;
    operation: ShadowTransitionOperation;
  }>;
  observe(observation: ShadowTransitionObservation): void;
}>): Promise<void> {
  const normalized = normalizeCandidate(input.candidate);
  if (normalized === null) {
    const family = FAMILIES.has(input.candidate.family)
      ? input.candidate.family
      : "message";
    const operation = OPERATIONS.has(input.candidate.operation)
      ? input.candidate.operation
      : "unsupported_operation";
    observeClosed(input.observe, { family, operation }, input.trigger,
      "integrity_failure");
    return;
  }
  try {
    if (
      input.expected !== undefined
      && (
        normalized.family !== input.expected.family
        || normalized.operation !== input.expected.operation
      )
    ) {
      observeClosed(input.observe, input.expected, input.trigger,
        "integrity_failure");
      return;
    }
    if (
      normalized.operation === "access_change"
      && !normalized.audienceMappingInvalidated
    ) {
      observeClosed(input.observe, normalized, input.trigger,
        "integrity_failure");
      return;
    }
    const verification = await input.ports.verifyCurrent(normalized);
    if (!VERIFICATIONS.has(verification)) {
      observeClosed(input.observe, normalized, input.trigger,
        "integrity_failure");
      return;
    }
    if (verification !== "current") {
      if (
        (verification === "stale_product"
          || verification === "stale_authority")
        && input.ports.invalidateMapping !== undefined
      ) {
        const invalidated = await input.ports.invalidateMapping(normalized);
        if (!INVALIDATIONS.has(invalidated) || invalidated === "conflict") {
          observeClosed(input.observe, normalized, input.trigger,
            "integrity_failure");
          return;
        }
      }
      observeClosed(input.observe, normalized, input.trigger, verification);
      return;
    }
    const outcome = await input.ports.publishExisting(normalized);
    if (!OUTCOMES.has(outcome)) {
      observeClosed(input.observe, normalized, input.trigger,
        "integrity_failure");
      return;
    }
    if (
      (outcome === "stale_product" || outcome === "stale_authority")
      && input.ports.invalidateMapping !== undefined
    ) {
      const invalidated = await input.ports.invalidateMapping(normalized);
      if (!INVALIDATIONS.has(invalidated) || invalidated === "conflict") {
        observeClosed(input.observe, normalized, input.trigger,
          "integrity_failure");
        return;
      }
    }
    if (
      (outcome === "pending" || outcome === "response_lost_reconciling")
      && input.ports.reconcileExisting !== undefined
    ) {
      try {
        await input.ports.reconcileExisting(normalized);
      } catch {
        // The existing family lifecycle owns retry/reconcile state. The
        // transition coordinator deliberately records no second failure row.
      }
    }
    observeClosed(input.observe, normalized, input.trigger, outcome);
  } catch {
    observeClosed(input.observe, normalized, input.trigger,
      "publication_failure");
  } finally {
    normalized.audienceFingerprint.fill(0);
  }
}

export function createShadowTransitionCoordinator(input: Readonly<{
  policy: unknown;
  schedule(task: ShadowTransitionTask): void;
  observe(observation: ShadowTransitionObservation): void;
}>): ShadowTransitionCoordinator {
  const selected = selectLiveShadowEncryptionTransitionPolicy(input.policy);
  if (!selected.ok) {
    throw new TypeError(selected.error);
  }
  const policy: LiveShadowEncryptionTransitionPolicy = selected.value;
  const schedule = input.schedule;
  const observe = input.observe;

  function safelySchedule(
    task: ShadowTransitionTask,
    candidate: Pick<ShadowTransitionCandidate<unknown>, "family" | "operation">,
    trigger: ShadowTransitionTrigger,
  ): void {
    try {
      schedule(task);
    } catch {
      // Shadow scheduling is subordinate to the completed ordinary operation.
      // Still emit the one closed denominator outcome for this eligible
      // attempt; no crypto lifecycle was started.
      observeClosed(observe, candidate, trigger, "publication_failure");
    }
  }

  return Object.freeze({
    async runOrdinaryWrite<Result, Opaque>(
      request: ShadowTransitionPorts<Opaque> & Readonly<{
        family: ShadowContentFamily;
        operation: ShadowTransitionOperation;
        ordinary(): Promise<Result>;
        selectCandidate(result: Result): ShadowTransitionCandidate<Opaque>;
      }>,
    ): Promise<Result> {
      const result = await request.ordinary();
      if (policy.mode === "plaintext_only") return result;
      safelySchedule(async () => {
        let candidate: ShadowTransitionCandidate<Opaque>;
        try {
          candidate = request.selectCandidate(result);
        } catch {
          observeClosed(observe, request, "ordinary_write",
            "integrity_failure");
          return;
        }
        await runCandidate({
          candidate,
          trigger: "ordinary_write",
          ports: request,
          expected: request,
          observe,
        });
      }, {
        family: FAMILIES.has(request.family) ? request.family : "message",
        operation: OPERATIONS.has(request.operation)
          ? request.operation
          : "unsupported_operation",
      }, "ordinary_write");
      return result;
    },

    async runOrdinaryReadRepair<Result, Opaque>(
      request: ShadowTransitionPorts<Opaque> & Readonly<{
        family: ShadowContentFamily;
        ordinaryBound: number;
        ordinary(): Promise<Result>;
        selectCompleteCandidates(
          result: Result,
        ): readonly ShadowTransitionCandidate<Opaque>[];
      }>,
    ): Promise<Result> {
      const result = await request.ordinary();
      if (policy.mode === "plaintext_only") return result;
      safelySchedule(async () => {
        let candidates: readonly ShadowTransitionCandidate<Opaque>[];
        try {
          candidates = request.selectCompleteCandidates(result);
        } catch {
          observeClosed(observe, {
            family: FAMILIES.has(request.family) ? request.family : "message",
            operation: "read_repair",
          }, "read_repair", "integrity_failure");
          return;
        }
        if (
          !FAMILIES.has(request.family)
          || !Number.isSafeInteger(request.ordinaryBound)
          || request.ordinaryBound < 0
          || !Array.isArray(candidates as unknown)
          || candidates.length > request.ordinaryBound
          || candidates.some((candidate) =>
            candidate.family !== request.family
            || candidate.operation !== "read_repair"
          )
        ) {
          observeClosed(observe, {
            family: FAMILIES.has(request.family) ? request.family : "message",
            operation: "read_repair",
          }, "read_repair", "integrity_failure");
          return;
        }
        for (const candidate of candidates) {
          await runCandidate({
            candidate,
            trigger: "read_repair",
            ports: request,
            expected: {
              family: request.family,
              operation: "read_repair",
            },
            observe,
          });
        }
      }, {
        family: FAMILIES.has(request.family) ? request.family : "message",
        operation: "read_repair",
      }, "read_repair");
      return result;
    },
  });
}
