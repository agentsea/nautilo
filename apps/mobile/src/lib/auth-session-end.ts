/**
 * D468 authenticated session-ending order.
 *
 * A server session cannot be made unreachable locally until its matching
 * Mobile push binding has either been authenticated-revoked or retained as a
 * durable proof-only tombstone. Keeping this as a small pure coordinator
 * makes that ordering and per-server auth-dead coalescing testable without a
 * React runtime.
 */
export interface AuthSessionEndTarget {
  readonly serverId: string;
  readonly serverUrl: string;
  /** `undefined` asks the coordinator to capture the currently stored bearer. */
  readonly bearerToken: string | null | undefined;
  /** Runs only after all local cleanup has completed. */
  readonly commitSignedOut?: () => void | Promise<void>;
}

export interface AuthSessionEndCoordinatorDeps {
  readonly loadStoredBearer: (serverId: string) => Promise<string | null>;
  readonly releasePushBinding: (input: {
    serverId: string;
    serverUrl: string;
    bearerToken: string | null;
  }) => Promise<unknown>;
  readonly clearClientBearer: (serverUrl: string) => void;
  readonly clearViewerCache: (serverId: string) => Promise<void>;
  readonly clearTokens: (serverId: string) => Promise<void>;
}

export interface AuthSessionEndCoordinator {
  /** Same-server calls share the one durable cleanup operation. */
  end(target: AuthSessionEndTarget): Promise<void>;
}

export function createAuthSessionEndCoordinator(
  deps: AuthSessionEndCoordinatorDeps,
): AuthSessionEndCoordinator {
  const inFlightByServer = new Map<string, Promise<void>>();

  return {
    end(target) {
      const existing = inFlightByServer.get(target.serverId);
      if (existing) return existing;
      const operation = (async () => {
        const bearerToken = target.bearerToken === undefined
          ? await deps.loadStoredBearer(target.serverId)
          : target.bearerToken;
        // This may reject if neither authenticated revoke nor durable proof
        // persistence succeeded. In that case *nothing* below may run.
        await deps.releasePushBinding({
          serverId: target.serverId,
          serverUrl: target.serverUrl,
          bearerToken,
        });
        deps.clearClientBearer(target.serverUrl);
        await deps.clearViewerCache(target.serverId);
        await deps.clearTokens(target.serverId);
        await target.commitSignedOut?.();
      })();
      inFlightByServer.set(target.serverId, operation);
      void operation.finally(() => {
        if (inFlightByServer.get(target.serverId) === operation) {
          inFlightByServer.delete(target.serverId);
        }
      }).catch(() => {});
      return operation;
    },
  };
}
