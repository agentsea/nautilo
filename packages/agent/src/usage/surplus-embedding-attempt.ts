import { randomUUID } from "node:crypto";
import {
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  settleSurplusLlmAttempt,
  type SettleSurplusLlmAttemptInput,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import type { QualifiedSurplusEmbeddingRoute } from "../providers/surplus-embedding-route";
import { assertQualifiedSurplusEmbeddingReceipt } from "../providers/surplus-embedding-route";
import {
  surplusCredentialFingerprint,
  surplusReceiptTelemetry,
} from "../providers/surplus-reconciliation";
import { readSurplusWireReceipt, type SurplusWireReceipt } from "../providers/surplus-transport";
import {
  provenPreRoutingSurplusTrace,
  readBoundedSurplusErrorBody,
  safeSurplusErrorDiagnostics,
  surplusErrorTelemetry,
} from "../providers/surplus-error";
import { getUsageContext, normalizeUsageRoomId } from "./usage-context";

const SURPLUS_EMBEDDINGS_URL = "https://api.surplusintelligence.ai/v1/embeddings";

export interface SurplusEmbeddingUsageEvidence {
  readonly inputTokens?: number;
  readonly totalTokens?: number;
}

export class SurplusEmbeddingAttemptError extends Error {
  constructor(
    readonly failureCode:
      | "attempt_ledger_unavailable"
      | "provider_unavailable"
      | "invalid_response"
      | "outcome_unknown",
    readonly status?: number,
    readonly retryable = false,
    readonly vendorCode?: string,
  ) {
    super(failureCode === "provider_unavailable"
      ? "Surplus is temporarily unavailable for embeddings. Retry shortly."
      : failureCode === "attempt_ledger_unavailable"
        ? "Embedding attempt accounting is unavailable. Retry shortly."
        : failureCode === "invalid_response"
          ? "Surplus returned an invalid embedding response. Retry shortly."
          : "The Surplus embedding request may have been processed. Check Costs before trying again.");
    this.name = "SurplusEmbeddingAttemptError";
  }
}

export interface InvokeSurplusEmbeddingAttemptInput<T> {
  readonly route: QualifiedSurplusEmbeddingRoute;
  readonly apiKey: string;
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
  /** Revalidate policy, credential, selection, and disclosure after the durable begin. */
  readonly assertStillAuthorized: () => void;
  readonly parseResponse: (value: unknown) => T;
  readonly fetchImpl?: typeof fetch;
}

type AttemptDeps = Readonly<{
  mintAttemptId: () => string;
  begin: typeof beginSurplusLlmAttempt;
  attach: typeof attachSurplusRequestReceipt;
  settle: typeof settleSurplusLlmAttempt;
}>;

const DEFAULT_DEPS: AttemptDeps = {
  mintAttemptId: randomUUID,
  begin: beginSurplusLlmAttempt,
  attach: attachSurplusRequestReceipt,
  settle: settleSurplusLlmAttempt,
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

function usageEvidence(value: unknown): SurplusEmbeddingUsageEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = (value as Record<string, unknown>)["usage"];
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  const inputTokens = count(record["prompt_tokens"]);
  const totalTokens = count(record["total_tokens"]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

async function settleWithRetry(
  settle: typeof settleSurplusLlmAttempt,
  input: SettleSurplusLlmAttemptInput,
): Promise<void> {
  const immutable = Object.freeze({ ...input, settledAt: input.settledAt ?? new Date() });
  try {
    await settle(immutable);
  } catch {
    await settle(immutable);
  }
}

function receiptCostUsd(receipt: SurplusWireReceipt | undefined): number | undefined {
  return receipt?.buyerCostMicro === undefined
    ? undefined : receipt.buyerCostMicro / 1_000_000;
}

function receiptMetadata(
  route: QualifiedSurplusEmbeddingRoute,
  apiKey: string,
): Record<string, unknown> {
  return {
    catalogModelId: route.catalogModelId,
    surplusModelId: route.wireModel,
    surplusEmbeddingPolicy: route.servingPolicy,
    surplusEmbeddingDimensions: route.dimensions,
    surplusEmbeddingReceiptModel: route.receiptModel,
    surplusEmbeddingServingProviders: [...route.knownServingProviders],
    surplusCredentialFingerprint: surplusCredentialFingerprint(apiKey),
  };
}

/** Execute exactly one durable marketplace embedding request. This function never replays provider work. */
export async function invokeSurplusEmbeddingAttempt<T>(
  input: InvokeSurplusEmbeddingAttemptInput<T>,
  deps: Partial<AttemptDeps> = {},
): Promise<T> {
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  const attemptId = resolvedDeps.mintAttemptId();
  const context = getUsageContext();
  const binding = receiptMetadata(input.route, input.apiKey);
  try {
    await resolvedDeps.begin({
      id: attemptId,
      model: input.route.catalogModelId,
      provider: input.route.provider,
      endpoint: "/v1/embeddings",
      fundingKind: "service",
      callType: "embedding",
      userId: context?.funding?.humanUserId ?? context?.userId ?? null,
      roomId: normalizeUsageRoomId(context?.roomId),
      ...(typeof context?.metadata?.["taskId"] === "string"
        ? { taskId: context.metadata["taskId"] } : {}),
      metadata: binding,
    });
  } catch {
    throw new SurplusEmbeddingAttemptError("attempt_ledger_unavailable", undefined, true);
  }

  let receipt: SurplusWireReceipt | undefined;
  let responseStatus: number | undefined;
  let wireDispatched = false;
  let responseObserved = false;
  let evidence: SurplusEmbeddingUsageEvidence = {};
  let receiptAttached = false;
  let errorBodyRequestId: string | undefined;
  try {
    input.assertStillAuthorized();
    input.signal?.throwIfAborted();
    let response: Response;
    try {
      wireDispatched = true;
      response = await (input.fetchImpl ?? globalThis.fetch)(SURPLUS_EMBEDDINGS_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${input.apiKey.trim()}`,
          "Content-Type": "application/json",
          "X-Request-Id": attemptId,
        },
        body: JSON.stringify({
          model: input.route.wireModel,
          input: input.texts,
          dimensions: input.route.dimensions,
        }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      throw new SurplusEmbeddingAttemptError("outcome_unknown");
    }
    responseObserved = true;
    responseStatus = response.status;
    receipt = readSurplusWireReceipt(response.headers);
    if (receipt.requestId && response.ok) {
      try {
        await resolvedDeps.attach({
          attemptId,
          providerRequestId: receipt.requestId,
          ...(receipt.providerFamily ? { servingProvider: receipt.providerFamily.toLowerCase() } : {}),
          endpoint: "/v1/embeddings",
          metadata: surplusReceiptTelemetry(receipt),
        });
        receiptAttached = true;
      } catch {
        warn("[nautilo/surplus] embedding receipt persistence failed", {
          failureCode: "request_receipt_failed",
        });
      }
    }
    assertQualifiedSurplusEmbeddingReceipt(input.route, receipt, response.status);
    if (!response.ok) {
      let diagnostics: Awaited<ReturnType<typeof readBoundedSurplusErrorBody>> = {};
      try {
        // This response is terminal and will not be parsed elsewhere. Reading
        // it directly avoids tee cancellation waiting on an unread clone.
        diagnostics = await readBoundedSurplusErrorBody(response.body?.getReader());
      } catch {
        // Diagnostics are optional. Preserve the provider failure when the
        // runtime cannot read the error response.
      }
      errorBodyRequestId = diagnostics.requestId;
      await response.body?.cancel();
      throw new SurplusEmbeddingAttemptError(
        "provider_unavailable",
        response.status,
        response.status === 429 || response.status >= 500,
        diagnostics.vendorCode,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new SurplusEmbeddingAttemptError("invalid_response", response.status, true);
    }
    evidence = usageEvidence(value);
    let result: T;
    try {
      result = input.parseResponse(value);
    } catch (error) {
      if (error instanceof SurplusEmbeddingAttemptError) throw error;
      throw error;
    }
    const cost = receiptCostUsd(receipt);
    try {
      await settleWithRetry(resolvedDeps.settle, {
        attemptId,
        ...(receipt.requestId ? { providerRequestId: receipt.requestId } : {}),
        metadata: surplusReceiptTelemetry(receipt),
        outcome: "succeeded",
        costState: cost === undefined ? (receipt.requestId ? "pending" : "unknown") : "actual",
        ...(cost === undefined ? {} : { actualCostUsd: cost }),
        ...(evidence.inputTokens === undefined ? {} : { inputTokens: evidence.inputTokens }),
        ...(evidence.totalTokens === undefined ? {} : { totalTokens: evidence.totalTokens }),
        ...(receipt.providerFamily ? { servingProvider: receipt.providerFamily.toLowerCase() } : {}),
      });
    } catch {
      warn("[nautilo/surplus] completed embedding settlement failed", {
        failureCode: "attempt_settlement_failed",
      });
    }
    return result;
  } catch (error) {
    const cancelled = input.signal?.aborted === true;
    const cost = receiptCostUsd(receipt);
    const knownPreWireZero = !wireDispatched;
    const matchingBodyRequestId = errorBodyRequestId !== undefined
      && (receipt?.requestId === undefined || receipt.requestId === errorBodyRequestId)
      ? errorBodyRequestId
      : undefined;
    const trace = provenPreRoutingSurplusTrace({
      error,
      responseStatus,
      receipt,
      ...(matchingBodyRequestId === undefined ? {} : { requestId: matchingBodyRequestId }),
    });
    const safeDiagnostics = safeSurplusErrorDiagnostics(error, responseStatus);
    const failureCode = cancelled
      ? "cancelled"
      : !wireDispatched
        ? "pre_wire_authorization_changed"
      : error instanceof SurplusEmbeddingAttemptError
        ? error.failureCode
        : responseObserved
          ? "invalid_response"
          : "outcome_unknown";
    if (!trace && receipt?.requestId && !receiptAttached) {
      try {
        await resolvedDeps.attach({
          attemptId,
          providerRequestId: receipt.requestId,
          ...(receipt.providerFamily ? { servingProvider: receipt.providerFamily.toLowerCase() } : {}),
          endpoint: "/v1/embeddings",
          metadata: {
            ...surplusReceiptTelemetry(receipt),
            ...surplusErrorTelemetry(safeDiagnostics),
          },
        });
        receiptAttached = true;
      } catch {
        warn("[nautilo/surplus] embedding receipt persistence failed", {
          failureCode: "request_receipt_failed",
        });
      }
    }
    try {
      await settleWithRetry(resolvedDeps.settle, {
        attemptId,
        ...(!trace && receipt?.requestId ? { providerRequestId: receipt.requestId } : {}),
        ...(!receipt && Object.keys(safeDiagnostics).length === 0 ? {} : {
          metadata: {
            ...(receipt ? surplusReceiptTelemetry(receipt) : {}),
            ...surplusErrorTelemetry(trace ?? safeDiagnostics),
          },
        }),
        outcome: cancelled ? "cancelled" : responseObserved || !wireDispatched ? "failed" : "unknown",
        costState: knownPreWireZero || trace || cost !== undefined
          ? "actual" : receipt?.requestId ? "pending" : "unknown",
        ...(knownPreWireZero || trace ? { actualCostUsd: 0 }
          : cost === undefined ? {} : { actualCostUsd: cost }),
        ...(evidence.inputTokens === undefined ? {} : { inputTokens: evidence.inputTokens }),
        ...(evidence.totalTokens === undefined ? {} : { totalTokens: evidence.totalTokens }),
        ...(receipt?.providerFamily ? { servingProvider: receipt.providerFamily.toLowerCase() } : {}),
        failureCode,
      });
    } catch {
      warn("[nautilo/surplus] embedding attempt settlement failed", {
        failureCode: "attempt_settlement_failed",
      });
    }
    if (cancelled) throw input.signal?.reason ?? error;
    if (!wireDispatched) throw error;
    if (error instanceof SurplusEmbeddingAttemptError) throw error;
    throw new SurplusEmbeddingAttemptError("invalid_response", responseStatus, true);
  }
}
