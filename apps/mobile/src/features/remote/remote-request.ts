import {
  ApiError,
  type NautiloApiClient,
} from "@nautilo/api-client/browser";

export interface RemoteServerTarget {
  readonly id: string;
  readonly serverUrl: string;
  readonly displayName: string;
}

export interface SameServerRequestDeps {
  readonly getClient: (serverUrl: string) => NautiloApiClient;
  readonly refreshToken: (
    serverId: string,
    serverUrl: string,
    options: { forceRefresh: true },
  ) => Promise<string | null>;
  readonly authDead: (serverId: string) => void;
}

/**
 * Retry one stale bearer only against the exact server originally selected.
 * The target is immutable for the entire operation; this helper never reads
 * or changes the active-server registry.
 */
export async function runSameServerRemoteRequest<T>(
  target: RemoteServerTarget,
  operation: (client: NautiloApiClient) => Promise<T>,
  deps: SameServerRequestDeps,
): Promise<T> {
  const client = deps.getClient(target.serverUrl);
  try {
    return await operation(client);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const token = await deps.refreshToken(target.id, target.serverUrl, {
      forceRefresh: true,
    });
    if (!token) {
      deps.authDead(target.id);
      throw error;
    }
    client.setToken(token);
    return operation(client);
  }
}
