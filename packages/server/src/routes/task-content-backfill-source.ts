import {
  and,
  eq,
  inArray,
  isProtectedTaskPreset,
  taskRuns,
  tasks,
  type Task,
  type TaskContentBackfillClaim,
  type TaskRun,
} from "@nautilo/db";
import {
  classifyTaskHistoricalContentSourceV1,
  type TaskHistoricalContentSourceClassificationV1,
  type TaskHistoricalContentSourceV1,
  type TaskHistoricalOperationalFieldsV1,
} from "@nautilo/lattice-bridge";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const ACTIVE_RUN_STATUSES = ["running", "awaiting", "paused"] as const;

type TaskCommonSourceRow = Pick<Task,
  | "id" | "ownerId" | "requestorId" | "agentId"
  | "metadata"
  | "preset" | "scheduleKind" | "runAt" | "cron" | "timezone" | "catchup"
  | "callingRoomId" | "targetChat" | "targetChatHandle" | "targetRoomId"
  | "targetUserIds" | "resultDelivery" | "useScope" | "scopeId"
  | "toolsMode" | "toolsWhitelist" | "selectionProfile" | "selectionSpec"
  | "requestedModelId" | "fundingMode" | "timeLimitSeconds" | "awaitResponse"
  | "localExecutionDelegation" | "parentTaskId" | "depth"
  | "status" | "fireLockId" | "contentRepresentation"
  | "contentNamespaceId" | "contentRevision" | "cryptoObjectId"
  | "cryptoAccessRevision" | "cryptoRequiredNamespaceFingerprint"
  | "cryptoMappingState" | "createdAt" | "updatedAt"
>;
type TaskDefinitionSourceRow = TaskCommonSourceRow & Pick<Task,
  "prompt" | "expectedOutput" | "lastError"
>;

type ResultSourceRow = Pick<TaskRun,
  | "id" | "taskId" | "status" | "resultText" | "lastError"
  | "startedAt" | "completedAt" | "resultRepresentation"
  | "resultContentNamespaceId" | "resultRevision" | "resultCryptoObjectId"
  | "resultCryptoAccessRevision" | "resultCryptoRequiredNamespaceFingerprint"
  | "resultCryptoMappingState"
>;

export type TaskContentBackfillSourceRead = Readonly<{
  source: TaskHistoricalContentSourceV1;
  agentId: string;
  contentNamespaceId: string | null;
  classification: TaskHistoricalContentSourceClassificationV1;
}>;

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function exactOrdinaryDefinition(task: TaskCommonSourceRow): boolean {
  return task.contentRepresentation === "ordinary"
    && task.contentNamespaceId === null
    && task.contentRevision === 0
    && task.cryptoObjectId === null
    && task.cryptoAccessRevision === 0
    && task.cryptoRequiredNamespaceFingerprint === null
    && task.cryptoMappingState === "unmapped";
}

function exactProtectedParent(task: TaskCommonSourceRow): boolean {
  return (task.contentRepresentation === "dual"
      || task.contentRepresentation === "protected")
    && task.contentNamespaceId !== null
    && task.contentRevision > 0
    && task.cryptoObjectId !== null
    && task.cryptoAccessRevision >= 0
    && task.cryptoRequiredNamespaceFingerprint instanceof Uint8Array
    && task.cryptoRequiredNamespaceFingerprint.length === 32
    && task.cryptoMappingState === "verified";
}

function exactOrdinaryResult(run: ResultSourceRow): boolean {
  return run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

function operationalFields(task: TaskCommonSourceRow): Readonly<{
  fields: TaskHistoricalOperationalFieldsV1;
  exactTools: boolean;
}> {
  const fields: TaskHistoricalOperationalFieldsV1 = {
    scheduleKind: task.scheduleKind,
    ...(task.runAt === null ? {} : { runAt: task.runAt.toISOString() }),
    ...(task.cron === null ? {} : { cron: task.cron }),
    timezone: task.timezone,
    targetChat: task.targetChat as TaskHistoricalOperationalFieldsV1["targetChat"],
    ...(task.toolsMode === "auto" ? {} : {
      tools: task.toolsMode === "none" ? [] : [...task.toolsWhitelist],
    }),
    resultDelivery: task.resultDelivery,
    useScope: task.useScope,
    scopeId: task.scopeId,
    parentTaskId: task.parentTaskId,
    timeLimitSeconds: task.timeLimitSeconds,
    selectionProfile: task.selectionProfile,
    selectionSpec: task.selectionSpec,
    requestedModelId: task.requestedModelId,
  };
  const exactTools = task.toolsMode === "whitelist"
    || task.toolsWhitelist.length === 0;
  return Object.freeze({ fields: Object.freeze(fields), exactTools });
}

function classify(
  source: TaskHistoricalContentSourceV1,
  exactTools: boolean,
): TaskHistoricalContentSourceClassificationV1 {
  return exactTools
    ? classifyTaskHistoricalContentSourceV1(source)
    : Object.freeze({ status: "unsupported", reason: "operational_fields" });
}

const commonTaskProjection = {
  id: tasks.id,
  ownerId: tasks.ownerId,
  requestorId: tasks.requestorId,
  agentId: tasks.agentId,
  metadata: tasks.metadata,
  preset: tasks.preset,
  scheduleKind: tasks.scheduleKind,
  runAt: tasks.runAt,
  cron: tasks.cron,
  timezone: tasks.timezone,
  catchup: tasks.catchup,
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
  selectionProfile: tasks.selectionProfile,
  selectionSpec: tasks.selectionSpec,
  requestedModelId: tasks.requestedModelId,
  fundingMode: tasks.fundingMode,
  timeLimitSeconds: tasks.timeLimitSeconds,
  awaitResponse: tasks.awaitResponse,
  localExecutionDelegation: tasks.localExecutionDelegation,
  parentTaskId: tasks.parentTaskId,
  depth: tasks.depth,
  status: tasks.status,
  fireLockId: tasks.fireLockId,
  contentRepresentation: tasks.contentRepresentation,
  contentNamespaceId: tasks.contentNamespaceId,
  contentRevision: tasks.contentRevision,
  cryptoObjectId: tasks.cryptoObjectId,
  cryptoAccessRevision: tasks.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
  cryptoMappingState: tasks.cryptoMappingState,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
} as const;

async function readDefinitionTask(
  tx: CanonicalTranscriptTx,
  taskId: string,
): Promise<TaskDefinitionSourceRow | null> {
  const [task] = await tx.select({
    ...commonTaskProjection,
    prompt: tasks.prompt,
    expectedOutput: tasks.expectedOutput,
    lastError: tasks.lastError,
  }).from(tasks).where(eq(tasks.id, taskId)).limit(2);
  return task ?? null;
}

async function readResultTask(
  tx: CanonicalTranscriptTx,
  taskId: string,
): Promise<TaskCommonSourceRow | null> {
  const [task] = await tx.select(commonTaskProjection).from(tasks)
    .where(eq(tasks.id, taskId)).limit(2);
  return task ?? null;
}

function exactCommonTask(
  task: TaskCommonSourceRow,
  claim: TaskContentBackfillClaim,
): task is TaskCommonSourceRow & Readonly<{
  preset: TaskHistoricalContentSourceV1["preset"];
}> {
  return task.id === claim.candidate.taskId
    && task.ownerId === claim.requesterUserId
    && task.requestorId === claim.requesterUserId
    && task.parentTaskId === null
    && task.depth === 0
    && isProtectedTaskPreset(task.preset)
    && sameDate(task.updatedAt, claim.candidate.sourceUpdatedAt);
}

/**
 * Read one exact historical ordinary Task source through the caller's already
 * admitted canonical transaction. This helper never opens or retains another
 * connection and returns classification alongside the lossless source.
 */
export async function readTaskContentBackfillSource(
  tx: CanonicalTranscriptTx,
  claim: TaskContentBackfillClaim,
): Promise<TaskContentBackfillSourceRead | null> {
  if (claim.candidate.kind === "definition") {
    const task = await readDefinitionTask(tx, claim.candidate.taskId);
    if (task === null || !exactCommonTask(task, claim)) return null;
    const operational = operationalFields(task);
    if (!exactOrdinaryDefinition(task)
      || !sameDate(task.createdAt, claim.candidate.sourceCreatedAt)
      || task.contentRevision !== claim.candidate.sourceRevision
      || task.status !== claim.candidate.sourceStatus) return null;
    const [activeRun] = await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(
      eq(taskRuns.taskId, task.id),
      inArray(taskRuns.status, ACTIVE_RUN_STATUSES),
    )).limit(1);
    const source: TaskHistoricalContentSourceV1 = Object.freeze({
      kind: "definition",
      taskId: task.id,
      requesterHumanId: claim.humanActorId,
      sourceRevision: 0,
      taskCreatedAt: new Date(task.createdAt),
      taskUpdatedAt: new Date(task.updatedAt),
      taskStatus: task.status,
      activeRun: task.fireLockId !== null || activeRun !== undefined,
      parentTaskId: task.parentTaskId,
      taskLastError: task.lastError,
      prompt: task.prompt,
      expectedOutput: task.expectedOutput,
      metadata: task.metadata,
      operationalFields: operational.fields,
      agentId: task.agentId,
      preset: task.preset,
      catchup: task.catchup,
      callingRoomId: task.callingRoomId,
      targetChatHandle: task.targetChatHandle,
      targetRoomId: task.targetRoomId,
      targetUserIds: [...task.targetUserIds],
      awaitResponse: task.awaitResponse,
      fundingMode: task.fundingMode,
      localExecutionDelegation: task.localExecutionDelegation,
    });
    return Object.freeze({
      source,
      agentId: task.agentId,
      contentNamespaceId: null,
      classification: classify(source, operational.exactTools),
    });
  }

  const task = await readResultTask(tx, claim.candidate.taskId);
  if (task === null || !exactCommonTask(task, claim)) return null;
  const operational = operationalFields(task);
  if (!exactProtectedParent(task) || task.contentNamespaceId === null) return null;
  const [run] = await tx.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    status: taskRuns.status,
    resultText: taskRuns.resultText,
    lastError: taskRuns.lastError,
    startedAt: taskRuns.startedAt,
    completedAt: taskRuns.completedAt,
    resultRepresentation: taskRuns.resultRepresentation,
    resultContentNamespaceId: taskRuns.resultContentNamespaceId,
    resultRevision: taskRuns.resultRevision,
    resultCryptoObjectId: taskRuns.resultCryptoObjectId,
    resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
    resultCryptoRequiredNamespaceFingerprint:
      taskRuns.resultCryptoRequiredNamespaceFingerprint,
    resultCryptoMappingState: taskRuns.resultCryptoMappingState,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, claim.candidate.taskRunId),
    eq(taskRuns.taskId, claim.candidate.taskId),
  )).limit(2);
  if (run === undefined || run.taskId !== task.id || !exactOrdinaryResult(run)
    || run.completedAt === null
    || run.status !== "completed" && run.status !== "errored" && run.status !== "cancelled"
    || run.status !== claim.candidate.sourceStatus
    || run.resultRevision !== claim.candidate.sourceRevision
    || !sameDate(run.startedAt, claim.candidate.sourceStartedAt)
    || !sameDate(run.completedAt, claim.candidate.sourceCompletedAt)) return null;

  const source: TaskHistoricalContentSourceV1 = Object.freeze({
    kind: "run_result",
    taskId: task.id,
    taskRunId: run.id,
    requesterHumanId: claim.humanActorId,
    sourceRevision: 0,
    taskCreatedAt: new Date(task.createdAt),
    taskUpdatedAt: new Date(task.updatedAt),
    taskStatus: task.status,
    runStartedAt: new Date(run.startedAt),
    runCompletedAt: new Date(run.completedAt),
    runStatus: run.status,
    resultText: run.resultText,
    lastError: run.lastError,
    metadata: task.metadata,
    operationalFields: operational.fields,
    agentId: task.agentId,
    preset: task.preset,
    catchup: task.catchup,
    callingRoomId: task.callingRoomId,
    targetChatHandle: task.targetChatHandle,
    targetRoomId: task.targetRoomId,
    targetUserIds: [...task.targetUserIds],
    awaitResponse: task.awaitResponse,
    fundingMode: task.fundingMode,
    localExecutionDelegation: task.localExecutionDelegation,
  });
  return Object.freeze({
    source,
    agentId: task.agentId,
    contentNamespaceId: task.contentNamespaceId,
    classification: classify(source, operational.exactTools),
  });
}
