import { randomUUID } from "node:crypto";
import {
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  settleSurplusLlmAttempt,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import {
  getUsageContext,
  normalizeUsageRoomId,
  type UsageFundingProvenance,
} from "../usage/usage-context";
import {
  surplusCredentialFingerprint,
  surplusReceiptTelemetry,
} from "../providers/surplus-reconciliation";
import type {
  GenerateImagesArgs,
  GenerateImagesResult,
  ImageGenerationProviderReceipt,
} from "./types";
import {
  generateImagesSurplus,
  SurplusImageAttemptError,
  type QualifiedSurplusImageRoute,
} from "./surplus";

export interface SurplusImageAttemptInput {
  readonly route: QualifiedSurplusImageRoute;
  readonly canonicalModelId: string;
  readonly args: GenerateImagesArgs;
  readonly apiKey: string;
  readonly funding: UsageFundingProvenance;
}

export interface SurplusImageAttemptDeps {
  readonly mintAttemptId?: () => string;
  readonly begin?: typeof beginSurplusLlmAttempt;
  readonly attach?: typeof attachSurplusRequestReceipt;
  readonly settle?: typeof settleSurplusLlmAttempt;
  readonly invoke?: typeof generateImagesSurplus;
}

/** A failed attempt whose durable settlement could not be confirmed is never replayable. */
export class SurplusImageAttemptLedgerError extends Error {
  constructor(readonly attemptError: unknown) {
    super("Surplus image attempt accounting is unavailable; the request was not retried.");
    this.name = "SurplusImageAttemptLedgerError";
  }
}

function canonicalProvider(modelId: string): string {
  const separator = modelId.indexOf(":");
  if (separator < 1) throw new Error("A canonical image model id is required.");
  return modelId.slice(0, separator);
}

function endpointFor(args: GenerateImagesArgs): "/v1/images/generations" | "/v1/images/edits" {
  return (args.references?.length ?? 0) > 0
    ? "/v1/images/edits"
    : "/v1/images/generations";
}

function receiptTelemetry(receipt: ImageGenerationProviderReceipt): Record<string, unknown> {
  return surplusReceiptTelemetry({
    ...(receipt.requestId === undefined ? {} : { requestId: receipt.requestId }),
    ...(receipt.buyerCostMicroUsd === undefined
      ? {}
      : { buyerCostMicro: receipt.buyerCostMicroUsd }),
    ...(receipt.marketplaceAttempts === undefined
      ? {}
      : { marketplaceAttempts: receipt.marketplaceAttempts }),
    ...(receipt.adaptedParameters === undefined
      ? {}
      : { adaptedParameters: receipt.adaptedParameters }),
    truncated: receipt.truncated === true,
  });
}

function actualCostUsd(receipt: ImageGenerationProviderReceipt | undefined): number | undefined {
  return receipt?.buyerCostMicroUsd === undefined
    ? undefined
    : receipt.buyerCostMicroUsd / 1_000_000;
}

/** One durable marketplace image attempt. It never retries provider work. */
export async function invokeSurplusImageAttempt(
  input: SurplusImageAttemptInput,
  deps: SurplusImageAttemptDeps = {},
): Promise<GenerateImagesResult> {
  if (input.route.modelId !== input.canonicalModelId) {
    throw new Error("The qualified Surplus image route does not match the selected model.");
  }
  if (input.funding.kind === "personal" && input.funding.providerRoute !== "surplus") {
    throw new Error("A personal marketplace image attempt requires its admitted marketplace credential.");
  }
  const begin = deps.begin ?? beginSurplusLlmAttempt;
  const attach = deps.attach ?? attachSurplusRequestReceipt;
  const settle = deps.settle ?? settleSurplusLlmAttempt;
  const invoke = deps.invoke ?? generateImagesSurplus;
  const attemptId = (deps.mintAttemptId ?? randomUUID)();
  const endpoint = endpointFor(input.args);
  const context = getUsageContext();
  const metadata = {
    surplusUnpinnedMedia: true,
    surplusModelId: input.route.surplusModelId,
    catalogModelId: input.canonicalModelId,
    surplusCredentialFingerprint: surplusCredentialFingerprint(input.apiKey),
    ...(typeof context?.metadata?.["taskRunId"] === "string"
      ? { taskRunId: context.metadata["taskRunId"] }
      : {}),
    ...(typeof context?.metadata?.["agentId"] === "string"
      ? { agentId: context.metadata["agentId"] }
      : {}),
    ...(typeof context?.metadata?.["turnId"] === "string"
      ? { turnId: context.metadata["turnId"] }
      : {}),
  };

  await begin({
    id: attemptId,
    model: input.canonicalModelId,
    provider: canonicalProvider(input.canonicalModelId),
    endpoint,
    fundingKind: input.funding.kind,
    ...(input.funding.kind === "personal" ? {
      payerHumanId: input.funding.payerHumanId,
      credentialId: input.funding.credentialId,
      credentialRevision: input.funding.credentialRevision,
    } : {}),
    callType: "image_gen",
    userId: input.funding.kind === "personal"
      ? input.funding.humanUserId
      : context?.userId ?? input.funding.humanUserId ?? null,
    roomId: normalizeUsageRoomId(context?.roomId),
    ...(typeof context?.metadata?.["taskId"] === "string"
      ? { taskId: context.metadata["taskId"] }
      : {}),
    metadata,
  });

  let receipt: ImageGenerationProviderReceipt | undefined;
  let providerRequestId: string | undefined;
  try {
    const result = await invoke(
      input.canonicalModelId,
      input.args,
      input.apiKey,
      globalThis.fetch,
      {
        requestId: attemptId,
        onResponse: async (next) => {
          receipt = next;
          providerRequestId = next.requestId;
          if (providerRequestId !== undefined) {
            await attach({
              attemptId,
              providerRequestId,
              endpoint,
              metadata: receiptTelemetry(next),
            });
          }
        },
      },
    );
    const cost = actualCostUsd(result.providerReceipt ?? receipt);
    try {
      await settle({
        attemptId,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(receipt === undefined ? {} : { metadata: receiptTelemetry(receipt) }),
        outcome: "succeeded",
        costState: cost === undefined ? "pending" : "actual",
        ...(cost === undefined ? {} : { actualCostUsd: cost }),
      });
    } catch {
      warn("[nautilo/surplus] completed image attempt settlement failed", {
        failureCode: "attempt_settlement_failed",
      });
    }
    return result;
  } catch (error) {
    const attemptError = error instanceof SurplusImageAttemptError ? error : null;
    const errorReceipt = attemptError?.receipt ?? receipt;
    providerRequestId = errorReceipt?.requestId ?? providerRequestId;
    const cost = actualCostUsd(errorReceipt);
    try {
      await settle({
        attemptId,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(errorReceipt === undefined ? {} : { metadata: receiptTelemetry(errorReceipt) }),
        outcome: attemptError?.attemptOutcome ?? "unknown",
        costState: cost === undefined
          ? providerRequestId === undefined ? "unknown" : "pending"
          : "actual",
        ...(cost === undefined ? {} : { actualCostUsd: cost }),
        failureCode: attemptError?.failureCode ?? "outcome_unknown",
      });
    } catch {
      warn("[nautilo/surplus] image attempt settlement failed", {
        failureCode: "attempt_settlement_failed",
      });
      throw new SurplusImageAttemptLedgerError(error);
    }
    throw error;
  }
}
