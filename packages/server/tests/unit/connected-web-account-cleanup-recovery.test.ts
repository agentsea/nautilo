import { expect, test } from "bun:test";
import { ConnectedWebAccountController } from "../../src/connected-web-accounts/controller";
import type { BrowserUseCloudAdapter } from "../../src/browser-use/browser-use-cloud";
import type { ConnectedWebAccountStore } from "../../src/connected-web-accounts/store";

test("D568 boot cleanup completes successful and already-deleted revoked profiles", async () => {
  const completed: string[] = [];
  const failed: string[] = [];
  const store = {
    async listRevokedProfilesForCleanup() {
      return [
        { accountId: "account-deleted", profileRef: "deleted-profile" },
        { accountId: "account-gone", profileRef: "gone-profile" },
      ];
    },
    async markProviderCleanupCompleted(accountId: string) { completed.push(accountId); },
    async markProviderCleanupFailed({ accountId }: { accountId: string }) { failed.push(accountId); },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async deleteProfile(profileRef: string) {
      return profileRef === "gone-profile"
        ? { kind: "failure" as const, code: "resource_not_found" as const }
        : undefined;
    },
  } as unknown as BrowserUseCloudAdapter;
  const controller = new ConnectedWebAccountController({
    store,
    browser,
    navigator: { async navigate() {}, async verifySignIn() { return { atExpectedOrigin: true, authenticationRequired: false }; } },
  });

  await controller.reconcileRevokedProfileCleanup();

  expect(completed).toEqual(["account-deleted", "account-gone"]);
  expect(failed).toEqual([]);
});

test("D568 boot cleanup keeps transient provider failures retryable and continues", async () => {
  const completed: string[] = [];
  const failed: string[] = [];
  const store = {
    async listRevokedProfilesForCleanup() {
      return [
        { accountId: "account-failed", profileRef: "failed-profile" },
        { accountId: "account-throws", profileRef: "throwing-profile" },
        { accountId: "account-next", profileRef: "next-profile" },
      ];
    },
    async markProviderCleanupCompleted(accountId: string) { completed.push(accountId); },
    async markProviderCleanupFailed({ accountId, safeFailureCode }: { accountId: string; safeFailureCode: string }) {
      expect(safeFailureCode).toBe("cleanup_unavailable");
      failed.push(accountId);
    },
  } as unknown as ConnectedWebAccountStore;
  const browser = {
    async deleteProfile(profileRef: string) {
      if (profileRef === "failed-profile") return { kind: "failure" as const, code: "provider_unavailable" as const };
      if (profileRef === "throwing-profile") throw new Error("network unavailable");
      return undefined;
    },
  } as unknown as BrowserUseCloudAdapter;
  const controller = new ConnectedWebAccountController({
    store,
    browser,
    navigator: { async navigate() {}, async verifySignIn() { return { atExpectedOrigin: true, authenticationRequired: false }; } },
  });

  await controller.reconcileRevokedProfileCleanup();

  expect(failed).toEqual(["account-failed", "account-throws"]);
  expect(completed).toEqual(["account-next"]);
});
