import { expect, mock, spyOn, test } from "bun:test";
import { COMPUTER_USE_BROWSER_CONTRACTS } from "@nautilo/computer-use-contracts";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import { NATIVE_COMPATIBILITY_SCHEMAS } from "@nautilo/computer-use-contracts/native-compatibility";

import type { CuaCheckedContextPort, CuaMainLifecycle } from "../../src/native-cua-lifecycle.ts";
import { createNativeCuaHost } from "../../src/native-host.ts";
import * as nativeRuntime from "../../src/native-runtime.ts";
import { createNativeComputerUseScopeFactory } from "../../src/native-contract-runtime.ts";
import { COMPUTER_USE_HOST_VERSION } from "../../src/version.ts";
import classificationReview from "../../reviews/0.1.26.json";

function checkedPort(): CuaCheckedContextPort {
  return {
    generation: `cua_${"a".repeat(32)}`,
    callContextTool: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    launchApplication: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    getWindowState: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    captureWindowState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
    captureDesktopState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
    clickDesktop: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    endContextLease: mock(async () => undefined),
    awaitOutstandingOperations: mock(async () => undefined),
  };
}

test("native Host owns lifecycle startup, checked generation, contracts, invalidation, and teardown", async () => {
  const port = checkedPort();
  let invalidate: ((event: { generation: string; reason: "supervisor_invalidated" }) => void) | undefined;
  const shutdown = mock(async () => undefined);
  const lifecycle = {
    startup: mock(async () => ({ lifecycle: "healthy" as const })),
    checkedContextPort: mock(() => port),
    subscribeCheckedGenerationInvalidation: mock((listener: typeof invalidate) => {
      invalidate = listener;
      return () => { invalidate = undefined; };
    }),
    shutdown,
  } as unknown as CuaMainLifecycle;
  const invalidated = mock(() => undefined);
  const seen: unknown[] = [];
  const runtime = await createNativeCuaHost({
    driverPath: "/Applications/Nautilo.app/Contents/Resources/tools-cua/cua-driver",
    runtimeRoot: "/private/tmp/nautilo-host-runtime",
    hostBundleId: "com.nautilo.desktop",
    hostGeneration: "host:one",
    onDriverInvalidated: invalidated,
    createLifecycle: (options) => { seen.push(options); return lifecycle; },
  });

  expect(seen).toEqual([{
    binaryPath: "/Applications/Nautilo.app/Contents/Resources/tools-cua/cua-driver",
    userDataPath: "/private/tmp/nautilo-host-runtime",
    hostBundleId: "com.nautilo.desktop",
  }]);
  expect(runtime.driverGeneration).toBe(port.generation);
  expect(runtime.host.ready().contracts).toEqual([
    COMPUTER_USE_NATIVE_CONTRACTS.observe,
    COMPUTER_USE_NATIVE_CONTRACTS.do,
    COMPUTER_USE_NATIVE_CONTRACTS.verify,
    ...NATIVE_COMPATIBILITY_SCHEMAS.map((schema) => schema.descriptor),
    COMPUTER_USE_BROWSER_CONTRACTS.bindWindow,
    COMPUTER_USE_BROWSER_CONTRACTS.prepare,
    COMPUTER_USE_BROWSER_CONTRACTS.readPage,
    COMPUTER_USE_BROWSER_CONTRACTS.openUrl,
    COMPUTER_USE_BROWSER_CONTRACTS.navigate,
    COMPUTER_USE_BROWSER_CONTRACTS.click,
    COMPUTER_USE_BROWSER_CONTRACTS.type,
    COMPUTER_USE_BROWSER_CONTRACTS.pointer,
    COMPUTER_USE_BROWSER_CONTRACTS.dialog,
  ]);
  const readyContracts = [...runtime.host.ready().contracts].sort((left, right) =>
    left.contractId.localeCompare(right.contractId)
    || left.contractNamespace.localeCompare(right.contractNamespace)
    || left.contractVersion - right.contractVersion);
  expect(classificationReview.hostVersion).toBe(COMPUTER_USE_HOST_VERSION);
  expect(classificationReview.contracts).toEqual(readyContracts);
  const closeNative = spyOn(runtime.adapter, "close");
  invalidate?.({ generation: "cua_other_generation", reason: "supervisor_invalidated" });
  expect(closeNative).not.toHaveBeenCalled();
  invalidate?.({ generation: port.generation, reason: "supervisor_invalidated" });
  expect(closeNative).toHaveBeenCalledTimes(1);
  expect(invalidated).toHaveBeenCalledTimes(1);
  await runtime.shutdown();
  expect(closeNative).toHaveBeenCalledTimes(2);
  expect(shutdown).toHaveBeenCalledTimes(1);
});

test("native Host publishes nothing when its owned driver is unhealthy", async () => {
  const shutdown = mock(async () => undefined);
  const lifecycle = {
    startup: mock(async () => ({ lifecycle: "unhealthy" as const })),
    checkedContextPort: mock(() => null),
    shutdown,
  } as unknown as CuaMainLifecycle;
  await expect(createNativeCuaHost({
    driverPath: "/signed/cua-driver",
    runtimeRoot: "/private/tmp/runtime",
    hostBundleId: "com.nautilo.desktop",
    createLifecycle: () => lifecycle,
  })).rejects.toThrow("Host-owned Cua driver did not pass its local readiness check");
  expect(shutdown).toHaveBeenCalledTimes(1);
});

test("production Host defaults to the native input monitor rather than the inert adapter baseline", async () => {
  const port = checkedPort();
  const lifecycle = {
    startup: async () => ({ lifecycle: "healthy" as const }), checkedContextPort: () => port,
    subscribeCheckedGenerationInvalidation: () => () => undefined, shutdown: async () => undefined,
  } as unknown as CuaMainLifecycle;
  // Stub the OS reader itself: no real HID access, and no injected adapter seam
  // that could accidentally leave the production default unwired.
  const monitor = spyOn(nativeRuntime, "readMacosHidIdleNanoseconds").mockRejectedValue(new Error("fixture unreadable"));
  const runtime = await createNativeCuaHost({ driverPath: "/fixture/cua-driver", runtimeRoot: "/fixture/runtime",
    hostBundleId: "org.example.fixture", createLifecycle: () => lifecycle });
  try {
    const scope = createNativeComputerUseScopeFactory(runtime)({ authorityLeaseId: "fixture-lease", authorityGeneration: 1 });
    const observed = await runtime.adapter.observe({ scope, operation: "desktop_state" });
    expect(monitor).toHaveBeenCalled();
    expect(port.callContextTool).not.toHaveBeenCalled();
    expect(observed).toMatchObject({ ok: false, outcome: { providerCondition: "unknown" } });
    expect(observed).not.toMatchObject({ outcome: { externalInterference: "user_input" } });
  } finally {
    monitor.mockRestore();
    await runtime.shutdown();
  }
});

test("native Host refuses a checked port that cannot drain dispatched requests", async () => {
  const port = checkedPort();
  delete port.awaitOutstandingOperations;
  const shutdown = mock(async () => undefined);
  const lifecycle = {
    startup: mock(async () => ({ lifecycle: "healthy" as const })),
    checkedContextPort: mock(() => port),
    shutdown,
  } as unknown as CuaMainLifecycle;
  await expect(createNativeCuaHost({
    driverPath: "/signed/cua-driver",
    runtimeRoot: "/private/tmp/runtime",
    hostBundleId: "com.nautilo.desktop",
    createLifecycle: () => lifecycle,
  })).rejects.toThrow("Host-owned Cua port cannot drain coordinated requests");
  expect(shutdown).toHaveBeenCalledTimes(1);
});
