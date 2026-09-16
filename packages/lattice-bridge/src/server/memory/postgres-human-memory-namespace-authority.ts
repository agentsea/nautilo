import {
  and,
  eq,
  isNull,
  rooms,
} from "@nautilo/db";

import type { PostgresDomainKeyAuthorityRepository } from
  "../delivery/postgres-domain-key-authority.ts";
import type { PostgresNamespaceProductAuthority } from
  "../delivery/postgres-namespace-product-authority.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import type { ResolveHumanMemoryNamespaceAuthority } from
  "./human-memory-protected-route-ports.ts";

function toBase64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function resolveSourceRoom(
  transaction: ConversationProductPostgresTransaction,
  input: Readonly<{
    namespaceId: string;
    preferredSourceRoomId: string | null;
  }>,
): Promise<string | null> {
  let sourceRoomId: string | null = null;
  if (input.preferredSourceRoomId !== null) {
    const sources = await executeTypedConversationProductQuery(transaction,
      conversationProductTypedDb.select({
        source_room_id: rooms.id,
        authority_room_id: rooms.parentRoomId,
      }).from(rooms).where(and(
        eq(rooms.id, input.preferredSourceRoomId),
        eq(rooms.namespaceId, input.namespaceId),
        isNull(rooms.archivedAt),
      )).limit(2));
    if (sources.length === 1) sourceRoomId = sources[0]!.id;
  }
  if (sourceRoomId === null) {
    const roots = await executeTypedConversationProductQuery(transaction,
      conversationProductTypedDb.select({ source_room_id: rooms.id })
        .from(rooms).where(and(
          eq(rooms.namespaceId, input.namespaceId),
          isNull(rooms.parentRoomId),
          isNull(rooms.archivedAt),
        )).limit(2));
    if (roots.length !== 1) return null;
    sourceRoomId = roots[0]!.id;
  }
  return sourceRoomId;
}

/**
 * Resolves public Domain binding descriptors only after exact Human product
 * membership has selected one Namespace. No key or ciphertext crosses this
 * trusted-server boundary.
 */
export function createPostgresHumanMemoryNamespaceAuthorityResolver(input: Readonly<{
  product: ConversationProductPostgresHandle;
  productAuthority: Pick<PostgresNamespaceProductAuthority,
    "withCurrentHumanNamespaceRoom">;
  domainKeys: Pick<PostgresDomainKeyAuthorityRepository,
    "inspectNamespaceGenerationAuthorityMetadata">;
}>): ResolveHumanMemoryNamespaceAuthority {
  assertVerifiedConversationProductPostgresHandle(input.product);
  return async (request) => {
    const sourceRoomId = await input.product.transaction(
      (transaction) => resolveSourceRoom(transaction, request),
      { isolationLevel: "serializable" },
    );
    if (sourceRoomId === null) return null;
    return input.productAuthority.withCurrentHumanNamespaceRoom({
      subjectUserId: request.subjectUserId,
      subjectHumanId: request.subjectHumanId,
      roomId: sourceRoomId,
      namespaceId: request.namespaceId,
      use: async () => {
        const inspected = await input.domainKeys.inspectNamespaceGenerationAuthorityMetadata({
          namespaceId: request.namespaceId,
          keyClass: "ai",
          requested: request.requested,
        });
        if (inspected.status !== "ready" || inspected.namespaceId !== request.namespaceId) {
          return null;
        }
        return Object.freeze({ sourceRoomId, namespaceId: request.namespaceId,
          currentGeneration: inspected.currentGeneration,
          retainedGenerations: inspected.retainedGenerations.map((entry) => ({
            generation: entry.generation, accessRevision: entry.accessRevision,
            headDigestBase64url: toBase64url(entry.headDigest),
            publicationDigestBase64url: toBase64url(entry.publicationDigest),
            publicationSetDigestBase64url: toBase64url(entry.publicationSetDigest),
            audienceFingerprintBase64url: toBase64url(entry.audienceFingerprint),
          })) });
      },
    });
  };
}
