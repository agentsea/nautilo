/**
 * Serialized environment-effect adapter for the pure first-owner claim
 * machine. This deliberately owns neither React rendering nor browser storage:
 * the route/auth/storage adapter closes over those authorities and presents
 * only redacted command outcomes here.
 */
import {
  createOwnerClaimMachineState,
  transitionOwnerClaim,
  type OwnerClaimCommand,
  type OwnerClaimContinuation,
  type OwnerClaimEvent,
  type OwnerClaimMachineState,
  type OwnerClaimPhase,
  type OwnerClaimTransition,
} from "./owner-claim-machine";

declare const ownerClaimOperationIdBrand: unique symbol;
export type OwnerClaimOperationId = number & {
  readonly [ownerClaimOperationIdBrand]: "OwnerClaimOperationId";
};

export type OwnerClaimCommandKind = OwnerClaimCommand["kind"];
export type OwnerClaimNavigationIntent = "guide" | "product" | null;
export type OwnerClaimEffectClassification =
  | "started"
  | "succeeded"
  | "failed"
  | "aborted"
  | "stale"
  | "unsupported";

/**
 * Deliberately bounded, redacted qualification observation. No other values
 * can be placed in this payload: the effect adapter keeps all authority and
 * Human input inside its own closure.
 */
export interface OwnerClaimCoordinatorTraceEvent {
  readonly operationId: OwnerClaimOperationId;
  readonly phase: OwnerClaimPhase;
  readonly commandKind: OwnerClaimCommandKind;
  readonly result: OwnerClaimEffectClassification;
  readonly navigationIntent: OwnerClaimNavigationIntent;
}

export type OwnerClaimCoordinatorEventSink = (event: OwnerClaimCoordinatorTraceEvent) => void;

export const NOOP_OWNER_CLAIM_COORDINATOR_EVENT_SINK: OwnerClaimCoordinatorEventSink = () => undefined;

export interface OwnerClaimEffectRequest {
  readonly operationId: OwnerClaimOperationId;
  readonly command: OwnerClaimCommand;
  readonly signal: AbortSignal;
}

/**
 * A dependency adapter translates server/auth/browser work into an outcome
 * without exposing its claim, prepared state, bearer, profile, PIN or recovery
 * material to the coordinator. Each outcome is intentionally small enough to
 * map directly to one pure-machine event.
 */
export type OwnerClaimEffectOutcome =
  | { readonly commandKind: "preview-claim"; readonly result: "resolved"; readonly continuation?: OwnerClaimContinuation }
  | { readonly commandKind: "preview-claim"; readonly result: "unavailable" | "failed" }
  | { readonly commandKind: "prepare-signup"; readonly result: "prepared" | "failed" }
  | { readonly commandKind: "prepare-resume"; readonly result: "prepared" | "failed" }
  | { readonly commandKind: "launch-logto-signup"; readonly result: "launched" | "failed" }
  | { readonly commandKind: "launch-logto-signin"; readonly result: "launched" | "failed" }
  | { readonly commandKind: "sign-out"; readonly result: "completed" | "failed" }
  | { readonly commandKind: "bind-subject"; readonly result: "resolved" | "reserved" | "ambiguous" | "failed" }
  | { readonly commandKind: "reobserve-bind"; readonly result: "resolved" | "reserved" | "failed" }
  | { readonly commandKind: "complete-profile"; readonly result: "recovery-ready" | "ambiguous" | "failed" }
  | { readonly commandKind: "reobserve-completion"; readonly result: "recovery-ready" | "pending" | "failed" }
  | { readonly commandKind: "navigate-guide"; readonly result: "completed" | "failed" }
  | { readonly commandKind: "navigate-product"; readonly result: "completed" | "failed" };

export interface OwnerClaimEffectAdapter {
  execute(request: OwnerClaimEffectRequest): Promise<OwnerClaimEffectOutcome>;
}

export interface OwnerClaimCoordinatorDependencies {
  readonly effects: OwnerClaimEffectAdapter;
  readonly eventSink?: OwnerClaimCoordinatorEventSink;
  readonly onStateChange?: (state: OwnerClaimMachineState, transition: OwnerClaimTransition) => void;
  readonly initialState?: OwnerClaimMachineState;
}

export type OwnerClaimCoordinatorInvalidation = "route" | "auth" | "checkpoint";

/** Human, route and auth observations accepted at the coordinator boundary. */
export type OwnerClaimCoordinatorInputEvent = Exclude<
  OwnerClaimEvent,
  | { readonly type: "preview-resolved" }
  | { readonly type: "preview-failed" }
  | { readonly type: "prepared" }
  | { readonly type: "prepare-failed" }
  | { readonly type: "sign-out-failed" }
  | { readonly type: "bind-resolved" }
  | { readonly type: "bind-failed" }
  | { readonly type: "bind-ambiguous" }
  | { readonly type: "completion-resolved" }
  | { readonly type: "completion-failed" }
  | { readonly type: "reobserve-resolved" }
  | { readonly type: "reobserve-failed" }
  | { readonly type: "finalized" }
  | { readonly type: "finalization-failed" }
>;

interface ActiveOperation {
  readonly id: OwnerClaimOperationId;
  readonly phase: OwnerClaimPhase;
  readonly command: OwnerClaimCommand;
  readonly controller: AbortController;
  readonly generation: number;
}

function navigationIntentFor(command: OwnerClaimCommand): OwnerClaimNavigationIntent {
  if (command.kind === "navigate-guide") return "guide";
  if (command.kind === "navigate-product") return "product";
  return null;
}

function isMutation(command: OwnerClaimCommand): boolean {
  switch (command.kind) {
    case "prepare-signup":
    case "prepare-resume":
    case "sign-out":
    case "bind-subject":
    case "reobserve-bind":
    case "complete-profile":
      return true;
    case "preview-claim":
    case "launch-logto-signup":
    case "launch-logto-signin":
    case "reobserve-completion":
    case "navigate-guide":
    case "navigate-product":
      return false;
    default:
      return assertNever(command);
  }
}

function resultEventFor(outcome: OwnerClaimEffectOutcome): OwnerClaimEvent | null {
  switch (outcome.commandKind) {
    case "preview-claim":
      return outcome.result === "resolved"
        ? { type: "preview-resolved", ...(outcome.continuation === undefined ? {} : { continuation: outcome.continuation }) }
        : { type: "preview-failed", reason: outcome.result === "unavailable" ? "unavailable" : "failed" };
    case "prepare-signup":
      return outcome.result === "prepared" ? { type: "prepared", intent: "signup" } : { type: "prepare-failed" };
    case "prepare-resume":
      return outcome.result === "prepared" ? { type: "prepared", intent: "signin" } : { type: "prepare-failed" };
    case "launch-logto-signup":
    case "launch-logto-signin":
      return outcome.result === "launched" ? null : { type: "callback", outcome: "failed" };
    case "sign-out":
      return outcome.result === "completed" ? null : { type: "sign-out-failed" };
    case "bind-subject":
      return outcome.result === "resolved"
        ? { type: "bind-resolved" }
        : outcome.result === "ambiguous"
          ? { type: "bind-ambiguous" }
        : { type: "bind-failed", reason: outcome.result === "reserved" ? "reserved" : "failed" };
    case "reobserve-bind":
      return outcome.result === "resolved"
        ? { type: "bind-resolved" }
        : { type: "bind-failed", reason: outcome.result === "reserved" ? "reserved" : "failed" };
    case "complete-profile":
      return outcome.result === "recovery-ready"
        ? { type: "completion-resolved", outcome: "recovery-ready" }
        : outcome.result === "ambiguous"
          ? { type: "completion-resolved", outcome: "ambiguous" }
          : { type: "completion-failed" };
    case "reobserve-completion":
      return outcome.result === "failed"
        ? { type: "reobserve-failed" }
        : { type: "reobserve-resolved", outcome: outcome.result };
    case "navigate-guide":
    case "navigate-product":
      return outcome.result === "completed" ? { type: "finalized" } : { type: "finalization-failed" };
    default:
      return assertNever(outcome);
  }
}

function failureEventFor(command: OwnerClaimCommand): OwnerClaimEvent {
  switch (command.kind) {
    case "preview-claim":
      return { type: "preview-failed", reason: "failed" };
    case "prepare-signup":
    case "prepare-resume":
      return { type: "prepare-failed" };
    case "launch-logto-signup":
    case "launch-logto-signin":
      return { type: "callback", outcome: "failed" };
    case "sign-out":
      return { type: "sign-out-failed" };
    case "bind-subject":
    case "reobserve-bind":
      return { type: "bind-failed", reason: "failed" };
    case "complete-profile":
      return { type: "completion-failed" };
    case "reobserve-completion":
      return { type: "reobserve-failed" };
    case "navigate-guide":
    case "navigate-product":
      return { type: "finalization-failed" };
    default:
      return assertNever(command);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/**
 * Creates one owner-only coordinator. `dispatch` is synchronous and drains a
 * serial event queue; environment work is then observed asynchronously behind
 * an operation-generation fence. Route/auth/checkpoint invalidation aborts the
 * active effect, clears commands derived from it and makes any late response
 * inert.
 */
export function createOwnerClaimCoordinator(
  dependencies: OwnerClaimCoordinatorDependencies,
): {
  readonly dispatch: (event: OwnerClaimCoordinatorInputEvent) => void;
  readonly invalidate: (reason: OwnerClaimCoordinatorInvalidation) => void;
  readonly dispose: () => void;
  readonly getState: () => OwnerClaimMachineState;
  readonly getActiveOperationId: () => OwnerClaimOperationId | null;
} {
  let state = dependencies.initialState ?? createOwnerClaimMachineState();
  let disposed = false;
  let draining = false;
  let generation = 0;
  let nextOperation = 0;
  let activeOperation: ActiveOperation | null = null;
  // An AbortSignal cannot prove that a mutating transport stopped at the
  // server. Do not start a successor mutation until its old promise settles;
  // meanwhile a read-only canonical reobservation may still run.
  const retiringMutations = new Set<OwnerClaimOperationId>();
  const eventQueue: OwnerClaimEvent[] = [];
  const commandQueue: OwnerClaimCommand[] = [];
  const eventSink = dependencies.eventSink ?? NOOP_OWNER_CLAIM_COORDINATOR_EVENT_SINK;

  const trace = (
    operation: Pick<ActiveOperation, "id" | "phase" | "command">,
    result: OwnerClaimEffectClassification,
  ): void => {
    eventSink({
      operationId: operation.id,
      phase: operation.phase,
      commandKind: operation.command.kind,
      result,
      navigationIntent: navigationIntentFor(operation.command),
    });
  };

  const invalidateActive = (): void => {
    generation += 1;
    commandQueue.length = 0;
    if (activeOperation !== null) {
      const previous = activeOperation;
      activeOperation = null;
      if (isMutation(previous.command)) retiringMutations.add(previous.id);
      previous.controller.abort();
      trace(previous, "aborted");
    }
  };

  const isCurrent = (operation: ActiveOperation): boolean =>
    !disposed
    && activeOperation?.id === operation.id
    && activeOperation.generation === operation.generation
    && generation === operation.generation
    && !operation.controller.signal.aborted;

  const finishOperation = (operation: ActiveOperation): void => {
    if (activeOperation?.id === operation.id) activeOperation = null;
  };

  const releaseRetiringMutation = (operation: ActiveOperation): void => {
    retiringMutations.delete(operation.id);
  };

  const runNextCommand = (): void => {
    if (disposed || activeOperation !== null) return;
    const commandIndex = commandQueue.findIndex((candidate) =>
      retiringMutations.size === 0 || !isMutation(candidate));
    if (commandIndex < 0) return;
    const [command] = commandQueue.splice(commandIndex, 1);
    if (command === undefined) return;

    const operation: ActiveOperation = {
      id: (++nextOperation) as OwnerClaimOperationId,
      phase: state.phase,
      command,
      controller: new AbortController(),
      generation,
    };
    activeOperation = operation;
    trace(operation, "started");

    void dependencies.effects.execute({
      operationId: operation.id,
      command: operation.command,
      signal: operation.controller.signal,
    }).then((outcome) => {
      if (!isCurrent(operation)) {
        releaseRetiringMutation(operation);
        trace(operation, "stale");
        runNextCommand();
        return;
      }
      finishOperation(operation);
      if (outcome.commandKind !== operation.command.kind) {
        trace(operation, "unsupported");
        dispatchMachineEvent(failureEventFor(operation.command));
        runNextCommand();
        return;
      }
      trace(operation, outcome.result === "failed" || outcome.result === "unavailable" || outcome.result === "reserved" || outcome.result === "ambiguous"
        ? "failed"
        : "succeeded");
      const event = resultEventFor(outcome);
      if (event !== null) dispatchMachineEvent(event);
      runNextCommand();
    }).catch((error: unknown) => {
      if (!isCurrent(operation)) {
        releaseRetiringMutation(operation);
        trace(operation, "stale");
        runNextCommand();
        return;
      }
      finishOperation(operation);
      // Abort is only quiet when this operation is still current. An external
      // abort is a real recoverable failure; invalidation has already made its
      // operation stale above.
      trace(operation, isAbortError(error) ? "aborted" : "failed");
      dispatchMachineEvent(failureEventFor(operation.command));
      runNextCommand();
    });
  };

  /**
   * Logto's browser session intentionally reports `signing-in` as soon as its
   * launch call begins. That observation belongs to the launch currently in
   * flight; aborting it makes its eventual rejection invisible and leaves the
   * machine unable to report an authentication failure. This is deliberately
   * narrower than an auth invalidation exemption: it permits only the exact
   * signed-out -> signing-in observation for the matching callback launch.
   */
  const keepsExpectedAuthLaunch = (event: OwnerClaimEvent): boolean => {
    if (event.type !== "auth" || event.auth !== "signing-in") return false;
    if (state.phase !== "awaiting-callback" || state.auth !== "signed-out") return false;
    if (activeOperation?.phase !== "awaiting-callback") return false;
    return activeOperation.command.kind === "launch-logto-signup"
      || activeOperation.command.kind === "launch-logto-signin";
  };

  const processEvent = (event: OwnerClaimEvent): void => {
    const authChanged = event.type === "auth" && event.auth !== state.auth;
    const checkpointChanged = event.type === "checkpoint";
    if ((authChanged && !keepsExpectedAuthLaunch(event)) || checkpointChanged) invalidateActive();

    const transition = transitionOwnerClaim(state, event);
    state = transition.state;
    dependencies.onStateChange?.(state, transition);
    if (transition.commands.length > 0) {
      commandQueue.push(...transition.commands);
      runNextCommand();
    }
  };

  const dispatchMachineEvent = (event: OwnerClaimEvent): void => {
    if (disposed) return;
    eventQueue.push(event);
    if (draining) return;
    draining = true;
    try {
      while (!disposed) {
        const next = eventQueue.shift();
        if (next === undefined) break;
        processEvent(next);
      }
    } finally {
      draining = false;
    }
  };

  return {
    dispatch: dispatchMachineEvent,
    invalidate: (_reason) => {
      if (!disposed) invalidateActive();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      invalidateActive();
      eventQueue.length = 0;
    },
    getState: () => state,
    getActiveOperationId: () => activeOperation?.id ?? null,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled owner-claim coordinator value: ${String(value)}`);
}
