import {
  and,
  createPostgresJsBridgeConnection,
  eq,
  getSharedDirectCryptoDb,
  taskRuns,
  tasks,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  copyTaskScopeMemoryBinding,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  withInitialTaskRuntimeRecipientAuthority,
  type InitialTaskRuntimeRecipientAuthority,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import {
  isCurrentProtectedTaskRunForGrant,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import { findActorByOwnerId, findAgentOwnerPrivateRoom } from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from "./human-message-product-store";

type CurrentTask = Pick<
  Task,
  | "id"
  | "ownerId"
  | "requestorId"
  | "agentId"
  | "callingRoomId"
  | "status"
  | "scheduleKind"
  | "contentRepresentation"
  | "contentNamespaceId"
  | "contentRevision"
  | "cryptoObjectId"
  | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint"
  | "cryptoMappingState"
>;

type CurrentRun = Pick<
  TaskRun,
  | "id"
  | "taskId"
  | "jobId"
  | "graphThreadId"
  | "status"
  | "resultRepresentation"
  | "resultContentNamespaceId"
  | "resultRevision"
  | "resultCryptoObjectId"
  | "resultCryptoAccessRevision"
  | "resultCryptoRequiredNamespaceFingerprint"
  | "resultCryptoMappingState"
>;

type ProductContext = Awaited<
  ReturnType<typeof createHumanProductTransactionContext>
>;

export type ProtectedTaskRuntimeRecipientDeviceBinding = Readonly<{
  userId: string;
  humanActorId: string;
  deviceId: string;
}>;

export type ProtectedTaskRuntimeRecipientCurrentAuthority = Readonly<{
  device: InitialTaskRuntimeRecipientAuthority["device"];
  domains: InitialTaskRuntimeRecipientAuthority["domains"];
  namespaceRequirements: InitialTaskRuntimeRecipientAuthority["namespaceRequirements"];
  policyRevision: number;
  sourceRoomId: string;
  scopeMemory?: TaskScopeMemoryBinding;
}>;

export type ProtectedTaskRuntimeRecipientAuthorityPort = <Value>(
  input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    binding: ProtectedTaskRuntimeRecipientDeviceBinding;
    targetRoomId: string;
    scopeMemory?: TaskScopeMemoryBinding;
    use(
      current: ProtectedTaskRuntimeRecipientCurrentAuthority,
    ): Value | Promise<Value>;
  }>,
) => Promise<Value | null>;

export type ProtectedTaskRuntimeRecipientAuthorityDependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  restricted(): PostgresJsBridgeConnection;
  resolveRequesterHuman(userId: string): Promise<Readonly<{
    id: string;
  }> | null>;
  resolveRequesterPrivateRoom(
    userId: string,
    agentId: string,
  ): Promise<Readonly<{
    roomId: string;
    namespaceId: string;
  }> | null>;
  createProductContext(
    userId: string,
    database: DirectDatabase,
  ): Promise<ProductContext>;
  validateCurrentTaskRun(
    input: Readonly<{
      product: PostgresJsBridgeConnection;
      occurrence: ProtectedTaskOccurrence;
      requesterPrivateRoom: Readonly<{ roomId: string; namespaceId: string }>;
    }>,
  ): Promise<boolean>;
  withAuthority: typeof withInitialTaskRuntimeRecipientAuthority;
}>;

function sameNamespaceRequirements(
  left: InitialTaskRuntimeRecipientAuthority["namespaceRequirements"],
  right: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["namespaceRequirements"],
): boolean {
  return (
    left.length === right.length &&
    left.every((requirement, index) => {
      const expected = right[index];
      return (
        expected !== undefined &&
        requirement.ordinal === expected.ordinal &&
        requirement.namespaceId === expected.namespaceId &&
        requirement.domainId === expected.domainId &&
        requirement.expectedAccessRevision ===
          expected.expectedAccessRevision &&
        requirement.expectedPolicyRevision ===
          expected.expectedPolicyRevision &&
        requirement.operations.length === expected.operations.length &&
        requirement.operations.every(
          (operation, operationIndex) =>
            operation === expected.operations[operationIndex],
        )
      );
    })
  );
}

function sameTaskScopeMemoryBinding(
  left: TaskScopeMemoryBinding,
  right: TaskScopeMemoryBinding,
): boolean {
  return left.scopeId === right.scopeId
    && left.memoryRoomId === right.memoryRoomId
    && left.originWritableNamespaceId === right.originWritableNamespaceId
    && left.readableNamespaceIds.length === right.readableNamespaceIds.length
    && left.readableNamespaceIds.every(
      (id, index) => id === right.readableNamespaceIds[index],
    );
}

function exactAwaitingRecord(
  occurrence: ProtectedTaskOccurrence,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const namespaces = record.authoritySet.namespaceRequirements;
  const domains = record.authoritySet.domainRequirements;
  const content = namespaces.filter(
    (requirement) =>
      requirement.namespaceId === occurrence.task.contentNamespaceId,
  );
  const contentRequirement = content[0];
  const contentDomain = domains.find(
    (requirement) => requirement.domainId === contentRequirement?.domainId,
  );
  return (
    record.snapshot.formatVersion === 3 &&
    record.snapshot.credentialSubject.kind === "runtime" &&
    record.snapshot.credentialSubject.runtimeKind === "task" &&
    record.snapshot.credentialSubject.runtimeVersion === 1 &&
    record.snapshot.workId === occurrence.run.id &&
    record.snapshot.namespaceId === occurrence.task.contentNamespaceId &&
    record.snapshot.state === "awaiting_recipient" &&
    record.snapshot.recipient === null &&
    record.snapshot.descriptorDigest === null &&
    record.descriptorBytes === null &&
    record.acceptedMaterial === null &&
    record.workKind === "task.execute" &&
    record.purpose === "task.execute" &&
    record.processorAuthorizationRevision === null &&
    record.expectedDomainEpoch !== null &&
    Number.isSafeInteger(record.expectedDomainEpoch) &&
    record.expectedDomainEpoch > 0 &&
    Number.isSafeInteger(record.expectedPolicyRevision) &&
    record.expectedPolicyRevision > 0 &&
    record.finishedAt === null &&
    occurrence.task.cryptoAccessRevision === 0 &&
    occurrence.task.cryptoObjectId ===
      deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: occurrence.task.id,
        contentRevision: occurrence.task.contentRevision,
      }) &&
    namespaces.length > 0 &&
    namespaces.every(
      (requirement, index) =>
        requirement.ordinal === index &&
        requirement.namespaceId.length > 0 &&
        requirement.domainId.length > 0 &&
        (index === 0 ||
          namespaces[index - 1]!.namespaceId < requirement.namespaceId) &&
        Number.isSafeInteger(requirement.expectedAccessRevision) &&
        requirement.expectedAccessRevision >= 0 &&
        requirement.expectedPolicyRevision === record.expectedPolicyRevision &&
        requirement.operations.length > 0 &&
        requirement.operations.length <= 2 &&
        requirement.operations.every(
          (operation, operationIndex) =>
            (operation === "decrypt" || operation === "encrypt") &&
            (operationIndex === 0 ||
              requirement.operations[operationIndex - 1]! < operation),
        ),
    ) &&
    domains.length > 0 &&
    domains.every(
      (requirement, index) =>
        requirement.ordinal === index &&
        requirement.domainId.length > 0 &&
        Number.isSafeInteger(requirement.expectedEpoch) &&
        requirement.expectedEpoch > 0 &&
        Number.isSafeInteger(requirement.expectedAuthorizationRevision) &&
        requirement.expectedAuthorizationRevision >= 0 &&
        (index === 0 || domains[index - 1]!.domainId < requirement.domainId),
    ) &&
    namespaces.every((requirement) =>
      domains.some((domain) => domain.domainId === requirement.domainId),
    ) &&
    domains.every((domain) =>
      namespaces.some(
        (requirement) => requirement.domainId === domain.domainId,
      ),
    ) &&
    content.length === 1 &&
    contentRequirement !== undefined &&
    contentRequirement.operations.length === 2 &&
    contentRequirement.operations[0] === "decrypt" &&
    contentRequirement.operations[1] === "encrypt" &&
    contentRequirement.domainId === record.domainId &&
    contentRequirement.expectedAccessRevision ===
      record.expectedNamespaceAccessRevision &&
    contentRequirement.expectedPolicyRevision ===
      record.expectedPolicyRevision &&
    contentDomain !== undefined &&
    contentDomain.expectedEpoch === record.expectedDomainEpoch
  );
}

function exactBorrowedAuthority(
  authority: InitialTaskRuntimeRecipientAuthority,
  input: Readonly<{
    binding: ProtectedTaskRuntimeRecipientDeviceBinding;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    sourceRoomId: string;
    contentNamespaceId: string;
    scopeMemory?: TaskScopeMemoryBinding;
  }>,
): boolean {
  return (
    authority.sourceRoomId === input.sourceRoomId &&
    authority.sourceNamespaceId === input.contentNamespaceId &&
    (input.scopeMemory === undefined
      ? authority.scopeMemory === undefined
      : authority.scopeMemory !== undefined
        && sameTaskScopeMemoryBinding(input.scopeMemory, authority.scopeMemory)) &&
    authority.policyRevision === input.record.expectedPolicyRevision &&
    authority.device.userId === input.binding.userId &&
    authority.device.humanActorId === input.binding.humanActorId &&
    authority.device.deviceId === input.binding.deviceId &&
    sameNamespaceRequirements(
      authority.namespaceRequirements,
      input.record.authoritySet.namespaceRequirements,
    ) &&
    authority.domains.length ===
      input.record.authoritySet.domainRequirements.length &&
    authority.domains.every((domain, index) => {
      const expected = input.record.authoritySet.domainRequirements[index];
      return (
        expected !== undefined &&
        domain.domainId === expected.domainId &&
        domain.domainKeyGeneration === expected.expectedEpoch &&
        domain.authorizationRevision === expected.expectedAuthorizationRevision
      );
    })
  );
}

async function validateLockedCurrentTaskRun(
  input: Readonly<{
    product: PostgresJsBridgeConnection;
    occurrence: ProtectedTaskOccurrence;
    requesterPrivateRoom: Readonly<{ roomId: string; namespaceId: string }>;
  }>,
): Promise<boolean> {
  const taskRows = await executeTypedConversationProductQuery(
    input.product,
    conversationProductTypedDb
      .select({
        id: tasks.id,
        ownerId: tasks.ownerId,
        requestorId: tasks.requestorId,
        agentId: tasks.agentId,
        callingRoomId: tasks.callingRoomId,
        status: tasks.status,
        scheduleKind: tasks.scheduleKind,
        contentRepresentation: tasks.contentRepresentation,
        contentNamespaceId: tasks.contentNamespaceId,
        contentRevision: tasks.contentRevision,
        cryptoObjectId: tasks.cryptoObjectId,
        cryptoAccessRevision: tasks.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          tasks.cryptoRequiredNamespaceFingerprint,
        cryptoMappingState: tasks.cryptoMappingState,
      })
      .from(tasks)
      .where(eq(tasks.id, input.occurrence.task.id))
      .limit(2)
      .for("update"),
  );
  if (taskRows.length !== 1) return false;
  const taskRow = taskRows[0]!;
  const task: CurrentTask = {
    id: taskRow.id,
    ownerId: taskRow.owner_id,
    requestorId: taskRow.requestor_id,
    agentId: taskRow.agent_id,
    callingRoomId: taskRow.calling_room_id,
    status: taskRow.status,
    scheduleKind: taskRow.schedule_kind,
    contentRepresentation: taskRow.content_representation,
    contentNamespaceId: taskRow.content_namespace_id,
    contentRevision: taskRow.content_revision,
    cryptoObjectId: taskRow.crypto_object_id,
    cryptoAccessRevision: taskRow.crypto_access_revision,
    cryptoRequiredNamespaceFingerprint:
      taskRow.crypto_required_namespace_fingerprint,
    cryptoMappingState: taskRow.crypto_mapping_state,
  };
  const runRows = await executeTypedConversationProductQuery(
    input.product,
    conversationProductTypedDb
      .select({
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        jobId: taskRuns.jobId,
        graphThreadId: taskRuns.graphThreadId,
        status: taskRuns.status,
        resultRepresentation: taskRuns.resultRepresentation,
        resultContentNamespaceId: taskRuns.resultContentNamespaceId,
        resultRevision: taskRuns.resultRevision,
        resultCryptoObjectId: taskRuns.resultCryptoObjectId,
        resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
        resultCryptoRequiredNamespaceFingerprint:
          taskRuns.resultCryptoRequiredNamespaceFingerprint,
        resultCryptoMappingState: taskRuns.resultCryptoMappingState,
      })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.id, input.occurrence.run.id),
          eq(taskRuns.taskId, input.occurrence.task.id),
        ),
      )
      .limit(2)
      .for("update"),
  );
  if (runRows.length !== 1) return false;
  const runRow = runRows[0]!;
  const run: CurrentRun = {
    id: runRow.id,
    taskId: runRow.task_id,
    jobId: runRow.job_id,
    graphThreadId: runRow.graph_thread_id,
    status: runRow.status,
    resultRepresentation: runRow.result_representation,
    resultContentNamespaceId: runRow.result_content_namespace_id,
    resultRevision: runRow.result_revision,
    resultCryptoObjectId: runRow.result_crypto_object_id,
    resultCryptoAccessRevision: runRow.result_crypto_access_revision,
    resultCryptoRequiredNamespaceFingerprint:
      runRow.result_crypto_required_namespace_fingerprint,
    resultCryptoMappingState: runRow.result_crypto_mapping_state,
  };
  return isCurrentProtectedTaskRunForGrant({
    occurrence: input.occurrence,
    task,
    run,
    requestorUserId: input.occurrence.task.requestorId,
    requestWorkId: input.occurrence.run.id,
    sourceRoomId: input.requesterPrivateRoom.roomId,
    requesterPrivateRoom: input.requesterPrivateRoom,
    phase: "awaiting",
  });
}

/**
 * Dark awaiting-phase adapter. It lets the Runtime build a signed request only
 * while the exact Task, TaskRun, requester-private Room and admitted device
 * remain current inside the native lattice authority owner.
 */
export function createProtectedTaskRuntimeRecipientAuthorityPort(
  overrides: Partial<ProtectedTaskRuntimeRecipientAuthorityDependencies> = {},
): ProtectedTaskRuntimeRecipientAuthorityPort {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const serverScope =
    overrides.serverScope ??
    (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001");
  const restricted =
    overrides.restricted ??
    (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const resolveRequesterHuman =
    overrides.resolveRequesterHuman ?? findActorByOwnerId;
  const resolveRequesterPrivateRoom =
    overrides.resolveRequesterPrivateRoom ?? findAgentOwnerPrivateRoom;
  const createProductContext =
    overrides.createProductContext ?? createHumanProductTransactionContext;
  const validateCurrentTaskRun =
    overrides.validateCurrentTaskRun ?? validateLockedCurrentTaskRun;
  const withAuthority =
    overrides.withAuthority ?? withInitialTaskRuntimeRecipientAuthority;

  return async (input) => {
    const targetRoomId = input.targetRoomId;
    const scopeMemory = input.scopeMemory === undefined
      ? undefined
      : copyTaskScopeMemoryBinding(input.scopeMemory);
    if (
      input.binding.userId !== input.occurrence.task.requestorId ||
      input.binding.humanActorId.length === 0 ||
      input.binding.deviceId.length === 0 ||
      !exactAwaitingRecord(input.occurrence, input.record)
    )
      return null;

    const [human, room] = await Promise.all([
      resolveRequesterHuman(input.binding.userId),
      resolveRequesterPrivateRoom(
        input.binding.userId,
        input.occurrence.task.agentId,
      ),
    ]);
    if (
      human === null ||
      room === null ||
      human.id !== input.binding.humanActorId ||
      room.namespaceId !== input.occurrence.task.contentNamespaceId
    )
      return null;

    const product = await createProductContext(input.binding.userId, db);
    const namespaceRequirements =
      input.record.authoritySet.namespaceRequirements;
    const domainRequirements = input.record.authoritySet.domainRequirements;
    return withAuthority({
      runner: product.canonicalRunner,
      restricted: restricted(),
      crypto,
      serverScope,
      taskId: input.occurrence.task.id,
      requesterUserId: input.binding.userId,
      requesterHumanId: input.binding.humanActorId,
      agentId: input.occurrence.task.agentId,
      contentNamespaceId: input.occurrence.task.contentNamespaceId,
      sourceRoomId: room.roomId,
      targetRoomId,
      namespaceIds: Object.freeze(
        namespaceRequirements.map((requirement) => requirement.namespaceId),
      ),
      ...(scopeMemory === undefined ? {} : { scopeMemory }),
      expectedPolicyRevision: input.record.expectedPolicyRevision,
      deviceId: input.binding.deviceId,
      namespaceRequirements,
      domainRequirements,
      validateCurrentTaskRun: (product) =>
        validateCurrentTaskRun({
          product,
          occurrence: input.occurrence,
          requesterPrivateRoom: room,
        }),
      use: (authority) => {
        if (
          !exactBorrowedAuthority(authority, {
            binding: input.binding,
            record: input.record,
            sourceRoomId: room.roomId,
            contentNamespaceId: input.occurrence.task.contentNamespaceId,
            ...(scopeMemory === undefined ? {} : { scopeMemory }),
          })
        )
          return null;
        return input.use(
          Object.freeze({
            device: authority.device,
            domains: authority.domains,
            namespaceRequirements: authority.namespaceRequirements,
            policyRevision: authority.policyRevision,
            sourceRoomId: authority.sourceRoomId,
            ...(authority.scopeMemory === undefined
              ? {}
              : { scopeMemory: authority.scopeMemory }),
          }),
        );
      },
    });
  };
}
