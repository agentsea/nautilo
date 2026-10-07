import {
  eq,
  sql,
  tasks,
  type DirectDatabase,
  type ParkedProtectedTaskAdditionalAuthority,
  type ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import {
  copyTaskScopeMemoryBinding,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type { ProtectedTaskPredispatchPlan } from "@nautilo/runtime";
import {
  buildEnvelopeForTargetUsers,
  buildWideEnvelopeForSpeaker,
  createScopeMemoryEnvelopeWithOrigin,
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
  getPolicyResolver,
  isNamespaceMemoryEnvelope,
  type MemoryAccessEnvelope,
  type PolicyResolver,
  type TargetUserRef,
} from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import {
  createProtectedTaskScopeMemoryInventoryResolver,
  type ProtectedTaskScopeMemoryInventoryResolverInput,
} from "./protected-task-scope-memory-inventory";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ParkedProtectedTaskTargetChat =
  | "last_in_namespace"
  | "new_in_namespace"
  | "last_dm"
  | "new_dm"
  | "orphan";

export type ParkedProtectedTaskRuntimeMemoryMetadata = Readonly<{
  taskId: string;
  requesterUserId: string;
  agentId: string;
  targetRoomId: string | null;
  targetUserIds: readonly string[];
  useScope: boolean;
  scopeId: string | null;
  preset: string;
  targetChat: ParkedProtectedTaskTargetChat;
  wideBringBack: boolean;
}>;

type ReadCurrentTaskMemoryMetadata = (
  db: DirectDatabase,
  taskId: string,
) => Promise<ParkedProtectedTaskRuntimeMemoryMetadata | null>;

type ResolveScopeMemoryInventory = (
  input: ProtectedTaskScopeMemoryInventoryResolverInput,
) => Promise<TaskScopeMemoryBinding>;

type TaskEnvelopeResolution = ProtectedTaskPredispatchPlan["memory"];

export type ParkedProtectedTaskRuntimeMemoryRouting = Readonly<{
  taskId: string;
  taskRunId: string;
  requesterUserId: string;
  requesterHumanId: string;
  agentId: string;
  sourceRoomId: string;
  sourceNamespaceId: string;
  targetRoomId: string;
  targetUserIds: readonly string[];
  memoryMode: "scope" | "wide" | "namespace";
  scopeId: string | null;
  targetChat: ParkedProtectedTaskTargetChat;
  wideBringBack: boolean;
  /** Canonical private write target returned by the Wide resolver. */
  widePrivateNamespaceId: string | null;
  outputRoomId: string | null;
  outputNamespaceId: string | null;
}>;

export type ParkedProtectedTaskRuntimeMemoryPlan = Readonly<{
  routing: ParkedProtectedTaskRuntimeMemoryRouting;
  resolution: TaskEnvelopeResolution;
  scopeMemory?: TaskScopeMemoryBinding;
  expectedNamespaceParticipants?: readonly Readonly<{
    namespaceId: string;
    match: "exact" | "includes";
    participantHumanIds: readonly string[];
  }>[];
}>;

export type ProtectedTaskRuntimeParkedMemoryPlanResolverDependencies =
  Readonly<{
    db: DirectDatabase;
    resolver: PolicyResolver | null;
    readCurrentMetadata: ReadCurrentTaskMemoryMetadata;
    resolveRequesterHuman(userId: string): Promise<Readonly<{
      id: string;
    }> | null>;
    resolveRequesterPrivateRoom: typeof findAgentOwnerPrivateRoom;
    buildTargetUsersEnvelope: typeof buildEnvelopeForTargetUsers;
    buildWideEnvelope: typeof buildWideEnvelopeForSpeaker;
    createScopeEnvelope: typeof createScopeMemoryEnvelopeWithOrigin;
    resolveScopeMemoryInventory: ResolveScopeMemoryInventory;
  }>;

async function readCurrentTaskMemoryMetadata(
  db: DirectDatabase,
  taskId: string,
): Promise<ParkedProtectedTaskRuntimeMemoryMetadata | null> {
  const rows = await db.select({
    taskId: tasks.id,
    requesterUserId: tasks.requestorId,
    agentId: tasks.agentId,
    targetRoomId: tasks.targetRoomId,
    targetUserIds: tasks.targetUserIds,
    useScope: tasks.useScope,
    scopeId: tasks.scopeId,
    preset: tasks.preset,
    targetChat: tasks.targetChat,
    wideBringBack:
      sql<boolean>`(${tasks.metadata} -> 'bringBack') IS DISTINCT FROM 'false'::jsonb`
        .mapWith(Boolean)
        .as("wide_bring_back"),
  }).from(tasks).where(eq(tasks.id, taskId)).limit(2);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return null;
  return Object.freeze({
    taskId: row.taskId,
    requesterUserId: row.requesterUserId,
    agentId: row.agentId,
    targetRoomId: row.targetRoomId,
    targetUserIds: Object.freeze([...row.targetUserIds]),
    useScope: row.useScope,
    scopeId: row.scopeId,
    preset: row.preset,
    targetChat: row.targetChat,
    wideBringBack: row.wideBringBack,
  });
}

function copyEnvelope(envelope: MemoryAccessEnvelope): MemoryAccessEnvelope {
  if (envelope.memoryMode === "scope") {
    return Object.freeze({
      ...envelope,
      toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
    });
  }
  return Object.freeze({
    ...envelope,
    readableNamespaces: Object.freeze([...envelope.readableNamespaces]),
    mutableNamespaces: Object.freeze([...envelope.mutableNamespaces]),
    writableNamespaces: Object.freeze([...envelope.writableNamespaces]),
    toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
  }) as MemoryAccessEnvelope;
}

function uuidSet(values: readonly string[]): boolean {
  return values.length > 0
    && values.every(value => UUID.test(value))
    && new Set(values).size === values.length;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactNamespaceEnvelope(
  envelope: MemoryAccessEnvelope,
  identity: Readonly<{
    requesterUserId: string;
    requesterHumanId: string;
    agentId: string;
  }>,
): envelope is Exclude<MemoryAccessEnvelope, { memoryMode: "scope" }> {
  return isNamespaceMemoryEnvelope(envelope)
    && envelope.ownerId === identity.requesterUserId
    && envelope.actorId === identity.requesterHumanId
    && envelope.agentId === identity.agentId
    && UUID.test(envelope.roomId)
    && uuidSet(envelope.readableNamespaces)
    && uuidSet(envelope.mutableNamespaces)
    && uuidSet(envelope.writableNamespaces);
}

function exactOutputBinding(input: Readonly<{
  taskRunId: string;
  callingRoomId: string | null;
  resultObjectId: string;
  outputTaskRunId: string;
  outputBindingId: string;
  outputDeliveryMode: "none" | "wake" | "raw" | "raw_and_wake";
  outputRoomId: string | null;
  outputNamespaceId: string | null;
  outputResultOperationId: string;
  outputResultObjectId: string;
}>): boolean {
  return input.outputTaskRunId === input.taskRunId
    && input.outputBindingId === `task-run-output:${input.taskRunId}`
    && input.outputResultOperationId === `task-run-result:${input.taskRunId}`
    && input.outputResultObjectId === input.resultObjectId
    && input.outputRoomId === input.callingRoomId
    && (input.outputRoomId === null
      ? input.outputDeliveryMode === "none"
        && input.outputNamespaceId === null
      : input.outputDeliveryMode !== "none"
        && input.outputNamespaceId !== null
        && UUID.test(input.outputRoomId)
        && UUID.test(input.outputNamespaceId));
}

function expectedMode(metadata: ParkedProtectedTaskRuntimeMemoryMetadata):
  "scope" | "wide" | "namespace" {
  return metadata.useScope
    ? "scope"
    : metadata.preset === "in_private_namespace"
      ? "wide"
      : "namespace";
}

function exactCurrentMetadata(
  metadata: ParkedProtectedTaskRuntimeMemoryMetadata,
  expected: Readonly<{
    taskId: string;
    requesterUserId: string;
    agentId: string;
  }>,
): metadata is ParkedProtectedTaskRuntimeMemoryMetadata & Readonly<{
  targetRoomId: string;
}> {
  return metadata.taskId === expected.taskId
    && metadata.requesterUserId === expected.requesterUserId
    && metadata.agentId === expected.agentId
    && metadata.targetRoomId !== null
    && UUID.test(metadata.targetRoomId)
    && metadata.targetUserIds.every(id => UUID.test(id))
    && new Set(metadata.targetUserIds).size === metadata.targetUserIds.length
    && (metadata.useScope === true || metadata.useScope === false)
    && (metadata.scopeId === null || UUID.test(metadata.scopeId))
    && [
      "last_in_namespace",
      "new_in_namespace",
      "last_dm",
      "new_dm",
      "orphan",
    ].includes(metadata.targetChat)
    && typeof metadata.wideBringBack === "boolean";
}

/**
 * Rebuild current Memory metadata for a parked protected Task without reading
 * definition plaintext or mutating routing. The returned plan is detached;
 * the grant owner must compare its pinned routing with locked current facts.
 */
export function createProtectedTaskRuntimeParkedMemoryPlanResolver(
  overrides: Partial<
    ProtectedTaskRuntimeParkedMemoryPlanResolverDependencies
  > = {},
): (input: Readonly<{
  expected: ParkedProtectedTaskAdditionalAuthority;
  output: ProtectedTaskRunOutputBinding;
}>) => Promise<ParkedProtectedTaskRuntimeMemoryPlan | null> {
  const db = overrides.db ?? getServerDirectDb();
  const resolver = overrides.resolver ?? getPolicyResolver();
  const readMetadata = overrides.readCurrentMetadata
    ?? readCurrentTaskMemoryMetadata;
  const resolveRequesterHuman = overrides.resolveRequesterHuman
    ?? findActorByOwnerId;
  const resolveRequesterPrivateRoom = overrides.resolveRequesterPrivateRoom
    ?? findAgentOwnerPrivateRoom;
  const buildTargetUsersEnvelope = overrides.buildTargetUsersEnvelope
    ?? buildEnvelopeForTargetUsers;
  const buildWideEnvelope = overrides.buildWideEnvelope
    ?? buildWideEnvelopeForSpeaker;
  const createScopeEnvelope = overrides.createScopeEnvelope
    ?? createScopeMemoryEnvelopeWithOrigin;
  const resolveScopeMemoryInventory = overrides.resolveScopeMemoryInventory
    ?? createProtectedTaskScopeMemoryInventoryResolver({ db });

  return async input => {
    const occurrence = input.expected.occurrence;
    const pinned = Object.freeze({
      taskId: occurrence.task.id,
      taskRunId: occurrence.run.id,
      requesterUserId: occurrence.task.requestorId,
      agentId: occurrence.task.agentId,
      contentNamespaceId: occurrence.task.contentNamespaceId,
      callingRoomId: occurrence.task.callingRoomId,
      resultObjectId: input.expected.priorJob.reference.resultObjectId,
      outputTaskRunId: input.output.taskRunId,
      outputBindingId: input.output.bindingId,
      outputDeliveryMode: input.output.deliveryMode,
      outputRoomId: input.output.destinationRoomId,
      outputNamespaceId: input.output.destinationNamespaceId,
      outputResultOperationId: input.output.resultOperationId,
      outputResultObjectId: input.output.resultObjectId,
    });
    if (resolver === null
      || !UUID.test(pinned.taskId)
      || !UUID.test(pinned.taskRunId)
      || !UUID.test(pinned.requesterUserId)
      || !UUID.test(pinned.agentId)
      || !UUID.test(pinned.contentNamespaceId)
      || !exactOutputBinding(pinned)) return null;

    const metadataValue = await readMetadata(db, pinned.taskId);
    if (metadataValue === null) return null;
    const metadata: ParkedProtectedTaskRuntimeMemoryMetadata = Object.freeze({
      ...metadataValue,
      targetUserIds: Object.freeze([...metadataValue.targetUserIds]),
    });
    if (!exactCurrentMetadata(metadata, pinned)) return null;

    const [requesterHumanValue, sourceRoomValue] = await Promise.all([
      resolveRequesterHuman(pinned.requesterUserId),
      resolveRequesterPrivateRoom(pinned.requesterUserId, pinned.agentId),
    ]);
    if (requesterHumanValue === null || sourceRoomValue === null) return null;
    const requesterHuman = Object.freeze({ ...requesterHumanValue });
    const sourceRoom = Object.freeze({ ...sourceRoomValue });
    if (!UUID.test(requesterHuman.id)
      || !UUID.test(sourceRoom.roomId)
      || sourceRoom.namespaceId !== pinned.contentNamespaceId) return null;

    const identity = Object.freeze({
      requesterUserId: pinned.requesterUserId,
      requesterHumanId: requesterHuman.id,
      agentId: pinned.agentId,
    });
    const sourceEnvelope = await resolver.buildEnvelope(
      requesterHuman.id,
      `task:${pinned.taskId}`,
      pinned.agentId,
      sourceRoom.roomId,
    );
    if (!exactNamespaceEnvelope(sourceEnvelope, identity)
      || sourceEnvelope.roomId !== sourceRoom.roomId
      || sourceEnvelope.writableNamespaces.length !== 1
      || sourceEnvelope.writableNamespaces[0] !== pinned.contentNamespaceId) {
      return null;
    }
    const closedSourceEnvelope = copyEnvelope(sourceEnvelope);
    if (!isNamespaceMemoryEnvelope(closedSourceEnvelope)) return null;

    const mode = expectedMode(metadata);
    const targetUserIds = Object.freeze([...new Set([
      pinned.requesterUserId,
      ...metadata.targetUserIds,
    ])].sort());
    let resolution: TaskEnvelopeResolution;
    let scopeMemory: TaskScopeMemoryBinding | undefined;
    let widePrivateNamespaceId: string | null = null;
    let expectedNamespaceParticipants:
      ParkedProtectedTaskRuntimeMemoryPlan["expectedNamespaceParticipants"]
      = undefined;

    if (mode === "namespace") {
      const targetUsers: TargetUserRef[] = [];
      for (const userId of targetUserIds) {
        const actor = userId === pinned.requesterUserId
          ? requesterHuman
          : await resolveRequesterHuman(userId);
        if (actor === null || !UUID.test(actor.id)) return null;
        targetUsers.push({ userId, actorId: actor.id });
      }
      const participantHumanIds = Object.freeze(
        targetUsers.map(target => target.actorId).sort(),
      );
      if (new Set(participantHumanIds).size !== targetUserIds.length) {
        return null;
      }
      const derived = await buildTargetUsersEnvelope({
        requester: {
          userId: pinned.requesterUserId,
          actorId: requesterHuman.id,
        },
        targetUsers,
        agentId: pinned.agentId,
        toolPolicy: { ...closedSourceEnvelope.toolPolicy },
        allowMint: false,
      });
      if (!derived.ok || derived.minted
        || derived.namespaceRoomId !== derived.envelope.roomId
        || !exactNamespaceEnvelope(derived.envelope, identity)
        || derived.envelope.writableNamespaces.length !== 1
        || !derived.envelope.readableNamespaces.includes(
          derived.envelope.writableNamespaces[0]!,
        )
        || !sameIds(
          derived.envelope.readableNamespaces,
          derived.envelope.mutableNamespaces,
        )) return null;
      const selectedNamespaceId = derived.envelope.writableNamespaces[0]!;
      expectedNamespaceParticipants = Object.freeze(
        [...derived.envelope.readableNamespaces]
          .sort()
          .map(namespaceId => Object.freeze({
            namespaceId,
            match: namespaceId === selectedNamespaceId
              ? "exact" as const
              : "includes" as const,
            participantHumanIds,
          })),
      );
      resolution = Object.freeze({
        envelope: copyEnvelope(derived.envelope),
        mode,
        authorityStatus: "exact",
        provenance: "target_users_namespace",
      });
    } else if (mode === "wide") {
      const derived = await buildWideEnvelope({
        speakerActorId: requesterHuman.id,
        speakerUserId: pinned.requesterUserId,
        agentId: pinned.agentId,
        toolPolicy: { ...closedSourceEnvelope.toolPolicy },
        ...(metadata.wideBringBack && pinned.outputNamespaceId !== null
          ? { returnRoomNamespaceId: pinned.outputNamespaceId }
          : {}),
      });
      if (!derived.ok
        || derived.privateRoomId !== derived.envelope.roomId
        || !exactNamespaceEnvelope(derived.envelope, identity)) return null;
      const privateNamespaceId = derived.envelope.writableNamespaces.at(-1);
      const expectedPrimary = metadata.wideBringBack
          && pinned.outputNamespaceId !== null
        ? pinned.outputNamespaceId
        : privateNamespaceId;
      if (privateNamespaceId === undefined
        || !UUID.test(privateNamespaceId)
        || derived.envelope.writableNamespaces[0] !== expectedPrimary
        || derived.envelope.writableNamespaces.length
          !== (expectedPrimary === privateNamespaceId ? 1 : 2)
        || !derived.envelope.readableNamespaces.includes(privateNamespaceId)
        || !sameIds(
          derived.envelope.readableNamespaces,
          derived.envelope.mutableNamespaces,
        )) {
        return null;
      }
      widePrivateNamespaceId = privateNamespaceId;
      resolution = Object.freeze({
        envelope: copyEnvelope(derived.envelope),
        mode,
        authorityStatus: "exact",
        provenance: "wide_private_namespace",
      });
    } else {
      if (metadata.scopeId === null) return null;
      const memoryRoomId = metadata.targetChat === "orphan"
        ? sourceRoom.roomId
        : metadata.targetRoomId;
      const parent = memoryRoomId === sourceRoom.roomId
        ? closedSourceEnvelope
        : await resolver.buildEnvelope(
            requesterHuman.id,
            `task:${pinned.taskId}`,
            pinned.agentId,
            memoryRoomId,
          );
      if (!exactNamespaceEnvelope(parent, identity)
        || parent.roomId !== memoryRoomId
        || parent.writableNamespaces.length !== 1) return null;
      const originWritableNamespaceId = parent.writableNamespaces[0]!;
      const envelope = createScopeEnvelope(parent, metadata.scopeId);
      if (envelope.scopeId !== metadata.scopeId
        || envelope.roomId !== memoryRoomId
        || envelope.originWritableNamespaceId
          !== originWritableNamespaceId) return null;
      const closedScopeEnvelope = copyEnvelope(envelope);
      try {
        scopeMemory = copyTaskScopeMemoryBinding(
          await resolveScopeMemoryInventory({
            coordinates: Object.freeze({
              taskId: pinned.taskId,
              taskRunId: pinned.taskRunId,
              requesterUserId: pinned.requesterUserId,
              agentId: pinned.agentId,
              contentNamespaceId: pinned.contentNamespaceId,
              scopeId: metadata.scopeId,
              memoryRoomId,
              originWritableNamespaceId,
              requesterActorId: requesterHuman.id,
            }),
          }),
        );
      } catch (error) {
        if (error instanceof TypeError) return null;
        throw error;
      }
      if (scopeMemory.scopeId !== metadata.scopeId
        || scopeMemory.memoryRoomId !== memoryRoomId
        || scopeMemory.originWritableNamespaceId
          !== originWritableNamespaceId) return null;
      resolution = Object.freeze({
        envelope: closedScopeEnvelope,
        mode,
        authorityStatus: "exact",
        provenance: "scope_existing",
      });
    }

    const routing: ParkedProtectedTaskRuntimeMemoryRouting = Object.freeze({
      taskId: pinned.taskId,
      taskRunId: pinned.taskRunId,
      requesterUserId: pinned.requesterUserId,
      requesterHumanId: requesterHuman.id,
      agentId: pinned.agentId,
      sourceRoomId: sourceRoom.roomId,
      sourceNamespaceId: sourceRoom.namespaceId,
      targetRoomId: metadata.targetRoomId,
      targetUserIds,
      memoryMode: mode,
      scopeId: mode === "scope" ? metadata.scopeId : null,
      targetChat: metadata.targetChat,
      wideBringBack: metadata.wideBringBack,
      widePrivateNamespaceId,
      outputRoomId: pinned.outputRoomId,
      outputNamespaceId: pinned.outputNamespaceId,
    });
    return Object.freeze({
      routing,
      resolution,
      ...(scopeMemory === undefined ? {} : { scopeMemory }),
      ...(expectedNamespaceParticipants === undefined
        ? {}
        : { expectedNamespaceParticipants }),
    });
  };
}
