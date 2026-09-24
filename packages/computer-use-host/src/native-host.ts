import { randomBytes } from "node:crypto";

import { createNativeRegistryWindowResolver, CuaBrowserRuntime } from "./browser-runtime.js";
import { CuaCheckedBrowserClient } from "./checked-browser-client.js";
import { CuaNativeContractRuntime, createNativeComputerUseScopeFactory } from "./native-contract-runtime.js";
import { CuaMainLifecycle, type CuaCheckedGenerationInvalidation, type CuaMainLifecycleOptions } from "./native-cua-lifecycle.js";
import { CuaComputerUseAdapter, readMacosHidIdleNanoseconds, type CuaReadHidIdleNanoseconds } from "./native-runtime.js";
import { ComputerUseHost } from "./runtime.js";
import { ComputerUseResourceCoordinator } from "./resource-coordinator.js";

export type NativeCuaHostOptions = Readonly<{
  driverPath: string;
  runtimeRoot: string;
  hostBundleId: string;
  hostGeneration?: string;
  onDriverInvalidated?: (event: CuaCheckedGenerationInvalidation) => void;
  /** Test seam; production always constructs the Host-owned lifecycle here. */
  createLifecycle?: (options: CuaMainLifecycleOptions) => CuaMainLifecycle;
  /** Test seam; the executable always uses the local macOS input monitor. */
  readHidIdleNanoseconds?: CuaReadHidIdleNanoseconds;
}>;

export type NativeCuaHost = Readonly<{
  host: ComputerUseHost;
  native: CuaNativeContractRuntime;
  browser: CuaBrowserRuntime;
  browserClient: CuaCheckedBrowserClient;
  adapter: CuaComputerUseAdapter;
  lifecycle: CuaMainLifecycle;
  hostGeneration: string;
  driverGeneration: string;
  shutdown(): Promise<void>;
}>;

function freshHostGeneration(): string {
  return `host:${randomBytes(18).toString("base64url")}`;
}

/**
 * Sole production composition root for native Cua. It owns driver attestation,
 * process/socket/session startup, the checked driver generation, semantic
 * adapter state, and teardown. No Electron-owned socket can enter this API.
 */
export async function createNativeCuaHost(options: NativeCuaHostOptions): Promise<NativeCuaHost> {
  const hostGeneration = options.hostGeneration ?? freshHostGeneration();
  const lifecycleOptions: CuaMainLifecycleOptions = {
    binaryPath: options.driverPath,
    userDataPath: options.runtimeRoot,
    hostBundleId: options.hostBundleId,
  };
  const lifecycle = options.createLifecycle?.(lifecycleOptions) ?? new CuaMainLifecycle(lifecycleOptions);
  const status = await lifecycle.startup();
  const port = lifecycle.checkedContextPort();
  if (status.lifecycle !== "healthy" || port === null) {
    await lifecycle.shutdown().catch(() => undefined);
    throw new Error("Host-owned Cua driver did not pass its local readiness check");
  }
  if (port.awaitOutstandingOperations === undefined) {
    await lifecycle.shutdown();
    throw new Error("Host-owned Cua port cannot drain coordinated requests");
  }
  const drain = port.awaitOutstandingOperations.bind(port);
  const driverGeneration = port.generation;
  const adapter = new CuaComputerUseAdapter({ port,
    readHidIdleNanoseconds: options.readHidIdleNanoseconds ?? readMacosHidIdleNanoseconds });
  const scopeForAuthority = createNativeComputerUseScopeFactory({ hostGeneration, driverGeneration });
  const coordinator = new ComputerUseResourceCoordinator();
  const native = new CuaNativeContractRuntime({
    adapter,
    scopeForAuthority,
    coordinator,
    registry: adapter.registry,
    drain: (scope, signal) => drain(scope, signal),
  });
  const browserClient = new CuaCheckedBrowserClient({ port, scopeForAuthority });
  const browser = new CuaBrowserRuntime({
    client: browserClient,
    coordinator,
    resolveNativeWindow: createNativeRegistryWindowResolver(adapter.registry, scopeForAuthority),
  });
  const host = new ComputerUseHost({
    hostGeneration,
    driverGeneration,
    handlers: [...native.handlers, ...browser.handlers],
  });
  const unsubscribe = lifecycle.subscribeCheckedGenerationInvalidation((event) => {
    if (event.generation !== driverGeneration) return;
    // The checked port cannot recover this generation. Retire native authority
    // immediately; old cleanup carries its own session/generation identity.
    host.revoke();
    browser.revoke();
    void Promise.allSettled([adapter.close(), browser.close(), browserClient.close()]);
    options.onDriverInvalidated?.(event);
  });
  return {
    host,
    native,
    browser,
    browserClient,
    adapter,
    lifecycle,
    hostGeneration,
    driverGeneration,
    shutdown: async () => {
      unsubscribe();
      host.revoke();
      browser.revoke();
      await adapter.close();
      await browser.close();
      await browserClient.close();
      await lifecycle.shutdown();
    },
  };
}
