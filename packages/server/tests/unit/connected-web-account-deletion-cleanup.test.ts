import { describe, expect, mock, test } from "bun:test";
import {
  AccountDeletionConnectedWebAccountsCleanupError,
  cleanupConnectedWebAccountsBeforeAccountDeletion,
} from "../../src/lib/user-account-deletion";

const active = (resource: "login" | "read" | "view", opaqueExecutionRef: string) => ({
  resource,
  phase: "active" as const,
  reservationToken: "reservation",
  opaqueExecutionRef,
  recordedAt: "2026-09-01T00:00:00.000Z",
});

describe("D568 Human account deletion provider cleanup", () => {
  test("unknown admission cannot discard its only recovery owner", async () => {
    let deleted = false;
    const result = await cleanupConnectedWebAccountsBeforeAccountDeletion([{
      profileRef: "profile", checkpoint: { ...active("read", "run"), phase: "reserving" },
    }], {
      stopBrowser: async () => { throw new Error("must not run"); },
      stopHostedReadBrowser: async () => false,
      deleteProfile: async () => { deleted = true; },
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AccountDeletionConnectedWebAccountsCleanupError);
    expect(deleted).toBe(false);
  });

  test("deletion orders website operation cascade before initiating Genie and user FKs", async () => {
    const source = await Bun.file(new URL("../../src/lib/user-account-deletion.ts", import.meta.url)).text();
    const accountDelete = source.indexOf("await tx.delete(connectedWebAccounts)");
    expect(accountDelete).toBeGreaterThan(source.indexOf("await cleanupConnectedWebAccountsBeforeAccountDeletion(connectedRows"));
    expect(accountDelete).toBeLessThan(source.indexOf("await tx.delete(agents)"));
    expect(accountDelete).toBeLessThan(source.indexOf("await tx.delete(users)"));
    expect(source.indexOf("const websiteOperations =")).toBeLessThan(source.indexOf("const connectedRows ="));
    expect(source).toContain('websiteOperations.some((operation) => operation.lifecycle !== "terminal")');
  });
  test("stops login, private page, and read work before deleting each retained profile", async () => {
    const calls: string[] = [];
    const browser = {
      stopBrowser: mock(async (id: string) => { calls.push(`stop:${id}`); return undefined as never; }),
      stopHostedReadBrowser: mock(async (id: string) => { calls.push(`stop-run-browser:${id}`); return true; }),
      deleteProfile: mock(async (id: string) => { calls.push(`delete:${id}`); return undefined; }),
    };

    await cleanupConnectedWebAccountsBeforeAccountDeletion([
      { profileRef: "profile-login", checkpoint: active("login", "browser") },
      { profileRef: "profile-view", checkpoint: active("view", "page-browser") },
      { profileRef: "profile-read", checkpoint: active("read", "run") },
    ], browser);

    expect(calls).toEqual([
      "stop:browser",
      "delete:profile-login",
      "stop:page-browser",
      "delete:profile-view",
      "stop-run-browser:run",
      "delete:profile-read",
    ]);
  });

  test("treats provider not-found as already cleaned", async () => {
    const notFound = { kind: "failure" as const, code: "resource_not_found" as const };
    const deleteProfile = mock(async () => notFound);
    await cleanupConnectedWebAccountsBeforeAccountDeletion([
      { profileRef: "gone", checkpoint: active("login", "gone") },
    ], {
      stopBrowser: mock(async () => notFound),
      stopHostedReadBrowser: mock(async () => false),
      deleteProfile,
    });
    expect(deleteProfile).toHaveBeenCalledWith("gone");
  });

  test("fails closed before profile deletion when active work cannot be stopped", async () => {
    const deleteProfile = mock(async () => undefined);
    const cleanup = cleanupConnectedWebAccountsBeforeAccountDeletion([
      { profileRef: "keep", checkpoint: active("login", "browser") },
    ], {
      stopBrowser: mock(async () => ({ kind: "failure" as const, code: "provider_unavailable" as const })),
      stopHostedReadBrowser: mock(async () => false),
      deleteProfile,
    });
    let failure: unknown;
    try {
      await cleanup;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AccountDeletionConnectedWebAccountsCleanupError);
    expect(deleteProfile).not.toHaveBeenCalled();
  });
});
