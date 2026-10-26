import { AsyncLocalStorage } from "node:async_hooks";
import { chatGPTFundingRegistration } from "./chatgpt-plan/runtime";
import { createCapabilityFundingSession, prepareCapabilityFundingSession } from "./capability-funding";
import {
  COMBO_SPECS,
  modelIdForCapabilityProjection, getProfileByAgentId, resolveTaskModel,
  validateExactTaskModelSelection, resolveRetainedModels, resolveCatalogModel,
  type ForegroundChatFundingAttempt, type ForegroundChatFundingSession,
  isSupportedPersonalTool, readDeepResearchTaskMetadata,
} from "@nautilo/agent";
import { and, eq, isNull, rooms, roomMembers, namespaces, sql, tasks, taskRuns, getServerProviderPolicy, getTaskById, getTaskRunForTask, getCachedServerModelConfigRow, recordTaskWakeFundingFailure, type TaskRun } from "@nautilo/db";
import { assertCanInvokeAgent, findActorByOwnerId, getUserCapabilities } from "@nautilo/trust";
import { TaskFundingError, taskFundingFailureCode, type TaskFundingPort, type TaskFundingAdmission,
  type TaskFundingRunSource, type TaskFundingTaskSource } from "@nautilo/runtime";
import { classifyProtectedTaskMetadataV1, parseTaskFundingBinding, type TaskFundingBinding, type TaskFundingFailureCode } from "@nautilo/types";
import { isOwnPrivateGenieRoom, usageFundingFor } from "./foreground-chat-funding";
import { ModelFundingError, resolveModelFunding, withAdmittedPersonalCredential,
  type ModelFundingDecision } from "./model-funding";
import { getServerDirectDb } from "./server-direct-db";
import {
  openServerFirstPersonalRecovery,
  openSurplusPersonalDirectRecovery,
} from "./surplus-personal-recovery";

import { callerTaskModelEnvironment, callerTaskModelIds, personalOnlyTaskModelIds } from "./caller-task-model-context";
import { protectedTaskRepoDocsSelectionProjection } from "../routes/protected-task-repo-docs-selection";

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
  metadataShapeSupported: sql<boolean>`case when jsonb_typeof(${tasks.metadata}) = 'object'
    then (${tasks.metadata} - 'preparation' - 'deepResearch') = '{}'::jsonb
      or (${protectedTaskRepoDocsSelectionProjection().sql}) is not null
    else false end`.mapWith(Boolean),
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

const legacyServerFundingTaskProjection = {
  id: tasks.id,
  ownerId: tasks.ownerId,
  requestorId: tasks.requestorId,
  agentId: tasks.agentId,
  fundingMode: tasks.fundingMode,
  requestedModelId: tasks.requestedModelId,
  selectionProfile: tasks.selectionProfile,
  selectionSpec: tasks.selectionSpec,
  toolsMode: tasks.toolsMode,
  toolsWhitelist: tasks.toolsWhitelist,
} as const;

type LegacyServerFundingTask = Readonly<Pick<ProtectedTaskWakeFundingTaskSource,
  "id" | "ownerId" | "requestorId" | "agentId" | "fundingMode" |
  "requestedModelId" | "selectionProfile" | "selectionSpec" | "toolsMode" |
  "toolsWhitelist"
>>;

async function readLegacyServerFundingTask(
  taskId: string,
): Promise<LegacyServerFundingTask | undefined> {
  const [task] = await getServerDirectDb().select(legacyServerFundingTaskProjection)
    .from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return task;
}

async function readProtectedFundingTask(
  taskId: string,
  acceptedMetadata: ProtectedTaskWakeFundingTaskSource["metadata"],
): Promise<ProtectedTaskWakeFundingTaskSource | undefined> {
  const [task] = await getServerDirectDb().select(protectedTaskProjection)
    .from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task?.metadataShapeSupported) return undefined;
  const { metadataShapeSupported: _metadataShapeSupported, ...current } = task;
  return { ...current, metadata: structuredClone(acceptedMetadata) };
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

export function nativeTaskAllowsUnpinnedSurplusRetry(
  task: Pick<Candidate, "contentRepresentation" | "selectionProfile" | "selectionSpec">,
): boolean {
  if ((task.contentRepresentation ?? "ordinary") !== "ordinary") return false;
  const profile = task.selectionProfile;
  const effective = task.selectionSpec ?? (profile && profile !== "balanced"
    ? COMBO_SPECS[profile]
    : undefined);
  return effective?.band !== "privacy"
    && effective?.objective !== "privacy"
    && effective?.absoluteFloors?.privacy === undefined;
}

const NATIVE_TASK_METADATA_KEYS = new Set([
  "preparation", "lastInterruption", "deepResearch", "bringBack",
  "writerReviewAwaiting", "writerReviewAcceptedReceipt", "subscriptionFunding",
]);

// These fields are durable runtime progress, not admitted prompt, routing, or
// provider-selection input. They may advance while an approved Task is parked
// or while its exact run is executing. Every other accepted metadata field is
// part of the funding source fence below.
const MUTABLE_TASK_RUNTIME_METADATA_KEYS = new Set([
  "preparation", "lastInterruption",
  "writerReviewAwaiting", "writerReviewAcceptedReceipt",
]);

function fundingRelevantTaskMetadata(metadata: Candidate["metadata"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {})
    .filter(([key]) => !MUTABLE_TASK_RUNTIME_METADATA_KEYS.has(key)));
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
  return (task.contentRepresentation ?? "ordinary") === "ordinary"
    && ["none", "auto", "whitelist"].includes(task.toolsMode ?? "auto")
    && (task.toolsWhitelist ?? []).every(isSupportedPersonalTool)
    && !["ping", "repo_docs"].includes(task.preset ?? "task")
    && Object.keys(task.metadata ?? {}).every((key) => NATIVE_TASK_METADATA_KEYS.has(key));
}

function protectedRuntimeShape(task: FundingTaskSource): boolean {
  const repoDocs = task.preset === "repo_docs" && protectedRepoDocsFundingShape(task);
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
    && (repoDocs || task.preset === "task"
      || task.preset === "in_background"
      || task.preset === "schedule")
    && (task.targetChat === "orphan"
      || task.targetChat === "last_in_namespace")
    && (task.targetUserIds ?? []).every(id => id === task.requestorId)
    && !task.awaitResponse
    && (repoDocs || Object.keys(task.metadata ?? {}).every(
      key => key === "preparation" || key === "deepResearch",
    ));
}

function protectedRepoDocsFundingShape(task: FundingTaskSource): boolean {
  if (task.toolsMode !== "whitelist" || task.toolsWhitelist?.length !== 1
    || task.toolsWhitelist[0] !== "file" || task.useScope || task.scopeId != null) return false;
  const metadata = task.metadata ?? {};
  if (Reflect.ownKeys(metadata).some(key => typeof key !== "string"
    || !["target", "instructions", "mode", "publish", "preparation", "lastInterruption"].includes(key))) return false;
  const classified = classifyProtectedTaskMetadataV1(metadata);
  return classified.status === "supported"
    && typeof classified.protectedContent["target"] === "string"
    && typeof classified.operational["mode"] === "string"
    && ["init", "update", "auto"].includes(classified.operational["mode"])
    && typeof classified.operational["publish"] === "string"
    && ["branch", "push", "pr"].includes(classified.operational["publish"]);
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
  const authority = retainedProtectedAuthority ?? protectedTaskFundingAuthority.getStore();
  if (!protectedRuntimeShape(task)
    || authority === undefined
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
  await authority();
  return authority;
}

async function resolveCanonicalLineage(task: FundingTaskSource): Promise<Readonly<{
  sourceRoomId: string;
  taskIds: readonly string[];
}>> {
  let current = task;
  const seen = new Set<string>();
  const taskIds = [task.id ?? "candidate"];
  while (current.parentTaskId) {
    if (seen.has(current.parentTaskId)) throw new TaskFundingError("unsupported_workload");
    seen.add(current.parentTaskId);
    const parent = await getTaskById(getServerDirectDb(), current.parentTaskId);
    if (!parent || parent.requestorId !== task.requestorId
      || (current.depth ?? 0) !== parent.depth + 1
      || !current.callingRoomId
      || (current.callingRoomId !== parent.callingRoomId && current.callingRoomId !== parent.targetRoomId)
      || ["cancelled", "errored"].includes(parent.status)) {
      throw new TaskFundingError("unsupported_workload");
    }
    taskIds.push(parent.id);
    current = parent;
  }
  if ((current.depth ?? 0) !== 0 || !current.callingRoomId) {
    throw new TaskFundingError("unsupported_workload");
  }
  return { sourceRoomId: current.callingRoomId, taskIds };
}

async function isLiveSourceRoomMember(roomId: string, actorId: string): Promise<boolean> {
  const [room] = await getServerDirectDb()
    .select({ id: rooms.id })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(and(
      eq(rooms.id, roomId),
      isNull(rooms.archivedAt),
      eq(roomMembers.actorId, actorId),
    ))
    .limit(1);
  return room?.id === roomId;
}

async function assertCanonicalShape(task: FundingTaskSource): Promise<void> {
  if (!supportedShape(task) || !task.callingRoomId) {
    throw new TaskFundingError("unsupported_workload");
  }
  const lineage = await resolveCanonicalLineage(task);
  const { sourceRoomId } = lineage;
  const requestor = await findActorByOwnerId(task.requestorId);
  if (!requestor) throw new TaskFundingError("unsupported_workload");
  const requestorActorId = requestor.id;
  // The calling Room is the causal Human's source. The target Genie can be a
  // foreign Genie and need not already be a member of that Room; exact-target
  // invocation admission below owns that social boundary.
  if (!await isLiveSourceRoomMember(sourceRoomId, requestorActorId)
    || (task.preset === "schedule" && task.targetRoomId !== null
      && task.targetRoomId !== undefined && task.targetRoomId !== task.callingRoomId)) {
    throw new TaskFundingError("unsupported_workload");
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
    agentId: task.agentId, roomId: sourceRoomId });
  const [currentLineage, currentCallingRoomLive] = await Promise.all([
    resolveCanonicalLineage(task),
    isLiveSourceRoomMember(sourceRoomId, requestorActorId),
  ]);
  if (currentLineage.sourceRoomId !== lineage.sourceRoomId
    || JSON.stringify(currentLineage.taskIds) !== JSON.stringify(lineage.taskIds)
    || !currentCallingRoomLive) {
    throw new TaskFundingError("unsupported_workload");
  }
}

function bindingFor(decision: ModelFundingDecision): TaskFundingBinding {
  return decision.kind === "personal"
    ? { kind: "personal", providerRoute: decision.providerRoute,
      credentialId: decision.credentialId, credentialRevision: decision.credentialRevision }
    : { kind: "server", providerRoute: decision.providerRoute };
}

function assertProtectedFundingDecision(decision: ModelFundingDecision): void {
  if (decision.kind === "personal" && decision.providerRoute === "openai-chatgpt") {
    throw new TaskFundingError("unsupported_workload");
  }
}

function subscriptionPin(task: Pick<FundingTaskSource, "metadata">): Extract<TaskFundingBinding, { kind: "personal" }> | null {
  if (!Object.hasOwn(task.metadata ?? {}, "subscriptionFunding")) return null;
  try {
    const binding = parseTaskFundingBinding(task.metadata!["subscriptionFunding"]);
    if (binding.kind !== "personal" || binding.providerRoute !== "openai-chatgpt") throw new Error();
    return binding;
  } catch { throw new TaskFundingError("funding_source_changed"); }
}

function restoreDecision(task: Pick<FundingTaskSource, "id" | "requestorId" | "metadata">,
  run: Pick<FundingRunSource, "taskId" | "modelId" | "fundingBinding">,
): ModelFundingDecision {
  if (run.taskId !== task.id || !run.modelId) throw new TaskFundingError("funding_source_changed");
  let binding: TaskFundingBinding;
  try { binding = parseTaskFundingBinding(run.fundingBinding); }
  catch { throw new TaskFundingError("funding_source_changed"); }
  const pin = subscriptionPin(task);
  if (pin && JSON.stringify(pin) !== JSON.stringify(binding)) throw new TaskFundingError("funding_source_changed");
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
  const authority = (task.contentRepresentation ?? "ordinary") === "ordinary"
    ? (await assertCanonicalShape(task), undefined)
    : await assertOwnShape(task);
  const modelId = await selectTaskModel(task, priorRun);
  const pin = subscriptionPin(task);
  const priorDecision = priorRun ? restoreDecision(task, priorRun) : pin ? {
    ...pin, humanUserId: task.requestorId, payerHumanId: task.requestorId, modelId, workload: "native_text_task" as const,
  } : undefined;
  const decision = await resolveModelFunding({ humanUserId: task.requestorId, modelId,
    workload: "native_text_task", ...(priorDecision ? { priorDecision } : {}) });
  if (authority) assertProtectedFundingDecision(decision);
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
  const protectedSource = (task.contentRepresentation ?? "ordinary") !== "ordinary";
  const authority = protectedSource
    ? await assertOwnShape(task)
    : (await assertCanonicalShape(task), undefined);
  const acceptedProtectedMetadata = protectedSource
    ? structuredClone(task.metadata)
    : undefined;
  if (typeof task.id !== "string" || typeof task.requestorId !== "string"
    || typeof run.id !== "string") throw new TaskFundingError("funding_source_changed");
  const taskId = task.id;
  const taskRunId = run.id;
  const freshCancelledWake = retainedDecision !== undefined;
  const admitted = retainedDecision ?? restoreDecision(task, run);
  if (protectedSource) assertProtectedFundingDecision(admitted);
  const resolveCandidateUnchecked = async (candidateModelId: string, transport?: "direct" | "surplus") => {
    await authority?.();
    // Every retry/fallback rechecks exact Room authority and the original revision.
    const db = getServerDirectDb();
    const [currentTask, currentRun] = protectedSource
      ? await Promise.all([
          readProtectedFundingTask(taskId, acceptedProtectedMetadata!),
          readProtectedFundingRun(taskId, taskRunId),
        ])
      : await Promise.all([
          getTaskById(db, taskId), getTaskRunForTask(db, taskId, taskRunId),
        ]);
    if (!currentTask || !currentRun || currentTask.fundingMode !== "caller"
      || currentTask.ownerId !== task.ownerId || currentTask.requestorId !== task.requestorId
      || currentTask.agentId !== task.agentId || currentTask.callingRoomId !== task.callingRoomId
      || currentTask.parentTaskId !== task.parentTaskId || currentTask.depth !== task.depth
      || currentTask.preset !== task.preset || currentTask.targetChat !== task.targetChat
      || currentTask.targetChatHandle !== task.targetChatHandle
      || currentTask.targetRoomId !== task.targetRoomId
      || JSON.stringify(currentTask.targetUserIds) !== JSON.stringify(task.targetUserIds)
      || currentTask.resultDelivery !== task.resultDelivery
      || currentTask.useScope !== task.useScope || currentTask.scopeId !== task.scopeId
      || currentTask.awaitResponse !== task.awaitResponse
      || currentTask.requestedModelId !== task.requestedModelId
      || currentTask.selectionProfile !== task.selectionProfile
      || JSON.stringify(currentTask.selectionSpec) !== JSON.stringify(task.selectionSpec)
      || currentTask.toolsMode !== task.toolsMode
      || JSON.stringify(currentTask.toolsWhitelist) !== JSON.stringify(task.toolsWhitelist)
      || (protectedSource
        ? !sameProtectedRuntimeCoordinates(currentTask, task)
          || currentRun.jobId !== run.jobId
        : currentTask.contentRepresentation !== task.contentRepresentation
          || currentTask.contentNamespaceId !== task.contentNamespaceId
          || currentTask.contentRevision !== task.contentRevision
          || currentTask.cryptoObjectId !== task.cryptoObjectId
          || JSON.stringify(fundingRelevantTaskMetadata(currentTask.metadata))
            !== JSON.stringify(fundingRelevantTaskMetadata(task.metadata)))
      || currentRun.modelId !== run.modelId || currentRun.graphThreadId !== run.graphThreadId
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
    if (protectedSource) await assertOwnShape(currentTask, authority);
    else await assertCanonicalShape(currentTask);
    assertNativeTaskRetainedModelSelection(candidateModelId, currentTask);
    if (!wake && task.requestedModelId && task.requestedModelId !== candidateModelId) {
      throw new TaskFundingError("funding_source_changed");
    }
    const decision = await resolveModelFunding({ humanUserId: task.requestorId, modelId: candidateModelId,
      workload: "native_text_task", priorDecision: admitted, ...(transport ? { transport } : {}) });
    if (protectedSource) assertProtectedFundingDecision(decision);
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
  const initialDecision = await resolveCandidate(modelId);
  const allowUnpinnedSurplusRetry = nativeTaskAllowsUnpinnedSurplusRetry(task);
  const fundingPolicy = admitted.kind === "server"
    ? await getServerProviderPolicy(getServerDirectDb())
    : null;
  let lastAttempt: ModelFundingDecision | undefined;
  return {
    kind: admitted.kind,
    ...(admitted.kind === "server" ? {
      admittedTransport: initialDecision.providerRoute === "surplus" ? "surplus" as const : "direct" as const,
    } : {}),
    ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
    capabilityFunding: await prepareCapabilityFundingSession(
      task.requestorId,
      async () => { await resolveCandidate(modelId); },
      admitted.kind,
      bindingFor(admitted),
      allowUnpinnedSurplusRetry ? true : undefined,
    ),
    ...(admitted.kind === "server" && admitted.providerRoute === "surplus" ? {
      openPersonalDirectRecovery: async (candidate: string) => {
        const recovery = await fundingBoundary(() => openSurplusPersonalDirectRecovery({
          humanUserId: task.requestorId,
          modelId: candidate,
          workload: "native_text_task",
          primaryDecision: admitted,
          ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
          recheckPrimary: () => resolveCandidate(candidate),
        }));
        return {
          ...recovery,
          recheckAttempt: (recoveryModelId: string, transport?: "direct" | "surplus") =>
            fundingBoundary(() => recovery.recheckAttempt(recoveryModelId, transport)),
          async runAttempt<T>(recoveryModelId: string,
            callback: (attempt: ForegroundChatFundingAttempt) => Promise<T>,
            transport?: "direct" | "surplus") {
            return fundingBoundary(() => recovery.runAttempt(recoveryModelId, callback, transport));
          },
        };
      },
    } : {}),
    ...(admitted.kind === "server" && fundingPolicy?.fundingPreference === "server_first" ? {
      openPersonalRecovery: async (candidate: string) => {
        const recovery = await fundingBoundary(() => openServerFirstPersonalRecovery({
          humanUserId: task.requestorId,
          modelId: candidate,
          workload: "native_text_task",
          primaryDecision: admitted,
          ...(allowUnpinnedSurplusRetry ? { allowUnpinnedSurplusRetry: true as const } : {}),
          recheckPrimary: () => resolveCandidate(candidate),
        }));
        return {
          ...recovery,
          recheckAttempt: (recoveryModelId: string, transport?: "direct" | "surplus") =>
            fundingBoundary(() => recovery.recheckAttempt(recoveryModelId, transport)),
          async runAttempt<T>(recoveryModelId: string,
            callback: (attempt: ForegroundChatFundingAttempt) => Promise<T>,
            transport?: "direct" | "surplus") {
            return fundingBoundary(() => recovery.runAttempt(recoveryModelId, callback, transport));
          },
        };
      },
    } : {}),
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
          return await withAdmittedPersonalCredential(decision,
            (personalCredential) => runAttempt({ usageFunding, personalCredential }), undefined, admitted);
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
 * Open funding for one already-terminal protected Task Run without
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
  if (task.fundingMode === "legacy_server") {
    const terminal = ["completed", "errored", "cancelled"].includes(run.status);
    const freshCancelledWake = run.status === "cancelled"
      && run.jobId === null && run.modelId === null && run.fundingBinding === null
      && run.fundingPredecessorRunId === null;
    if (run.taskId !== task.id || !terminal || run.fundingBinding !== null
      || (freshCancelledWake ? input.modelId !== null : run.modelId === null
        || run.modelId !== input.modelId)) {
      throw new TaskFundingError("funding_source_changed");
    }
    return fundingBoundary(async () => {
      await input.assertCurrent();
      const modelId = run.modelId ?? await selectTaskModel(task);
      assertNativeTaskRetainedModelSelection(modelId, task);
      const admitted = await resolveModelFunding({
        humanUserId: task.requestorId,
        modelId,
        workload: "native_text_task",
        fundingKind: "server",
      });
      if (admitted.kind !== "server") throw new TaskFundingError("funding_source_changed");
      await input.assertCurrent();
      const resolveCandidateUnchecked = async (
        candidateModelId: string,
        transport?: "direct" | "surplus",
      ): Promise<ModelFundingDecision> => {
        await input.assertCurrent();
        const [currentTask, currentRun] = await Promise.all([
          readLegacyServerFundingTask(task.id),
          readProtectedFundingRun(task.id, run.id),
        ]);
        if (!currentTask || !currentRun
          || currentTask.id !== task.id
          || currentTask.ownerId !== task.ownerId
          || currentTask.requestorId !== task.requestorId
          || currentTask.agentId !== task.agentId
          || currentTask.fundingMode !== "legacy_server"
          || currentTask.requestedModelId !== task.requestedModelId
          || currentTask.selectionProfile !== task.selectionProfile
          || JSON.stringify(currentTask.selectionSpec) !== JSON.stringify(task.selectionSpec)
          || currentTask.toolsMode !== task.toolsMode
          || JSON.stringify(currentTask.toolsWhitelist) !== JSON.stringify(task.toolsWhitelist)
          || currentRun.id !== run.id
          || currentRun.taskId !== run.taskId
          || currentRun.jobId !== run.jobId
          || currentRun.graphThreadId !== run.graphThreadId
          || currentRun.status !== run.status
          || currentRun.modelId !== run.modelId
          || currentRun.fundingBinding !== null
          || currentRun.fundingPredecessorRunId !== run.fundingPredecessorRunId) {
          throw new TaskFundingError("funding_source_changed");
        }
        assertNativeTaskRetainedModelSelection(candidateModelId, currentTask);
        const decision = await resolveModelFunding({
          humanUserId: task.requestorId,
          modelId: candidateModelId,
          workload: "native_text_task",
          fundingKind: "server",
          priorDecision: admitted,
          ...(transport ? { transport } : {}),
        });
        if (decision.kind !== "server") throw new TaskFundingError("funding_source_changed");
        await input.assertCurrent();
        return decision;
      };
      const resolveCandidate = async (
        candidateModelId: string,
        transport?: "direct" | "surplus",
      ) => fundingBoundary(
        () => resolveCandidateUnchecked(candidateModelId, transport),
      );
      const initialDecision = await resolveCandidate(modelId);
      return {
        kind: "server",
        admittedTransport: initialDecision.providerRoute === "surplus"
          ? "surplus" as const
          : "direct" as const,
        async recheckAttempt(candidate, transport) {
          await resolveCandidate(candidate, transport);
        },
        async runAttempt(candidate, runAttempt, transport) {
          const decision = await resolveCandidate(candidate, transport);
          try { return await runAttempt({ usageFunding: usageFundingFor(decision) }); }
          finally { await input.assertCurrent(); }
        },
      };
    });
  }
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
      assertProtectedFundingDecision(retainedDecision);
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
    if (Object.hasOwn(input.metadata ?? {}, "subscriptionFunding")) throw new TaskFundingError("funding_source_changed");
    let inheritedSubscription: ModelFundingDecision | undefined;
    if (provenance.kind === "agent_turn" && provenance.parentTaskId && provenance.parentTaskRunId) {
      const db = getServerDirectDb();
      const parent = await getTaskById(db, provenance.parentTaskId);
      const run = await getTaskRunForTask(db, provenance.parentTaskId, provenance.parentTaskRunId);
      if (!parent || parent.requestorId !== input.requestorId || !run || !["running", "awaiting", "completed"].includes(run.status)) {
        throw new TaskFundingError("unsupported_workload");
      }
      if (run.fundingBinding !== null && run.fundingBinding !== undefined) {
        const decision = restoreDecision(parent, run);
        if (decision.kind === "personal" && decision.providerRoute === "openai-chatgpt") inheritedSubscription = decision;
      }
    }
    const wouldUseSelectedSubscription = async () => {
      const selected = await chatGPTFundingRegistration(input.requestorId);
      return selected !== null && (await selectTaskModel(input)).startsWith("openai:");
    };
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
    }) && !inheritedSubscription) {
      // An unavailable explicitly selected plan is still a funding choice.
      // Never reinterpret policy disable/revocation as permission to charge
      // the legacy server lane when a queued Task is created.
      if (await wouldUseSelectedSubscription()) throw new TaskFundingError(
        policy.allowPersonalProviderKeys ? "personal_credentials_forbidden" : "personal_credentials_disabled",
      );
      return false;
    }
    const inputParentTaskId = input.parentTaskId ?? null;
    const originSupported = provenance.kind === "human_api"
      ? provenance.requestedParentTaskId === inputParentTaskId
      : provenance.kind === "agent_turn"
        && provenance.roomId === input.callingRoomId
        && provenance.parentTaskId === inputParentTaskId
        && (provenance.parentTaskId === null || provenance.parentTaskRunId !== null);
    if (!originSupported || !supportedShape(input) || !input.callingRoomId) {
      if (!inheritedSubscription && !admittedDeepResearch && caps.includes("use_server_provider_credentials")
        && !await wouldUseSelectedSubscription()) return false;
      throw new TaskFundingError("unsupported_workload");
    }
    const decision = await fundingBoundary(async () => {
      if (provenance.kind === "agent_turn" && provenance.parentTaskId && provenance.parentTaskRunId) {
        const parentRun = await getTaskRunForTask(getServerDirectDb(), provenance.parentTaskId, provenance.parentTaskRunId);
        if (!parentRun || !["running", "awaiting", "completed"].includes(parentRun.status)) {
          throw new TaskFundingError("unsupported_workload");
        }
      }
      await assertCanonicalShape(input);
      const modelId = await selectTaskModel(input);
      return resolveModelFunding({ humanUserId: input.requestorId, modelId, workload: "native_text_task",
        ...(inheritedSubscription ? { priorDecision: inheritedSubscription } : {}) });
    });
    return decision.kind === "personal" && decision.providerRoute === "openai-chatgpt"
      ? { modelId: decision.modelId, binding: bindingFor(decision) } : true;
  },
  admit: (task, priorRun) => fundingBoundary(() => admit(task, priorRun)),
  openSession: (task, run, modelId, wake) => fundingBoundary(() => openSession(task, run, modelId, wake)),
};
