import {
  actors,
  and,
  deriveProtectedTaskDeliveryGraphThreadId,
  eq,
  roomMembers,
  rooms,
  sessions,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  PostgresNamespaceProductAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  isScopeMemoryEnvelope,
  type CanonicalTranscriptTx,
  type PolicyResolver,
} from "@nautilo/trust";
import { createHumanProductTransactionContext } from
  "./human-message-product-store";
import type {
  ProtectedTaskOutputReadIntent,
} from "./protected-task-output-read-product";
import type {
  ProtectedTaskWakeForegroundAdmission,
  ProtectedTaskWakeForegroundInventory,
} from "./protected-task-output-read-authority";

type Subject = Readonly<{ userId: string; humanActorId: string }>;
type NamespaceAuthority = Pick<PostgresNamespaceProductAuthority,
  "withCurrentReadableNamespaceSet">;

export type ProtectedTaskWakeForegroundAdmissionDependencies = Readonly<{
  createProductContext: typeof createHumanProductTransactionContext;
  createNamespaceAuthority(product: PostgresJsBridgeConnection): NamespaceAuthority;
}>;

const dependencies: ProtectedTaskWakeForegroundAdmissionDependencies =
  Object.freeze({
    createProductContext: createHumanProductTransactionContext,
    createNamespaceAuthority: product =>
      new PostgresNamespaceProductAuthority(product),
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function inTransaction(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: executor.query.bind(executor),
    transaction: use => use(executor),
    transactionOnce: use => use(executor),
  };
}

function canonicalNamespaceIds(values: readonly string[]): readonly string[] | null {
  if (values.length === 0
    || values.some(value => !UUID.test(value))) return null;
  return Object.freeze([...new Set(values)].sort());
}

function exactExpectedNamespaceIds(
  values: readonly string[],
): readonly string[] | null {
  if (values.length === 0
    || values.some((value, index) => !UUID.test(value)
      || index > 0 && values[index - 1]! >= value)) return null;
  return Object.freeze([...values]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validWakeInput(
  intent: ProtectedTaskOutputReadIntent,
  subject: Subject,
): boolean {
  return intent.invocation.kind === "wake"
    && intent.requesterUserId === subject.userId
    && intent.requesterHumanId === subject.humanActorId
    && UUID.test(subject.userId) && UUID.test(subject.humanActorId)
    && UUID.test(intent.agentId) && UUID.test(intent.invocation.roomId)
    && UUID.test(intent.invocation.sessionId);
}

async function readRoomCoordinate(
  transaction: CanonicalTranscriptTx,
  roomId: string,
): Promise<Readonly<{
  roomId: string;
  namespaceId: string;
  topLevelRoomId: string;
}> | null> {
  const rows = await transaction.select({
    id: rooms.id,
    namespaceId: rooms.namespaceId,
    parentRoomId: rooms.parentRoomId,
  }).from(rooms).where(eq(rooms.id, roomId)).limit(2);
  const room = rows[0];
  if (rows.length !== 1 || room === undefined
    || room.id !== roomId || !UUID.test(room.namespaceId)
    || (room.parentRoomId !== null && !UUID.test(room.parentRoomId))) return null;
  return Object.freeze({
    roomId,
    namespaceId: room.namespaceId,
    topLevelRoomId: room.parentRoomId ?? room.id,
  });
}

async function resolveOrdinaryForegroundNamespaces(input: Readonly<{
  resolver: PolicyResolver;
  intent: ProtectedTaskOutputReadIntent;
  subject: Subject;
  topLevelRoomId: string;
  destinationNamespaceId: string;
}>): Promise<readonly string[] | null> {
  let envelope: Awaited<ReturnType<PolicyResolver["buildEnvelope"]>>;
  try {
    envelope = await input.resolver.buildEnvelope(
      input.subject.humanActorId,
      `room:${input.topLevelRoomId}`,
      input.intent.agentId,
      input.topLevelRoomId,
    );
  } catch {
    return null;
  }
  if (isScopeMemoryEnvelope(envelope)
    || envelope.ownerId !== input.subject.userId
    || envelope.actorId !== input.subject.humanActorId
    || envelope.agentId !== input.intent.agentId
    || envelope.roomId !== input.topLevelRoomId) return null;
  const namespaceIds = canonicalNamespaceIds(envelope.readableNamespaces);
  return namespaceIds !== null
      && namespaceIds.includes(input.destinationNamespaceId)
    ? namespaceIds : null;
}

async function validateExactDestination(input: Readonly<{
  transaction: CanonicalTranscriptTx;
  intent: ProtectedTaskOutputReadIntent;
  subject: Subject;
  coordinate: Readonly<{
    roomId: string;
    namespaceId: string;
    topLevelRoomId: string;
  }>;
}>): Promise<boolean> {
  const { transaction, intent, subject, coordinate } = input;
  const roomRows = await transaction.select({
    id: rooms.id,
    ownerId: rooms.ownerId,
    namespaceId: rooms.namespaceId,
    parentRoomId: rooms.parentRoomId,
    kind: rooms.kind,
    archivedAt: rooms.archivedAt,
    graphThreadId: rooms.graphThreadId,
  }).from(rooms).where(eq(rooms.id, coordinate.roomId)).limit(2);
  const room = roomRows[0];
  if (roomRows.length !== 1 || room === undefined
    || room.id !== coordinate.roomId
    || room.namespaceId !== coordinate.namespaceId
    || room.archivedAt !== null
    || (room.parentRoomId === null
      ? room.id !== coordinate.topLevelRoomId
      : room.kind !== "subthread"
        || room.parentRoomId !== coordinate.topLevelRoomId)) return false;

  const members = await transaction.select({
    actorId: actors.id,
    kind: actors.kind,
    ownerId: actors.ownerId,
    agentId: actors.agentId,
  }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, coordinate.roomId))
    .orderBy(actors.id).for("share", { of: actors });
  if (members.filter(member => member.kind === "user"
      && member.actorId === subject.humanActorId
      && member.ownerId === subject.userId).length !== 1
    || !members.some(member => member.kind === "user"
      && member.ownerId === room.ownerId)
    || members.filter(member => member.kind === "agent"
      && member.agentId === intent.agentId).length !== 1) return false;

  const graphThreadId = deriveProtectedTaskDeliveryGraphThreadId({
    roomId: room.id,
    roomGraphThreadId: room.graphThreadId,
    targetAgentId: intent.agentId,
    members: members.map(member => ({
      actorKind: member.kind,
      actorOwnerId: member.ownerId,
      actorAgentId: member.agentId,
    })),
  });
  if (graphThreadId === null) return false;
  const sessionRows = await transaction.select({
    id: sessions.id,
    ownerId: sessions.ownerId,
    agentId: sessions.agentId,
    roomId: sessions.roomId,
    threadId: sessions.threadId,
    personaId: sessions.personaId,
  }).from(sessions).where(and(
    eq(sessions.id, intent.invocation.sessionId),
    eq(sessions.ownerId, room.ownerId),
    eq(sessions.threadId, graphThreadId),
  )).limit(2).for("share");
  const session = sessionRows[0];
  return sessionRows.length === 1 && session !== undefined
    && session.id === intent.invocation.sessionId
    && session.ownerId === room.ownerId
    && session.agentId === intent.agentId
    && session.roomId === room.id
    && session.threadId === graphThreadId
    && session.personaId === "owner";
}

async function readHeldInventory(input: Readonly<{
  product: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
  intent: ProtectedTaskOutputReadIntent;
  subject: Subject;
  expectedCoordinate?: Readonly<{
    roomId: string;
    namespaceId: string;
    topLevelRoomId: string;
  }>;
  expectedNamespaceIds: readonly string[];
  retainedNamespaceIds?: readonly string[];
  createNamespaceAuthority(product: PostgresJsBridgeConnection): NamespaceAuthority;
}>): Promise<ProtectedTaskWakeForegroundInventory | null> {
  const { intent, subject, transaction } = input;
  if (!validWakeInput(intent, subject)) return null;
  const expectedNamespaceIds = exactExpectedNamespaceIds(
    input.expectedNamespaceIds,
  );
  if (expectedNamespaceIds === null) return null;
  const coordinate = await readRoomCoordinate(transaction, intent.invocation.roomId);
  if (coordinate === null
    || input.expectedCoordinate !== undefined && (
      coordinate.roomId !== input.expectedCoordinate.roomId
      || coordinate.namespaceId !== input.expectedCoordinate.namespaceId
      || coordinate.topLevelRoomId !== input.expectedCoordinate.topLevelRoomId
    )) return null;
  const restriction = intent.continuation?.retainedSourceNamespaceIds ?? input.retainedNamespaceIds;
  const namespaceIds = restriction === undefined
    ? expectedNamespaceIds : exactExpectedNamespaceIds(restriction);
  if (namespaceIds === null || !namespaceIds.includes(coordinate.namespaceId)
    || !sameIds(namespaceIds, expectedNamespaceIds)) return null;
  return input.createNamespaceAuthority(input.product)
    .withCurrentReadableNamespaceSet({
      subjectUserId: subject.userId,
      subjectHumanId: subject.humanActorId,
      sourceRoomId: coordinate.topLevelRoomId,
      namespaceIds,
      destinationRoom: {
        roomId: coordinate.roomId,
        namespaceId: coordinate.namespaceId,
      },
      use: async entries => {
        const heldIds = entries.map(entry => entry.namespaceId);
        if (!sameIds(heldIds, namespaceIds)
          || !await validateExactDestination({
            transaction,
            intent,
            subject,
            coordinate,
          })) return null;
        return Object.freeze({ namespaceIds: Object.freeze([...heldIds]) });
      },
    });
}

/** Fresh current foreground Namespace admission for one protected Task wake. */
export function createProtectedTaskWakeForegroundAdmission(
  input: Readonly<{ db: DirectDatabase; resolver: PolicyResolver }>,
  overrides: Partial<ProtectedTaskWakeForegroundAdmissionDependencies> = {},
): ProtectedTaskWakeForegroundAdmission {
  const deps = Object.freeze({ ...dependencies, ...overrides });
  return Object.freeze({
    async discover(operation) {
      if (!validWakeInput(operation.intent, operation.subject)) return null;
      const context = await deps.createProductContext(
        operation.subject.userId,
        input.db,
      );
      const coordinate = await context.canonicalRunner.transaction(
        transaction => readRoomCoordinate(
          transaction,
          operation.intent.invocation.roomId,
        ),
        { isolationLevel: "read committed" },
      );
      if (coordinate === null) return null;
      const canonicalIds = await resolveOrdinaryForegroundNamespaces({
        resolver: input.resolver,
        intent: operation.intent,
        subject: operation.subject,
        topLevelRoomId: coordinate.topLevelRoomId,
        destinationNamespaceId: coordinate.namespaceId,
      });
      if (canonicalIds === null) return null;
      const restriction = operation.intent.continuation
        ?.retainedSourceNamespaceIds;
      const namespaceIds = restriction === undefined
        ? canonicalIds : exactExpectedNamespaceIds(restriction);
      if (namespaceIds === null
        || !namespaceIds.includes(coordinate.namespaceId)
        || namespaceIds.some(id => !canonicalIds.includes(id))) return null;
      return context.canonicalRunner.transaction(
        (transaction, executor) => readHeldInventory({
          ...operation,
          product: inTransaction(executor),
          transaction,
          expectedCoordinate: coordinate,
          expectedNamespaceIds: namespaceIds,
          createNamespaceAuthority: deps.createNamespaceAuthority,
        }),
        { isolationLevel: "read committed" },
      );
    },
    readCurrent(operation) {
      return readHeldInventory({
        ...operation,
        createNamespaceAuthority: deps.createNamespaceAuthority,
      });
    },
  });
}
