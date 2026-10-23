import { randomUUID } from "node:crypto";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
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
import { invalidateSurplusModelCatalog } from "./surplus-catalog";
import type { ReasoningEffort } from "./types";
import { surplusAttemptBinding, surplusReceiptTelemetry } from "./surplus-reconciliation";
import {
  provenPreRoutingSurplusTrace,
  safeSurplusErrorDiagnostics,
  surplusErrorTelemetry,
  SurplusMarketplaceAttemptError,
} from "./surplus-error";
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
  /** Omit the provider pin for the one admitted same-model marketplace retry. */
  readonly providerMode?: "any";
  readonly messages: BaseMessage[];
  readonly tools: readonly StructuredTool[];
  readonly toolBindingOptions?: Record<string, unknown>;
  readonly config: RunnableConfig;
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly reasoningOutput?: boolean;
  readonly openrouterSessionId?: string;
  readonly funding: UsageFundingProvenance;
  /** True only after this attempt delivered text or an executable action outside the provider buffer. */
  readonly hasDeliveredOutput: () => boolean;
  readonly invokeModel: InvokeModel;
  readonly validateResponse?: (response: AIMessage) => void;
  /** Optional live authority fence, evaluated after admission and immediately before provider work. */
  readonly assertStillAuthorized?: () => void | Promise<void>;
  /** Narrow service callers may retry direct only after a proven pre-service refusal. */
  readonly directFallbackPolicy?: "pre_service_only";
}

export type SurplusChatAttemptResult =
  | Readonly<{ kind: "served"; response: AIMessage; requestId?: string }>
  | Readonly<{
      kind: "direct_fallback";
      retryUnpinned?: true;
      /** Exact-model supply was refused before any marketplace seller attempt. */
      modelUnavailableBeforeService?: true;
      /** Content-free typed cause retained when optional recovery is unavailable. */
      failure?: Error;
    }>;

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
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1
    || input.maxOutputTokens > route.maxOutputTokens) return false;
  return input.estimatedInputTokens + input.maxOutputTokens <= route.maxContextTokens;
}

type SurplusAdaptationKind = "none" | "benign" | "output_ceiling" | "unsupported";

function surplusAdaptationKind(adaptedParameters: string | undefined): SurplusAdaptationKind {
  const adapted = adaptedParameters?.trim();
  if (!adapted) return "none";
  const parameters = adapted.split(",").map((parameter) => parameter.trim());
  if (parameters.some((parameter) => !parameter)
    || new Set(parameters).size !== parameters.length) return "unsupported";
  let outputCeilingAdapted = false;
  for (const parameter of parameters) {
    // Surplus may choose a cache bucket and overwrite stream_options with
    // include_usage:true for metering, which our adapter already requests.
    if (parameter === "prompt_cache_key" || parameter === "stream_options") continue;
    // The receipt names the parameter but not how it changed. Defer these two
    // ceiling aliases until the completed response can prove that the actual
    // result stayed within the caller's original budget.
    if (parameter === "max_tokens" || parameter === "max_completion_tokens") {
      outputCeilingAdapted = true;
      continue;
    }
    return "unsupported";
  }
  return outputCeilingAdapted ? "output_ceiling" : "benign";
}

function hasUnsupportedSurplusAdaptation(adaptedParameters: string | undefined): boolean {
  return surplusAdaptationKind(adaptedParameters) === "unsupported";
}

/** A successful marketplace response must preserve the provider and inference settings. */
export function assertSuccessfulSurplusProviderReceipt(
  route: QualifiedSurplusChatRoute,
  receipt: SurplusWireReceipt,
  responseStatus: number,
  providerMode?: "any",
): void {
  if (responseStatus < 200 || responseStatus >= 300) return;
  if (hasUnsupportedSurplusAdaptation(receipt.adaptedParameters)) {
    throw new SurplusAdaptedParametersError();
  }
  const servingProvider = receipt.providerFamily?.trim().toLowerCase();
  if (!servingProvider || (providerMode !== "any" && servingProvider !== route.providerPin)) {
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
  response: unknown,
  maxOutputTokens?: number,
): void {
  if (!AIMessage.isInstance(response)) throw new SurplusIncompleteResponseError();
  const message = response;
  const finishReason = record(message.response_metadata)?.["finish_reason"];
  if (receipt?.truncated || typeof finishReason !== "string" || !TERMINAL_FINISH_REASONS.has(finishReason)) {
    throw new SurplusIncompleteResponseError();
  }
  const adaptation = surplusAdaptationKind(receipt?.adaptedParameters);
  if (adaptation === "unsupported") throw new SurplusAdaptedParametersError();
  if (adaptation === "output_ceiling") {
    if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
      || finishReason === "length") throw new SurplusAdaptedParametersError();
    // LangChain can synthesize a normalized zero while merging absent usage
    // fields. Require the raw terminal completion count emitted by Surplus.
    const rawUsage = record(record(message.response_metadata)?.["usage"]);
    const actualOutputTokens = count(rawUsage?.["completion_tokens"]);
    if (actualOutputTokens === undefined || actualOutputTokens > maxOutputTokens) {
      throw new SurplusAdaptedParametersError();
    }
  }
  // A provider-enforced content filter is a valid terminal answer even when it
  // deliberately carries no text. Every other successful terminal must give
  // Nautilo something useful to deliver or execute.
  if (finishReason !== "content_filter" && !hasUsableSurplusResponse(message)) {
    throw new SurplusIncompleteResponseError();
  }
}

function hasUsableSurplusResponse(response: AIMessage): boolean {
  const hasText = (value: unknown): boolean => typeof value === "string"
    ? value.trim().length > 0
    : Array.isArray(value) && value.some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        const block = record(part);
        if (!block) return false;
        if (typeof block["text"] === "string" && block["text"].trim().length > 0) return true;
        return typeof block["type"] === "string"
          && ["tool_use", "tool_call", "function_call"].includes(block["type"])
          && typeof block["name"] === "string" && block["name"].trim().length > 0;
      });
  if (hasText(response.content)) return true;
  if (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) return true;
  const additional = record(response.additional_kwargs);
  if (Array.isArray(additional?.["tool_calls"]) && additional["tool_calls"].length > 0) return true;
  const functionCall = record(additional?.["function_call"]);
  return typeof functionCall?.["name"] === "string" && functionCall["name"].trim().length > 0;
}

/** Content-free terminal classification shared by persistence and isolated tests. */
export function classifySurplusFailedAttempt(input: {
  readonly error: unknown;
  readonly cancelled: boolean;
  readonly responseStatus: number | undefined;
  readonly receipt: SurplusWireReceipt | undefined;
  readonly deliveredOutput: boolean;
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
      : ["output_ceiling", "unsupported"].includes(surplusAdaptationKind(input.receipt?.adaptedParameters))
        || input.error instanceof SurplusAdaptedParametersError
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
    // Product policy prefers producing a result even when the marketplace may
    // already have charged. Financial uncertainty remains on this attempt; it
    // does not prohibit one admitted same-model direct attempt when nothing was
    // delivered. Cancellation and delivered output remain terminal.
    directFallback: !input.cancelled && !input.deliveredOutput,
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

function nonEmptyMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Content-free correlation needed to prevent replay after a lost Memory result. */
function memoryAttemptCorrelation(context: ReturnType<typeof getUsageContext>): Record<string, string> {
  if (context?.callType === "memory_review") {
    const workId = nonEmptyMetadataString(context.metadata, "workId");
    const attemptId = nonEmptyMetadataString(context.metadata, "attemptId");
    return workId && attemptId ? { workId, attemptId } : {};
  }
  if (context?.callType === "room_stenographer"
    || context?.callType === "room_event_compaction"
    || context?.callType === "room_reflection"
    || context?.callType === "image_assistance") {
    const operationId = nonEmptyMetadataString(context.metadata, "operationId");
    return operationId ? { operationId } : {};
  }
  return {};
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
      ...surplusAttemptBinding(input.route, input.apiKey, input.providerMode),
      catalogModelId: input.route.catalogModelId,
      ...(typeof context?.metadata?.["taskRunId"] === "string" ? { taskRunId: context.metadata["taskRunId"] } : {}),
      ...(typeof context?.metadata?.["agentId"] === "string" ? { agentId: context.metadata["agentId"] } : {}),
      ...(typeof context?.metadata?.["turnId"] === "string" ? { turnId: context.metadata["turnId"] } : {}),
      ...memoryAttemptCorrelation(context),
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
  let authorizationGuardEntered = false;
  let invocationEntered = false;
  let receiptAttached = false;
  const onResponse = async (next: SurplusWireReceipt, status: number) => {
    receipt = next;
    responseStatus = status;
    // Successful streamed responses expose a settlement id. Error responses
    // may expose only a pre-routing trace id, so defer those until the stable
    // error code and attempt count are available in the catch path.
    if (next.requestId && status >= 200 && status < 300) {
      try {
        await attachSurplusRequestReceipt({
          attemptId,
          providerRequestId: next.requestId,
          ...(next.providerFamily ? { servingProvider: next.providerFamily } : {}),
          metadata: surplusReceiptTelemetry(next),
        });
        receiptAttached = true;
      } catch {
        warn("[nautilo/surplus] request receipt persistence failed", { failureCode: "request_receipt_failed" });
      }
    }
    assertSuccessfulSurplusProviderReceipt(input.route, next, status, input.providerMode);
  };
  try {
    const model = createSurplusChatModel({
      route: input.route,
      apiKey: input.apiKey,
      ...(input.providerMode === undefined ? {} : { providerMode: input.providerMode }),
      maxOutputTokens: input.maxOutputTokens,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.reasoningOutput === undefined ? {} : { reasoningOutput: input.reasoningOutput }),
      ...(input.openrouterSessionId === undefined ? {} : { openrouterSessionId: input.openrouterSessionId }),
      onResponse,
    });
    const bound = input.tools.length > 0 ? model.bindTools?.([...input.tools], input.toolBindingOptions) : model;
    if (!bound) throw new Error("The selected Surplus route cannot bind tools.");
    if (input.assertStillAuthorized) {
      authorizationGuardEntered = true;
      await input.assertStillAuthorized();
      input.config.signal?.throwIfAborted();
    }
    invocationEntered = true;
    const response = await input.invokeModel(
      bound as { invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<unknown> },
      input.messages,
      input.config,
    );
    terminalUsage = readSurplusResponseUsage(response);
    assertCompleteSurplusResponse(receipt, response, input.maxOutputTokens);
    input.validateResponse?.(response);
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
    const guardRejectedBeforeInvocation = authorizationGuardEntered && !invocationEntered;
    const disposition = guardRejectedBeforeInvocation
      ? {
          outcome: cancelled ? "cancelled" as const : "failed" as const,
          costState: "actual" as const,
          actualCostUsd: 0,
          failureCode: cancelled ? "cancelled" as const : "authorization_changed" as const,
          directFallback: false,
        }
      : classifySurplusFailedAttempt({
          error,
          cancelled,
          responseStatus,
          receipt,
          deliveredOutput: input.hasDeliveredOutput(),
          ...(terminalUsage === undefined ? {} : { terminalUsage }),
        });
    const safeDiagnostics = safeSurplusErrorDiagnostics(error, responseStatus);
    const trace = provenPreRoutingSurplusTrace({ error, responseStatus, receipt });
    if (trace?.vendorCode === "no_sellers_for_model" || error instanceof SurplusAdaptedParametersError) {
      // Refresh metadata for the next admission; this never replays a request
      // whose output or billing may already have occurred.
      invalidateSurplusModelCatalog();
    }
    const failure = new SurplusMarketplaceAttemptError(trace ?? safeDiagnostics);
    if (!trace && receipt?.requestId && !receiptAttached) {
      try {
        await attachSurplusRequestReceipt({
          attemptId,
          providerRequestId: receipt.requestId,
          ...(receipt.providerFamily ? { servingProvider: receipt.providerFamily } : {}),
          metadata: {
            ...surplusReceiptTelemetry(receipt),
            ...surplusErrorTelemetry(safeDiagnostics),
          },
        });
        receiptAttached = true;
      } catch {
        warn("[nautilo/surplus] request receipt persistence failed", { failureCode: "request_receipt_failed" });
      }
    }
    try {
      await settleSurplusAttemptWithRetry({
        attemptId,
        ...(!trace && receipt?.requestId ? { providerRequestId: receipt.requestId } : {}),
        ...(!receipt && Object.keys(safeDiagnostics).length === 0 ? {} : {
          metadata: {
            ...(receipt ? surplusReceiptTelemetry(receipt) : {}),
            ...surplusErrorTelemetry(trace ?? safeDiagnostics),
          },
        }),
        outcome: disposition.outcome,
        costState: trace ? "actual" : disposition.costState,
        ...(trace ? { actualCostUsd: 0 }
          : disposition.actualCostUsd === undefined ? {} : { actualCostUsd: disposition.actualCostUsd }),
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
    if (guardRejectedBeforeInvocation) throw error;
    if (cancelled) throw input.config.signal?.reason ?? error;
    if (disposition.directFallback
      && (input.directFallbackPolicy !== "pre_service_only" || disposition.outcome === "failed")) {
      const modelUnavailableBeforeService = input.directFallbackPolicy === "pre_service_only"
        && disposition.outcome === "failed"
        && receipt?.marketplaceAttempts === 0
        && (responseStatus === 404 || responseStatus === 503);
      return {
        kind: "direct_fallback",
        failure,
        ...(input.providerMode !== "any" && disposition.failureCode === "no_sellers_for_model"
          ? { retryUnpinned: true as const }
          : {}),
        ...(modelUnavailableBeforeService ? { modelUnavailableBeforeService: true as const } : {}),
      };
    }
    throw new SurplusOutcomeUnknownError();
  }
}
