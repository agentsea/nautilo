import {
  MAX_SUBAGENT_DEPTH,
  ModelSelectionError,
  getDefaultModel,
  getProfileByAgentId,
  getRelayRegistry,
  resolveExactTaskModelId,
  resolveTaskModel,
  type NautiloProfile,
  type RunScopeSubagentOpts,
} from "@nautilo/agent";
import {
  attachProtectedTaskRunModel,
  and,
  eq,
  jobs,
  taskRuns,
  tasks,
  type DirectDatabase,
  type Job,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import type { TaskPayloadV1 } from "@nautilo/lattice-bridge";
import {
  assertProtectedTaskJobReferenceV1,
  computeTaskRelayCapabilities,
  resolveToolWhitelist,
  resolveTaskReturnBinding,
  type ProtectedTaskNativeExecution,
  type ProtectedTaskPredispatchPlan,
  type ProtectedTaskRunningOccurrence,
  type TaskRuntimeGrantClaimPlan,
} from "@nautilo/runtime";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";

type FixedExecutionContext = Omit<
  ProtectedTaskNativeExecution,
  | "parentThreadId"
  | "parentTurnId"
  | "parentOwnerId"
  | "causalHumanUserId"
  | "brief"
  | "expectedOutput"
  | "subEnvelope"
  | "actorRole"
  | "roomId"
  | "callingRoomId"
>;

type JobReference = TaskRuntimeGrantClaimPlan["reference"];
type OperationalTask = Readonly<Pick<Task,
  | "id"
  | "ownerId"
  | "requestorId"
  | "agentId"
  | "preset"
  | "scheduleKind"
  | "callingRoomId"
  | "targetChat"
  | "targetChatHandle"
  | "targetRoomId"
  | "targetUserIds"
  | "useScope"
  | "scopeId"
  | "toolsMode"
  | "toolsWhitelist"
  | "awaitResponse"
  | "selectionProfile"
  | "selectionSpec"
  | "requestedModelId"
  | "parentTaskId"
  | "depth"
  | "status"
  | "fundingMode"
  | "contentRepresentation"
  | "contentNamespaceId"
  | "contentRevision"
  | "cryptoObjectId"
  | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint"
  | "cryptoMappingState"
>>;
type OperationalRun = Readonly<Pick<TaskRun,
  | "id"
  | "taskId"
  | "jobId"
  | "graphThreadId"
  | "status"
  | "modelId"
  | "fundingBinding"
  | "fundingPredecessorRunId"
  | "startedAt"
  | "completedAt"
  | "resultRepresentation"
  | "resultContentNamespaceId"
  | "resultRevision"
  | "resultCryptoObjectId"
  | "resultCryptoAccessRevision"
  | "resultCryptoRequiredNamespaceFingerprint"
  | "resultCryptoMappingState"
>>;
type OperationalJob = Readonly<Pick<Job,
  | "id"
  | "ownerId"
  | "requestorId"
  | "laneKey"
  | "type"
  | "status"
  | "input"
  | "startedAt"
  | "completedAt"
>>;

type ReadTask = (
  db: DirectDatabase,
  taskId: string,
) => Promise<OperationalTask | undefined>;
type ReadRun = (
  db: DirectDatabase,
  taskId: string,
  taskRunId: string,
) => Promise<OperationalRun | undefined>;
type ReadJob = (
  db: DirectDatabase,
  jobId: string,
  ownerId: string,
) => Promise<OperationalJob | undefined>;

export type ProtectedTaskNativeExecutionContextInput = Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  predispatch: ProtectedTaskPredispatchPlan;
  protectedMetadata: TaskPayloadV1["protectedMetadata"];
}>;

export type ProductionProtectedTaskNativeExecutionContextDependencies =
  Readonly<{
    db: DirectDatabase;
    /** The ordinary Task dispatch resolver; server composition supplies it. */
    resolveToolWhitelist?: typeof resolveToolWhitelist;
    readTask?: ReadTask;
    readRun?: ReadRun;
    readJob?: ReadJob;
    getProfileByAgentId?: typeof getProfileByAgentId;
    getDefaultModel?: typeof getDefaultModel;
    resolveExactTaskModelId?: typeof resolveExactTaskModelId;
    resolveTaskModel?: typeof resolveTaskModel;
    assertCanUseServerProviderCredentials?:
      typeof assertCanUseServerProviderCredentials;
    attachProtectedTaskRunModel?: typeof attachProtectedTaskRunModel;
    resolveTaskReturnBinding?: typeof resolveTaskReturnBinding;
    resolveRelayCapabilities?: (
      ownerId: string,
    ) => RunScopeSubagentOpts["relayCapabilities"];
  }>;

async function readOperationalTask(
  db: DirectDatabase,
  taskId: string,
): Promise<OperationalTask | undefined> {
  const [row] = await db.select({
    id: tasks.id,
    ownerId: tasks.ownerId,
    requestorId: tasks.requestorId,
    agentId: tasks.agentId,
    preset: tasks.preset,
    scheduleKind: tasks.scheduleKind,
    callingRoomId: tasks.callingRoomId,
    targetChat: tasks.targetChat,
    targetChatHandle: tasks.targetChatHandle,
    targetRoomId: tasks.targetRoomId,
    targetUserIds: tasks.targetUserIds,
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
    status: tasks.status,
    fundingMode: tasks.fundingMode,
    contentRepresentation: tasks.contentRepresentation,
    contentNamespaceId: tasks.contentNamespaceId,
    contentRevision: tasks.contentRevision,
    cryptoObjectId: tasks.cryptoObjectId,
    cryptoAccessRevision: tasks.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
    cryptoMappingState: tasks.cryptoMappingState,
  }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row;
}

async function readOperationalRun(
  db: DirectDatabase,
  taskId: string,
  taskRunId: string,
): Promise<OperationalRun | undefined> {
  const [row] = await db.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    jobId: taskRuns.jobId,
    graphThreadId: taskRuns.graphThreadId,
    status: taskRuns.status,
    modelId: taskRuns.modelId,
    fundingBinding: taskRuns.fundingBinding,
    fundingPredecessorRunId: taskRuns.fundingPredecessorRunId,
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
    eq(taskRuns.id, taskRunId),
    eq(taskRuns.taskId, taskId),
  )).limit(1);
  return row;
}

async function readOperationalJob(
  db: DirectDatabase,
  jobId: string,
  ownerId: string,
): Promise<OperationalJob | undefined> {
  const [row] = await db.select({
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  }).from(jobs).where(and(
    eq(jobs.id, jobId),
    eq(jobs.ownerId, ownerId),
  )).limit(1);
  return row as OperationalJob | undefined;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameOccurrence(
  running: ProtectedTaskRunningOccurrence,
  predispatch: ProtectedTaskPredispatchPlan,
): boolean {
  const awaiting = predispatch.occurrence;
  return running.task.id === awaiting.task.id
    && running.task.ownerId === awaiting.task.ownerId
    && running.task.requestorId === awaiting.task.requestorId
    && running.task.agentId === awaiting.task.agentId
    && running.task.callingRoomId === awaiting.task.callingRoomId
    && running.task.scheduleKind === awaiting.task.scheduleKind
    && running.task.contentRepresentation
      === awaiting.task.contentRepresentation
    && running.task.contentNamespaceId === awaiting.task.contentNamespaceId
    && running.task.contentRevision === awaiting.task.contentRevision
    && running.task.cryptoObjectId === awaiting.task.cryptoObjectId
    && running.task.cryptoAccessRevision === awaiting.task.cryptoAccessRevision
    && sameBytes(
      running.task.cryptoRequiredNamespaceFingerprint,
      awaiting.task.cryptoRequiredNamespaceFingerprint,
    )
    && running.run.id === awaiting.run.id
    && running.run.taskId === awaiting.run.taskId
    && running.run.graphThreadId === awaiting.run.graphThreadId
    && running.run.startedAt.getTime() === awaiting.run.startedAt.getTime()
    && running.run.status === "running"
    && typeof running.run.jobId === "string"
    && running.run.jobId.length > 0;
}

function executionSelection(task: OperationalTask): string {
  return JSON.stringify([
    task.preset, task.targetChat, task.targetChatHandle, task.targetUserIds,
    task.useScope, task.scopeId, task.toolsMode, task.toolsWhitelist,
    task.awaitResponse, task.selectionProfile, task.selectionSpec,
    task.requestedModelId, task.parentTaskId, task.depth, task.fundingMode,
  ]);
}

function currentTaskAndRun(
  occurrence: ProtectedTaskRunningOccurrence,
  predispatch: ProtectedTaskPredispatchPlan,
  task: OperationalTask,
  run: OperationalRun,
  expectedModelId: string | null | undefined,
): boolean {
  const expectedTaskStatus = task.scheduleKind === "cron"
    ? "pending"
    : "running";
  return sameOccurrence(occurrence, predispatch)
    && task.id === occurrence.task.id
    && task.ownerId === occurrence.task.ownerId
    && task.requestorId === occurrence.task.requestorId
    && task.agentId === occurrence.task.agentId
    && task.callingRoomId === occurrence.task.callingRoomId
    && task.scheduleKind === occurrence.task.scheduleKind
    && task.status === expectedTaskStatus
    && task.targetRoomId === predispatch.target.roomId
    && predispatch.target.targetUserIds.every(
      userId => userId === task.requestorId || task.targetUserIds.includes(userId),
    )
    && task.targetUserIds.every(
      userId => userId === task.requestorId || predispatch.target.targetUserIds.includes(userId),
    )
    && task.contentRepresentation === occurrence.task.contentRepresentation
    && task.contentNamespaceId === occurrence.task.contentNamespaceId
    && task.contentRevision === occurrence.task.contentRevision
    && task.cryptoObjectId === occurrence.task.cryptoObjectId
    && task.cryptoAccessRevision === occurrence.task.cryptoAccessRevision
    && task.cryptoMappingState === "verified"
    && sameBytes(
      task.cryptoRequiredNamespaceFingerprint,
      occurrence.task.cryptoRequiredNamespaceFingerprint,
    )
    && run.id === occurrence.run.id
    && run.taskId === task.id
    && run.jobId === occurrence.run.jobId
    && run.graphThreadId === occurrence.run.graphThreadId
    && run.status === "running"
    && run.startedAt.getTime() === occurrence.run.startedAt.getTime()
    && (expectedModelId === undefined
      ? run.modelId !== null
      : run.modelId === expectedModelId)
    && run.fundingBinding === null
    && run.fundingPredecessorRunId === null
    && run.completedAt === null
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

function currentJob(
  occurrence: ProtectedTaskRunningOccurrence,
  task: OperationalTask,
  job: OperationalJob,
): JobReference | null {
  if (
    job.id !== occurrence.run.jobId
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.status !== "queued" && job.status !== "running"
    || job.status === "queued" && job.startedAt !== null
    || job.status === "running" && job.startedAt === null
    || job.completedAt !== null
  ) return null;
  try {
    assertProtectedTaskJobReferenceV1(job.input);
  } catch {
    return null;
  }
  const reference = job.input;
  return reference.taskId === task.id
      && reference.taskRunId === occurrence.run.id
      && reference.inputObjectId === task.cryptoObjectId
    ? reference
    : null;
}

function sameReference(left: JobReference, right: JobReference): boolean {
  return left.kind === right.kind
    && left.taskId === right.taskId
    && left.taskRunId === right.taskRunId
    && left.inputObjectId === right.inputObjectId
    && left.resultObjectId === right.resultObjectId
    && left.authorizationRequestId === right.authorizationRequestId
    && left.policyRevision === right.policyRevision
    && left.executionSegment === right.executionSegment
    && left.resumeAcceptanceId === right.resumeAcceptanceId
    && left.resumeContinuationFingerprint
      === right.resumeContinuationFingerprint;
}

function selectLegacyModel(
  task: OperationalTask,
  profile: NautiloProfile | null,
  dependencies: ProductionProtectedTaskNativeExecutionContextDependencies,
): Readonly<{ modelId: string; exact: boolean }> {
  if (task.requestedModelId !== null && task.requestedModelId !== undefined) {
    return Object.freeze({
      modelId: (
        dependencies.resolveExactTaskModelId ?? resolveExactTaskModelId
      )({
        requestedModelId: task.requestedModelId,
        toolsMode: task.toolsMode,
        toolsWhitelist: task.toolsWhitelist,
      }),
      exact: true,
    });
  }
  const baseModelId = profile?.defaultModel?.trim()
    || (dependencies.getDefaultModel ?? getDefaultModel)().id;
  try {
    return Object.freeze({
      modelId: (dependencies.resolveTaskModel ?? resolveTaskModel)({
        baseModelId,
        profile: task.selectionProfile,
        spec: task.selectionSpec,
      }).modelId,
      exact: false,
    });
  } catch (error) {
    if (error instanceof ModelSelectionError) {
      throw new Error(`[task-model-selection] ${error.detail.message}`);
    }
    throw error;
  }
}

function bindingInput(
  occurrence: ProtectedTaskRunningOccurrence,
  reference: JobReference,
  modelId: string,
): Parameters<typeof attachProtectedTaskRunModel>[1] {
  return {
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    graphThreadId: occurrence.run.graphThreadId,
    jobId: occurrence.run.jobId,
    contentRepresentation: occurrence.task.contentRepresentation,
    contentNamespaceId: occurrence.task.contentNamespaceId,
    contentRevision: occurrence.task.contentRevision,
    cryptoObjectId: occurrence.task.cryptoObjectId,
    cryptoAccessRevision: occurrence.task.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
    jobReference: reference,
    modelId,
  };
}

/**
 * Load and bind the non-content execution context for one initial native
 * protected Task segment. Every durable identity is re-read before and after
 * model attachment; this function never invokes ordinary Task dispatch.
 */
export function createProductionProtectedTaskNativeExecutionContext(
  dependencies: ProductionProtectedTaskNativeExecutionContextDependencies,
): (
  input: ProtectedTaskNativeExecutionContextInput,
) => Promise<FixedExecutionContext> {
  const readTask = dependencies.readTask ?? readOperationalTask;
  const readRun = dependencies.readRun ?? readOperationalRun;
  const readJob = dependencies.readJob ?? readOperationalJob;
  const readProfile = dependencies.getProfileByAgentId ?? getProfileByAgentId;
  const assertServerFunding = dependencies.assertCanUseServerProviderCredentials
    ?? assertCanUseServerProviderCredentials;
  const attachModel = dependencies.attachProtectedTaskRunModel
    ?? attachProtectedTaskRunModel;
  const taskReturnBinding = dependencies.resolveTaskReturnBinding
    ?? resolveTaskReturnBinding;
  const relayCapabilities = dependencies.resolveRelayCapabilities
    ?? computeTaskRelayCapabilities;
  const toolResolver = dependencies.resolveToolWhitelist
    ?? resolveToolWhitelist;

  return async input => {
    // The metadata is already authenticated protected definition content. It
    // deliberately supplies no operational fallback for the schema rows.
    void input.protectedMetadata;
    if (!sameOccurrence(input.occurrence, input.predispatch)) {
      throw new TypeError("Protected Task execution occurrence changed");
    }
    const [task, run, job] = await Promise.all([
      readTask(dependencies.db, input.occurrence.task.id),
      readRun(
        dependencies.db,
        input.occurrence.task.id,
        input.occurrence.run.id,
      ),
      readJob(
        dependencies.db,
        input.occurrence.run.jobId,
        input.occurrence.task.requestorId,
      ),
    ]);
    if (!task || !run || !job) {
      throw new TypeError("Protected Task execution is no longer current");
    }
    const reference = currentJob(input.occurrence, task, job);
    if (reference === null) {
      throw new TypeError("Protected Task execution Job is no longer current");
    }
    if (!currentTaskAndRun(
      input.occurrence,
      input.predispatch,
      task,
      run,
      reference.executionSegment === 1 ? null : undefined,
    )) {
      throw new TypeError("Protected Task execution is no longer current");
    }

    if ((task.fundingMode ?? "legacy_server") !== "legacy_server") {
      // The owning caller-funded Task contract deliberately supports only its
      // narrow ordinary text workload. Never fall through to server custody.
      throw new TypeError(
        "Caller-funded protected Task execution is unsupported",
      );
    }
    await assertServerFunding(task.requestorId, "task_execute");

    const expectedSelection = executionSelection(task);
    const profile = await readProfile(task.agentId);
    const selection = selectLegacyModel(task, profile, dependencies);
    const toolWhitelist = toolResolver(
      task,
      input.predispatch.memory.envelope,
    );
    const subagentDepth = task.depth + 1;
    if (!Number.isSafeInteger(subagentDepth)
      || subagentDepth < 0
      || subagentDepth > MAX_SUBAGENT_DEPTH) {
      throw new TypeError("Protected Task execution depth is invalid");
    }

    const attached = await attachModel(
      dependencies.db,
      bindingInput(input.occurrence, reference, selection.modelId),
    );
    if (attached.status === "stale") {
      throw new TypeError("Protected Task execution model binding is stale");
    }

    const [currentTask, currentRun, currentJobRow] = await Promise.all([
      readTask(dependencies.db, input.occurrence.task.id),
      readRun(
        dependencies.db,
        input.occurrence.task.id,
        input.occurrence.run.id,
      ),
      readJob(
        dependencies.db,
        input.occurrence.run.jobId,
        input.occurrence.task.requestorId,
      ),
    ]);
    const finalReference = currentTask && currentJobRow
      ? currentJob(input.occurrence, currentTask, currentJobRow)
      : null;
    if (!currentTask || !currentRun || !currentJobRow
      || !currentTaskAndRun(
        input.occurrence,
        input.predispatch,
        currentTask,
        currentRun,
        selection.modelId,
      )
      || executionSelection(currentTask) !== expectedSelection
      || finalReference === null
      || !sameReference(reference, finalReference)) {
      throw new TypeError("Protected Task execution changed after model binding");
    }

    const returnBinding = taskReturnBinding(
      currentTask.id,
      currentTask.ownerId,
      getRelayRegistry() as Parameters<typeof resolveTaskReturnBinding>[2],
    );
    const hasReturnBinding = returnBinding.status === "available";
    const currentRelayCapabilities = relayCapabilities(currentTask.ownerId);
    return Object.freeze({
      ...(toolWhitelist === undefined
        ? {}
        : { toolWhitelist: [...toolWhitelist] }),
      assistantName: profile?.name ?? "Genie",
      soulFile: profile?.soulFile ?? "",
      modelId: selection.modelId,
      currentFolder: hasReturnBinding ? returnBinding.currentFolder ?? "" : "",
      workspacePath: hasReturnBinding ? returnBinding.workspacePath ?? "" : "",
      subagentDepth,
      subagentMaxDepth: MAX_SUBAGENT_DEPTH,
      roomRoster: [],
      ...(currentRelayCapabilities === undefined
        ? {}
        : { relayCapabilities: currentRelayCapabilities }),
      modelFallbackMode: selection.exact ? "none" : "agent_chain",
    });
  };
}
