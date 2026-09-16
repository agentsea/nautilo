/**
 * M056 — shared "give me a fresh Logto access token" helper.
 *
 * The IPC handler at `main.ts:auth:getAccessToken` and the
 * relay-pair flow in `relay-pair.ts` both need the same
 * load-then-refresh-if-expiring dance. Pulling it out keeps the
 * two callers from drifting and gives the renderer / pair flow a
 * single observable place to instrument.
 *
 * Stale-token drop + broadcast: {@link reportStaleToken} in `./report-stale-token`.
 */
import { isAccessTokenExpiring } from "./refresh";
import { loadTokens } from "./token-store-electron";

/**
 * Resolve a usable access token. Returns null when:
 *   - no tokens are persisted (user never signed in or signed out),
 *   - the access token is expiring AND refresh failed,
 *   - the caller passed a no-op refresher and the bundle is stale.
 *
 * The refresher is injected so tests + the IPC handler can wire
 * their own. In production both call sites pass the
 * `refreshTokens()` wrapper from `main.ts` which already has
 * `logtoConfig` bound.
 *
 * Optional `onObservedRejection` runs after a failed refresh when the
 * bundle was expiring (e.g. main wires menu + multi-window broadcast).
 */
export async function getValidAccessToken(args: {
  refresh: () => Promise<{ access_token: string } | null>;
  /**
   * Called when the caller has externally observed an authenticated
   * request was refused (e.g. workbench renderer reported a 401 via IPC),
   * or when `refresh` returns null after the access token was expiring.
   */
  onObservedRejection?: () => void | Promise<void>;
}): Promise<string | null> {
  const bundle = loadTokens();
  if (!bundle) return null;
  if (!isAccessTokenExpiring(bundle)) return bundle.access_token;
  const refreshed = await args.refresh();
  if (!refreshed) {
    if (args.onObservedRejection) await args.onObservedRejection();
    return null;
  }
  return refreshed.access_token;
}
