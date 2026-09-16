import type {
  ProtectedMemoryDetailResponseV1,
  ProtectedMemoryPreparedUpdateResponseV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import type {
  AtomicMemoryCryptoCompletionPort,
} from "../../memory/memory-repository.ts";
import type {
  MemoryForegroundEmbeddingProcessor,
} from "../../memory/foreground-embedding-processor.ts";
import type {
  AuthenticatedHumanMemoryPreparedUpdate,
  HumanMemoryProductAllocationCertificate,
} from "./human-memory-prepared-update.ts";
import {
  bindPreparedHumanMemoryProductAllocation,
  readPreparedHumanMemoryUpdateSnapshot,
} from "./human-memory-prepared-update.ts";
import { isHumanMemoryCryptoServiceUnavailable } from
  "./human-memory-crypto-availability.ts";
import {
  humanMemoryPreparedIntegrityError,
} from
  "./human-memory-prepared-route-error.ts";
import {
  assertPreparedHumanMemoryCurrentWriteAuthority,
  type ResolveCurrentHumanMemoryWriteAuthorization,
} from "./postgres-human-memory-crypto-completion.ts";
import type {
  HumanMemoryActualEmbedding,
  HumanMemoryProductProjection,
  HumanMemoryOrdinaryFallbackReason,
} from "./postgres-human-memory-product-update.ts";

type CreateBoundHumanMemoryCryptoCompletion = (
  resolve: ResolveCurrentHumanMemoryWriteAuthorization,
) => AtomicMemoryCryptoCompletionPort;

type HumanMemoryNamespaceAuthorityV1 =
  ProtectedMemoryDetailResponseV1["memory"]["projection"]["readAuthorities"][number];

type PublicationInspection =
  | Readonly<{ kind: "new" }>
  | Readonly<{
      kind: "replay";
      certificate: HumanMemoryProductAllocationCertificate;
      alreadyPublished: boolean;
      projection?: HumanMemoryProductProjection;
      ordinaryFallbackReason?: HumanMemoryOrdinaryFallbackReason;
    }>;

type PreparedWirePublication = Readonly<{
  encryptedPayloadBytesBase64url: string;
  accessManifestBytesBase64url: string;
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string;
    envelopeBytesBase64url: string;
  }>[];
}>;

function unavailable(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): ProtectedMemoryUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

/** Shared post-authentication execution for prepared Human Memory publication. */
export async function publishPreparedHumanMemory(input: Readonly<{
  crypto: LatticeCrypto;
  humanId: string;
  authenticated: AuthenticatedHumanMemoryPreparedUpdate;
  inspection: PublicationInspection;
  preparedWire: PreparedWirePublication;
  publishedAuthorities: readonly HumanMemoryNamespaceAuthorityV1[];
  foregroundEmbeddingProcessor: MemoryForegroundEmbeddingProcessor;
  createCryptoCompletion: CreateBoundHumanMemoryCryptoCompletion;
  resolveCurrentWriteAuthorization: ResolveCurrentHumanMemoryWriteAuthorization;
  allocate(): Promise<HumanMemoryProductAllocationCertificate>;
  publish(args: Readonly<{
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    preparedAuthority: ReturnType<typeof readPreparedHumanMemoryUpdateSnapshot>["authority"];
  }>): Promise<HumanMemoryProductProjection>;
  publishOrdinaryFallback(args: Readonly<{
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    preparedAuthority: ReturnType<typeof readPreparedHumanMemoryUpdateSnapshot>["authority"];
    reason: "encryption_pending";
  }>): Promise<HumanMemoryProductProjection>;
}>): Promise<
  ProtectedMemoryPreparedUpdateResponseV1 | ProtectedMemoryUnavailableResponseV1
> {
  const allocation = input.inspection.kind === "replay"
    ? input.inspection.certificate
    : await input.allocate();
  let projection = input.inspection.kind === "replay"
    && input.inspection.alreadyPublished
    ? input.inspection.projection
    : undefined;
  if (input.inspection.kind === "replay"
    && input.inspection.alreadyPublished
    && input.inspection.ordinaryFallbackReason !== undefined) {
    if (projection === undefined) {
      throw humanMemoryPreparedIntegrityError(
        "Human Memory fallback replay is incomplete",
      );
    }
    return Object.freeze({
      dtoVersion: 1,
      status: "ordinary_fallback",
      operationId: allocation.operationId,
      memoryId: projection.memoryId,
      contentRevision: projection.contentRevision,
      cryptoAccessRevision: projection.cryptoAccessRevision,
      reason: input.inspection.ordinaryFallbackReason,
    });
  }
  if (projection === undefined) {
    const prepared = bindPreparedHumanMemoryProductAllocation(
      input.authenticated.prepared,
      allocation,
    );
    const completion = input.createCryptoCompletion(
      input.resolveCurrentWriteAuthorization,
    );
    try {
      await completion.complete(prepared);
    } catch (error) {
      if (!isHumanMemoryCryptoServiceUnavailable(error)) throw error;
      const embedded = await input.foregroundEmbeddingProcessor.embed({
        request: input.authenticated.embeddingRequest,
        authenticatedSubjectId: input.humanId,
      });
      if (embedded.status === "unavailable") {
        return unavailable("embedding_unavailable");
      }
      const fallback = await input.publishOrdinaryFallback({
        certificate: allocation,
        embedding: embedded.embedding,
        preparedAuthority: readPreparedHumanMemoryUpdateSnapshot(prepared).authority,
        reason: "encryption_pending",
      });
      return Object.freeze({
        dtoVersion: 1,
        status: "ordinary_fallback",
        operationId: allocation.operationId,
        memoryId: fallback.memoryId,
        contentRevision: fallback.contentRevision,
        cryptoAccessRevision: fallback.cryptoAccessRevision,
        reason: "encryption_pending",
      });
    }
    await assertPreparedHumanMemoryCurrentWriteAuthority({
      crypto: input.crypto,
      prepared,
      resolve: input.resolveCurrentWriteAuthorization,
    });
    const embedded = await input.foregroundEmbeddingProcessor.embed({
      request: input.authenticated.embeddingRequest,
      authenticatedSubjectId: input.humanId,
    });
    if (embedded.status === "unavailable") {
      return unavailable("embedding_unavailable");
    }
    projection = await input.publish({
      certificate: allocation,
      embedding: embedded.embedding,
      preparedAuthority: readPreparedHumanMemoryUpdateSnapshot(prepared).authority,
    });
  }
  const preparedAuthority = readPreparedHumanMemoryUpdateSnapshot(
    input.authenticated.prepared,
  ).authority;
  return Object.freeze({
    dtoVersion: 1,
    status: input.inspection.kind === "replay" ? "replayed" : "published",
    memory: Object.freeze({
      dtoVersion: 1,
      projection: Object.freeze({
        memoryId: projection.memoryId,
        contentRevision: projection.contentRevision,
        cryptoAccessRevision: projection.cryptoAccessRevision,
        importance: projection.importance,
        tier: projection.tier,
        createdAt: projection.createdAt.toISOString(),
        updatedAt: projection.updatedAt.toISOString(),
        namespaceIds: [...projection.namespaceIds],
        requiredNamespaceIds: [...projection.requiredNamespaceIds],
        readAuthorities: [...input.publishedAuthorities],
        mutationAuthorities: [...input.publishedAuthorities],
        ...(projection.scopeOrigin === undefined
          ? {} : { scopeOrigin: projection.scopeOrigin }),
      }),
      protectedPayload: Object.freeze({
        status: "encrypted",
        cryptoObjectId: allocation.objectId,
        payloadVersion: 1,
        encryptedPayloadBytesBase64url:
          input.preparedWire.encryptedPayloadBytesBase64url,
        accessManifestBytesBase64url:
          input.preparedWire.accessManifestBytesBase64url,
        accessSignerEvidence: [Object.freeze({
          kind: "human_device" as const,
          subjectHumanId: input.humanId,
          committerDeviceId: preparedAuthority.committerDeviceId,
          hostAuthorizationRevision:
            preparedAuthority.hostAuthorizationRevision,
          signingPublicKeyBase64url: Buffer.from(
            input.authenticated.committerSigningPublicKey,
          ).toString("base64url"),
        })],
        namespaceEnvelopes: input.preparedWire.namespaceEnvelopes.map(
          (entry) => ({ ...entry }),
        ),
      }),
    }),
  });
}
