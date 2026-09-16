import type { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import type { ConnectedWebAccountStore } from "./store";

type CleanupStore = Pick<ConnectedWebAccountStore, "requestExecutionCleanup" | "completeExecution" | "listPendingExecutionCleanup">;
type CleanupProvider = Pick<BrowserUseCloudAdapter, "stopHostedReadBrowser">;

/** The run remains fenced durably if either provider stop or local completion fails. */
export async function completeHostedExecution(
  store: CleanupStore, provider: CleanupProvider,
  input: Parameters<ConnectedWebAccountStore["requestExecutionCleanup"]>[0],
): Promise<Awaited<ReturnType<ConnectedWebAccountStore["completeExecution"]>>> {
  const runId = await store.requestExecutionCleanup(input);
  if (!await provider.stopHostedReadBrowser(runId)) throw new Error("Connected website cleanup pending.");
  return store.completeExecution({ ...input, expectedOpaqueExecutionRef: runId });
}

/** Only explicitly finished sync executions: never cancel an active Genie task. */
export async function reconcileHostedExecutionCleanup(store: CleanupStore, provider: CleanupProvider): Promise<void> {
  for (const execution of await store.listPendingExecutionCleanup()) {
    const { checkpoint } = execution;
    if (!checkpoint.cleanupStatus || !checkpoint.opaqueExecutionRef) continue;
    try {
      await completeHostedExecution(store, provider, {
        ownerUserId: execution.ownerUserId, accountId: execution.accountId,
        reservationToken: checkpoint.reservationToken,
        expectedOpaqueExecutionRef: checkpoint.opaqueExecutionRef,
        status: checkpoint.cleanupStatus,
      });
    } catch { /* Durable custody remains for the next independent cleanup tick. */ }
  }
}
