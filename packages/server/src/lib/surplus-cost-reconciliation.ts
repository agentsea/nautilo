import {
  fetchSurplusSettlement,
  getQualifiedSurplusEmbeddingRoute,
  resolveProviderKey,
  surplusCredentialFingerprint,
} from "@nautilo/agent";
import {
  classifySurplusLlmAttemptRecovery,
  listPendingSurplusAttempts,
  DEFAULT_SURPLUS_RECOVERY_BATCH_LIMIT,
  reconcileSurplusLlmAttemptCost,
  requeueBlockedServerSurplusAttempts,
  requeueBlockedSurplusDecisionAttempts,
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
  resolveServerCredential(): string | null;
  requeueBlockedServer(): Promise<number>;
  requeueBlockedDecisions(): Promise<number>;
  fetchCost: typeof fetchSurplusSettlement;
  fetchEmbeddingCost(input: {
    requestId: string;
    apiKey: string;
    expectedReceiptModel: string;
    knownServingProviders: readonly string[];
    observedServingProvider: string;
    signal: AbortSignal;
  }): Promise<Awaited<ReturnType<typeof fetchSurplusSettlement>>>;
  now(): number;
}

async function readBoundedReceiptJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) return null;
      size += chunk.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return null;
      }
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Embedding receipts bind both the qualified adapter model and its observed processor. */
async function fetchQualifiedEmbeddingSettlement(input: {
  requestId: string;
  apiKey: string;
  expectedReceiptModel: string;
  knownServingProviders: readonly string[];
  observedServingProvider: string;
  signal: AbortSignal;
}): Promise<Awaited<ReturnType<typeof fetchSurplusSettlement>>> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) {
    return { status: "blocked_repair", failureCode: "receipt_request_rejected" };
  }
  const response = await fetch(
    `https://api.surplusintelligence.ai/v1/requests/${encodeURIComponent(input.requestId)}`,
    {
      method: "GET",
      redirect: "error",
      signal: input.signal,
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      return { status: "blocked_repair", failureCode: "receipt_read_unauthorized" };
    }
    if (response.status === 404) {
      return { status: "retryable", failureCode: "receipt_not_found" };
    }
    if (response.status === 429) {
      return { status: "retryable", failureCode: "receipt_rate_limited" };
    }
    if (response.status >= 500) {
      return { status: "retryable", failureCode: "receipt_service_unavailable" };
    }
    return { status: "blocked_repair", failureCode: "receipt_request_rejected" };
  }
  const value = await readBoundedReceiptJson(response);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "retryable", failureCode: "receipt_not_confirmed" };
  }
  const row = value as Record<string, unknown>;
  const provider = typeof row["provider"] === "string"
    ? row["provider"].trim().toLowerCase() : "";
  if (row["request_id"] !== input.requestId
    || row["model"] !== input.expectedReceiptModel
    || !input.knownServingProviders.includes(provider)
    || provider !== input.observedServingProvider.trim().toLowerCase()
    || row["settlement_status"] !== "accrued"
    || row["settlement_type"] !== "credit"
    || (row["settlement_error"] !== undefined && row["settlement_error"] !== null)
    || typeof row["confirmed_at"] !== "string"
    || !Number.isFinite(Date.parse(row["confirmed_at"]))) {
    return { status: "retryable", failureCode: "receipt_not_confirmed" };
  }
  const cost = row["buyer_cost_micro"];
  return typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0
    ? { status: "settled", costMicro: cost }
    : { status: "retryable", failureCode: "receipt_not_confirmed" };
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
    resolveServerCredential: () => resolveProviderKey("surplus"),
    requeueBlockedServer: requeueBlockedServerSurplusAttempts,
    requeueBlockedDecisions: requeueBlockedSurplusDecisionAttempts,
    fetchCost: fetchSurplusSettlement,
    fetchEmbeddingCost: fetchQualifiedEmbeddingSettlement,
    now: Date.now,
    ...overrides,
  };
  const shutdown = new AbortController();
  let observedServerCredentialFingerprint: string | null | undefined;
  let decisionEndpointUpgradeApplied = false;

  async function wakeBlockedServerAttemptsForCurrentCredential(): Promise<void> {
    const apiKey = deps.resolveServerCredential();
    const currentFingerprint = apiKey === null ? null : surplusCredentialFingerprint(apiKey);
    if (currentFingerprint === observedServerCredentialFingerprint) return;
    if (currentFingerprint === null) {
      observedServerCredentialFingerprint = null;
      return;
    }
    await deps.requeueBlockedServer();
    // Retain only the one-way fingerprint. A failed wake remains eligible for
    // the next pass; a successful wake runs once per continuous observation.
    observedServerCredentialFingerprint = currentFingerprint;
  }

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
      if (!decisionEndpointUpgradeApplied) {
        await deps.requeueBlockedDecisions();
        decisionEndpointUpgradeApplied = true;
      }
      await wakeBlockedServerAttemptsForCurrentCredential();
      if (isStopped()) return;
      const rows = await deps.list({
        limit: DEFAULT_SURPLUS_RECOVERY_BATCH_LIMIT,
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
        const imageEndpoint = row.endpoint === "/v1/images/generations" || row.endpoint === "/v1/images/edits";
        const embeddingEndpoint = row.endpoint === "/v1/embeddings";
        if (!imageEndpoint && !embeddingEndpoint
          && row.endpoint !== "/v1/chat/completions" && row.endpoint !== "/v1/decisions") {
          await classify(row, "blocked_repair", "receipt_endpoint_unsupported");
          continue;
        }
        const binding = row.metadata;
        const unpinnedModel = !imageEndpoint && !embeddingEndpoint
          && binding?.["surplusUnpinnedModel"] === true;
        const catalogProvider = typeof binding?.["catalogModelId"] === "string"
          ? binding["catalogModelId"].split(":", 1)[0]
          : binding?.["surplusProviderPin"];
        const embeddingProviders = binding?.["surplusEmbeddingServingProviders"];
        const embeddingDimensions = binding?.["surplusEmbeddingDimensions"];
        const embeddingRoute = embeddingEndpoint
          && typeof embeddingDimensions === "number"
          ? getQualifiedSurplusEmbeddingRoute(row.model, embeddingDimensions)
          : null;
        const validEmbeddingBinding = embeddingEndpoint
          && embeddingRoute !== null
          && row.fundingKind === "service"
          && row.callType === "embedding"
          && row.provider === embeddingRoute.provider
          && binding?.["catalogModelId"] === row.model
          && binding?.["surplusModelId"] === embeddingRoute.wireModel
          && binding?.["surplusEmbeddingPolicy"] === embeddingRoute.servingPolicy
          && embeddingDimensions === embeddingRoute.dimensions
          && binding?.["surplusEmbeddingReceiptModel"] === embeddingRoute.receiptModel
          && Array.isArray(embeddingProviders)
          && embeddingProviders.length === embeddingRoute.knownServingProviders.length
          && embeddingRoute.knownServingProviders.every(
            (provider, index) => embeddingProviders[index] === provider,
          )
          && typeof row.servingProvider === "string"
          && embeddingProviders.includes(row.servingProvider.toLowerCase());
        if (typeof binding?.["surplusCredentialFingerprint"] !== "string"
          || typeof binding["surplusModelId"] !== "string"
          || (embeddingEndpoint
            ? !validEmbeddingBinding
            : imageEndpoint
            ? binding["surplusUnpinnedMedia"] !== true
            : typeof binding["surplusProviderPin"] !== "string")
          || (!embeddingEndpoint && catalogProvider !== row.provider)) {
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
        const fingerprintMismatch = binding["surplusCredentialFingerprint"]
          !== surplusCredentialFingerprint(credential.apiKey);
        const personalReplacement = row.fundingKind === "personal" && credential.replacement === true;
        if (row.fundingKind === "personal" && !personalReplacement && fingerprintMismatch) {
          await classify(row, "blocked_repair", "credential_fingerprint_mismatch");
          continue;
        }

        try {
          const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
          const result = embeddingEndpoint
            ? await deps.fetchEmbeddingCost({
                apiKey: credential.apiKey,
                requestId: row.providerRequestId,
                expectedReceiptModel: binding["surplusEmbeddingReceiptModel"] as string,
                knownServingProviders: embeddingProviders as string[],
                observedServingProvider: row.servingProvider!,
                signal,
              })
            : await deps.fetchCost({
                apiKey: credential.apiKey,
                binding: {
                  requestId: row.providerRequestId,
                  surplusModelId: binding["surplusModelId"],
                  providerPin: imageEndpoint || unpinnedModel ? null : binding["surplusProviderPin"] as string,
                  ...(unpinnedModel ? { unpinnedModel: true as const } : {}),
                },
                signal,
              });
          if (isStopped()) return;
          if (result.status === "blocked_repair") {
            await classify(row, "blocked_repair", result.failureCode);
          } else if (result.status === "retryable") {
            // A different key with no exact receipt has not established account
            // authority. Keep the charge unknown and let a credential repair
            // explicitly retry proof; do not poll the wrong account forever.
            const accountUnproven = fingerprintMismatch
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
