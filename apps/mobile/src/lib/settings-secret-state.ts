/**
 * The recovery secret is deliberately custody-only state: it is visible in
 * memory while its one-time reveal screen is active and is never persisted to
 * SecureStore, AsyncStorage, navigation params, or a query string.
 */
export type RecoverySecretState =
  | { status: "hidden"; secret: null }
  | { status: "revealed"; secret: string };

export type RecoverySecretExit =
  | "dismiss"
  | "navigation"
  | "unmount"
  | "scope-change"
  | "logout"
  | "auth-dead"
  | "error"
  | "abort"
  | "complete";

export type RecoverySecretEvent =
  | { type: "reveal"; secret: string }
  | { type: RecoverySecretExit };

export const EMPTY_RECOVERY_SECRET_STATE: RecoverySecretState = {
  status: "hidden",
  secret: null,
};

/**
 * Pure state transition for one-time recovery secret custody.
 * Every terminal UI path clears the secret synchronously by returning the
 * hidden state; UI code should dispatch its matching exit event in cleanup.
 */
export function transitionRecoverySecretState(
  _current: RecoverySecretState,
  event: RecoverySecretEvent,
): RecoverySecretState {
  if (event.type === "reveal") {
    return { status: "revealed", secret: event.secret };
  }
  return EMPTY_RECOVERY_SECRET_STATE;
}

/** Convenience for effect cleanups and imperative exit handlers. */
export function clearRecoverySecret(): RecoverySecretState {
  return EMPTY_RECOVERY_SECRET_STATE;
}
