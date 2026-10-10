import { ensureSession } from "@nautilo/agent";
import { eq, rooms, sessions } from "@nautilo/db";
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
  namespaceId: string;
}>;

type Dependencies = Readonly<{
  ensureSession: typeof ensureSession;
  loadSessionFacts(
    runner: ConversationProductCanonicalTransactionRunner,
    expected: Readonly<{
      sessionId: string;
      graphThreadId: string;
      ownerId: string;
      agentId: string;
      roomId: string;
    }>,
  ): Promise<SessionFacts | null>;
  validateProductAuthority(
    runner: ConversationProductCanonicalTransactionRunner,
    authority: ProtectedTaskMessageProductAuthority,
    now: () => number,
  ): Promise<void>;
  withNamespaceSource: typeof withNativeTaskNamespaceSource;
  createPublication: typeof createProtectedTaskNativeMessagePublication;
  verifyCryptoHandle: typeof verifyCryptoPostgresHandle;
  createSignerHistory(
    input: ConstructorParameters<typeof PostgresHumanDeviceSignerHistory>[0],
  ): PostgresHumanDeviceSignerHistory;
}>;

async function loadSessionFacts(
  runner: ConversationProductCanonicalTransactionRunner,
  expected: Readonly<{
    sessionId: string;
    graphThreadId: string;
    ownerId: string;
    agentId: string;
    roomId: string;
  }>,
): Promise<SessionFacts | null> {
  return runner.transaction(async tx => {
    const [session] = await tx.select({
      id: sessions.id,
      threadId: sessions.threadId,
      ownerId: sessions.ownerId,
      agentId: sessions.agentId,
      roomId: sessions.roomId,
    }).from(sessions).where(eq(sessions.id, expected.sessionId))
      .limit(2).for("share");
    const [room] = await tx.select({
      id: rooms.id,
      namespaceId: rooms.namespaceId,
    }).from(rooms).where(eq(rooms.id, expected.roomId))
      .limit(2).for("share");
    if (session === undefined || room === undefined
      || session.id !== expected.sessionId
      || session.threadId !== expected.graphThreadId
      || session.ownerId !== expected.ownerId
      || session.agentId !== expected.agentId
      || session.roomId !== expected.roomId
      || room.id !== expected.roomId) return null;
    return Object.freeze({
      sessionId: session.id,
      namespaceId: room.namespaceId,
    });
  }, { isolationLevel: "read committed" });
}

async function validateProductAuthority(
  runner: ConversationProductCanonicalTransactionRunner,
  authority: ProtectedTaskMessageProductAuthority,
  now: () => number,
): Promise<void> {
  const guard = createProtectedTaskMessageProductGuard(authority, now);
  await runner.transaction(tx => guard.assertPublicationAllowed(tx, {
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
  }), { isolationLevel: "read committed" });
}

const productionDependencies: Dependencies = Object.freeze({
  ensureSession,
  loadSessionFacts,
  validateProductAuthority,
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
  return Object.freeze({
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    jobId: input.current.jobId,
    taskOwnerId: occurrence.task.ownerId,
    graphThreadId: occurrence.run.graphThreadId,
    sessionId: session.sessionId,
    sessionOwnerId: occurrence.task.ownerId,
    roomId: input.current.executionRoomId,
    namespaceId: session.namespaceId,
    contentNamespaceId: occurrence.task.contentNamespaceId,
    contentRevision: occurrence.task.contentRevision,
    requiredNamespaceFingerprint:
      occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
    agentId: occurrence.task.agentId,
    requestorId: occurrence.task.requestorId,
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
    representation: occurrence.task.contentRepresentation,
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
    const sessionId = await dependencies.ensureSession({
      threadId: occurrence.run.graphThreadId,
      ownerId: occurrence.task.ownerId,
      personaId: "owner",
      agentId: occurrence.task.agentId,
      roomId: current.executionRoomId,
      title: "Task transcript",
    });
    await segment.assertCurrentTaskAuthority();
    signal.throwIfAborted();
    const session = await dependencies.loadSessionFacts(current.runner, {
      sessionId,
      graphThreadId: occurrence.run.graphThreadId,
      ownerId: occurrence.task.ownerId,
      agentId: occurrence.task.agentId,
      roomId: current.executionRoomId,
    });
    if (session === null) {
      throw new TypeError("Protected Task transcript Session is unavailable");
    }
    const authority = productAuthority(segment, session);
    await dependencies.validateProductAuthority(
      current.runner,
      authority,
      current.now,
    );
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
