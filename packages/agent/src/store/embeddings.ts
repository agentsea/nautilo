import { fromRuntimeConfig } from "@nautilo/config";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import {
  sameMemoryEmbeddingDisclosureV2,
  type MemoryEmbeddingDisclosureV2,
} from "@nautilo/lattice-crypto/wire";
import { resolveProviderKey } from "../resolve-provider-key";
import {
  runServiceEmbeddingAttempt,
  type ServiceEmbeddingAttemptEvidence,
} from "../usage/service-embedding-attempt";
import { VENICE_EMBEDDINGS_URL } from "../providers/venice-api";
import { resolveOpenRouterTransport } from "../providers/openrouter-transport";
import {
  assertQualifiedSurplusEmbeddingResponseModel,
  getQualifiedSurplusEmbeddingRoute,
  QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID,
  type QualifiedSurplusEmbeddingRoute,
} from "../providers/surplus-embedding-route";
import {
  invokeSurplusEmbeddingAttempt,
  SurplusEmbeddingAttemptError,
} from "../usage/surplus-embedding-attempt";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_VENICE_EMBEDDING_MODEL = "text-embedding-qwen3-8b";
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

import type { EmbeddingProvider, EmbeddingWithProvenanceV1 } from "@nautilo/types";
export type { EmbeddingProvider, EmbeddingWithProvenanceV1 } from "@nautilo/types";

export type EmbeddingErrorCode =
  | "missing_credentials"
  | "request_failed"
  | "invalid_response"
  | "unsupported_provider";


/**
 * A provider-safe embedding failure. The message is suitable for an operator
 * surface and deliberately never includes provider response bodies or keys.
 */
export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly provider: EmbeddingProvider | null;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    code: EmbeddingErrorCode;
    provider: EmbeddingProvider | null;
    status?: number;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "EmbeddingProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

interface ResolvedEmbeddingProvider {
  provider: EmbeddingProvider;
  apiKey: string;
  endpoint: string;
  model: string;
  transport: "direct" | "surplus_marketplace";
  surplusRoute?: QualifiedSurplusEmbeddingRoute;
}

const SURPLUS_EMBEDDING_DATA_RECIPIENT_CLASSES = Object.freeze([
  "surplus",
  "marketplace_seller",
  "seller_upstream_processor",
] as const);

function getEmbeddingConfig(modelOverride?: string | null) {
  const config = fromRuntimeConfig();
  const serverModel = modelOverride === undefined
    ? getCachedServerModelConfigRow()?.embeddingModel
    : modelOverride;
  return {
    // null/undefined inherit the runtime setting. An explicitly empty server
    // value deliberately requests automatic provider selection.
    model: serverModel == null ? config.nautilo_embedding_model : serverModel,
    dims: config.nautilo_embedding_dims,
  };
}

export function getEmbeddingDims(): number {
  return getEmbeddingConfig().dims;
}

/** Public disclosure metadata only; credentials and endpoints never leave this owner. */
export function getProtectedMemoryEmbeddingConfiguration(
  modelOverride?: string | null,
): Readonly<{
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}> {
  const configured = getEmbeddingConfig(modelOverride);
  const resolved = resolveEmbeddingExecution(configured.model, configured.dims);
  return Object.freeze({ provider: resolved.provider, model: resolved.model,
    dimensions: configured.dims });
}

function disclosureFor(
  resolved: ResolvedEmbeddingProvider,
  dimensions: number,
): Readonly<MemoryEmbeddingDisclosureV2> {
  if (dimensions !== 1_536) {
    throw new EmbeddingProviderError({
      message: "Protected Memory embeddings require exactly 1,536 dimensions.",
      code: "unsupported_provider",
      provider: resolved.provider,
    });
  }
  const canonicalSpace = Object.freeze({
    provider: resolved.provider,
    model: resolved.model,
    dimensions: 1_536 as const,
  });
  if (resolved.transport === "direct") {
    return Object.freeze({
      contractVersion: 2,
      canonicalSpace,
      processingRoute: Object.freeze({ transport: "direct" as const }),
    });
  }
  return Object.freeze({
    contractVersion: 2,
    canonicalSpace,
    processingRoute: Object.freeze({
      transport: "surplus_marketplace",
      marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
      dataRecipientClasses: SURPLUS_EMBEDDING_DATA_RECIPIENT_CLASSES,
    }),
  });
}

/** Current protected-Memory processing disclosure, including marketplace recipients. */
export function getMemoryEmbeddingDisclosure(): Readonly<MemoryEmbeddingDisclosureV2> {
  const configured = getEmbeddingConfig();
  return disclosureFor(resolveEmbeddingExecution(configured.model, configured.dims), configured.dims);
}

function openRouterModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.toLowerCase().startsWith("openrouter:")) {
    return trimmed.slice("openrouter:".length);
  }
  // Existing bare model ids are OpenAI ids. OpenRouter's embedding router uses
  // the canonical `provider/model` form documented for these same models.
  return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
}

function embeddingProviderLabel(provider: EmbeddingProvider): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "venice") return "Venice";
  return "OpenAI";
}

function resolveEmbeddingProvider(model: string): ResolvedEmbeddingProvider {
  const trimmedModel = model.trim();
  const veniceKey = resolveProviderKey("venice", {});
  const directOpenRouterKey = resolveProviderKey("openrouter", {});
  const openAiKey = resolveProviderKey("openai", {});
  const explicitlyVenice = trimmedModel.toLowerCase().startsWith("venice:");
  const explicitlyOpenAi = trimmedModel.toLowerCase().startsWith("openai:");
  const explicitlyOpenRouter =
    trimmedModel.toLowerCase().startsWith("openrouter:") || trimmedModel.includes("/");

  if (explicitlyVenice) {
    if (!veniceKey) {
      throw new EmbeddingProviderError({
        message: "The configured Venice embedding model requires a Venice credential.",
        code: "missing_credentials",
        provider: "venice",
      });
    }
    return {
      provider: "venice",
      apiKey: veniceKey,
      endpoint: VENICE_EMBEDDINGS_URL,
      model: trimmedModel.slice("venice:".length),
      transport: "direct",
    };
  }

  if (explicitlyOpenAi) {
    if (!openAiKey) {
      throw new EmbeddingProviderError({
        message: "The configured OpenAI embedding model requires an OpenAI credential.",
        code: "missing_credentials",
        provider: "openai",
      });
    }
    return {
      provider: "openai",
      apiKey: openAiKey,
      endpoint: OPENAI_EMBEDDINGS_URL,
      model: trimmedModel.slice("openai:".length),
      transport: "direct",
    };
  }

  if (explicitlyOpenRouter) {
    const openRouterTransport = resolveOpenRouterTransport();
    if (!openRouterTransport) {
      throw new EmbeddingProviderError({
        message:
          "The configured OpenRouter embedding model requires an OpenRouter credential.",
        code: "missing_credentials",
        provider: "openrouter",
      });
    }
    return {
      provider: "openrouter",
      apiKey: openRouterTransport.apiKey,
      endpoint: `${openRouterTransport.baseUrl}/embeddings`,
      model: openRouterModelId(trimmedModel),
      transport: "direct",
    };
  }

  // Preserve the established automatic embedding identity when a direct
  // provider is already configured.
  if (veniceKey) {
    return {
      provider: "venice",
      apiKey: veniceKey,
      endpoint: VENICE_EMBEDDINGS_URL,
      model: trimmedModel || DEFAULT_VENICE_EMBEDDING_MODEL,
      transport: "direct",
    };
  }

  if (!directOpenRouterKey && openAiKey) {
    return {
      provider: "openai",
      apiKey: openAiKey,
      endpoint: OPENAI_EMBEDDINGS_URL,
      model: trimmedModel || DEFAULT_OPENAI_EMBEDDING_MODEL,
      transport: "direct",
    };
  }

  const openRouterTransport = resolveOpenRouterTransport();

  if (directOpenRouterKey && openRouterTransport) {
    return {
      provider: "openrouter",
      apiKey: openRouterTransport.apiKey,
      endpoint: `${openRouterTransport.baseUrl}/embeddings`,
      // Preserve the selected model while spelling bare OpenAI model ids in
      // OpenRouter's canonical provider/model form.
      model: trimmedModel
        ? openRouterModelId(trimmedModel)
        : DEFAULT_OPENROUTER_EMBEDDING_MODEL,
      transport: "direct",
    };
  }

  if (openAiKey) {
    return {
      provider: "openai",
      apiKey: openAiKey,
      endpoint: OPENAI_EMBEDDINGS_URL,
      model: trimmedModel || DEFAULT_OPENAI_EMBEDDING_MODEL,
      transport: "direct",
    };
  }

  throw new EmbeddingProviderError({
    message:
      "Memory embeddings require a configured Venice, OpenRouter, or OpenAI credential.",
    code: "missing_credentials",
    provider: null,
  });
}

function resolveEmbeddingExecution(model: string, dimensions: number): ResolvedEmbeddingProvider {
  const trimmedModel = model.trim();
  const route = getQualifiedSurplusEmbeddingRoute(trimmedModel, dimensions);
  const surplusKey = resolveProviderKey("surplus", {});
  const preferSurplus = getCachedServerModelConfigRow()?.preferSurplus === true;
  const surplusExecution = (qualified: QualifiedSurplusEmbeddingRoute, apiKey: string) => ({
    provider: qualified.provider,
    model: qualified.model,
    endpoint: "https://api.surplusintelligence.ai/v1/embeddings",
    apiKey,
    transport: "surplus_marketplace" as const,
    surplusRoute: qualified,
  });
  if (route && preferSurplus && surplusKey) {
    return surplusExecution(route, surplusKey);
  }
  if (trimmedModel) return resolveEmbeddingProvider(model);
  try {
    // Keep Automatic's established direct vector identity whenever any direct
    // embedding credential is runnable, even when Surplus is preferred.
    return resolveEmbeddingProvider(model);
  } catch (error) {
    if (!(error instanceof EmbeddingProviderError)
      || error.code !== "missing_credentials") throw error;
    const fallbackRoute = getQualifiedSurplusEmbeddingRoute(
      QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID,
      dimensions,
    );
    if (fallbackRoute && preferSurplus && surplusKey) {
      return surplusExecution(fallbackRoute, surplusKey);
    }
    throw error;
  }
}

function disclosuresEqual(
  left: Readonly<MemoryEmbeddingDisclosureV2>,
  right: Readonly<MemoryEmbeddingDisclosureV2>,
): boolean {
  try {
    return sameMemoryEmbeddingDisclosureV2(left, right);
  } catch {
    return false;
  }
}

function providerFailureMessage(provider: EmbeddingProvider, status: number): string {
  const label = embeddingProviderLabel(provider);
  const credentialLabel = `${label} credential`;

  switch (status) {
    case 401:
      return `${label} rejected the embedding credential. Verify the ${credentialLabel} and retry.`;
    case 402:
      return `${label} has insufficient credits for embeddings. Add credits and retry.`;
    case 404:
      return `${label} could not find the configured embedding model. Check the embedding model in Server → Models and operator embedding configuration, then retry.`;
    case 429:
      return `${label} rate-limited the embedding request. Wait and retry.`;
    default:
      return status >= 500
        ? `${label} is temporarily unavailable for embeddings. Retry shortly.`
        : `${label} rejected the embedding request. Verify the embedding model and input configuration.`;
  }
}

function parseEmbeddingResponse(
  value: unknown,
  expectedCount: number,
  expectedDims: number,
  provider: EmbeddingProvider,
): number[][] {
  const data =
    typeof value === "object" && value !== null && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : null;

  if (!data || data.length !== expectedCount) {
    throw new EmbeddingProviderError({
      message: `${embeddingProviderLabel(provider)} returned an invalid embedding response. Retry; if it persists, check the embedding model in Server → Models and operator embedding configuration, including NAUTILO_EMBEDDING_DIMS.`,
      code: "invalid_response",
      provider,
      retryable: true,
    });
  }

  const ordered: Array<number[] | undefined> = Array.from(
    { length: expectedCount },
    () => undefined,
  );
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      throwInvalidEmbeddingResponse(provider);
    }
    const { index, embedding } = item as { index?: unknown; embedding?: unknown };
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= expectedCount ||
      ordered[index as number] !== undefined ||
      !Array.isArray(embedding) ||
      embedding.length !== expectedDims ||
      !embedding.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
      throwInvalidEmbeddingResponse(provider);
    }
    ordered[index as number] = embedding as number[];
  }

  if (ordered.some((embedding) => embedding === undefined)) {
    throwInvalidEmbeddingResponse(provider);
  }
  return ordered as number[][];
}

function throwInvalidEmbeddingResponse(provider: EmbeddingProvider): never {
  throw new EmbeddingProviderError({
    message: `${embeddingProviderLabel(provider)} returned an invalid embedding response. Retry; if it persists, check the embedding model in Server → Models and operator embedding configuration, including NAUTILO_EMBEDDING_DIMS.`,
    code: "invalid_response",
    provider,
    retryable: true,
  });
}

async function embedTextsWithResolvedProvider(
  texts: string[],
  signal?: AbortSignal,
  fixed?: Readonly<{
    resolved: ResolvedEmbeddingProvider;
    dimensions: number;
  }>,
): Promise<Readonly<{
  embeddings: number[][];
  resolved: ResolvedEmbeddingProvider;
  dimensions: number;
}>> {
  const config = getEmbeddingConfig();
  const dims = fixed?.dimensions ?? config.dims;
  const resolved = fixed?.resolved ?? resolveEmbeddingExecution(config.model, dims);

  if (resolved.transport === "surplus_marketplace") {
    const route = resolved.surplusRoute;
    if (!route) throw new Error("Qualified Surplus embedding route is missing.");
    const authorizedDisclosure = disclosureFor(resolved, dims);
    try {
      const embeddings = await invokeSurplusEmbeddingAttempt({
        route,
        apiKey: resolved.apiKey,
        texts,
        ...(signal === undefined ? {} : { signal }),
        assertStillAuthorized: () => {
          try {
            const latest = getEmbeddingConfig();
            const current = resolveEmbeddingExecution(latest.model, latest.dims);
            if (current.transport === "surplus_marketplace"
              && current.apiKey === resolved.apiKey
              && current.surplusRoute === route
              && disclosuresEqual(disclosureFor(current, latest.dims), authorizedDisclosure)) {
              return;
            }
          } catch {
            // Project every selection, policy, or credential drift through the
            // same stale-approval result without disclosing credential state.
          }
          throw new EmbeddingProviderError({
            message: "The approved embedding configuration changed. Prepare the Memory request again.",
            code: "unsupported_provider",
            provider: resolved.provider,
          });
        },
        parseResponse: (value) => {
          assertQualifiedSurplusEmbeddingResponseModel(route, value);
          const embeddings = parseEmbeddingResponse(value, texts.length, dims, resolved.provider);
          return embeddings;
        },
      });
      return { embeddings, resolved, dimensions: dims };
    } catch (error) {
      if (error instanceof EmbeddingProviderError) throw error;
      if (error instanceof SurplusEmbeddingAttemptError) {
        throw new EmbeddingProviderError({
          message: error.message,
          code: error.failureCode === "invalid_response" ? "invalid_response" : "request_failed",
          provider: resolved.provider,
          ...(error.status === undefined ? {} : { status: error.status }),
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }

  return runServiceEmbeddingAttempt({
    provider: resolved.provider,
    model: resolved.model,
    endpoint: resolved.endpoint,
    dimensions: dims,
    ...(signal === undefined ? {} : { signal }),
    assertStillAuthorized: () => {
      try {
        const latest = getEmbeddingConfig();
        const current = resolveEmbeddingExecution(latest.model, latest.dims);
        const disclosureStillMatches = dims !== 1_536
          || disclosuresEqual(disclosureFor(current, latest.dims), disclosureFor(resolved, dims));
        if (current.transport === "direct"
          && latest.dims === dims
          && current.provider === resolved.provider
          && current.model === resolved.model
          && current.endpoint === resolved.endpoint
          && current.apiKey === resolved.apiKey
          && disclosureStillMatches) {
          return;
        }
      } catch {
        // Project every selection, policy, credential, or disclosure drift
        // through the same stale-approval result without exposing key state.
      }
      throw new EmbeddingProviderError({
        message: "The approved embedding configuration changed. Prepare the Memory request again.",
        code: "unsupported_provider",
        provider: resolved.provider,
      });
    },
    invoke: async (observeEvidence) => {
      let response: Response;
      try {
        response = await fetch(resolved.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resolved.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: resolved.model,
            input: texts,
            // OpenRouter documents output dimensions on its embedding request.
            // Pinning them keeps the provider response aligned with pgvector.
            ...(resolved.provider === "openrouter" || resolved.provider === "venice"
              ? { dimensions: dims }
              : {}),
          }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new EmbeddingProviderError({
          message: `${embeddingProviderLabel(resolved.provider)} could not be reached for embeddings. Check network access and retry.`,
          code: "request_failed",
          provider: resolved.provider,
          retryable: true,
        });
      }

      if (!response.ok) {
        const providerRequestId = response.headers.get("x-request-id")?.trim();
        if (providerRequestId) observeEvidence({ providerRequestId });
        throw new EmbeddingProviderError({
          message: providerFailureMessage(resolved.provider, response.status),
          code: "request_failed",
          provider: resolved.provider,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      let data: {
        data: Array<{ embedding: number[]; index: number }>;
        usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
      };
      try {
        data = (await response.json()) as typeof data;
      } catch {
        throwInvalidEmbeddingResponse(resolved.provider);
      }

      const evidence: ServiceEmbeddingAttemptEvidence = {};
      const promptTokens = data.usage?.prompt_tokens;
      if (typeof promptTokens === "number" && Number.isSafeInteger(promptTokens)
        && promptTokens >= 0) {
        evidence.inputTokens = promptTokens;
      }
      const totalTokens = data.usage?.total_tokens;
      if (typeof totalTokens === "number" && Number.isSafeInteger(totalTokens)
        && totalTokens >= 0) {
        evidence.totalTokens = totalTokens;
      }
      const reportedCost = data.usage?.cost;
      if (resolved.provider === "openrouter" && typeof reportedCost === "number"
        && Number.isFinite(reportedCost) && reportedCost >= 0) {
        evidence.actualCostUsd = reportedCost;
      }
      const providerRequestId = response.headers.get("x-request-id")?.trim();
      if (providerRequestId) evidence.providerRequestId = providerRequestId;
      if (Object.keys(evidence).length > 0) observeEvidence(evidence);

      const embeddings = parseEmbeddingResponse(data, texts.length, dims, resolved.provider);
      return { embeddings, resolved, dimensions: dims };
    },
  });
}

export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  return (await embedTextsWithResolvedProvider(texts, signal)).embeddings;
}

export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const [embedding] = await embedTexts([text], signal);
  if (!embedding) throw new Error("No embedding returned");
  return embedding;
}

/**
 * M271 production Reflection seam. Unlike the legacy vector-only helpers,
 * this returns the exact resolved provider/model provenance required by the
 * Record projection contract.
 */
export async function embedTextWithProvenance(
  text: string,
  signal?: AbortSignal,
  expected?: Readonly<{
    provider: EmbeddingProvider;
    model: string;
    dimensions: number;
    disclosure?: Readonly<MemoryEmbeddingDisclosureV2>;
  }>,
): Promise<EmbeddingWithProvenanceV1> {
  const configured = getEmbeddingConfig();
  const resolved = resolveEmbeddingExecution(configured.model, configured.dims);
  if (expected !== undefined && (resolved.provider !== expected.provider
    || resolved.model !== expected.model || configured.dims !== expected.dimensions)) {
    throw new EmbeddingProviderError({
      message: "The approved embedding configuration changed. Prepare the Memory request again.",
      code: "unsupported_provider", provider: resolved.provider,
    });
  }
  if (expected !== undefined && resolved.transport === "surplus_marketplace"
    && (expected.disclosure === undefined
      || !disclosuresEqual(disclosureFor(resolved, configured.dims), expected.disclosure))) {
    throw new EmbeddingProviderError({
      message: "The approved embedding processing route changed. Prepare the Memory request again.",
      code: "unsupported_provider", provider: resolved.provider,
    });
  }
  if (expected?.disclosure !== undefined
    && !disclosuresEqual(disclosureFor(resolved, configured.dims), expected.disclosure)) {
    throw new EmbeddingProviderError({
      message: "The approved embedding processing route changed. Prepare the Memory request again.",
      code: "unsupported_provider", provider: resolved.provider,
    });
  }
  const result = await embedTextsWithResolvedProvider(
    [text],
    signal,
    { resolved, dimensions: configured.dims },
  );
  const vector = result.embeddings[0];
  if (!vector) {
    throw new EmbeddingProviderError({
      message: `${embeddingProviderLabel(result.resolved.provider)} returned an invalid embedding response. Retry; if it persists, check the embedding model in Server → Models and operator embedding configuration, including NAUTILO_EMBEDDING_DIMS.`,
      code: "invalid_response",
      provider: result.resolved.provider,
      retryable: true,
    });
  }
  return Object.freeze({
    vector: Object.freeze([...vector]),
    provider: resolved.provider,
    canonicalModel: resolved.model,
    dimensions: result.dimensions,
    contractVersion: 1 as const,
  });
}
