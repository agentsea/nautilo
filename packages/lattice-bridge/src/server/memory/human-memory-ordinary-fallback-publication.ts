import type {
  ProtectedMemoryOrdinaryFallbackCreateRequestV1,
  ProtectedMemoryOrdinaryFallbackUpdateRequestV1,
  ProtectedMemoryPreparedUpdateResponseV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  decodeHumanMemoryOrdinaryFallbackRequestV1,
  decodeHumanMemoryOrdinaryFallbackRequestV2,
  digestHumanMemoryOrdinaryFallbackRequestV1,
  digestHumanMemoryOrdinaryFallbackRequestV2,
  verifyHumanMemoryOrdinaryFallbackRequestV1,
  verifyHumanMemoryOrdinaryFallbackRequestV2,
  type HumanMemoryOrdinaryFallbackRequestV1,
  type HumanMemoryOrdinaryFallbackRequestV2,
  type AuthenticatedHumanMemoryOrdinaryFallbackRequestV1,
  type AuthenticatedHumanMemoryOrdinaryFallbackRequestV2,
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

type FallbackRequest = HumanMemoryOrdinaryFallbackRequestV1 | HumanMemoryOrdinaryFallbackRequestV2;
type AuthenticatedFallback = AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 | AuthenticatedHumanMemoryOrdinaryFallbackRequestV2;
function decodeFallback(bytes: Uint8Array): FallbackRequest {
  try { return decodeHumanMemoryOrdinaryFallbackRequestV2(bytes); }
  catch { return decodeHumanMemoryOrdinaryFallbackRequestV1(bytes); }
}
function requestedSpace(request: FallbackRequest) {
  return request.formatVersion === 2 ? request.requestedEmbedding.canonicalSpace
    : { provider: request.requestedProvider, model: request.requestedModel,
      dimensions: request.dimensions };
}

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
  request: FallbackRequest,
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
  let unsigned: FallbackRequest;
  try {
    unsigned = decodeFallback(requestBytes);
    digest = unsigned.formatVersion === 2
      ? digestHumanMemoryOrdinaryFallbackRequestV2(requestBytes)
      : digestHumanMemoryOrdinaryFallbackRequestV1(requestBytes);
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
  let authenticated: AuthenticatedFallback;
  try {
    const verify = unsigned.formatVersion === 2
      ? verifyHumanMemoryOrdinaryFallbackRequestV2 : verifyHumanMemoryOrdinaryFallbackRequestV1;
    authenticated = verify(input.crypto, {
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
    request: Object.freeze({ contractVersion: authenticated.request.processorContractVersion,
      purpose: "memory.content_embedding",
      subjectId: authenticated.request.subjectHumanId,
      requestId: authenticated.request.operationId,
      plaintext: authenticated.request.content,
      ...requestedSpace(authenticated.request),
      ...(authenticated.request.formatVersion === 2
        ? { embeddingDisclosure: authenticated.request.requestedEmbedding } : {}),
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
