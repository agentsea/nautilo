import { describe, expect, mock, test } from "bun:test";
import type { UsageFundingProvenance } from "@nautilo/agent";
import type { DurableServiceFundingBinding } from "@nautilo/types";
import type { BrowserUseCloudAdapter } from "../../src/browser-use/browser-use-cloud";
import type { ConnectedWebBrowserFunding } from "../../src/connected-web-accounts/browser-use-funding";
import {
  AccountDeletionConnectedWebAccountsCleanupError,
  cleanupConnectedWebAccountsBeforeAccountDeletion,
  cleanupIdleConnectedWebOperationsBeforeAccountDeletion,
  isSafelyDeletableConversionOperation,
} from "../../src/lib/user-account-deletion";

const HUMAN = "00000000-0000-4000-8000-000000000001";

const active = (resource: "login" | "read" | "view", opaqueExecutionRef: string) => ({
  resource,
  phase: "active" as const,
  reservationToken: "reservation",
  opaqueExecutionRef,
  recordedAt: "2026-09-01T00:00:00.000Z",
});

function serverBinding(humanUserId = HUMAN, marker = "a"): DurableServiceFundingBinding {
  return {
    humanUserId,
    provider: "browser-use",
    binding: { kind: "server", providerRoute: "browser-use" },
    credentialFingerprint: marker.repeat(64),
  };
}

function fundingForKeys(keys: ReadonlyMap<string, string>, legacyKey = "legacy-key") {
  const legacy = mock(async (humanUserId: string) => serverBinding(humanUserId, "f"));
  const funding: ConnectedWebBrowserFunding = {
    admit: async (humanUserId, prior) => prior ?? serverBinding(humanUserId),
    admitLegacyServer: legacy,
    run: async <T>(binding: DurableServiceFundingBinding, intent: "spend" | "recover", callback: (attempt: {
      readonly apiKey: string;
      readonly usageFunding: UsageFundingProvenance;
    }) => Promise<T>) => {
      expect(intent).toBe("recover");
      return callback({
        apiKey: keys.get(binding.credentialFingerprint) ?? legacyKey,
        usageFunding: {
          kind: "server",
          humanUserId: binding.humanUserId,
          providerRoute: "browser-use",
        },
      });
    },
  };
  return { funding, legacy };
}

function scopedBrowser(calls: string[]): Pick<BrowserUseCloudAdapter, "withRequestCredential"> {
  return {
    withRequestCredential: ({ apiKey }) => ({
      stopBrowser: async (id: string) => { calls.push(`${apiKey}:stop:${id}`); return undefined as never; },
      stopHostedReadBrowser: async (id: string) => { calls.push(`${apiKey}:stop-run-browser:${id}`); return true; },
      deleteProfile: async (id: string) => { calls.push(`${apiKey}:delete:${id}`); return undefined; },
    }) as unknown as BrowserUseCloudAdapter,
  };
}

describe("Human account deletion provider cleanup", () => {
  test("unknown admission cannot discard its only recovery owner", async () => {
    let scoped = false;
    const result = await cleanupConnectedWebAccountsBeforeAccountDeletion([{
      ownerUserId: HUMAN,
      profileRef: "profile",
      profileFundingBinding: serverBinding(),
      checkpoint: { ...active("read", "run"), phase: "reserving" },
    }], {
      withRequestCredential: () => { scoped = true; throw new Error("must not run"); },
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AccountDeletionConnectedWebAccountsCleanupError);
    expect(scoped).toBe(false);
  });

  test("deletion locks conversions and deletes only safe receipts before the Human", async () => {
    const source = await Bun.file(new URL("../../src/lib/user-account-deletion.ts", import.meta.url)).text();
    const conversionLock = source.indexOf("const targetConversionRows =");
    const eligibilityCheck = source.indexOf("!isSafelyDeletableConversionOperation(row)", conversionLock);
    const conversionDelete = source.indexOf("await tx.delete(conversionOperations)");
    const userDelete = source.indexOf("await tx.delete(users)");
    expect(conversionLock).toBeGreaterThan(source.indexOf("SELECT id, external_id, server"));
    expect(eligibilityCheck).toBeGreaterThan(conversionLock);
    expect(conversionDelete).toBeGreaterThan(eligibilityCheck);
    expect(conversionDelete).toBeLessThan(userDelete);
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

  test("reopens each retained profile only with its exact creating credential", async () => {
    const first = serverBinding(HUMAN, "a");
    const second = serverBinding(HUMAN, "b");
    const { funding, legacy } = fundingForKeys(new Map([
      [first.credentialFingerprint, "first-key"],
      [second.credentialFingerprint, "second-key"],
    ]));
    const calls: string[] = [];

    await cleanupConnectedWebAccountsBeforeAccountDeletion([
      { ownerUserId: HUMAN, profileRef: "profile-login", profileFundingBinding: first, checkpoint: active("login", "browser") },
      { ownerUserId: HUMAN, profileRef: "profile-read", profileFundingBinding: second, checkpoint: active("read", "run") },
    ], scopedBrowser(calls), funding);

    expect(calls).toEqual([
      "first-key:stop:browser",
      "first-key:delete:profile-login",
      "second-key:stop-run-browser:run",
      "second-key:delete:profile-read",
    ]);
    expect(legacy).not.toHaveBeenCalled();
  });

  test("legacy locked profile recovery explicitly adopts only server funding", async () => {
    const { funding, legacy } = fundingForKeys(new Map(), "legacy-server-key");
    const calls: string[] = [];
    await cleanupConnectedWebAccountsBeforeAccountDeletion([{
      ownerUserId: HUMAN,
      profileRef: "legacy-profile",
      profileFundingBinding: null,
      checkpoint: null,
    }], scopedBrowser(calls), funding);
    expect(legacy).toHaveBeenCalledWith(HUMAN);
    expect(calls).toEqual(["legacy-server-key:delete:legacy-profile"]);
  });

  test("account rows without provider resources require no funding", async () => {
    const { funding, legacy } = fundingForKeys(new Map());
    await cleanupConnectedWebAccountsBeforeAccountDeletion([{
      ownerUserId: HUMAN,
      profileRef: null,
      profileFundingBinding: null,
      checkpoint: null,
    }], {
      withRequestCredential: () => { throw new Error("must not open a provider credential"); },
    }, funding);
    expect(legacy).not.toHaveBeenCalled();
  });

  test("treats provider not-found as already cleaned", async () => {
    const binding = serverBinding();
    const { funding } = fundingForKeys(new Map([[binding.credentialFingerprint, "exact-key"]]));
    const notFound = { kind: "failure" as const, code: "resource_not_found" as const };
    const deleted: string[] = [];
    await cleanupConnectedWebAccountsBeforeAccountDeletion([{
      ownerUserId: HUMAN,
      profileRef: "gone",
      profileFundingBinding: binding,
      checkpoint: active("login", "gone"),
    }], {
      withRequestCredential: () => ({
        stopBrowser: async () => notFound,
        stopHostedReadBrowser: async () => false,
        deleteProfile: async (id: string) => { deleted.push(id); return notFound; },
      }) as unknown as BrowserUseCloudAdapter,
    }, funding);
    expect(deleted).toEqual(["gone"]);
  });

  test("fails closed before profile deletion when exact-key cleanup fails", async () => {
    const binding = serverBinding();
    const { funding } = fundingForKeys(new Map([[binding.credentialFingerprint, "exact-key"]]));
    const deleted: string[] = [];
    const cleanup = cleanupConnectedWebAccountsBeforeAccountDeletion([{
      ownerUserId: HUMAN,
      profileRef: "keep",
      profileFundingBinding: binding,
      checkpoint: active("login", "browser"),
    }], {
      withRequestCredential: () => ({
        stopBrowser: async () => ({ kind: "failure" as const, code: "provider_unavailable" as const }),
        stopHostedReadBrowser: async () => false,
        deleteProfile: async (id: string) => { deleted.push(id); return undefined; },
      }) as unknown as BrowserUseCloudAdapter,
    }, funding);
    expect(await cleanup.catch((error: unknown) => error))
      .toBeInstanceOf(AccountDeletionConnectedWebAccountsCleanupError);
    expect(deleted).toEqual([]);
  });

  test("idle operation cleanup uses exact funding and settles retained cost custody", async () => {
    const binding = serverBinding();
    const { funding, legacy } = fundingForKeys(new Map([[binding.credentialFingerprint, "creating-key"]]));
    const calls: string[] = [];
    const settlements: unknown[] = [];
    await cleanupIdleConnectedWebOperationsBeforeAccountDeletion([{
      id: "operation",
      ownerUserId: HUMAN,
      accountId: "account",
      initiatingAgentId: "agent",
      initiatingRoomId: "room",
      sealedProviderRefs: { version: 1, sessionRef: "sealed" },
      lifecycle: "terminal",
      browserCleanupStartedAt: null,
      browserIdleUntil: new Date("2026-09-01T00:00:00.000Z"),
      fundingBinding: binding,
    }], scopedBrowser(calls), {} as never, {
      funding,
      stopIdle: async (input) => {
        await input.provider.stopBrowser("retained-browser");
        await input.settleBrowserCost?.({
          identity: "browser-cost",
          workload: "connected_web_read",
          estimatedCostUsd: "0.25000000",
          evidenceState: "estimated",
        });
        return true;
      },
      settleCost: async (receipt) => { settlements.push(receipt); },
    });
    expect(calls).toEqual(["creating-key:stop:retained-browser"]);
    expect(legacy).not.toHaveBeenCalled();
    expect(settlements[0]).toMatchObject({
      identity: "browser-cost",
      usageFunding: { kind: "server", humanUserId: HUMAN, providerRoute: "browser-use" },
      userId: HUMAN,
      roomId: "room",
      agentId: "agent",
      provider: "browser_use",
      operation: "browser_session",
      estimatedCostUsd: "0.25000000",
      evidenceState: "estimated",
      attemptOutcome: "succeeded",
    });
  });
});

describe("Human account deletion conversion receipts", () => {
  test("permits only unadmitted prepared or fully terminal receipts", () => {
    const terminal = new Date("2026-09-01T00:00:00.000Z");
    expect(isSafelyDeletableConversionOperation({
      status: "prepared", providerJobId: null, failureCode: null, submittedAt: null, terminalAt: null,
    })).toBe(true);
    for (const status of ["published", "cancelled", "failed", "publication_failed", "expired"]) {
      expect(isSafelyDeletableConversionOperation({
        status, providerJobId: "provider-job", failureCode: null, submittedAt: terminal, terminalAt: terminal,
      })).toBe(true);
    }
    expect(isSafelyDeletableConversionOperation({
      status: "cancelled", providerJobId: null, failureCode: "cancelled_before_provider_dispatch",
      submittedAt: null, terminalAt: terminal,
    })).toBe(true);
    expect(isSafelyDeletableConversionOperation({
      status: "cancelled", providerJobId: null, failureCode: "provider_cancelled",
      submittedAt: null, terminalAt: terminal,
    })).toBe(false);
    expect(isSafelyDeletableConversionOperation({
      status: "publication_committing", providerJobId: "provider-job", failureCode: null, submittedAt: terminal, terminalAt: terminal,
    })).toBe(false);
    expect(isSafelyDeletableConversionOperation({
      status: "submission_unknown", providerJobId: null, failureCode: null, submittedAt: null, terminalAt: null,
    })).toBe(false);
    expect(isSafelyDeletableConversionOperation({
      status: "published", providerJobId: "provider-job", failureCode: null, submittedAt: terminal, terminalAt: null,
    })).toBe(false);
  });
});
