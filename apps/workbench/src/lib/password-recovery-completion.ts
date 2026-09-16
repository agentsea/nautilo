const PASSWORD_RECOVERY_COMPLETE_PENDING_KEY =
  "nautilo:password-recovery-complete-pending";

export interface PasswordRecoveryCompletionProof {
  sessionId: string;
  sessionToken: string;
}

export function markPasswordRecoveryCompletionPending(
  proof: PasswordRecoveryCompletionProof,
): void {
  try {
    window.localStorage.setItem(
      PASSWORD_RECOVERY_COMPLETE_PENDING_KEY,
      JSON.stringify(proof),
    );
  } catch {
    /* best-effort browser hint */
  }
}

export function readPasswordRecoveryCompletionPending():
  | PasswordRecoveryCompletionProof
  | null {
  try {
    const raw = window.localStorage.getItem(PASSWORD_RECOVERY_COMPLETE_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PasswordRecoveryCompletionProof>;
    if (
      typeof parsed.sessionId !== "string" ||
      parsed.sessionId.length === 0 ||
      typeof parsed.sessionToken !== "string" ||
      parsed.sessionToken.length === 0
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      sessionToken: parsed.sessionToken,
    };
  } catch {
    return null;
  }
}

export function clearPasswordRecoveryCompletionPending(): void {
  try {
    window.localStorage.removeItem(PASSWORD_RECOVERY_COMPLETE_PENDING_KEY);
  } catch {
    /* best-effort browser hint */
  }
}
