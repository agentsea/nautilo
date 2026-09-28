import {
  updateTask,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import {
  buildEnvelopeForTargetUsers,
  buildWideEnvelopeForSpeaker,
  createScope,
  createScopeMemoryEnvelopeWithOrigin,
  findActorByOwnerId,
  getRoomWithAccess,
  isNamespaceMemoryEnvelope,
  type MemoryAccessEnvelope,
  type PolicyResolver,
  type ScopeMemoryEnvelope,
  type ScopeMemoryEnvelopeWithOrigin,
  type TargetUserRef,
} from "@nautilo/trust";
import { log } from "@nautilo/logger";

/** The three Memory-envelope variants available to a Task run. */
export type TaskEnvelopeMode = "scope" | "wide" | "namespace";

/**
 * Describes how the resolver obtained the returned authority. Protected Task
 * execution can use this instead of mistaking an ordinary compatibility
 * fallback for the exact requested Memory authority.
 */
export type TaskEnvelopeResolutionProvenance =
  | "scope_existing"
  | "scope_created_from_plaintext_prompt"
  | "scope_without_origin_namespace"
  | "wide_private_namespace"
  | "wide_base_namespace_fallback"
  | "target_users_namespace"
  | "authorized_calling_room_fallback"
  | "base_namespace_fallback"
  | "base_namespace_without_requestor_actor";

export type TaskEnvelopeResolution = Readonly<{
  envelope: MemoryAccessEnvelope;
  mode: TaskEnvelopeMode;
  /** Protected coordinators must accept only exact authority. */
  authorityStatus: "exact" | "fallback" | "unresolved";
  provenance: TaskEnvelopeResolutionProvenance;
}>;

export type TaskMemoryEnvelopeResolverInput = Readonly<{
  task: Task;
  db: DirectDatabase;
  resolver: PolicyResolver;
  laneKey: string;
  sessionRoomId: string;
  /** Fresh target users, including any peer added while resolving the Room. */
  targetUserIds: readonly string[];
}>;

export type TaskMemoryEnvelopeResolutionDependencies = Readonly<{
  findActorByOwnerId: typeof findActorByOwnerId;
  buildEnvelopeForTargetUsers: typeof buildEnvelopeForTargetUsers;
  buildWideEnvelopeForSpeaker: typeof buildWideEnvelopeForSpeaker;
  createScope: typeof createScope;
  createScopeMemoryEnvelopeWithOrigin: typeof createScopeMemoryEnvelopeWithOrigin;
  getRoomWithAccess: typeof getRoomWithAccess;
  updateTask: typeof updateTask;
  log: typeof log;
}>;

const productionDependencies: TaskMemoryEnvelopeResolutionDependencies = {
  findActorByOwnerId,
  buildEnvelopeForTargetUsers,
  buildWideEnvelopeForSpeaker,
  createScope,
  createScopeMemoryEnvelopeWithOrigin,
  getRoomWithAccess,
  updateTask,
  log,
};

/** Select the Task's requested Memory-envelope mode. */
export function selectTaskEnvelopeMode(task: Task): TaskEnvelopeMode {
  if (task.useScope) return "scope";
  if (task.preset === "in_private_namespace") return "wide";
  return "namespace";
}

/**
 * Resolve the canonical Memory envelope used by ordinary Task dispatch.
 *
 * This deliberately preserves ordinary dispatch's historical fallbacks and
 * labels them in the result. Callers that require exact protected authority
 * must reject `authorityStatus: "fallback"` rather than silently accepting a
 * different namespace.
 *
 * Creating a new scope currently stores a purpose derived from the plaintext
 * Task prompt. The provenance makes that dependency explicit so a protected
 * coordinator does not attempt scope creation before decrypting Task content.
 */
export async function resolveTaskMemoryEnvelope(
  input: TaskMemoryEnvelopeResolverInput,
  dependencyOverrides: Partial<TaskMemoryEnvelopeResolutionDependencies> = {},
): Promise<TaskEnvelopeResolution> {
  const dependencies = { ...productionDependencies, ...dependencyOverrides };
  const { task, db, resolver, laneKey, sessionRoomId } = input;

  // `buildEnvelope` resolves the capability subject by actor id. Task rows
  // retain users.id for the requestor, so translate it before building the
  // base envelope and retain the existing user-id compatibility fallback.
  const requestorActor = await dependencies.findActorByOwnerId(task.requestorId);
  const baseEnvelope = await resolver.buildEnvelope(
    requestorActor?.id ?? task.requestorId,
    laneKey,
    task.agentId,
    sessionRoomId,
  );
  const mode = selectTaskEnvelopeMode(task);

  if (mode === "scope") {
    const actorId = requestorActor?.id ?? baseEnvelope.actorId;
    let scopeId = task.scopeId;
    let provenance: TaskEnvelopeResolutionProvenance = "scope_existing";
    if (!scopeId) {
      const scope = await dependencies.createScope({
        parentAgentId: task.agentId,
        speakerUserId: task.requestorId,
        name: `task:${task.id}`,
        purpose: task.prompt.slice(0, 200),
      });
      if ("error" in scope) {
        throw new Error(
          `dispatchTaskRun: createScope failed for task ${task.id}: ${scope.error}`,
        );
      }
      scopeId = scope.scopeId;
      await dependencies.updateTask(db, task.id, { scopeId });
      provenance = "scope_created_from_plaintext_prompt";
    }
    const canInheritOrigin = baseEnvelope.memoryMode === "namespace"
      && baseEnvelope.writableNamespaces.length === 1
      && (baseEnvelope.writableNamespaces[0]?.trim().length ?? 0) > 0;
    const envelope = canInheritOrigin
      ? dependencies.createScopeMemoryEnvelopeWithOrigin(baseEnvelope, scopeId)
      : {
          memoryMode: "scope",
          ownerId: baseEnvelope.ownerId,
          actorId,
          agentId: task.agentId,
          roomId: baseEnvelope.roomId,
          scopeId,
          toolPolicy: baseEnvelope.toolPolicy,
        } satisfies ScopeMemoryEnvelope | ScopeMemoryEnvelopeWithOrigin;
    return {
      envelope,
      mode,
      authorityStatus: canInheritOrigin ? "exact" : "unresolved",
      provenance: canInheritOrigin ? provenance : "scope_without_origin_namespace",
    };
  }

  if (mode === "wide") {
    const speakerActorId = requestorActor?.id ?? baseEnvelope.actorId;
    const bringBack = task.metadata["bringBack"] !== false;
    let returnRoomNamespaceId: string | undefined;
    if (bringBack && task.callingRoomId) {
      const callingRoom = await dependencies.getRoomWithAccess(task.callingRoomId);
      returnRoomNamespaceId = callingRoom?.namespaceId;
    }
    const wide = await dependencies.buildWideEnvelopeForSpeaker({
      speakerActorId,
      speakerUserId: task.requestorId,
      agentId: task.agentId,
      toolPolicy: baseEnvelope.toolPolicy,
      ...(returnRoomNamespaceId ? { returnRoomNamespaceId } : {}),
    });
    if (wide.ok) {
      return {
        envelope: wide.envelope,
        mode,
        authorityStatus: "exact",
        provenance: "wide_private_namespace",
      };
    }
    dependencies.log(
      `[task-dispatch] wide envelope unavailable for task=${task.id} (${wide.reason}); falling back to namespace envelope`,
    );
    return {
      envelope: baseEnvelope,
      mode,
      authorityStatus: "fallback",
      provenance: "wide_base_namespace_fallback",
    };
  }

  if (!requestorActor) {
    return {
      envelope: baseEnvelope,
      mode,
      authorityStatus: "fallback",
      provenance: "base_namespace_without_requestor_actor",
    };
  }

  const targetUserIds = Array.from(
    new Set([task.requestorId, ...input.targetUserIds].filter(Boolean)),
  );
  const targetUsers: TargetUserRef[] = [];
  for (const uid of targetUserIds) {
    if (uid === task.requestorId) {
      targetUsers.push({ userId: uid, actorId: requestorActor.id });
      continue;
    }
    const peerActor = await dependencies.findActorByOwnerId(uid);
    if (peerActor) targetUsers.push({ userId: uid, actorId: peerActor.id });
  }
  const derived = await dependencies.buildEnvelopeForTargetUsers({
    requester: { userId: task.requestorId, actorId: requestorActor.id },
    targetUsers,
    agentId: task.agentId,
    toolPolicy: baseEnvelope.toolPolicy,
    mintLabel: `Task ${task.id.slice(0, 8)} namespace`,
  });
  if (derived.ok) {
    return {
      envelope: derived.envelope,
      mode,
      authorityStatus: "exact",
      provenance: "target_users_namespace",
    };
  }

  // A foreign-owned Agent may have no requester-private namespace. Preserve
  // ordinary dispatch's exact requester-only compatibility behavior by
  // rechecking the already-authorized calling Room before falling back to the
  // original base envelope.
  const requesterOnly = targetUserIds.length === 1
    && targetUserIds[0] === task.requestorId;
  if (requesterOnly && task.callingRoomId) {
    const callingRoomEnvelope = await resolver.buildEnvelope(
      requestorActor.id,
      laneKey,
      task.agentId,
      task.callingRoomId,
    );
    if (
      isNamespaceMemoryEnvelope(callingRoomEnvelope)
      && callingRoomEnvelope.roomId === task.callingRoomId
      && callingRoomEnvelope.writableNamespaces.length > 0
    ) {
      dependencies.log(
        `[task-dispatch] target-users envelope unavailable for task=${task.id} (${derived.reason}); using authorized calling-room namespace`,
      );
      return {
        envelope: callingRoomEnvelope,
        mode,
        // This recovery path is exact despite being selected after target-user
        // resolution failed: the policy resolver rechecked the current Human,
        // Agent, and exact calling Room, and the Room exposed a write target.
        authorityStatus: "exact",
        provenance: "authorized_calling_room_fallback",
      };
    }
  }

  dependencies.log(
    `[task-dispatch] target-users envelope unavailable for task=${task.id} (${derived.reason}); falling back to base namespace envelope`,
  );
  return {
    envelope: baseEnvelope,
    mode,
    authorityStatus: "fallback",
    provenance: "base_namespace_fallback",
  };
}
