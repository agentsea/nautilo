import {
  actors, and, asc, createPostgresJsBridgeConnection, eq,
  getSharedDirectCryptoDb, roomMembers, rooms,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  conversationProductTypedDb, executeTypedConversationProductQuery,
  inspectTaskDeliveryNamespaceAuthority, withTaskDeliveryRecipientAuthority,
  withCurrentTaskRuntimeAuthority, withCurrentAcceptedTaskRuntimeClaimAuthority,
  type AcceptedTaskRuntimeAuthorizationV3, type CurrentTaskRuntimeAuthority,
  type InitialTaskRuntimeRecipientAuthority, type StenographerRequestAdmission,
  type TaskRuntimeAuthoritySubject, type TaskRuntimeDomainAuthorityRequirement,
  type TaskRuntimeNamespaceAuthorityRequirement,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { findActorByOwnerId } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  readProtectedTaskTerminalMessageIntent,
  sameProtectedTaskTerminalMessageIntent,
  type ProtectedTaskTerminalMessageIntent,
} from "./protected-task-terminal-message-product";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";

type Coordinates = Readonly<{
  intent: ProtectedTaskTerminalMessageIntent;
  publicationPolicyRevision: number;
  subject: TaskRuntimeAuthoritySubject;
  restricted?: PostgresJsBridgeConnection;
  signal?: AbortSignal;
}>;

export type ProtectedTaskTerminalMessageDiscoveryAuthority =
  InitialTaskRuntimeRecipientAuthority & Readonly<{
    /** Borrowed only for the callback lifetime. */
    restricted: PostgresJsBridgeConnection;
  }>;

export type ProtectedTaskTerminalMessageAuthorityPort = Readonly<{
  withDiscovery<Value>(input: Coordinates & Readonly<{
    use(current: ProtectedTaskTerminalMessageDiscoveryAuthority,
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx): Value | Promise<Value>;
    validateBeforeCommit?(): void | Promise<void>;
  }>): Promise<Value | null>;
  withBound<Value>(input: Coordinates & Readonly<{
    request: TaskRuntimeBackgroundAuthorizationRequestV1;
    admission: StenographerRequestAdmission;
    namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
    domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
    use(current: CurrentTaskRuntimeAuthority,
      product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection): Value | Promise<Value>;
  }>): Promise<Value | null>;
  withAccepted<Value>(input: Coordinates & Readonly<{
    accepted: AcceptedTaskRuntimeAuthorizationV3;
    use(current: CurrentTaskRuntimeAuthority,
      product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx): Value | Promise<Value>;
    validateBeforeCommit(): void | Promise<void>;
  }>): Promise<Value | null>;
}>;

export type ProtectedTaskTerminalMessageAuthorityDependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  restricted(): PostgresJsBridgeConnection;
  resolveRequesterHuman(userId: string):
    Promise<Readonly<{ id: string }> | null>;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  createProductContext: typeof createHumanProductTransactionContext;
  inspectDeliveryAuthority: typeof inspectTaskDeliveryNamespaceAuthority;
  withRecipientAuthority: typeof withTaskDeliveryRecipientAuthority;
  withBoundAuthority: typeof withCurrentTaskRuntimeAuthority;
  withAcceptedAuthority: typeof withCurrentAcceptedTaskRuntimeClaimAuthority;
  validateCurrentIntent:
    typeof validateCurrentProtectedTaskTerminalMessageIntent;
  now(): number;
}>;

/** Rechecks the immutable stopped Task/Run/binding proof in the held product transaction. */
export async function validateCurrentProtectedTaskTerminalMessageIntent(
  input: Readonly<{
    transaction: CanonicalTranscriptTx;
    intent: ProtectedTaskTerminalMessageIntent;
  }>,
): Promise<boolean> {
  const current = await readProtectedTaskTerminalMessageIntent(
    input.transaction,
    { taskId: input.intent.taskId, taskRunId: input.intent.taskRunId },
  );
  return current !== null
    && sameProtectedTaskTerminalMessageIntent(input.intent, current);
}

async function exactPrivateRoom(
  product: PostgresJsBridgeConnection,
  roomId: string,
  intent: ProtectedTaskTerminalMessageIntent,
  subject: TaskRuntimeAuthoritySubject,
): Promise<boolean> {
  const rows = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      id: rooms.id, namespaceId: rooms.namespaceId,
      type: rooms.type, kind: rooms.kind, parentRoomId: rooms.parentRoomId,
      archivedAt: rooms.archivedAt, humanActorIds: rooms.humanActorIds,
    }).from(rooms).where(eq(rooms.id, roomId)).limit(2).for("update"));
  const room = rows[0];
  if (rows.length !== 1 || room === undefined || room.id !== roomId
    || room.namespace_id !== intent.contentNamespaceId
    || room.type !== "private" || room.kind !== "private"
    || room.parent_room_id !== null || room.archived_at !== null
    || room.human_actor_ids.length !== 1
    || room.human_actor_ids[0] !== subject.humanActorId) return false;
  const members = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      id: actors.id, kind: actors.kind,
      ownerId: actors.ownerId, agentId: actors.agentId,
    }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, roomId)).orderBy(asc(actors.id))
      .limit(3).for("share", { of: actors }));
  return members.length === 2
    && members.filter(member => member.kind === "user"
      && member.id === subject.humanActorId
      && member.owner_id === subject.userId).length === 1
    && members.filter(member => member.kind === "agent").length === 1;
}

/** The canonical destination owner has already locked this Room and roster. */
async function exactDestinationAgent(
  product: PostgresJsBridgeConnection,
  intent: ProtectedTaskTerminalMessageIntent,
): Promise<boolean> {
  const rows = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      actorId: actors.id,
      agentId: actors.agentId,
    }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(
        eq(roomMembers.roomId, intent.destinationRoomId),
        eq(actors.kind, "agent"),
        eq(actors.agentId, intent.agentId),
      )).limit(2));
  return rows.length === 1 && rows[0]?.agent_id === intent.agentId;
}

function exactRequirements(
  intent: ProtectedTaskTerminalMessageIntent,
  policyRevision: number,
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[],
  domains: readonly TaskRuntimeDomainAuthorityRequirement[],
): boolean {
  const namespace = namespaces[0];
  const domain = domains[0];
  return namespaces.length === 1 && domains.length === 1
    && namespace !== undefined && domain !== undefined
    && namespace.ordinal === 0 && domain.ordinal === 0
    && namespace.namespaceId === intent.destinationNamespaceId
    && namespace.domainId === domain.domainId
    && namespace.operations.length === 1
    && namespace.operations[0] === "encrypt"
    && namespace.expectedPolicyRevision === policyRevision;
}

function copyNamespaces(
  values: readonly TaskRuntimeNamespaceAuthorityRequirement[],
) {
  return Object.freeze(values.map(value => Object.freeze({
    ...value,
    operations: Object.freeze([...value.operations]),
  })));
}

/** Canonical destination-only authority for the fixed terminal Task Message. */
export function createProtectedTaskTerminalMessageAuthorityPort(
  overrides: Partial<ProtectedTaskTerminalMessageAuthorityDependencies> = {},
): ProtectedTaskTerminalMessageAuthorityPort {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const serverScope = overrides.serverScope
    ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
      || "http://localhost:3001");
  const restricted = overrides.restricted
    ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const resolveHuman = overrides.resolveRequesterHuman ?? findActorByOwnerId;
  const resolveRoom = overrides.resolveRequesterPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(db);
  const context = overrides.createProductContext
    ?? createHumanProductTransactionContext;
  const inspect = overrides.inspectDeliveryAuthority
    ?? inspectTaskDeliveryNamespaceAuthority;
  const recipient = overrides.withRecipientAuthority
    ?? withTaskDeliveryRecipientAuthority;
  const bound = overrides.withBoundAuthority ?? withCurrentTaskRuntimeAuthority;
  const accepted = overrides.withAcceptedAuthority
    ?? withCurrentAcceptedTaskRuntimeClaimAuthority;
  const validate = overrides.validateCurrentIntent
    ?? validateCurrentProtectedTaskTerminalMessageIntent;
  const now = overrides.now ?? Date.now;

  async function prepare(input: Coordinates) {
    const intent = Object.freeze({
      ...input.intent,
      terminalAt: new Date(input.intent.terminalAt),
      attachedAt: new Date(input.intent.attachedAt),
    });
    const subject = Object.freeze({ ...input.subject });
    if (subject.userId !== intent.requesterUserId
      || subject.humanActorId.length === 0 || subject.deviceId.length === 0
      || intent.resultRevision !== 2
      || intent.representation !== "protected" && intent.representation !== "dual"
      || !Number.isFinite(intent.terminalAt.getTime())
      || !Number.isFinite(intent.attachedAt.getTime())
      || !Number.isSafeInteger(input.publicationPolicyRevision)
      || input.publicationPolicyRevision < intent.acceptedPolicyRevision) {
      return null;
    }
    const [human, room] = await Promise.all([
      resolveHuman(subject.userId),
      resolveRoom(subject.userId, intent.agentId, intent.contentNamespaceId),
    ]);
    if (human === null || room === null || human.id !== subject.humanActorId
      || room.namespaceId !== intent.contentNamespaceId) return null;
    const product = await context(subject.userId, db);
    return {
      intent, publicationPolicyRevision: input.publicationPolicyRevision,
      subject, room, runner: product.canonicalRunner,
      restricted: input.restricted ?? restricted(), crypto, serverScope,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }

  const currentIntent = async (
    current: NonNullable<Awaited<ReturnType<typeof prepare>>>,
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
  ): Promise<boolean> => await validate({
    transaction,
    intent: current.intent,
  }) && await exactPrivateRoom(
    product, current.room.roomId, current.intent, current.subject,
  );

  return {
    async withDiscovery(input) {
      const current = await prepare(input);
      if (current === null) return null;
      const coordinates = {
        ...current,
        taskId: current.intent.taskId,
        requesterUserId: current.subject.userId,
        requesterHumanId: current.subject.humanActorId,
        agentId: current.intent.agentId,
        contentNamespaceId: current.intent.contentNamespaceId,
        sourceRoomId: current.room.roomId,
        destinationRoomId: current.intent.destinationRoomId,
        destinationNamespaceId: current.intent.destinationNamespaceId,
        expectedPolicyRevision: current.publicationPolicyRevision,
        validateCurrentTaskRun: (
          product: PostgresJsBridgeConnection,
          transaction: CanonicalTranscriptTx,
        ) => currentIntent(current, product, transaction),
      };
      const planning = await inspect(coordinates);
      const fact = planning?.facts[0];
      if (planning === null || planning.facts.length !== 1
        || fact === undefined
        || fact.namespaceId !== current.intent.destinationNamespaceId
        || fact.expectedPolicyRevision !== current.publicationPolicyRevision) {
        return null;
      }
      return recipient({
        ...coordinates,
        deviceId: current.subject.deviceId,
        namespaceRequirements: [{
          ordinal: 0, namespaceId: fact.namespaceId,
          domainId: fact.domainId, operations: ["encrypt"],
          expectedAccessRevision: fact.expectedAccessRevision,
          expectedPolicyRevision: fact.expectedPolicyRevision,
        }],
        domainRequirements: [{
          ordinal: 0, domainId: fact.domainId,
          expectedEpoch: fact.expectedDomainEpoch,
          expectedAuthorizationRevision: fact.expectedAuthorizationRevision,
        }],
        ...(input.validateBeforeCommit === undefined
          ? {} : { validateBeforeCommit: input.validateBeforeCommit }),
        use: (authority, scoped, product, transaction) => input.use(
          Object.freeze({ ...authority, restricted: scoped }),
          product,
          transaction,
        ),
      });
    },

    async withBound(input) {
      const bytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        input.request,
      );
      const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(bytes);
      bytes.fill(0);
      if (request === null) return null;
      const admission = Object.freeze({
        ...input.admission,
        headDigest: input.admission.headDigest.slice(),
      });
      const namespaceRequirements = copyNamespaces(input.namespaceRequirements);
      const domainRequirements = input.domainRequirements.map(value =>
        Object.freeze({ ...value }));
      try {
        if (request.workKind !== "task.deliver_message"
          || request.workPurpose !== "task.deliver_message"
          || request.workId !== input.intent.taskRunId
          || !exactRequirements(input.intent, input.publicationPolicyRevision,
            namespaceRequirements, domainRequirements)) return null;
        const current = await prepare(input);
        if (current === null
          || request.sourceRoomId !== current.intent.destinationRoomId) {
          return null;
        }
        return await bound({
          ...current, request, admission,
          namespaceRequirements, domainRequirements, now,
          validateCurrentProduct: (product, transaction) =>
            currentIntent(current, product, transaction),
          use: async (authority, product, scoped) => {
            if (!await exactDestinationAgent(product, current.intent)) {
              return null;
            }
            return input.use(authority, product, scoped);
          },
        });
      } finally {
        admission.headDigest.fill(0);
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
      }
    },

    async withAccepted(input) {
      const record = Object.freeze({
        ...input.accepted,
        descriptorBytes: input.accepted.descriptorBytes.slice(),
        authorizationBytes: input.accepted.authorizationBytes.slice(),
        issuerSigningPublicKeyHash:
          input.accepted.issuerSigningPublicKeyHash.slice(),
        namespaceRequirements: copyNamespaces(
          input.accepted.namespaceRequirements),
        domainRequirements: input.accepted.domainRequirements.map(value =>
          Object.freeze({ ...value })),
      });
      try {
        if (record.workKind !== "task.deliver_message"
          || record.workPurpose !== "task.deliver_message"
          || record.workId !== input.intent.taskRunId
          || record.expectedPolicyRevision !== input.publicationPolicyRevision
          || !exactRequirements(input.intent, input.publicationPolicyRevision,
            record.namespaceRequirements, record.domainRequirements)
          || typeof input.validateBeforeCommit !== "function") return null;
        const current = await prepare(input);
        if (current === null) return null;
        return await accepted({
          ...current, accepted: record, now,
          validateCurrentProduct: (product, transaction) =>
            currentIntent(current, product, transaction),
          validateBeforeCommit: input.validateBeforeCommit,
          use: async (authority, product, scoped, transaction) => {
            if (authority.plan.roomId !== current.intent.destinationRoomId) {
              return null;
            }
            if (!await exactDestinationAgent(product, current.intent)) {
              return null;
            }
            await input.validateBeforeCommit();
            return input.use(authority, product, scoped, transaction);
          },
        });
      } finally {
        record.descriptorBytes.fill(0);
        record.authorizationBytes.fill(0);
        record.issuerSigningPublicKeyHash.fill(0);
      }
    },
  };
}
