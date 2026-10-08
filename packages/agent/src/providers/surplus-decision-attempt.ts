import { randomUUID } from "node:crypto";
import {
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  settleSurplusLlmAttempt,
  type SettleSurplusLlmAttemptInput,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { getUsageContext, normalizeUsageRoomId, type UsageFundingProvenance } from "../usage/usage-context";
import { modelRouteProvider } from "./model-route";
import type { QualifiedSurplusDecisionRoute } from "./surplus-decision-route";
import { surplusCredentialFingerprint, surplusReceiptTelemetry } from "./surplus-reconciliation";
import {
  isSafeSurplusDirectFallback,
  readSurplusWireReceipt,
  SurplusOutcomeUnknownError,
  type SurplusWireReceipt,
} from "./surplus-transport";

const SURPLUS_DECISIONS_URL = "https://api.surplusintelligence.ai/v1/decisions";

export class SurplusDecisionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Surplus decision request was refused.");
    this.name = "SurplusDecisionHttpError";
  }
}

export class SurplusDecisionDirectFallbackError extends Error {
  readonly code = "surplus_decision_direct_fallback" as const;

  constructor() {
    super("Surplus did not return a usable decision; try the admitted direct route.");
    this.name = "SurplusDecisionDirectFallbackError";
  }
}

interface ParsedSurplusDecision<T> {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Validate and project the parsed provider envelope after usage is retained. */
  readonly finalize: () => T;
}

function errorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const top = payload as Record<string, unknown>;
  const error = top["error"] && typeof top["error"] === "object"
    ? top["error"] as Record<string, unknown>
    : undefined;
  const code = error?.["code"] ?? top["code"];
  return typeof code === "string" ? code.trim().toLowerCase() || undefined : undefined;
}

function safeDecisionFallback(
  error: unknown,
  receipt: SurplusWireReceipt | undefined,
): boolean {
  if (!(error instanceof SurplusDecisionHttpError)) return false;
  const code = errorCode(error.payload);
  // The current machine-readable contract identifies this pilot gate as an
  // endpoint admission refusal. No provider attempt has begun.
  if (error.status === 403 && code === "buyer_not_in_allowlist") return true;
  if (error.status === 400 && code === "unsupported_provider") return true;
  return isSafeSurplusDirectFallback(error.payload, error.status, receipt, false);
}

async function settleWithRetry(input: SettleSurplusLlmAttemptInput): Promise<void> {
  const settlement = Object.freeze({ ...input, settledAt: input.settledAt ?? new Date() });
  try {
    await settleSurplusLlmAttempt(settlement);
  } catch {
    await settleSurplusLlmAttempt(settlement);
  }
}

interface SurplusDecisionAttemptDependencies {
  readonly begin?: typeof beginSurplusLlmAttempt;
  readonly attach?: typeof attachSurplusRequestReceipt;
  readonly settle?: typeof settleSurplusLlmAttempt;
}

/** One synchronous native-decision marketplace attempt and its durable cost receipt. */
export async function invokeSurplusDecisionAttempt<T>(input: {
  readonly route: QualifiedSurplusDecisionRoute;
  readonly apiKey: string;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly funding: UsageFundingProvenance;
  readonly fetchImpl?: typeof fetch;
  readonly parse: (response: Response) => Promise<ParsedSurplusDecision<T>>;
}, dependencies: SurplusDecisionAttemptDependencies = {}): Promise<T> {
  if (input.funding.kind === "personal" && input.funding.providerRoute !== "surplus") {
    throw new Error("A personal marketplace attempt requires its admitted marketplace credential.");
  }
  const attemptId = randomUUID();
  const context = getUsageContext();
  try {
    await (dependencies.begin ?? beginSurplusLlmAttempt)({
      id: attemptId,
      model: input.route.catalogModelId,
      provider: modelRouteProvider(input.route.catalogModelId),
      endpoint: "/v1/decisions",
      fundingKind: input.funding.kind,
      ...(input.funding.kind === "personal" ? {
        payerHumanId: input.funding.payerHumanId,
        credentialId: input.funding.credentialId,
        credentialRevision: input.funding.credentialRevision,
      } : {}),
      callType: context?.callType ?? "other",
      userId: input.funding.kind === "personal"
        ? input.funding.humanUserId
        : context?.userId ?? input.funding.humanUserId ?? null,
      roomId: normalizeUsageRoomId(context?.roomId),
      ...(typeof context?.metadata?.["taskId"] === "string"
        ? { taskId: context.metadata["taskId"] }
        : {}),
      metadata: {
        surplusModelId: input.route.surplusModelId,
        surplusProviderPin: input.route.providerPin,
        surplusCredentialFingerprint: surplusCredentialFingerprint(input.apiKey),
        catalogModelId: input.route.catalogModelId,
        operation: "decision",
        ...(typeof context?.metadata?.["taskRunId"] === "string"
          ? { taskRunId: context.metadata["taskRunId"] }
          : {}),
        ...(typeof context?.metadata?.["agentId"] === "string"
          ? { agentId: context.metadata["agentId"] }
          : {}),
        ...(typeof context?.metadata?.["turnId"] === "string"
          ? { turnId: context.metadata["turnId"] }
          : {}),
      },
    });
  } catch {
    // Accounting admission happens before the external wire. A missing ledger
    // cannot be repaired after spending, so do not send the request.
    throw new Error("Surplus decision attempt accounting is unavailable.");
  }

  let receipt: SurplusWireReceipt | undefined;
  let parsed: ParsedSurplusDecision<T> | undefined;
  try {
    const response = await (input.fetchImpl ?? globalThis.fetch)(SURPLUS_DECISIONS_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${input.apiKey.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": attemptId,
      },
      body: input.body,
      signal: input.signal,
    });
    receipt = readSurplusWireReceipt(response.headers);
    if (receipt.requestId) {
      try {
        await (dependencies.attach ?? attachSurplusRequestReceipt)({
          attemptId,
          providerRequestId: receipt.requestId,
          ...(receipt.providerFamily ? { servingProvider: receipt.providerFamily } : {}),
          endpoint: "/v1/decisions",
          metadata: surplusReceiptTelemetry(receipt),
        });
      } catch {
        warn("[nautilo/surplus] decision request receipt persistence failed", {
          failureCode: "request_receipt_failed",
        });
      }
    }
    parsed = await input.parse(response);
    const value = parsed.finalize();
    const costMicro = receipt.buyerCostMicro;
    try {
      const settlement = {
        attemptId,
        ...(receipt.requestId ? { providerRequestId: receipt.requestId } : {}),
        metadata: surplusReceiptTelemetry(receipt),
        outcome: "succeeded",
        costState: costMicro === undefined
          ? receipt.requestId ? "pending" : "unknown"
          : "actual",
        ...(costMicro === undefined ? {} : { actualCostUsd: costMicro / 1_000_000 }),
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        totalTokens: parsed.inputTokens + parsed.outputTokens,
        ...(receipt.providerFamily ? { servingProvider: receipt.providerFamily } : {}),
      } satisfies SettleSurplusLlmAttemptInput;
      if (dependencies.settle) await dependencies.settle(settlement);
      else await settleWithRetry(settlement);
    } catch {
      warn("[nautilo/surplus] completed decision settlement failed", {
        failureCode: "attempt_settlement_failed",
      });
    }
    return value;
  } catch (error) {
    const cancelled = input.signal.aborted;
    const safeFallback = !cancelled && safeDecisionFallback(error, receipt);
    const costMicro = receipt?.buyerCostMicro;
    const outcome = cancelled ? "cancelled" as const
      : safeFallback ? "failed" as const
        : "unknown" as const;
    const failureCode = cancelled ? "cancelled"
      : safeFallback ? "pre_service_refusal"
        : "outcome_unknown";
    try {
      const settlement = {
        attemptId,
        ...(receipt?.requestId ? { providerRequestId: receipt.requestId } : {}),
        ...(receipt ? { metadata: surplusReceiptTelemetry(receipt) } : {}),
        outcome,
        costState: costMicro === undefined
          ? receipt?.requestId ? "pending" : "unknown"
          : "actual",
        ...(costMicro === undefined ? {} : { actualCostUsd: costMicro / 1_000_000 }),
        ...(parsed === undefined ? {} : {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.inputTokens + parsed.outputTokens,
        }),
        ...(receipt?.providerFamily ? { servingProvider: receipt.providerFamily } : {}),
        failureCode,
      } satisfies SettleSurplusLlmAttemptInput;
      if (dependencies.settle) await dependencies.settle(settlement);
      else await settleWithRetry(settlement);
    } catch {
      warn("[nautilo/surplus] decision attempt settlement failed", {
        failureCode: "attempt_settlement_failed",
      });
    }
    if (cancelled) throw input.signal.reason ?? error;
    if (safeFallback) throw new SurplusDecisionDirectFallbackError();
    throw new SurplusOutcomeUnknownError();
  }
}
