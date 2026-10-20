import {
  acquireEncryptionConsumptionFence,
  and,
  eq,
  protectedTaskDefinitionSupportsPolicy,
  rooms,
  sessions,
  tasks,
} from "@nautilo/db";
import {
  PostgresHumanDeviceSignerHistory,
  verifyCryptoPostgresHandle,
  withNativeTaskNamespaceSource,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";

import {
  createProtectedTaskMessageProductGuard,
  type ProtectedTaskMessageProductAuthority,
} from "./protected-task-message-product-authority";
import {
  createProtectedTaskNativeMessagePublication,
} from "./protected-task-native-message-publication";
import type {
  ProtectedTaskNativeFixedMemorySegmentInput,
} from "./protected-task-native-fixed-memory-segment";

type ProductContext = Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
}>;

type CreateTranscriptPublisher =
  ProtectedTaskNativeFixedMemorySegmentInput["createTranscriptPublisher"];
type CreateTranscriptPublisherInput = Parameters<CreateTranscriptPublisher>[0];

type SessionFacts = Readonly<{
  sessionId: string;
  ownerId: string;
  roomId: string;
  namespaceId: string;
}>;

type AdmittedTranscript = Readonly<{
  session: SessionFacts;
  authority: ProtectedTaskMessageProductAuthority;
}>;

type ExecutionRoomFacts = Readonly<{
  id: string;
  ownerId: string;
  namespaceId: string;
  type: string;
  kind: string;
  parentRoomId: string | null;
  humanActorIds: readonly string[];
  archivedAt: Date | null;
}>;

function isAdmittedExecutionRoom(
  room: ExecutionRoomFacts,
  expected: Readonly<{ roomId: string; ownerId: string }>,
): boolean {
  return room.id === expected.roomId
    && room.archivedAt === null
    && (room.kind !== "task" || (
      room.ownerId === expected.ownerId
      && room.type === "private"
      && room.humanActorIds.length === 0
    ));
}

function sameExecutionRoom(
  left: ExecutionRoomFacts,
  right: ExecutionRoomFacts,
): boolean {
  return left.id === right.id
    && left.ownerId === right.ownerId
    && left.namespaceId === right.namespaceId
    && left.type === right.type
    && left.kind === right.kind
    && left.parentRoomId === right.parentRoomId
    && left.archivedAt?.getTime() === right.archivedAt?.getTime()
    && left.humanActorIds.length === right.humanActorIds.length
    && left.humanActorIds.every((id, index) => id === right.humanActorIds[index]);
}

function unavailableSession(): never {
  throw new TypeError("Protected Task transcript Session is unavailable");
}

type Dependencies = Readonly<{
  admitTranscript(
    runner: ConversationProductCanonicalTransactionRunner,
    input: CreateTranscriptPublisherInput,
    now: () => number,
  ): Promise<AdmittedTranscript | null>;
  withNamespaceSource: typeof withNativeTaskNamespaceSource;
  createPublication: typeof createProtectedTaskNativeMessagePublication;
  verifyCryptoHandle: typeof verifyCryptoPostgresHandle;
  createSignerHistory(
    input: ConstructorParameters<typeof PostgresHumanDeviceSignerHistory>[0],
  ): PostgresHumanDeviceSignerHistory;
}>;

async function admitTranscript(
  runner: ConversationProductCanonicalTransactionRunner,
  input: CreateTranscriptPublisherInput,
  now: () => number,
): Promise<AdmittedTranscript | null> {
  const occurrence = input.occurrence;
  const expected = Object.freeze({
    graphThreadId: occurrence.run.graphThreadId,
    taskOwnerId: occurrence.task.ownerId,
    requestorId: occurrence.task.requestorId,
    requesterHumanId: input.current.subject.humanActorId,
    agentId: occurrence.task.agentId,
    executionRoomId: input.current.executionRoomId,
    sourceRoomId: input.request.sourceRoomId,
    contentNamespaceId: occurrence.task.contentNamespaceId,
  });
  return runner.transaction(async tx => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== input.policy.mode
      || policy.revision !== input.policy.revision) {
      throw new TypeError("Protected Task transcript policy changed");
    }
    const [task] = await tx.select({ id: tasks.id }).from(tasks)
      .where(eq(tasks.id, occurrence.task.id)).limit(1).for("share");
    if (task === undefined) return null;
    const selectRoom = (roomId: string) => tx.select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      namespaceId: rooms.namespaceId,
      type: rooms.type,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      humanActorIds: rooms.humanActorIds,
      archivedAt: rooms.archivedAt,
    }).from(rooms).where(eq(rooms.id, roomId))
      .limit(2);
    const executionRoomRows = await selectRoom(expected.executionRoomId);
    const executionRoom = executionRoomRows[0];
    if (executionRoomRows.length !== 1 || executionRoom === undefined
      || !isAdmittedExecutionRoom(executionRoom, {
        roomId: expected.executionRoomId,
        ownerId: expected.taskOwnerId,
      })) return null;
    const hidden = executionRoom.kind === "task";
    const roomRows = hidden
      ? await selectRoom(expected.sourceRoomId)
      : executionRoomRows;
    const room = roomRows[0];
    if (roomRows.length !== 1 || room === undefined
      || room.archivedAt !== null
      || (hidden && (
        room.id !== expected.sourceRoomId
        || room.ownerId !== expected.requestorId
        || room.namespaceId !== expected.contentNamespaceId
        || room.type !== "private"
        || room.kind !== "private"
        || room.parentRoomId !== null
        || room.humanActorIds.length !== 1
        || room.humanActorIds[0] !== expected.requesterHumanId
      ))) return null;

    const selectSession = () => tx.select({
      id: sessions.id,
      threadId: sessions.threadId,
      ownerId: sessions.ownerId,
      personaId: sessions.personaId,
      agentId: sessions.agentId,
      roomId: sessions.roomId,
    }).from(sessions).where(and(
      eq(sessions.ownerId, expected.taskOwnerId),
      eq(sessions.threadId, expected.graphThreadId),
    )).limit(2);
    let sessionRows = await selectSession();
    let session = sessionRows[0];
    if (sessionRows.length > 1) return null;
    let insertedSession = false;
    if (session === undefined) {
      await tx.insert(sessions).values({
        threadId: expected.graphThreadId,
        ownerId: expected.taskOwnerId,
        personaId: "owner",
        agentId: expected.agentId,
        roomId: room.id,
        title: "Task transcript",
      }).onConflictDoNothing({
        target: [sessions.ownerId, sessions.threadId],
      });
      insertedSession = true;
      sessionRows = await selectSession();
      session = sessionRows[0];
    }
    if (sessionRows.length !== 1 || session === undefined
      || session.threadId !== expected.graphThreadId
      || session.ownerId !== expected.taskOwnerId
      || session.personaId !== "owner"
      || session.agentId !== expected.agentId
      || session.roomId !== room.id) {
      if (insertedSession) unavailableSession();
      return null;
    }
    const facts = Object.freeze({
      sessionId: session.id,
      ownerId: session.ownerId,
      roomId: session.roomId,
      namespaceId: room.namespaceId,
    });
    const authority = productAuthority(input, facts);
    const guard = createProtectedTaskMessageProductGuard(authority, now);
    await guard.assertPublicationAllowed(tx, {
      action: "appendAllocated",
      sessionId: authority.sessionId,
      messageId: 0,
      revision: 0,
      idempotencyKey:
        `task-transcript:${authority.taskRunId}:fp:v1:preflight`,
      authorRole: "assistant",
      keyClass: "ai",
      publicationPolicy: {
        expectedRevision: authority.policyRevision,
        representation: authority.representation === "dual"
          ? "ordinary_and_protected"
          : "protected_only",
      },
    });
    const finalExecutionRoomRows = await selectRoom(expected.executionRoomId);
    const finalExecutionRoom = finalExecutionRoomRows[0];
    const finalRoomRows = hidden
      ? await selectRoom(expected.sourceRoomId)
      : finalExecutionRoomRows;
    const finalRoom = finalRoomRows[0];
    const finalSessionRows = await selectSession();
    const finalSession = finalSessionRows[0];
    if (finalExecutionRoomRows.length !== 1
      || finalExecutionRoom === undefined
      || !isAdmittedExecutionRoom(finalExecutionRoom, {
        roomId: expected.executionRoomId,
        ownerId: expected.taskOwnerId,
      })
      || !sameExecutionRoom(executionRoom, finalExecutionRoom)
      || finalRoomRows.length !== 1 || finalRoom === undefined
      || finalRoom.id !== room.id
      || finalRoom.archivedAt !== null
      || !sameExecutionRoom(room, finalRoom)
      || finalRoom.namespaceId !== facts.namespaceId
      || finalSessionRows.length !== 1 || finalSession === undefined
      || finalSession.id !== facts.sessionId
      || finalSession.threadId !== expected.graphThreadId
      || finalSession.ownerId !== expected.taskOwnerId
      || finalSession.personaId !== "owner"
      || finalSession.agentId !== expected.agentId
      || finalSession.roomId !== room.id) unavailableSession();
    return Object.freeze({ session: facts, authority });
  }, { isolationLevel: "read committed" });
}

const productionDependencies: Dependencies = Object.freeze({
  admitTranscript,
  withNamespaceSource: withNativeTaskNamespaceSource,
  createPublication: createProtectedTaskNativeMessagePublication,
  verifyCryptoHandle: verifyCryptoPostgresHandle,
  createSignerHistory: input => new PostgresHumanDeviceSignerHistory(input),
});

function productAuthority(
  input: CreateTranscriptPublisherInput,
  session: SessionFacts,
): ProtectedTaskMessageProductAuthority {
  const occurrence = input.occurrence;
  const reference = input.current.reference;
  const signal = input.current.signal;
  if (!protectedTaskDefinitionSupportsPolicy(occurrence.task.contentRepresentation, input.policy.mode)
    || input.policy.revision !== input.current.evidence.policyRevision) {
    throw new TypeError("Protected Task transcript policy changed");
  }
  return Object.freeze({
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    jobId: input.current.jobId,
    taskOwnerId: occurrence.task.ownerId,
    graphThreadId: occurrence.run.graphThreadId,
    sessionId: session.sessionId,
    sessionOwnerId: session.ownerId,
    executionRoomId: input.current.executionRoomId,
    roomId: session.roomId,
    namespaceId: session.namespaceId,
    contentNamespaceId: occurrence.task.contentNamespaceId,
    contentRevision: occurrence.task.contentRevision,
    requiredNamespaceFingerprint:
      occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
    agentId: occurrence.task.agentId,
    requestorId: occurrence.task.requestorId,
    requesterHumanId: input.current.subject.humanActorId,
    inputObjectId: reference.inputObjectId,
    resultObjectId: reference.resultObjectId,
    authorizationRequestId: reference.authorizationRequestId,
    executionSegment: reference.executionSegment,
    ...(Object.hasOwn(reference, "resumeAcceptanceId")
      ? { resumeAcceptanceId: reference.resumeAcceptanceId }
      : {}),
    ...(Object.hasOwn(reference, "resumeContinuationFingerprint")
      ? {
          resumeContinuationFingerprint:
            reference.resumeContinuationFingerprint,
        }
      : {}),
    policyRevision: input.current.evidence.policyRevision,
    definitionRepresentation: occurrence.task.contentRepresentation,
    representation: input.policy.mode === "shadow_encryption" ? "dual" : "protected",
    authorizationExpiresAt: input.current.evidence.expiresAt,
    signal,
  });
}

/** Build the production per-segment transcript publisher factory. */
export function createProtectedTaskNativeTranscriptPublisher(
  input: Readonly<{ product: ProductContext }>,
  overrides: Partial<Dependencies> = {},
): CreateTranscriptPublisher {
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  if (input.product.handle.role !== "nautilo") {
    throw new TypeError("Protected Task transcript product role is unavailable");
  }
  const product = Object.freeze({ ...input.product });
  return async segment => {
    const current = segment.current;
    const occurrence = segment.occurrence;
    const signal = current.signal;
    if (product.canonicalRunner !== current.runner
      || occurrence.run.jobId !== current.jobId
      || occurrence.task.id !== current.reference.taskId
      || occurrence.run.id !== current.reference.taskRunId
      || occurrence.task.cryptoObjectId !== current.reference.inputObjectId
      || current.evidence.result.objectId !== current.reference.resultObjectId
      || current.evidence.requestId
        !== current.reference.authorizationRequestId
      || current.evidence.policyRevision !== current.reference.policyRevision
      || current.evidence.expiresAt <= current.now()
      || segment.humanTurnId.length === 0) {
      throw new TypeError("Protected Task transcript identity is unavailable");
    }
    await segment.assertCurrentTaskAuthority();
    signal.throwIfAborted();
    const admitted = await dependencies.admitTranscript(
      current.runner,
      segment,
      current.now,
    );
    if (admitted === null) {
      throw new TypeError("Protected Task transcript Session is unavailable");
    }
    const { session, authority } = admitted;
    await segment.assertCurrentTaskAuthority();
    signal.throwIfAborted();
    const cryptoHandle = await dependencies.verifyCryptoHandle(
      current.restricted,
    );
    const signerHistory = dependencies.createSignerHistory({
      handle: cryptoHandle,
      crypto: current.crypto,
    });

    return request => dependencies.withNamespaceSource({
      restricted: current.restricted,
      crypto: current.crypto,
      serverScope: current.serverScope,
      evidence: current.evidence,
      domains: segment.domains,
      namespaceId: session.namespaceId,
      requiredOperations: ["decrypt", "encrypt"],
      signal,
      assertCurrentTaskAuthority: segment.assertCurrentTaskAuthority,
    }, async namespace => {
      const publish = dependencies.createPublication({
        authority: {
          occurrence,
          record: segment.record,
          request: segment.request,
          subject: current.subject,
          evidence: current.evidence,
          productAuthority: authority,
          runner: current.runner,
          restricted: current.restricted,
          crypto: current.crypto,
          serverScope: current.serverScope,
          now: current.now,
          signal,
        },
        humanTurnId: segment.humanTurnId,
        productHandle: product.handle,
        cryptoHandle,
        domains: segment.domains,
        preparation: {
          namespace,
          runtime: segment.signer.runtime,
          signerPublication: segment.signer.signerPublication,
          ...(segment.signer.temporarySigner === undefined ? {} : {
            temporarySigner: segment.signer.temporarySigner,
          }),
          agentAuthorizationRevision:
            segment.signer.agentAuthorizationRevision,
          resolveHistoricalSignerPublicationManager:
            segment.resolveHistoricalSignerPublicationManager,
        },
        resolveHistoricalAgentSignerAuthority:
          signerHistory.resolveAgentRuntimeSignerManager,
        hasCurrentGrant: async () => {
          try {
            await segment.assertCurrentTaskAuthority();
            return !signal.aborted;
          } catch {
            return false;
          }
        },
      });
      await publish(request);
    });
  };
}
