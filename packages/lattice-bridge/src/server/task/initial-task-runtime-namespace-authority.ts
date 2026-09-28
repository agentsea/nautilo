import {
  acquireEncryptionConsumptionFence,
  actors,
  and,
  asc,
  domainKeyHeads,
  eq,
  roomMembers,
  rooms,
  tasks,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { LATTICE_LIMITS, type LatticeCrypto } from "@nautilo/lattice-crypto";
import { PostgresDomainKeyAuthorityRepository, type DomainForegroundNamespaceAuthorityInspectionV2 } from "../delivery/postgres-domain-key-authority.ts";
import {
  inspectNamespaceProductAuthoritySnapshot,
  PostgresNamespaceProductAuthority,
} from "../delivery/postgres-namespace-product-authority.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductCanonicalTransactionRunner,
} from "../message/postgres-conversation-product-store.ts";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type InitialTaskRuntimeNamespaceFact = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  expectedDomainEpoch: number;
  expectedAuthorizationRevision: number;
}>;

export type InitialTaskRuntimeNamespaceAuthority = Readonly<{
  sourceRoomId: string;
  sourceNamespaceId: string;
  facts: readonly InitialTaskRuntimeNamespaceFact[];
}>;

function inTransaction(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: executor.query.bind(executor),
    transaction: (use) => use(executor),
    transactionOnce: (use) => use(executor),
  };
}

/**
 * Unmounted planning owner. All product and crypto evidence is consumed while
 * locked; only detached scalar coordinates escape. These facts are a plan,
 * never a replacement for response-acceptance or execution revalidation.
 */
export async function inspectInitialTaskRuntimeNamespaceAuthority(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  taskId: string;
  requesterUserId: string;
  requesterHumanId: string;
  agentId: string;
  contentNamespaceId: string;
  sourceRoomId: string;
  namespaceIds: readonly string[];
  expectedPolicyRevision: number;
}>): Promise<InitialTaskRuntimeNamespaceAuthority | null> {
  // Snapshot caller-owned coordinates before the first asynchronous boundary.
  const request = Object.freeze({ ...input,
    namespaceIds: Object.freeze([...input.namespaceIds]),
  });
  if ([request.taskId, request.requesterUserId, request.requesterHumanId,
    request.agentId, request.contentNamespaceId, request.sourceRoomId]
    .some((value) => !UUID.test(value))
    || !Number.isSafeInteger(request.expectedPolicyRevision)
    || request.expectedPolicyRevision < 0
    || request.namespaceIds.length < 1
    || request.namespaceIds.length > LATTICE_LIMITS.agentGrantNamespaces
    || !request.namespaceIds.includes(request.contentNamespaceId)
    || request.namespaceIds.some((value, index) => !UUID.test(value)
      || (index > 0 && request.namespaceIds[index - 1]! >= value))) {
    throw new TypeError("Initial Task Runtime authority coordinates are invalid");
  }
  return request.runner.transaction(async (tx, executor) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode === "plaintext_only"
      || policy.revision !== request.expectedPolicyRevision) return null;
    const product = inTransaction(executor);
    const taskRows = await executeTypedConversationProductQuery(product,
      conversationProductTypedDb.select({
        task_id: tasks.id,
        requestor_id: tasks.requestorId,
        agent_id: tasks.agentId,
        content_namespace_id: tasks.contentNamespaceId,
        content_representation: tasks.contentRepresentation,
      }).from(tasks).where(eq(tasks.id, request.taskId)).limit(2).for("update"));
    const task = taskRows[0];
    if (taskRows.length !== 1 || task === undefined
      || task.id !== request.taskId
      || task.requestor_id !== request.requesterUserId
      || task.agent_id !== request.agentId
      || task.content_namespace_id !== request.contentNamespaceId
      || (task.content_representation !== "protected"
        && task.content_representation !== "dual")) return null;
    return new PostgresNamespaceProductAuthority(product)
      .withCurrentReadableNamespaceSet({
        subjectUserId: request.requesterUserId,
        subjectHumanId: request.requesterHumanId,
        sourceRoomId: request.sourceRoomId,
        namespaceIds: request.namespaceIds,
        use: async (entries) => {
          // The shared owner already locked the source, subject and membership
          // rows and proved current moderation/readability for every target.
          const sourceRows = await executeTypedConversationProductQuery(product,
            conversationProductTypedDb.select({
              source_room_id: rooms.id,
              namespace_id: rooms.namespaceId,
              type: rooms.type,
              kind: rooms.kind,
              parent_room_id: rooms.parentRoomId,
              archived_at: rooms.archivedAt,
              human_actor_ids: rooms.humanActorIds,
            }).from(rooms).where(eq(rooms.id, request.sourceRoomId))
              .limit(2).for("update"));
          const source = sourceRows[0];
          if (sourceRows.length !== 1 || source === undefined
            || source.id !== request.sourceRoomId
            || source.namespace_id !== request.contentNamespaceId
            || source.type !== "private" || source.kind !== "private"
            || source.parent_room_id !== null || source.archived_at !== null
            || source.human_actor_ids.length !== 1
            || source.human_actor_ids[0] !== request.requesterHumanId) return null;
          const members = await executeTypedConversationProductQuery(product,
            conversationProductTypedDb.select({
              actor_id: actors.id,
              kind: actors.kind,
              agent_id: actors.agentId,
              owner_id: actors.ownerId,
            }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
              .where(eq(roomMembers.roomId, request.sourceRoomId))
              .orderBy(asc(actors.id)).limit(3).for("share", { of: actors }));
          if (members.length !== 2
            || members.filter((member) => member.kind === "user"
              && member.id === request.requesterHumanId
              && member.owner_id === request.requesterUserId).length !== 1
            || members.filter((member) => member.kind === "agent"
              && member.agent_id === request.agentId).length !== 1) return null;
          if (entries.length !== request.namespaceIds.length) return null;
          const accessRevisions: number[] = [];
          for (const [index, entry] of entries.entries()) {
            const snapshot = inspectNamespaceProductAuthoritySnapshot(entry.authority);
            try {
              if (entry.namespaceId !== request.namespaceIds[index]
                || snapshot.namespaceId !== entry.namespaceId
                || snapshot.subjectHumanId !== request.requesterHumanId) return null;
              accessRevisions.push(snapshot.accessRevision);
            } finally {
              snapshot.audienceFingerprint.fill(0);
            }
          }
          return request.restricted.transactionOnce(async (restrictedTx) => {
            const restricted = inTransaction(restrictedTx);
            await verifyCryptoPostgresHandle(restricted);
            const repository = new PostgresDomainKeyAuthorityRepository(
              restricted, request.crypto, request.serverScope,
            );
            const authorities: DomainForegroundNamespaceAuthorityInspectionV2[] = [];
            const byDomain = new Map<string, DomainForegroundNamespaceAuthorityInspectionV2[]>();
            try {
              // Preserve the shared Namespace -> Domain lock order. In
              // particular, never lock a Domain before a later Namespace.
              for (const [index, namespaceId] of request.namespaceIds.entries()) {
                const authority = await repository.inspectForegroundNamespaceAuthority({
                  namespaceId, keyClass: "ai",
                });
                if (authority.status !== "ready") return null;
                authorities.push(authority);
                if (authority.namespaceId !== namespaceId
                  || authority.namespaceAccessRevision !== accessRevisions[index]) return null;
                const group = byDomain.get(authority.domainId);
                if (group === undefined) byDomain.set(authority.domainId, [authority]);
                else group.push(authority);
              }
              const domainIds = [...byDomain.keys()].sort();
              if (domainIds.length > LATTICE_LIMITS.agentGrantDomains) return null;
              for (const domainId of domainIds) {
                const heads = await executeTypedCryptoQuery(restricted,
                  cryptoTypedDb.select({
                    domain_id: domainKeyHeads.domainId,
                    domain_key_generation: domainKeyHeads.domainKeyGeneration,
                    authorization_revision: domainKeyHeads.authorizationRevision,
                    head_digest: domainKeyHeads.headDigest,
                  }).from(domainKeyHeads).where(and(
                    eq(domainKeyHeads.domainId, domainId),
                    eq(domainKeyHeads.keyClass, "ai"),
                  )).limit(2).for("share"));
                const head = heads[0];
                if (heads.length !== 1 || head === undefined
                  || head.domain_id !== domainId
                  || !(head.head_digest instanceof Uint8Array)) return null;
                for (const authority of byDomain.get(domainId)!) {
                  if (head.domain_key_generation !== authority.domainKeyGeneration
                    || head.authorization_revision !== authority.domainAuthorizationRevision
                    || head.head_digest.length !== authority.domainHeadDigest.length
                    || !head.head_digest.every((byte, offset) =>
                      byte === authority.domainHeadDigest[offset])) return null;
                }
              }
              const facts = authorities.map((authority): InitialTaskRuntimeNamespaceFact => Object.freeze({
                namespaceId: authority.namespaceId,
                domainId: authority.domainId,
                expectedAccessRevision: authority.namespaceAccessRevision,
                expectedPolicyRevision: policy.revision,
                expectedDomainEpoch: authority.domainKeyGeneration,
                expectedAuthorizationRevision: authority.domainAuthorizationRevision,
              }));
              return Object.freeze({ sourceRoomId: request.sourceRoomId,
                sourceNamespaceId: request.contentNamespaceId,
                facts: Object.freeze(facts) });
            } finally {
              for (const authority of authorities) {
                authority.namespaceHeadDigest.fill(0);
                authority.namespacePublicationDigest.fill(0);
                authority.namespacePublicationSetDigest.fill(0);
                authority.namespaceAudienceFingerprint.fill(0);
                authority.domainHeadDigest.fill(0);
                authority.bundleDigest.fill(0);
              }
            }
          }, { isolationLevel: "read committed" });
        },
      });
  }, { isolationLevel: "read committed" });
}
