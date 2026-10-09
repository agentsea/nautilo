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

export interface ProtectedTaskNodeSettlementScope {
  /**
   * Admit one graph node body before it starts and retain only its settlement
   * lifetime. Arguments, state, results, and errors are never retained here.
   */
  run<Value>(
    name: ProtectedTaskGraphNodeName,
    body: () => Value | PromiseLike<Value>,
  ): Promise<Value>;

  /** Stop admission and wait for every body that was already admitted. */
  closeAndWait(): Promise<void>;
}

type ScopeState = "open" | "closing" | "closed";

/**
 * Process-local lifetime accounting for one protected Task graph invocation.
 *
 * LangGraph may settle its outer stream after cancellation wins a race with a
 * node that ignores AbortSignal. This scope keeps the encrypted saver owner
 * alive until every admitted body returns. It proves worker settlement only;
 * it is not a checkpoint or external-effect replay receipt.
 */
export function createProtectedTaskNodeSettlementScope(signal?: AbortSignal):
ProtectedTaskNodeSettlementScope {
  const active = new Set<Promise<void>>();
  let state: ScopeState = "open";
  let closePromise: Promise<void> | null = null;

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
      if (state !== "open") {
        return Promise.reject(new Error(
          "Protected Task graph node started after settlement closed",
        ));
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

    closeAndWait,
  });

  if (signal?.aborted === true) closeOnAbort();
  else signal?.addEventListener("abort", closeOnAbort, { once: true });
  return scope;
}
