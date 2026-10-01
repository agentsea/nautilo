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
import {
  LATTICE_LIMITS,
  type DomainForegroundAuthorityEntry,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  PostgresDeviceAdmissionRepository,
  type CurrentDeviceAdmissionAuthority,
} from "../device/postgres-device-admission-repository.ts";
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

import type {
  TaskRuntimeDomainAuthorityRequirement,
  TaskRuntimeNamespaceAuthorityRequirement,
} from "./current-task-runtime-authority.ts";

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

type InitialTaskRuntimeNamespaceInput = Readonly<{
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
}>;

async function withInitialTaskRuntimeProductAuthority<Value>(
  input: InitialTaskRuntimeNamespaceInput,
  use: (
    restricted: PostgresJsBridgeConnection,
    accessRevisions: readonly number[],
    policyRevision: number,
  ) => Promise<Value | null>,
  validateCurrentTaskRun?: (
    product: PostgresJsBridgeConnection,
  ) => Promise<boolean>,
): Promise<Value | null> {
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
    // Recipient binding starts before a signed request exists. Hold the exact
    // awaiting TaskRun lock for the entire request-construction callback.
    if (validateCurrentTaskRun !== undefined
      && !await validateCurrentTaskRun(product)) return null;
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
            return use(restricted, accessRevisions, policy.revision);
          }, { isolationLevel: "read committed" });
        },
      });
  }, { isolationLevel: "read committed" });
}

/** Detached planning facts; never a substitute for operation-time authority. */
export async function inspectInitialTaskRuntimeNamespaceAuthority(
  input: InitialTaskRuntimeNamespaceInput,
): Promise<InitialTaskRuntimeNamespaceAuthority | null> {
  const request = Object.freeze({
    ...input,
    namespaceIds: Object.freeze([...input.namespaceIds]),
  });
  return withInitialTaskRuntimeProductAuthority(
    request,
    async (restricted, accessRevisions, policyRevision) => {
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
          expectedPolicyRevision: policyRevision,
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
    },
  );
}

export type InitialTaskRuntimeRecipientAuthority = Readonly<{
  sourceRoomId: string;
  sourceNamespaceId: string;
  device: CurrentDeviceAdmissionAuthority;
  domains: readonly DomainForegroundAuthorityEntry[];
  namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  policyRevision: number;
}>;

function sameDevice(left: CurrentDeviceAdmissionAuthority, right: CurrentDeviceAdmissionAuthority): boolean {
  return left.userId === right.userId && left.humanActorId === right.humanActorId
    && left.deviceId === right.deviceId && left.deviceGeneration === right.deviceGeneration
    && left.serverInstanceId === right.serverInstanceId && left.lineageGeneration === right.lineageGeneration
    && left.epoch === right.epoch && left.securityRevision === right.securityRevision
    && left.headDigest.length === right.headDigest.length
    && left.headDigest.every((byte, index) => byte === right.headDigest[index])
    && left.signingPublicKey.length === right.signingPublicKey.length
    && left.signingPublicKey.every((byte, index) => byte === right.signingPublicKey[index]);
}

/**
 * Awaiting-phase request construction under the same product proof as planning.
 * The callback borrows public authority only; copy public bytes into its request
 * before returning. No key material or transaction handle is lent.
 */
export async function withInitialTaskRuntimeRecipientAuthority<Value>(input: InitialTaskRuntimeNamespaceInput & Readonly<{
  deviceId: string;
  namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
  validateCurrentTaskRun(product: PostgresJsBridgeConnection): Promise<boolean>;
  signal?: AbortSignal;
  use(authority: InitialTaskRuntimeRecipientAuthority): Value | Promise<Value>;
}>): Promise<Value | null> {
  const namespaces = Object.freeze(input.namespaceRequirements.map((entry) => Object.freeze({
    ...entry, operations: Object.freeze([...entry.operations]),
  })));
  const domains = Object.freeze(input.domainRequirements.map((entry) => Object.freeze({ ...entry })));
  const request = Object.freeze({ ...input, namespaceIds: Object.freeze([...input.namespaceIds]) });
  if (typeof request.validateCurrentTaskRun !== "function"
    || request.deviceId.length === 0 || namespaces.length !== request.namespaceIds.length
    || namespaces.some((entry, index) => entry.ordinal !== index
      || entry.namespaceId !== request.namespaceIds[index]
      || !Number.isSafeInteger(entry.expectedAccessRevision) || entry.expectedAccessRevision < 0
      || entry.expectedPolicyRevision !== request.expectedPolicyRevision
      || (entry.namespaceId === request.contentNamespaceId
        && (entry.operations.length !== 2 || entry.operations[0] !== "decrypt" || entry.operations[1] !== "encrypt"))
      || entry.operations.length < 1 || entry.operations.length > 2
      || entry.operations.some((operation, ordinal) => (operation !== "decrypt" && operation !== "encrypt")
        || (ordinal > 0 && entry.operations[ordinal - 1]! >= operation)))
    || domains.length < 1 || domains.length > LATTICE_LIMITS.agentGrantDomains
    || domains.some((entry, index) => entry.ordinal !== index
      || entry.domainId.length === 0 || (index > 0 && domains[index - 1]!.domainId >= entry.domainId)
      || !Number.isSafeInteger(entry.expectedEpoch) || entry.expectedEpoch < 1
      || !Number.isSafeInteger(entry.expectedAuthorizationRevision) || entry.expectedAuthorizationRevision < 0)
    || namespaces.some((entry) => !domains.some((domain) => domain.domainId === entry.domainId))
    || domains.some((domain) => !namespaces.some((entry) => entry.domainId === domain.domainId))) {
    throw new TypeError("Initial Task Runtime recipient requirements are invalid");
  }
  request.signal?.throwIfAborted();
  return withInitialTaskRuntimeProductAuthority(request, async (restricted, accessRevisions, policyRevision) => {
    if (namespaces.some((entry, index) => entry.expectedAccessRevision !== accessRevisions[index])) return null;
    const subject = { userId: request.requesterUserId, humanActorId: request.requesterHumanId, deviceId: request.deviceId };
    const admission = new PostgresDeviceAdmissionRepository(await verifyCryptoPostgresHandle(restricted), request.crypto);
    const owned: Uint8Array[] = [];
    const retainDevice = (device: CurrentDeviceAdmissionAuthority) => { owned.push(device.signingPublicKey, device.headDigest); };
    try {
      const device = await admission.currentAuthorityForDelegation(subject);
      if (device === null) return null;
      retainDevice(device);
      if (device.userId !== subject.userId || device.humanActorId !== subject.humanActorId
        || device.deviceId !== subject.deviceId) return null;
      const repository = new PostgresDomainKeyAuthorityRepository(restricted, request.crypto, request.serverScope);
      // This owner locks the admitted device, then all Namespaces, then Domains.
      const inspected = await repository.inspectForegroundAuthority({
        namespaceIds: request.namespaceIds, keyClass: "ai",
        subjectHumanId: request.requesterHumanId, deviceId: request.deviceId,
      });
      if (inspected.status !== "ready") return null;
      for (const domain of inspected.domains) owned.push(domain.participantDigest, domain.headDigest, domain.activeNamespaceBindingSetDigest);
      if (inspected.committerDeviceId !== device.deviceId
        || inspected.committerDeviceSigningGeneration !== device.deviceGeneration
        || inspected.hostAuthorizationRevision !== device.securityRevision
        || inspected.domains.length !== domains.length
        || inspected.domains.some((domain, index) => domain.domainId !== domains[index]?.domainId
          || domain.domainKeyGeneration !== domains[index]?.expectedEpoch
          || domain.authorizationRevision !== domains[index]?.expectedAuthorizationRevision)) return null;
      // Every Namespace is already locked by inspectForegroundAuthority. Check
      // its exact Domain and product access revision without introducing locks
      // on any additional Namespace after the Domain locks.
      for (const requirement of namespaces) {
        const current = await repository.inspectForegroundNamespaceAuthority({ namespaceId: requirement.namespaceId, keyClass: "ai" });
        if (current.status !== "ready") return null;
        owned.push(current.namespaceHeadDigest, current.namespacePublicationDigest, current.namespacePublicationSetDigest,
          current.namespaceAudienceFingerprint, current.domainHeadDigest, current.bundleDigest);
        const domain = inspected.domains.find((entry) => entry.domainId === requirement.domainId);
        if (domain === undefined || current.domainId !== requirement.domainId
          || current.namespaceAccessRevision !== requirement.expectedAccessRevision
          || current.domainKeyGeneration !== domain.domainKeyGeneration
          || current.domainAuthorizationRevision !== domain.authorizationRevision
          || current.domainHeadDigest.length !== domain.headDigest.length
          || !current.domainHeadDigest.every((byte, index) => byte === domain.headDigest[index])) return null;
      }
      // Re-read after the device/group rows have been locked by the native owner.
      const lockedDevice = await admission.currentAuthorityForDelegation(subject);
      if (lockedDevice === null) return null;
      retainDevice(lockedDevice);
      if (!sameDevice(device, lockedDevice)) return null;
      request.signal?.throwIfAborted();
      const value = await request.use(Object.freeze({ sourceRoomId: request.sourceRoomId,
        sourceNamespaceId: request.contentNamespaceId, device: Object.freeze(lockedDevice),
        domains: inspected.domains, namespaceRequirements: namespaces, policyRevision }));
      request.signal?.throwIfAborted();
      return value;
    } finally { for (const bytes of owned) bytes.fill(0); }
  }, request.validateCurrentTaskRun);
}
