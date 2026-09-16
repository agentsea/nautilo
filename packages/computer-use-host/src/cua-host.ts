import { CuaBrowserRuntime, PrivateComputerUseTargetRegistry } from "./browser-runtime.js";
import type { CuaToolClient } from "./cua-client.js";
import { ComputerUseHost } from "./runtime.js";
import { CuaNativeContractRuntime, type CuaNativeContractRuntimeOptions } from "./native-contract-runtime.js";

/** One composition root so native and browser runtimes share the same private targets. */
export function createCuaComputerUseHost(options: Readonly<{
  client: CuaToolClient;
  hostGeneration: string;
  driverGeneration: string;
  targets?: PrivateComputerUseTargetRegistry;
  native?: CuaNativeContractRuntimeOptions;
}>): Readonly<{
  host: ComputerUseHost;
  browser: CuaBrowserRuntime;
  native: CuaNativeContractRuntime | null;
  targets: PrivateComputerUseTargetRegistry;
}> {
  const targets = options.targets ?? new PrivateComputerUseTargetRegistry();
  const browser = new CuaBrowserRuntime({ client: options.client, targets });
  const native = options.native === undefined ? null : new CuaNativeContractRuntime(options.native);
  const host = new ComputerUseHost({
    hostGeneration: options.hostGeneration,
    driverGeneration: options.driverGeneration,
    handlers: [...browser.handlers, ...(native?.handlers ?? [])],
  });
  return { host, browser, native, targets };
}
