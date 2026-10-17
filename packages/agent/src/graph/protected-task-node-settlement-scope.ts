export type ProtectedTaskGraphNodeName =
  | "pre_model"
  | "browser_decision"
  | "agent"
  | "model_output_preflight"
  | "projection_preflight"
  | "ordinary_content_access_preflight"
  | "post_model"
  | "tools"
  | "await_reply";

export type ProtectedTaskCheckpointPauseReason =
  | "manual_pause"
  | "time_limit"
  | "grant_refresh";

/**
 * Process-local request to stop admitting protected graph nodes at the next
 * boundary. The first request owns the reason for this invocation.
 */
export interface ProtectedTaskCheckpointPauseController {
  request(reason: ProtectedTaskCheckpointPauseReason): boolean;
  currentRequestedReason(): ProtectedTaskCheckpointPauseReason | null;
}

/** Typed interruption emitted before a paused graph node body is admitted. */
export type ProtectedTaskCheckpointPauseInterruption = Error & Readonly<{
  reason: ProtectedTaskCheckpointPauseReason;
}>;

const checkpointPauseInterruptions = new WeakSet<object>();

function checkpointPauseInterruption(
  reason: ProtectedTaskCheckpointPauseReason,
): ProtectedTaskCheckpointPauseInterruption {
  const interruption = new Error(
    "Protected Task checkpoint pause requested",
  ) as ProtectedTaskCheckpointPauseInterruption;
  interruption.name = "ProtectedTaskCheckpointPauseInterruption";
  Object.defineProperty(interruption, "reason", {
    value: reason,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  checkpointPauseInterruptions.add(interruption);
  // LangGraph annotates node failures with `pregelTaskId`. Keep the Error
  // extensible while the WeakSet brand and immutable reason remain private.
  return interruption;
}

/** Refuses lookalike Errors; only this module can mint the interruption. */
export function isProtectedTaskCheckpointPauseInterruption(
  value: unknown,
): value is ProtectedTaskCheckpointPauseInterruption {
  return typeof value === "object"
    && value !== null
    && checkpointPauseInterruptions.has(value);
}

export function createProtectedTaskCheckpointPauseController():
ProtectedTaskCheckpointPauseController {
  let requestedReason: ProtectedTaskCheckpointPauseReason | null = null;
  return Object.freeze({
    request(reason: ProtectedTaskCheckpointPauseReason): boolean {
      if (
        reason !== "manual_pause"
        && reason !== "time_limit"
        && reason !== "grant_refresh"
      ) {
        throw new TypeError("Protected Task checkpoint pause reason is invalid");
      }
      if (requestedReason !== null) return false;
      requestedReason = reason;
      return true;
    },
    currentRequestedReason(): ProtectedTaskCheckpointPauseReason | null {
      return requestedReason;
    },
  });
}

export interface ProtectedTaskNodeSettlementScope {
  /**
   * Admit one graph node body before it starts and retain only its settlement
   * lifetime. Arguments, state, and results are never retained here. The first
   * stream-consumer failure may be retained only for this invocation so later
   * node bodies reject with that exact failure.
   */
  run<Value>(
    name: ProtectedTaskGraphNodeName,
    body: () => Value | PromiseLike<Value>,
  ): Promise<Value>;

  /** Retain the first stream-consumer failure and reject every future body. */
  fail(error: Error): boolean;

  /** Stop admission and wait for every body that was already admitted. */
  closeAndWait(): Promise<void>;
}

type ScopeState = "open" | "closing" | "closed";

function authorizationAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("Protected Task authorization was revoked", {
    cause: signal.reason,
  });
}

/**
 * Process-local lifetime accounting for one protected Task graph invocation.
 *
 * LangGraph may settle its outer stream after cancellation wins a race with a
 * node that ignores AbortSignal. This scope keeps the encrypted saver owner
 * alive until every admitted body returns. It proves worker settlement only;
 * it is not a checkpoint or external-effect replay receipt.
 */
export function createProtectedTaskNodeSettlementScope(signal?: AbortSignal):
ProtectedTaskNodeSettlementScope;
export function createProtectedTaskNodeSettlementScope(
  signal: AbortSignal | undefined,
  pause: ProtectedTaskCheckpointPauseController | undefined,
): ProtectedTaskNodeSettlementScope;
export function createProtectedTaskNodeSettlementScope(
  signal?: AbortSignal,
  pause?: ProtectedTaskCheckpointPauseController,
): ProtectedTaskNodeSettlementScope {
  const active = new Set<Promise<void>>();
  let state: ScopeState = "open";
  let closePromise: Promise<void> | null = null;
  let failed = false;
  let failure: Error | null = null;

  const closeAndWait = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    state = "closing";
    signal?.removeEventListener("abort", closeOnAbort);
    closePromise = Promise.all([...active]).then(() => {
      state = "closed";
    });
    return closePromise;
  };
  const closeOnAbort = (): void => {
    void closeAndWait();
  };

  const scope: ProtectedTaskNodeSettlementScope = Object.freeze({
    run<Value>(
      _name: ProtectedTaskGraphNodeName,
      body: () => Value | PromiseLike<Value>,
    ): Promise<Value> {
      // Authorization revocation is stronger than a cooperative pause, even
      // when both become observable before this admission attempt.
      if (signal?.aborted === true) {
        return Promise.reject(authorizationAbortError(signal));
      }
      if (failed) return Promise.reject(failure!);
      if (state !== "open") {
        return Promise.reject(new Error(
          "Protected Task graph node started after settlement closed",
        ));
      }
      const requestedReason = pause?.currentRequestedReason() ?? null;
      if (requestedReason !== null) {
        return Promise.reject(checkpointPauseInterruption(requestedReason));
      }

      const settled = Promise.withResolvers<void>();
      active.add(settled.promise);
      let result: Promise<Value>;
      try {
        result = Promise.resolve(body());
      } catch (error) {
        result = Promise.reject(
          error instanceof Error
            ? error
            : new Error("Protected Task graph node failed", { cause: error }),
        );
      }
      void result.then(
        () => settled.resolve(),
        () => settled.resolve(),
      ).finally(() => {
        active.delete(settled.promise);
      });
      return result;
    },

    fail(error: Error): boolean {
      if (state !== "open" || failed) return false;
      failed = true;
      failure = error;
      return true;
    },

    closeAndWait,
  });

  if (signal?.aborted === true) closeOnAbort();
  else signal?.addEventListener("abort", closeOnAbort, { once: true });
  return scope;
}
