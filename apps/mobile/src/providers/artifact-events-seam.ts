import type { NautiloApiClient, WorkspaceArtifactEvent } from "@nautilo/api-client/browser";

export type ArtifactEvent = WorkspaceArtifactEvent | { type: "reconnected" };
type ArtifactEventClient = Pick<NautiloApiClient, "setToken" | "subscribeWorkspaceArtifactEvents">;

/** Only an explicit rejected SSE handshake can justify replacing its frozen token URL. */
export function shouldRefreshArtifactEventToken(
  refreshedAfterUnauthorized: boolean,
  current: boolean,
  status: number | undefined,
): boolean {
  return current && !refreshedAfterUnauthorized && status === 401;
}

/**
 * react-native-sse does not poll again from its XMLHttpRequest `onerror`
 * status-0 path. Close that dead handle so a bounded AppState foreground
 * recovery may start a new ordinary stream. Nonzero HTTP failures retain the
 * package's native reconnect behavior unless they are handled 401s above.
 */
export function shouldCloseArtifactEventStreamForLifecycleRecovery(status: number | undefined): boolean {
  return status === undefined;
}

/** Resolves an error that arrived while async startup was still settling. */
export function settleArtifactEventStart(
  pendingUnauthorizedRebind: boolean,
  pendingTransportClose: boolean,
): "subscribed" | "refresh-token" | "wait-for-lifecycle" {
  if (pendingUnauthorizedRebind) return "refresh-token";
  if (pendingTransportClose) return "wait-for-lifecycle";
  return "subscribed";
}

/** A bounded foreground recovery starts a normal stream and invalidates once. */
export function beginArtifactEventLifecycleRecovery(input: {
  nextAppState: string;
  alreadyUsed: boolean;
  startInFlight: boolean;
  hasSubscription: boolean;
  current: boolean;
}): { invalidate: true; forceRefresh: false } | undefined {
  if (
    input.nextAppState !== "active" ||
    input.alreadyUsed ||
    input.startInFlight ||
    input.hasSubscription ||
    !input.current
  ) return undefined;
  return { invalidate: true, forceRefresh: false };
}

/** Testable startup boundary: late token/client work is discarded by provider generation. */
export async function startArtifactEventSubscription(input: {
  client: ArtifactEventClient;
  getToken: () => Promise<string | null>;
  isCurrent: () => boolean;
  onAuthDead: () => void;
  dispatch: (event: ArtifactEvent) => void;
  onError?: (error: { status?: number }) => void;
  onOpen?: (reconnected: boolean) => void;
}): Promise<(() => void) | undefined> {
  try {
    const token = await input.getToken();
    if (!input.isCurrent()) return undefined;
    if (!token) {
      input.onAuthDead();
      return undefined;
    }
    input.client.setToken(token);
    const unsubscribe = input.client.subscribeWorkspaceArtifactEvents((event) => input.dispatch(event), {
      onOpen: (reconnected) => {
        input.onOpen?.(reconnected);
        if (reconnected) input.dispatch({ type: "reconnected" });
      },
      onError: (error) => input.onError?.(error),
    });
    if (!input.isCurrent()) {
      unsubscribe();
      return undefined;
    }
    return unsubscribe;
  } catch {
    // Startup network failure is advisory; focus/manual reads remain available.
    return undefined;
  }
}
