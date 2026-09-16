import type { SharedTextIntent } from "@/lib/share-handoff";

export type PendingShareScope = { readonly serverId: string; readonly viewerId: string };
export type PendingShareStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export const PENDING_SHARE_MAX_AGE_MS = 10 * 60 * 1000;
export const PENDING_SHARE_DEVICE_KEY = null;

export function savePendingShare(
  _intent: SharedTextIntent,
  _store?: PendingShareStore,
  _now?: number,
  _scope?: PendingShareScope | null,
): Promise<never> {
  return Promise.reject(new Error("Native Share text custody requires the installed Mobile app."));
}

export function loadPendingShare(_store?: PendingShareStore, _now?: number): Promise<null> {
  return Promise.resolve(null);
}

export function claimPendingShare(
  _scope: PendingShareScope,
  _store?: PendingShareStore,
  _now?: number,
): Promise<null> {
  return Promise.resolve(null);
}

export function clearPendingShare(_store?: PendingShareStore): Promise<void> {
  return Promise.resolve();
}

export function clearPendingShareForScope(
  _scope: PendingShareScope,
  _store?: PendingShareStore,
  _now?: number,
): Promise<void> {
  return Promise.resolve();
}

export function clearPendingShareForServer(
  _serverId: string,
  _store?: PendingShareStore,
  _now?: number,
): Promise<void> {
  return Promise.resolve();
}
