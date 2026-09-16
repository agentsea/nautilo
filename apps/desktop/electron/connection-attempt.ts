/** D514 Phase 1 — pure, generation- and origin-fenced connection authority. */

import {
  isSafePromotionOrigin,
  type NormalizedServerTarget,
  type TransportCandidate,
} from "./server-target";

/** Opaque to consumers: never infer authority from a generation alone. */
declare const connectionAttemptIdBrand: unique symbol;
export type ConnectionAttemptId = string & { readonly [connectionAttemptIdBrand]: "ConnectionAttemptId" };

export function connectionAttemptId(value: string): ConnectionAttemptId {
  if (!value.trim()) throw new Error("connection attempt id must not be empty");
  return value as ConnectionAttemptId;
}

export type ConnectionContext = "initial" | "cold-boot" | "add" | "switch";
export type ConnectionPhase =
  | "normalizing" | "downgrade-confirmation" | "transport" | "readiness" | "health"
  | "identity" | "setup" | "auth" | "navigation" | "promotion" | "complete"
  | "failed" | "cancelled" | "mismatch" | "superseded";
export type ConnectionAction = "retry" | "cancel" | "edit-target" | "accept-identity" | "wait" | "confirm-downgrade" | "resume-handoff";
export type TransportFailureCategory = "network" | "timeout" | "protocol" | "certificate" | "status" | "malformed" | "identity";

export type ConnectionErrorCode =
  | "invalid-target" | "transport-unavailable" | "readiness-unavailable" | "health-unavailable"
  | "identity-missing" | "identity-mismatch" | "setup-discovery-failed" | "auth-discovery-failed"
  | "unsafe-promotion-origin" | "navigation-failed" | "promotion-failed" | "cancelled" | "superseded";

/** Candidate-side errors never claim that the old active pairing changed. */
export type ConnectionFailure = Readonly<{
  code: ConnectionErrorCode;
  phase: ConnectionPhase;
  retrySafe: boolean;
  reducerStateChanged: true;
  pairingChange: Readonly<{ possible: boolean; actual: boolean }>;
  measured: Readonly<Record<string, string | number | boolean>>;
  validActions: readonly ConnectionAction[];
}>;

export type TimingClass = "soft" | "caller" | "hard";
export type TimingRule = Readonly<{
  classification: TimingClass;
  /** Optional thresholds are diagnostics or freshness requests, never terminal truth. */
  milliseconds?: number;
  rationale: string;
}>;

/** There is intentionally no request or terminal connection deadline. */
export type ConnectionAttemptPolicy = Readonly<{
  retryDelay: TimingRule;
  slowObservationDiagnostic: TimingRule;
  identityFreshness: TimingRule;
  setupFreshness: TimingRule;
  authFreshness: TimingRule;
  cancellation: TimingRule;
  promotionOrigin: TimingRule;
}>;

export const DEFAULT_CONNECTION_ATTEMPT_POLICY: ConnectionAttemptPolicy = {
  retryDelay: { classification: "soft", rationale: "scheduler may inject a bounded backoff" },
  slowObservationDiagnostic: { classification: "soft", rationale: "may warn without declaring the server failed" },
  identityFreshness: { classification: "caller", rationale: "consumer requests explicit revalidation" },
  setupFreshness: { classification: "caller", rationale: "consumer requests explicit revalidation" },
  authFreshness: { classification: "caller", rationale: "consumer requests explicit revalidation" },
  cancellation: { classification: "hard", rationale: "explicit cancel or supersession fences all late work" },
  promotionOrigin: { classification: "hard", rationale: "cross-origin facts cannot be promoted" },
};

export type ObservationReceipt = Readonly<{
  attemptId: ConnectionAttemptId;
  generation: number;
  origin: string;
  observedAtMs: number;
}>;
export type IdentityMismatchReceipt = Readonly<{
  observation: ObservationReceipt;
  expectedIdentity: string;
  observedIdentity: string;
}>;
export type DowngradeConfirmationReceipt = Readonly<{
  attemptId: ConnectionAttemptId;
  generation: number;
  origin: string;
  confirmedAtMs: number;
}>;
export type PromotionReceipt = Readonly<{
  attemptId: ConnectionAttemptId;
  generation: number;
  origin: string;
  /** Kept receipt-shaped so promotion remains origin/time-bound like observations. */
  observedAtMs: number;
  committedAtMs: number;
  /** Integration sets this only after its atomic pairing handoff succeeds. */
  authoritativePairingChanged: true;
}>;

export type ConnectionFacts = Readonly<{
  target?: NormalizedServerTarget;
  transport?: TransportCandidate;
  transportObserved?: ObservationReceipt;
  readiness?: ObservationReceipt;
  health?: ObservationReceipt;
  expectedIdentity?: string | null;
  observedIdentity?: string | null;
  mismatch?: IdentityMismatchReceipt;
  acceptedMismatch?: IdentityMismatchReceipt;
  setup?: ObservationReceipt;
  auth?: ObservationReceipt;
  navigation?: ObservationReceipt;
}>;

export type ConnectionAttemptState = Readonly<{
  attemptId: ConnectionAttemptId;
  generation: number;
  context: ConnectionContext;
  /** Scope is informational only: the reducer never mutates it. */
  priorActiveScope: string | null;
  enteredTarget: string;
  phase: ConnectionPhase;
  facts: ConnectionFacts;
  retryCount: number;
  error: ConnectionFailure | null;
  authoritativePairingChanged: boolean;
  validActions: readonly ConnectionAction[];
}>;

type BoundEvent = Readonly<{ attemptId: ConnectionAttemptId; generation: number }>;
export type ConnectionAttemptEvent =
  | (BoundEvent & { type: "target-normalized"; target: NormalizedServerTarget })
  | (BoundEvent & { type: "confirm-downgrade"; receipt: DowngradeConfirmationReceipt })
  | (BoundEvent & { type: "transport-connected"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "transport-failed"; receipt: ObservationReceipt; category: TransportFailureCategory })
  | (BoundEvent & { type: "readiness-observed"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "health-observed"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "identity-observed"; receipt: ObservationReceipt; expected: string | null; observed: string | null })
  | (BoundEvent & { type: "setup-discovered"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "auth-discovered"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "navigation-succeeded"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "released-active"; receipt: ObservationReceipt })
  | (BoundEvent & { type: "promoted"; receipt: PromotionReceipt })
  | (BoundEvent & { type: "failed"; code: Exclude<ConnectionErrorCode, "cancelled" | "superseded" | "identity-mismatch" | "promotion-failed">; measured?: Readonly<Record<string, string | number | boolean>> })
  | (BoundEvent & { type: "failed"; code: "promotion-failed"; authoritativePairingChanged: boolean; measured?: Readonly<Record<string, string | number | boolean>> })
  | (BoundEvent & { type: "accept-identity"; mismatch: IdentityMismatchReceipt })
  | (BoundEvent & { type: "resume-handoff" })
  | (BoundEvent & { type: "retry-accepted-identity"; nextAttemptId: ConnectionAttemptId; nextGeneration: number })
  | (BoundEvent & { type: "retry"; nextAttemptId: ConnectionAttemptId; nextGeneration: number })
  | (BoundEvent & { type: "cancel" })
  | (BoundEvent & { type: "supersede" });

export type ConnectionTransition = Readonly<{
  state: ConnectionAttemptState;
  accepted: boolean;
  /** Reducer-only truth. Pairing truth lives in `state.authoritativePairingChanged`. */
  stateChanged: boolean;
  reason?: "late-attempt" | "late-generation" | "wrong-origin" | "stale-receipt" | "illegal-transition" | "invalid-retry";
}>;

const ACTIVE_ACTIONS: readonly ConnectionAction[] = ["cancel", "wait"];
const RETRY_ACTIONS: readonly ConnectionAction[] = ["retry", "edit-target", "cancel"];
const MISMATCH_ACTIONS: readonly ConnectionAction[] = ["retry", "edit-target", "accept-identity", "cancel"];
const DOWNGRADE_ACTIONS: readonly ConnectionAction[] = ["confirm-downgrade", "edit-target", "cancel"];
const RESUME_HANDOFF_ACTIONS: readonly ConnectionAction[] = ["resume-handoff"];
const COMMITTED_PROMOTION_ACTIONS: readonly ConnectionAction[] = ["wait"];

export function beginConnectionAttempt(input: Readonly<{
  attemptId: ConnectionAttemptId;
  generation: number;
  context: ConnectionContext;
  priorActiveScope: string | null;
  enteredTarget: string;
}>): ConnectionAttemptState {
  return {
    ...input,
    phase: "normalizing", facts: {}, retryCount: 0, error: null,
    authoritativePairingChanged: false, validActions: ACTIVE_ACTIONS,
  };
}

function currentCandidate(state: ConnectionAttemptState): TransportCandidate | null {
  const target = state.facts.target;
  if (!target) return null;
  const used = state.facts.transport;
  if (used) return used;
  return target.candidates[0] ?? null;
}

function receiptMatches(state: ConnectionAttemptState, receipt: ObservationReceipt): boolean {
  const candidate = currentCandidate(state);
  return receipt.attemptId === state.attemptId && receipt.generation === state.generation &&
    candidate !== null && receipt.origin === candidate.origin &&
    Number.isFinite(receipt.observedAtMs) && receipt.observedAtMs >= 0;
}
function orderedAfterOrEqual(receipt: ObservationReceipt, predecessor: ObservationReceipt | undefined): boolean {
  return !predecessor || receipt.observedAtMs >= predecessor.observedAtMs;
}

function active(state: ConnectionAttemptState, phase: ConnectionPhase, facts = state.facts): ConnectionAttemptState {
  return { ...state, phase, facts, error: null, validActions: ACTIVE_ACTIONS };
}
function downgradeConfirmation(state: ConnectionAttemptState, facts: ConnectionFacts): ConnectionAttemptState {
  return { ...state, phase: "downgrade-confirmation", facts, error: null, validActions: DOWNGRADE_ACTIONS };
}

function failure(
  state: ConnectionAttemptState,
  code: ConnectionErrorCode,
  terminalPhase: ConnectionPhase,
  measured: Readonly<Record<string, string | number | boolean>> = {},
  validActions = RETRY_ACTIONS,
): ConnectionAttemptState {
  return {
    ...state,
    phase: terminalPhase,
    error: {
      code, phase: state.phase, retrySafe: validActions.includes("retry"), reducerStateChanged: true,
      pairingChange: { possible: state.phase === "promotion", actual: state.authoritativePairingChanged },
      measured, validActions,
    },
    validActions,
  };
}

function reject(state: ConnectionAttemptState, reason: NonNullable<ConnectionTransition["reason"]>): ConnectionTransition {
  return { state, accepted: false, stateChanged: false, reason };
}
function accept(state: ConnectionAttemptState): ConnectionTransition {
  return { state, accepted: true, stateChanged: true };
}
function eligibleHttpFallback(state: ConnectionAttemptState, category: TransportFailureCategory): TransportCandidate | null {
  const target = state.facts.target;
  const current = currentCandidate(state);
  if (!target || !current || current.scheme !== "https" || current.reason !== "bare-https") return null;
  if (!["network", "timeout", "protocol"].includes(category)) return null;
  return target.candidates.find((candidate) => candidate.reason === "local-http-fallback") ?? null;
}
function legalFailurePhase(code: ConnectionErrorCode, phase: ConnectionPhase): boolean {
  return (code === "invalid-target" && phase === "normalizing") ||
    (code === "transport-unavailable" && phase === "transport") ||
    (code === "readiness-unavailable" && phase === "readiness") ||
    (code === "health-unavailable" && phase === "health") ||
    (code === "identity-missing" && phase === "identity") ||
    (code === "setup-discovery-failed" && phase === "setup") ||
    (code === "auth-discovery-failed" && phase === "auth") ||
    (code === "unsafe-promotion-origin" && phase === "navigation") ||
    (code === "navigation-failed" && phase === "navigation") ||
    (code === "promotion-failed" && phase === "promotion");
}
function sameMismatchReceipt(left: IdentityMismatchReceipt, right: IdentityMismatchReceipt): boolean {
  return left.expectedIdentity === right.expectedIdentity &&
    left.observedIdentity === right.observedIdentity &&
    left.observation.attemptId === right.observation.attemptId &&
    left.observation.generation === right.observation.generation &&
    left.observation.origin === right.observation.origin &&
    left.observation.observedAtMs === right.observation.observedAtMs;
}

/** Late, duplicate, wrong-origin, and illegal events are always no-ops. */
export function transitionConnectionAttempt(state: ConnectionAttemptState, event: ConnectionAttemptEvent): ConnectionTransition {
  if (event.attemptId !== state.attemptId) return reject(state, "late-attempt");
  if (event.generation !== state.generation) return reject(state, "late-generation");

  switch (event.type) {
    case "target-normalized":
      if (state.phase !== "normalizing" || event.target.enteredTarget !== state.enteredTarget) return reject(state, "illegal-transition");
      return accept(event.target.requiresExplicitDowngradeConfirmation
        ? downgradeConfirmation(state, { ...state.facts, target: event.target })
        : active(state, "transport", { ...state.facts, target: event.target }));
    case "confirm-downgrade": {
      const candidate = currentCandidate(state);
      if (state.phase !== "downgrade-confirmation" || !candidate || candidate.scheme !== "http" ||
        event.receipt.attemptId !== state.attemptId || event.receipt.generation !== state.generation ||
        event.receipt.origin !== candidate.origin || !Number.isFinite(event.receipt.confirmedAtMs)) return reject(state, "illegal-transition");
      return accept(active(state, "transport"));
    }
    case "transport-connected": {
      if (state.phase !== "transport") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      const candidate = currentCandidate(state);
      return candidate ? accept(active(state, "readiness", { ...state.facts, transport: candidate, transportObserved: event.receipt })) : reject(state, "illegal-transition");
    }
    case "transport-failed": {
      if (state.phase !== "transport") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      const fallback = eligibleHttpFallback(state, event.category);
      if (fallback) return accept(active(state, "transport", { ...state.facts, transport: fallback }));
      return accept(failure(state, "transport-unavailable", "failed", { category: event.category }));
    }
    case "readiness-observed":
      if (state.phase !== "readiness") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      return orderedAfterOrEqual(event.receipt, state.facts.transportObserved)
        ? accept(active(state, "health", { ...state.facts, readiness: event.receipt }))
        : reject(state, "stale-receipt");
    case "health-observed":
      if (state.phase !== "health") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      if (state.facts.acceptedMismatch &&
        (state.facts.acceptedMismatch.observation.attemptId === state.attemptId
          ? event.receipt.observedAtMs <= state.facts.acceptedMismatch.observation.observedAtMs
          : state.facts.acceptedMismatch.observation.generation >= state.generation)) {
        return reject(state, "stale-receipt");
      }
      if (!orderedAfterOrEqual(event.receipt, state.facts.readiness)) return reject(state, "stale-receipt");
      return accept(active(state, "identity", { ...state.facts, health: event.receipt }));
    case "identity-observed": {
      if (state.phase !== "identity" || !receiptMatches(state, event.receipt) || state.facts.health?.observedAtMs !== event.receipt.observedAtMs) {
        return reject(state, "wrong-origin");
      }
      const facts = { ...state.facts, expectedIdentity: event.expected, observedIdentity: event.observed };
      if (!event.observed) return accept(failure({ ...state, facts }, "identity-missing", "failed"));
      const accepted = state.facts.acceptedMismatch;
      const acceptedFreshlyReobserved = accepted &&
        (accepted.observation.attemptId === state.attemptId
          ? event.receipt.observedAtMs > accepted.observation.observedAtMs
          : accepted.observation.generation < state.generation);
      if (acceptedFreshlyReobserved && event.observed === accepted.observedIdentity) {
        // The fresh accepted identity, not the formerly expected identity,
        // becomes the candidate fact carried into setup/promotion. Keep
        // acceptedMismatch as audit evidence, but drop the resolved mismatch.
        const { mismatch: _resolvedMismatch, ...acceptedFacts } = facts;
        return accept(active(state, "setup", {
          ...acceptedFacts,
          expectedIdentity: accepted.observedIdentity,
          observedIdentity: accepted.observedIdentity,
        }));
      }
      if (accepted) {
        const mismatch: IdentityMismatchReceipt = {
          observation: event.receipt,
          expectedIdentity: accepted.observedIdentity,
          observedIdentity: event.observed,
        };
        return accept(failure({ ...state, facts: { ...facts, mismatch } }, "identity-mismatch", "mismatch", { identityMatched: false }, MISMATCH_ACTIONS));
      }
      if (event.expected && event.expected !== event.observed) {
        const mismatch: IdentityMismatchReceipt = { observation: event.receipt, expectedIdentity: event.expected, observedIdentity: event.observed };
        return accept(failure({ ...state, facts: { ...facts, mismatch } }, "identity-mismatch", "mismatch", { identityMatched: false }, MISMATCH_ACTIONS));
      }
      return accept(active(state, "setup", facts));
    }
    case "accept-identity": {
      const mismatch = state.facts.mismatch;
      if (state.phase !== "mismatch" || !mismatch || !sameMismatchReceipt(event.mismatch, mismatch)) return reject(state, "illegal-transition");
      return accept(active(state, "health", { ...state.facts, acceptedMismatch: mismatch }));
    }
    case "setup-discovered":
      if (state.phase !== "setup") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      return orderedAfterOrEqual(event.receipt, state.facts.health)
        ? accept(active(state, "auth", { ...state.facts, setup: event.receipt }))
        : reject(state, "stale-receipt");
    case "auth-discovered":
      if (state.phase !== "auth") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      return orderedAfterOrEqual(event.receipt, state.facts.setup)
        ? accept(active(state, "navigation", { ...state.facts, auth: event.receipt }))
        : reject(state, "stale-receipt");
    case "navigation-succeeded":
      if (state.phase !== "navigation") return reject(state, "illegal-transition");
      if (!receiptMatches(state, event.receipt)) return reject(state, "wrong-origin");
      if (!orderedAfterOrEqual(event.receipt, state.facts.auth)) return reject(state, "stale-receipt");
      if (!isSafePromotionOrigin(currentCandidate(state)?.origin ?? "", event.receipt.origin)) {
        return accept(failure(state, "unsafe-promotion-origin", "failed", { originMatched: false }));
      }
      return accept(active(state, "promotion", { ...state.facts, navigation: event.receipt }));
    case "released-active":
      // Cold boot is proving an authority that is already durable, not
      // promoting a candidate.  The release is therefore legal only after
      // the exact active origin and its expected identity have been freshly
      // observed.  In particular, an accepted mismatch must take the normal
      // promotion/config path instead of quietly reusing this terminal.
      if (state.context !== "cold-boot" || state.phase !== "promotion" ||
        state.priorActiveScope === null || state.priorActiveScope !== event.receipt.origin ||
        !receiptMatches(state, event.receipt) ||
        state.facts.navigation?.attemptId !== event.receipt.attemptId ||
        state.facts.navigation.generation !== event.receipt.generation ||
        state.facts.navigation.origin !== event.receipt.origin ||
        state.facts.navigation.observedAtMs !== event.receipt.observedAtMs ||
        state.facts.expectedIdentity === null || state.facts.expectedIdentity === undefined ||
        state.facts.expectedIdentity !== state.facts.observedIdentity ||
        state.facts.mismatch !== undefined || state.facts.acceptedMismatch !== undefined) {
        return reject(state, "illegal-transition");
      }
      return accept({
        ...state,
        phase: "complete",
        error: null,
        authoritativePairingChanged: false,
        validActions: [],
      });
    case "promoted":
      if (state.phase !== "promotion" || !receiptMatches(state, event.receipt) || !Number.isFinite(event.receipt.committedAtMs) || event.receipt.committedAtMs < event.receipt.observedAtMs || !event.receipt.authoritativePairingChanged) return reject(state, "illegal-transition");
      if (!orderedAfterOrEqual(event.receipt, state.facts.navigation)) return reject(state, "stale-receipt");
      return accept({ ...state, phase: "complete", error: null, authoritativePairingChanged: true, validActions: [] });
    case "failed": {
      if (!legalFailurePhase(event.code, state.phase)) return reject(state, "illegal-transition");
      // A handoff can fail before or after its single durable linearization
      // point. Only that promotion receipt may report an actual pairing move.
      const effectiveAuthoritativePairingChanged = state.authoritativePairingChanged ||
        (event.code === "promotion-failed" && event.authoritativePairingChanged);
      const failureState = event.code === "promotion-failed"
        ? { ...state, authoritativePairingChanged: effectiveAuthoritativePairingChanged }
        : state;
      return accept(failure(
        failureState,
        event.code,
        "failed",
        event.measured,
        event.code === "promotion-failed" && effectiveAuthoritativePairingChanged
          ? RESUME_HANDOFF_ACTIONS
          : RETRY_ACTIONS,
      ));
    }
    case "resume-handoff":
      if (state.phase !== "failed" || state.error?.code !== "promotion-failed" || !state.authoritativePairingChanged || !state.validActions.includes("resume-handoff")) {
        return reject(state, "illegal-transition");
      }
      return accept({ ...state, phase: "promotion", error: null, validActions: COMMITTED_PROMOTION_ACTIONS });
    case "retry-accepted-identity": {
      const acceptedMismatch = state.facts.acceptedMismatch;
      if (state.phase !== "health" || !acceptedMismatch ||
        !Number.isSafeInteger(event.nextGeneration) || event.nextGeneration <= state.generation ||
        event.nextAttemptId === state.attemptId) return reject(state, "invalid-retry");
      return accept({
        ...beginConnectionAttempt({
          attemptId: event.nextAttemptId,
          generation: event.nextGeneration,
          context: state.context,
          priorActiveScope: state.priorActiveScope,
          enteredTarget: state.enteredTarget,
        }),
        facts: { acceptedMismatch },
        retryCount: state.retryCount + 1,
      });
    }
    case "retry":
      if (state.authoritativePairingChanged || !state.validActions.includes("retry") || !Number.isSafeInteger(event.nextGeneration) || event.nextGeneration <= state.generation || event.nextAttemptId === state.attemptId) return reject(state, "invalid-retry");
      return accept({ ...beginConnectionAttempt({ attemptId: event.nextAttemptId, generation: event.nextGeneration, context: state.context, priorActiveScope: state.priorActiveScope, enteredTarget: state.enteredTarget }), retryCount: state.retryCount + 1 });
    case "cancel":
      return state.validActions.includes("cancel") ? accept(failure(state, "cancelled", "cancelled", {}, [])) : reject(state, "illegal-transition");
    case "supersede":
      return state.authoritativePairingChanged || ["complete", "cancelled", "superseded"].includes(state.phase) ? reject(state, "illegal-transition") : accept(failure(state, "superseded", "superseded", {}, []));
  }
}
