import { expect, test } from "bun:test";
import { stopIdleConnectedWebBrowser } from "../../src/connected-web-accounts/browser-idle-cleanup";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";

const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "test-secret-with-enough-bytes-for-aead" });
const context = { operationId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222", accountId: "33333333-3333-4333-8333-333333333333" };
const operation = { id: context.operationId, ownerUserId: context.ownerUserId, accountId: context.accountId,
  lifecycle: "terminal", browserCleanupStartedAt: new Date(),
  sealedProviderRefs: secrets.sealProviderReferences({ context, coordinates: { sessionId: "exact-session", runId: "exact-run" } }),
} as ConnectedWebOperation;

test("idle cleanup stops only active browsers in the exact claimed session, never a run or profile", async () => {
  const stopped: string[] = [];
  const result = await stopIdleConnectedWebBrowser({ operation, secrets, provider: {
    findHostedBrowsers: async ({ agentSessionId }) => {
      expect(agentSessionId).toBe("exact-session");
      return [{ browserId: "old-stopped", status: "stopped" }, { browserId: "live-exact", status: "active" }] as never;
    },
    stopBrowser: async (id) => { stopped.push(id); return { browserId: id, status: "stopped" } as never; },
  } });
  expect(result).toBe(true);
  expect(stopped).toEqual(["live-exact"]);
});

test("active or unclaimed work cannot be stopped by idle cleanup", async () => {
  let calls = 0;
  const provider = { findHostedBrowsers: async () => { calls++; return []; }, stopBrowser: async () => { calls++; return {} as never; } };
  expect(await stopIdleConnectedWebBrowser({ operation: { ...operation, lifecycle: "running" }, secrets, provider })).toBe(false);
  expect(await stopIdleConnectedWebBrowser({ operation: { ...operation, browserCleanupStartedAt: null }, secrets, provider })).toBe(false);
  expect(calls).toBe(0);
});

test("unknown provider stop is not recorded as release and can be reconciled after restart", async () => {
  let attempts = 0;
  const provider = {
    findHostedBrowsers: async () => [{ browserId: "live-exact", status: "active" }] as never,
    stopBrowser: async () => ++attempts === 1 ? { kind: "failure", code: "network_error" } as never : { browserId: "live-exact", status: "stopped" } as never,
  };
  expect(await stopIdleConnectedWebBrowser({ operation, secrets, provider })).toBe(false);
  expect(await stopIdleConnectedWebBrowser({ operation, secrets, provider })).toBe(true);
  expect(attempts).toBe(2);
});

test("unsealing with a foreign account fails before touching Browser Use", async () => {
  let calls = 0;
  expect(await stopIdleConnectedWebBrowser({ operation: { ...operation, accountId: "44444444-4444-4444-8444-444444444444" }, secrets,
    provider: { findHostedBrowsers: async () => { calls++; return []; }, stopBrowser: async () => ({} as never) },
  })).toBe(false);
  expect(calls).toBe(0);
});
