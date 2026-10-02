import { fetchSurplusSettlement, resolveProviderKey, surplusCredentialFingerprint } from "@nautilo/agent";
import { listPendingSurplusAttempts, reconcileSurplusLlmAttemptCost } from "@nautilo/db";
import type { ListPendingSurplusAttemptsInput, SurplusPendingAttempt } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { createReceiptRecoveryPump } from "./receipt-recovery";

interface SurplusCostRecoveryDependencies {
  list(input: ListPendingSurplusAttemptsInput): Promise<SurplusPendingAttempt[]>;
  settle(input: Parameters<typeof reconcileSurplusLlmAttemptCost>[0]): Promise<boolean>;
  resolveKey(): string | null;
  fetchCost: typeof fetchSurplusSettlement;
  now(): number;
}

/** Financial recovery continues when preference is off; it never sends an inference request. */
export function createSurplusCostRecovery(overrides: Partial<SurplusCostRecoveryDependencies> = {}) {
  const deps: SurplusCostRecoveryDependencies = {
    list: listPendingSurplusAttempts,
    settle: reconcileSurplusLlmAttemptCost,
    resolveKey: () => resolveProviderKey("surplus"),
    fetchCost: fetchSurplusSettlement,
    now: Date.now,
    ...overrides,
  };
  const shutdown = new AbortController();
  const pump = createReceiptRecoveryPump({
    async runPass(isStopped) {
      if (!deps.resolveKey()) return;
      // Give a recently updated wire a minute before reading its financial
      // receipt; compare-and-set protects
      // any concurrent local completion regardless of its duration.
      const updatedBefore = new Date(deps.now() - 60_000);
      let after: ListPendingSurplusAttemptsInput["after"];
      while (!isStopped()) {
        const rows = await deps.list({ limit: 100, updatedBefore, ...(after ? { after } : {}) });
        if (rows.length === 0) break;
        for (const row of rows) {
          if (isStopped()) return;
          // Old unbound attempts remain visibly pending for operator recovery.
          // Do not guess their creating key or wire mapping from today's catalogue.
          if (!row.providerRequestId || row.endpoint !== "/v1/chat/completions"
            || (row.fundingKind !== "server" && row.fundingKind !== "service")) continue;
          const key = deps.resolveKey();
          const binding = row.metadata;
          if (!key || binding?.["surplusCredentialFingerprint"] !== surplusCredentialFingerprint(key)
            || typeof binding["surplusModelId"] !== "string"
            || typeof binding["surplusProviderPin"] !== "string"
            || binding["surplusProviderPin"] !== row.provider) continue;
          try {
            const costMicro = await deps.fetchCost({
              apiKey: key,
              binding: {
                requestId: row.providerRequestId,
                surplusModelId: binding["surplusModelId"],
                providerPin: binding["surplusProviderPin"],
              },
              // Each read is bounded and is cancelled during server shutdown.
              signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
            });
            if (costMicro !== null && !isStopped()) {
              await deps.settle({
                attemptId: row.id,
                providerRequestId: row.providerRequestId,
                expectedUpdatedAt: row.updatedAt,
                actualCostUsd: costMicro / 1_000_000,
              });
            }
          } catch {
            // No raw provider body, exception, or key is emitted. Keep the
            // durable pending row for a later pass, including auth refusals.
            if (!isStopped()) warn("[surplus] cost receipt remains pending", { failureCode: "receipt_read_failed" });
          }
        }
        const last = rows.at(-1)!;
        after = { updatedAt: last.updatedAt, id: last.id };
        if (rows.length < 100) break;
      }
    },
    onPassFailure: () => warn("[surplus] cost recovery pass remains pending", { failureCode: "receipt_queue_unavailable" }),
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer !== null || shutdown.signal.aborted) return;
      pump.start();
      // One low-frequency, sequential queue pass bounds request-log pressure.
      timer = setInterval(pump.wake, 60_000);
      timer.unref();
    },
    wake: pump.wake,
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      shutdown.abort();
      await pump.stop();
    },
  };
}
