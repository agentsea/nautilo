import type { BrowserUseBrowserSession, BrowserUseProviderFailure, BrowserUseResult } from "../browser-use/browser-use-cloud";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import type { ConnectedWebAccountStore, ConnectedWebOperation } from "./store";
import type { DirectBrowserRouterDirectoryAuthority } from "./direct-browser-router";
import type { DirectBrowserControlHarness } from "./direct-browser-control";

export interface ConnectedWebOperationDirectRecoveryOptions {
  readonly store: Pick<ConnectedWebAccountStore, "listDirectOperationsForRecovery" | "rotateOperationDriver">;
  readonly secrets: ConnectedWebOperationSecrets;
  readonly provider: {
    getBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>>;
    stopBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>>;
  };
  readonly directories: DirectBrowserRouterDirectoryAuthority;
  readonly harness: DirectBrowserControlHarness;
  readonly now?: () => Date;
}

function failure(value: unknown): value is BrowserUseProviderFailure {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "failure";
}

function context(operation: ConnectedWebOperation) {
  return { operationId: operation.id, ownerUserId: operation.ownerUserId, accountId: operation.accountId };
}

/** Clean one orphaned direct writer without constructing a control lease. */
export async function recoverDirectConnectedWebOperation(
  options: ConnectedWebOperationDirectRecoveryOptions,
  operation: ConnectedWebOperation,
): Promise<boolean> {
  if (operation.accountId === null || operation.driver !== "direct" || operation.lifecycle === "terminal") return false;
  try {
    const browserId = options.secrets.unsealProviderReferences({
      context: context(operation), references: operation.sealedProviderRefs,
    }).browserId;
    if (!browserId || !options.harness.closePrivateDaemons || !options.directories.forRecovery) return false;
    for await (const directories of options.directories.forRecovery({
      ownerUserId: operation.ownerUserId, accountId: operation.accountId,
      operationId: operation.id, controlEpoch: operation.controlEpoch,
    })) {
      await options.harness.closePrivateDaemons(directories);
      await options.directories.release(directories);
    }
    const observed = await options.provider.getBrowser(browserId);
    let stopped = !failure(observed) && observed.browserId === browserId && observed.status === "stopped";
    if (!failure(observed) && observed.browserId === browserId && observed.status === "active") {
      const result = await options.provider.stopBrowser(browserId);
      stopped = !failure(result) && result.browserId === browserId && result.status === "stopped";
    }
    if (!stopped) return false;
    const now = (options.now ?? (() => new Date()))();
    const rotated = await options.store.rotateOperationDriver({
      operationId: operation.id, expectedControlEpoch: operation.controlEpoch, now,
      driver: "checking", lifecycle: "attention",
      safeActivity: {
        version: 1, phase: "checking", code: "direct_browser_control_recovered",
        summary: "Browser control stopped. Nautilo is checking the final operation status.",
      },
      nextCheckAt: now, controlLeaseExpiresAt: null,
    });
    return rotated !== null;
  } catch {
    // No new writer is admitted while either local or provider cleanup is uncertain.
    return false;
  }
}

/** Listener-start inventory uses the same exact cleanup as an owner Stop. */
export async function recoverDirectConnectedWebOperations(
  options: ConnectedWebOperationDirectRecoveryOptions,
): Promise<void> {
  for (const operation of await options.store.listDirectOperationsForRecovery()) {
    await recoverDirectConnectedWebOperation(options, operation);
  }
}
