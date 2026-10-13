import type { ToolContext } from "@nautilo/catalog";
import { warn } from "@nautilo/logger";
import { estimateImageCostUsd, PRICING_VERSION } from "../config/model-pricing";
import {
  beginToolProviderCostAttempt,
  type ProviderCostRecorder,
} from "../usage/provider-cost-recorder";
import type { UsageFundingProvenance } from "../usage/usage-context";
import type { GenerateImagesArgs, GenerateImagesResult } from "./types";
import { DirectImageAttemptError } from "./errors";

function operationFor(args: GenerateImagesArgs): "image_generation" | "image_edit" {
  return (args.references?.length ?? 0) > 0 ? "image_edit" : "image_generation";
}

async function settleDirectImageAttempt(
  recorder: ProviderCostRecorder,
  input: {
    canonicalModelId: string;
    provider: string;
    operation: "image_generation" | "image_edit";
    result?: GenerateImagesResult;
    error?: unknown;
  },
): Promise<void> {
  if (input.result) {
    const estimatedCostUsd = estimateImageCostUsd(
      input.canonicalModelId,
      input.result.bytes.length,
    ).toFixed(6);
    await recorder({
      provider: input.provider,
      operation: input.operation,
      estimatedCostUsd,
      actualCostUsd: null,
      evidenceState: "estimated",
      attemptOutcome: "succeeded",
      pricingVersion: PRICING_VERSION,
      measuredUnits: input.result.bytes.length,
      unitType: "image",
    });
    return;
  }
  const typed = input.error instanceof DirectImageAttemptError ? input.error : null;
  await recorder({
    provider: input.provider,
    operation: input.operation,
    actualCostUsd: null,
    evidenceState: "unknown",
    attemptOutcome: typed?.attemptOutcome ?? "unknown",
    failureCode: typed?.failureCode ?? "outcome_unknown",
  });
}

/** Opens and settles one request-local direct image provider cost attempt. */
export async function runFundedDirectImageAttempt(input: {
  readonly context?: ToolContext;
  readonly canonicalModelId: string;
  readonly provider: string;
  readonly usageFunding: UsageFundingProvenance;
  readonly args: GenerateImagesArgs;
  readonly invoke: () => Promise<GenerateImagesResult>;
  readonly beginProviderCostAttempt?: typeof beginToolProviderCostAttempt;
}): Promise<GenerateImagesResult> {
  const operation = operationFor(input.args);
  const recorder = await (input.beginProviderCostAttempt
    ?? beginToolProviderCostAttempt)(input.context, {
    provider: input.provider,
    operation,
    usageFunding: input.usageFunding,
  });
  let result: GenerateImagesResult;
  try {
    result = await input.invoke();
  } catch (error) {
    try {
      await settleDirectImageAttempt(recorder, {
        canonicalModelId: input.canonicalModelId,
        provider: input.provider,
        operation,
        error,
      });
    } catch {
      warn("[nautilo/image] failed provider attempt settlement remains unknown", {
        failureCode: "attempt_settlement_failed",
      });
    }
    throw error;
  }
  try {
    await settleDirectImageAttempt(recorder, {
      canonicalModelId: input.canonicalModelId,
      provider: input.provider,
      operation,
      result,
    });
  } catch {
    // The pre-dispatch unknown row remains truthful and repairable. Never
    // discard a valid paid result or cause the caller to repeat inference.
    warn("[nautilo/image] completed provider attempt settlement remains unknown", {
      failureCode: "attempt_settlement_failed",
    });
  }
  return result;
}
