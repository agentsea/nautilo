import { protectedTaskDefinitionSupportsPolicy } from "@nautilo/db";
import { isDeepStrictEqual } from "node:util";
import {
  actors,
  and,
  deriveProtectedTaskDeliveryGraphThreadId,
  encryptionTransitionPolicy,
  eq,
  isNull,
  jobs,
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunOutputBindings,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  PROTECTED_TASK_CANCELLED_RESULT,
  readLatestProtectedTaskWakeContinuation,
  withCurrentProtectedTaskWakeContinuation,
  type ProtectedTaskWakeContinuationReceipt,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  taskRunMessageAssociations,
  taskRunResultCryptoRevisions,
  taskRuns,
  tasks,
  type PostgresJsBridgeConnection,
  type ProtectedTaskRunWakeReferenceV1,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ProtectedTaskOutputReadInitialState =
  | "raw_unpublished"
  | "wake_queued"
  | "wake_running";

export type ProtectedTaskOutputReadClosedProof = Readonly<{
  requesterUserId: string;
  requesterHumanId: string;
  agentId: string;
  contentNamespaceId: string;
  representation: "protected" | "dual";
  expectedPolicyRevision: number;
  acceptedPolicyRevision: number;
  /** Detached hint until the held loader reproves the immutable receipt. */
  continuation?: ProtectedTaskWakeContinuationReceipt;
  result: Readonly<{
    taskId: string;
    taskRunId: string;
    terminalStatus: "completed" | "errored" | "cancelled";
    contentRevision: 1 | 2;
    objectId: string;
    cryptoAccessRevision: number;
    genesisManifestHash: Uint8Array;
    signerAgentId: string;
  }>;
  invocation: Readonly<{
    bindingId: string;
    operationId: string;
    roomId: string;
    sessionId: string;
  }> & (Readonly<{ kind: "raw" }> | Readonly<{
    kind: "wake";
    jobId: string;
    reference: ProtectedTaskRunWakeReferenceV1;
  }>);
}>;

export type ProtectedTaskOutputReadIntent = ProtectedTaskOutputReadClosedProof &
  Readonly<{ initialState: ProtectedTaskOutputReadInitialState }>;

type Coordinates = Readonly<{
  taskId: string;
  taskRunId: string;
  kind: "raw" | "wake";
}>;

type ProductState = Readonly<{
  proof: Omit<ProtectedTaskOutputReadClosedProof, "invocation">;
  binding: typeof protectedTaskRunOutputBindings.$inferSelect;
  terminalAt: Date;
}>;

type WakeJobReceipt = Readonly<{
  createdAt: number; startedAt: number; completedAt: number | null;
}>;

type ForegroundState = Readonly<{
  jobCreatedAt?: number;
  jobReceipt?: WakeJobReceipt;
  invocation: ProtectedTaskOutputReadClosedProof["invocation"];
  state: "raw_unpublished" | "raw_published" | "wake_queued" | "wake_running"
    | "wake_completed" | "wake_failed";
}>;

type ProductTx = Pick<CanonicalTranscriptTx, "select">;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactReference(
  value: unknown,
  expected: ProtectedTaskRunWakeReferenceV1,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",")
      === "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
    && Object.entries(expected).every(([key, expectedValue]) =>
      record[key] === expectedValue);
}

function copyProof(
  value: ProtectedTaskOutputReadClosedProof,
): ProtectedTaskOutputReadClosedProof {
  return Object.freeze({
    requesterUserId: value.requesterUserId,
    requesterHumanId: value.requesterHumanId,
    agentId: value.agentId,
    contentNamespaceId: value.contentNamespaceId,
    representation: value.representation,
    expectedPolicyRevision: value.expectedPolicyRevision,
    acceptedPolicyRevision: value.acceptedPolicyRevision,
    ...(value.continuation === undefined ? {} : { continuation: structuredClone(value.continuation) }),
    result: Object.freeze({
      ...value.result,
      genesisManifestHash: Uint8Array.from(value.result.genesisManifestHash),
    }),
    invocation: Object.freeze(value.invocation.kind === "raw"
      ? { ...value.invocation }
      : { ...value.invocation, reference: Object.freeze({ ...value.invocation.reference }) }),
  });
}

function sameContinuation(left: ProtectedTaskWakeContinuationReceipt | undefined, right: ProtectedTaskWakeContinuationReceipt | undefined): boolean {
  // PostgreSQL bytea may be Buffer; compare detached canonical byte views.
  return isDeepStrictEqual(structuredClone(left), structuredClone(right));
}

function sameProof(
  left: ProtectedTaskOutputReadClosedProof,
  right: ProtectedTaskOutputReadClosedProof,
): boolean {
  const leftInvocation = left.invocation;
  const rightInvocation = right.invocation;
  return left.requesterUserId === right.requesterUserId
    && left.requesterHumanId === right.requesterHumanId
    && left.agentId === right.agentId
    && left.contentNamespaceId === right.contentNamespaceId
    && left.representation === right.representation
    && left.expectedPolicyRevision === right.expectedPolicyRevision
    && left.acceptedPolicyRevision === right.acceptedPolicyRevision
    && sameContinuation(left.continuation, right.continuation)
    && left.result.taskId === right.result.taskId
    && left.result.taskRunId === right.result.taskRunId
    && left.result.terminalStatus === right.result.terminalStatus
    && left.result.contentRevision === right.result.contentRevision
    && left.result.objectId === right.result.objectId
    && left.result.cryptoAccessRevision === right.result.cryptoAccessRevision
    && left.result.signerAgentId === right.result.signerAgentId
    && sameBytes(left.result.genesisManifestHash, right.result.genesisManifestHash)
    && leftInvocation.kind === rightInvocation.kind
    && leftInvocation.bindingId === rightInvocation.bindingId
    && leftInvocation.operationId === rightInvocation.operationId
    && leftInvocation.roomId === rightInvocation.roomId
    && leftInvocation.sessionId === rightInvocation.sessionId
    && (leftInvocation.kind === "raw" || rightInvocation.kind === "raw"
      || leftInvocation.jobId === rightInvocation.jobId
        && exactReference(leftInvocation.reference, rightInvocation.reference));
}

async function loadProductState(
  tx: ProductTx,
  coordinates: Coordinates,
): Promise<ProductState | null> {
  const [policy] = await tx.select({
    mode: encryptionTransitionPolicy.mode,
    revision: encryptionTransitionPolicy.revision,
  }).from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server")).limit(2).for("share");
  if (policy === undefined) return null;

  const [task] = await tx.select({
    id: tasks.id,
    ownerId: tasks.ownerId,
    requesterUserId: tasks.requestorId,
    agentId: tasks.agentId,
    callingRoomId: tasks.callingRoomId,
    resultDelivery: tasks.resultDelivery,
    status: tasks.status,
    cancelledAt: tasks.cancelledAt,
    representation: tasks.contentRepresentation,
    contentNamespaceId: tasks.contentNamespaceId,
    contentRevision: tasks.contentRevision,
    cryptoObjectId: tasks.cryptoObjectId,
    cryptoAccessRevision: tasks.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
    cryptoMappingState: tasks.cryptoMappingState,
    promptIsEmpty: eq(tasks.prompt, "").mapWith(Boolean),
    expectedOutputIsNull: isNull(tasks.expectedOutput).mapWith(Boolean),
    lastErrorIsNull: isNull(tasks.lastError).mapWith(Boolean),
  }).from(tasks).where(eq(tasks.id, coordinates.taskId)).limit(2)
    // Exclude Task edits/deletes while permitting FK-only usage accounting.
    .for("no key update");
  if (task === undefined || task.ownerId !== task.requesterUserId
    || task.contentNamespaceId === null || task.cryptoObjectId === null
    || task.cryptoMappingState !== "verified" || task.contentRevision < 1
    || task.cryptoAccessRevision < 0
    || !(task.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.representation !== "protected" && task.representation !== "dual"
    || !protectedTaskDefinitionSupportsPolicy(task.representation, policy.mode)
    || task.representation === "protected"
      && (!task.promptIsEmpty || !task.expectedOutputIsNull
        || !task.lastErrorIsNull)) return null;

  const [run] = await tx.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    status: taskRuns.status,
    completedAt: taskRuns.completedAt,
    representation: taskRuns.resultRepresentation,
    contentNamespaceId: taskRuns.resultContentNamespaceId,
    revision: taskRuns.resultRevision,
    objectId: taskRuns.resultCryptoObjectId,
    accessRevision: taskRuns.resultCryptoAccessRevision,
    requiredNamespaceFingerprint: taskRuns.resultCryptoRequiredNamespaceFingerprint,
    mappingState: taskRuns.resultCryptoMappingState,
    resultTextIsNull: isNull(taskRuns.resultText).mapWith(Boolean),
    resultTextIsCancelled: eq(taskRuns.resultText, PROTECTED_TASK_CANCELLED_RESULT)
      .mapWith(Boolean),
    lastErrorIsNull: isNull(taskRuns.lastError).mapWith(Boolean),
  }).from(taskRuns).where(and(
    eq(taskRuns.id, coordinates.taskRunId),
    eq(taskRuns.taskId, coordinates.taskId),
  )).limit(2).for("update");
  if (run === undefined || run.taskId !== task.id || run.completedAt === null
    || !protectedTaskDefinitionSupportsPolicy(run.representation, policy.mode)
    || run.contentNamespaceId !== task.contentNamespaceId
    || !Number.isSafeInteger(run.accessRevision) || run.accessRevision < 0 || run.mappingState !== "verified"
    || !(run.requiredNamespaceFingerprint instanceof Uint8Array)
    || !sameBytes(run.requiredNamespaceFingerprint,
      task.cryptoRequiredNamespaceFingerprint)) return null;

  const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id))
    .limit(2).for("update");
  if (binding === undefined || binding.taskRunId !== run.id
    || binding.bindingId !== protectedTaskRunOutputBindingId(run.id)
    || binding.resultTerminalAt?.getTime() !== run.completedAt.getTime()
    || binding.resultAttachedAt?.getTime() !== run.completedAt.getTime()
    || binding.destinationRoomId === null || binding.destinationNamespaceId === null
    || task.callingRoomId !== binding.destinationRoomId
    || task.resultDelivery !== binding.deliveryMode
    || policy.revision < binding.acceptedPolicyRevision) return null;

  const terminalStatus = run.status === "completed" || run.status === "errored"
    || run.status === "cancelled" ? run.status : null;
  const revision = terminalStatus === "cancelled" ? 2 as const : 1 as const;
  const objectId = revision === 2
    ? protectedTaskRunCancelledResultObjectId(task.id, run.id)
    : protectedTaskRunResultObjectId(task.id, run.id);
  const operationId = revision === 2
    ? protectedTaskRunCancelledResultOperationId(run.id)
    : protectedTaskRunResultOperationId(run.id);
  const exactCancelled = terminalStatus === "cancelled"
    && task.status === "cancelled" && task.cancelledAt?.getTime() === run.completedAt.getTime()
    && run.lastErrorIsNull
    && (run.representation === "protected" ? run.resultTextIsNull : run.resultTextIsCancelled);
  const exactNormal = terminalStatus === "completed" || terminalStatus === "errored";
  if ((!exactNormal && !exactCancelled) || terminalStatus === null
    || run.revision !== revision || binding.resultRevision !== revision
    || run.objectId !== objectId || binding.resultObjectId !== objectId
    || binding.resultOperationId !== operationId
    || run.representation === "protected" && (!run.resultTextIsNull || !run.lastErrorIsNull)) {
    return null;
  }

  const [ledger] = await tx.select({
    taskId: taskRunResultCryptoRevisions.taskId,
    taskRunId: taskRunResultCryptoRevisions.taskRunId,
    revision: taskRunResultCryptoRevisions.resultRevision,
    operationId: taskRunResultCryptoRevisions.operationId,
    requestDigest: taskRunResultCryptoRevisions.requestDigest,
    requesterHumanId: taskRunResultCryptoRevisions.requesterHumanId,
    contentNamespaceId: taskRunResultCryptoRevisions.contentNamespaceId,
    anchorNamespaceId: taskRunResultCryptoRevisions.anchorNamespaceId,
    objectId: taskRunResultCryptoRevisions.cryptoObjectId,
    representation: taskRunResultCryptoRevisions.representation,
    payloadVersion: taskRunResultCryptoRevisions.payloadVersion,
    accessRevision: taskRunResultCryptoRevisions.cryptoAccessRevision,
    requiredNamespaceFingerprint:
      taskRunResultCryptoRevisions.requiredNamespaceFingerprint,
    completion: taskRunResultCryptoRevisions.completion,
    disposition: taskRunResultCryptoRevisions.disposition,
    nextAttemptAt: taskRunResultCryptoRevisions.nextAttemptAt,
    leaseToken: taskRunResultCryptoRevisions.leaseToken,
    leaseExpiresAt: taskRunResultCryptoRevisions.leaseExpiresAt,
    failureCode: taskRunResultCryptoRevisions.failureCode,
    cryptoCompletedAt: taskRunResultCryptoRevisions.cryptoCompletedAt,
  }).from(taskRunResultCryptoRevisions).where(and(
    eq(taskRunResultCryptoRevisions.taskId, task.id),
    eq(taskRunResultCryptoRevisions.taskRunId, run.id),
    eq(taskRunResultCryptoRevisions.resultRevision, revision),
  )).limit(2).for("share");
  if (ledger === undefined || ledger.taskId !== task.id || ledger.taskRunId !== run.id
    || ledger.revision !== revision || ledger.operationId !== operationId
    || !(ledger.requestDigest instanceof Uint8Array) || ledger.requestDigest.length !== 32
    || !UUID.test(ledger.requesterHumanId)
    || ledger.contentNamespaceId !== task.contentNamespaceId
    || ledger.anchorNamespaceId !== task.contentNamespaceId
    || ledger.objectId !== objectId || ledger.representation !== run.representation
    || ledger.payloadVersion !== 1 || ledger.accessRevision !== 0
    || !sameBytes(ledger.requiredNamespaceFingerprint, run.requiredNamespaceFingerprint)
    || ledger.completion !== "complete" || ledger.disposition !== "mapped"
    || ledger.nextAttemptAt !== null || ledger.leaseToken !== null
    || ledger.leaseExpiresAt !== null || ledger.failureCode !== null
    || ledger.cryptoCompletedAt === null) return null;

  if (coordinates.kind === "raw") {
    if (binding.deliveryMode !== "raw" && binding.deliveryMode !== "raw_and_wake"
      || binding.messageOperationId !== protectedTaskRunMessageOperationId(run.id)) return null;
  } else if (binding.deliveryMode !== "wake" && binding.deliveryMode !== "raw_and_wake"
    || binding.wakeOperationId !== protectedTaskRunWakeOperationId(run.id)) return null;

  return Object.freeze({
    proof: Object.freeze({
      requesterUserId: task.requesterUserId,
      requesterHumanId: ledger.requesterHumanId,
      agentId: task.agentId,
      contentNamespaceId: task.contentNamespaceId,
      representation: policy.mode === "encrypted_only" ? "protected" : "dual",
      expectedPolicyRevision: policy.revision,
      acceptedPolicyRevision: binding.acceptedPolicyRevision,
      result: Object.freeze({
        taskId: task.id,
        taskRunId: run.id,
        terminalStatus,
        contentRevision: revision,
        objectId,
        cryptoAccessRevision: run.accessRevision,
        genesisManifestHash: Uint8Array.from(ledger.requestDigest),
        signerAgentId: task.agentId,
      }),
    }),
    binding,
    terminalAt: new Date(run.completedAt),
  });
}

async function loadForegroundState(
  tx: ProductTx,
  product: ProductState,
  kind: "raw" | "wake",
  createSession?: Pick<CanonicalTranscriptTx, "insert">,
): Promise<ForegroundState | null> {
  const { proof, binding } = product;
  const roomId = binding.destinationRoomId;
  const namespaceId = binding.destinationNamespaceId;
  if (roomId === null || namespaceId === null) return null;
  const [room] = await tx.select({
    id: rooms.id,
    ownerId: rooms.ownerId,
    namespaceId: rooms.namespaceId,
    graphThreadId: rooms.graphThreadId,
    archivedAt: rooms.archivedAt,
  }).from(rooms).where(eq(rooms.id, roomId)).limit(2).for("share");
  if (room === undefined || room.namespaceId !== namespaceId
    || room.archivedAt !== null) return null;
  const members = await tx.select({
    kind: actors.kind,
    ownerId: actors.ownerId,
    agentId: actors.agentId,
  }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, room.id)).for("share");
  const humans = members.filter(member => member.kind === "user");
  const agents = members.filter(member => member.kind === "agent");
  if (!humans.some(member => member.ownerId === proof.requesterUserId)
    || !humans.some(member => member.ownerId === room.ownerId)
    || !agents.some(member => member.agentId === proof.agentId)) return null;
  const threadId = deriveProtectedTaskDeliveryGraphThreadId({
    roomId: room.id,
    roomGraphThreadId: room.graphThreadId,
    targetAgentId: proof.agentId,
    members: members.map(member => ({
      actorKind: member.kind,
      actorOwnerId: member.ownerId,
      actorAgentId: member.agentId,
    })),
  });
  if (threadId === null) return null;
  const readSession = () => tx.select({
    id: sessions.id,
    ownerId: sessions.ownerId,
    agentId: sessions.agentId,
    roomId: sessions.roomId,
    threadId: sessions.threadId,
    personaId: sessions.personaId,
  }).from(sessions).where(and(
    eq(sessions.ownerId, room.ownerId),
    eq(sessions.threadId, threadId),
  )).limit(2).for("share");
  let sessionRows = await readSession();
  if (sessionRows.length === 0 && createSession !== undefined) {
    await createSession.insert(sessions).values({
      ownerId: room.ownerId, agentId: proof.agentId, roomId: room.id,
      threadId, personaId: "owner", title: null,
    }).onConflictDoNothing({ target: [sessions.ownerId, sessions.threadId] });
    sessionRows = await readSession();
  }
  const session = sessionRows.length === 1 ? sessionRows[0] : undefined;
  if (session === undefined || session.ownerId !== room.ownerId
    || session.agentId !== proof.agentId || session.roomId !== room.id
    || session.threadId !== threadId || session.personaId !== "owner") return null;

  if (kind === "raw") {
    const invocation = Object.freeze({
      kind: "raw" as const,
      bindingId: binding.bindingId,
      operationId: binding.messageOperationId!,
      roomId: room.id,
      sessionId: session.id,
    });
    if (binding.messageId === null && binding.messagePublishedAt === null) {
      if (binding.completedAt !== null || binding.wakeJobId !== null
        || binding.wakeScheduledAt !== null) return null;
      return Object.freeze({ invocation, state: "raw_unpublished" as const });
    }
    if (binding.messageId === null || binding.messagePublishedAt === null) return null;
    const [message] = await tx.select({
      id: sessionMessages.id,
      sessionId: sessionMessages.sessionId,
      revision: sessionMessages.editRevision,
      role: sessionMessages.role,
      objectId: sessionMessages.cryptoObjectId,
      contentIsNull: isNull(sessionMessages.content).mapWith(Boolean),
      toolCallsIsNull: isNull(sessionMessages.toolCalls).mapWith(Boolean),
      toolNameIsNull: isNull(sessionMessages.toolName).mapWith(Boolean),
    }).from(sessionMessages).where(and(
      eq(sessionMessages.id, binding.messageId),
      eq(sessionMessages.sessionId, session.id),
    )).limit(2).for("share");
    if (message === undefined) return null;
    const [revision] = await tx.select().from(sessionMessageCryptoRevisions)
      .where(and(
        eq(sessionMessageCryptoRevisions.sessionId, session.id),
        eq(sessionMessageCryptoRevisions.messageId, message.id),
        eq(sessionMessageCryptoRevisions.editRevision, message.revision),
      )).limit(2).for("share");
    const [association] = await tx.select().from(taskRunMessageAssociations)
      .where(and(
        eq(taskRunMessageAssociations.taskRunId, proof.result.taskRunId),
        eq(taskRunMessageAssociations.sessionId, session.id),
        eq(taskRunMessageAssociations.messageId, message.id),
        eq(taskRunMessageAssociations.publishedRevision, message.revision),
        eq(taskRunMessageAssociations.kind, "raw_delivery"),
        eq(taskRunMessageAssociations.publicationKey, binding.messageOperationId!),
      )).limit(2);
    const expectedRepresentation = proof.representation === "protected"
      ? "full_encryption" : "shadow_encryption";
    if (revision === undefined || association === undefined
      || message.role !== "assistant" || message.objectId === null
      || revision.cryptoObjectId !== message.objectId
      || revision.roomId !== room.id || revision.namespaceIdAtAllocation !== namespaceId
      || revision.appendIdempotencyKey !== binding.messageOperationId
      || revision.representationMode !== expectedRepresentation
      || (proof.representation === "protected"
        ? revision.publicationPolicyRevision === null
          || revision.publicationPolicyRevision < proof.acceptedPolicyRevision
        : revision.publicationPolicyRevision !== null)
      || revision.completion !== "complete" || revision.disposition !== "mapped"
      || revision.cryptoCompletedAt?.getTime() !== binding.messagePublishedAt.getTime()
      || binding.messagePublishedAt.getTime() < product.terminalAt.getTime()
      || revision.failureCode !== null || revision.payloadVersion !== 2
      || revision.keyClass !== "ai" || revision.authorRole !== "assistant"
      || proof.representation === "protected"
        && (!message.contentIsNull || !message.toolCallsIsNull || !message.toolNameIsNull)
      || binding.deliveryMode === "raw"
        && binding.completedAt?.getTime() !== binding.messagePublishedAt.getTime()) return null;
    return Object.freeze({ invocation, state: "raw_published" as const });
  }

  const reference: ProtectedTaskRunWakeReferenceV1 = Object.freeze({
    kind: "protected_task_delivery_v1",
    taskId: proof.result.taskId,
    taskRunId: proof.result.taskRunId,
    bindingId: binding.bindingId,
    resultObjectId: proof.result.objectId,
    wakeOperationId: binding.wakeOperationId!,
  });
  const jobId = protectedTaskRunWakeJobId(proof.result.taskRunId);
  if (binding.wakeJobId !== jobId || binding.wakeScheduledAt === null
    || binding.completedAt?.getTime() !== binding.wakeScheduledAt.getTime()
    || binding.deliveryMode === "raw_and_wake" && binding.messagePublishedAt === null) return null;
  const [job] = await tx.select({
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    roomId: jobs.roomId,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    resultIsNull: isNull(jobs.result).mapWith(Boolean),
    messageIsNull: isNull(jobs.message).mapWith(Boolean),
    metadataIsEmpty: eq(jobs.metadata, {}).mapWith(Boolean),
    createdAt: jobs.createdAt,
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  }).from(jobs).where(eq(jobs.id, jobId)).limit(2).for("update");
  const state = job?.status === "queued" && job.startedAt === null
      && job.completedAt === null ? "wake_queued"
    : job?.status === "running" && job.startedAt !== null
      && job.completedAt === null ? "wake_running"
    : job?.status === "completed" && job.startedAt !== null
      && job.completedAt !== null ? "wake_completed"
    : job?.status === "failed" && job.startedAt !== null
      && job.completedAt !== null ? "wake_failed" : null;
  if (job === undefined || state === null || job.ownerId !== proof.requesterUserId
    || job.requestorId !== proof.requesterUserId || job.roomId !== room.id
    || job.laneKey !== `room:${room.id}` || job.type !== "foreground"
    || !job.resultIsNull || !job.messageIsNull || !job.metadataIsEmpty
    || !exactReference(job.input, reference)
    || job.createdAt.getTime() !== binding.wakeScheduledAt.getTime()
    || job.createdAt.getTime() < product.terminalAt.getTime()) return null;
  return Object.freeze({
    state,
    jobCreatedAt: job.createdAt.getTime(),
    ...(job.startedAt === null ? {} : { jobReceipt: Object.freeze({
      createdAt: job.createdAt.getTime(), startedAt: job.startedAt.getTime(),
      completedAt: job.completedAt?.getTime() ?? null,
    }) }),
    invocation: Object.freeze({
      kind: "wake" as const,
      bindingId: binding.bindingId,
      operationId: binding.wakeOperationId!,
      roomId: room.id,
      sessionId: session.id,
      jobId,
      reference,
    }),
  });
}

function initialStateAllows(
  expected: ProtectedTaskOutputReadInitialState,
  actual: ForegroundState["state"],
): boolean {
  return expected === actual;
}

function laterStateAllows(
  expected: ProtectedTaskOutputReadInitialState,
  actual: ForegroundState["state"],
): boolean {
  if (expected === "raw_unpublished") {
    return actual === "raw_unpublished" || actual === "raw_published";
  }
  if (expected === "wake_queued") {
    return actual === "wake_queued" || actual === "wake_running";
  }
  return actual === "wake_running" || actual === "wake_completed"
    || actual === "wake_failed";
}

type Dependencies = Readonly<{
  loadProduct: typeof loadProductState;
  loadForeground: typeof loadForegroundState;
  readContinuation?: typeof readLatestProtectedTaskWakeContinuation;
  withContinuation?: typeof withCurrentProtectedTaskWakeContinuation;
}>;

const productionDependencies: Dependencies = Object.freeze({
  loadProduct: loadProductState,
  loadForeground: loadForegroundState,
  readContinuation: readLatestProtectedTaskWakeContinuation,
  withContinuation: withCurrentProtectedTaskWakeContinuation,
});

export type ProtectedTaskOutputReadProductProofLoader = Readonly<{
  validateCurrentTaskRun(
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
  ): Promise<boolean>;
  validateCurrentForeground(
    product: PostgresJsBridgeConnection,
    transaction: CanonicalTranscriptTx,
    coordinates: Readonly<{
      destinationRoomId: string;
      destinationNamespaceId: string;
      foregroundNamespaceIds: readonly string[];
    }>,
  ): Promise<boolean>;
  readCurrent(): ProtectedTaskOutputReadClosedProof | null;
  reset(): void;
}>;

declare const committedWakeSettlementBrand: unique symbol;
/** Operation-local proof; it does not authorize another grant, start or write. */
export type ProtectedTaskWakeCommittedSettlement = Readonly<{
  [committedWakeSettlementBrand]: true;
}>;

type TerminalWakeReceipt = Readonly<{
  proof: ProtectedTaskOutputReadClosedProof;
  state: "wake_completed" | "wake_failed";
  job: WakeJobReceipt;
}>;
const terminalObservations = new WeakMap<ProtectedTaskOutputReadProductProofLoader,
  () => TerminalWakeReceipt | null>();
const committedWakeSettlements = new WeakMap<ProtectedTaskWakeCommittedSettlement, TerminalWakeReceipt>();

declare const committedWakeParkBrand: unique symbol;
/** Product park receipt only; never authority to open a new grant or write. */
export type ProtectedTaskWakeCommittedPark = Readonly<{ [committedWakeParkBrand]: true }>;
type ParkedWakeObservation = Readonly<{
  proof: ProtectedTaskOutputReadClosedProof;
  continuation: ProtectedTaskWakeContinuationReceipt;
  jobCreatedAt: number;
}>;
const parkedObservations = new WeakMap<ProtectedTaskOutputReadProductProofLoader, () => ParkedWakeObservation | null>();
const committedWakeParks = new WeakMap<ProtectedTaskWakeCommittedPark, ParkedWakeObservation>();

/** Capture only after the canonical running-to-queued product transaction commits. */
export async function withCommittedProtectedTaskWakePark<Value>(
  commit: (capture: (loader: ProtectedTaskOutputReadProductProofLoader) => void) => Promise<Value>,
): Promise<Readonly<{ value: Value; receipt: ProtectedTaskWakeCommittedPark | null }>> {
  let active = true;
  let observation: ParkedWakeObservation | null = null;
  try {
    const value = await commit(loader => {
      if (!active || observation !== null) throw new TypeError("Wake park capture is closed");
      const observed = parkedObservations.get(loader)?.();
      if (observed == null) throw new TypeError("Wake park requires genuine running-to-queued receipt proof");
      observation = observed;
    });
    if (observation === null) return Object.freeze({ value, receipt: null });
    const receipt = Object.freeze({}) as ProtectedTaskWakeCommittedPark;
    committedWakeParks.set(receipt, observation);
    return Object.freeze({ value, receipt });
  } finally { active = false; }
}

/** Exact public metadata from a committed park; it does not replace current product authority. */
export function readCommittedProtectedTaskWakePark(
  receipt: ProtectedTaskWakeCommittedPark,
  intent: ProtectedTaskOutputReadIntent,
  recipientGeneration: number,
): ProtectedTaskWakeContinuationReceipt {
  const observed = committedWakeParks.get(receipt);
  if (observed === undefined || intent.invocation.kind !== "wake"
    || !sameProof(intent, observed.proof)
    || observed.continuation.priorRecipientGeneration !== recipientGeneration) {
    throw new TypeError("Wake committed park proof is invalid");
  }
  return structuredClone(observed.continuation);
}

/** Special capture loader; only an already running operation can observe its own park. */
export function createProtectedTaskWakeParkingProductProofLoader(intent: ProtectedTaskOutputReadIntent): ProtectedTaskOutputReadProductProofLoader {
  if (intent.initialState !== "wake_running" || intent.invocation.kind !== "wake") {
    throw new TypeError("Wake park requires a running invocation");
  }
  return createOutputProofLoader(intent, "wake_running", productionDependencies, undefined, { observe: true });
}

/** Read-only post-park reproof for the still-live old grant's final callback assertions. */
export function createProtectedTaskWakeParkedProductProofLoader(
  intent: ProtectedTaskOutputReadIntent,
  receipt: ProtectedTaskWakeCommittedPark,
): ProtectedTaskOutputReadProductProofLoader {
  const observed = committedWakeParks.get(receipt);
  if (observed === undefined || intent.initialState !== "wake_running" || !sameProof(intent, observed.proof)) {
    throw new TypeError("Wake committed park proof is invalid");
  }
  return createOutputProofLoader(intent, "wake_running", productionDependencies, undefined, { observe: false, receipt: observed });
}

/** The callback must enclose the canonical transaction, including its commit. */
export async function withCommittedProtectedTaskWakeSettlement<Value>(
  commit: (capture: (loader: ProtectedTaskOutputReadProductProofLoader) => void) => Promise<Value>,
): Promise<Readonly<{ value: Value; receipt: ProtectedTaskWakeCommittedSettlement | null }>> {
  let active = true;
  let observation: TerminalWakeReceipt | null = null;
  try {
    const value = await commit(loader => {
      if (!active || observation !== null) throw new TypeError("Wake settlement capture is closed");
      const observed = terminalObservations.get(loader)?.();
      if (observed == null) throw new TypeError("Wake settlement requires a genuine running-to-terminal proof");
      observation = observed;
    });
    if (observation === null) return Object.freeze({ value, receipt: null });
    const receipt = Object.freeze({}) as ProtectedTaskWakeCommittedSettlement;
    committedWakeSettlements.set(receipt, observation);
    return Object.freeze({ value, receipt });
  } finally { active = false; }
}

/** Exact post-commit reproof only; ordinary discovery still rejects terminal Jobs. */
export function createProtectedTaskWakeSettledProductProofLoader(
  intent: ProtectedTaskOutputReadIntent,
  receipt: ProtectedTaskWakeCommittedSettlement,
): ProtectedTaskOutputReadProductProofLoader {
  const observed = committedWakeSettlements.get(receipt);
  if (observed === undefined || intent.initialState !== "wake_running"
    || intent.invocation.kind !== "wake" || !sameProof(intent, observed.proof)) {
    throw new TypeError("Wake committed settlement proof is invalid");
  }
  return createOutputProofLoader(intent, "wake_running", productionDependencies, observed);
}

/**
 * Binds one detached closed intent to the two callbacks owned by Task output
 * Namespace authority. No proof is exposed until both callback phases succeed.
 */
export function createProtectedTaskOutputReadProductProofLoader(
  intentInput: ProtectedTaskOutputReadIntent,
  dependencies: Dependencies = productionDependencies,
): ProtectedTaskOutputReadProductProofLoader {
  return createOutputProofLoader(intentInput, intentInput.initialState, dependencies);
}

/** Recovery re-proves immutable source metadata without opening a read grant. */
export function createProtectedTaskOutputReadRecoveryProductProofLoader(
  proof: ProtectedTaskOutputReadClosedProof,
  dependencies: Dependencies = productionDependencies,
): ProtectedTaskOutputReadProductProofLoader {
  if (proof.invocation.kind !== "raw" || proof.result.contentRevision !== 1) {
    throw new TypeError("Task result Message recovery requires a normal raw result");
  }
  return createOutputProofLoader(proof, "raw_recovery", dependencies);
}

function createOutputProofLoader(
  intentInput: ProtectedTaskOutputReadClosedProof,
  initialState: ProtectedTaskOutputReadInitialState | "raw_recovery",
  dependencies: Dependencies,
  settled?: TerminalWakeReceipt,
  park?: Readonly<{ observe: boolean; receipt?: ParkedWakeObservation }>,
): ProtectedTaskOutputReadProductProofLoader {
  const intent = copyProof(intentInput);
  const coordinates: Coordinates = Object.freeze({
    taskId: intent.result.taskId,
    taskRunId: intent.result.taskRunId,
    kind: intent.invocation.kind,
  });
  let transaction: CanonicalTranscriptTx | null = null;
  let admittedTransaction: CanonicalTranscriptTx | null = null;
  let productState: ProductState | null = null;
  let current: ProtectedTaskOutputReadClosedProof | null = null;
  let generation = 0;
  let validationPhase: "initial" | "later" = "initial";
  let runningObservation: Readonly<{ tx: CanonicalTranscriptTx; job: WakeJobReceipt }> | null = null;
  let terminalObservation: TerminalWakeReceipt | null = null;
  let parkObservation: ParkedWakeObservation | null = null;

  const clear = (): void => {
    transaction = null;
    productState = null;
    current = null;
    terminalObservation = null;
    parkObservation = null;
  };

  const loader: ProtectedTaskOutputReadProductProofLoader = Object.freeze({
    async validateCurrentTaskRun(_product, tx) {
      clear();
      generation += 1;
      validationPhase = admittedTransaction === tx ? "later" : "initial";
      const state = await dependencies.loadProduct(tx, coordinates);
      if (state === null) return false;
      const candidate: ProtectedTaskOutputReadClosedProof = {
        ...state.proof,
        ...(intent.continuation === undefined ? {} : { continuation: intent.continuation }),
        invocation: intent.invocation,
      };
      if (!sameProof(candidate, intent)) return false;
      transaction = tx;
      productState = state;
      return true;
    },
    async validateCurrentForeground(_product, tx, foreground) {
      const thisGeneration = generation;
      const thisPhase = validationPhase;
      current = null;
      terminalObservation = null;
      parkObservation = null;
      if (transaction !== tx || productState === null
        || foreground.destinationRoomId !== intent.invocation.roomId
        || foreground.destinationNamespaceId !== productState.binding.destinationNamespaceId
        || foreground.foregroundNamespaceIds.length < 1
        || !foreground.foregroundNamespaceIds.includes(
          foreground.destinationNamespaceId)) return false;
      const observed = await dependencies.loadForeground(
        tx, productState, intent.invocation.kind,
      );
      const isParked = observed?.state === "wake_queued" && observed.jobCreatedAt !== undefined
        && (park?.receipt !== undefined && observed.jobCreatedAt === park.receipt.jobCreatedAt
          || park?.observe === true && thisPhase === "later" && runningObservation?.tx === tx
            && observed.jobCreatedAt === runningObservation.job.createdAt);
      if (thisGeneration !== generation) return false;
      if (observed === null) return false;
      if (!sameProof({ ...productState.proof,
        ...(intent.continuation === undefined ? {} : { continuation: intent.continuation }),
        invocation: observed.invocation }, intent)) return false;
      if (isParked ? false : park?.receipt !== undefined ? true : settled !== undefined
          ? observed.state !== settled.state || observed.jobReceipt === undefined
            || observed.jobReceipt.createdAt !== settled.job.createdAt
            || observed.jobReceipt.startedAt !== settled.job.startedAt
            || observed.jobReceipt.completedAt !== settled.job.completedAt
          : initialState === "raw_recovery"
          ? observed.state !== "raw_unpublished" && observed.state !== "raw_published"
          : thisPhase === "initial"
            ? !initialStateAllows(initialState, observed.state)
            : !laterStateAllows(initialState, observed.state)) return false;
      if (intent.invocation.kind === "wake") {
        const retained = intent.continuation;
        const latest = dependencies.readContinuation === undefined ? null
          : await dependencies.readContinuation(tx, intent.invocation.jobId);
        if (isParked ? latest === null || latest === undefined
          || park?.receipt !== undefined && !sameContinuation(latest, park.receipt.continuation)
          || park?.observe === true && retained !== undefined && latest.segment <= retained.segment
          : !sameContinuation(latest ?? undefined, retained)) return false;
        const selectedContinuation = isParked ? latest! : retained;
        if (selectedContinuation !== undefined) {
          const retained = selectedContinuation;
          if (retained.taskId !== intent.result.taskId || retained.taskRunId !== intent.result.taskRunId
            || retained.bindingId !== intent.invocation.bindingId
            || retained.wakeJobId !== intent.invocation.jobId
            || retained.wakeOperationId !== intent.invocation.operationId
            || retained.wakeAuthorizationRequestId !== `task-wake-authorization:${intent.invocation.jobId}`) return false;
          if (observed.state === "wake_queued" || observed.state === "wake_running") {
            if (dependencies.withContinuation === undefined) return false;
            const verified = await dependencies.withContinuation(tx, {
              wakeJobId: retained.wakeJobId, segment: retained.segment,
              priorRecipientGeneration: retained.priorRecipientGeneration,
              wakeAuthorizationRequestId: retained.wakeAuthorizationRequestId,
              jobState: observed.state === "wake_queued" ? "queued" : "running",
            }, async proof => {
              await proof.assertCurrent();
              return sameContinuation(proof.receipt, retained);
            });
            if (verified !== true) return false;
          } else if (settled === undefined && runningObservation?.tx !== tx) return false;
          if (isParked && observed.jobCreatedAt !== undefined) {
            parkObservation = Object.freeze({ proof: copyProof(intent), continuation: structuredClone(retained),
              jobCreatedAt: observed.jobCreatedAt });
          }
          // A terminal continuation can only be re-observed through the same
          // running-to-terminal transaction or the genuine committed receipt.
        }
      }
      if (thisGeneration !== generation) return false;
      current = copyProof(intent);
      if (settled === undefined && initialState === "wake_running" && observed.jobReceipt !== undefined) {
        if (observed.state === "wake_running") {
          runningObservation = Object.freeze({ tx, job: observed.jobReceipt });
        } else if ((observed.state === "wake_completed" || observed.state === "wake_failed")
          && runningObservation?.tx === tx
          && observed.jobReceipt.completedAt !== null
          && observed.jobReceipt.createdAt === runningObservation.job.createdAt
          && observed.jobReceipt.startedAt === runningObservation.job.startedAt) {
          terminalObservation = Object.freeze({ proof: copyProof(intent), state: observed.state,
            job: Object.freeze({ ...observed.jobReceipt }) });
        }
      }
      admittedTransaction = tx;
      return true;
    },
    readCurrent() {
      return current === null ? null : copyProof(current);
    },
    reset() {
      clear();
      generation = 0;
      admittedTransaction = null;
      validationPhase = "initial";
      runningObservation = null;
    },
  });
  if (dependencies === productionDependencies && park?.observe === true) {
    parkedObservations.set(loader, () => current === null ? null : parkObservation);
  }
  if (dependencies === productionDependencies && settled === undefined && park === undefined) {
    terminalObservations.set(loader, () => current === null ? null : terminalObservation);
  }
  return loader;
}

/** Includes already-published raw metadata solely for immutable receipt replay. */
export async function readProtectedTaskOutputReadClosedProof(
  transaction: CanonicalTranscriptTx,
  coordinates: Readonly<{ taskId: string; taskRunId: string; kind: "raw" }>,
): Promise<ProtectedTaskOutputReadClosedProof | null> {
  if (!UUID.test(coordinates.taskId) || !UUID.test(coordinates.taskRunId)
    || coordinates.kind !== "raw") throw new TypeError("Task raw recovery coordinates are invalid");
  const product = await loadProductState(transaction, coordinates);
  if (product === null || product.proof.result.contentRevision !== 1) return null;
  const foreground = await loadForegroundState(transaction, product, "raw");
  if (foreground === null) return null;
  return copyProof({ ...product.proof, invocation: foreground.invocation });
}

/** Detached discovery. Revalidation must use a fresh proof loader. */
export async function readProtectedTaskOutputReadIntent(
  transaction: CanonicalTranscriptTx,
  coordinates: Coordinates,
  options: Readonly<{ ensureDestinationSession?: boolean }> = {},
): Promise<ProtectedTaskOutputReadIntent | null> {
  if (!UUID.test(coordinates.taskId) || !UUID.test(coordinates.taskRunId)
    || coordinates.kind !== "raw" && coordinates.kind !== "wake") {
    throw new TypeError("Protected Task output read coordinates are invalid");
  }
  const product = await loadProductState(transaction, coordinates);
  if (product === null) return null;
  const foreground = await loadForegroundState(
    transaction, product, coordinates.kind,
    options.ensureDestinationSession === true ? transaction : undefined,
  );
  if (foreground === null || foreground.state === "raw_published"
    || foreground.state === "wake_completed" || foreground.state === "wake_failed") return null;
  const continuation = coordinates.kind === "wake" && foreground.invocation.kind === "wake"
    ? await readLatestProtectedTaskWakeContinuation(transaction, foreground.invocation.jobId) : null;
  return Object.freeze({
    ...copyProof({ ...product.proof, invocation: foreground.invocation,
      ...(continuation === null ? {} : { continuation }) }),
    initialState: foreground.state,
  });
}
