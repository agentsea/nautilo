import { serverIdFromUrl } from "@/lib/server-store.web";
import type { MobileWebAuthSession } from "@/lib/browser-auth-session";

export interface BrowserAuthExclusiveRunner {
  <T>(operation: () => Promise<T>): Promise<T>;
}

export interface BrowserAuthLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface InstalledBrowserAuth {
  readonly serverId: string;
  readonly serverOrigin: string;
  readonly session: MobileWebAuthSession;
  readonly runExclusive: BrowserAuthExclusiveRunner;
}

let installed: InstalledBrowserAuth | null = null;

export function createBrowserAuthExclusiveRunner(
  appId: string,
  lockManager: BrowserAuthLockManager | null | undefined,
): BrowserAuthExclusiveRunner {
  const lockName = `nautilo:mobile-web:oidc:${appId}`;
  return lockManager
    ? <T>(operation: () => Promise<T>) => lockManager.request(lockName, operation)
    : <T>(operation: () => Promise<T>) => operation();
}

export function installBrowserAuth(input: InstalledBrowserAuth): () => void {
  installed = input;
  return () => {
    if (installed === input) installed = null;
  };
}

function matchingInstalledAuth(serverId: string, baseUrl: string): InstalledBrowserAuth | null {
  if (!installed || installed.serverId !== serverId) return null;
  try {
    const origin = new URL(baseUrl).origin;
    if (origin !== installed.serverOrigin || serverIdFromUrl(origin) !== serverId) return null;
    return installed;
  } catch {
    return null;
  }
}

/** Browser equivalent of native token recovery, backed only by Logto browser storage. */
export async function ensureValidToken(
  serverId: string,
  baseUrl: string,
  options?: Readonly<{ forceRefresh?: boolean }>,
): Promise<string | null> {
  const auth = matchingInstalledAuth(serverId, baseUrl);
  if (!auth) return null;
  return auth.runExclusive(() => auth.session.getAccessToken(options));
}

/** Clear the installed browser session only when its exact server still owns it. */
export async function signOutServer(serverId: string): Promise<void> {
  const auth = installed?.serverId === serverId ? installed : null;
  if (!auth) return;
  await auth.runExclusive(() => auth.session.signOut());
}

/** Remove browser credentials without starting the identity-provider logout redirect. */
export async function clearBrowserAuthSession(serverId: string): Promise<void> {
  const auth = installed?.serverId === serverId ? installed : null;
  if (!auth) return;
  await auth.runExclusive(() => auth.session.clearLocalSession());
}

export function hasInstalledBrowserAuth(serverId: string, baseUrl: string): boolean {
  return matchingInstalledAuth(serverId, baseUrl) !== null;
}
