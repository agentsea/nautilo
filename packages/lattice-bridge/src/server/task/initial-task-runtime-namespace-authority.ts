import {
  acquireEncryptionConsumptionFence,
  actors,
  and,
  asc,
  domainKeyHeads,
  eq,
  roomMembers,
  moderationEffectiveHumanActorIdsSql,
  protectedTaskRunWakeJobId,
  rooms,
  sql,
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
import { readableNamespacePolicyAllows } from "../delivery/namespace-readable-policy.ts";
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
  readCryptoStorageInteger,
  verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

import type {
  TaskRuntimeDomainAuthorityRequirement,
  TaskRuntimeNamespaceAuthorityRequirement,
} from "./current-task-runtime-authority.ts";
import {
  copyTaskScopeMemoryBinding,
  readCurrentTaskScopeMemoryNamespaceInventory,
  type TaskScopeMemoryBinding,
} from "./task-scope-memory-metadata.ts";
import {
  copyParkedTaskRuntimeAuthority,
  copyParkedTaskRuntimeExpectedNamespaceParticipants,
  currentParkedTaskRuntimeRoutingFacts,
  lockCurrentParkedTaskAuthority,
  parkedTaskRuntimeNamespaceParticipantsMatch,
  withParkedTaskRuntimeRestrictedAuthority,
  type ParkedTaskRuntimeCurrentRoutingFacts,
  type ParkedTaskRuntimeExpectedNamespaceParticipants,
  type ParkedTaskRuntimeLockedRoutingTask,
  type ParkedTaskRuntimeContinuation,
} from "./parked-task-runtime-authority.ts";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

export type {
  ParkedTaskRuntimeCurrentRoutingFacts,
  ParkedTaskRuntimeExpectedNamespaceParticipants,
} from "./parked-task-runtime-authority.ts";

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

type LockedTaskRuntimeRoutingRow = Readonly<{
  id: string;
  owner_id: string;
  requestor_id: string;
  agent_id: string;
  calling_room_id: string | null;
  schedule_kind: "now" | "one_shot" | "cron";
  preset: string;
  target_user_ids: unknown;
  content_namespace_id: string;
  content_representation: "ordinary" | "dual" | "protected";
  content_revision: number;
  crypto_object_id: string | null;
  crypto_access_revision: number;
  crypto_required_namespace_fingerprint: Uint8Array | null;
  use_scope: boolean;
  scope_id: string | null;
  target_chat: string;
  target_room_id: string | null;
  wide_bring_back: boolean;
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

type TaskNamespaceAuthorityCommonInput = Readonly<{
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
  expectedPolicyRevision: number;
}>;

type InitialTaskRuntimeNamespaceInput = TaskNamespaceAuthorityCommonInput &
  Readonly<{
  targetRoomId: string;
  namespaceIds: readonly string[];
  scopeMemory?: TaskScopeMemoryBinding;
}>;

export type TaskContentNamespaceAuthorityInput =
  TaskNamespaceAuthorityCommonInput;

export type TaskDeliveryNamespaceAuthorityInput =
  TaskNamespaceAuthorityCommonInput & Readonly<{
    destinationRoomId: string;
    destinationNamespaceId: string;
  }>;

type TaskTerminalProductProof = Readonly<{
  validateCurrentTaskRun(
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
    task: LockedTaskRuntimeRoutingRow,
  ): Promise<boolean>;
}>;

export type TaskOutputAdditionalMutationDestination = Readonly<{
  roomId: string;
  namespaceId: string;
  /** Canonical sealed semantic requirement digest, never a source-read authority. */
  semanticDigest: string;
}>;

export type TaskOutputNamespaceAuthorityInput = TaskDeliveryNamespaceAuthorityInput &
  TaskTerminalProductProof & Readonly<{
    workKind: "task.deliver_result" | "task.delivery_wake";
    workId: string;
    requestId: string;
    taskRunId: string;
    episodeId: string;
    foregroundNamespaceIds: readonly string[];
    projectionDestination?: Readonly<{ roomId: string; namespaceId: string }>;
    /** Locks destination metadata without granting its Namespace or Domain. */
    projectionPlanningOnly?: true;
    additionalMutationDestination?: TaskOutputAdditionalMutationDestination;
    validateCurrentAdditionalMutationDestination?(
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
      destination: TaskOutputAdditionalMutationDestination,
    ): Promise<boolean>;
    validateCurrentProjectionDestination?(
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
    ): Promise<boolean>;
    /** Additional canonical Scope/invocation inventory validation, after Room locks. */
    validateCurrentForeground(
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
      coordinates: Readonly<{ destinationRoomId: string; destinationNamespaceId: string;
        foregroundNamespaceIds: readonly string[] }>,
    ): Promise<boolean>;
  }>;

export type TaskOutputNamespaceAuthority = InitialTaskRuntimeNamespaceAuthority & Readonly<{
  resultFact: InitialTaskRuntimeNamespaceFact;
  foregroundFacts: readonly InitialTaskRuntimeNamespaceFact[];
  additionalMutationFact?: Readonly<{
    destination: TaskOutputAdditionalMutationDestination;
    namespace: InitialTaskRuntimeNamespaceFact;
  }>;
}>;

type TaskRuntimeProductAuthorityInput =
  | (InitialTaskRuntimeNamespaceInput & Readonly<{
      purpose: "initial_execution";
    }>)
  | (TaskContentNamespaceAuthorityInput & Readonly<{
      purpose: "content_only";
      namespaceIds: readonly [string];
    }>)
  | (TaskDeliveryNamespaceAuthorityInput & Readonly<{
      purpose: "terminal_delivery";
      namespaceIds: readonly [string];
    }>)
  | (TaskOutputNamespaceAuthorityInput & Readonly<{ purpose: "output_result_read"; namespaceIds: readonly string[] }>);

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function snapshotTaskRuntimeProductAuthority(input: TaskRuntimeProductAuthorityInput): TaskRuntimeProductAuthorityInput {
  if (input.purpose === "initial_execution") return Object.freeze({ ...input,
    namespaceIds: Object.freeze([...input.namespaceIds]),
    ...(input.scopeMemory === undefined ? {} : { scopeMemory: copyTaskScopeMemoryBinding(input.scopeMemory) }),
  });
  if (input.purpose === "output_result_read") return Object.freeze({ ...input,
    namespaceIds: outputNamespaceIds(input),
    foregroundNamespaceIds: Object.freeze([...input.foregroundNamespaceIds]),
    ...(input.additionalMutationDestination === undefined ? {} : {
      additionalMutationDestination: Object.freeze({ ...input.additionalMutationDestination }),
    }),
    ...(input.projectionDestination === undefined ? {} : {
      projectionDestination: Object.freeze({ ...input.projectionDestination }),
    }),
  });
  return Object.freeze({ ...input, namespaceIds: Object.freeze([
    input.purpose === "terminal_delivery" ? input.destinationNamespaceId : input.contentNamespaceId,
  ] as const) });
}

async function withInitialTaskRuntimeProductAuthority<Value>(
  input: TaskRuntimeProductAuthorityInput,
  use: (
    restricted: PostgresJsBridgeConnection,
    accessRevisions: readonly number[],
    policyRevision: number,
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
  ) => Promise<Value | null>,
  validateCurrentTaskRun?: (
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
    task: LockedTaskRuntimeRoutingRow,
  ) => Promise<boolean>,
  expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants,
): Promise<Value | null> {
  const request = snapshotTaskRuntimeProductAuthority(input);
  const coordinateIds = [request.taskId, request.requesterUserId,
    request.requesterHumanId, request.agentId, request.contentNamespaceId,
    request.sourceRoomId,
    ...(request.purpose === "initial_execution"
      ? [request.targetRoomId]
      : request.purpose === "terminal_delivery" || request.purpose === "output_result_read"
        ? [request.destinationRoomId, request.destinationNamespaceId]
        : [])];
  if (request.purpose === "output_result_read" && (
    !UUID.test(request.taskRunId) || !UUID.test(request.episodeId)
    || request.workId !== (request.workKind === "task.deliver_result" ? request.taskRunId : protectedTaskRunWakeJobId(request.taskRunId))
    || request.requestId !== (request.workKind === "task.deliver_result"
      ? `task-run-delivery-result-authorization:${request.taskRunId}` : `task-wake-authorization:${request.workId}`)
    || (request.workKind !== "task.deliver_result" && request.workKind !== "task.delivery_wake")
    || typeof request.validateCurrentForeground !== "function" || typeof validateCurrentTaskRun !== "function"
    || request.foregroundNamespaceIds.length < 1
    || request.projectionDestination !== undefined && (
      request.workKind !== "task.delivery_wake"
      || !UUID.test(request.projectionDestination.roomId)
      || !UUID.test(request.projectionDestination.namespaceId)
      || (request.projectionPlanningOnly !== true && !request.foregroundNamespaceIds.includes(request.projectionDestination.namespaceId)
        && (request.additionalMutationDestination?.namespaceId !== request.projectionDestination.namespaceId
          || request.additionalMutationDestination.roomId !== request.projectionDestination.roomId))
      || typeof request.validateCurrentProjectionDestination !== "function"
    )
    || request.projectionPlanningOnly !== undefined && (request.projectionPlanningOnly !== true
      || request.projectionDestination === undefined || request.workKind !== "task.delivery_wake")
    || request.additionalMutationDestination !== undefined && (
      request.workKind !== "task.delivery_wake"
      || !UUID.test(request.additionalMutationDestination.roomId)
      || !UUID.test(request.additionalMutationDestination.namespaceId)
      || !/^[0-9a-f]{64}$/u.test(request.additionalMutationDestination.semanticDigest)
      || request.additionalMutationDestination.namespaceId === request.contentNamespaceId
      || request.foregroundNamespaceIds.includes(request.additionalMutationDestination.namespaceId)
      || typeof request.validateCurrentAdditionalMutationDestination !== "function"
    )
    || !request.foregroundNamespaceIds.includes(request.destinationNamespaceId)
    || (request.workKind === "task.deliver_result" && request.foregroundNamespaceIds.length !== 1)
    || request.foregroundNamespaceIds.some((id, index) => !UUID.test(id)
      || index > 0 && request.foregroundNamespaceIds[index - 1]! >= id)
  )) throw new TypeError("Task output authority coordinates are invalid");
  if (coordinateIds
    .some((value) => !UUID.test(value))
    || !Number.isSafeInteger(request.expectedPolicyRevision)
    || request.expectedPolicyRevision < 0
    || request.namespaceIds.length < 1
    || request.namespaceIds.length > LATTICE_LIMITS.agentGrantNamespaces
    || (request.purpose === "terminal_delivery"
      ? request.namespaceIds.length !== 1
        || request.namespaceIds[0] !== request.destinationNamespaceId
        || typeof validateCurrentTaskRun !== "function"
      : !request.namespaceIds.includes(request.contentNamespaceId))
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
        owner_id: tasks.ownerId,
        requestor_id: tasks.requestorId,
        agent_id: tasks.agentId,
        calling_room_id: tasks.callingRoomId,
        schedule_kind: tasks.scheduleKind,
        preset: tasks.preset,
        target_user_ids: tasks.targetUserIds,
        content_namespace_id: tasks.contentNamespaceId,
        content_representation: tasks.contentRepresentation,
        content_revision: tasks.contentRevision,
        crypto_object_id: tasks.cryptoObjectId,
        crypto_access_revision: tasks.cryptoAccessRevision,
        crypto_required_namespace_fingerprint:
          tasks.cryptoRequiredNamespaceFingerprint,
        use_scope: tasks.useScope,
        scope_id: tasks.scopeId,
        target_chat: tasks.targetChat,
        target_room_id: tasks.targetRoomId,
        wide_bring_back: sql<boolean>`(${tasks.metadata} -> 'bringBack') IS DISTINCT FROM 'false'::jsonb`
          .mapWith(Boolean).as("wide_bring_back"),
      }).from(tasks).where(eq(tasks.id, request.taskId)).limit(2)
        // Exclude Task edits/deletes while permitting FK-only usage accounting.
        .for("no key update"));
    const task = taskRows[0];
    if (taskRows.length !== 1 || task === undefined
      || task.id !== request.taskId
      || task.requestor_id !== request.requesterUserId
      || task.agent_id !== request.agentId
      || task.content_namespace_id !== request.contentNamespaceId
      || request.purpose === "initial_execution" && (
        !["last_in_namespace", "new_in_namespace", "last_dm", "new_dm",
          "orphan"].includes(task.target_chat)
        || task.target_room_id !== request.targetRoomId
        || (task.use_scope !== true && task.use_scope !== false)
        || (task.use_scope
          ? task.scope_id === null
            || request.scopeMemory === undefined
            || request.scopeMemory.scopeId !== task.scope_id
            || request.scopeMemory.memoryRoomId
              !== (task.target_chat === "orphan"
                ? request.sourceRoomId
                : task.target_room_id)
            || request.scopeMemory.readableNamespaceIds.some(
              namespaceId => !request.namespaceIds.includes(namespaceId),
            )
          : request.scopeMemory !== undefined))
      || (task.content_representation !== "protected"
        && task.content_representation !== "dual")) return null;
    // The caller holds its exact Run/output proof for the entire Namespace
    // callback, including recipient binding before a signed request exists.
    if (validateCurrentTaskRun !== undefined
      && !await validateCurrentTaskRun(
        product,
        tx,
        task as LockedTaskRuntimeRoutingRow,
      )) return null;
    return new PostgresNamespaceProductAuthority(product)
      .withCurrentReadableNamespaceSet({
        subjectUserId: request.requesterUserId,
        subjectHumanId: request.requesterHumanId,
        sourceRoomId: request.sourceRoomId,
        namespaceIds: request.namespaceIds,
        ...(request.purpose === "terminal_delivery" || request.purpose === "output_result_read" ? {
          destinationRoom: {
            roomId: request.destinationRoomId,
            namespaceId: request.destinationNamespaceId,
          },
        } : {}),
        ...(request.purpose !== "output_result_read" || request.projectionDestination === undefined ? {} : {
          ...(request.projectionPlanningOnly === true
            ? { planningDestinationRoom: request.projectionDestination }
            : { additionalDestinationRoom: request.projectionDestination }),
        }),
        ...(request.purpose !== "output_result_read" || request.additionalMutationDestination === undefined ? {} : {
          mutationDestinationRoom: request.additionalMutationDestination,
        }),
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
            || members.filter((member) => member.kind === "agent").length !== 1) return null;
          if (entries.length !== request.namespaceIds.length) return null;
          const accessRevisions: number[] = [];
          for (const [index, entry] of entries.entries()) {
            const snapshot = inspectNamespaceProductAuthoritySnapshot(entry.authority);
            try {
              if (entry.namespaceId !== request.namespaceIds[index]
                || snapshot.namespaceId !== entry.namespaceId
                || snapshot.subjectHumanId !== request.requesterHumanId
                || !parkedTaskRuntimeNamespaceParticipantsMatch(
                  entry.namespaceId,
                  snapshot.participantHumanIds,
                  expectedNamespaceParticipants,
                )) return null;
              accessRevisions.push(snapshot.accessRevision);
            } finally {
              snapshot.audienceFingerprint.fill(0);
            }
          }
          if (request.purpose === "terminal_delivery" || request.purpose === "output_result_read") {
            // All membership rows are already locked. Check the exact Agent,
            // not merely the presence of some Agent in this audience.
            const destinationMembers = await executeTypedConversationProductQuery(
              product,
              conversationProductTypedDb.select({
                actor_id: actors.id,
                kind: actors.kind,
                agent_id: actors.agentId,
                owner_id: actors.ownerId,
              }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
                .where(eq(roomMembers.roomId, request.destinationRoomId))
                .orderBy(asc(actors.id)).for("share", { of: actors }),
            );
            if (destinationMembers.filter(member => member.kind === "user"
              && member.id === request.requesterHumanId
              && member.owner_id === request.requesterUserId).length !== 1
              || destinationMembers.filter(member => member.kind === "agent"
                && member.agent_id === request.agentId).length !== 1) return null;
          }
          if (request.purpose === "output_result_read") {
            if (request.projectionDestination !== undefined) {
              if (!await request.validateCurrentProjectionDestination!(product, tx)) return null;
            }
            const destinationRows = await executeTypedConversationProductQuery(product,
              conversationProductTypedDb.select({
                id: rooms.id,
                effective_human_actor_ids: moderationEffectiveHumanActorIdsSql(sql`${rooms.humanActorIds}`, sql`${rooms.id}`)
                  .as("effective_human_actor_ids"),
              }).from(rooms).where(eq(rooms.id, request.destinationRoomId)).limit(2));
            const destination = destinationRows[0];
            const humans = destination?.effective_human_actor_ids;
            if (destinationRows.length !== 1 || destination?.id !== request.destinationRoomId
              || !Array.isArray(humans) || humans.length === 0
              || !humans.includes(request.requesterHumanId)
              || !await readableNamespacePolicyAllows(product, {
                sourceRoomId: request.destinationRoomId, sourceHumanIds: humans,
                namespaceIds: request.foregroundNamespaceIds,
              })
              || !await request.validateCurrentForeground(product, tx, {
                destinationRoomId: request.destinationRoomId,
                destinationNamespaceId: request.destinationNamespaceId,
                foregroundNamespaceIds: request.foregroundNamespaceIds,
              })) return null;
            if (request.additionalMutationDestination !== undefined
              && !await request.validateCurrentAdditionalMutationDestination!(product, tx,
                request.additionalMutationDestination)) return null;
          }
          if (request.purpose === "initial_execution"
            && request.scopeMemory !== undefined) {
            const memoryRoomRows = await executeTypedConversationProductQuery(
              product,
              conversationProductTypedDb.select({
                id: rooms.id,
                namespace_id: rooms.namespaceId,
                archived_at: rooms.archivedAt,
              }).from(rooms).where(eq(
                rooms.id,
                request.scopeMemory.memoryRoomId,
              )).limit(2).for("share"),
            );
            const memoryRoom = memoryRoomRows[0];
            if (memoryRoomRows.length !== 1 || memoryRoom === undefined
              || memoryRoom.id !== request.scopeMemory.memoryRoomId
              || memoryRoom.namespace_id
                !== request.scopeMemory.originWritableNamespaceId
              || memoryRoom.archived_at !== null) return null;

            // Namespace/source locks precede the Scope SHARE fence. Scope attach
            // and detach take Scope UPDATE, so this locked inventory remains
            // fixed through the later restricted Domain work.
            const currentScopeMemory =
              await readCurrentTaskScopeMemoryNamespaceInventory({
                transaction: product,
                coordinates: {
                  taskId: task.id,
                  requesterUserId: task.requestor_id,
                  agentId: task.agent_id,
                  scopeId: request.scopeMemory.scopeId,
                  memoryRoomId: request.scopeMemory.memoryRoomId,
                  originWritableNamespaceId:
                    request.scopeMemory.originWritableNamespaceId,
                },
                sourceRoomId: request.sourceRoomId,
                requesterHumanId: request.requesterHumanId,
              });
            if (currentScopeMemory === null
              || currentScopeMemory.scopeId !== request.scopeMemory.scopeId
              || currentScopeMemory.originWritableNamespaceId
                !== request.scopeMemory.originWritableNamespaceId
              || !sameIds(
                currentScopeMemory.readableNamespaceIds,
                request.scopeMemory.readableNamespaceIds,
              )) return null;
          }
          return request.restricted.transactionOnce(async (restrictedTx) => {
            const restricted = inTransaction(restrictedTx);
            await verifyCryptoPostgresHandle(restricted);
            const value = await use(
              restricted,
              accessRevisions,
              policy.revision,
              product,
              tx,
            );
            if (request.purpose === "output_result_read"
              && (!await request.validateCurrentTaskRun(product, tx, task as LockedTaskRuntimeRoutingRow)
                || !await request.validateCurrentForeground(product, tx, {
                  destinationRoomId: request.destinationRoomId,
                  destinationNamespaceId: request.destinationNamespaceId,
                  foregroundNamespaceIds: request.foregroundNamespaceIds,
                })
                || request.additionalMutationDestination !== undefined
                  && !await request.validateCurrentAdditionalMutationDestination!(product, tx,
                    request.additionalMutationDestination)
                || request.projectionDestination !== undefined
                  && !await request.validateCurrentProjectionDestination!(product, tx))) throw new Error("Task output product authority changed before commit");
            return value;
          }, { isolationLevel: "read committed" });
        },
      });
  }, { isolationLevel: "read committed" });
}

async function withTaskRuntimeNamespaceAuthority<Value>(
  input: TaskRuntimeProductAuthorityInput,
  validateCurrentTaskRun: ((
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
    task: LockedTaskRuntimeRoutingRow,
  ) => Promise<boolean>) | undefined,
  use: (
    authority: InitialTaskRuntimeNamespaceAuthority,
    restricted: PostgresJsBridgeConnection,
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
  ) => Value | Promise<Value>,
  onNamespaceReadinessUnavailable?: (namespaceId: string) => void,
  expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants,
): Promise<Value | null> {
  const request = snapshotTaskRuntimeProductAuthority(input);
  return withInitialTaskRuntimeProductAuthority(
    request,
    async (
      restricted,
      accessRevisions,
      policyRevision,
      product,
      transaction,
    ) => {
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
          if (authority.status !== "ready") {
            if (authority.reason === "namespace_bundle_unavailable") {
              onNamespaceReadinessUnavailable?.(namespaceId);
            }
            return null;
          }
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
          const generation = readCryptoStorageInteger(head, "domain_key_generation");
          const authorizationRevision = readCryptoStorageInteger(head, "authorization_revision");
          for (const authority of byDomain.get(domainId)!) {
            if (generation !== authority.domainKeyGeneration
              || authorizationRevision !== authority.domainAuthorizationRevision
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
        const authority = Object.freeze({ sourceRoomId: request.purpose === "terminal_delivery" || request.purpose === "output_result_read"
          ? request.destinationRoomId : request.sourceRoomId,
          sourceNamespaceId: request.contentNamespaceId,
          facts: Object.freeze(facts) });
        return await use(authority, restricted, product, transaction);
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
    validateCurrentTaskRun,
    expectedNamespaceParticipants,
  );
}

function normalizeLockedTaskRuntimeRouting(
  task: LockedTaskRuntimeRoutingRow,
): ParkedTaskRuntimeLockedRoutingTask {
  return Object.freeze({
    id: task.id,
    ownerId: task.owner_id,
    requestorId: task.requestor_id,
    agentId: task.agent_id,
    callingRoomId: task.calling_room_id,
    scheduleKind: task.schedule_kind,
    contentRepresentation: task.content_representation,
    contentNamespaceId: task.content_namespace_id,
    contentRevision: task.content_revision,
    cryptoObjectId: task.crypto_object_id,
    cryptoAccessRevision: task.crypto_access_revision,
    cryptoRequiredNamespaceFingerprint:
      task.crypto_required_namespace_fingerprint,
    preset: task.preset,
    targetUserIds: task.target_user_ids,
    useScope: task.use_scope,
    scopeId: task.scope_id,
    targetChat: task.target_chat,
    targetRoomId: task.target_room_id,
    wideBringBack: task.wide_bring_back,
  });
}

async function inspectTaskRuntimeNamespaceAuthority(
  input: TaskRuntimeProductAuthorityInput,
): Promise<InitialTaskRuntimeNamespaceAuthority | null> {
  return withTaskRuntimeNamespaceAuthority(
    input,
    undefined,
    authority => authority,
  );
}

/** Detached planning facts; never a substitute for operation-time authority. */
export async function inspectInitialTaskRuntimeNamespaceAuthority(
  input: InitialTaskRuntimeNamespaceInput,
): Promise<InitialTaskRuntimeNamespaceAuthority | null> {
  return inspectTaskRuntimeNamespaceAuthority(Object.freeze({
    ...input,
    purpose: "initial_execution" as const,
  }));
}

/** Current requester-private Task content authority, independent of Memory. */
export async function inspectTaskContentNamespaceAuthority(
  input: TaskContentNamespaceAuthorityInput,
): Promise<InitialTaskRuntimeNamespaceAuthority | null> {
  return inspectTaskRuntimeNamespaceAuthority(Object.freeze({
    ...input,
    purpose: "content_only" as const,
    namespaceIds: Object.freeze([input.contentNamespaceId] as const),
  }));
}

/** Destination-only planning facts under the caller's exact terminal proof. */
export async function inspectTaskDeliveryNamespaceAuthority(
  input: TaskDeliveryNamespaceAuthorityInput & TaskTerminalProductProof,
): Promise<InitialTaskRuntimeNamespaceAuthority | null> {
  return withTaskDeliveryNamespaceAuthority({ ...input, use: authority => authority });
}

/** Holds private source provenance and current delivery authority together. */
export async function withTaskDeliveryNamespaceAuthority<Value>(
  input: TaskDeliveryNamespaceAuthorityInput & TaskTerminalProductProof & Readonly<{
    use(
      authority: InitialTaskRuntimeNamespaceAuthority,
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
      restricted: PostgresJsBridgeConnection,
    ): Value | Promise<Value>;
  }>,
): Promise<Value | null> {
  const { validateCurrentTaskRun, use, ...coordinates } = input;
  if (typeof validateCurrentTaskRun !== "function" || typeof use !== "function") return null;
  return withTaskRuntimeNamespaceAuthority(
    Object.freeze({ ...coordinates, purpose: "terminal_delivery" as const,
      namespaceIds: Object.freeze([coordinates.destinationNamespaceId] as const) }),
    validateCurrentTaskRun,
    (authority, restricted, product, transaction) =>
      use(authority, product, transaction, restricted),
  );
}

/**
 * Current requester-private Task content authority held with caller-supplied
 * exact product proof. Product mutations remain inside the same canonical
 * transaction and held Namespace/Domain authority callback.
 */
export async function withTaskContentNamespaceAuthority<Value>(
  input: TaskContentNamespaceAuthorityInput & Readonly<{
    validateCurrentTaskRun(
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
      task: LockedTaskRuntimeRoutingRow,
    ): Promise<boolean>;
    use(
      authority: InitialTaskRuntimeNamespaceAuthority,
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
      restricted: PostgresJsBridgeConnection,
    ): Value | Promise<Value>;
  }>,
): Promise<Value | null> {
  const validateCurrentTaskRun = input.validateCurrentTaskRun;
  const use = input.use;
  if (typeof validateCurrentTaskRun !== "function"
    || typeof use !== "function") return null;
  const {
    validateCurrentTaskRun: _validateCurrentTaskRun,
    use: _use,
    ...coordinates
  } = input;
  return withTaskRuntimeNamespaceAuthority(
    Object.freeze({
      ...coordinates,
      purpose: "content_only" as const,
      namespaceIds: Object.freeze([coordinates.contentNamespaceId] as const),
    }),
    validateCurrentTaskRun,
    (authority, restricted, product, transaction) =>
      use(authority, product, transaction, restricted),
  );
}

/**
 * Current Namespace and Domain authority held under the exact parked lifecycle
 * proof. The restricted handle is valid only for the callback lifetime.
 */
export async function withParkedTaskRuntimeNamespaceAuthority<Value>(
  input: InitialTaskRuntimeNamespaceInput & Readonly<{
    expected: ParkedTaskRuntimeContinuation;
    authorizationRequestId: string;
    validateCurrentRouting(
      facts: ParkedTaskRuntimeCurrentRoutingFacts,
    ): boolean | Promise<boolean>;
    onNamespaceReadinessUnavailable?(namespaceId: string): void;
    expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants;
    use(
      authority: InitialTaskRuntimeNamespaceAuthority,
      restricted: PostgresJsBridgeConnection,
    ): Value | Promise<Value>;
  }>,
): Promise<Value | null> {
  const use = input.use;
  const validateCurrentRouting = input.validateCurrentRouting;
  const onNamespaceReadinessUnavailable =
    input.onNamespaceReadinessUnavailable;
  const suppliedNamespaceParticipants = input.expectedNamespaceParticipants;
  let expectedNamespaceParticipants:
    ParkedTaskRuntimeExpectedNamespaceParticipants | undefined;
  if (suppliedNamespaceParticipants !== undefined) {
    const copied = copyParkedTaskRuntimeExpectedNamespaceParticipants(
      suppliedNamespaceParticipants,
    );
    if (copied === null) return null;
    expectedNamespaceParticipants = copied;
  }
  const namespaceIds = Object.freeze([...input.namespaceIds]);
  const expected = copyParkedTaskRuntimeAuthority(input.expected);
  const authorizationRequestId = input.authorizationRequestId;
  if (typeof use !== "function"
    || typeof validateCurrentRouting !== "function"
    || (onNamespaceReadinessUnavailable !== undefined
      && typeof onNamespaceReadinessUnavailable !== "function")
    || expectedNamespaceParticipants?.some(value =>
      !namespaceIds.includes(value.namespaceId)) === true
    || authorizationRequestId !== expected.authorizationRequestId
    || input.taskId !== expected.occurrence.task.id
    || input.requesterUserId !== expected.occurrence.task.requestorId
    || input.agentId !== expected.occurrence.task.agentId
    || input.contentNamespaceId
      !== expected.occurrence.task.contentNamespaceId) return null;
  const {
    expected: _expected,
    authorizationRequestId: _authorizationRequestId,
    validateCurrentRouting: _validateCurrentRouting,
    onNamespaceReadinessUnavailable: _onNamespaceReadinessUnavailable,
    expectedNamespaceParticipants: _expectedNamespaceParticipants,
    use: _use,
    ...coordinates
  } = input;
  return withTaskRuntimeNamespaceAuthority(
    Object.freeze({
      ...coordinates,
      namespaceIds,
      purpose: "initial_execution" as const,
    }),
    async (_product, transaction, task) => {
      const current = await lockCurrentParkedTaskAuthority({
        transaction,
        expected,
      });
      if (current === null) return false;
      const facts = currentParkedTaskRuntimeRoutingFacts({
        sourceRoomId: coordinates.sourceRoomId,
        targetRoomId: coordinates.targetRoomId,
        task: normalizeLockedTaskRuntimeRouting(task),
        current,
      });
      return facts !== null && await validateCurrentRouting(facts);
    },
    (authority, restricted) => withParkedTaskRuntimeRestrictedAuthority(
      restricted,
      scoped => Promise.resolve(use(authority, scoped)),
    ),
    onNamespaceReadinessUnavailable,
    expectedNamespaceParticipants ?? undefined,
  );
}

export type InitialTaskRuntimeRecipientAuthority = Readonly<{
  sourceRoomId: string;
  sourceNamespaceId: string;
  device: CurrentDeviceAdmissionAuthority;
  domains: readonly DomainForegroundAuthorityEntry[];
  namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  policyRevision: number;
  scopeMemory?: TaskScopeMemoryBinding;
}>;

type TaskRuntimeRecipientAuthorityInput =
  InitialTaskRuntimeNamespaceInput & Readonly<{
    deviceId: string;
    namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
    domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
    signal?: AbortSignal;
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

/** Shared awaiting-phase authority pipeline for initial and parked requests. */
async function withTaskRuntimeRecipientAuthority<Value>(
  input: Omit<TaskRuntimeRecipientAuthorityInput, "targetRoomId"> & Readonly<{ targetRoomId?: string }>,
  validateCurrentTaskRun: (
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
    task: LockedTaskRuntimeRoutingRow,
  ) => Promise<boolean>,
  use: (
    authority: InitialTaskRuntimeRecipientAuthority,
    restricted: PostgresJsBridgeConnection,
    request: Omit<TaskRuntimeRecipientAuthorityInput, "targetRoomId"> & Readonly<{ targetRoomId?: string }>,
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
  ) => Value | Promise<Value>,
  expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants,
  terminalPurpose?: Readonly<{ purpose: "content_only" }> | Readonly<{
    purpose: "terminal_delivery";
    destinationRoomId: string;
    destinationNamespaceId: string;
  }> | (TaskOutputNamespaceAuthorityInput & Readonly<{ purpose: "output_result_read" }>),
): Promise<Value | null> {
  const terminal = terminalPurpose === undefined ? undefined : Object.freeze({ ...terminalPurpose });
  const terminalNamespaceId = terminal?.purpose === "terminal_delivery"
    ? terminal.destinationNamespaceId : input.contentNamespaceId;
  const namespaces = Object.freeze(input.namespaceRequirements.map((entry) => Object.freeze({
    ...entry, operations: Object.freeze([...entry.operations]),
  })));
  const domains = Object.freeze(input.domainRequirements.map((entry) => Object.freeze({ ...entry })));
  const request = Object.freeze({
    ...input,
    namespaceIds: Object.freeze([...input.namespaceIds]),
    ...(input.scopeMemory === undefined
      ? {}
      : { scopeMemory: copyTaskScopeMemoryBinding(input.scopeMemory) }),
  });
  if (typeof validateCurrentTaskRun !== "function"
    || (terminal !== undefined && terminal.purpose !== "output_result_read" && (namespaces.length !== 1 || domains.length !== 1
      || namespaces[0]?.namespaceId !== terminalNamespaceId
      || namespaces[0]?.operations.length !== 1
      || namespaces[0]?.operations[0] !== "encrypt"))
    || request.deviceId.length === 0 || namespaces.length !== request.namespaceIds.length
    || namespaces.some((entry, index) => entry.ordinal !== index
      || entry.namespaceId !== request.namespaceIds[index]
      || !Number.isSafeInteger(entry.expectedAccessRevision) || entry.expectedAccessRevision < 0
      || entry.expectedPolicyRevision !== request.expectedPolicyRevision
      || (terminal === undefined && entry.namespaceId === request.contentNamespaceId
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
  const productInput: TaskRuntimeProductAuthorityInput = terminal?.purpose === "output_result_read"
    ? Object.freeze({ ...request, ...terminal, namespaceIds: request.namespaceIds })
    : terminal !== undefined
    ? Object.freeze({ ...request, ...terminal,
        namespaceIds: Object.freeze([terminalNamespaceId] as const) })
    : Object.freeze({ ...request, purpose: "initial_execution" as const,
        targetRoomId: request.targetRoomId! });
  return withInitialTaskRuntimeProductAuthority(productInput,
    async (restricted, accessRevisions, policyRevision, product, transaction) => {
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
      // The native inspector's hostAuthorizationRevision is the device-row
      // projection revision. Task recipient admission is instead bound to the
      // group securityRevision re-read below; these counters may differ.
      if (inspected.committerDeviceId !== device.deviceId
        || inspected.committerDeviceSigningGeneration !== device.deviceGeneration
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
      const value = await use(Object.freeze({ sourceRoomId: terminal?.purpose === "terminal_delivery" || terminal?.purpose === "output_result_read"
        ? terminal.destinationRoomId : request.sourceRoomId,
        sourceNamespaceId: request.contentNamespaceId, device: Object.freeze(lockedDevice),
        domains: inspected.domains, namespaceRequirements: namespaces, policyRevision,
        ...(request.scopeMemory === undefined
          ? {}
          : { scopeMemory: request.scopeMemory }) }), restricted, request, product, transaction);
      request.signal?.throwIfAborted();
      return value;
    } finally { for (const bytes of owned) bytes.fill(0); }
  }, validateCurrentTaskRun, expectedNamespaceParticipants);
}

/** Encrypt-only recipient authority for a stopped Task's fixed cancellation result. */
export async function withTaskContentRecipientAuthority<Value>(
  input: TaskContentNamespaceAuthorityInput & Readonly<{
    deviceId: string;
    namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
    domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
    signal?: AbortSignal;
    validateCurrentTaskRun(
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
    ): Promise<boolean>;
    use(
      authority: InitialTaskRuntimeRecipientAuthority,
      restricted: PostgresJsBridgeConnection,
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
    ): Value | Promise<Value>;
    validateBeforeCommit?(): void | Promise<void>;
  }>,
): Promise<Value | null> {
  const use = input.use;
  const validate = input.validateCurrentTaskRun;
  const beforeCommit = input.validateBeforeCommit;
  return withTaskRuntimeRecipientAuthority(
    { ...input, namespaceIds: [input.contentNamespaceId] },
    (product, transaction) => validate(product, transaction),
    async (authority, restricted, _request, product, transaction) => {
      const result = await withParkedTaskRuntimeRestrictedAuthority(restricted,
        scoped => Promise.resolve(use(authority, scoped, product, transaction)));
      await beforeCommit?.();
      return result;
    },
    undefined,
    { purpose: "content_only" },
  );
}

/** Current device/Domain custody for one encrypt-only delivery Namespace. */
export async function withTaskDeliveryRecipientAuthority<Value>(
  input: TaskDeliveryNamespaceAuthorityInput & TaskTerminalProductProof & Readonly<{
    deviceId: string;
    namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
    domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
    signal?: AbortSignal;
    use(
      authority: InitialTaskRuntimeRecipientAuthority,
      restricted: PostgresJsBridgeConnection,
      product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx,
    ): Value | Promise<Value>;
    validateBeforeCommit?(): void | Promise<void>;
  }>,
): Promise<Value | null> {
  const { use, validateCurrentTaskRun, validateBeforeCommit } = input;
  if (typeof use !== "function" || typeof validateCurrentTaskRun !== "function"
    || validateBeforeCommit !== undefined && typeof validateBeforeCommit !== "function") return null;
  return withTaskRuntimeRecipientAuthority(
    { ...input, namespaceIds: [input.destinationNamespaceId] },
    validateCurrentTaskRun,
    async (authority, restricted, _request, product, transaction) => {
      const result = await withParkedTaskRuntimeRestrictedAuthority(restricted,
        scoped => Promise.resolve(use(authority, scoped, product, transaction)));
      await validateBeforeCommit?.();
      return result;
    },
    undefined,
    { purpose: "terminal_delivery", destinationRoomId: input.destinationRoomId,
      destinationNamespaceId: input.destinationNamespaceId },
  );
}

export async function withInitialTaskRuntimeRecipientAuthority<Value>(
  input: TaskRuntimeRecipientAuthorityInput & Readonly<{
    validateCurrentTaskRun(
      product: PostgresJsBridgeConnection,
    ): Promise<boolean>;
    use(
      authority: InitialTaskRuntimeRecipientAuthority,
      restricted: PostgresJsBridgeConnection,
    ): Value | Promise<Value>;
    /** Runs after scoped restricted operations drain, before the owner commits. */
    validateBeforeCommit?(): void | Promise<void>;
  }>,
): Promise<Value | null> {
  const validateCurrentTaskRun = input.validateCurrentTaskRun;
  const use = input.use;
  const validateBeforeCommit = input.validateBeforeCommit;
  if (validateBeforeCommit !== undefined
    && typeof validateBeforeCommit !== "function") return null;
  return withTaskRuntimeRecipientAuthority(
    input,
    product => validateCurrentTaskRun(product),
    async (authority, restricted, request) => {
      const value = await withParkedTaskRuntimeRestrictedAuthority(
        restricted,
        scoped => Promise.resolve(Reflect.apply(use, request, [authority, scoped])),
      );
      await validateBeforeCommit?.();
      return value;
    },
  );
}

/**
 * Continuation recipient construction under the exact parked lifecycle proof.
 * The proof is locked and re-parsed before any Namespace or crypto authority.
 */
export async function withParkedTaskRuntimeRecipientAuthority<Value>(
  input: TaskRuntimeRecipientAuthorityInput & Readonly<{
    expected: ParkedTaskRuntimeContinuation;
    authorizationRequestId: string;
    validateCurrentRouting(
      facts: ParkedTaskRuntimeCurrentRoutingFacts,
    ): boolean | Promise<boolean>;
    expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants;
    use(
      authority: InitialTaskRuntimeRecipientAuthority,
      restricted: PostgresJsBridgeConnection,
    ): Value | Promise<Value>;
  }>,
): Promise<Value | null> {
  const use = input.use;
  const validateCurrentRouting = input.validateCurrentRouting;
  const sourceRoomId = input.sourceRoomId;
  const targetRoomId = input.targetRoomId;
  const suppliedNamespaceParticipants = input.expectedNamespaceParticipants;
  let expectedNamespaceParticipants:
    ParkedTaskRuntimeExpectedNamespaceParticipants | undefined;
  if (suppliedNamespaceParticipants !== undefined) {
    const copied = copyParkedTaskRuntimeExpectedNamespaceParticipants(
      suppliedNamespaceParticipants,
    );
    if (copied === null) return null;
    expectedNamespaceParticipants = copied;
  }
  const expected = copyParkedTaskRuntimeAuthority(input.expected);
  if (typeof use !== "function" || typeof validateCurrentRouting !== "function"
    || expectedNamespaceParticipants?.some(value =>
      !input.namespaceIds.includes(value.namespaceId)) === true
    || input.authorizationRequestId !== expected.authorizationRequestId
    || input.taskId !== expected.occurrence.task.id
    || input.requesterUserId !== expected.occurrence.task.requestorId
    || input.agentId !== expected.occurrence.task.agentId
    || input.contentNamespaceId
      !== expected.occurrence.task.contentNamespaceId) return null;
  return withTaskRuntimeRecipientAuthority(
    input,
    async (_product, transaction, task) => {
      const current = await lockCurrentParkedTaskAuthority({
        transaction,
        expected,
      });
      if (current === null) return false;
      const facts = currentParkedTaskRuntimeRoutingFacts({
        sourceRoomId,
        targetRoomId,
        task: normalizeLockedTaskRuntimeRouting(task),
        current,
      });
      return facts !== null && await validateCurrentRouting(facts);
    },
    (authority, restricted) => withParkedTaskRuntimeRestrictedAuthority(
      restricted,
      scoped => Promise.resolve(use(authority, scoped)),
    ),
    expectedNamespaceParticipants,
  );
}

function outputNamespaceIds(input: TaskOutputNamespaceAuthorityInput): readonly string[] {
  return Object.freeze([...new Set([input.contentNamespaceId, ...input.foregroundNamespaceIds,
    ...(input.additionalMutationDestination === undefined ? [] : [input.additionalMutationDestination.namespaceId])])].sort());
}

function outputOperations(input: TaskOutputNamespaceAuthorityInput, namespaceId: string): readonly ("decrypt" | "encrypt")[] {
  const foreground = input.foregroundNamespaceIds.includes(namespaceId);
  return Object.freeze([
    ...(namespaceId === input.contentNamespaceId || foreground && input.workKind === "task.delivery_wake" ? ["decrypt" as const] : []),
    ...(foreground || input.additionalMutationDestination?.namespaceId === namespaceId ? ["encrypt" as const] : []),
  ]);
}

function outputRequirementsMatch(
  input: TaskOutputNamespaceAuthorityInput,
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[],
  accessRevisions?: readonly number[],
): boolean {
  const ids = outputNamespaceIds(input);
  return namespaces.length === ids.length && namespaces.every((n, index) =>
    n.ordinal === index && n.namespaceId === ids[index]
    && n.expectedPolicyRevision === input.expectedPolicyRevision
    && (accessRevisions === undefined || n.expectedAccessRevision === accessRevisions[index])
    && sameIds(n.operations, outputOperations(input, n.namespaceId)));
}

function outputFacts(input: TaskOutputNamespaceAuthorityInput, authority: InitialTaskRuntimeNamespaceAuthority): TaskOutputNamespaceAuthority {
  const resultFact = authority.facts.find(fact => fact.namespaceId === input.contentNamespaceId);
  if (resultFact === undefined) throw new TypeError("Task output result Namespace is missing");
  const mutation = input.additionalMutationDestination;
  const mutationFact = mutation === undefined ? undefined : authority.facts.find(fact => fact.namespaceId === mutation.namespaceId);
  if (mutation !== undefined && mutationFact === undefined) throw new TypeError("Task output mutation Namespace is missing");
  return Object.freeze({ ...authority, resultFact,
    ...(mutation === undefined || mutationFact === undefined ? {} : { additionalMutationFact: Object.freeze({
      destination: Object.freeze({ ...mutation }), namespace: mutationFact,
    }) }),
    foregroundFacts: Object.freeze(authority.facts.filter(fact => input.foregroundNamespaceIds.includes(fact.namespaceId))) });
}

/** Current terminal result and independent destination/foreground planning facts. */
export function inspectTaskOutputNamespaceAuthority(input: TaskOutputNamespaceAuthorityInput): Promise<TaskOutputNamespaceAuthority | null> {
  return withTaskOutputNamespaceAuthority({ ...input, use: authority => authority });
}

export function withTaskOutputNamespaceAuthority<Value>(input: TaskOutputNamespaceAuthorityInput & Readonly<{
  use(authority: TaskOutputNamespaceAuthority, product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx, restricted: PostgresJsBridgeConnection): Value | Promise<Value>;
}>): Promise<Value | null> {
  const request = Object.freeze({ ...input, foregroundNamespaceIds: Object.freeze([...input.foregroundNamespaceIds]),
    ...(input.additionalMutationDestination === undefined ? {} : {
      additionalMutationDestination: Object.freeze({ ...input.additionalMutationDestination }),
    }),
    ...(input.projectionDestination === undefined ? {} : { projectionDestination: Object.freeze({ ...input.projectionDestination }) }),
  });
  return withTaskRuntimeNamespaceAuthority({ ...request, purpose: "output_result_read",
    namespaceIds: outputNamespaceIds(request) }, request.validateCurrentTaskRun,
  (authority, restricted, product, transaction) => request.use(outputFacts(request, authority), product, transaction, restricted));
}

export type TaskOutputRecipientAuthority = InitialTaskRuntimeRecipientAuthority & Readonly<{
  resultNamespaceRequirement: TaskRuntimeNamespaceAuthorityRequirement;
  foregroundNamespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
}>;

export function withTaskOutputRecipientAuthority<Value>(input: TaskOutputNamespaceAuthorityInput & Readonly<{
  deviceId: string;
  namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
  signal?: AbortSignal;
  use(authority: TaskOutputRecipientAuthority, restricted: PostgresJsBridgeConnection,
    product: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx): Value | Promise<Value>;
  validateBeforeCommit?(): void | Promise<void>;
}>): Promise<Value | null> {
  const request = Object.freeze({ ...input, foregroundNamespaceIds: Object.freeze([...input.foregroundNamespaceIds]),
    ...(input.additionalMutationDestination === undefined ? {} : {
      additionalMutationDestination: Object.freeze({ ...input.additionalMutationDestination }),
    }),
    ...(input.projectionDestination === undefined ? {} : { projectionDestination: Object.freeze({ ...input.projectionDestination }) }),
  });
  if (!outputRequirementsMatch(request, request.namespaceRequirements)) {
    throw new TypeError("Task output recipient partitions are invalid");
  }
  return withTaskRuntimeRecipientAuthority({ ...request, namespaceIds: outputNamespaceIds(request) },
    request.validateCurrentTaskRun,
    async (authority, restricted, _request, product, transaction) => {
      const source = authority.namespaceRequirements.find(n => n.namespaceId === request.contentNamespaceId)!;
      const current = Object.freeze({ ...authority,
        resultNamespaceRequirement: Object.freeze({ ...source, operations: Object.freeze(["decrypt"] as const) }),
        foregroundNamespaceRequirements: Object.freeze(authority.namespaceRequirements
          .filter(n => request.foregroundNamespaceIds.includes(n.namespaceId))
          .map(n => Object.freeze({ ...n, operations: Object.freeze(request.workKind === "task.deliver_result"
            ? ["encrypt"] as const : ["decrypt", "encrypt"] as const) }))),
      });
      const value = await withParkedTaskRuntimeRestrictedAuthority(restricted,
        scoped => Promise.resolve(request.use(current, scoped, product, transaction)));
      await request.validateBeforeCommit?.();
      return value;
    }, undefined, { ...request, purpose: "output_result_read" });
}

declare const taskOutputProductAuthorityBrand: unique symbol;
export type TaskOutputProductAuthority = Readonly<{ readonly [taskOutputProductAuthorityBrand]: true }>;
type OutputProductContext = Readonly<{
  input: TaskOutputNamespaceAuthorityInput;
  product: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
  restricted: PostgresJsBridgeConnection;
  accessRevisions: readonly number[];
}>;
const outputProductProofs = new WeakMap<object, OutputProductContext>();

/** Product-only phase; no device, Namespace bundle or Domain locks precede use. */
export function withTaskOutputProductAuthority<Value>(input: TaskOutputNamespaceAuthorityInput & Readonly<{
  use(proof: TaskOutputProductAuthority, product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx, restricted: PostgresJsBridgeConnection): Promise<Value>;
}>): Promise<Value | null> {
  const request = Object.freeze({ ...input, foregroundNamespaceIds: Object.freeze([...input.foregroundNamespaceIds]),
    ...(input.additionalMutationDestination === undefined ? {} : {
      additionalMutationDestination: Object.freeze({ ...input.additionalMutationDestination }),
    }),
    ...(input.projectionDestination === undefined ? {} : { projectionDestination: Object.freeze({ ...input.projectionDestination }) }),
  });
  return withInitialTaskRuntimeProductAuthority({ ...request, purpose: "output_result_read",
    namespaceIds: outputNamespaceIds(request) }, async (restricted, revisions, _policy, product, transaction) => {
      const proof = Object.freeze({}) as TaskOutputProductAuthority;
      const context = Object.freeze({ input: request, product, transaction, restricted,
        accessRevisions: Object.freeze([...revisions]) });
      outputProductProofs.set(proof, context);
      try { return await request.use(proof, product, transaction, restricted); }
      finally { outputProductProofs.delete(proof); }
    }, request.validateCurrentTaskRun);
}

/** Internal common-verifier seam, deliberately absent from the server barrel. */
export async function withTaskOutputProductAuthorityContext<Value>(proof: TaskOutputProductAuthority,
  use: (context: OutputProductContext) => Promise<Value>): Promise<Value> {
  const context = outputProductProofs.get(proof);
  if (context === undefined) throw new TypeError("Task output product authority is not active");
  const value = await use(context);
  if (outputProductProofs.get(proof) !== context) throw new TypeError("Task output product authority is not active");
  return value;
}

/** Internal exact admission check; a structural copy of a proof never qualifies. */
export function assertTaskOutputProductAuthority(proof: TaskOutputProductAuthority, expected: Readonly<{
  transaction: CanonicalTranscriptTx;
  subject: Readonly<{ userId: string; humanActorId: string }>;
  request: Readonly<{ requestId: string; workId: string; workKind: string; workPurpose: string; sourceRoomId: string; episodeId: string }>;
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  policyRevision: number;
}>): void {
  const context = outputProductProofs.get(proof);
  const actual = context?.input;
  if (context === undefined || actual === undefined || context.transaction !== expected.transaction
    || actual.requesterUserId !== expected.subject.userId || actual.requesterHumanId !== expected.subject.humanActorId
    || actual.requestId !== expected.request.requestId || actual.workId !== expected.request.workId
    || actual.workKind !== expected.request.workKind || expected.request.workPurpose !== actual.workKind
    || actual.destinationRoomId !== expected.request.sourceRoomId || actual.episodeId !== expected.request.episodeId
    || actual.expectedPolicyRevision !== expected.policyRevision
    || !outputRequirementsMatch(actual, expected.namespaces, context.accessRevisions)) {
    throw new TypeError("Task output product authority does not match the request");
  }
}
