/** D514 Phase 2 — renderer-safe projection of main-owned connection truth. */

import type {
  ConnectionAction,
  ConnectionAttemptState,
  ConnectionErrorCode,
  ConnectionPhase,
} from "./connection-attempt";
import type { ConnectionSupportReceipt } from "./connection-support-receipt";

export type ConnectionPresentationPhase =
  | "preparing" | "awaiting-downgrade-confirmation" | "contacting"
  | "waiting-for-server" | "verifying-server" | "verifying-identity"
  | "discovering-setup" | "discovering-sign-in" | "opening-nautilo"
  | "saving-connection" | "complete" | "failed" | "cancelled"
  | "identity-mismatch" | "superseded";

export type ConnectionPresentationAction =
  | "retry" | "cancel" | "edit-target" | "accept-identity" | "wait"
  | "confirm-downgrade" | "resume-handoff";
export type ConnectionPresentationFailureCode =
  | "invalid-target" | "transport-unavailable" | "readiness-unavailable"
  | "health-unavailable" | "identity-missing" | "identity-mismatch"
  | "setup-discovery-failed" | "auth-discovery-failed"
  | "unsafe-promotion-origin" | "navigation-failed" | "promotion-failed"
  | "cancelled" | "superseded";
export type ConnectionPairingStateChange = "unchanged" | "changed" | "indeterminate";
export type ConnectionPriorPairing = "present" | "absent";

/**
 * Main may provide this only after reducing a terminal result to these safe
 * facts. It intentionally has no target, identity, receipt, or error detail.
 */
export type ConnectionTerminalPresentationFact = Readonly<{
  failureCode: ConnectionPresentationFailureCode;
  pairingStateChange: ConnectionPairingStateChange;
}>;

export type ConnectionPresentation = Readonly<{
  version: 1;
  /** Main-owned monotonic snapshot revision; never an attempt identifier. */
  revision: number;
  phase: ConnectionPresentationPhase;
  /** Last verified main-process observation; absence is not a failure. */
  lastObservationAtMs: number | null;
  retrySafe: boolean;
  validActions: readonly ConnectionPresentationAction[];
  priorPairing: ConnectionPriorPairing;
  pairingStateChange: ConnectionPairingStateChange;
  failureCode: ConnectionPresentationFailureCode | null;
  supportReceipt: ConnectionSupportReceipt | null;
}>;

export type ConnectionPresentationInput = Readonly<{
  state: ConnectionAttemptState;
  /** Supplied by the main-owned snapshot authority, not inferred from time. */
  revision: number;
  terminal?: ConnectionTerminalPresentationFact;
}>;

const PHASES: Readonly<Record<ConnectionPhase, ConnectionPresentationPhase>> = {
  normalizing: "preparing",
  "downgrade-confirmation": "awaiting-downgrade-confirmation",
  transport: "contacting",
  readiness: "waiting-for-server",
  health: "verifying-server",
  identity: "verifying-identity",
  setup: "discovering-setup",
  auth: "discovering-sign-in",
  navigation: "opening-nautilo",
  promotion: "saving-connection",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
  mismatch: "identity-mismatch",
  superseded: "superseded",
};

const ACTIONS: Readonly<Record<ConnectionAction, ConnectionPresentationAction>> = {
  retry: "retry",
  cancel: "cancel",
  "edit-target": "edit-target",
  "accept-identity": "accept-identity",
  wait: "wait",
  "confirm-downgrade": "confirm-downgrade",
  "resume-handoff": "resume-handoff",
};

const FAILURE_CODES: Readonly<Record<ConnectionErrorCode, ConnectionPresentationFailureCode>> = {
  "invalid-target": "invalid-target",
  "transport-unavailable": "transport-unavailable",
  "readiness-unavailable": "readiness-unavailable",
  "health-unavailable": "health-unavailable",
  "identity-missing": "identity-missing",
  "identity-mismatch": "identity-mismatch",
  "setup-discovery-failed": "setup-discovery-failed",
  "auth-discovery-failed": "auth-discovery-failed",
  "unsafe-promotion-origin": "unsafe-promotion-origin",
  "navigation-failed": "navigation-failed",
  "promotion-failed": "promotion-failed",
  cancelled: "cancelled",
  superseded: "superseded",
};

function latestObservationAtMs(state: ConnectionAttemptState): number | null {
  const candidates = [
    state.facts.transportObserved, state.facts.readiness, state.facts.health,
    state.facts.setup, state.facts.auth, state.facts.navigation,
  ].map((receipt) => receipt?.observedAtMs).filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return candidates.length === 0 ? null : Math.max(...candidates);
}

function stateChange(state: ConnectionAttemptState, terminal: ConnectionTerminalPresentationFact | undefined): ConnectionPairingStateChange {
  if (terminal) return terminal.pairingStateChange;
  return state.authoritativePairingChanged ? "changed" : "unchanged";
}

/**
 * This is a one-way capability reduction. In particular it deliberately does
 * not expose `enteredTarget`, scope, attempt ID, transport, identity facts,
 * receipts, raw error measurements, or any observed response body.
 */
export function presentConnectionAttempt(input: ConnectionPresentationInput): ConnectionPresentation {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error("connection presentation revision must be a non-negative safe integer");
  }
  const pairingStateChange = stateChange(input.state, input.terminal);
  const internalFailureCode = input.terminal?.failureCode ?? input.state.error?.code;
  const failureCode = internalFailureCode ? FAILURE_CODES[internalFailureCode] : null;
  const mappedActions = input.state.validActions
    .filter((action) => !(action === "accept-identity" && input.state.facts.acceptedMismatch))
    .map((action) => ACTIONS[action]);
  const validActions = pairingStateChange === "unchanged"
    ? mappedActions
    : mappedActions.filter((action) => action === "wait" || action === "resume-handoff");
  const retrySafe = validActions.includes("retry") &&
    (input.state.error?.retrySafe ?? true);
  return {
    version: 1,
    revision: input.revision,
    phase: PHASES[input.state.phase],
    lastObservationAtMs: latestObservationAtMs(input.state),
    retrySafe,
    validActions,
    priorPairing: input.state.priorActiveScope === null ? "absent" : "present",
    pairingStateChange,
    failureCode,
    supportReceipt: null,
  };
}

const COPY: Readonly<Record<ConnectionPresentationPhase, string>> = {
  preparing: "Preparing the connection…", "awaiting-downgrade-confirmation": "Waiting for confirmation.",
  contacting: "Contacting the server…", "waiting-for-server": "Waiting for the server…",
  "verifying-server": "Verifying the server…", "verifying-identity": "Checking the saved server identity…",
  "discovering-setup": "Checking server setup…", "discovering-sign-in": "Preparing sign-in…",
  "opening-nautilo": "Opening Nautilo…", "saving-connection": "Finishing the connection…", complete: "Connected.",
  failed: "The connection needs attention.", cancelled: "Connection cancelled.",
  "identity-mismatch": "Waiting for your identity decision.", superseded: "A newer connection replaced this attempt.",
};
export function connectionPhaseCopy(phase: ConnectionPresentationPhase): string { return COPY[phase]; }
export function connectionPairingTruthCopy(snapshot: ConnectionPresentation): string {
  if (snapshot.pairingStateChange === "changed") return "The saved connection changed; only finishing actions are available.";
  if (snapshot.pairingStateChange === "indeterminate") return "Nautilo could not confirm whether the saved connection changed.";
  return snapshot.priorPairing === "present" ? "Your current server remains active." : "No server was saved.";
}

const FAILURE_COPY: Readonly<Record<ConnectionPresentationFailureCode, string>> = {
  "invalid-target": "Enter a valid Nautilo server address.",
  "transport-unavailable": "Nautilo could not contact this server.",
  "readiness-unavailable": "The server did not become ready.",
  "health-unavailable": "The server could not complete its compatibility check.",
  "identity-missing": "The server did not provide a valid identity.",
  "identity-mismatch": "This is a different Nautilo server.",
  "setup-discovery-failed": "Nautilo could not check this server’s setup.",
  "auth-discovery-failed": "Nautilo could not prepare sign-in for this server.",
  "unsafe-promotion-origin": "The verified server route changed before it could be saved.",
  "navigation-failed": "Nautilo could not open the verified server.",
  "promotion-failed": "Nautilo could not finish saving the connection.",
  cancelled: "Connection cancelled.",
  superseded: "A newer connection replaced this attempt.",
};
export function connectionFailureCopy(code: ConnectionPresentationFailureCode): string { return FAILURE_COPY[code]; }

export function publishConnectionPresentationListener(snapshot: ConnectionPresentation,
  listener: ((value: ConnectionPresentation) => void) | null): boolean {
  if (!listener) return true;
  try { listener(snapshot); return true; } catch { return false; }
}

export function publishConnectionPresentation<T>(snapshot: ConnectionPresentation, subscribers: Map<number, T>,
  authorized: (id: number, subscriber: T) => boolean, send: (subscriber: T, snapshot: ConnectionPresentation) => void): void {
  for (const [id, subscriber] of subscribers) {
    try {
      if (!authorized(id, subscriber)) throw new Error("inactive presentation subscriber");
      send(subscriber, snapshot);
    } catch { subscribers.delete(id); }
  }
}
