import { insertLlmUsageEvent } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import {
  PRICING_VERSION,
  estimateCostUsd,
  estimateImageCostUsd,
  getProviderFromModelId,
  resolveImagePrice,
  resolveModelPrice,
  type UsagePricingSource,
} from "../config/model-pricing";
import {
  normalizeUsageRoomId,
  type UsageCallType,
  type UsageFundingProvenance,
  type UsageModelControlMetadata,
} from "./usage-context";

export interface RecordUsageInput {
  /** Full model id, e.g. `anthropic:claude-sonnet-4-6`. */
  model: string;
  callType: UsageCallType;
  userId?: string | null;
  roomId?: string | null;
  /** Trusted durable Task identity projected by the execution owner. */
  taskId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  /** Cache-write/creation input tokens (Anthropic); priced at the write rate. */
  cacheCreationTokens?: number;
  totalTokens?: number;
  /** Provider-reported dollar cost (OpenRouter/gateway). Overrides the estimate as `actual`. */
  actualCostUsd?: number | null;
  /** For image-gen calls: number of images produced (priced per-image). */
  imageCount?: number;
  modelControl?: UsageModelControlMetadata;
  funding?: UsageFundingProvenance;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget: compute the USD estimate and persist one usage row. Never
 * throws into the caller — LLM cost accounting must not be able to break a
 * user's turn. Skips rows with no signal (no tokens and no images).
 */
export function recordLlmUsage(input: RecordUsageInput): void {
  void recordLlmUsageAsync(input).catch((err) => {
    warn(
      `[nautilo/usage] failed to record LLM usage for ${input.model}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

async function recordLlmUsageAsync(input: RecordUsageInput): Promise<void> {
  const funding = input.funding;
  const imageCount = input.imageCount ?? 0;
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  if (imageCount <= 0 && inputTokens <= 0 && outputTokens <= 0) {
    return;
  }

  const usagePricingSource: UsagePricingSource =
    imageCount > 0
      ? resolveImagePrice(input.model).source
      : resolveModelPrice(input.model, input.modelControl?.servingProfileId).source;

  const estimatedCostUsd =
    imageCount > 0
      ? estimateImageCostUsd(input.model, imageCount)
      : estimateCostUsd(input.model, {
          inputTokens,
          outputTokens,
          reasoningTokens: input.reasoningTokens ?? 0,
          cachedInputTokens: input.cachedInputTokens ?? 0,
          cacheCreationTokens: input.cacheCreationTokens ?? 0,
        }, input.modelControl?.servingProfileId);

  await insertLlmUsageEvent({
    userId: input.userId ?? funding?.humanUserId ?? null,
    roomId: normalizeUsageRoomId(input.roomId),
    taskId: input.taskId ?? null,
    callType: input.callType,
    provider: getProviderFromModelId(input.model),
    model: input.model,
    inputTokens,
    outputTokens,
    reasoningTokens: input.reasoningTokens ?? 0,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    estimatedCostUsd,
    actualCostUsd: input.actualCostUsd ?? null,
    pricingVersion: PRICING_VERSION,
    fundingKind: funding?.kind ?? null,
    payerHumanId: funding?.kind === "personal" ? funding.payerHumanId : null,
    providerRoute: funding?.providerRoute ?? null,
    credentialId: funding?.kind === "personal" ? funding.credentialId : null,
    credentialRevision:
      funding?.kind === "personal" ? funding.credentialRevision : null,
    metadata: {
      ...(input.metadata ?? {}),
      usagePricingSource,
      ...(input.modelControl
        ? {
            canonicalModelId: input.modelControl.canonicalModelId,
            effectiveModelId: input.modelControl.effectiveModelId,
            ...(input.modelControl.requestedReasoningEffort === undefined ? {} : { requestedReasoningEffort: input.modelControl.requestedReasoningEffort }),
            ...(input.modelControl.effectiveReasoningEffort === undefined ? {} : { effectiveReasoningEffort: input.modelControl.effectiveReasoningEffort }),
            ...(input.modelControl.servingProfileId === undefined ? {} : { servingProfileId: input.modelControl.servingProfileId }),
            ...(input.modelControl.servingSelector === undefined ? {} : { servingSelector: input.modelControl.servingSelector }),
          }
        : {}),
      ...(imageCount > 0 ? { imageCount } : {}),
      // No dedicated column for cache-write tokens; keep them on the row for
      // auditability (cost already reflects them via the write rate).
      ...(input.cacheCreationTokens ? { cacheCreationTokens: input.cacheCreationTokens } : {}),
    },
  });
}
