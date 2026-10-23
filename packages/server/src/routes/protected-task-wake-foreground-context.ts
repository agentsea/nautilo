import { createHash } from "node:crypto";
import type { ForegroundChatFundingSession } from "@nautilo/agent";
import {
  actors,
  agents,
  and,
  encryptionTransitionPolicy,
  eq,
  groupMembers,
  groupRoles,
  groups,
  profiles,
  protectedTaskRunOutputBindings,
  protectedTaskDefinitionSupportsPolicy,
  roomMembers,
  rooms,
  roles,
  sessions,
  taskRuns,
  tasks,
  users,
  type ProtectedTaskWakeScheduling,
} from "@nautilo/db";
import type { StrictShadowEnforcementPolicy } from "@nautilo/lattice-bridge";
import { createLiveShadowDataOperationPolicyBinding } from "@nautilo/runtime";
import {
  isScopeMemoryEnvelope,
  type CanonicalTranscriptTx,
  type MemoryAccessEnvelope,
  type PolicyResolver,
  type RoomParticipant,
} from "@nautilo/trust";

import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import {
  openProtectedTaskWakeFundingSession,
  type ProtectedTaskWakeFundingRunSource,
  type ProtectedTaskWakeFundingTaskSource,
} from "../lib/native-task-funding";
import type {
  ProtectedTaskWakeForegroundContext,
  ProtectedTaskWakeForegroundContextOwner,
  ProtectedTaskWakePublication,
} from "./protected-task-wake-foreground-publication";

type CurrentAssertion = () => Promise<void>;

export type ProtectedTaskWakeForegroundFactsOwner = <Value>(input: Readonly<{
  publication: ProtectedTaskWakePublication;
  scheduling: ProtectedTaskWakeScheduling;
  signal: AbortSignal;
  /**
   * `assertCurrent` is an operation-lifetime reprover. It must remain usable
   * after this transaction commits; it is not a borrowed-connection guard.
   */
  use(
    transaction: CanonicalTranscriptTx,
    assertCurrent: CurrentAssertion,
  ): Promise<Value>;
}>) => Promise<Value | null>;

export type ProtectedTaskWakeFundingOwner = (input: Readonly<{
  publication: ProtectedTaskWakePublication;
  scheduling: ProtectedTaskWakeScheduling;
  taskSource: ProtectedTaskWakeFundingTaskSource;
  runSource: ProtectedTaskWakeFundingRunSource;
  modelId: string | null;
  signal: AbortSignal;
  assertCurrent: CurrentAssertion;
}>) => Promise<ForegroundChatFundingSession | null>;

export type ProtectedTaskWakeForegroundContextDependencies = Readonly<{
  resolver: PolicyResolver;
  withCurrentFacts: ProtectedTaskWakeForegroundFactsOwner;
  openWakeFunding?: ProtectedTaskWakeFundingOwner;
  readPolicy?: () => Promise<StrictShadowEnforcementPolicy>;
}>;

type ContextSnapshot = Readonly<{
  actorRole: string;
  roomRoster: readonly RoomParticipant[];
  memoryAccessEnvelope: MemoryAccessEnvelope;
  subthread: Readonly<{ parentRoomId: string; anchorMessageId: number }> | null;
  resultMessagePublished: boolean;
  enforcementPolicy: StrictShadowEnforcementPolicy;
  assertCurrent: CurrentAssertion;
  taskSource: ProtectedTaskWakeFundingTaskSource;
  runSource: ProtectedTaskWakeFundingRunSource;
  envelopeRoomId: string;
}>; 

type ContextCoordinates = Readonly<{
  room: Readonly<{
    id: string;
    ownerId: string;
    namespaceId: string;
    graphThreadId: string;
  }>;
  envelopeRoomId: string;
  subthread: ContextSnapshot["subthread"];
}>;

const ROLE_RANK = Object.freeze(new Map<string, number>([
  ["owner", 0], ["admin", 1], ["superuser", 2], ["member", 3],
  ["contributor", 4], ["community", 5], ["guest", 6],
]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalIds(values: readonly string[]): readonly string[] | null {
  if (values.length === 0 || values.some(value => !UUID.test(value))) return null;
  return Object.freeze([...new Set(values)].sort());
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** Bind the exact retained source capability without storing its contents. */
export function protectedTaskWakeSourceEnvelopeDigest(
  envelope: MemoryAccessEnvelope,
): Uint8Array {
  if (isScopeMemoryEnvelope(envelope)) {
    throw new TypeError("Protected Task wake source must be namespace-backed");
  }
  return new Uint8Array(createHash("sha256").update(JSON.stringify([
    "nautilo/protected-task-wake-source-envelope/v1",
    envelope.ownerId, envelope.actorId, envelope.agentId, envelope.roomId,
    [...envelope.readableNamespaces].sort(),
    [...envelope.mutableNamespaces].sort(),
    [...envelope.writableNamespaces].sort(),
    Object.entries(envelope.toolPolicy).sort(([left], [right]) => left.localeCompare(right)),
  ])).digest());
}

function exactWakeNamespaces(input: Readonly<{
  publication: ProtectedTaskWakePublication;
  foregroundNamespaceIds: readonly string[];
}>): boolean {
  const { plan, wakeEvidence } = input.publication;
  const expectedIds = canonicalIds(input.foregroundNamespaceIds);
  const actualIds = canonicalIds(
    wakeEvidence.namespaceRequirements.map(namespace => namespace.namespaceId),
  );
  if (expectedIds === null || actualIds === null
    || actualIds.length !== wakeEvidence.namespaceRequirements.length
    || !sameIds(expectedIds, actualIds)) return false;
  return wakeEvidence.namespaceRequirements.every(namespace => {
    const expectedOperations = Object.freeze(["decrypt", "encrypt"] as const);
    return namespace.expectedPolicyRevision === plan.intent.expectedPolicyRevision
      && sameIds(namespace.operations, expectedOperations);
  });
}

function hasWakeFundingSource(run: ProtectedTaskWakeFundingRunSource): boolean {
  const freshCancelled = run.status === "cancelled"
    && run.jobId === null && run.modelId === null && run.fundingBinding === null
    && run.fundingPredecessorRunId === null;
  return freshCancelled || run.jobId !== null && run.modelId !== null
    && run.fundingBinding !== null;
}

function highestRole(values: readonly string[]): string {
  let selected = "guest";
  let rank = ROLE_RANK.get(selected)!;
  for (const value of values) {
    const candidate = ROLE_RANK.get(value);
    if (candidate !== undefined && candidate < rank) {
      selected = value;
      rank = candidate;
    }
  }
  return selected;
}

function roster(rows: readonly Readonly<{
  actorId: string;
  kind: string;
  displayName: string;
  agentId: string | null;
  ownerId: string | null;
  userHandle: string | null;
  userDisplayName: string | null;
  agentHandle: string | null;
  agentAvatar: unknown;
  roomRole: string;
  agentResponseMode: string | null;
}>[]): readonly RoomParticipant[] | null {
  const result: RoomParticipant[] = [];
  for (const row of rows) {
    if (row.kind !== "user" && row.kind !== "agent"
      || row.roomRole !== "admin" && row.roomRole !== "member") return null;
    if (row.kind === "user") {
      if (row.ownerId === null || row.agentId !== null) return null;
      result.push(Object.freeze({ actorId: row.actorId, kind: "user" as const,
        displayName: row.displayName, handle: row.userHandle,
        userId: row.ownerId, roomRole: row.roomRole }));
      continue;
    }
    if (row.ownerId === null || row.agentId === null) return null;
    result.push(Object.freeze({ actorId: row.actorId, kind: "agent" as const,
      displayName: row.displayName, handle: row.agentHandle,
      agentId: row.agentId, roomRole: row.roomRole,
      agentOwnerUserId: row.ownerId,
      ...(row.userHandle === null ? {} : { agentOwnerHandle: row.userHandle }),
      ...(row.userDisplayName === null
        ? {} : { agentOwnerDisplayName: row.userDisplayName }),
      ...(row.agentAvatar == null ? {} : { agentAvatar: row.agentAvatar as never }),
      ...(row.agentResponseMode === null
        ? {} : { agentResponseMode: row.agentResponseMode as never }),
    }));
  }
  return Object.freeze(result);
}

async function snapshotCurrentCoordinates(input: Readonly<{
  publication: ProtectedTaskWakePublication;
  scheduling: ProtectedTaskWakeScheduling;
  transaction: CanonicalTranscriptTx;
}>): Promise<ContextCoordinates | null> {
  const { publication, scheduling, transaction } = input;
  const { plan, wakeEvidence } = publication;
  if (plan.intent.invocation.kind !== "wake"
    || plan.intent.requesterUserId !== scheduling.requestorId
    || plan.intent.requesterHumanId !== wakeEvidence.requesterHumanId
    || plan.intent.agentId !== scheduling.agentId
    || plan.intent.result.taskId !== scheduling.taskId
    || plan.intent.result.taskRunId !== scheduling.taskRunId
    || plan.intent.invocation.jobId !== scheduling.jobId
    || plan.intent.invocation.roomId !== scheduling.roomId
    || plan.intent.invocation.sessionId !== scheduling.sessionId
    || wakeEvidence.invocation.jobId !== scheduling.jobId
    || wakeEvidence.invocation.operationId !== plan.intent.invocation.operationId
    || wakeEvidence.policyRevision !== plan.intent.expectedPolicyRevision
    || scheduling.ownerId !== scheduling.requestorId
    || scheduling.laneKey !== `room:${scheduling.roomId}`) return null;

  const roomRows = await transaction.select({
    id: rooms.id,
    ownerId: rooms.ownerId,
    namespaceId: rooms.namespaceId,
    graphThreadId: rooms.graphThreadId,
    kind: rooms.kind,
    parentRoomId: rooms.parentRoomId,
    threadRootMessageId: rooms.threadRootMessageId,
    deletedThreadRootMessageId: rooms.deletedThreadRootMessageId,
    archivedAt: rooms.archivedAt,
  }).from(rooms).where(eq(rooms.id, scheduling.roomId)).limit(2);
  const room = roomRows[0];
  if (roomRows.length !== 1 || room === undefined
    || room.id !== scheduling.roomId || room.ownerId !== scheduling.sessionOwnerId
    || room.namespaceId !== scheduling.namespaceId || room.archivedAt !== null) return null;

  let envelopeRoomId = room.id;
  let subthread: ContextSnapshot["subthread"] = null;
  if (room.kind === "subthread") {
    const anchorMessageId = room.threadRootMessageId
      ?? room.deletedThreadRootMessageId;
    if (room.parentRoomId === null || anchorMessageId === null
      || !Number.isSafeInteger(anchorMessageId) || anchorMessageId < 1) return null;
    const parentRows = await transaction.select({
      id: rooms.id,
      archivedAt: rooms.archivedAt,
      parentRoomId: rooms.parentRoomId,
      kind: rooms.kind,
    }).from(rooms).where(eq(rooms.id, room.parentRoomId)).limit(2);
    const parent = parentRows[0];
    if (parentRows.length !== 1 || parent === undefined
      || parent.id !== room.parentRoomId || parent.archivedAt !== null
      || parent.kind === "subthread" || parent.parentRoomId !== null) return null;
    envelopeRoomId = parent.id;
    subthread = Object.freeze({ parentRoomId: parent.id, anchorMessageId });
  } else if (room.parentRoomId !== null
    || room.threadRootMessageId !== null
    || room.deletedThreadRootMessageId !== null) return null;

  return Object.freeze({
    room: Object.freeze({
      id: room.id,
      ownerId: room.ownerId,
      namespaceId: room.namespaceId,
      graphThreadId: room.graphThreadId,
    }),
    envelopeRoomId,
    subthread,
  });
}

function restrictCurrentEnvelope(input: Readonly<{
  publication: ProtectedTaskWakePublication;
  scheduling: ProtectedTaskWakeScheduling;
  envelopeRoomId: string;
  envelope: MemoryAccessEnvelope;
}>): MemoryAccessEnvelope | null {
  const { publication, scheduling, envelopeRoomId } = input;
  const { plan } = publication;
  let envelope = input.envelope;
  if (isScopeMemoryEnvelope(envelope)
    || envelope.ownerId !== scheduling.requestorId
    || envelope.actorId !== plan.intent.requesterHumanId
    || envelope.agentId !== scheduling.agentId
    || envelope.roomId !== envelopeRoomId) return null;
  const currentReadableIds = canonicalIds(envelope.readableNamespaces);
  const plannedNamespaceIds = canonicalIds(plan.foregroundNamespaceIds);
  const retained = plan.intent.continuation?.retainedSourceNamespaceIds;
  if (currentReadableIds === null || plannedNamespaceIds === null
    || plannedNamespaceIds.length !== plan.foregroundNamespaceIds.length
    || (retained === undefined
      ? !sameIds(currentReadableIds, plannedNamespaceIds)
      : !sameIds(retained, plannedNamespaceIds)
        || !retained.every(id => currentReadableIds.includes(id)))
    || !plannedNamespaceIds.includes(scheduling.namespaceId)
    || !exactWakeNamespaces({ publication, foregroundNamespaceIds: plannedNamespaceIds })) return null;
  if (retained !== undefined) {
    // A receipt can restrict fresh authority to the original source envelope;
    // newly readable namespaces never become new sources during continuation.
    envelope = { ...envelope,
      readableNamespaces: [...retained],
      mutableNamespaces: envelope.mutableNamespaces.filter(id => retained.includes(id)),
      writableNamespaces: envelope.writableNamespaces.filter(id => retained.includes(id)),
    };
  }
  const readableNamespaces = [...envelope.readableNamespaces];
  const mutableNamespaces = [...envelope.mutableNamespaces];
  const writableNamespaces = [...envelope.writableNamespaces];
  const toolPolicy = { ...envelope.toolPolicy };
  Object.freeze(readableNamespaces);
  Object.freeze(mutableNamespaces);
  Object.freeze(writableNamespaces);
  Object.freeze(toolPolicy);
  return Object.freeze({ ...envelope, readableNamespaces, mutableNamespaces,
    writableNamespaces, toolPolicy });
}

async function snapshotCurrentContext(input: Readonly<{
  publication: ProtectedTaskWakePublication;
  scheduling: ProtectedTaskWakeScheduling;
  transaction: CanonicalTranscriptTx;
  envelope: MemoryAccessEnvelope;
  assertCurrent: CurrentAssertion;
}>): Promise<ContextSnapshot | null> {
  const { publication, scheduling, transaction } = input;
  const { plan } = publication;
  const coordinates = await snapshotCurrentCoordinates({
    publication,
    scheduling,
    transaction,
  });
  if (coordinates === null) return null;
  const { room, envelopeRoomId, subthread } = coordinates;

  const [sessionRows, memberRows, roleRows, policyRows, bindingRows,
    taskRows, runRows] =
    await Promise.all([
      transaction.select({
        id: sessions.id,
        ownerId: sessions.ownerId,
        agentId: sessions.agentId,
        roomId: sessions.roomId,
        threadId: sessions.threadId,
        personaId: sessions.personaId,
      }).from(sessions).where(and(
        eq(sessions.id, scheduling.sessionId),
        eq(sessions.ownerId, scheduling.sessionOwnerId),
      )).limit(2),
      transaction.select({
        actorId: actors.id,
        kind: actors.kind,
        displayName: actors.displayName,
        agentId: actors.agentId,
        ownerId: actors.ownerId,
        userHandle: users.handle,
        userDisplayName: users.name,
        agentHandle: agents.handle,
        agentAvatar: profiles.avatarRef,
        roomRole: roomMembers.roomRole,
        agentResponseMode: roomMembers.agentResponseMode,
      }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .leftJoin(users, eq(users.id, actors.ownerId))
        .leftJoin(agents, eq(agents.id, actors.agentId))
        .leftJoin(profiles, eq(profiles.agentId, actors.agentId))
        .where(eq(roomMembers.roomId, room.id)).orderBy(actors.id),
      transaction.select({ slug: roles.slug }).from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
        .innerJoin(roles, eq(roles.id, groupRoles.roleId))
        .where(eq(groupMembers.userId, scheduling.requestorId)),
      transaction.select({
        id: encryptionTransitionPolicy.id,
        mode: encryptionTransitionPolicy.mode,
        shadowBehavior: encryptionTransitionPolicy.shadowBehavior,
        revision: encryptionTransitionPolicy.revision,
      }).from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server")).limit(2),
      transaction.select({
        bindingId: protectedTaskRunOutputBindings.bindingId,
        taskRunId: protectedTaskRunOutputBindings.taskRunId,
        destinationRoomId: protectedTaskRunOutputBindings.destinationRoomId,
        destinationNamespaceId: protectedTaskRunOutputBindings.destinationNamespaceId,
        wakeOperationId: protectedTaskRunOutputBindings.wakeOperationId,
        wakeJobId: protectedTaskRunOutputBindings.wakeJobId,
        deliveryMode: protectedTaskRunOutputBindings.deliveryMode,
        messageId: protectedTaskRunOutputBindings.messageId,
        messagePublishedAt: protectedTaskRunOutputBindings.messagePublishedAt,
      }).from(protectedTaskRunOutputBindings)
        .where(eq(protectedTaskRunOutputBindings.bindingId,
          scheduling.reference.bindingId)).limit(2),
      transaction.select({
        id: tasks.id,
        ownerId: tasks.ownerId,
        requestorId: tasks.requestorId,
        agentId: tasks.agentId,
        preset: tasks.preset,
        callingRoomId: tasks.callingRoomId,
        targetChat: tasks.targetChat,
        targetChatHandle: tasks.targetChatHandle,
        targetRoomId: tasks.targetRoomId,
        targetUserIds: tasks.targetUserIds,
        resultDelivery: tasks.resultDelivery,
        useScope: tasks.useScope,
        scopeId: tasks.scopeId,
        toolsMode: tasks.toolsMode,
        toolsWhitelist: tasks.toolsWhitelist,
        awaitResponse: tasks.awaitResponse,
        selectionProfile: tasks.selectionProfile,
        selectionSpec: tasks.selectionSpec,
        requestedModelId: tasks.requestedModelId,
        parentTaskId: tasks.parentTaskId,
        depth: tasks.depth,
        fundingMode: tasks.fundingMode,
        metadata: tasks.metadata,
        contentRepresentation: tasks.contentRepresentation,
        contentNamespaceId: tasks.contentNamespaceId,
        contentRevision: tasks.contentRevision,
        cryptoObjectId: tasks.cryptoObjectId,
        cryptoAccessRevision: tasks.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          tasks.cryptoRequiredNamespaceFingerprint,
        cryptoMappingState: tasks.cryptoMappingState,
      }).from(tasks).where(eq(tasks.id, scheduling.taskId)).limit(2),
      transaction.select({
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        jobId: taskRuns.jobId,
        graphThreadId: taskRuns.graphThreadId,
        status: taskRuns.status,
        modelId: taskRuns.modelId,
        fundingBinding: taskRuns.fundingBinding,
        fundingPredecessorRunId: taskRuns.fundingPredecessorRunId,
      }).from(taskRuns).where(and(eq(taskRuns.id, scheduling.taskRunId),
        eq(taskRuns.taskId, scheduling.taskId))).limit(2),
    ]);
  const session = sessionRows[0];
  const policy = policyRows[0];
  const binding = bindingRows[0];
  const taskSource = taskRows[0];
  const runSource = runRows[0];
  const currentRoster = roster(memberRows);
  if (sessionRows.length !== 1 || session === undefined
    || session.id !== scheduling.sessionId
    || session.ownerId !== room.ownerId || session.agentId !== scheduling.agentId
    || session.roomId !== room.id || session.threadId !== scheduling.graphThreadId
    || session.personaId !== "owner"
    || currentRoster === null
    || !currentRoster.some(member => member.kind === "user"
      && member.actorId === plan.intent.requesterHumanId
      && member.userId === scheduling.requestorId)
    || !currentRoster.some(member => member.kind === "user"
      && member.userId === room.ownerId)
    || currentRoster.filter(member => member.kind === "agent"
      && member.agentId === scheduling.agentId).length !== 1
    || policyRows.length !== 1 || policy === undefined || policy.id !== "server"
    || policy.revision !== plan.intent.expectedPolicyRevision
    || policy.mode !== (plan.intent.representation === "protected"
      ? "encrypted_only" : "shadow_encryption")
    || bindingRows.length !== 1 || binding === undefined
    || binding.bindingId !== scheduling.reference.bindingId
    || binding.taskRunId !== scheduling.taskRunId
    || binding.destinationRoomId !== scheduling.roomId
    || binding.destinationNamespaceId !== scheduling.namespaceId
    || binding.wakeOperationId !== scheduling.reference.wakeOperationId
    || binding.wakeJobId !== scheduling.jobId
    || (binding.messageId === null) !== (binding.messagePublishedAt === null)
    || binding.deliveryMode === "raw_and_wake" && binding.messageId === null
    || binding.deliveryMode !== "wake" && binding.deliveryMode !== "raw_and_wake"
    || taskRows.length !== 1 || taskSource === undefined
    || taskSource.id !== scheduling.taskId
    || taskSource.ownerId !== scheduling.ownerId
    || taskSource.requestorId !== scheduling.requestorId
    || taskSource.agentId !== scheduling.agentId
    || !protectedTaskDefinitionSupportsPolicy(taskSource.contentRepresentation, policy.mode)
    || taskSource.contentNamespaceId !== plan.intent.contentNamespaceId
    || taskSource.fundingMode !== "caller"
      && taskSource.fundingMode !== "legacy_server"
    || runRows.length !== 1 || runSource === undefined
    || runSource.id !== scheduling.taskRunId
    || runSource.taskId !== scheduling.taskId
    || runSource.status !== plan.intent.result.terminalStatus
    || taskSource.fundingMode === "caller"
      && !hasWakeFundingSource(runSource)) return null;

  const envelope = restrictCurrentEnvelope({
    publication,
    scheduling,
    envelopeRoomId,
    envelope: input.envelope,
  });
  if (envelope === null) return null;

  return Object.freeze({
    actorRole: highestRole(roleRows.map(row => row.slug)),
    roomRoster: currentRoster,
    memoryAccessEnvelope: envelope,
    subthread,
    resultMessagePublished: binding.messageId !== null,
    enforcementPolicy: Object.freeze({ mode: policy.mode,
      shadowBehavior: policy.shadowBehavior, revision: policy.revision }),
    assertCurrent: input.assertCurrent,
    taskSource: Object.freeze({ ...taskSource,
      targetUserIds: Object.freeze([...taskSource.targetUserIds]),
      toolsWhitelist: Object.freeze([...taskSource.toolsWhitelist]),
      metadata: structuredClone(taskSource.metadata),
      cryptoRequiredNamespaceFingerprint:
        taskSource.cryptoRequiredNamespaceFingerprint === null
          ? null
          : Uint8Array.from(taskSource.cryptoRequiredNamespaceFingerprint),
    }),
    runSource: Object.freeze({ ...runSource,
      fundingBinding: structuredClone(runSource.fundingBinding),
    }),
    envelopeRoomId,
  });
}

/**
 * Build one request-local foreground context from current product authority.
 * Database locks are released before funding or model inference begins.
 */
export function createProtectedTaskWakeForegroundContextOwner(
  dependencies: ProtectedTaskWakeForegroundContextDependencies,
): ProtectedTaskWakeForegroundContextOwner {
  const readPolicy = dependencies.readPolicy ?? currentStrictShadowPolicy;
  const openWakeFunding = dependencies.openWakeFunding
    ?? (operation => openProtectedTaskWakeFundingSession(operation));
  return async input => {
    input.signal.throwIfAborted();
    const coordinates = await dependencies.withCurrentFacts({ ...input,
      use: async (transaction, assertCurrent) => {
        const value = await snapshotCurrentCoordinates({
          publication: input.publication,
          scheduling: input.scheduling,
          transaction,
        });
        return value === null ? null : Object.freeze({ ...value, assertCurrent });
      },
    });
    if (coordinates === null) {
      throw new TypeError("Protected Task wake foreground context is unavailable");
    }
    input.signal.throwIfAborted();
    await coordinates.assertCurrent();
    let candidateEnvelope: MemoryAccessEnvelope;
    try {
      candidateEnvelope = await dependencies.resolver.buildEnvelope(
        input.publication.plan.intent.requesterHumanId,
        `room:${coordinates.envelopeRoomId}`,
        input.scheduling.agentId,
        coordinates.envelopeRoomId,
      );
    } catch {
      throw new TypeError("Protected Task wake foreground context is unavailable");
    }
    const restrictedCandidate = restrictCurrentEnvelope({
      publication: input.publication,
      scheduling: input.scheduling,
      envelopeRoomId: coordinates.envelopeRoomId,
      envelope: candidateEnvelope,
    });
    if (restrictedCandidate === null) {
      throw new TypeError("Protected Task wake foreground context is unavailable");
    }
    await coordinates.assertCurrent();
    const snapshot = await dependencies.withCurrentFacts({ ...input,
      use: (transaction, assertCurrent) => snapshotCurrentContext({
        publication: input.publication,
        scheduling: input.scheduling,
        transaction,
        envelope: restrictedCandidate,
        assertCurrent,
      }),
    });
    if (snapshot === null) {
      throw new TypeError("Protected Task wake foreground context is unavailable");
    }
    input.signal.throwIfAborted();
    await snapshot.assertCurrent();
    let currentEnvelope: MemoryAccessEnvelope;
    try {
      currentEnvelope = await dependencies.resolver.buildEnvelope(
        input.publication.plan.intent.requesterHumanId,
        `room:${snapshot.envelopeRoomId}`,
        input.scheduling.agentId,
        snapshot.envelopeRoomId,
      );
    } catch {
      throw new TypeError("Protected Task wake foreground context is unavailable");
    }
    const restrictedCurrent = restrictCurrentEnvelope({
      publication: input.publication,
      scheduling: input.scheduling,
      envelopeRoomId: snapshot.envelopeRoomId,
      envelope: currentEnvelope,
    });
    if (restrictedCurrent === null) {
      throw new TypeError("Protected Task wake foreground context is unavailable");
    }
    const candidateDigest = protectedTaskWakeSourceEnvelopeDigest(
      snapshot.memoryAccessEnvelope,
    );
    const currentDigest = protectedTaskWakeSourceEnvelopeDigest(restrictedCurrent);
    if (candidateDigest.length !== currentDigest.length
      || !candidateDigest.every((byte, index) => byte === currentDigest[index])) {
      throw new TypeError("Protected Task wake foreground context changed");
    }
    await snapshot.assertCurrent();
    const continuation = input.publication.plan.intent.continuation;
    const sourceEnvelopeDigest = currentDigest;
    if (continuation !== undefined
      && (continuation.sourceEnvelopeDigest.length !== sourceEnvelopeDigest.length
        || !sourceEnvelopeDigest.every((byte, index) =>
          byte === continuation.sourceEnvelopeDigest[index]))) {
      throw new TypeError("Protected Task wake retained source changed");
    }
    const fundingSession = snapshot.taskSource.fundingMode === "caller"
      || snapshot.taskSource.fundingMode === "legacy_server"
      ? await openWakeFunding({
          publication: input.publication,
          scheduling: input.scheduling,
          taskSource: snapshot.taskSource,
          runSource: snapshot.runSource,
          modelId: snapshot.runSource.modelId,
          signal: input.signal,
          assertCurrent: snapshot.assertCurrent,
        })
      : null;
    await snapshot.assertCurrent();
    input.signal.throwIfAborted();
    const checkpointBinding = Object.freeze({
      retainedSourceNamespaceIds: Object.freeze([
        ...input.publication.plan.foregroundNamespaceIds,
      ].sort()),
      sourceEnvelopeDigest,
      initialPolicyRevision: continuation?.initialPolicyRevision
        ?? input.publication.wakeEvidence.policyRevision,
      initialAgentAuthorizationRevision:
        continuation?.initialAgentAuthorizationRevision
        // Filled by the authenticated HIVE signer owner before the context
        // reaches Runtime or a projection service.
        ?? 0,
    });
    const context: ProtectedTaskWakeForegroundContext = Object.freeze({
      resultMessagePublished: snapshot.resultMessagePublished,
      actorRole: snapshot.actorRole,
      roomRoster: snapshot.roomRoster,
      memoryAccessEnvelope: restrictedCurrent,
      subthread: snapshot.subthread,
      fundingSession,
      checkpointBinding,
      ...(continuation === undefined ? {} : {
        continuation: Object.freeze({
          segment: continuation.segment,
          checkpointThreadId: continuation.checkpointThreadId,
          resume: Object.freeze({
            interruptId: continuation.interruptId,
            authorizationRequestId: continuation.additionalAuthorizationRequestId,
            effectDisposition: "not_started_v1" as const,
            operationId: continuation.operationId,
            requestDigest: Uint8Array.from(continuation.requestDigest),
            requiredAuthorityDigest: Uint8Array.from(continuation.requiredAuthorityDigest),
          }),
        }),
      }),
      enforcementPolicy: snapshot.enforcementPolicy,
      dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(readPolicy),
    });
    const result = await input.use(context);
    input.signal.throwIfAborted();
    await snapshot.assertCurrent();
    return result;
  };
}
