import { expect, test } from "bun:test";
import { stopIdleConnectedWebBrowser } from "../../src/connected-web-accounts/browser-idle-cleanup";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";

const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "test-secret-with-enough-bytes-for-aead" });
const context = { operationId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222", accountId: "33333333-3333-4333-8333-333333333333" };
const operation = { id: context.operationId, ownerUserId: context.ownerUserId, accountId: context.accountId,
  lifecycle: "terminal", browserCleanupStartedAt: new Date(),
  sealedProviderRefs: secrets.sealProviderReferences({ context, coordinates: {
    sessionId: "exact-session",
    runId: "exact-run",
    browserCost: { identity: "browser-cost-identity", workload: "connected_web_read" },
  } }),
} as ConnectedWebOperation;

test("idle cleanup stops only active browsers in the exact claimed session, never a run or profile", async () => {
  const stopped: string[] = [];
  const costs: unknown[] = [];
  const result = await stopIdleConnectedWebBrowser({ operation, secrets, provider: {
    findHostedBrowsers: async ({ agentSessionId }) => {
      expect(agentSessionId).toBe("exact-session");
      return [{ browserId: "old-stopped", status: "stopped" }, { browserId: "live-exact", status: "active" }] as never;
    },
    stopBrowser: async (id) => { stopped.push(id); return { browserId: id, status: "stopped", costEvidence: { estimatedCostUsd: "0.125", evidenceState: "estimated" } } as never; },
  }, settleBrowserCost: async (cost) => { costs.push(cost); } });
  expect(result).toBe(true);
  expect(stopped).toEqual(["live-exact"]);
  // One already-stopped browser has no complete component evidence, so the
  // final session row remains honestly unknown rather than undercounted.
  expect(costs).toEqual([{ identity: "browser-cost-identity", workload: "connected_web_read", estimatedCostUsd: null, evidenceState: "unknown" }]);
});

test("complete Browser Use stop usage is retained as an estimate rather than a buyer charge", async () => {
  const costs: unknown[] = [];
  expect(await stopIdleConnectedWebBrowser({ operation, secrets, provider: {
    findHostedBrowsers: async () => [{ browserId: "live-exact", status: "active" }] as never,
    stopBrowser: async (browserId) => ({
      browserId, status: "stopped",
      costEvidence: { estimatedCostUsd: "0.12500000", evidenceState: "estimated" },
    }) as never,
  }, settleBrowserCost: async (cost) => { costs.push(cost); } })).toBe(true);
  expect(costs).toEqual([{
    identity: "browser-cost-identity",
    workload: "connected_web_read",
    estimatedCostUsd: "0.12500000",
    evidenceState: "estimated",
  }]);
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

test("a retry recovers the provider estimate from a browser already stopped after a lost response", async () => {
  let inventory = 0;
  let stops = 0;
  const costs: unknown[] = [];
  const provider = {
    findHostedBrowsers: async () => ++inventory === 1
      ? [{ browserId: "live-exact", status: "active" }] as never
      : [{
        browserId: "live-exact",
        status: "stopped",
        costEvidence: { estimatedCostUsd: "0.03125000", evidenceState: "estimated" },
      }] as never,
    stopBrowser: async () => { stops += 1; return { kind: "failure", code: "network_error" } as never; },
  };
  const settleBrowserCost = async (cost: unknown) => { costs.push(cost); };
  expect(await stopIdleConnectedWebBrowser({ operation, secrets, provider, settleBrowserCost })).toBe(false);
  expect(await stopIdleConnectedWebBrowser({ operation, secrets, provider, settleBrowserCost })).toBe(true);
  expect(stops).toBe(1);
  expect(costs).toEqual([{
    identity: "browser-cost-identity",
    workload: "connected_web_read",
    estimatedCostUsd: "0.03125000",
    evidenceState: "estimated",
  }]);
});

test("unsealing with a foreign account fails before touching Browser Use", async () => {
  let calls = 0;
  expect(await stopIdleConnectedWebBrowser({ operation: { ...operation, accountId: "44444444-4444-4444-8444-444444444444" }, secrets,
    provider: { findHostedBrowsers: async () => { calls++; return []; }, stopBrowser: async () => ({} as never) },
  })).toBe(false);
  expect(calls).toBe(0);
});
