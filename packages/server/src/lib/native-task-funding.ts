import { AsyncLocalStorage } from "node:async_hooks";
import { createCapabilityFundingSession, prepareCapabilityFundingSession } from "./capability-funding";
import {
  modelIdForCapabilityProjection, getProfileByAgentId, resolveTaskModel,
  validateExactTaskModelSelection, resolveRetainedModels, resolveCatalogModel,
  type ForegroundChatFundingSession, isSupportedPersonalTool, readDeepResearchTaskMetadata,
} from "@nautilo/agent";
import { and, eq, isNull, rooms, namespaces, tasks, taskRuns, getServerProviderPolicy, getTaskById, getTaskRunForTask, getCachedServerModelConfigRow, recordTaskWakeFundingFailure, type TaskRun } from "@nautilo/db";
import { assertCanInvokeAgent, getUserCapabilities } from "@nautilo/trust";
import { TaskFundingError, taskFundingFailureCode, type TaskFundingPort, type TaskFundingAdmission,
  type TaskFundingRunSource, type TaskFundingTaskSource } from "@nautilo/runtime";
import { parseTaskFundingBinding, type TaskFundingBinding, type TaskFundingFailureCode } from "@nautilo/types";
import { isOwnPrivateGenieRoom, usageFundingFor } from "./foreground-chat-funding";
import { ModelFundingError, resolveModelFunding, withAdmittedPersonalProviderKey, type ModelFundingDecision } from "./model-funding";
import { getServerDirectDb } from "./server-direct-db";

import { callerTaskModelEnvironment, callerTaskModelIds, personalOnlyTaskModelIds } from "./caller-task-model-context";

type Candidate = Parameters<TaskFundingPort["prepareCreation"]>[0];
type ProtectedTaskFundingAuthority = () => Promise<void>;
const SCOPE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const protectedTaskFundingAuthority =
  new AsyncLocalStorage<ProtectedTaskFundingAuthority>();

export type ProtectedTaskWakeFundingTaskSource = TaskFundingTaskSource;

export type ProtectedTaskWakeFundingRunSource = TaskFundingRunSource;

type FundingTaskSource = Candidate | TaskFundingTaskSource;
type FundingRunSource = TaskRun | TaskFundingRunSource;

const protectedTaskProjection = {
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
  cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
  cryptoMappingState: tasks.cryptoMappingState,
} as const;

const protectedRunProjection = {
  id: taskRuns.id,
  taskId: taskRuns.taskId,
  jobId: taskRuns.jobId,
  graphThreadId: taskRuns.graphThreadId,
  status: taskRuns.status,
  modelId: taskRuns.modelId,
  fundingBinding: taskRuns.fundingBinding,
  fundingPredecessorRunId: taskRuns.fundingPredecessorRunId,
} as const;

async function readProtectedFundingTask(
  taskId: string,
): Promise<ProtectedTaskWakeFundingTaskSource | undefined> {
  const [task] = await getServerDirectDb().select(protectedTaskProjection)
    .from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return task;
}

async function readProtectedFundingRun(
  taskId: string,
  taskRunId: string,
): Promise<ProtectedTaskWakeFundingRunSource | undefined> {
  const [run] = await getServerDirectDb().select(protectedRunProjection)
    .from(taskRuns).where(and(eq(taskRuns.id, taskRunId),
      eq(taskRuns.taskId, taskId))).limit(1);
  return run;
}

/**
 * Borrow the live protected-definition authority for caller funding setup.
 * The callback is captured only by the request-local funding session and is
 * rechecked around every provider attempt; it is never serialized.
 */
export async function withProtectedTaskFundingAuthority<T>(
  assertCurrent: ProtectedTaskFundingAuthority,
  work: () => Promise<T>,
): Promise<T> {
  if (typeof assertCurrent !== "function" || typeof work !== "function") {
    throw new TypeError("Protected Task funding authority is invalid");
  }
  await assertCurrent();
  return protectedTaskFundingAuthority.run(assertCurrent, async () => {
    const result = await work();
    await assertCurrent();
    return result;
  });
}

export function shouldPrepareNativeTaskCallerFunding(
  metadata: Candidate["metadata"],
  access: Readonly<{
    allowPersonalProviderKeys: boolean;
    capabilities: readonly string[];
  }>,
): boolean {
  if (access.allowPersonalProviderKeys
    && access.capabilities.includes("use_personal_provider_credentials")) return true;
  return hasAdmittedDeepResearchFunding(metadata);
}

function hasAdmittedDeepResearchFunding(metadata: Candidate["metadata"]): boolean {
  try {
    return readDeepResearchTaskMetadata(metadata)?.version === 2;
  } catch {
    // Preserve the legacy server-funding path for inputs that are not a valid,
    // admitted v2 Deep Research task. The worker's metadata parser remains the
    // authority for rejecting malformed legacy definitions.
    return false;
  }
}

function supportedShape(task: FundingTaskSource): boolean {
  return task.ownerId === task.requestorId && !task.parentTaskId && (task.depth ?? 0) === 0
    && (task.contentRepresentation ?? "ordinary") === "ordinary"
    && ["none", "auto", "whitelist"].includes(task.toolsMode ?? "auto")
    && (task.toolsWhitelist ?? []).every(isSupportedPersonalTool)
    && !task.useScope && !task.scopeId && !task.targetChatHandle
    && (task.preset === "task" || task.preset === "in_background" || task.preset === "schedule")
    && (task.targetChat === "orphan" || task.targetChat === "last_in_namespace")
    && (task.targetUserIds ?? []).every((id) => id === task.requestorId)
    && !task.awaitResponse && Object.keys(task.metadata ?? {}).every((key) => key === "preparation" || key === "deepResearch");
}

function protectedRuntimeShape(task: FundingTaskSource): boolean {
  return task.ownerId === task.requestorId
    && !task.parentTaskId
    && (task.depth ?? 0) === 0
    && (task.contentRepresentation === "dual"
      || task.contentRepresentation === "protected")
    && task.contentNamespaceId !== null
    && task.contentNamespaceId !== undefined
    && Number.isSafeInteger(task.contentRevision)
    && (task.contentRevision ?? 0) > 0
    && typeof task.cryptoObjectId === "string"
    && task.cryptoObjectId.length > 0
    && Number.isSafeInteger(task.cryptoAccessRevision)
    && (task.cryptoAccessRevision ?? -1) >= 0
    && task.cryptoRequiredNamespaceFingerprint instanceof Uint8Array
    && task.cryptoRequiredNamespaceFingerprint.length === 32
    && task.cryptoMappingState === "verified"
    && ["none", "auto", "whitelist"].includes(task.toolsMode ?? "auto")
    && (task.toolsWhitelist ?? []).every(isSupportedPersonalTool)
    && (task.useScope === true
      ? typeof task.scopeId === "string" && SCOPE_UUID.test(task.scopeId)
      : task.useScope === false && task.scopeId == null)
    && !task.targetChatHandle
    && (task.preset === "task"
      || task.preset === "in_background"
      || task.preset === "schedule")
    && (task.targetChat === "orphan"
      || task.targetChat === "last_in_namespace")
    && (task.targetUserIds ?? []).every(id => id === task.requestorId)
    && !task.awaitResponse
    && Object.keys(task.metadata ?? {}).every(
      key => key === "preparation" || key === "deepResearch",
    );
}

function sameProtectedRuntimeCoordinates(
  current: FundingTaskSource,
  accepted: FundingTaskSource,
): boolean {
  if (!protectedRuntimeShape(accepted)) return true;
  const currentFingerprint = current.cryptoRequiredNamespaceFingerprint;
  const acceptedFingerprint = accepted.cryptoRequiredNamespaceFingerprint;
  return protectedRuntimeShape(current)
    && current.contentRepresentation === accepted.contentRepresentation
    && current.contentNamespaceId === accepted.contentNamespaceId
    && current.contentRevision === accepted.contentRevision
    && current.cryptoObjectId === accepted.cryptoObjectId
    && current.cryptoAccessRevision === accepted.cryptoAccessRevision
    && current.cryptoMappingState === accepted.cryptoMappingState
    && current.useScope === accepted.useScope
    && current.scopeId === accepted.scopeId
    && currentFingerprint instanceof Uint8Array
    && acceptedFingerprint instanceof Uint8Array
    && currentFingerprint.length === acceptedFingerprint.length
    && currentFingerprint.every(
      (value, index) => value === acceptedFingerprint[index],
    );
}

async function assertOwnShape(
  task: FundingTaskSource,
  retainedProtectedAuthority?: ProtectedTaskFundingAuthority,
): Promise<ProtectedTaskFundingAuthority | undefined> {
  const isProtected = protectedRuntimeShape(task);
  const authority = isProtected
    ? retainedProtectedAuthority ?? protectedTaskFundingAuthority.getStore()
    : undefined;
  if ((!supportedShape(task) && !isProtected)
    || isProtected && authority === undefined
    || !task.callingRoomId
    || !await isOwnPrivateGenieRoom(task.requestorId, task.callingRoomId, task.agentId)) {
    throw new TaskFundingError("unsupported_workload");
  }
  await authority?.();
  if (task.targetChat === "last_in_namespace" && task.targetRoomId
    && task.targetRoomId !== task.callingRoomId) {
    throw new TaskFundingError("unsupported_workload");
  }
  const [callingRoom] = await getServerDirectDb().select({ id: rooms.id })
    .from(rooms).innerJoin(namespaces, eq(rooms.namespaceId, namespaces.id))
    .where(and(eq(rooms.id, task.callingRoomId), eq(rooms.ownerId, task.requestorId),
      eq(rooms.type, "private"), eq(namespaces.scope, "private"), isNull(rooms.archivedAt))).limit(1);
  if (!callingRoom) throw new TaskFundingError("unsupported_workload");
  if (task.targetChat === "orphan" && task.targetRoomId) {
    const [room] = await getServerDirectDb().select({
      ownerId: rooms.ownerId, type: rooms.type, kind: rooms.kind,
      humanActorIds: rooms.humanActorIds, scope: namespaces.scope, label: namespaces.label,
    }).from(rooms).innerJoin(namespaces, eq(rooms.namespaceId, namespaces.id))
      .where(and(eq(rooms.id, task.targetRoomId), eq(rooms.ownerId, task.requestorId),
        isNull(rooms.archivedAt))).limit(1);
    if (!room || room.type !== "private" || room.kind !== "task"
      || room.humanActorIds.length !== 0 || room.scope !== "private"
      || room.label !== `task:${task.id}`) throw new TaskFundingError("unsupported_workload");
  }
  const research = readDeepResearchTaskMetadata(task.metadata);
  if (research && research.version !== 2) throw new TaskFundingError("unsupported_workload");
  if (research?.version === 2) {
    const session = createCapabilityFundingSession(task.requestorId);
    const lanes = { supervisor: research.modelPlan.supervisorModel, research: research.modelPlan.researchModel,
      summarization: research.modelPlan.summarizationModel, compression: research.modelPlan.compressionModel,
      finalReport: research.modelPlan.finalReportModel } as const;
    for (const lane of Object.keys(lanes) as (keyof typeof lanes)[]) {
      await session.openModel(lanes[lane], "research", research.modelFunding[lane]);
    }
    await session.openService("tavily", research.tavilyFunding);
  }
  await assertCanInvokeAgent({ humanUserId: task.requestorId, origin: "task_dispatch",
    agentId: task.agentId, roomId: task.callingRoomId });
  return authority;
}

function bindingFor(decision: ModelFundingDecision): TaskFundingBinding {
  return decision.kind === "personal"
    ? { kind: "personal", providerRoute: decision.providerRoute,
      credentialId: decision.credentialId, credentialRevision: decision.credentialRevision }
    : { kind: "server", providerRoute: decision.providerRoute };
}

function restoreDecision(task: Pick<FundingTaskSource, "id" | "requestorId">,
  run: Pick<FundingRunSource, "taskId" | "modelId" | "fundingBinding">,
): ModelFundingDecision {
  if (run.taskId !== task.id || !run.modelId) throw new TaskFundingError("funding_source_changed");
  let binding: TaskFundingBinding;
  try { binding = parseTaskFundingBinding(run.fundingBinding); }
  catch { throw new TaskFundingError("funding_source_changed"); }
  const base = { humanUserId: task.requestorId, modelId: run.modelId,
    providerRoute: binding.providerRoute, workload: "native_text_task" as const };
  return binding.kind === "personal"
    ? { ...base, ...binding, payerHumanId: task.requestorId }
    : { ...base, ...binding };
}

type TaskSelection = Readonly<Omit<Pick<Candidate,
  "agentId" | "requestorId" | "requestedModelId" | "selectionProfile" |
  "selectionSpec" | "toolsMode" | "toolsWhitelist">, "toolsWhitelist">> & Readonly<{
    toolsWhitelist?: readonly string[] | undefined;
  }>;

/** Match the shared Task-selection definition of whether this run needs tools. */
export function nativeTaskSelectionPurpose(
  task: Pick<TaskSelection, "toolsMode" | "toolsWhitelist">,
): "chat" | "task-tools" {
  if (task.toolsMode === "none") return "chat";
  if (task.toolsMode === "whitelist" && (task.toolsWhitelist?.length ?? 0) === 0) {
    return "chat";
  }
  return "task-tools";
}

export function assertNativeTaskRetainedModelSelection(
  modelId: string,
  task: Pick<TaskSelection, "toolsMode" | "toolsWhitelist">,
  env: NodeJS.ProcessEnv = {
    NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"],
  },
): void {
  const row = resolveRetainedModels([modelId], { purpose: nativeTaskSelectionPurpose(task), env })[0];
  const catalog = resolveCatalogModel(modelId, { env });
  if (!row || (row.availability !== "selectable" && row.availability !== "missing-key")) {
    throw new TaskFundingError("unsupported_provider");
  }
  if (catalog.workload !== "chat" || !catalog.output.includes("text")) throw new TaskFundingError("unsupported_workload");
}

export function validateNativeTaskExactModelSelection(
  task: Pick<TaskSelection,
    "requestedModelId" | "selectionProfile" | "selectionSpec" | "toolsMode" | "toolsWhitelist">,
  env: NodeJS.ProcessEnv = {
    NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"],
  },
) {
  return validateExactTaskModelSelection({
    requestedModelId: task.requestedModelId,
    profile: task.selectionProfile,
    spec: task.selectionSpec,
    toolsMode: task.toolsMode,
    toolsWhitelist: task.toolsWhitelist === undefined
      ? undefined
      : [...task.toolsWhitelist],
    env,
  });
}

async function selectTaskModel(task: TaskSelection, priorRun?: TaskFundingRunSource): Promise<string> {
  if (priorRun) {
    if (!priorRun.modelId || (task.requestedModelId && task.requestedModelId !== priorRun.modelId)) {
      throw new TaskFundingError("funding_source_changed");
    }
    assertNativeTaskRetainedModelSelection(priorRun.modelId, task);
    return priorRun.modelId;
  }
  if (task.requestedModelId) {
    const failure = validateNativeTaskExactModelSelection(task);
    if (failure && failure.code !== "missing_credentials") throw new Error(`[task-model-selection] ${failure.message}`);
    assertNativeTaskRetainedModelSelection(task.requestedModelId, task);
    return task.requestedModelId;
  }
  const profile = await getProfileByAgentId(task.agentId);
  const baseModelId = modelIdForCapabilityProjection("chat", profile?.defaultModel?.trim()
    || process.env["NAUTILO_MODEL"]?.trim() || getCachedServerModelConfigRow()?.defaultChatModel?.trim());
  if (!task.selectionSpec && (!task.selectionProfile || task.selectionProfile === "balanced")) {
    assertNativeTaskRetainedModelSelection(baseModelId, task);
    return baseModelId;
  }
  const env = await callerTaskModelEnvironment(task.requestorId);
  return resolveTaskModel({ baseModelId,
    profile: task.selectionProfile ?? null, spec: task.selectionSpec ?? null, env,
    purpose: nativeTaskSelectionPurpose(task),
    runnableModelIds: await callerTaskModelIds(task.requestorId) }).modelId;
}

async function selectRunnableTaskModel(task: TaskSelection): Promise<string | null> {
  const modelId = await selectTaskModel(task);
  const runnable = await callerTaskModelIds(task.requestorId);
  return runnable.includes(modelId) ? modelId : null;
}

/** Validate the persisted selection for the Task's next fresh occurrence. */
export async function assertRunnableNativeTaskSelection(
  input: TaskSelection,
): Promise<void> {
  if (!await selectRunnableTaskModel(input)) {
    throw new TaskFundingError("provider_credentials_missing");
  }
}

/** Classify the actual worker selection without reading or exposing key plaintext. */
export async function isPersonalOnlyNativeTaskSelection(
  input: Omit<TaskSelection,
    "selectionProfile" | "selectionSpec" | "toolsMode" | "toolsWhitelist"> & {
    callingRoomId: string;
    selectionProfile?: TaskSelection["selectionProfile"] | null;
    selectionSpec?: TaskSelection["selectionSpec"] | null;
    toolsMode?: TaskSelection["toolsMode"];
    toolsWhitelist?: TaskSelection["toolsWhitelist"];
  },
): Promise<boolean> {
  if (!await isOwnPrivateGenieRoom(input.requestorId, input.callingRoomId, input.agentId)) return false;
  const modelId = await selectRunnableTaskModel({ ...input,
    selectionProfile: input.selectionProfile ?? undefined,
    selectionSpec: input.selectionSpec ?? undefined,
    // This legacy classifier rewrites an accepted create to `tools: []`.
    // Capability-funded auto/whitelist Tasks enter through prepareCreation.
    toolsMode: input.toolsMode ?? "none",
    toolsWhitelist: input.toolsWhitelist ?? [] });
  if (!modelId) return false;
  return (await personalOnlyTaskModelIds(input.requestorId, [modelId])).length === 1;
}

async function admit(task: TaskFundingTaskSource,
  priorRun?: TaskFundingRunSource): Promise<TaskFundingAdmission> {
  const authority = await assertOwnShape(task);
  const modelId = await selectTaskModel(task, priorRun);
  const decision = await resolveModelFunding({ humanUserId: task.requestorId, modelId,
    workload: "native_text_task", ...(priorRun ? { priorDecision: restoreDecision(task, priorRun) } : {}) });
  await authority?.();
  return { modelId, binding: bindingFor(decision) };
}

function sameBinding(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(parseTaskFundingBinding(left)) === JSON.stringify(parseTaskFundingBinding(right)); }
  catch { throw new TaskFundingError("funding_source_changed"); }
}

async function openSession(task: FundingTaskSource, run: FundingRunSource,
  modelId: string, wake: boolean, retainedDecision?: ModelFundingDecision,
): Promise<ForegroundChatFundingSession> {
  const authority = await assertOwnShape(task);
  const protectedSource = protectedRuntimeShape(task);
  if (typeof task.id !== "string" || typeof task.requestorId !== "string"
    || typeof run.id !== "string") throw new TaskFundingError("funding_source_changed");
  const taskId = task.id;
  const taskRunId = run.id;
  const freshCancelledWake = retainedDecision !== undefined;
  const admitted = retainedDecision ?? restoreDecision(task, run);
  const resolveCandidateUnchecked = async (candidateModelId: string, transport?: "direct" | "surplus") => {
    await authority?.();
    // Every retry/fallback rechecks exact Room authority and the original revision.
    const db = getServerDirectDb();
    const [currentTask, currentRun] = protectedSource
      ? await Promise.all([
          readProtectedFundingTask(taskId),
          readProtectedFundingRun(taskId, taskRunId),
        ])
      : await Promise.all([
          getTaskById(db, taskId), getTaskRunForTask(db, taskId, taskRunId),
        ]);
    if (!currentTask || !currentRun || currentTask.fundingMode !== "caller"
      || currentTask.ownerId !== task.ownerId || currentTask.requestorId !== task.requestorId
      || currentTask.agentId !== task.agentId || currentTask.callingRoomId !== task.callingRoomId
      || currentTask.requestedModelId !== task.requestedModelId
      || currentTask.toolsMode !== task.toolsMode
      || JSON.stringify(currentTask.toolsWhitelist) !== JSON.stringify(task.toolsWhitelist)
      || !sameProtectedRuntimeCoordinates(currentTask, task)
      || currentRun.modelId !== run.modelId || currentRun.jobId !== run.jobId
      || currentRun.graphThreadId !== run.graphThreadId
      || currentRun.fundingPredecessorRunId !== run.fundingPredecessorRunId
      || (freshCancelledWake
        ? currentRun.fundingBinding !== null || run.fundingBinding !== null
        : !sameBinding(currentRun.fundingBinding, run.fundingBinding))
      || (!wake && currentRun.status !== "running")
      || (wake && !["completed", "errored", "cancelled"].includes(currentRun.status))) {
      throw new TaskFundingError("funding_source_changed");
    }
    const predecessorRunId = currentRun.fundingPredecessorRunId;
    if (predecessorRunId) {
      const predecessor = protectedSource
        ? await readProtectedFundingRun(taskId, predecessorRunId)
        : await getTaskRunForTask(db, taskId, predecessorRunId);
      if (!predecessor || predecessor.id === currentRun.id
        || predecessor.status !== "paused" || predecessor.modelId !== currentRun.modelId
        || predecessor.graphThreadId !== currentRun.graphThreadId
        || !sameBinding(predecessor.fundingBinding, currentRun.fundingBinding)) {
        throw new TaskFundingError("funding_source_changed");
      }
    }
    await assertOwnShape(currentTask, authority);
    assertNativeTaskRetainedModelSelection(candidateModelId, currentTask);
    if (!wake && task.requestedModelId && task.requestedModelId !== candidateModelId) {
      throw new TaskFundingError("funding_source_changed");
    }
    const decision = await resolveModelFunding({ humanUserId: task.requestorId, modelId: candidateModelId,
      workload: "native_text_task", priorDecision: admitted, ...(transport ? { transport } : {}) });
    await authority?.();
    return decision;
  };
  const resolveCandidate = async (candidateModelId: string, transport?: "direct" | "surplus") => {
    try { return await fundingBoundary(() => resolveCandidateUnchecked(candidateModelId, transport)); }
    catch (error) {
      if (wake && run.status === "completed" && error instanceof TaskFundingError) {
        await recordTaskWakeFundingFailure(getServerDirectDb(), { taskId,
          taskRunId, requestorId: task.requestorId, reason: error.code });
      }
      throw error;
    }
  };
  await resolveCandidate(modelId);
  let lastAttempt: ModelFundingDecision | undefined;
  return {
    kind: admitted.kind,
    capabilityFunding: await prepareCapabilityFundingSession(
      task.requestorId,
      async () => { await resolveCandidate(modelId); },
      admitted.kind,
    ),
    async recheckAttempt(candidate, transport) {
      const current = await resolveCandidate(candidate, transport);
      if (transport && lastAttempt?.kind === "personal" && current.kind === "personal"
        && lastAttempt.modelId === candidate && lastAttempt.providerRoute === current.providerRoute
        && (lastAttempt.credentialId !== current.credentialId
          || lastAttempt.credentialRevision !== current.credentialRevision)) {
        throw new TaskFundingError("personal_credential_stale");
      }
    },
    async runAttempt(candidate, runAttempt, transport) {
      try {
        const decision = await resolveCandidate(candidate, transport);
        lastAttempt = decision;
        const usageFunding = usageFundingFor(decision);
        await authority?.();
        try {
          if (decision.kind === "server") return await runAttempt({ usageFunding });
          return await withAdmittedPersonalProviderKey(decision,
            (apiKey) => runAttempt({ usageFunding, personalCredential: { apiKey } }), undefined, admitted);
        } finally {
          await authority?.();
        }
      } catch (error) {
        const reason = taskFundingFailureCode(error);
        if (wake && run.status === "completed" && reason) {
          await recordTaskWakeFundingFailure(getServerDirectDb(), { taskId,
            taskRunId, requestorId: task.requestorId, reason });
        }
        throw error;
      }
    },
  };
}

/**
 * Open caller funding for one already-terminal protected Task Run without
 * materializing the Task prompt, expected output, or Run result columns.
 */
export async function openProtectedTaskWakeFundingSession(input: Readonly<{
  taskSource: ProtectedTaskWakeFundingTaskSource;
  runSource: ProtectedTaskWakeFundingRunSource;
  modelId: string | null;
  assertCurrent: ProtectedTaskFundingAuthority;
}>): Promise<ForegroundChatFundingSession | null> {
  const task: ProtectedTaskWakeFundingTaskSource = Object.freeze({
    ...input.taskSource,
    targetUserIds: Object.freeze([...input.taskSource.targetUserIds]),
    toolsWhitelist: Object.freeze([...input.taskSource.toolsWhitelist]),
    metadata: structuredClone(input.taskSource.metadata),
    cryptoRequiredNamespaceFingerprint:
      input.taskSource.cryptoRequiredNamespaceFingerprint === null
        ? null
        : Uint8Array.from(input.taskSource.cryptoRequiredNamespaceFingerprint),
  });
  const run: ProtectedTaskWakeFundingRunSource = Object.freeze({
    ...input.runSource,
    fundingBinding: structuredClone(input.runSource.fundingBinding),
  });
  if (task.fundingMode === "legacy_server") return null;
  const freshCancelledWake = run.status === "cancelled"
    && run.jobId === null && run.modelId === null && run.fundingBinding === null
    && run.fundingPredecessorRunId === null;
  if (task.fundingMode !== "caller" || !protectedRuntimeShape(task)
    || run.taskId !== task.id
    || !["completed", "errored", "cancelled"].includes(run.status)
    || (freshCancelledWake ? input.modelId !== null : run.modelId === null
      || run.modelId !== input.modelId)) {
    throw new TaskFundingError("funding_source_changed");
  }
  return withProtectedTaskFundingAuthority(input.assertCurrent, async () => {
    if (!freshCancelledWake) {
      return fundingBoundary(() => openSession(task, run, input.modelId!, true));
    }
    return fundingBoundary(async () => {
      await assertOwnShape(task);
      const modelId = await selectTaskModel(task);
      await input.assertCurrent();
      const retainedDecision = await resolveModelFunding({
        humanUserId: task.requestorId,
        modelId,
        workload: "native_text_task",
      });
      await input.assertCurrent();
      return openSession(
        task,
        run,
        modelId,
        true,
        retainedDecision,
      );
    });
  });
}

async function fundingBoundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ModelFundingError) throw new TaskFundingError(error.code as TaskFundingFailureCode);
    throw error;
  }
}

export const nativeTaskFundingPort: TaskFundingPort = {
  async prepareCreation(input, provenance) {
    const caps = await getUserCapabilities(input.requestorId);
    const policy = await getServerProviderPolicy(getServerDirectDb());
    let admittedDeepResearch: boolean;
    try {
      admittedDeepResearch = readDeepResearchTaskMetadata(input.metadata)?.version === 2;
    } catch {
      throw new TaskFundingError("unsupported_workload");
    }
    if (!shouldPrepareNativeTaskCallerFunding(input.metadata, {
      allowPersonalProviderKeys: policy.allowPersonalProviderKeys,
      capabilities: caps,
    })) return false;
    const originSupported = provenance.kind === "human_api"
      ? !provenance.requestedParentTaskId
      : provenance.kind === "agent_turn"
        && (provenance.entrypoint === "foreground.main" || provenance.entrypoint === "foreground.fork")
        && provenance.roomId === input.callingRoomId && !provenance.parentTaskId;
    if (!originSupported || input.targetRoomId || !supportedShape(input)
      || !input.callingRoomId || !await isOwnPrivateGenieRoom(input.requestorId, input.callingRoomId, input.agentId)) {
      if (!admittedDeepResearch && caps.includes("use_server_provider_credentials")) return false;
      throw new TaskFundingError("unsupported_workload");
    }
    await fundingBoundary(async () => {
      await assertOwnShape(input);
      const modelId = await selectTaskModel(input);
      await resolveModelFunding({ humanUserId: input.requestorId, modelId, workload: "native_text_task" });
    });
    return true;
  },
  admit: (task, priorRun) => fundingBoundary(() => admit(task, priorRun)),
  openSession: (task, run, modelId, wake) => fundingBoundary(() => openSession(task, run, modelId, wake)),
};
