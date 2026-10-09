import type {
  GenerateImagesArgs,
  GenerateImagesResult,
  ImageGenerationProviderReceipt,
} from "./types";
import { readSurplusWireReceipt } from "../providers/surplus-transport";

const SURPLUS_IMAGE_ROOT = "https://api.surplusintelligence.ai";

export interface QualifiedSurplusImageRoute {
  readonly modelId: string;
  readonly surplusModelId: string;
  readonly operations: readonly ("generate" | "edit")[];
  readonly maxReferenceImages: number;
  readonly supportsMasks: false;
  readonly exactSize: false;
  /** Media provider pins are documented as accepted but currently ignored. */
  readonly privacy: "marketplace-unpinned";
}

const ROUTES = Object.freeze({
  "venice:gpt-image-2": Object.freeze({
    modelId: "venice:gpt-image-2",
    surplusModelId: "venice-gpt-image-2",
    operations: Object.freeze(["generate"] as const),
    maxReferenceImages: 0,
    supportsMasks: false,
    exactSize: false,
    privacy: "marketplace-unpinned",
  }),
} satisfies Record<string, QualifiedSurplusImageRoute>);

export function resolveSurplusImageRoute(
  modelId: string,
): QualifiedSurplusImageRoute | null {
  return ROUTES[modelId as keyof typeof ROUTES] ?? null;
}

export class SurplusImageAttemptError extends Error {
  constructor(
    message: string,
    readonly attemptOutcome: "failed" | "unknown",
    readonly failureCode: string,
    readonly receipt?: ImageGenerationProviderReceipt,
  ) {
    super(message);
    this.name = "SurplusImageAttemptError";
  }
}

export interface SurplusImageTransportObservation {
  /** Caller-generated durable request identity; Surplus documents it as echoed. */
  readonly requestId?: string;
  /** Runs after headers arrive and before any response bytes are consumed. */
  readonly onResponse?: (
    receipt: ImageGenerationProviderReceipt,
    status: number,
  ) => Promise<void> | void;
}

function operationFor(args: GenerateImagesArgs): "generate" | "edit" {
  return (args.references?.length ?? 0) > 0 ? "edit" : "generate";
}

export function assertSurplusImageRequestCompatible(
  route: QualifiedSurplusImageRoute,
  args: GenerateImagesArgs,
): "generate" | "edit" {
  const operation = operationFor(args);
  if (!route.operations.includes(operation)) {
    throw new Error(`${route.modelId} is not qualified for Surplus image ${operation}.`);
  }
  const referenceCount = args.references?.length ?? 0;
  if (referenceCount > route.maxReferenceImages) {
    throw new Error(`${route.modelId} accepts at most ${route.maxReferenceImages} reference images through Surplus.`);
  }
  if (operation === "edit" && args.count !== 1) {
    throw new Error("Surplus image editing returns exactly one image per request.");
  }
  // Live qualification showed a requested 1024x1024 generation returned
  // 1024x768, so an exact requested size stays on a qualified direct route.
  if (args.size !== "auto") {
    throw new Error(`${route.modelId} cannot guarantee exact image dimensions through Surplus.`);
  }
  if (args.background !== "auto") {
    throw new Error(`${route.modelId} cannot guarantee explicit background handling through Surplus.`);
  }
  if (args.format !== "png") {
    throw new Error(`${route.modelId} is qualified only for PNG delivery through Surplus.`);
  }
  return operation;
}

function dataUri(reference: NonNullable<GenerateImagesArgs["references"]>[number]): string {
  return `data:${reference.mime};base64,${reference.bytes.toString("base64")}`;
}

function receiptFrom(response: Response): ImageGenerationProviderReceipt {
  const receipt = readSurplusWireReceipt(response.headers);
  return {
    ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
    ...(receipt.buyerCostMicro === undefined
      ? {}
      : { buyerCostMicroUsd: receipt.buyerCostMicro }),
    ...(receipt.marketplaceAttempts === undefined
      ? {}
      : { marketplaceAttempts: receipt.marketplaceAttempts }),
    ...(receipt.adaptedParameters
      ? { adaptedParameters: receipt.adaptedParameters }
      : {}),
    ...(receipt.truncated ? { truncated: true } : {}),
  };
}

function adaptedRequiredParameters(
  adaptedParameters: string | undefined,
  sentParameters: ReadonlySet<string>,
): readonly string[] {
  if (!adaptedParameters) return [];
  return adaptedParameters
    .split(",")
    .map((parameter) => parameter.trim().toLowerCase())
    .filter((parameter) => parameter !== "" && sentParameters.has(parameter));
}

function responseFailureOutcome(
  status: number,
  receipt: ImageGenerationProviderReceipt,
): "failed" | "unknown" {
  const noSellerAttempt = receipt.marketplaceAttempts === 0
    && receipt.buyerCostMicroUsd === undefined;
  return noSellerAttempt && [400, 401, 402, 404, 429, 503].includes(status)
    ? "failed"
    : "unknown";
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

/** One synchronous paid request. Callers must never replay it after dispatch. */
export async function generateImagesSurplus(
  canonicalModelId: string,
  args: GenerateImagesArgs,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  observation: SurplusImageTransportObservation = {},
): Promise<GenerateImagesResult> {
  const route = resolveSurplusImageRoute(canonicalModelId);
  if (!route) {
    throw new Error(`${canonicalModelId} has no qualified Surplus image route.`);
  }
  const operation = assertSurplusImageRequestCompatible(route, args);
  const references = args.references ?? [];
  const body: Record<string, unknown> = {
    model: route.surplusModelId,
    prompt: args.prompt,
    response_format: "b64_json",
    ...(args.quality === "auto" ? {} : { quality: args.quality }),
    ...(operation === "generate"
      ? { n: Math.min(4, Math.max(1, Math.floor(args.count))) }
      : references.length === 1
        ? { image: dataUri(references[0]!) }
        : {
            input_images: references.map((reference, index) => ({
              url: dataUri(reference),
              role: index === 0 ? "start" : "reference",
            })),
          }),
  };
  let response: Response;
  try {
    response = await fetchImpl(
      `${SURPLUS_IMAGE_ROOT}/v1/images/${operation === "edit" ? "edits" : "generations"}`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(observation.requestId === undefined
            ? {}
            : { "X-Request-Id": observation.requestId }),
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    throw new SurplusImageAttemptError(
      "The Surplus image request may have been processed or billed. Check Costs before trying again.",
      "unknown",
      "outcome_unknown",
    );
  }
  const wireReceipt = receiptFrom(response);
  // A server-assigned response id is the authoritative financial receipt even
  // when it differs from the caller's proposed correlation id.
  const receipt: ImageGenerationProviderReceipt = observation.requestId === undefined
    || wireReceipt.requestId !== undefined
    ? wireReceipt
    : { ...wireReceipt, requestId: observation.requestId };
  try {
    await observation.onResponse?.(receipt, response.status);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new SurplusImageAttemptError(
      `Surplus image ${operation} failed (HTTP ${response.status}).`,
      responseFailureOutcome(response.status, receipt),
      responseFailureOutcome(response.status, receipt) === "failed"
        ? "provider_refused"
        : "outcome_unknown",
      receipt,
    );
  }
  if (receipt.truncated) {
    throw new SurplusImageAttemptError(
      "Surplus reported a truncated image result; the paid request was not retried.",
      "failed",
      "truncated_response",
      receipt,
    );
  }
  const adaptedRequired = adaptedRequiredParameters(
    receipt.adaptedParameters,
    new Set(Object.keys(body)),
  );
  if (adaptedRequired.length > 0) {
    throw new SurplusImageAttemptError(
      `Surplus changed required image parameter${adaptedRequired.length === 1 ? "" : "s"} (${adaptedRequired.join(", ")}); the paid result was not published and was not retried.`,
      "failed",
      "provider_adapted_parameters",
      receipt,
    );
  }
  let parsed: { data?: Array<{ b64_json?: unknown }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new SurplusImageAttemptError(
      "Surplus image generation returned invalid JSON; the request was not retried.",
      "unknown",
      "invalid_provider_response",
      receipt,
    );
  }
  const bytes = (parsed.data ?? []).map((item) => {
    if (typeof item.b64_json !== "string" || !item.b64_json) {
      throw new SurplusImageAttemptError(
        "Surplus image generation returned an incomplete result; the request was not retried.",
        "unknown",
        "invalid_provider_response",
        receipt,
      );
    }
    const decoded = Buffer.from(item.b64_json, "base64");
    if (!isPng(decoded)) {
      throw new SurplusImageAttemptError(
        "Surplus image generation returned an unqualified output format; the request was not retried.",
        "failed",
        "unsupported_output_format",
        receipt,
      );
    }
    return decoded;
  });
  const expected = operation === "edit" ? 1 : Math.min(4, Math.max(1, Math.floor(args.count)));
  if (bytes.length !== expected) {
    throw new SurplusImageAttemptError(
      "Surplus image generation returned an incomplete result; the request was not retried.",
      "unknown",
      "invalid_provider_response",
      receipt,
    );
  }
  return {
    bytes,
    model: args.model,
    mime: "image/png",
    providerReceipt: receipt,
  };
}
