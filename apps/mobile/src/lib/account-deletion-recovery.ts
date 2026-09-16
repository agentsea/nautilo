import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AccountDeletionEligibility } from "@nautilo/api-client/browser";

import { serverIdFromUrl } from "./server-store";
import { normalizeServerUrl } from "./server-url";

export const ACCOUNT_DELETION_RECOVERY_STORAGE_KEY = "nautilo.account-deletion-recovery.v1";
export const ACCOUNT_DELETION_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ACCOUNT_DELETION_ATTEMPTS = 8;

export interface AccountDeletionRecoveryStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface AccountDeletionServerScope {
  readonly serverId: string;
  readonly serverUrl: string;
}

export interface AccountDeletionAttempt extends AccountDeletionServerScope {
  /** A DELETE was durably scheduled, but its response is not yet known. */
  readonly status: "pending" | "server-confirmed";
  readonly startedAt: number;
  readonly updatedAt: number;
}

interface StoredAccountDeletionAttempt extends AccountDeletionAttempt {
  readonly v: 1;
}

interface StoredAccountDeletionRecovery {
  readonly v: 1;
  readonly attempts: readonly StoredAccountDeletionAttempt[];
}

export type AccountDeletionReconciliation =
  | "server-deleted"
  | "retry-deletion"
  | "ambiguous";

type EligibilityObservation =
  | { readonly kind: "eligibility"; readonly eligibility: AccountDeletionEligibility }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "transport-error" };

let mutationTail: Promise<void> = Promise.resolve();

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeScope(scope: AccountDeletionServerScope): AccountDeletionServerScope {
  const serverUrl = normalizeServerUrl(scope.serverUrl);
  if (!serverUrl) throw new Error("invalid account deletion server URL");
  const serverId = serverIdFromUrl(serverUrl);
  if (scope.serverId !== serverId) throw new Error("account deletion server identity mismatch");
  return { serverId, serverUrl };
}

function parseAttempt(value: unknown, now: number): StoredAccountDeletionAttempt | null {
  if (typeof value !== "object" || value === null) return null;
  const attempt = value as Record<string, unknown>;
  if (
    attempt["v"] !== 1
    || typeof attempt["serverId"] !== "string"
    || attempt["serverId"].length === 0
    || attempt["serverId"].length > 180
    || typeof attempt["serverUrl"] !== "string"
    || attempt["serverUrl"].length > 512
    || (attempt["status"] !== "pending" && attempt["status"] !== "server-confirmed")
    || !isSafeTimestamp(attempt["startedAt"])
    || !isSafeTimestamp(attempt["updatedAt"])
    || attempt["updatedAt"] < attempt["startedAt"]
    || attempt["startedAt"] > now + 60_000
    || attempt["updatedAt"] > now + 60_000
    || now - attempt["startedAt"] > ACCOUNT_DELETION_RECOVERY_TTL_MS
  ) {
    return null;
  }
  try {
    const scope = normalizeScope({
      serverId: attempt["serverId"],
      serverUrl: attempt["serverUrl"],
    });
    return {
      v: 1,
      ...scope,
      status: attempt["status"],
      startedAt: attempt["startedAt"],
      updatedAt: attempt["updatedAt"],
    };
  } catch {
    return null;
  }
}

function parseRecovery(raw: string | null, now: number): StoredAccountDeletionRecovery {
  if (!raw) return { v: 1, attempts: [] };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { v: 1, attempts: [] };
    const document = value as Record<string, unknown>;
    if (document["v"] !== 1 || !Array.isArray(document["attempts"])) return { v: 1, attempts: [] };
    const attempts = document["attempts"]
      .map((attempt) => parseAttempt(attempt, now))
      .filter((attempt): attempt is StoredAccountDeletionAttempt => attempt !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ACCOUNT_DELETION_ATTEMPTS);
    return { v: 1, attempts };
  } catch {
    return { v: 1, attempts: [] };
  }
}

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationTail.catch(() => {}).then(mutation);
  mutationTail = result.then(() => {}, () => {});
  return result;
}

async function writeRecovery(
  storage: AccountDeletionRecoveryStorage,
  recovery: StoredAccountDeletionRecovery,
): Promise<void> {
  if (recovery.attempts.length === 0) {
    await storage.removeItem(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY);
    return;
  }
  await storage.setItem(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
}

/**
 * Persist a non-secret, exact-server receipt before sending DELETE. A write
 * failure deliberately prevents the destructive request: without this receipt
 * a process death could no longer distinguish a lost response from no delete.
 */
export async function beginAccountDeletionAttempt(
  scope: AccountDeletionServerScope,
  options: Readonly<{
    storage?: AccountDeletionRecoveryStorage;
    now?: () => number;
  }> = {},
): Promise<AccountDeletionAttempt> {
  const normalized = normalizeScope(scope);
  const storage = options.storage ?? AsyncStorage;
  const now = options.now ?? Date.now;
  return enqueueMutation(async () => {
    const timestamp = now();
    const recovery = parseRecovery(
      await storage.getItem(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY),
      timestamp,
    );
    const attempt: StoredAccountDeletionAttempt = {
      v: 1,
      ...normalized,
      status: "pending",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const attempts = [
      attempt,
      ...recovery.attempts.filter((entry) => entry.serverId !== normalized.serverId),
    ].slice(0, MAX_ACCOUNT_DELETION_ATTEMPTS);
    await writeRecovery(storage, { v: 1, attempts });
    return attempt;
  });
}

/** Mark the receipt only after a successful DELETE response. */
export async function markAccountDeletionServerConfirmed(
  scope: AccountDeletionServerScope,
  options: Readonly<{
    storage?: AccountDeletionRecoveryStorage;
    now?: () => number;
  }> = {},
): Promise<AccountDeletionAttempt | null> {
  const normalized = normalizeScope(scope);
  const storage = options.storage ?? AsyncStorage;
  const now = options.now ?? Date.now;
  return enqueueMutation(async () => {
    const recovery = parseRecovery(
      await storage.getItem(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY),
      now(),
    );
    const current = recovery.attempts.find((entry) => entry.serverId === normalized.serverId);
    if (!current || current.serverUrl !== normalized.serverUrl) return null;
    const confirmed: StoredAccountDeletionAttempt = {
      ...current,
      status: "server-confirmed",
      updatedAt: now(),
    };
    const attempts = recovery.attempts.map((entry) =>
      entry.serverId === normalized.serverId ? confirmed : entry,
    );
    await writeRecovery(storage, { v: 1, attempts });
    return confirmed;
  });
}

/** Read a fresh receipt for exactly one saved server. Expired or malformed data is ignored. */
export async function loadAccountDeletionAttempt(
  scope: AccountDeletionServerScope,
  options: Readonly<{
    storage?: AccountDeletionRecoveryStorage;
    now?: () => number;
  }> = {},
): Promise<AccountDeletionAttempt | null> {
  const normalized = normalizeScope(scope);
  const storage = options.storage ?? AsyncStorage;
  const now = options.now ?? Date.now;
  const recovery = parseRecovery(
    await storage.getItem(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY),
    now(),
  );
  const attempt = recovery.attempts.find((entry) => entry.serverId === normalized.serverId);
  return attempt?.serverUrl === normalized.serverUrl ? attempt : null;
}

/** Call this only after the scoped saved-server removal has completed. */
export async function clearAccountDeletionAttempt(
  scope: AccountDeletionServerScope,
  options: Readonly<{
    storage?: AccountDeletionRecoveryStorage;
    now?: () => number;
  }> = {},
): Promise<void> {
  const normalized = normalizeScope(scope);
  const storage = options.storage ?? AsyncStorage;
  const now = options.now ?? Date.now;
  await enqueueMutation(async () => {
    const recovery = parseRecovery(
      await storage.getItem(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY),
      now(),
    );
    await writeRecovery(storage, {
      v: 1,
      attempts: recovery.attempts.filter((entry) => entry.serverId !== normalized.serverId),
    });
  });
}

/**
 * Reconcile only a receipt created before a fresh DELETE. A transport failure
 * is intentionally not proof of deletion; only a prior success receipt,
 * explicit user-not-found, or auth/not-found eligibility response converges.
 */
export function reconcileAccountDeletionAttempt(
  attempt: AccountDeletionAttempt,
  observation: EligibilityObservation,
): AccountDeletionReconciliation {
  if (attempt.status === "server-confirmed") return "server-deleted";
  if (observation.kind === "eligibility") {
    if (observation.eligibility.eligible) return "retry-deletion";
    if (observation.eligibility.code === "user_not_found") return "server-deleted";
    return "ambiguous";
  }
  if (observation.kind === "http-error" && (observation.status === 401 || observation.status === 404)) {
    return "server-deleted";
  }
  return "ambiguous";
}
