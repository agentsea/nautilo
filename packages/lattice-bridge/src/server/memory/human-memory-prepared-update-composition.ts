import type {
  ProtectedMemorySubmittedUpdateRequestV1,
  ProtectedMemoryPreparedUpdateResponseV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";

import type {
  AtomicMemoryCryptoCompletionPort,
} from "../../memory/memory-repository.ts";
import type {
  MemoryForegroundEmbeddingProcessor,
} from "../../memory/foreground-embedding-processor.ts";
import {
  authenticatePreparedHumanMemoryUpdate,
  digestPreparedHumanMemorySignedRequest,
  type ResolveHistoricalHumanMemoryDeviceAuthority,
} from "./human-memory-prepared-update.ts";
import {
  type ResolveCurrentHumanMemoryWriteAuthorization,
} from "./postgres-human-memory-crypto-completion.ts";
import type {
  HumanMemoryProductAuthority,
  HumanMemoryProductUpdatePort,
} from "./postgres-human-memory-product-update.ts";
import { publishPreparedHumanMemory } from
  "./human-memory-prepared-publication.ts";
import { publishHumanMemoryOrdinaryFallbackIntent,
  type ResolveHistoricalHumanMemoryOrdinaryDeviceAuthority } from
  "./human-memory-ordinary-fallback-publication.ts";
import type { ResolveHumanMemoryNamespaceAuthority } from
  "./human-memory-protected-route-ports.ts";
import { HumanMemoryPreparedRouteError, humanMemoryPreparedIntegrityError } from
  "./human-memory-prepared-route-error.ts";

export type HumanMemoryPreparedUpdateRouteAuthority =
  HumanMemoryProductAuthority & Readonly<{
    actorId: string | null;
    agentId: string | null;
    sourceRoomId: string | null;
    memoryMode: "namespace" | "scope";
  }>;

export interface HumanMemoryPreparedUpdateRoutePort {
  updatePrepared(input: Readonly<{
    authority: HumanMemoryPreparedUpdateRouteAuthority;
    memoryId: string;
    prepared: ProtectedMemorySubmittedUpdateRequestV1;
  }>): Promise<
    ProtectedMemoryPreparedUpdateResponseV1
    | ProtectedMemoryUnavailableResponseV1
  >;
}

export type ResolveHumanMemoryRouteHumanId = (
  userId: string,
) => Promise<string | null>;

export type CreateBoundHumanMemoryCryptoCompletion = (
  resolveCurrentWriteAuthorization: ResolveCurrentHumanMemoryWriteAuthorization,
) => AtomicMemoryCryptoCompletionPort;

function unavailable(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): ProtectedMemoryUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function expectedFailure(error: unknown): ProtectedMemoryUnavailableResponseV1 | null {
  return error instanceof HumanMemoryPreparedRouteError
    ? unavailable(error.reason)
    : null;
}

/**
 * Authenticated Human prepared-update vertical. It binds the signed request to
 * its durable reservation and rechecks current publication authority before
 * committing either protected state or an explicitly permitted fallback.
 */
export function createHumanMemoryPreparedUpdateRoutePort(input: Readonly<{
  crypto: LatticeCrypto;
  now: () => number;
  resolveHumanId: ResolveHumanMemoryRouteHumanId;
  resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryDeviceAuthority;
  resolveCurrentWriteAuthorization:
    ResolveCurrentHumanMemoryWriteAuthorization;
  foregroundEmbeddingProcessor: MemoryForegroundEmbeddingProcessor;
  product: HumanMemoryProductUpdatePort;
  createCryptoCompletion: CreateBoundHumanMemoryCryptoCompletion;
  resolveNamespaceAuthority: ResolveHumanMemoryNamespaceAuthority;
  resolveHistoricalOrdinaryDeviceAuthority:
    ResolveHistoricalHumanMemoryOrdinaryDeviceAuthority;
  ordinaryFallbackAuthorization?: Readonly<{ policyRevision: number }>;
}>): HumanMemoryPreparedUpdateRoutePort {
  return Object.freeze({
    async updatePrepared(operation: Readonly<{
      authority: HumanMemoryPreparedUpdateRouteAuthority;
      memoryId: string;
      prepared: ProtectedMemorySubmittedUpdateRequestV1;
    }>): Promise<
      ProtectedMemoryPreparedUpdateResponseV1
      | ProtectedMemoryUnavailableResponseV1
    > {
      try {
        if (operation.authority.agentId !== null) {
          return unavailable("authorization_required");
        }
        const humanId = await input.resolveHumanId(operation.authority.userId);
        if (humanId === null) return unavailable("authorization_required");
        if ("publicationKind" in operation.prepared) {
          if (input.ordinaryFallbackAuthorization === undefined) {
            return unavailable("authorization_required");
          }
          if (operation.prepared.memoryId !== operation.memoryId) {
            throw humanMemoryPreparedIntegrityError(
              "Human Memory ordinary fallback path disagrees",
            );
          }
          return await publishHumanMemoryOrdinaryFallbackIntent({
            crypto: input.crypto, now: input.now, expectedHumanId: humanId,
            expectedPurpose: "memory.ordinary_fallback.update",
            authority: operation.authority, submitted: operation.prepared,
            product: input.product,
            resolveHistoricalDeviceAuthority:
              input.resolveHistoricalOrdinaryDeviceAuthority,
            foregroundEmbeddingProcessor: input.foregroundEmbeddingProcessor,
          });
        }
        if (operation.authority.memoryMode === "scope") {
          return unavailable("target_encryption_not_ready");
        }
        const requestDigest = digestPreparedHumanMemorySignedRequest(
          input.crypto, operation.prepared);
        const reservedReplay = await input.product.lookupReservation({
          authority: operation.authority,
          operationId: operation.prepared.operationId,
          memoryId: operation.memoryId,
          operationRequestDigest: requestDigest,
        });
        const authenticated = await authenticatePreparedHumanMemoryUpdate({
          crypto: input.crypto,
          expectedHumanId: humanId,
          memoryId: operation.memoryId,
          prepared: operation.prepared,
          now: input.now(),
          resolveHistoricalDeviceAuthority: input.resolveHistoricalDeviceAuthority,
          ...(reservedReplay === null ? {}
            : { reservedReplayAdmission: reservedReplay.admission }),
        });
        requestDigest.fill(0);
        const publishedAuthorities = [];
        for (const entry of operation.prepared.namespaceEnvelopes) {
          if (!operation.authority.mutableNamespaceIds.includes(entry.namespaceId)) {
            return unavailable("authorization_required");
          }
          const envelope = decodeNamespaceObjectEnvelopeV2(
            Uint8Array.from(Buffer.from(entry.envelopeBytesBase64url, "base64url")),
          );
          const resolved = await input.resolveNamespaceAuthority({
            subjectUserId: operation.authority.userId, subjectHumanId: humanId,
            preferredSourceRoomId: operation.authority.sourceRoomId,
            namespaceId: entry.namespaceId,
            requested: [{ generation: envelope.context.keyGeneration,
              accessRevision: envelope.context.bindingRevisionAtWrap }],
          });
          if (resolved === null) return unavailable("target_encryption_not_ready");
          publishedAuthorities.push(resolved);
        }
        const inspection = await input.product.inspect({
        authority: operation.authority,
        prepared: authenticated.prepared,
        operationRequestDigest: authenticated.operationRequestDigest,
      });
        return await publishPreparedHumanMemory({
          crypto: input.crypto,
          humanId,
          authenticated,
          inspection,
          preparedWire: operation.prepared,
          publishedAuthorities,
          foregroundEmbeddingProcessor: input.foregroundEmbeddingProcessor,
          createCryptoCompletion: input.createCryptoCompletion,
          resolveCurrentWriteAuthorization: input.resolveCurrentWriteAuthorization,
          allocate: () => input.product.allocate({
            authority: operation.authority,
            prepared: authenticated.prepared,
            operationRequestDigest: authenticated.operationRequestDigest,
          }),
          publish: (publication) => input.product.publish({
            authority: operation.authority,
            authored: authenticated.authored,
            ...publication,
          }),
          publishOrdinaryFallback: (publication) =>
            input.product.publishOrdinaryFallback({
              authority: operation.authority,
              authored: authenticated.authored,
              ...publication,
            }),
        });
      } catch (error) {
        const response = expectedFailure(error);
        if (response !== null) return response;
        throw error;
      }
    },
  });
}
