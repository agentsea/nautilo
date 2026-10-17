import {
  MAX_SUBAGENT_DEPTH,
  ModelSelectionError,
  getDefaultModel,
  getProfileByAgentId,
  getRelayRegistry,
  resolveExactTaskModelId,
  resolveTaskModel,
  type NautiloProfile,
  type ForegroundChatFundingSession,
  type ProtectedRepoDocsOpenedSelection,
  type ProtectedRepoDocsExecutionPort,
  type ProtectedTaskProjectFilePort,
  type RunScopeSubagentOpts,
} from "@nautilo/agent";
import {
  attachProtectedTaskRunModel,
  bindProtectedTaskRunFunding,
  and,
  eq,
  jobs,
  sql,
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
  assertTaskFundingAdmission,
  computeTaskRelayCapabilities,
  getCurrentAcceptedInvocationAuthority,
  openTaskFundingSession,
  resolveToolWhitelist,
  resolveTaskReturnBinding,
  type ProtectedTaskNativeExecution,
  type ProtectedTaskPredispatchPlan,
  type ProtectedTaskRunningOccurrence,
  type TaskFundingRunSource,
  type TaskFundingTaskSource,
  type TaskRuntimeGrantClaimPlan,
} from "@nautilo/runtime";
import {
  assertAcceptedInvocationAuthoritySubject,
  assertCanUseServerProviderCredentials,
  getAcceptedInvocationAuthorityOrigin,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { parseLocalExecutionDelegation, parseTaskFundingBinding, type TaskFundingBinding } from "@nautilo/types";

import { withProtectedTaskFundingAuthority } from "../lib/native-task-funding";
import { resolveProtectedTaskLocalExecutionPort } from "./protected-task-local-execution";
import { createProtectedTaskRepoDocsLocalExecutionPort } from "./protected-task-repo-docs-local-execution";
import { createProtectedTaskRepoDocsProjectFilePort } from "./protected-task-repo-docs-project-file";
import { parseProtectedTaskRepoDocsSelection, protectedTaskRepoDocsSelectionProjection,
  sameProtectedTaskRepoDocsSelection } from "./protected-task-repo-docs-selection";

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
  | "protectedRepoDocs"
> & Readonly<{
  protectedRepoDocsExecutionPort?: ProtectedRepoDocsExecutionPort;
  createProtectedRepoDocsProjectFilePort?(workDir: string): ProtectedTaskProjectFilePort;
}>;

type JobReference = TaskRuntimeGrantClaimPlan["reference"];
type OperationalTask = Readonly<Omit<TaskFundingTaskSource, "metadata"> & Pick<Task,
  | "scheduleKind" | "status" | "localExecutionDelegation"
> & { repoDocsSelection?: unknown }>;
type OperationalRun = Readonly<TaskFundingRunSource & Pick<TaskRun,
  | "startedAt" | "completedAt" | "resultRepresentation"
  | "resultContentNamespaceId" | "resultRevision" | "resultCryptoObjectId"
  | "resultCryptoAccessRevision" | "resultCryptoRequiredNamespaceFingerprint"
  | "resultCryptoMappingState"
> & {
  resultTextIsNull: boolean;
  lastErrorIsNull: boolean;
}>;
type OperationalJob = Readonly<Pick<
  Job,
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
  repoDocs?: ProtectedRepoDocsOpenedSelection;
  signal: AbortSignal;
  assertCurrentTaskAuthority(): Promise<void>;
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
    bindProtectedTaskRunFunding?: typeof bindProtectedTaskRunFunding;
    assertTaskFundingAdmission?: typeof assertTaskFundingAdmission;
    openTaskFundingSession?: typeof openTaskFundingSession;
    getCurrentAcceptedInvocationAuthority?:
      typeof getCurrentAcceptedInvocationAuthority;
    withProtectedTaskFundingAuthority?:
      typeof withProtectedTaskFundingAuthority;
    resolveLocalExecutionPort?: typeof resolveProtectedTaskLocalExecutionPort;
    createRepoDocsLocalExecutionPort?: typeof createProtectedTaskRepoDocsLocalExecutionPort;
    createRepoDocsProjectFilePort?: typeof createProtectedTaskRepoDocsProjectFilePort;
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
    status: tasks.status,
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
    localExecutionDelegation: tasks.localExecutionDelegation,
    repoDocsSelection: protectedTaskRepoDocsSelectionProjection(),
    contentRepresentation: tasks.contentRepresentation,
    contentNamespaceId: tasks.contentNamespaceId,
    contentRevision: tasks.contentRevision,
    cryptoObjectId: tasks.cryptoObjectId,
    cryptoAccessRevision: tasks.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      tasks.cryptoRequiredNamespaceFingerprint,
    cryptoMappingState: tasks.cryptoMappingState,
  }).from(tasks)
    .where(eq(tasks.id, taskId)).limit(1);
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
    resultTextIsNull:
      sql<boolean>`${taskRuns.resultText} is null`,
    lastErrorIsNull:
      sql<boolean>`${taskRuns.lastError} is null`,
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
  const [row] = await db.select().from(jobs).where(and(
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
    task.localExecutionDelegation,
  ]);
}

function currentTaskAndRun(
  occurrence: ProtectedTaskRunningOccurrence,
  predispatch: ProtectedTaskPredispatchPlan,
  task: OperationalTask,
  run: OperationalRun,
  expectedModelId: string | null | undefined,
  expectedFundingBinding: TaskFundingBinding | null | undefined,
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
    && (expectedFundingBinding === undefined
      ? run.fundingBinding !== null
      : expectedFundingBinding === null
        ? run.fundingBinding === null
        : sameFundingBinding(run.fundingBinding, expectedFundingBinding))
    && run.fundingPredecessorRunId === null
    && run.resultTextIsNull
    && run.completedAt === null
    && run.lastErrorIsNull
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

function fundingTaskSource(
  task: OperationalTask,
  metadata: TaskPayloadV1["protectedMetadata"],
): TaskFundingTaskSource {
  return Object.freeze({
    id: task.id,
    ownerId: task.ownerId,
    requestorId: task.requestorId,
    agentId: task.agentId,
    preset: task.preset,
    callingRoomId: task.callingRoomId,
    targetChat: task.targetChat,
    targetChatHandle: task.targetChatHandle,
    targetRoomId: task.targetRoomId,
    targetUserIds: Object.freeze([...task.targetUserIds]),
    resultDelivery: task.resultDelivery,
    useScope: task.useScope,
    scopeId: task.scopeId,
    toolsMode: task.toolsMode,
    toolsWhitelist: Object.freeze([...task.toolsWhitelist]),
    awaitResponse: task.awaitResponse,
    selectionProfile: task.selectionProfile,
    selectionSpec: task.selectionSpec,
    requestedModelId: task.requestedModelId,
    parentTaskId: task.parentTaskId,
    depth: task.depth,
    fundingMode: task.fundingMode,
    metadata: structuredClone(metadata),
    contentRepresentation: task.contentRepresentation,
    contentNamespaceId: task.contentNamespaceId,
    contentRevision: task.contentRevision,
    cryptoObjectId: task.cryptoObjectId,
    cryptoAccessRevision: task.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      task.cryptoRequiredNamespaceFingerprint === null
        ? null
        : Uint8Array.from(task.cryptoRequiredNamespaceFingerprint),
    cryptoMappingState: task.cryptoMappingState,
  });
}

function fundingRunSource(run: OperationalRun): TaskFundingRunSource {
  return Object.freeze({
    id: run.id,
    taskId: run.taskId,
    jobId: run.jobId,
    graphThreadId: run.graphThreadId,
    status: run.status,
    modelId: run.modelId,
    fundingBinding: structuredClone(run.fundingBinding),
    fundingPredecessorRunId: run.fundingPredecessorRunId,
  });
}

function sameFundingBinding(
  left: unknown,
  right: TaskFundingBinding,
): boolean {
  try {
    return JSON.stringify(parseTaskFundingBinding(left))
      === JSON.stringify(right);
  } catch {
    return false;
  }
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
        toolsWhitelist: [...task.toolsWhitelist],
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

function fundingBindingInput(
  occurrence: ProtectedTaskRunningOccurrence,
  reference: JobReference,
  modelId: string,
  fundingBinding: TaskFundingBinding,
): Parameters<typeof bindProtectedTaskRunFunding>[1] {
  return {
    ...bindingInput(occurrence, reference, modelId),
    fundingBinding,
  };
}

function protectedFundingSession(
  session: ForegroundChatFundingSession,
  assertCurrent: () => Promise<void>,
): ForegroundChatFundingSession {
  const recheckAttempt: ForegroundChatFundingSession["recheckAttempt"] =
    async (modelId, transport) => {
      await assertCurrent();
      try {
        await session.recheckAttempt(modelId, transport);
      } finally {
        await assertCurrent();
      }
    };
  const runAttempt: ForegroundChatFundingSession["runAttempt"] =
    async (modelId, run, transport) => {
      await assertCurrent();
      try {
        return await session.runAttempt(modelId, run, transport);
      } finally {
        await assertCurrent();
      }
    };
  return Object.freeze({
    ...session,
    recheckAttempt,
    runAttempt,
  });
}

function currentCallerFundingAuthority(
  authority: AcceptedInvocationAuthority | undefined,
  task: OperationalTask,
): AcceptedInvocationAuthority {
  if (authority === undefined) {
    throw new TypeError("Protected Task caller funding authority is unavailable");
  }
  assertAcceptedInvocationAuthoritySubject(authority, task.requestorId);
  if (getAcceptedInvocationAuthorityOrigin(authority).originTaskId !== task.id) {
    throw new TypeError("Protected Task caller funding authority changed");
  }
  return authority;
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
  const bindFunding = dependencies.bindProtectedTaskRunFunding
    ?? bindProtectedTaskRunFunding;
  const admitFunding = dependencies.assertTaskFundingAdmission
    ?? assertTaskFundingAdmission;
  const openFunding = dependencies.openTaskFundingSession
    ?? openTaskFundingSession;
  const currentInvocationAuthority =
    dependencies.getCurrentAcceptedInvocationAuthority
      ?? getCurrentAcceptedInvocationAuthority;
  const withFundingAuthority =
    dependencies.withProtectedTaskFundingAuthority
      ?? withProtectedTaskFundingAuthority;
  const taskReturnBinding = dependencies.resolveTaskReturnBinding
    ?? resolveTaskReturnBinding;
  const relayCapabilities = dependencies.resolveRelayCapabilities
    ?? computeTaskRelayCapabilities;
  const toolResolver = dependencies.resolveToolWhitelist
    ?? resolveToolWhitelist;
  const resolveLocalExecution = dependencies.resolveLocalExecutionPort
    ?? resolveProtectedTaskLocalExecutionPort;

  return async input => {
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
    if (task.preset === "repo_docs" ? input.repoDocs === undefined
      || !sameProtectedTaskRepoDocsSelection(parseProtectedTaskRepoDocsSelection(task.repoDocsSelection),
        { mode: input.repoDocs.mode, publish: input.repoDocs.publish })
      || task.toolsMode !== "whitelist" || task.toolsWhitelist.length !== 1 || task.toolsWhitelist[0] !== "file"
      : input.repoDocs !== undefined) {
      throw new TypeError("Protected Task repo docs selection changed");
    }
    const reference = currentJob(input.occurrence, task, job);
    if (reference === null) {
      throw new TypeError("Protected Task execution Job is no longer current");
    }
    const initialSegment = reference.executionSegment === 1;
    const callerFunding = task.fundingMode === "caller";
    if (task.fundingMode !== "legacy_server" && !callerFunding) {
      throw new TypeError("Protected Task funding mode is invalid");
    }
    if (!currentTaskAndRun(
      input.occurrence,
      input.predispatch,
      task,
      run,
      initialSegment ? null : undefined,
      callerFunding && !initialSegment ? undefined : null,
    )) {
      throw new TypeError("Protected Task execution is no longer current");
    }
    const admittedFundingTask = fundingTaskSource(
      task,
      input.repoDocs === undefined ? input.protectedMetadata : {
        ...input.protectedMetadata, mode: input.repoDocs.mode, publish: input.repoDocs.publish,
      },
    );
    const admittedFundingRun = fundingRunSource(run);

    const expectedSelection = executionSelection(task);
    const delegatedLocalExecutionPort = await resolveLocalExecution({
      db: dependencies.db,
      occurrence: input.occurrence,
      signal: input.signal,
      assertCurrentTaskAuthority: input.assertCurrentTaskAuthority,
    });
    const profile = await readProfile(task.agentId);
    const toolWhitelist = toolResolver(
      { ...task, toolsWhitelist: [...task.toolsWhitelist] },
      input.predispatch.memory.envelope,
    );
    const subagentDepth = task.depth + 1;
    if (!Number.isSafeInteger(subagentDepth)
      || subagentDepth < 0
      || subagentDepth > MAX_SUBAGENT_DEPTH) {
      throw new TypeError("Protected Task execution depth is invalid");
    }

    let modelId: string;
    let exactModel: boolean;
    let fundingBinding: TaskFundingBinding | null = null;
    const invocationAuthority = callerFunding
      ? currentCallerFundingAuthority(currentInvocationAuthority(), task)
      : undefined;
    if (callerFunding) {
      const admission = await withFundingAuthority(
        input.assertCurrentTaskAuthority,
        () => admitFunding(
          admittedFundingTask,
          initialSegment ? undefined : admittedFundingRun,
        ),
      );
      if (admission === null) {
        throw new TypeError("Protected Task caller funding is unavailable");
      }
      modelId = admission.modelId;
      exactModel = task.requestedModelId !== null;
      fundingBinding = admission.binding;
    } else {
      await assertServerFunding(task.requestorId, "task_execute");
      const selection = selectLegacyModel(task, profile, dependencies);
      modelId = selection.modelId;
      exactModel = selection.exact;
    }

    let attached: Awaited<ReturnType<typeof attachProtectedTaskRunModel>>;
    if (callerFunding) {
      if (fundingBinding === null) {
        throw new TypeError("Protected Task caller funding is unavailable");
      }
      attached = await withFundingAuthority(
        input.assertCurrentTaskAuthority,
        () => bindFunding(
          dependencies.db,
          fundingBindingInput(
            input.occurrence,
            reference,
            modelId,
            fundingBinding,
          ),
        ),
      );
    } else {
      attached = await attachModel(
        dependencies.db,
        bindingInput(input.occurrence, reference, modelId),
      );
    }
    if (attached.status === "stale") {
      throw new TypeError(callerFunding
        ? "Protected Task execution funding binding is stale"
        : "Protected Task execution model binding is stale");
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
        modelId,
        fundingBinding,
      )
      || executionSelection(currentTask) !== expectedSelection
      || input.repoDocs !== undefined && !sameProtectedTaskRepoDocsSelection(
        parseProtectedTaskRepoDocsSelection(currentTask.repoDocsSelection),
        { mode: input.repoDocs.mode, publish: input.repoDocs.publish },
      )
      || finalReference === null
      || !sameReference(reference, finalReference)) {
      throw new TypeError("Protected Task execution changed after model binding");
    }

    let fundingSession: ForegroundChatFundingSession | null = null;
    if (callerFunding) {
      const currentFundingTask = fundingTaskSource(
        currentTask,
        input.repoDocs === undefined ? input.protectedMetadata : {
          ...input.protectedMetadata, mode: input.repoDocs.mode, publish: input.repoDocs.publish,
        },
      );
      const currentFundingRun = fundingRunSource(currentRun);
      fundingSession = await withFundingAuthority(
        input.assertCurrentTaskAuthority,
        () => openFunding({
          task: currentFundingTask,
          run: currentFundingRun,
          authority: invocationAuthority,
          requestorId: currentTask.requestorId,
          modelId,
          jobId: input.occurrence.run.jobId,
          graphThreadId: currentFundingRun.graphThreadId,
        }),
      );
      if (fundingSession === null) {
        throw new TypeError("Protected Task caller funding is unavailable");
      }
    }

    const returnBinding = taskReturnBinding(
      currentTask.id,
      currentTask.ownerId,
      getRelayRegistry() as Parameters<typeof resolveTaskReturnBinding>[2],
    );
    const hasReturnBinding = returnBinding.status === "available";
    const currentRelayCapabilities = relayCapabilities(currentTask.ownerId);
    let protectedRepoDocsExecutionPort: ProtectedRepoDocsExecutionPort | undefined;
    let createProtectedRepoDocsProjectFilePort: ((workDir: string) => ProtectedTaskProjectFilePort) | undefined;
    if (input.repoDocs !== undefined) {
      if (delegatedLocalExecutionPort === undefined) {
        throw new TypeError("Protected repo docs project authority is unavailable");
      }
      const delegation = parseLocalExecutionDelegation(currentTask.localExecutionDelegation);
      if (delegation === null) throw new TypeError("Protected repo docs project source is unavailable");
      const repoDocsRegistry = getRelayRegistry();
      if (repoDocsRegistry === null) throw new TypeError("Protected repo docs relay is unavailable");
      const repoDocsContext = {
        delegated: delegatedLocalExecutionPort, registry: repoDocsRegistry,
        state: { currentTaskId: currentTask.id, currentTaskRunId: currentRun.id,
          agentId: currentTask.agentId, roomId: input.predispatch.scheduling.roomId,
          currentThreadId: currentRun.graphThreadId, langgraphThreadId: currentRun.graphThreadId,
          causalHumanUserId: currentTask.requestorId, trustedExecutionEntrypoint: "background.task" as const },
        selection: input.repoDocs, modelId, signal: input.signal, assertCurrent: input.assertCurrentTaskAuthority,
      };
      protectedRepoDocsExecutionPort = (
        dependencies.createRepoDocsLocalExecutionPort ?? createProtectedTaskRepoDocsLocalExecutionPort
      )(repoDocsContext);
      createProtectedRepoDocsProjectFilePort = workDir => (
        dependencies.createRepoDocsProjectFilePort ?? createProtectedTaskRepoDocsProjectFilePort
      )({ ...repoDocsContext, workspaceRoot: workDir, relayId: delegation.target.relayId });
    }
    return Object.freeze({
      ...(toolWhitelist === undefined
        ? {}
        : { toolWhitelist: [...toolWhitelist] }),
      assistantName: profile?.name ?? "Genie",
      soulFile: profile?.soulFile ?? "",
      modelId,
      currentFolder: hasReturnBinding ? returnBinding.currentFolder ?? "" : "",
      workspacePath: hasReturnBinding ? returnBinding.workspacePath ?? "" : "",
      subagentDepth,
      subagentMaxDepth: MAX_SUBAGENT_DEPTH,
      roomRoster: [],
      ...(currentRelayCapabilities === undefined
        ? {}
        : { relayCapabilities: currentRelayCapabilities }),
      ...(fundingSession === null
        ? {}
        : {
            foregroundChatFundingSession: protectedFundingSession(
              fundingSession,
              input.assertCurrentTaskAuthority,
            ),
          }),
      ...(delegatedLocalExecutionPort === undefined
        ? {}
        : { delegatedLocalExecutionPort }),
      ...(protectedRepoDocsExecutionPort === undefined ? {} : { protectedRepoDocsExecutionPort }),
      ...(createProtectedRepoDocsProjectFilePort === undefined ? {} : { createProtectedRepoDocsProjectFilePort }),
      modelFallbackMode: exactModel ? "none" : "agent_chain",
    });
  };
}
