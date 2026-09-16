export type RuntimeStatementRole = "full" | "agent" | "crypto";

/** Process-local callback for each runtime postgres.js statement (role only; no SQL). */
export type RuntimeStatementObserver = (role: RuntimeStatementRole) => void;

let activeObserver: RuntimeStatementObserver | null = null;
let activeRegistrationId = 0;

/**
 * Bind a process-local observer for runtime postgres.js statements.
 *
 * Pass `null` to clear the active observer. Returns a cleanup function that
 * removes only the registration it created, so a stale cleanup cannot clear a
 * newer observer.
 */
export function setRuntimeStatementObserver(
  observer: RuntimeStatementObserver | null,
): () => void {
  const registrationId = ++activeRegistrationId;
  activeObserver = observer;
  return () => {
    if (registrationId === activeRegistrationId) {
      activeObserver = null;
    }
  };
}

function notifyRuntimeStatement(role: RuntimeStatementRole): void {
  activeObserver?.(role);
}

/** postgres.js `debug` handler that discards all driver args and notifies by role. */
export function createRuntimeStatementDebugHandler(
  role: RuntimeStatementRole,
): (
  connection: number,
  query: string,
  parameters: unknown[],
  paramTypes: unknown[],
) => void {
  return (_connection, _query, _parameters, _paramTypes) => {
    notifyRuntimeStatement(role);
  };
}
