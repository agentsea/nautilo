export type RealtimeOpenState = Readonly<{
  scopeId: string | null;
  /** False while an open is waiting for identity repair or the transport is closed. */
  settled: boolean;
  openRevision: number;
  /** Opens that require canonical recovery: reconnects and stale first opens. */
  recoveryRevision: number;
}>;

export type RealtimeOpenTransition = Readonly<{
  kind: "initial" | "reconnect";
  /** The open must repair canonical identity before consumers may observe it. */
  needsIdentityRefresh: boolean;
  state: RealtimeOpenState;
}>;

export function initialRealtimeOpenState(scopeId: string | null): RealtimeOpenState {
  return { scopeId, settled: false, openRevision: 0, recoveryRevision: 0 };
}

/**
 * Classify successful opens inside one authenticated Server scope. Consumers
 * must not infer recovery from raw transport states: authenticating -> open is
 * the ordinary first connection as well as a reconnect transition.
 */
export function advanceRealtimeOpenState(
  current: RealtimeOpenState,
  scopeId: string,
  options: { viewerVerified?: boolean } = {},
): RealtimeOpenTransition {
  if (current.scopeId !== scopeId || current.openRevision === 0) {
    const needsIdentityRefresh = options.viewerVerified === false;
    return {
      kind: "initial",
      needsIdentityRefresh,
      state: {
        scopeId,
        settled: true,
        openRevision: 1,
        recoveryRevision: needsIdentityRefresh ? 1 : 0,
      },
    };
  }
  return {
    kind: "reconnect",
    needsIdentityRefresh: true,
    state: {
      scopeId,
      settled: true,
      openRevision: current.openRevision + 1,
      recoveryRevision: current.recoveryRevision + 1,
    },
  };
}

/**
 * Testable render boundary: one Server must never observe another Server's
 * revisions, and consumers must wait until any required identity repair ends.
 */
export function visibleRealtimeOpenState(
  published: RealtimeOpenState,
  currentScopeId: string | null,
): RealtimeOpenState {
  return published.scopeId === currentScopeId && published.settled
    ? published
    : initialRealtimeOpenState(currentScopeId);
}

/**
 * Wait for this connection's identity repair to win AuthProvider's
 * latest-request-wins fence. A stale result means another caller superseded
 * this request, so retry while the same socket open still owns the boundary.
 */
export async function settleRealtimeIdentityRefresh(
  refreshViewer: () => Promise<"verified" | "failed" | "stale">,
  isCurrent: () => boolean,
): Promise<boolean> {
  while (isCurrent()) {
    try {
      const result = await refreshViewer();
      if (!isCurrent()) return false;
      if (result !== "stale") return true;
    } catch {
      return isCurrent();
    }
  }
  return false;
}
