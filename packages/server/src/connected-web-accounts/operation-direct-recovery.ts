import type { BrowserUseBrowserSession, BrowserUseProviderFailure, BrowserUseResult } from "../browser-use/browser-use-cloud";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import type { ConnectedWebAccountStore, ConnectedWebOperation } from "./store";
import type { DirectBrowserRouterDirectoryAuthority } from "./direct-browser-router";
import type { DirectBrowserControlHarness } from "./direct-browser-control";
import type { UsageFundingProvenance } from "@nautilo/agent";
import type { ServerProviderCostReceipt } from "../costs/provider-cost-recorder";

export interface ConnectedWebOperationDirectRecoveryOptions {
  readonly store: Pick<ConnectedWebAccountStore, "listDirectOperationsForRecovery" | "rotateOperationDriver">;
  readonly secrets: ConnectedWebOperationSecrets;
  readonly provider: {
    getBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>>;
    stopBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>>;
  };
  readonly withProvider?: <T>(
    operation: ConnectedWebOperation,
    callback: (provider: ConnectedWebOperationDirectRecoveryOptions["provider"], usageFunding?: UsageFundingProvenance) => Promise<T>,
  ) => Promise<T>;
  readonly settleCostAttempt?: (input: ServerProviderCostReceipt) => Promise<void>;
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

function withRecoveryProvider<T>(
  options: ConnectedWebOperationDirectRecoveryOptions,
  operation: ConnectedWebOperation,
  callback: (provider: ConnectedWebOperationDirectRecoveryOptions["provider"], usageFunding?: UsageFundingProvenance) => Promise<T>,
): Promise<T> {
  return options.withProvider === undefined ? callback(options.provider) : options.withProvider(operation, callback);
}

/** Clean one orphaned direct writer without constructing a control lease. */
export async function recoverDirectConnectedWebOperation(
  options: ConnectedWebOperationDirectRecoveryOptions,
  operation: ConnectedWebOperation,
): Promise<boolean> {
  if (operation.accountId === null || operation.driver !== "direct" || operation.lifecycle === "terminal") return false;
  try {
    const coordinates = options.secrets.unsealProviderReferences({
      context: context(operation), references: operation.sealedProviderRefs,
    });
    const browserId = coordinates.browserId;
    if (!browserId || !options.harness.closePrivateDaemons || !options.directories.forRecovery) return false;
    for await (const directories of options.directories.forRecovery({
      ownerUserId: operation.ownerUserId, accountId: operation.accountId,
      operationId: operation.id, controlEpoch: operation.controlEpoch,
    })) {
      await options.harness.closePrivateDaemons(directories);
      await options.directories.release(directories);
    }
    const stopped = await withRecoveryProvider(options, operation, async (provider, usageFunding) => {
      const observed = await provider.getBrowser(browserId);
      const result = !failure(observed) && observed.browserId === browserId && observed.status === "active"
        ? await provider.stopBrowser(browserId)
        : observed;
      const terminal = !failure(result) && result.browserId === browserId && result.status === "stopped";
      // Saved-profile direct browsers deliberately clear the inherited hosted
      // session coordinate when the browser ref is sealed. That durable bit
      // distinguishes their separately billed /browsers session on restart.
      if (terminal && coordinates.sessionId === undefined && coordinates.browserCost && options.settleCostAttempt) {
        await options.settleCostAttempt({
          identity: coordinates.browserCost.identity,
          ...(usageFunding === undefined ? {} : { usageFunding }),
          userId: operation.fundingBinding?.humanUserId ?? operation.ownerUserId,
          roomId: operation.initiatingRoomId,
          agentId: operation.initiatingAgentId,
          workload: coordinates.browserCost.workload,
          provider: "browser_use",
          operation: "browser_session",
          estimatedCostUsd: result.costEvidence?.estimatedCostUsd ?? null,
          actualCostUsd: null,
          evidenceState: result.costEvidence?.evidenceState ?? "unknown",
          attemptOutcome: "succeeded",
        });
      }
      return terminal;
    });
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
