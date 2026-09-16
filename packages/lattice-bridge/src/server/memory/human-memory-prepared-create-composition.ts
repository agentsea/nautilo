import type {
  ProtectedMemoryCreatePlanResponseV1,
  ProtectedMemorySubmittedCreateRequestV1,
  ProtectedMemoryPreparedUpdateResponseV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";

import type {
  MemoryForegroundEmbeddingProcessor,
} from "../../memory/foreground-embedding-processor.ts";
import {
  authenticatePreparedHumanMemoryCreate,
  digestPreparedHumanMemorySignedRequest,
  type ResolveHistoricalHumanMemoryDeviceAuthority,
} from "./human-memory-prepared-update.ts";
import {
  type ResolveCurrentHumanMemoryWriteAuthorization,
} from "./postgres-human-memory-crypto-completion.ts";
import type {
  HumanMemoryProductCreateAuthority,
  HumanMemoryProductCreatePort,
} from "./postgres-human-memory-product-update.ts";
import { publishPreparedHumanMemory } from
  "./human-memory-prepared-publication.ts";
import { publishHumanMemoryOrdinaryFallbackIntent,
  type ResolveHistoricalHumanMemoryOrdinaryDeviceAuthority } from
  "./human-memory-ordinary-fallback-publication.ts";
import type {
  CreateBoundHumanMemoryCryptoCompletion,
  ResolveHumanMemoryRouteHumanId,
} from "./human-memory-prepared-update-composition.ts";
import type { ResolveHumanMemoryNamespaceAuthority } from
  "./human-memory-protected-route-ports.ts";
import {
  HumanMemoryPreparedRouteError,
  humanMemoryPreparedIntegrityError,
} from
  "./human-memory-prepared-route-error.ts";

export type HumanMemoryPreparedCreateRouteAuthority =
  HumanMemoryProductCreateAuthority & Readonly<{
    actorId: string | null;
    agentId: string | null;
    sourceRoomId: string | null;
  }>;

export interface HumanMemoryPreparedCreateRoutePort {
  planCreate(input: Readonly<{
    authority: HumanMemoryPreparedCreateRouteAuthority;
  }>): Promise<
    ProtectedMemoryCreatePlanResponseV1
    | ProtectedMemoryUnavailableResponseV1
  >;
  createPrepared(input: Readonly<{
    authority: HumanMemoryPreparedCreateRouteAuthority;
    prepared: ProtectedMemorySubmittedCreateRequestV1;
  }>): Promise<
    ProtectedMemoryPreparedUpdateResponseV1
    | ProtectedMemoryUnavailableResponseV1
  >;
}

function unavailable(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): ProtectedMemoryUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function expectedFailure(
  error: unknown,
): ProtectedMemoryUnavailableResponseV1 | null {
  return error instanceof HumanMemoryPreparedRouteError
    ? unavailable(error.reason)
    : null;
}

/** Authenticated, reservation-bound Human Memory create publication vertical. */
export function createHumanMemoryPreparedCreateRoutePort(input: Readonly<{
  crypto: LatticeCrypto;
  now: () => number;
  resolveHumanId: ResolveHumanMemoryRouteHumanId;
  resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryDeviceAuthority;
  resolveCurrentWriteAuthorization:
    ResolveCurrentHumanMemoryWriteAuthorization;
  foregroundEmbeddingProcessor: MemoryForegroundEmbeddingProcessor;
  product: HumanMemoryProductCreatePort;
  createCryptoCompletion: CreateBoundHumanMemoryCryptoCompletion;
  resolveNamespaceAuthority: ResolveHumanMemoryNamespaceAuthority;
  resolveHistoricalOrdinaryDeviceAuthority:
    ResolveHistoricalHumanMemoryOrdinaryDeviceAuthority;
  ordinaryFallbackAuthorization?: Readonly<{ policyRevision: number }>;
}>): HumanMemoryPreparedCreateRoutePort {
  const humanAuthority = async (
    authority: HumanMemoryPreparedCreateRouteAuthority,
  ): Promise<string | null> => {
    if (authority.agentId !== null) return null;
    return input.resolveHumanId(authority.userId);
  };
  return Object.freeze({
    async planCreate({ authority }: Readonly<{
      authority: HumanMemoryPreparedCreateRouteAuthority;
    }>) {
      try {
        const humanId = await humanAuthority(authority);
        if (humanId === null) {
          return unavailable("authorization_required");
        }
        const plan = await input.product.reserveCreatePlan({
          authority,
          now: input.now(),
        });
        const fallbackPlan = () => {
          if (input.ordinaryFallbackAuthorization === undefined) {
            return unavailable("target_encryption_not_ready");
          }
          if (plan.issuedAt === undefined) throw humanMemoryPreparedIntegrityError(
            "Human Memory fallback plan has no issue time",
          );
          return Object.freeze({ dtoVersion: 1 as const,
            status: "ordinary_fallback_ready" as const,
            reason: "target_encryption_not_ready" as const,
            memoryId: plan.memoryId, operationId: plan.operationId,
            expectedContentRevision: 0 as const, nextContentRevision: 1 as const,
            expectedCryptoAccessRevision: 0 as const,
            productAuthority: plan.productAuthority,
            requiredNamespaceIds: plan.requiredNamespaceIds,
            ordinaryFallbackAuthorization: input.ordinaryFallbackAuthorization,
            issuedAt: plan.issuedAt, deadlineAt: plan.deadlineAt });
        };
        if (authority.memoryMode === "scope") return fallbackPlan();
        const targetAuthorities = [];
        for (const namespaceId of plan.requiredNamespaceIds) {
          if (!authority.writableNamespaceIds.includes(namespaceId)) {
            return unavailable("authorization_required");
          }
          const resolved = await input.resolveNamespaceAuthority({
            subjectUserId: authority.userId, subjectHumanId: humanId,
            preferredSourceRoomId: authority.sourceRoomId,
            namespaceId, requested: [],
          });
          if (resolved === null) return fallbackPlan();
          targetAuthorities.push(resolved);
        }
        return Object.freeze({ ...plan, targetAuthorities,
          ...(input.ordinaryFallbackAuthorization === undefined ? {}
            : { ordinaryFallbackAuthorization:
              input.ordinaryFallbackAuthorization }) });
      } catch (error) {
        const response = expectedFailure(error);
        if (response !== null) return response;
        throw error;
      }
    },

    async createPrepared({ authority, prepared }: Readonly<{
      authority: HumanMemoryPreparedCreateRouteAuthority;
      prepared: ProtectedMemorySubmittedCreateRequestV1;
    }>) {
      try {
        const humanId = await humanAuthority(authority);
        if (humanId === null) return unavailable("authorization_required");
        if ("publicationKind" in prepared) {
          if (input.ordinaryFallbackAuthorization === undefined) {
            return unavailable("authorization_required");
          }
          return await publishHumanMemoryOrdinaryFallbackIntent({
            crypto: input.crypto, now: input.now, expectedHumanId: humanId,
            expectedPurpose: "memory.ordinary_fallback.create",
            authority, submitted: prepared, product: input.product,
            resolveHistoricalDeviceAuthority:
              input.resolveHistoricalOrdinaryDeviceAuthority,
            foregroundEmbeddingProcessor: input.foregroundEmbeddingProcessor,
          });
        }
        const requestDigest = digestPreparedHumanMemorySignedRequest(
          input.crypto, prepared);
        const reservedReplay = await input.product.lookupReservation({
          authority, operationId: prepared.operationId,
          memoryId: prepared.memoryId, operationRequestDigest: requestDigest,
        });
        const authenticated = await authenticatePreparedHumanMemoryCreate({
          crypto: input.crypto,
          expectedHumanId: humanId,
          prepared,
          now: input.now(),
          resolveHistoricalDeviceAuthority:
            input.resolveHistoricalDeviceAuthority,
          ...(reservedReplay === null ? {}
            : { reservedReplayAdmission: reservedReplay.admission }),
        });
        requestDigest.fill(0);
        const publishedAuthorities = [];
        for (const entry of prepared.namespaceEnvelopes) {
          if (!authority.writableNamespaceIds.includes(entry.namespaceId)) {
            return unavailable("authorization_required");
          }
          const envelope = decodeNamespaceObjectEnvelopeV2(
            Uint8Array.from(Buffer.from(entry.envelopeBytesBase64url, "base64url")),
          );
          const resolved = await input.resolveNamespaceAuthority({
            subjectUserId: authority.userId, subjectHumanId: humanId,
            preferredSourceRoomId: authority.sourceRoomId,
            namespaceId: entry.namespaceId,
            requested: [{ generation: envelope.context.keyGeneration,
              accessRevision: envelope.context.bindingRevisionAtWrap }],
          });
          if (resolved === null) return unavailable("target_encryption_not_ready");
          publishedAuthorities.push(resolved);
        }
        const inspection = await input.product.inspectCreate({
          authority,
          prepared: authenticated.prepared,
          operationRequestDigest: authenticated.operationRequestDigest,
          now: input.now(),
        });
        if (
          authenticated.signedRequestValidity.issuedAt < inspection.planIssuedAt
          || authenticated.signedRequestValidity.deadlineAt
            !== inspection.planDeadlineAt
        ) throw humanMemoryPreparedIntegrityError(
          "Signed Human Memory request deadline disagrees",
        );
        return await publishPreparedHumanMemory({
          crypto: input.crypto,
          humanId,
          authenticated,
          inspection,
          preparedWire: prepared,
          publishedAuthorities,
          foregroundEmbeddingProcessor: input.foregroundEmbeddingProcessor,
          createCryptoCompletion: input.createCryptoCompletion,
          resolveCurrentWriteAuthorization: input.resolveCurrentWriteAuthorization,
          allocate: () => input.product.allocateCreate({
            authority,
            prepared: authenticated.prepared,
            operationRequestDigest: authenticated.operationRequestDigest,
            now: input.now(),
          }),
          publish: (publication) => input.product.publish({
            authority,
            authored: authenticated.authored,
            ...publication,
          }),
          publishOrdinaryFallback: (publication) =>
            input.product.publishOrdinaryFallback({
              authority,
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
