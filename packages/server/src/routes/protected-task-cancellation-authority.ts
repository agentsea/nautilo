import {
  actors, and, asc, createPostgresJsBridgeConnection, eq,
  getSharedDirectCryptoDb, protectedTaskRunOutputBindings, roomMembers, rooms,
  taskRuns, tasks,
  type DirectDatabase, type PostgresJsBridgeConnection,
  type ProtectedTaskCancellationOutputIntent,
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
  inspectTaskContentNamespaceAuthority, withTaskContentRecipientAuthority,
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
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";

type Coordinates = Readonly<{
  intent: ProtectedTaskCancellationOutputIntent;
  subject: TaskRuntimeAuthoritySubject;
  restricted?: PostgresJsBridgeConnection;
  signal?: AbortSignal;
}>;

export type ProtectedTaskCancellationDiscoveryAuthority =
  InitialTaskRuntimeRecipientAuthority & Readonly<{
    /** Borrowed only for the callback lifetime. */
    restricted: PostgresJsBridgeConnection;
  }>;

export type ProtectedTaskCancellationAuthorityPort = Readonly<{
  withDiscovery<Value>(input: Coordinates & Readonly<{
    use(current: ProtectedTaskCancellationDiscoveryAuthority,
      product: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx): Value | Promise<Value>;
    validateBeforeCommit?(): void | Promise<void>;
  }>): Promise<Value | null>;
  withBound<Value>(input: Coordinates & Readonly<{
    request: TaskRuntimeBackgroundAuthorizationRequestV1;
    admission: StenographerRequestAdmission;
    namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
    domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
    use(current: CurrentTaskRuntimeAuthority, product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection): Value | Promise<Value>;
  }>): Promise<Value | null>;
  withAccepted<Value>(input: Coordinates & Readonly<{
    accepted: AcceptedTaskRuntimeAuthorizationV3;
    use(current: CurrentTaskRuntimeAuthority, product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx): Value | Promise<Value>;
    validateBeforeCommit(): void | Promise<void>;
  }>): Promise<Value | null>;
}>;

export type ProtectedTaskCancellationAuthorityDependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  restricted(): PostgresJsBridgeConnection;
  resolveRequesterHuman(userId: string): Promise<Readonly<{ id: string }> | null>;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  createProductContext: typeof createHumanProductTransactionContext;
  inspectContentAuthority: typeof inspectTaskContentNamespaceAuthority;
  withRecipientAuthority: typeof withTaskContentRecipientAuthority;
  withBoundAuthority: typeof withCurrentTaskRuntimeAuthority;
  withAcceptedAuthority: typeof withCurrentAcceptedTaskRuntimeClaimAuthority;
  validateCurrentIntent: typeof validateCurrentProtectedTaskCancellationIntent;
  now(): number;
}>;

function timestamp(value: unknown): number {
  return value instanceof Date ? value.getTime()
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** Locks only lifecycle/output metadata; no definition, content, or Job is read. */
export async function validateCurrentProtectedTaskCancellationIntent(input: Readonly<{
  product: PostgresJsBridgeConnection;
  intent: ProtectedTaskCancellationOutputIntent;
  /** Recovery-only: the mapped result may already have its exact terminal receipt. */
  allowTerminalResultAttachment?: boolean;
}>): Promise<boolean> {
  const { product, intent } = input;
  const taskRows = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId,
      agentId: tasks.agentId, status: tasks.status, cancelledAt: tasks.cancelledAt,
      contentNamespaceId: tasks.contentNamespaceId,
      contentRepresentation: tasks.contentRepresentation,
    }).from(tasks).where(eq(tasks.id, intent.taskId)).limit(2).for("update"));
  const task = taskRows[0];
  if (taskRows.length !== 1 || task === undefined || task.id !== intent.taskId
    || task.owner_id !== intent.requesterUserId || task.requestor_id !== intent.requesterUserId
    || task.agent_id !== intent.agentId || task.status !== "cancelled"
    || task.content_namespace_id !== intent.contentNamespaceId
    || task.content_representation !== intent.representation
    || timestamp(task.cancelled_at) !== intent.terminalAt.getTime()) return false;
  const runRows = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({ id: taskRuns.id, taskId: taskRuns.taskId,
      status: taskRuns.status, completedAt: taskRuns.completedAt,
    }).from(taskRuns).where(and(eq(taskRuns.id, intent.taskRunId),
      eq(taskRuns.taskId, intent.taskId))).limit(2).for("update"));
  const run = runRows[0];
  if (runRows.length !== 1 || run === undefined || run.id !== intent.taskRunId
    || run.task_id !== intent.taskId || run.status !== "cancelled"
    || timestamp(run.completed_at) !== intent.terminalAt.getTime()) return false;
  const bindings = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({
      taskRunId: protectedTaskRunOutputBindings.taskRunId,
      resultRevision: protectedTaskRunOutputBindings.resultRevision,
      resultOperationId: protectedTaskRunOutputBindings.resultOperationId,
      resultObjectId: protectedTaskRunOutputBindings.resultObjectId,
      acceptedPolicyRevision: protectedTaskRunOutputBindings.acceptedPolicyRevision,
      resultTerminalAt: protectedTaskRunOutputBindings.resultTerminalAt,
      resultAttachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
    }).from(protectedTaskRunOutputBindings).where(eq(
      protectedTaskRunOutputBindings.taskRunId, intent.taskRunId,
    )).limit(2).for("update"));
  const binding = bindings[0];
  return bindings.length === 1 && binding !== undefined
    && binding.task_run_id === intent.taskRunId && binding.result_revision === 2
    && binding.result_operation_id === intent.resultOperationId
    && binding.result_object_id === intent.resultObjectId
    && binding.accepted_policy_revision === intent.policyRevision
    && timestamp(binding.result_terminal_at) === intent.terminalAt.getTime()
    && (binding.result_attached_at === null
      || input.allowTerminalResultAttachment === true
        && timestamp(binding.result_attached_at) === intent.terminalAt.getTime());
}

async function exactPrivateRoom(product: PostgresJsBridgeConnection,
  roomId: string, intent: ProtectedTaskCancellationOutputIntent,
  subject: TaskRuntimeAuthoritySubject): Promise<boolean> {
  const rows = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({ id: rooms.id, namespaceId: rooms.namespaceId,
      type: rooms.type, kind: rooms.kind, parentRoomId: rooms.parentRoomId,
      archivedAt: rooms.archivedAt, humanActorIds: rooms.humanActorIds,
    }).from(rooms).where(eq(rooms.id, roomId)).limit(2).for("update"));
  const room = rows[0];
  if (rows.length !== 1 || room === undefined || room.id !== roomId
    || room.namespace_id !== intent.contentNamespaceId
    || room.type !== "private" || room.kind !== "private"
    || room.parent_room_id !== null || room.archived_at !== null
    || room.human_actor_ids.length !== 1 || room.human_actor_ids[0] !== subject.humanActorId) return false;
  const members = await executeTypedConversationProductQuery(product,
    conversationProductTypedDb.select({ id: actors.id, kind: actors.kind,
      ownerId: actors.ownerId, agentId: actors.agentId,
    }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, roomId)).orderBy(asc(actors.id))
      .limit(3).for("share", { of: actors }));
  return members.length === 2
    && members.filter(member => member.kind === "user"
      && member.id === subject.humanActorId && member.owner_id === subject.userId).length === 1
    && members.filter(member => member.kind === "agent").length === 1;
}

function exactRequirements(intent: ProtectedTaskCancellationOutputIntent,
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[],
  domains: readonly TaskRuntimeDomainAuthorityRequirement[]): boolean {
  const namespace = namespaces[0];
  const domain = domains[0];
  return namespaces.length === 1 && domains.length === 1
    && namespace !== undefined && domain !== undefined
    && namespace.ordinal === 0 && domain.ordinal === 0
    && namespace.namespaceId === intent.contentNamespaceId
    && namespace.domainId === domain.domainId
    && namespace.operations.length === 1 && namespace.operations[0] === "encrypt"
    && namespace.expectedPolicyRevision === intent.policyRevision;
}

function copyNamespaces(values: readonly TaskRuntimeNamespaceAuthorityRequirement[]) {
  return Object.freeze(values.map(value => Object.freeze({ ...value,
    operations: Object.freeze([...value.operations]) })));
}

/** Dark cancellation-only owner. It never admits execution or loads Task content. */
export function createProtectedTaskCancellationAuthorityPort(
  overrides: Partial<ProtectedTaskCancellationAuthorityDependencies> = {},
): ProtectedTaskCancellationAuthorityPort {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const serverScope = overrides.serverScope
    ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001");
  const restricted = overrides.restricted
    ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const resolveHuman = overrides.resolveRequesterHuman ?? findActorByOwnerId;
  const resolveRoom = overrides.resolveRequesterPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(db);
  const context = overrides.createProductContext ?? createHumanProductTransactionContext;
  const inspect = overrides.inspectContentAuthority ?? inspectTaskContentNamespaceAuthority;
  const recipient = overrides.withRecipientAuthority ?? withTaskContentRecipientAuthority;
  const bound = overrides.withBoundAuthority ?? withCurrentTaskRuntimeAuthority;
  const accepted = overrides.withAcceptedAuthority ?? withCurrentAcceptedTaskRuntimeClaimAuthority;
  const validate = overrides.validateCurrentIntent ?? validateCurrentProtectedTaskCancellationIntent;
  const now = overrides.now ?? Date.now;

  async function prepare(input: Coordinates) {
    const intent = Object.freeze({ ...input.intent, terminalAt: new Date(input.intent.terminalAt) });
    const subject = Object.freeze({ ...input.subject });
    if (subject.userId !== intent.requesterUserId || subject.humanActorId.length === 0
      || subject.deviceId.length === 0 || intent.taskStatus !== "cancelled"
      || intent.runStatus !== "cancelled" || intent.resultRevision !== 2
      || !["protected", "dual"].includes(intent.representation)
      || !Number.isFinite(intent.terminalAt.getTime())) return null;
    const [human, room] = await Promise.all([
      resolveHuman(subject.userId), resolveRoom(subject.userId, intent.agentId, intent.contentNamespaceId),
    ]);
    if (human === null || room === null || human.id !== subject.humanActorId
      || room.namespaceId !== intent.contentNamespaceId) return null;
    const product = await context(subject.userId, db);
    return { intent, subject, room, runner: product.canonicalRunner,
      restricted: input.restricted ?? restricted(), crypto, serverScope,
      ...(input.signal === undefined ? {} : { signal: input.signal }) };
  }

  return {
    async withDiscovery(input) {
      const use = input.use;
      const validateBeforeCommit = input.validateBeforeCommit;
      const current = await prepare(input);
      if (current === null) return null;
      const coordinates = { ...current, taskId: current.intent.taskId,
        requesterUserId: current.subject.userId, requesterHumanId: current.subject.humanActorId,
        agentId: current.intent.agentId, contentNamespaceId: current.intent.contentNamespaceId,
        sourceRoomId: current.room.roomId, expectedPolicyRevision: current.intent.policyRevision };
      const planning = await inspect(coordinates);
      const fact = planning?.facts[0];
      if (planning === null || planning.facts.length !== 1 || fact === undefined
        || fact.namespaceId !== current.intent.contentNamespaceId
        || fact.expectedPolicyRevision !== current.intent.policyRevision) return null;
      // Planning is detached. The recipient owner repeats product/device/Namespace/
      // Domain proof in canonical order and holds it through binding publication.
      return recipient({ ...coordinates, deviceId: current.subject.deviceId,
        namespaceRequirements: [{ ordinal: 0, namespaceId: fact.namespaceId,
          domainId: fact.domainId, operations: ["encrypt"],
          expectedAccessRevision: fact.expectedAccessRevision,
          expectedPolicyRevision: fact.expectedPolicyRevision }],
        domainRequirements: [{ ordinal: 0, domainId: fact.domainId,
          expectedEpoch: fact.expectedDomainEpoch,
          expectedAuthorizationRevision: fact.expectedAuthorizationRevision }],
        validateCurrentTaskRun: product => validate({ product, intent: current.intent }),
        ...(validateBeforeCommit === undefined ? {} : { validateBeforeCommit }),
        use: (authority, scoped, product, transaction) => use(
          Object.freeze({ ...authority, restricted: scoped }), product, transaction),
      });
    },
    async withBound(input) {
      const use = input.use;
      const bytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(input.request);
      const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(bytes);
      bytes.fill(0);
      if (request === null) return null;
      const admission = Object.freeze({ ...input.admission, headDigest: input.admission.headDigest.slice() });
      const namespaceRequirements = copyNamespaces(input.namespaceRequirements);
      const domainRequirements = input.domainRequirements.map(value => Object.freeze({ ...value }));
      try {
        if (request.workKind !== "task.cancel_result" || request.workPurpose !== "task.cancel_result"
          || request.workId !== input.intent.taskRunId
          || !exactRequirements(input.intent, namespaceRequirements, domainRequirements)) return null;
        const current = await prepare(input);
        if (current === null || request.sourceRoomId !== current.room.roomId) return null;
        return await bound({ ...current, request, admission,
          namespaceRequirements, domainRequirements,
          now, validateCurrentProduct: async product =>
            await validate({ product, intent: current.intent })
            && await exactPrivateRoom(product, current.room.roomId, current.intent, current.subject),
          use: async (authority, product, scoped) => use(authority, product, scoped),
        });
      } finally {
        admission.headDigest.fill(0);
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
      }
    },
    async withAccepted(input) {
      const use = input.use;
      const record = Object.freeze({ ...input.accepted,
        descriptorBytes: input.accepted.descriptorBytes.slice(),
        authorizationBytes: input.accepted.authorizationBytes.slice(),
        issuerSigningPublicKeyHash: input.accepted.issuerSigningPublicKeyHash.slice(),
        namespaceRequirements: copyNamespaces(input.accepted.namespaceRequirements),
        domainRequirements: input.accepted.domainRequirements.map(value => Object.freeze({ ...value })),
      });
      try {
        const validateBeforeCommit = input.validateBeforeCommit;
        if (record.workKind !== "task.cancel_result" || record.workPurpose !== "task.cancel_result"
          || record.workId !== input.intent.taskRunId
          || record.expectedPolicyRevision !== input.intent.policyRevision
          || !exactRequirements(input.intent, record.namespaceRequirements, record.domainRequirements)
          || typeof validateBeforeCommit !== "function") return null;
        const current = await prepare(input);
        if (current === null) return null;
        return await accepted({ ...current, accepted: record, now,
          validateCurrentProduct: async product =>
            await validate({ product, intent: current.intent })
            && await exactPrivateRoom(product, current.room.roomId, current.intent, current.subject),
          validateBeforeCommit,
          use: async (authority, product, scoped, transaction) => {
            if (authority.plan.roomId !== current.room.roomId) return null;
            await validateBeforeCommit();
            return use(authority, product, scoped, transaction);
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
