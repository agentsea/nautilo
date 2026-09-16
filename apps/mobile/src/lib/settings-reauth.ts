/**
 * In-memory, one-attempt fence for a Settings action that needs fresh auth.
 *
 * Screens retain the returned attempt id while their auth sheet is active and
 * may resume only that exact action after `reauthenticateToServer` succeeds.
 * Replacing, cancelling, or failing an attempt makes older completions inert,
 * preventing an auth result from resuming the wrong sensitive mutation.
 */
export type SensitiveSettingsAction = () => void | Promise<void>;

/** The server-bound identity that must survive a fresh reauthentication. */
export interface SettingsReauthIdentity {
  serverId: string;
  userId: string;
  actorId: string;
}

export interface SettingsReauthFence {
  /** Fence an action and return the id that authorizes its later resumption. */
  fence(action: SensitiveSettingsAction, expectedIdentity: SettingsReauthIdentity): number;
  /** Run a fenced action once after matching fresh auth verifies the same identity. */
  resumeAfterFreshAuth(
    attemptId: number,
    verifiedIdentity: SettingsReauthIdentity,
  ): Promise<boolean>;
  /** Erase a pending action on cancellation, failure, or screen exit. */
  discard(attemptId?: number): void;
  /** Whether this instance currently holds a sensitive action closure. */
  hasPendingAction(): boolean;
}

export function createSettingsReauthFence(): SettingsReauthFence {
  let nextAttemptId = 0;
  let pending: {
    attemptId: number;
    action: SensitiveSettingsAction;
    expectedIdentity: SettingsReauthIdentity;
  } | null = null;

  return {
    fence(action, expectedIdentity) {
      const attemptId = ++nextAttemptId;
      pending = { attemptId, action, expectedIdentity };
      return attemptId;
    },

    async resumeAfterFreshAuth(attemptId, verifiedIdentity) {
      if (!pending || pending.attemptId !== attemptId) {
        return false;
      }
      if (!sameIdentity(pending.expectedIdentity, verifiedIdentity)) {
        // A different account/server is a terminal failure for this attempt;
        // do not leave its sensitive closure available for a later callback.
        pending = null;
        return false;
      }

      // Consume before invoking user code: a double completion, navigation
      // callback, or action error cannot rerun a sensitive operation.
      const { action } = pending;
      pending = null;
      await action();
      return true;
    },

    discard(attemptId) {
      if (attemptId === undefined || pending?.attemptId === attemptId) {
        pending = null;
      }
    },

    hasPendingAction() {
      return pending !== null;
    },
  };
}

/**
 * Perform fresh authentication and resume exactly the action it fenced.
 *
 * Failure/cancellation always discards the closure and is rethrown for the
 * caller to present its normal auth error state. This helper stays framework
 * agnostic so Settings screens can use it from press handlers or effects.
 */
export async function reauthenticateThenResume(
  fence: SettingsReauthFence,
  reauthenticate: () => Promise<SettingsReauthIdentity>,
  expectedIdentity: SettingsReauthIdentity,
  action: SensitiveSettingsAction,
): Promise<boolean> {
  const attemptId = fence.fence(action, expectedIdentity);
  try {
    const verifiedIdentity = await reauthenticate();
    return await fence.resumeAfterFreshAuth(attemptId, verifiedIdentity);
  } catch (error) {
    fence.discard(attemptId);
    throw error;
  }
}

function sameIdentity(
  expected: SettingsReauthIdentity,
  actual: SettingsReauthIdentity,
): boolean {
  return (
    expected.serverId === actual.serverId &&
    expected.userId === actual.userId &&
    expected.actorId === actual.actorId
  );
}
