import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";

/**
 * Private signal used only before a foreground model, tool, or checkpoint can
 * run. Job may safely repeat the executor because this signal cannot be
 * created after Agent work has started.
 */
class ForegroundContextPreparationWaitingError extends Error {
  readonly code = "foreground_encrypted_context_waiting";

  constructor(
    readonly enforcement: StrictShadowEnforcementError,
    readonly authorizationDeadlineAt?: number,
  ) {
    super("Foreground encrypted context is waiting for authority", {
      cause: enforcement,
    });
    this.name = "ForegroundContextPreparationWaitingError";
  }
}

export function isForegroundContextPreparationWaitingError(
  error: unknown,
): error is ForegroundContextPreparationWaitingError {
  return error instanceof ForegroundContextPreparationWaitingError;
}

/** Mark only retryable Strict failures from the pre-model context phase. */
export async function prepareForegroundEncryptedContext<Value>(
  work: () => Promise<Value>,
  authorizationDeadlineAt?: number,
): Promise<Value> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof StrictShadowEnforcementError
      && error.decision.retryable
      && (
        error.decision.state === "waiting_for_authority"
        || error.decision.state === "repairing"
      )
    ) {
      throw new ForegroundContextPreparationWaitingError(
        error,
        authorizationDeadlineAt,
      );
    }
    throw error;
  }
}
