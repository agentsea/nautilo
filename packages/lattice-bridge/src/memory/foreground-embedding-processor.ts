export const MEMORY_EMBEDDING_DIMENSIONS = 1536 as const;
export const MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION = 1 as const;
export const MEMORY_CONTENT_EMBEDDING_MAX_BYTES = 64 * 1024;
export const MEMORY_QUERY_EMBEDDING_MAX_BYTES = 4 * 1024;
export const MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS = 30_000;

export type MemoryEmbeddingPurpose =
  | "memory.content_embedding"
  | "memory.query_embedding";

export type MemoryForegroundEmbeddingRequest = Readonly<{
  readonly contractVersion:
    typeof MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION;
  readonly purpose: MemoryEmbeddingPurpose;
  readonly subjectId: string;
  readonly requestId: string;
  readonly plaintext: string;
  readonly provider: "openai" | "openrouter" | "venice";
  readonly model: string;
  readonly dimensions: typeof MEMORY_EMBEDDING_DIMENSIONS;
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly publication: Readonly<{
    readonly objectId: string;
    readonly expectedProductRevision: number;
    readonly idempotencyId: string;
  }> | null;
}>;

export class MemoryForegroundProcessorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryForegroundProcessorValidationError";
  }
}

export type MemoryForegroundEmbeddingUnavailableReason =
  | "invalid_request"
  | "subject_mismatch"
  | "rate_limited"
  | "provider_unavailable"
  | "incompatible_embedding";

export type MemoryForegroundEmbeddingResult =
  | Readonly<{
      readonly status: "embedded";
      readonly embedding: Readonly<{
        readonly provider: "openai" | "openrouter" | "venice";
        readonly canonicalModel: string;
        readonly dimensions: typeof MEMORY_EMBEDDING_DIMENSIONS;
        readonly vector: readonly number[];
        readonly processorContractVersion:
          typeof MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION;
      }>;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: MemoryForegroundEmbeddingUnavailableReason;
    }>;

export interface MemoryEmbeddingProviderPort {
  embed(input: Readonly<{
    readonly purpose: MemoryEmbeddingPurpose;
    readonly plaintext: string;
    readonly requestedProvider: "openai" | "openrouter" | "venice";
    readonly requestedModel: string;
    readonly dimensions: typeof MEMORY_EMBEDDING_DIMENSIONS;
    readonly signal?: AbortSignal;
  }>): Promise<Readonly<{
    readonly provider: "openai" | "openrouter" | "venice";
    readonly canonicalModel: string;
    readonly dimensions: number;
    readonly vector: readonly number[];
  }>>;
}

export interface MemoryForegroundProcessorRateLimitPort {
  admit(input: Readonly<{
    readonly subjectId: string;
    readonly requestId: string;
    readonly purpose: MemoryEmbeddingPurpose;
  }>): boolean | PromiseLike<boolean>;
}

export interface MemoryForegroundEmbeddingProcessor {
  embed(input: Readonly<{
    readonly request: MemoryForegroundEmbeddingRequest;
    readonly authenticatedSubjectId: string;
    readonly signal?: AbortSignal;
  }>): Promise<MemoryForegroundEmbeddingResult>;
}

const encoder = new TextEncoder();
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function invalid(message: string): never {
  throw new MemoryForegroundProcessorValidationError(message);
}

function assertPortableId(label: string, value: string): void {
  if (
    typeof value !== "string"
    || !PORTABLE_ID.test(value)
    || encoder.encode(value).length > 128
  ) invalid(`${label} must be a bounded portable identifier`);
}

export function validateMemoryForegroundEmbeddingRequest(
  request: MemoryForegroundEmbeddingRequest,
  now: number,
): MemoryForegroundEmbeddingRequest {
  if (
    request.contractVersion !== MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION
  ) invalid("Memory foreground processor contract version is unsupported");
  if (
    request.purpose !== "memory.content_embedding"
    && request.purpose !== "memory.query_embedding"
  ) invalid("Memory foreground processor purpose is unsupported");
  assertPortableId("Memory processor subject", request.subjectId);
  assertPortableId("Memory processor request", request.requestId);
  if (request.provider !== "openai" && request.provider !== "openrouter" && request.provider !== "venice") {
    invalid("Memory embedding provider is unsupported");
  }
  assertPortableId("Memory embedding model", request.model);
  if (request.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
    invalid("Memory embedding dimensions are incompatible");
  }
  if (
    !Number.isSafeInteger(now)
    || !Number.isSafeInteger(request.issuedAt)
    || !Number.isSafeInteger(request.deadlineAt)
    || request.issuedAt > now
    || request.deadlineAt < now
    || request.deadlineAt <= request.issuedAt
    || request.deadlineAt - request.issuedAt
      > MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS
  ) invalid("Memory embedding request deadline is invalid");

  const plaintextBytes = encoder.encode(request.plaintext).length;
  const maxBytes = request.purpose === "memory.content_embedding"
    ? MEMORY_CONTENT_EMBEDDING_MAX_BYTES
    : MEMORY_QUERY_EMBEDDING_MAX_BYTES;
  if (plaintextBytes < 1 || plaintextBytes > maxBytes) {
    invalid("Memory embedding plaintext is outside its purpose bound");
  }

  if (request.purpose === "memory.query_embedding") {
    if (request.publication !== null) {
      invalid("Memory query embedding must not carry publication state");
    }
  } else {
    if (request.publication === null) {
      invalid("Memory content embedding requires publication binding");
    }
    assertPortableId(
      "Memory publication object",
      request.publication.objectId,
    );
    assertPortableId(
      "Memory publication idempotency identity",
      request.publication.idempotencyId,
    );
    if (
      !Number.isSafeInteger(request.publication.expectedProductRevision)
      || request.publication.expectedProductRevision < 0
      || request.publication.expectedProductRevision > 2_147_483_647
    ) invalid("Memory publication revision is invalid");
  }

  return request;
}

function unavailable(
  reason: MemoryForegroundEmbeddingUnavailableReason,
): MemoryForegroundEmbeddingResult {
  return Object.freeze({ status: "unavailable", reason });
}

function validVector(value: readonly number[], dimensions: number): boolean {
  return Array.isArray(value)
    && value.length === dimensions
    && value.every((entry) => Number.isFinite(entry));
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Execute one synchronous, purpose-bound disclosure to the configured
 * embedding provider. The processor has deliberately no persistence, retry,
 * logging, or plaintext callback surface; callers must immediately consume
 * the detached vector in the authorized query/publication transaction.
 */
export function createMemoryForegroundEmbeddingProcessor(input: Readonly<{
  readonly provider: MemoryEmbeddingProviderPort;
  /** Optional deployment admission policy. No arbitrary per-Memory quota is
   * introduced where the ordinary authenticated embedding path has none. */
  readonly rateLimit?: MemoryForegroundProcessorRateLimitPort;
  readonly now: () => number;
}>): MemoryForegroundEmbeddingProcessor {
  return Object.freeze({
    async embed(
      operation: Readonly<{
        readonly request: MemoryForegroundEmbeddingRequest;
        readonly authenticatedSubjectId: string;
        readonly signal?: AbortSignal;
      }>,
    ): Promise<MemoryForegroundEmbeddingResult> {
      const now = input.now();
      let request: MemoryForegroundEmbeddingRequest;
      try {
        request = validateMemoryForegroundEmbeddingRequest(
          operation.request,
          now,
        );
      } catch {
        return unavailable("invalid_request");
      }
      if (request.subjectId !== operation.authenticatedSubjectId) {
        return unavailable("subject_mismatch");
      }
      if (signalIsAborted(operation.signal)) {
        return unavailable("provider_unavailable");
      }
      if (input.rateLimit !== undefined) {
        let admitted: boolean;
        try {
          admitted = await input.rateLimit.admit({
          subjectId: request.subjectId,
          requestId: request.requestId,
          purpose: request.purpose,
          });
        } catch {
          return unavailable("rate_limited");
        }
        if (!admitted) return unavailable("rate_limited");
      }

      let embedded: Awaited<ReturnType<MemoryEmbeddingProviderPort["embed"]>>;
      try {
        embedded = await input.provider.embed({
          purpose: request.purpose,
          plaintext: request.plaintext,
          requestedProvider: request.provider,
          requestedModel: request.model,
          dimensions: request.dimensions,
          ...(operation.signal === undefined
            ? {}
            : { signal: operation.signal }),
        });
      } catch {
        return unavailable("provider_unavailable");
      }
      const completedAt = input.now();
      if (
        signalIsAborted(operation.signal)
        || completedAt > request.deadlineAt
      ) return unavailable("provider_unavailable");
      try {
        assertPortableId(
          "Memory embedding canonical model",
          embedded.canonicalModel,
        );
      } catch {
        return unavailable("incompatible_embedding");
      }
      if (
        embedded.provider !== request.provider
        || embedded.dimensions !== MEMORY_EMBEDDING_DIMENSIONS
        || !validVector(embedded.vector, MEMORY_EMBEDDING_DIMENSIONS)
      ) return unavailable("incompatible_embedding");

      return Object.freeze({
        status: "embedded" as const,
        embedding: Object.freeze({
          provider: embedded.provider,
          canonicalModel: embedded.canonicalModel,
          dimensions: MEMORY_EMBEDDING_DIMENSIONS,
          vector: Object.freeze([...embedded.vector]),
          processorContractVersion:
            MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
        }),
      });
    },
  });
}
