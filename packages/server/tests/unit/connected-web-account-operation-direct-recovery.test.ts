import { expect, test } from "bun:test";
import { directBrowserPrivateRoot } from "../../src/connected-web-accounts/operation-direct-production";
import { recoverDirectConnectedWebOperation, recoverDirectConnectedWebOperations } from "../../src/connected-web-accounts/operation-direct-recovery";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function fixture() {
  const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "s".repeat(32) });
  const context = { operationId: OPERATION, ownerUserId: OWNER, accountId: ACCOUNT };
  const operation = {
    id: OPERATION, ownerUserId: OWNER, accountId: ACCOUNT, controlEpoch: 7,
    driver: "direct", lifecycle: "running",
    sealedProviderRefs: secrets.sealProviderReferences({ context, coordinates: { runId: "run-1", browserId: "browser-1" } }),
  } as ConnectedWebOperation;
  return { secrets, operation };
}

function browser(status: "active" | "stopped") {
  return {
    browserId: "browser-1", cdpUrl: status === "active" ? "https://private.cdp.browser-use.com" : null,
    liveViewUrl: null, status, timeoutAt: new Date(), observedAt: new Date(),
  } as const;
}

test("D568 restart recovery closes daemon, proves exact browser stop, releases dirs, then schedules reconciliation", async () => {
  const { secrets, operation } = fixture();
  const calls: string[] = [];
  const now = new Date("2026-09-04T12:00:00.000Z");
  await recoverDirectConnectedWebOperations({
    store: {
      listDirectOperationsForRecovery: async () => [operation],
      rotateOperationDriver: async (input) => {
        calls.push("rotate");
        expect(input).toMatchObject({ operationId: OPERATION, expectedControlEpoch: 7, driver: "checking", lifecycle: "attention", nextCheckAt: now });
        return { controlEpoch: 8, controlLeaseToken: "private" };
      },
    },
    secrets,
    provider: {
      getBrowser: async () => { calls.push("get"); return browser("active"); },
      stopBrowser: async () => { calls.push("stop"); return browser("stopped"); },
    },
    directories: {
      allocate: async () => { throw new Error("must not allocate"); },
      async *forRecovery() { calls.push("inventory"); yield { socketDirectory: "/tmp/private/s", homeDirectory: "/tmp/private/h" }; },
      release: async () => { calls.push("release"); },
    },
    harness: {
      buildArgv: () => [], invoke: async () => ({ text: "", truncated: false }),
      closePrivateDaemons: async () => { calls.push("close-daemon"); },
    },
    now: () => now,
  });
  expect(calls).toEqual(["inventory", "close-daemon", "release", "get", "stop", "rotate"]);
});

test("D568 restart recovery releases daemon-free dirs but preserves the direct fence on provider uncertainty", async () => {
  const { secrets, operation } = fixture();
  const calls: string[] = [];
  await recoverDirectConnectedWebOperations({
    store: {
      listDirectOperationsForRecovery: async () => [operation],
      rotateOperationDriver: async () => { calls.push("unsafe-rotate"); return null; },
    },
    secrets,
    provider: {
      getBrowser: async () => { calls.push("get"); return { kind: "failure", code: "provider_unavailable" }; },
      stopBrowser: async () => { calls.push("unsafe-stop"); return browser("stopped"); },
    },
    directories: {
      allocate: async () => { throw new Error("must not allocate"); },
      async *forRecovery() { yield { socketDirectory: "/tmp/private/s", homeDirectory: "/tmp/private/h" }; },
      release: async () => { calls.push("release"); },
    },
    harness: {
      buildArgv: () => [], invoke: async () => ({ text: "", truncated: false }),
      closePrivateDaemons: async () => { calls.push("close-daemon"); },
    },
  });
  expect(calls).toEqual(["close-daemon", "release", "get"]);
});

test("D568 production direct root is short and canonical on macOS", () => {
  expect(directBrowserPrivateRoot("instance", "darwin")).toMatch(/^\/private\/tmp\/nwc-[a-f0-9]{16}$/u);
});

test("owner recovery cannot release a fence without exact daemon and provider stop proof", async () => {
  for (const failureAt of ["daemon", "directories", "wrong-browser", "active-stop", "missing-browser", "epoch"] as const) {
    const { secrets, operation } = fixture();
    let rotations = 0;
    const recovered = await recoverDirectConnectedWebOperation({
      secrets,
      store: {
        listDirectOperationsForRecovery: async () => { throw new Error("must target one operation"); },
        rotateOperationDriver: async () => { rotations += 1; return null; },
      },
      directories: {
        allocate: async () => { throw new Error("must not allocate"); },
        async *forRecovery() { yield { socketDirectory: "/tmp/private/s", homeDirectory: "/tmp/private/h" }; },
        release: async () => { if (failureAt === "directories") throw new Error("unsafe directory"); },
      },
      harness: {
        buildArgv: () => [], invoke: async () => ({ text: "", truncated: false }),
        closePrivateDaemons: async () => { if (failureAt === "daemon") throw new Error("still running"); },
      },
      provider: {
        getBrowser: async () => failureAt === "missing-browser" ? { kind: "failure", code: "resource_not_found" }
          : failureAt === "wrong-browser" ? { ...browser("stopped"), browserId: "another-browser" } : browser("active"),
        stopBrowser: async () => browser(failureAt === "active-stop" ? "active" : "stopped"),
      },
    }, operation);
    expect(recovered).toBe(false);
    expect(rotations).toBe(failureAt === "epoch" ? 1 : 0);
  }
});
