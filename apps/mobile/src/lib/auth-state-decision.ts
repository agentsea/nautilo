/** Pure AuthProvider recovery decisions for D468's ownership fence. */
export type AuthRecoveryStatus = "signed-in" | "signed-out";
export type AuthRecoveryViewerState = "stale" | "none";

export interface AuthRecoveryDecision {
  readonly status: AuthRecoveryStatus;
  readonly viewerState: AuthRecoveryViewerState;
  readonly clearViewer: boolean;
  readonly notice: string;
}

/**
 * Never leave the root Auth gate loading after a terminal or transient
 * verification result. A durable owner from an earlier successful `/whoami`
 * remains usable-but-stale during an ordinary network failure. A session that
 * was never durably owner-confirmed must return to a truthful sign-in state.
 */
export function decideAuthRecovery(input: {
  readonly hasDurablyConfirmedOwner: boolean;
  readonly cleanupFailed: boolean;
}): AuthRecoveryDecision {
  if (input.hasDurablyConfirmedOwner) {
    return {
      status: "signed-in",
      viewerState: "stale",
      clearViewer: false,
      notice: input.cleanupFailed
        ? "Nautilo could not finish securing this session. Check your connection and try again."
        : "Nautilo could not verify this session right now. Check your connection and try again.",
    };
  }
  return {
    status: "signed-out",
    viewerState: "none",
    clearViewer: true,
    notice: input.cleanupFailed
      ? "Nautilo could not finish securing this session. Sign in again after resolving the problem."
      : "Nautilo could not verify this session. Sign in again.",
  };
}
