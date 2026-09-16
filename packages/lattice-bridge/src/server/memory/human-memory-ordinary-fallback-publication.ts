import type {
  ProtectedMemoryOrdinaryFallbackCreateRequestV1,
  ProtectedMemoryOrdinaryFallbackUpdateRequestV1,
  ProtectedMemoryPreparedUpdateResponseV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  decodeHumanMemoryOrdinaryFallbackRequestV1,
  digestHumanMemoryOrdinaryFallbackRequestV1,
  verifyHumanMemoryOrdinaryFallbackRequestV1,
} from "../../memory/human-memory-ordinary-fallback-request.ts";
import {
  MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
  type MemoryForegroundEmbeddingProcessor,
} from "../../memory/foreground-embedding-processor.ts";
import type {
  HumanMemoryProductAuthority,
  HumanMemoryOrdinaryFallbackAdmission,
  HumanMemoryOrdinaryFallbackReplay,
  HumanMemoryActualEmbedding,
  HumanMemoryProductProjection,
  HumanMemoryProductUpdatePort,
} from "./postgres-human-memory-product-update.ts";
import { humanMemoryPreparedAuthorizationError,
  humanMemoryPreparedIntegrityError } from "./human-memory-prepared-route-error.ts";

type SubmittedOrdinaryFallback =
  | ProtectedMemoryOrdinaryFallbackCreateRequestV1
  | ProtectedMemoryOrdinaryFallbackUpdateRequestV1;

export type ResolveHistoricalHumanMemoryOrdinaryDeviceAuthority = (
  context: Readonly<{
    subjectHumanId: string;
    committerDeviceId: string;
    committerDeviceSigningKeyGeneration: number;
    hostAuthorizationRevision: number;
    issuedAt: number;
  }>,
) => Promise<Readonly<{ committerSigningPublicKey: Uint8Array }> | null>;

type OrdinaryFallbackProduct<Authority extends HumanMemoryProductAuthority> =
  Readonly<{
    lookupOrdinaryFallback(input: Readonly<{ authority: Authority;
      operationId: string; memoryId: string; requestDigest: Uint8Array }> ):
      Promise<HumanMemoryOrdinaryFallbackReplay | null>;
    admitOrdinaryFallback(input: Readonly<{ authority: Authority;
      authenticated: Parameters<HumanMemoryProductUpdatePort["admitOrdinaryFallback"]>[0]["authenticated"] }> ):
      Promise<HumanMemoryOrdinaryFallbackAdmission>;
    publishOrdinaryFallbackIntent(input: Readonly<{ authority: Authority;
      admission: HumanMemoryOrdinaryFallbackAdmission;
      embedding: HumanMemoryActualEmbedding }> ):
      Promise<HumanMemoryProductProjection>;
  }>;

function unavailable(): ProtectedMemoryUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable",
    reason: "embedding_unavailable" });
}

function exactOuterRequest(
  submitted: SubmittedOrdinaryFallback,
  request: ReturnType<typeof verifyHumanMemoryOrdinaryFallbackRequestV1>["request"],
  expectedPurpose: HumanMemoryOrdinaryFallbackPurpose,
): boolean {
  return request.purpose === expectedPurpose
    && submitted.reason === request.reason
    && submitted.operationId === request.operationId
    && submitted.memoryId === request.memoryId
    && submitted.expectedContentRevision === request.expectedContentRevision
    && submitted.nextContentRevision === request.nextContentRevision
    && submitted.expectedCryptoAccessRevision === request.expectedCryptoAccessRevision
    && submitted.requiredNamespaceIds.length === request.requiredNamespaceIds.length
    && submitted.requiredNamespaceIds.every((id, index) =>
      id === request.requiredNamespaceIds[index]);
}

type HumanMemoryOrdinaryFallbackPurpose =
  | "memory.ordinary_fallback.create"
  | "memory.ordinary_fallback.update";

/** Executes only an authenticated Fallback Shadow ordinary intent. */
export async function publishHumanMemoryOrdinaryFallbackIntent<
  Authority extends HumanMemoryProductAuthority,
>(input: Readonly<{
  crypto: LatticeCrypto;
  now: () => number;
  expectedHumanId: string;
  expectedPurpose: HumanMemoryOrdinaryFallbackPurpose;
  authority: Authority;
  submitted: SubmittedOrdinaryFallback;
  product: OrdinaryFallbackProduct<Authority>;
  resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryOrdinaryDeviceAuthority;
  foregroundEmbeddingProcessor: MemoryForegroundEmbeddingProcessor;
}>): Promise<ProtectedMemoryPreparedUpdateResponseV1 | ProtectedMemoryUnavailableResponseV1> {
  const requestBytes = Uint8Array.from(Buffer.from(
    input.submitted.signedOrdinaryFallbackRequestBytesBase64url, "base64url",
  ));
  try {
  let digest: Uint8Array;
  let unsigned: ReturnType<typeof decodeHumanMemoryOrdinaryFallbackRequestV1>;
  try {
    unsigned = decodeHumanMemoryOrdinaryFallbackRequestV1(requestBytes);
    digest = digestHumanMemoryOrdinaryFallbackRequestV1(requestBytes);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    throw humanMemoryPreparedIntegrityError(
      "Human Memory ordinary fallback wire is invalid",
    );
  }
  const replay = await input.product.lookupOrdinaryFallback({
    authority: input.authority,
    operationId: input.submitted.operationId,
    memoryId: input.submitted.memoryId,
    requestDigest: digest,
  });
  if (unsigned.subjectHumanId !== input.expectedHumanId) {
    throw humanMemoryPreparedAuthorizationError(
      "Human Memory ordinary fallback subject disagrees",
    );
  }
  const historical = await input.resolveHistoricalDeviceAuthority({
    subjectHumanId: unsigned.subjectHumanId,
    committerDeviceId: unsigned.committerDeviceId,
    committerDeviceSigningKeyGeneration:
      unsigned.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: unsigned.hostAuthorizationRevision,
    issuedAt: unsigned.issuedAt,
  });
  if (historical === null) {
    throw humanMemoryPreparedAuthorizationError(
      "Human Memory ordinary fallback signer is unavailable",
    );
  }
  let authenticated: ReturnType<typeof verifyHumanMemoryOrdinaryFallbackRequestV1>;
  try {
    authenticated = verifyHumanMemoryOrdinaryFallbackRequestV1(input.crypto, {
      requestBytes,
      signingPublicKey: historical.committerSigningPublicKey,
      now: input.now(),
      ...(replay === null ? {} : { replayAdmission: replay.replayAdmission }),
    });
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    throw humanMemoryPreparedIntegrityError(
      "Human Memory ordinary fallback signature is invalid",
    );
  }
  if (!exactOuterRequest(input.submitted, authenticated.request,
    input.expectedPurpose)) {
    throw humanMemoryPreparedIntegrityError(
      "Human Memory ordinary fallback request disagrees",
    );
  }
  if (replay?.completed !== undefined) {
    return Object.freeze({ dtoVersion: 1, status: "ordinary_fallback",
      operationId: authenticated.request.operationId,
      memoryId: replay.completed.projection.memoryId,
      contentRevision: replay.completed.projection.contentRevision,
      cryptoAccessRevision: replay.completed.projection.cryptoAccessRevision,
      reason: replay.completed.reason });
  }
  const admission = await input.product.admitOrdinaryFallback({
    authority: input.authority, authenticated,
  });
  const processorIssuedAt = input.now();
  const embedded = await input.foregroundEmbeddingProcessor.embed({
    request: Object.freeze({ contractVersion: 1,
      purpose: "memory.content_embedding",
      subjectId: authenticated.request.subjectHumanId,
      requestId: authenticated.request.operationId,
      plaintext: authenticated.request.content,
      provider: authenticated.request.requestedProvider,
      model: authenticated.request.requestedModel,
      dimensions: authenticated.request.dimensions,
      issuedAt: processorIssuedAt,
      deadlineAt: processorIssuedAt + MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
      publication: Object.freeze({ objectId: authenticated.request.memoryId,
        expectedProductRevision: authenticated.request.expectedContentRevision,
        idempotencyId: authenticated.request.operationId }) }),
    authenticatedSubjectId: authenticated.request.subjectHumanId,
  });
  if (embedded.status === "unavailable") return unavailable();
  const projection = await input.product.publishOrdinaryFallbackIntent({
    authority: input.authority, admission, embedding: embedded.embedding,
  });
  return Object.freeze({ dtoVersion: 1, status: "ordinary_fallback",
    operationId: authenticated.request.operationId,
    memoryId: projection.memoryId,
    contentRevision: projection.contentRevision,
    cryptoAccessRevision: projection.cryptoAccessRevision,
    reason: authenticated.request.reason });
  } finally {
    requestBytes.fill(0);
  }
}
