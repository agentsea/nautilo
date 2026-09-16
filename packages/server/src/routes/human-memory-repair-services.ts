import { randomUUID } from "node:crypto";
import type {
  ProtectedMemoryRepairPlanResponseV1,
  ProtectedMemoryRepairResponseV1,
  ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import {
  and,
  eq,
  exists,
  inArray,
  memories,
  memoryNamespaces,
} from "@nautilo/db";
import {
  decodeHumanMemoryRepairAttestationV1,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  selectLiveEncryptionRepresentationPolicy,
  type ForegroundMemoryRepairSelection,
} from "@nautilo/lattice-bridge";
import {
  createPostgresHumanMemoryRepresentationRepairCrypto,
  isForegroundProductChangedError,
  loadPostgresForegroundMemoryRepairSources,
  publishPostgresHumanMemoryRepresentationRepair,
  type ForegroundMemoryRepairSource,
  type HumanMemoryRepairNativeAuthorityResolver,
} from "@nautilo/lattice-bridge/server";
import { HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2 } from
  "@nautilo/lattice-crypto/wire";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "@nautilo/lattice-crypto";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import type { HumanMemoryRequestServices } from "./human-memory-request-services";
import type {
  ProtectedMemoryRouteAuthority,
  ProtectedMemoryRoutePorts,
} from "./protected-memory-composition";

type RepairPort = NonNullable<ProtectedMemoryRoutePorts["repair"]>;
type Unavailable = ProtectedMemoryUnavailableResponseV1;

const unavailable = (reason: Unavailable["reason"]): Unavailable =>
  Object.freeze({ dtoVersion: 1, status: "unavailable", reason });

function sameAuthority(
  left: ProtectedMemoryRouteAuthority,
  right: ProtectedMemoryRouteAuthority,
): boolean {
  const sameIds = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().every((id, index) =>
      id === [...b].sort()[index]);
  return left.userId === right.userId && left.actorId === right.actorId
    && left.agentId === right.agentId && left.memoryMode === right.memoryMode
    && left.scopeId === right.scopeId
    && left.originWritableNamespaceId === right.originWritableNamespaceId
    && left.sourceRoomId === right.sourceRoomId
    && sameIds(left.readableNamespaceIds, right.readableNamespaceIds)
    && sameIds(left.mutableNamespaceIds, right.mutableNamespaceIds)
    && sameIds(left.writableNamespaceIds, right.writableNamespaceIds);
}

async function selectedRepairSource(input: Readonly<{
  services: HumanMemoryRequestServices;
  authority: ProtectedMemoryRouteAuthority;
  memoryId: string;
}>) {
  if (input.authority.readableNamespaceIds.length === 0) return null;
  const selected = await input.services.context.canonicalRunner.transaction(
    async (transaction): Promise<ForegroundMemoryRepairSelection | null> => {
      const rows = await transaction.select({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        importance: memories.importance,
        tier: memories.tier,
        createdAt: memories.createdAt,
      }).from(memories).where(and(
        eq(memories.id, input.memoryId),
        exists(transaction.select({ id: memoryNamespaces.memoryId })
          .from(memoryNamespaces).where(and(
            eq(memoryNamespaces.memoryId, memories.id),
            inArray(memoryNamespaces.namespaceId,
              [...input.authority.readableNamespaceIds]),
          ))),
      )).limit(2);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) return null;
      const common = {
        id: row.id,
        importance: row.importance,
        tier: row.tier,
        createdAt: row.createdAt,
      };
      return typeof row.type === "string" && typeof row.content === "string"
        ? Object.freeze({ ...common, type: row.type, content: row.content })
        : Object.freeze({
          ...common,
          representation: "structural" as const,
          type: typeof row.type === "string" ? row.type : null,
        });
    }, { isolationLevel: "serializable" },
  );
  if (selected === null) return null;
  const sources = await loadPostgresForegroundMemoryRepairSources({
    product: input.services.context.handle,
    crypto: input.services.crypto,
    memories: [selected],
    representationMode: "ordinary-and-protected",
  });
  return sources.length === 1 ? sources[0]! : null;
}

export function createHumanMemoryRepairServices(input: Readonly<{
  services: HumanMemoryRequestServices;
  authority: ProtectedMemoryRouteAuthority;
  envelope: MemoryAccessEnvelope;
  policy: Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    shadowBehavior: "fallback" | "strict";
    revision: number;
  }>;
}>): RepairPort {
  const representation = selectLiveEncryptionRepresentationPolicy(input.policy);
  const cryptoRepair = createPostgresHumanMemoryRepresentationRepairCrypto({
    handle: input.services.cryptoHandle,
    crypto: input.services.crypto,
    resolveStoredSignerAuthority:
      input.services.cryptoAuthority.resolveStoredSignerAuthority,
    resolveHistoricalAgentSignerAuthority:
      input.services.resolveHistoricalAgentSignerAuthority,
    readCurrent: input.services.cryptoCompletion.read.bind(
      input.services.cryptoCompletion,
    ),
  });
  const source = (memoryId: string) => selectedRepairSource({
    services: input.services, authority: input.authority, memoryId,
  });
  return Object.freeze({
    async plan({ authority, memoryId }): Promise<ProtectedMemoryRepairPlanResponseV1> {
      if (!sameAuthority(authority, input.authority)
        || (!representation.allowForwardRepair && !representation.allowReverseRepair)) {
        return unavailable("authorization_required");
      }
      let selected: ForegroundMemoryRepairSource | null;
      try {
        selected = await source(memoryId);
      } catch (error) {
        if (isForegroundProductChangedError(error)) {
          return unavailable("stale_revision");
        }
        throw error;
      }
      if (selected === null) return unavailable("authorization_required");
      const direction = selected.existingObjectId === null
        ? selected.plaintextBytes === null ? null : "ordinary_to_protected" as const
        : selected.plaintextBytes === null
        ? "protected_to_ordinary" as const
        : null;
      if (direction === null) {
        return Object.freeze({ dtoVersion: 1, status: "not_needed", memoryId });
      }
      if (direction === "ordinary_to_protected"
        ? !representation.allowForwardRepair : !representation.allowReverseRepair) {
        return unavailable("authorization_required");
      }
      const subjectHumanId = await input.services.resolveHumanId(authority.userId);
      if (subjectHumanId === null) return unavailable("authorization_required");
      const targetAuthorities = [];
      for (const namespaceId of selected.accessNamespaceIds) {
        const resolved = await input.services.resolveNamespaceAuthority({
          subjectUserId: authority.userId,
          subjectHumanId,
          preferredSourceRoomId: authority.sourceRoomId,
          namespaceId,
          requested: [],
        });
        if (resolved === null) return unavailable("target_encryption_not_ready");
        targetAuthorities.push(resolved);
      }
      const now = Date.now();
      const common = {
        dtoVersion: 1 as const,
        status: "planned" as const,
        mode: "shadow_encryption" as const,
        shadowBehavior: input.policy.shadowBehavior,
        policyRevision: input.policy.revision,
        memoryId,
        operationId: randomUUID(),
        expectedContentRevision: selected.expectedContentRevision,
        targetContentRevision: selected.targetContentRevision,
        expectedCryptoAccessRevision: selected.expectedAccessRevision,
        cryptoObjectId: selected.existingObjectId
          ?? deriveMemoryCryptoObjectIdV1({
            memoryId,
            contentRevision: selected.targetContentRevision,
          }),
        requiredNamespaceIds: [...selected.accessNamespaceIds],
        requiredNamespaceFingerprintBase64url: Buffer.from(
          fingerprintRequiredMemoryNamespaces(selected.accessNamespaceIds),
        ).toString("base64url"),
        targetAuthorities,
        createdAt: selected.createdAt,
        deadlineAt: now + HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2,
      };
      if (direction === "ordinary_to_protected") {
        return Object.freeze({ ...common, direction, repairInput: {
          formatVersion: 1 as const,
          type: selected.memory.type!,
          content: selected.memory.content!,
        } });
      }
      const detail = await input.services.product.detail({
        subjectHumanId, authority, memoryId, canManageMemories: false,
      });
      if ("status" in detail) return detail;
      return Object.freeze({
        ...common, direction, repairInput: detail.memory,
      });
    },

    async commit({ authority, memoryId, prepared }): Promise<ProtectedMemoryRepairResponseV1> {
      if (!sameAuthority(authority, input.authority)
        || (prepared.direction === "ordinary_to_protected"
          ? !representation.allowForwardRepair : !representation.allowReverseRepair)
        || prepared.memoryId !== memoryId) return unavailable("authorization_required");
      let attestation;
      try {
        attestation = decodeHumanMemoryRepairAttestationV1(Buffer.from(
          prepared.signedRepairAttestationBytesBase64url,
          "base64url",
        ));
      } catch {
        return unavailable("integrity_failure");
      }
      if (attestation.memoryId !== memoryId
        || attestation.operationId !== prepared.operationId
        || attestation.direction !== prepared.direction
        || attestation.policyRevision !== input.policy.revision) {
        return unavailable("integrity_failure");
      }
      const selected = await source(memoryId);
      if (selected === null) return unavailable("authorization_required");
      const currentHumanId = await input.services.resolveHumanId(authority.userId);
      if (currentHumanId === null
        || currentHumanId !== attestation.subjectHumanId) {
        return unavailable("authorization_required");
      }
      const signingKey = await input.services.cryptoAuthority
        .resolveCurrentAccessSigningKey({
          purpose: "human-memory-exact-access-verify",
          subjectHumanId: humanId(attestation.subjectHumanId),
          operationId: attestation.operationId,
          committerDeviceId: cryptoDeviceId(attestation.deviceId),
          hostAuthorizationRevision: authorizationRevision(
            attestation.hostAuthorizationRevision,
          ),
        });
      if (signingKey === null) return unavailable("authorization_required");
      try {
        const payload = prepared.direction === "ordinary_to_protected"
          ? {
            formatVersion: 1 as const,
            type: selected.memory.type!,
            content: selected.memory.content!,
          }
          : prepared.payload;
        const nativeAuthority: HumanMemoryRepairNativeAuthorityResolver = {
          withCurrent: <Result>(context: Parameters<
            HumanMemoryRepairNativeAuthorityResolver["withCurrent"]
          >[0], publish: () => Promise<Result>) => input.services.cryptoAuthority
            .withCurrentNativeMemoryAuthority(context, publish),
        };
        const common = {
          crypto: input.services.crypto,
          canonical: input.services.context.canonicalRunner,
          committerSigningPublicKey: signingKey,
          authority: {
            userId: authority.userId,
            humanId: currentHumanId,
            humanActorId: input.envelope.actorId,
            readableNamespaceIds: authority.readableNamespaceIds,
          },
          source: selected,
          payload,
          nativeAuthority,
          now: Date.now(),
        };
        const result = prepared.direction === "ordinary_to_protected"
          ? await publishPostgresHumanMemoryRepresentationRepair({
            ...common,
            attestation: Object.freeze({
              ...attestation, direction: "ordinary_to_protected" as const,
            }),
            completeForward: async () => {
              const payloadBytes = Buffer.from(
                prepared.encryptedPayloadBytesBase64url, "base64url");
              const accessManifestBytes = Buffer.from(
                prepared.accessManifestBytesBase64url, "base64url");
              const namespaceEnvelopes = prepared.namespaceEnvelopes.map(
                (entry) => ({
                  namespaceId: entry.namespaceId,
                  envelopeBytes: Buffer.from(
                    entry.envelopeBytesBase64url, "base64url"),
                }),
              );
              try {
                const outcome = await cryptoRepair.complete({
                  attestation,
                  payloadBytes,
                  accessManifestBytes,
                  namespaceEnvelopes,
                  committerSigningPublicKey: signingKey,
                });
                return outcome === "created" || outcome === "duplicate";
              } finally {
                payloadBytes.fill(0);
                accessManifestBytes.fill(0);
                namespaceEnvelopes.forEach((entry) =>
                  entry.envelopeBytes.fill(0));
              }
            },
          })
          : await publishPostgresHumanMemoryRepresentationRepair({
            ...common,
            attestation: Object.freeze({
              ...attestation, direction: "protected_to_ordinary" as const,
            }),
            verifyReverse: () => cryptoRepair.verify(attestation),
          });
        if (result === "repaired" || result === "replayed") {
          return Object.freeze({
            dtoVersion: 1,
            status: result,
            memoryId,
            operationId: prepared.operationId,
            direction: prepared.direction,
            contentRevision: selected.targetContentRevision,
            cryptoAccessRevision: selected.expectedAccessRevision,
          });
        }
        return unavailable(result === "unauthorized"
          ? "authorization_required"
          : result === "waiting_for_authority"
          ? "target_encryption_not_ready"
          : "stale_revision");
      } finally {
        signingKey.fill(0);
      }
    },
  });
}
