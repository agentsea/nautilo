/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

mock.module("expo-crypto", () => ({
  getRandomBytesAsync: async (size: number) => new Uint8Array(size),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

const values = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); },
  },
}));

const {
  ACCOUNT_DELETION_RECOVERY_STORAGE_KEY,
  ACCOUNT_DELETION_RECOVERY_TTL_MS,
  MAX_ACCOUNT_DELETION_ATTEMPTS,
  beginAccountDeletionAttempt,
  clearAccountDeletionAttempt,
  loadAccountDeletionAttempt,
  markAccountDeletionServerConfirmed,
  reconcileAccountDeletionAttempt,
} = await import("./account-deletion-recovery");

function scope(name: string) {
  return { serverId: `srv_https___${name}.test`, serverUrl: `https://${name}.test` };
}

function storage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: async (key: string) => entries.get(key) ?? null,
    setItem: async (key: string, value: string) => { entries.set(key, value); },
    removeItem: async (key: string) => { entries.delete(key); },
  };
}

describe("account deletion recovery receipt", () => {
  test("persists a non-secret pending receipt before DELETE and marks only its server response", async () => {
    const receipts = storage();
    const now = () => Date.UTC(2026, 7, 18);
    const first = scope("first");
    const second = scope("second");

    await beginAccountDeletionAttempt(first, { storage: receipts, now });
    await beginAccountDeletionAttempt(second, { storage: receipts, now });
    const confirmed = await markAccountDeletionServerConfirmed(first, { storage: receipts, now });

    expect(confirmed).toMatchObject({ serverId: first.serverId, status: "server-confirmed" });
    expect(await loadAccountDeletionAttempt(first, { storage: receipts, now })).toMatchObject({
      status: "server-confirmed",
      serverUrl: first.serverUrl,
    });
    expect(await loadAccountDeletionAttempt(second, { storage: receipts, now })).toMatchObject({
      status: "pending",
      serverUrl: second.serverUrl,
    });
    expect(JSON.stringify([...receipts.entries.values()])).not.toContain("accessToken");
  });

  test("never clears another saved server's receipt and expires stale recovery state", async () => {
    const receipts = storage();
    const first = scope("first");
    const second = scope("second");
    const then = Date.UTC(2026, 7, 18);
    await beginAccountDeletionAttempt(first, { storage: receipts, now: () => then });
    await beginAccountDeletionAttempt(second, { storage: receipts, now: () => then });

    await clearAccountDeletionAttempt(first, { storage: receipts, now: () => then + 1 });
    expect(await loadAccountDeletionAttempt(first, { storage: receipts, now: () => then + 1 })).toBeNull();
    expect(await loadAccountDeletionAttempt(second, { storage: receipts, now: () => then + 1 })).not.toBeNull();

    expect(await loadAccountDeletionAttempt(second, {
      storage: receipts,
      now: () => then + ACCOUNT_DELETION_RECOVERY_TTL_MS + 1,
    })).toBeNull();
  });

  test("bounds the persisted schema to the most recent server receipts", async () => {
    const receipts = storage();
    const then = Date.UTC(2026, 7, 18);
    for (let index = 0; index < MAX_ACCOUNT_DELETION_ATTEMPTS + 3; index += 1) {
      await beginAccountDeletionAttempt(scope(`server-${index}`), {
        storage: receipts,
        now: () => then + index,
      });
    }
    const raw = receipts.entries.get(ACCOUNT_DELETION_RECOVERY_STORAGE_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as { attempts: unknown[] };
    expect(parsed.attempts).toHaveLength(MAX_ACCOUNT_DELETION_ATTEMPTS);
    expect(await loadAccountDeletionAttempt(scope("server-0"), { storage: receipts, now: () => then + 100 })).toBeNull();
  });

  test("only unambiguous eligibility evidence converges a pending delete", async () => {
    const attempt = {
      ...scope("reconcile"),
      status: "pending" as const,
      startedAt: Date.UTC(2026, 7, 18),
      updatedAt: Date.UTC(2026, 7, 18),
    };

    expect(reconcileAccountDeletionAttempt(attempt, {
      kind: "eligibility",
      eligibility: { eligible: true },
    })).toBe("retry-deletion");
    expect(reconcileAccountDeletionAttempt(attempt, {
      kind: "eligibility",
      eligibility: { eligible: false, code: "user_not_found" },
    })).toBe("server-deleted");
    expect(reconcileAccountDeletionAttempt(attempt, {
      kind: "eligibility",
      eligibility: { eligible: false, code: "protected_custody" },
    })).toBe("ambiguous");
    expect(reconcileAccountDeletionAttempt(attempt, {
      kind: "eligibility",
      eligibility: { eligible: false, code: "active_media_operation" },
    })).toBe("ambiguous");
    expect(reconcileAccountDeletionAttempt(attempt, { kind: "http-error", status: 401 })).toBe("server-deleted");
    expect(reconcileAccountDeletionAttempt(attempt, { kind: "http-error", status: 404 })).toBe("server-deleted");
    expect(reconcileAccountDeletionAttempt(attempt, { kind: "transport-error" })).toBe("ambiguous");
  });
});
