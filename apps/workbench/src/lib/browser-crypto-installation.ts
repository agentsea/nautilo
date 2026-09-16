const KEY = "nautilo.crypto.browser-installation.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface BrowserCryptoAccountCoordinate {
  readonly serverScope: string;
  readonly userId: string;
  readonly humanActorId: string;
}

function accountKey(account: BrowserCryptoAccountCoordinate): string {
  return `${KEY}.account.${encodeURIComponent(account.serverScope)}.${account.userId}.${account.humanActorId}`;
}

/** Public opaque installation coordinate; never contains keys or recovery data. */
export function readOrCreateBrowserCryptoInstallationId(
  account?: BrowserCryptoAccountCoordinate,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const scoped = account === undefined
      ? null
      : window.localStorage.getItem(accountKey(account));
    if (scoped !== null) return UUID.test(scoped) ? scoped : null;
    const existing = window.localStorage.getItem(KEY);
    if (existing !== null) return UUID.test(existing) ? existing : null;
    const created = crypto.randomUUID();
    window.localStorage.setItem(KEY, created);
    return window.localStorage.getItem(KEY) === created ? created : null;
  } catch {
    return null;
  }
}

/**
 * Replace only the Browser crypto coordinate after recovery succeeds. Sign-in
 * and every non-crypto browser identity remain unchanged.
 */
export function activateFreshBrowserCryptoInstallationId(
  installationId: string,
  account?: BrowserCryptoAccountCoordinate,
): boolean {
  if (typeof window === "undefined" || !UUID.test(installationId)) return false;
  try {
    const key = account === undefined ? KEY : accountKey(account);
    window.localStorage.setItem(key, installationId);
    return window.localStorage.getItem(key) === installationId;
  } catch {
    return false;
  }
}
