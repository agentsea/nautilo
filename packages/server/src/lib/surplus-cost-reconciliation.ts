import {
  fetchSurplusSettlement,
  resolveProviderKey,
  surplusCredentialFingerprint,
} from "@nautilo/agent";
import {
  classifySurplusLlmAttemptRecovery,
  listPendingSurplusAttempts,
  reconcileSurplusLlmAttemptCost,
} from "@nautilo/db";
import type {
  ListPendingSurplusAttemptsInput,
  SurplusPendingAttempt,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { resolvePersonalSurplusReceiptCredential } from "./personal-provider-custody";
import { createReceiptRecoveryPump } from "./receipt-recovery";

type RecoveryCredential =
  | { status: "available"; apiKey: string; receiptReadStatus: "available" | "unavailable" | "unknown"; replacement?: boolean }
  | { status: "blocked_repair"; reason: "missing" | "replaced" | "custody_unavailable" };

interface SurplusCostRecoveryDependencies {
  list(input: ListPendingSurplusAttemptsInput): Promise<SurplusPendingAttempt[]>;
  settle(input: Parameters<typeof reconcileSurplusLlmAttemptCost>[0]): Promise<boolean>;
  classify(input: Parameters<typeof classifySurplusLlmAttemptRecovery>[0]): Promise<boolean>;
  resolveCredential(row: SurplusPendingAttempt): Promise<RecoveryCredential> | RecoveryCredential;
  fetchCost: typeof fetchSurplusSettlement;
  now(): number;
}

function defaultCredential(row: SurplusPendingAttempt): Promise<RecoveryCredential> | RecoveryCredential {
  if (row.fundingKind === "personal") {
    if (!row.payerHumanId || !row.credentialId || !row.credentialRevision) {
      return { status: "blocked_repair", reason: "missing" };
    }
    return resolvePersonalSurplusReceiptCredential({
      userId: row.payerHumanId,
      credentialId: row.credentialId,
      credentialRevision: row.credentialRevision,
    });
  }
  const apiKey = resolveProviderKey("surplus");
  return apiKey
    ? { status: "available", apiKey, receiptReadStatus: "unknown" }
    : { status: "blocked_repair", reason: "missing" };
}

/** Financial recovery continues when preference is off; it never sends an inference request. */
export function createSurplusCostRecovery(overrides: Partial<SurplusCostRecoveryDependencies> = {}) {
  const deps: SurplusCostRecoveryDependencies = {
    list: listPendingSurplusAttempts,
    settle: reconcileSurplusLlmAttemptCost,
    classify: classifySurplusLlmAttemptRecovery,
    resolveCredential: defaultCredential,
    fetchCost: fetchSurplusSettlement,
    now: Date.now,
    ...overrides,
  };
  const shutdown = new AbortController();

  async function classify(
    row: SurplusPendingAttempt,
    recoveryState: "retryable" | "blocked_repair",
    failureCode: string,
  ): Promise<void> {
    if (shutdown.signal.aborted) return;
    await deps.classify({
      attemptId: row.id,
      expectedUpdatedAtToken: row.updatedAtToken,
      recoveryState,
      failureCode,
    });
  }

  const pump = createReceiptRecoveryPump({
    async runPass(isStopped) {
      const rows = await deps.list({
        limit: 100,
        updatedBefore: new Date(deps.now() - 60_000),
      });
      for (const row of rows) {
        if (isStopped()) return;
        if (!row.providerRequestId) {
          await classify(
            row,
            row.attemptOutcome === "in_progress" ? "retryable" : "blocked_repair",
            row.attemptOutcome === "in_progress"
              ? "receipt_binding_pending" : "receipt_binding_missing",
          );
          continue;
        }
        if (row.endpoint !== "/v1/chat/completions") {
          await classify(row, "blocked_repair", "receipt_endpoint_unsupported");
          continue;
        }
        const binding = row.metadata;
        const catalogProvider = typeof binding?.["catalogModelId"] === "string"
          ? binding["catalogModelId"].split(":", 1)[0]
          : binding?.["surplusProviderPin"];
        if (typeof binding?.["surplusCredentialFingerprint"] !== "string"
          || typeof binding["surplusModelId"] !== "string"
          || typeof binding["surplusProviderPin"] !== "string"
          || catalogProvider !== row.provider) {
          await classify(row, "blocked_repair", "receipt_binding_invalid");
          continue;
        }

        let credential: RecoveryCredential;
        try {
          credential = await deps.resolveCredential(row);
        } catch {
          await classify(row, "retryable", "credential_lookup_failed");
          warn("[surplus] receipt credential lookup remains unresolved", {
            failureCode: "credential_lookup_failed",
          });
          continue;
        }
        if (credential.status === "blocked_repair") {
          await classify(row, "blocked_repair", `credential_${credential.reason}`);
          continue;
        }
        // List-scope denial does not prove exact-request denial. Surplus may
        // authorize the creating key or a replacement with account log access.
        // Only the fixed authenticated exact-receipt endpoint can establish it.
        const personalReplacement = row.fundingKind === "personal" && credential.replacement === true;
        if (!personalReplacement
          && binding["surplusCredentialFingerprint"] !== surplusCredentialFingerprint(credential.apiKey)) {
          await classify(row, "blocked_repair", "credential_fingerprint_mismatch");
          continue;
        }

        try {
          const result = await deps.fetchCost({
            apiKey: credential.apiKey,
            binding: {
              requestId: row.providerRequestId,
              surplusModelId: binding["surplusModelId"],
              providerPin: binding["surplusProviderPin"],
            },
            signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
          });
          if (isStopped()) return;
          if (result.status === "blocked_repair") {
            await classify(row, "blocked_repair", result.failureCode);
          } else if (result.status === "retryable") {
            // A different key with no exact receipt has not established account
            // authority. Keep the charge unknown and let a credential repair
            // explicitly retry proof; do not poll the wrong account forever.
            const accountUnproven = personalReplacement
              && binding["surplusCredentialFingerprint"] !== surplusCredentialFingerprint(credential.apiKey)
              && result.failureCode === "receipt_not_found";
            await classify(row, accountUnproven ? "blocked_repair" : "retryable",
              accountUnproven ? "receipt_account_unproven" : result.failureCode);
          } else {
            await deps.settle({
              attemptId: row.id,
              providerRequestId: row.providerRequestId,
              expectedUpdatedAtToken: row.updatedAtToken,
              actualCostUsd: result.costMicro / 1_000_000,
            });
          }
        } catch {
          if (!isStopped()) {
            await classify(row, "retryable", "receipt_read_failed");
            warn("[surplus] cost receipt remains unresolved", {
              failureCode: "receipt_read_failed",
            });
          }
        }
      }
    },
    onPassFailure: () => warn("[surplus] cost recovery pass remains pending", {
      failureCode: "receipt_queue_unavailable",
    }),
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer !== null || shutdown.signal.aborted) return;
      pump.start();
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
