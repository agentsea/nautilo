import { randomUUID } from "node:crypto";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import {
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  settleSurplusLlmAttempt,
  type SettleSurplusLlmAttemptInput,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { getUsageContext, normalizeUsageRoomId, type UsageFundingProvenance } from "../usage/usage-context";
import { modelRouteProvider } from "./model-route";
import type { QualifiedSurplusChatRoute } from "./surplus-route";
import type { ReasoningEffort } from "./types";
import { surplusAttemptBinding, surplusReceiptTelemetry } from "./surplus-reconciliation";
import {
  createSurplusChatModel,
  isSafeSurplusDirectFallback,
  SurplusOutcomeUnknownError,
  type SurplusWireReceipt,
} from "./surplus-transport";

type InvokeModel = (
  model: { invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<unknown> },
  messages: BaseMessage[],
  config: RunnableConfig,
) => Promise<AIMessage>;

export interface SurplusChatAttemptInput {
  readonly route: QualifiedSurplusChatRoute;
  readonly apiKey: string;
  readonly messages: BaseMessage[];
  readonly tools: readonly StructuredTool[];
  readonly config: RunnableConfig;
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly reasoningOutput?: boolean;
  readonly openrouterSessionId?: string;
  readonly funding: UsageFundingProvenance;
  readonly invokeModel: InvokeModel;
}

export type SurplusChatAttemptResult =
  | Readonly<{ kind: "served"; response: AIMessage; requestId?: string }>
  | Readonly<{ kind: "direct_fallback" }>;

export class SurplusProviderRouteMismatchError extends Error {
  readonly code = "surplus_provider_route_mismatch" as const;

  constructor() {
    super("The Surplus response did not confirm the qualified serving provider.");
    this.name = "SurplusProviderRouteMismatchError";
  }
}

export class SurplusAdaptedParametersError extends Error {
  readonly code = "surplus_adapted_parameters" as const;

  constructor() {
    super("The Surplus response changed qualified request parameters.");
    this.name = "SurplusAdaptedParametersError";
  }
}

export class SurplusIncompleteResponseError extends Error {
  readonly code = "surplus_incomplete_response" as const;

  constructor() {
    super("The Surplus response ended without valid completion metadata.");
    this.name = "SurplusIncompleteResponseError";
  }
}

export interface SurplusFailedAttemptDisposition {
  readonly outcome: "cancelled" | "failed" | "interrupted" | "unknown";
  readonly costState: "actual" | "pending" | "unknown";
  readonly actualCostUsd?: number;
  readonly failureCode:
    | "cancelled"
    | "no_sellers_for_model"
    | "pre_service_refusal"
    | "adapted_parameters"
    | "provider_route_mismatch"
    | "truncated_response"
    | "incomplete_response"
    | "outcome_unknown";
  readonly directFallback: boolean;
}

export function canUseQualifiedSurplusChatRoute(input: {
  route: QualifiedSurplusChatRoute | null;
  funding: UsageFundingProvenance;
  prefersSurplus: boolean;
  hasSurplusCredential: boolean;
  needsVision: boolean;
  requiresTools: boolean;
  reasoningRequested: boolean;
  hasRequestChangingServingProfile: boolean;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}): input is typeof input & { route: QualifiedSurplusChatRoute } {
  const route = input.route;
  if (!route || !input.prefersSurplus || !input.hasSurplusCredential) return false;
  if (input.hasRequestChangingServingProfile
    || (input.funding.kind === "personal" && input.funding.providerRoute !== "surplus")) return false;
  if (input.needsVision && !route.supportsVision) return false;
  if (input.requiresTools && !route.supportsTools) return false;
  if (input.reasoningRequested && !route.supportsReasoning) return false;
  if (input.maxOutputTokens > route.maxOutputTokens) return false;
  return input.estimatedInputTokens + input.maxOutputTokens <= route.maxContextTokens;
}

function hasUnsupportedSurplusAdaptation(adaptedParameters: string | undefined): boolean {
  const adapted = adaptedParameters?.trim();
  // This key only chooses a prompt cache bucket. It does not change the prompt,
  // model, output budget, or reasoning controls. Other or mixed adaptations
  // still fail closed; cache retention and session affinity are not exempt.
  return Boolean(adapted && adapted !== "prompt_cache_key");
}

/** A successful marketplace response must preserve the provider and inference settings. */
export function assertSuccessfulSurplusProviderReceipt(
  route: QualifiedSurplusChatRoute,
  receipt: SurplusWireReceipt,
  responseStatus: number,
): void {
  if (responseStatus < 200 || responseStatus >= 300) return;
  if (hasUnsupportedSurplusAdaptation(receipt.adaptedParameters)) {
    throw new SurplusAdaptedParametersError();
  }
  if (receipt.providerFamily?.trim().toLowerCase() !== route.providerPin) {
    throw new SurplusProviderRouteMismatchError();
  }
}

const TERMINAL_FINISH_REASONS = new Set([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "function_call",
]);

/** A complete answer needs both an untruncated receipt and SDK-observed terminal metadata. */
export function assertCompleteSurplusResponse(
  receipt: SurplusWireReceipt | undefined,
  response: AIMessage,
): void {
  const finishReason = record(response.response_metadata)?.["finish_reason"];
  if (receipt?.truncated || typeof finishReason !== "string" || !TERMINAL_FINISH_REASONS.has(finishReason)) {
    throw new SurplusIncompleteResponseError();
  }
}

/** Content-free terminal classification shared by persistence and isolated tests. */
export function classifySurplusFailedAttempt(input: {
  readonly error: unknown;
  readonly cancelled: boolean;
  readonly responseStatus: number | undefined;
  readonly receipt: SurplusWireReceipt | undefined;
  readonly terminalUsage?: ReturnType<typeof readSurplusResponseUsage>;
}): SurplusFailedAttemptDisposition {
  const safe = !input.cancelled
    && input.receipt?.truncated !== true
    && !input.receipt?.adaptedParameters?.trim()
    && !(input.error instanceof SurplusAdaptedParametersError)
    && !(input.error instanceof SurplusProviderRouteMismatchError)
    && !(input.error instanceof SurplusIncompleteResponseError)
    && isSafeSurplusDirectFallback(input.error, input.responseStatus, input.receipt, false);
  const knownCostMicro = input.terminalUsage?.buyerCostMicro ?? input.receipt?.buyerCostMicro;
  const costState = knownCostMicro !== undefined
    ? "actual" as const
    : input.receipt?.requestId
      ? "pending" as const
      : "unknown" as const;
  const failureCode = input.cancelled
    ? "cancelled" as const
    : input.receipt?.truncated === true
      ? "truncated_response" as const
      : hasUnsupportedSurplusAdaptation(input.receipt?.adaptedParameters) || input.error instanceof SurplusAdaptedParametersError
        ? "adapted_parameters" as const
        : input.error instanceof SurplusProviderRouteMismatchError
          ? "provider_route_mismatch" as const
          : input.error instanceof SurplusIncompleteResponseError
            ? "incomplete_response" as const
            : safe
              ? input.responseStatus === 404
                ? "no_sellers_for_model" as const
                : "pre_service_refusal" as const
              : "outcome_unknown" as const;
  return {
    outcome: input.cancelled
      ? "cancelled"
      : input.receipt?.truncated === true
        ? "interrupted"
        : input.error instanceof SurplusIncompleteResponseError
          ? "interrupted"
        : safe
          ? "failed"
          : "unknown",
    costState,
    ...(costState === "actual"
      ? { actualCostUsd: (knownCostMicro ?? 0) / 1_000_000 }
      : {}),
    failureCode,
    directFallback: safe,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A terminal usage receipt can carry cost when stream headers cannot. */
export function readSurplusResponseUsage(message: AIMessage): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  buyerCostMicro?: number;
} {
  const metadata = record(message.response_metadata);
  const rawUsage = record(metadata?.["usage"]);
  const normalized = record(message.usage_metadata);
  const inDetails = record(normalized?.["input_token_details"]);
  const outDetails = record(normalized?.["output_token_details"]);
  const cost = count(rawUsage?.["buyer_cost_micro"]);
  const inputTokens = count(normalized?.["input_tokens"]) ?? count(rawUsage?.["prompt_tokens"]);
  const outputTokens = count(normalized?.["output_tokens"]) ?? count(rawUsage?.["completion_tokens"]);
  const totalTokens = count(normalized?.["total_tokens"]) ?? count(rawUsage?.["total_tokens"]);
  const reasoningTokens = count(outDetails?.["reasoning"]) ?? count(record(rawUsage?.["completion_tokens_details"])?.["reasoning_tokens"]);
  const cachedInputTokens = count(inDetails?.["cache_read"]) ?? count(record(rawUsage?.["prompt_tokens_details"])?.["cached_tokens"]);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cost !== undefined ? { buyerCostMicro: cost } : {}),
  };
}

/** Retry one idempotent row settlement without replaying provider work. */
async function settleSurplusAttemptWithRetry(input: SettleSurplusLlmAttemptInput): Promise<void> {
  const settlement = Object.freeze(input);
  try {
    await settleSurplusLlmAttempt(settlement);
  } catch {
    // The first write may have committed before its result was lost. Reusing
    // the same immutable update makes either case safe and preserves every
    // terminal usage count still available in this process.
    await settleSurplusLlmAttempt(settlement);
  }
}

/** One marketplace wire attempt and its durable, content-free cost receipt. */
export async function invokeSurplusChatAttempt(input: SurplusChatAttemptInput): Promise<SurplusChatAttemptResult> {
  if (input.funding.kind === "personal" && input.funding.providerRoute !== "surplus") {
    throw new Error("A personal marketplace attempt requires its admitted marketplace credential.");
  }
  const attemptId = randomUUID();
  const context = getUsageContext();
  const provider = modelRouteProvider(input.route.catalogModelId);
  try {
    await beginSurplusLlmAttempt({
    id: attemptId,
    model: input.route.catalogModelId,
    provider,
    endpoint: "/v1/chat/completions",
    fundingKind: input.funding.kind,
    ...(input.funding.kind === "personal" ? {
      payerHumanId: input.funding.payerHumanId, credentialId: input.funding.credentialId,
      credentialRevision: input.funding.credentialRevision,
    } : {}),
    callType: context?.callType ?? "chat",
    userId: input.funding.kind === "personal" ? input.funding.humanUserId
      : context?.userId ?? input.funding.humanUserId ?? null,
    roomId: normalizeUsageRoomId(context?.roomId),
    ...(typeof context?.metadata?.["taskId"] === "string" ? { taskId: context.metadata["taskId"] } : {}),
    metadata: {
      ...surplusAttemptBinding(input.route, input.apiKey),
      catalogModelId: input.route.catalogModelId,
      ...(typeof context?.metadata?.["taskRunId"] === "string" ? { taskRunId: context.metadata["taskRunId"] } : {}),
      ...(typeof context?.metadata?.["agentId"] === "string" ? { agentId: context.metadata["agentId"] } : {}),
      ...(typeof context?.metadata?.["turnId"] === "string" ? { turnId: context.metadata["turnId"] } : {}),
    },
    });
  } catch {
    // No marketplace request was sent. Keep service available through the
    // existing direct path when the attempt ledger cannot be opened.
    warn("[nautilo/surplus] attempt ledger unavailable", { failureCode: "attempt_begin_failed" });
    return { kind: "direct_fallback" };
  }

  let receipt: SurplusWireReceipt | undefined;
  let responseStatus: number | undefined;
  let terminalUsage: ReturnType<typeof readSurplusResponseUsage> | undefined;
  const onResponse = async (next: SurplusWireReceipt, status: number) => {
    receipt = next;
    responseStatus = status;
    if (next.requestId) {
      try {
        await attachSurplusRequestReceipt({
          attemptId,
          providerRequestId: next.requestId,
          ...(next.providerFamily ? { servingProvider: next.providerFamily } : {}),
          metadata: surplusReceiptTelemetry(next),
        });
      } catch {
        warn("[nautilo/surplus] request receipt persistence failed", { failureCode: "request_receipt_failed" });
      }
    }
    assertSuccessfulSurplusProviderReceipt(input.route, next, status);
  };
  try {
    const model = createSurplusChatModel({
      route: input.route,
      apiKey: input.apiKey,
      maxOutputTokens: input.maxOutputTokens,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.reasoningOutput === undefined ? {} : { reasoningOutput: input.reasoningOutput }),
      ...(input.openrouterSessionId === undefined ? {} : { openrouterSessionId: input.openrouterSessionId }),
      onResponse,
    });
    const bound = input.tools.length > 0 ? model.bindTools?.([...input.tools]) : model;
    if (!bound) throw new Error("The selected Surplus route cannot bind tools.");
    const response = await input.invokeModel(
      bound as { invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<unknown> },
      input.messages,
      input.config,
    );
    terminalUsage = readSurplusResponseUsage(response);
    assertCompleteSurplusResponse(receipt, response);
    const usage = terminalUsage;
    const costMicro = usage.buyerCostMicro ?? receipt?.buyerCostMicro;
    try {
      await settleSurplusAttemptWithRetry({
        attemptId,
        ...(receipt?.requestId ? { providerRequestId: receipt.requestId } : {}),
        ...(receipt ? { metadata: surplusReceiptTelemetry(receipt) } : {}),
        outcome: "succeeded",
        costState: costMicro === undefined ? (receipt?.requestId ? "pending" : "unknown") : "actual",
        ...(costMicro === undefined ? {} : { actualCostUsd: costMicro / 1_000_000 }),
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
        ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
        ...(receipt?.providerFamily ? { servingProvider: receipt.providerFamily } : {}),
      });
    } catch {
      // The pre-inserted attempt remains pending for reconciliation. A
      // completed model answer must not be converted into another paid call.
      warn("[nautilo/surplus] completed attempt settlement failed", { failureCode: "attempt_settlement_failed" });
    }
    return {
      kind: "served",
      response,
      ...(receipt?.requestId ? { requestId: receipt.requestId } : {}),
    };
  } catch (error) {
    const cancelled = input.config.signal?.aborted === true;
    const disposition = classifySurplusFailedAttempt({
      error,
      cancelled,
      responseStatus,
      receipt,
      ...(terminalUsage === undefined ? {} : { terminalUsage }),
    });
    try {
      await settleSurplusAttemptWithRetry({
        attemptId,
        ...(receipt?.requestId ? { providerRequestId: receipt.requestId } : {}),
        ...(receipt ? { metadata: surplusReceiptTelemetry(receipt) } : {}),
        outcome: disposition.outcome,
        costState: disposition.costState,
        ...(disposition.actualCostUsd === undefined ? {} : { actualCostUsd: disposition.actualCostUsd }),
        ...(terminalUsage?.inputTokens === undefined ? {} : { inputTokens: terminalUsage.inputTokens }),
        ...(terminalUsage?.outputTokens === undefined ? {} : { outputTokens: terminalUsage.outputTokens }),
        ...(terminalUsage?.totalTokens === undefined ? {} : { totalTokens: terminalUsage.totalTokens }),
        ...(terminalUsage?.reasoningTokens === undefined ? {} : { reasoningTokens: terminalUsage.reasoningTokens }),
        ...(terminalUsage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: terminalUsage.cachedInputTokens }),
        ...(receipt?.providerFamily ? { servingProvider: receipt.providerFamily } : {}),
        failureCode: disposition.failureCode,
      });
    } catch {
      warn("[nautilo/surplus] attempt settlement failed", { failureCode: "attempt_settlement_failed" });
    }
    if (cancelled) throw input.config.signal?.reason ?? error;
    if (disposition.directFallback) return { kind: "direct_fallback" };
    throw new SurplusOutcomeUnknownError();
  }
}
