import type { SurplusWireReceipt } from "./surplus-transport";

export const SURPLUS_EMBEDDING_MARKETPLACE_POLICY_VERSION =
  "surplus-embedding-marketplace-v1" as const;

export const QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID =
  "venice:text-embedding-3-large" as const;
const QUALIFIED_MODEL = "text-embedding-3-large";
const QUALIFIED_DIMENSIONS = 1_536;
const QUALIFIED_RECEIPT_MODEL = "venice-embed-1";
const KNOWN_SERVING_PROVIDERS = Object.freeze(["mordiem", "venice"] as const);
const QUALIFIED_ADAPTED_PARAMETER = "safe_mode";

export interface QualifiedSurplusEmbeddingRoute {
  readonly catalogModelId: typeof QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID;
  readonly provider: "venice";
  readonly model: typeof QUALIFIED_MODEL;
  readonly dimensions: typeof QUALIFIED_DIMENSIONS;
  readonly wireModel: typeof QUALIFIED_MODEL;
  readonly responseModel: typeof QUALIFIED_MODEL;
  readonly receiptModel: typeof QUALIFIED_RECEIPT_MODEL;
  readonly servingPolicy: typeof SURPLUS_EMBEDDING_MARKETPLACE_POLICY_VERSION;
  readonly knownServingProviders: typeof KNOWN_SERVING_PROVIDERS;
}

const QUALIFIED_ROUTE: QualifiedSurplusEmbeddingRoute = Object.freeze({
  catalogModelId: QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID,
  provider: "venice",
  model: QUALIFIED_MODEL,
  dimensions: QUALIFIED_DIMENSIONS,
  wireModel: QUALIFIED_MODEL,
  responseModel: QUALIFIED_MODEL,
  receiptModel: QUALIFIED_RECEIPT_MODEL,
  servingPolicy: SURPLUS_EMBEDDING_MARKETPLACE_POLICY_VERSION,
  knownServingProviders: KNOWN_SERVING_PROVIDERS,
});

/** Return the one embedding space qualified for the marketplace transport. */
export function getQualifiedSurplusEmbeddingRoute(
  catalogModelId: string,
  dimensions: number,
): QualifiedSurplusEmbeddingRoute | null {
  return catalogModelId === QUALIFIED_ROUTE.catalogModelId
    && dimensions === QUALIFIED_ROUTE.dimensions
    ? QUALIFIED_ROUTE
    : null;
}

export class SurplusEmbeddingReceiptError extends Error {
  readonly code = "surplus_embedding_receipt_invalid" as const;

  constructor() {
    super("Surplus returned an unqualified embedding response.");
    this.name = "SurplusEmbeddingReceiptError";
  }
}

/** Successful embedding responses must identify a qualified processor and preserve parameters. */
export function assertQualifiedSurplusEmbeddingReceipt(
  route: QualifiedSurplusEmbeddingRoute,
  receipt: SurplusWireReceipt,
  responseStatus: number,
): void {
  if (responseStatus < 200 || responseStatus >= 300) return;
  const servingProvider = receipt.providerFamily?.trim().toLowerCase();
  if (!servingProvider || !route.knownServingProviders.includes(
    servingProvider as (typeof route.knownServingProviders)[number],
  )) {
    throw new SurplusEmbeddingReceiptError();
  }
  // Qualified Mordiem/Venice probes consistently disclose this one adapter change.
  // Keep the allowance bound to the observed token without inferring its semantics.
  const adaptedParameters = receipt.adaptedParameters
    ?.split(",")
    .map((parameter) => parameter.trim())
    .filter(Boolean);
  if (adaptedParameters?.length
    && (adaptedParameters.length !== 1
      || adaptedParameters[0] !== QUALIFIED_ADAPTED_PARAMETER)) {
    throw new SurplusEmbeddingReceiptError();
  }
  if (receipt.truncated) throw new SurplusEmbeddingReceiptError();
}

/** Validate the successful response's model alias before accepting any vectors. */
export function assertQualifiedSurplusEmbeddingResponseModel(
  route: QualifiedSurplusEmbeddingRoute,
  value: unknown,
): void {
  const model = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)["model"]
    : undefined;
  if (model !== route.responseModel) throw new SurplusEmbeddingReceiptError();
}
