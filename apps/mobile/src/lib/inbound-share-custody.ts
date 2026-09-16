/**
 * Replaceable custody boundary for native image/file Share receipts.
 *
 * This module intentionally persists metadata only. A native Share extension
 * must first copy raw bytes into its platform-protected inbox and return an
 * opaque receipt. JS never receives or writes a URI, filesystem path, or
 * base64 payload. the planned encryption contract will replace the native inbox
 * implementation without changing this lifecycle contract.
 */
export type InboundShareScope = { readonly serverId: string; readonly viewerId: string };
export type InboundFileReceipt = {
  readonly id: string;
  readonly nativeReceiptId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
};
export type InboundShareCustodyStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
export type NativeInboundFileReceiptStore = {
  peekAsync(): Promise<unknown>;
  ackAsync(id: string): Promise<boolean>;
  clearAsync(): Promise<void>;
};

export const INBOUND_SHARE_CUSTODY_DEVICE_KEY = "nautilo.inbound-share-custody.v1.device";
export const INBOUND_SHARE_MAX_AGE_MS = 10 * 60 * 1000;
// Matches the packaged server's workspace-artifact upload default. The
// authoritative server still applies its own (possibly lower) admission limit.
export const INBOUND_SHARE_MAX_BYTES = 100 * 1024 * 1024;

type StoredInboundReceipt = InboundFileReceipt & {
  readonly version: 1;
  readonly savedAt: number;
  readonly scope?: { readonly server: string; readonly viewer: string };
};

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(value);
}

function validScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function validReceipt(value: unknown, now: number): value is InboundFileReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  // Reject a tempting future native implementation that leaks raw locations
  // into persistent JS custody. An opaque receipt is the only raw-byte handle.
  if ("uri" in receipt || "path" in receipt || "base64" in receipt || "data" in receipt) return false;
  const createdAt = typeof receipt.createdAt === "string" ? Date.parse(receipt.createdAt) : Number.NaN;
  return validOpaqueId(receipt.id)
    && validOpaqueId(receipt.nativeReceiptId)
    && typeof receipt.filename === "string" && receipt.filename.length > 0 && receipt.filename.length <= 255
    && typeof receipt.mimeType === "string" && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(receipt.mimeType)
    && typeof receipt.sizeBytes === "number" && Number.isSafeInteger(receipt.sizeBytes)
    && receipt.sizeBytes > 0 && receipt.sizeBytes <= INBOUND_SHARE_MAX_BYTES
    && Number.isFinite(createdAt) && createdAt <= now + 60_000 && now - createdAt <= INBOUND_SHARE_MAX_AGE_MS;
}

function validStored(value: unknown, now: number): value is StoredInboundReceipt {
  if (!value || typeof value !== "object") return false;
  const stored = value as StoredInboundReceipt;
  if (stored.version !== 1 || !Number.isFinite(stored.savedAt) || stored.savedAt > now + 60_000 || now - stored.savedAt > INBOUND_SHARE_MAX_AGE_MS || !validReceipt(stored, now)) return false;
  return stored.scope === undefined || (
    typeof stored.scope === "object" && stored.scope !== null
    && validScopeId(stored.scope.server) && validScopeId(stored.scope.viewer)
  );
}

function defaultStore(): InboundShareCustodyStore & { readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("expo-secure-store") as InboundShareCustodyStore & { readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number };
}

function storedScope(scope: InboundShareScope): { readonly server: string; readonly viewer: string } {
  if (!validScopeId(scope.serverId) || !validScopeId(scope.viewerId)) throw new RangeError("Invalid inbound share scope");
  // This is encrypted device metadata. Preserve canonical values because this
  // is an authorization comparison, where a lossy hash is not exact enough.
  return { server: scope.serverId, viewer: scope.viewerId };
}

function exactScope(record: StoredInboundReceipt, scope: InboundShareScope): boolean {
  const expected = storedScope(scope);
  return record.scope?.server === expected.server && record.scope.viewer === expected.viewer;
}

/** Commit metadata only after native code has put bytes into its protected inbox. */
export async function saveInboundShareReceipt(
  receipt: InboundFileReceipt,
  scope: InboundShareScope | null,
  store: InboundShareCustodyStore = defaultStore(),
  now = Date.now(),
): Promise<void> {
  if (!validReceipt(receipt, now)) throw new RangeError("Inbound file is not eligible for bounded custody");
  const record: StoredInboundReceipt = { ...receipt, version: 1, savedAt: now, ...(scope ? { scope: storedScope(scope) } : {}) };
  const accessibility = "WHEN_UNLOCKED_THIS_DEVICE_ONLY" in store
    ? (store as InboundShareCustodyStore & { readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number }).WHEN_UNLOCKED_THIS_DEVICE_ONLY
    : undefined;
  await store.setItemAsync(
    INBOUND_SHARE_CUSTODY_DEVICE_KEY,
    JSON.stringify(record),
    accessibility === undefined ? undefined : { keychainAccessible: accessibility },
  );
}

/**
 * Claim an unbound signed-out receipt at the first verified identity. A receipt
 * already claimed by another server/user is cleared rather than replayed.
 */
export async function claimInboundShareReceipt(
  scope: InboundShareScope,
  store: InboundShareCustodyStore = defaultStore(),
  now = Date.now(),
): Promise<InboundFileReceipt | null> {
  const raw = await store.getItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as StoredInboundReceipt;
    if (!validStored(record, now)) { await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY); return null; }
    if (record.scope && !exactScope(record, scope)) { await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY); return null; }
    if (!record.scope) {
      const bound: StoredInboundReceipt = { ...record, scope: storedScope(scope) };
      await store.setItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY, JSON.stringify(bound));
    }
    return { id: record.id, nativeReceiptId: record.nativeReceiptId, filename: record.filename, mimeType: record.mimeType, sizeBytes: record.sizeBytes, createdAt: record.createdAt };
  } catch {
    await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
    return null;
  }
}

export async function clearInboundShareReceipt(store: InboundShareCustodyStore = defaultStore()): Promise<void> {
  await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
}

export async function clearInboundShareReceiptForScope(
  scope: InboundShareScope,
  store: InboundShareCustodyStore = defaultStore(),
  now = Date.now(),
): Promise<void> {
  const raw = await store.getItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
  if (!raw) return;
  try {
    const record = JSON.parse(raw) as StoredInboundReceipt;
    if (!validStored(record, now) || exactScope(record, scope)) await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
  } catch { await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY); }
}

export async function clearInboundShareReceiptForServer(
  serverId: string,
  store: InboundShareCustodyStore = defaultStore(),
  now = Date.now(),
): Promise<void> {
  const raw = await store.getItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
  if (!raw) return;
  try {
    const record = JSON.parse(raw) as StoredInboundReceipt;
    if (!validStored(record, now) || record.scope?.server === serverId) await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY);
  } catch { await store.deleteItemAsync(INBOUND_SHARE_CUSTODY_DEVICE_KEY); }
}

/** Ack native storage only after the replaceable JS metadata custody commit. */
export async function stageNativeInboundFileReceipt(
  save: (receipt: InboundFileReceipt) => Promise<void>,
  now = Date.now(),
  native?: NativeInboundFileReceiptStore,
): Promise<InboundFileReceipt | null> {
  if (!native) return null;
  const raw = await native.peekAsync();
  if (!validReceipt(raw, now)) {
    if (raw !== null && raw !== undefined) await native.clearAsync();
    return null;
  }
  await save(raw);
  if (!await native.ackAsync(raw.id)) throw new Error("Native inbound share acknowledgement did not commit");
  return raw;
}
