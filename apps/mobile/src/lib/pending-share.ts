import {
  SHARED_TEXT_INTENT_MAX_BYTES,
  type SharedTextIntent,
} from "@/lib/share-handoff";

export type PendingShareScope = { readonly serverId: string; readonly viewerId: string };

export type PendingShareStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

const KEY = "nautilo.pending-share.v1.device";
const MAX_AGE_MS = 10 * 60 * 1000;

type StoredPendingShare = SharedTextIntent & {
  readonly version: 1;
  readonly savedAt: number;
  readonly scope?: { readonly server: string; readonly viewer: string };
};

function validScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function storedScope(scope: PendingShareScope): { readonly server: string; readonly viewer: string } {
  if (!validScopeId(scope.serverId) || !validScopeId(scope.viewerId)) throw new RangeError("Invalid pending share scope");
  // Scope belongs in encrypted device metadata. It is authority, not a
  // display/privacy field, so lossy hashing is never acceptable here.
  return { server: scope.serverId, viewer: scope.viewerId };
}

function exactScope(record: StoredPendingShare, scope: PendingShareScope): boolean {
  const expected = storedScope(scope);
  return record.scope?.server === expected.server && record.scope.viewer === expected.viewer;
}

function isValidPendingIntent(value: StoredPendingShare): boolean {
  return value.version === 1
    && (value.kind === "text" || value.kind === "url")
    && typeof value.id === "string"
    && /^[a-zA-Z0-9-]{8,80}$/.test(value.id)
    && typeof value.value === "string"
    && new TextEncoder().encode(value.value).byteLength <= SHARED_TEXT_INTENT_MAX_BYTES
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt))
    && Number.isFinite(value.savedAt)
    && (value.scope === undefined || (
      typeof value.scope === "object" && value.scope !== null
      && validScopeId(value.scope.server) && validScopeId(value.scope.viewer)
    ));
}

function defaultStore(): PendingShareStore & { readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number } {
  // Keep the pure custody contract runnable in Bun; native code is resolved
  // only when the app persists an actual shared item.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("expo-secure-store") as PendingShareStore & { readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number };
}

export async function savePendingShare(
  intent: SharedTextIntent,
  store: PendingShareStore = defaultStore(),
  now = Date.now(),
  scope: PendingShareScope | null = null,
): Promise<void> {
  const record: StoredPendingShare = {
    ...intent,
    version: 1,
    savedAt: now,
    ...(scope ? { scope: storedScope(scope) } : {}),
  };
  if (!isValidPendingIntent(record)) {
    throw new RangeError("Shared text is not eligible for bounded encrypted custody");
  }
  const accessibility = "WHEN_UNLOCKED_THIS_DEVICE_ONLY" in store
    ? (store as PendingShareStore & { readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number }).WHEN_UNLOCKED_THIS_DEVICE_ONLY
    : undefined;
  await store.setItemAsync(
    KEY,
    JSON.stringify(record),
    accessibility === undefined ? undefined : { keychainAccessible: accessibility },
  );
}

export async function loadPendingShare(
  store: PendingShareStore = defaultStore(),
  now = Date.now(),
): Promise<SharedTextIntent | null> {
  const key = KEY;
  const raw = await store.getItemAsync(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredPendingShare;
    if (!isValidPendingIntent(value)
      || now - value.savedAt > MAX_AGE_MS
      || value.savedAt > now + 60_000
    ) {
      await store.deleteItemAsync(key);
      return null;
    }
    return { id: value.id, kind: value.kind, value: value.value, createdAt: value.createdAt };
  } catch {
    await store.deleteItemAsync(key);
    return null;
  }
}

/**
 * Bind the device-only, signed-out receipt to the first verified server/user.
 * A receipt bound to another identity is destroyed rather than replayed after
 * a server switch or logout. Call this before opening the ordinary Share UI.
 */
export async function claimPendingShare(
  scope: PendingShareScope,
  store: PendingShareStore = defaultStore(),
  now = Date.now(),
): Promise<SharedTextIntent | null> {
  const raw = await store.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredPendingShare;
    if (!isValidPendingIntent(value)
      || now - value.savedAt > MAX_AGE_MS
      || value.savedAt > now + 60_000
    ) {
      await store.deleteItemAsync(KEY);
      return null;
    }
    if (value.scope && !exactScope(value, scope)) {
      await store.deleteItemAsync(KEY);
      return null;
    }
    if (!value.scope) {
      await store.setItemAsync(KEY, JSON.stringify({ ...value, scope: storedScope(scope) }));
    }
    return { id: value.id, kind: value.kind, value: value.value, createdAt: value.createdAt };
  } catch {
    await store.deleteItemAsync(KEY);
    return null;
  }
}

export async function clearPendingShare(
  store: PendingShareStore = defaultStore(),
): Promise<void> {
  await store.deleteItemAsync(KEY);
}

export async function clearPendingShareForScope(
  scope: PendingShareScope,
  store: PendingShareStore = defaultStore(),
  now = Date.now(),
): Promise<void> {
  const raw = await store.getItemAsync(KEY);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as StoredPendingShare;
    if (!isValidPendingIntent(value)
      || now - value.savedAt > MAX_AGE_MS
      || value.savedAt > now + 60_000
      || exactScope(value, scope)
    ) await store.deleteItemAsync(KEY);
  } catch { await store.deleteItemAsync(KEY); }
}

export async function clearPendingShareForServer(
  serverId: string,
  store: PendingShareStore = defaultStore(),
  now = Date.now(),
): Promise<void> {
  const raw = await store.getItemAsync(KEY);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as StoredPendingShare;
    if (!isValidPendingIntent(value)
      || now - value.savedAt > MAX_AGE_MS
      || value.savedAt > now + 60_000
      || value.scope?.server === serverId
    ) await store.deleteItemAsync(KEY);
  } catch { await store.deleteItemAsync(KEY); }
}

export const PENDING_SHARE_MAX_AGE_MS = MAX_AGE_MS;
export const PENDING_SHARE_DEVICE_KEY = KEY;
