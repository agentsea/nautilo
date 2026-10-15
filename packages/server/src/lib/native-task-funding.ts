import { chatGPTFundingRegistration } from "./chatgpt-plan/runtime";
import { createCapabilityFundingSession, prepareCapabilityFundingSession } from "./capability-funding";
import {
  modelIdForCapabilityProjection, getProfileByAgentId, resolveTaskModel,
  validateExactTaskModelSelection, resolveRetainedModels, resolveCatalogModel,
  type ForegroundChatFundingSession, isSupportedPersonalTool, readDeepResearchTaskMetadata,
} from "@nautilo/agent";
import { and, eq, isNull, rooms, roomMembers, getServerProviderPolicy, getTaskById, getTaskRunForTask, getCachedServerModelConfigRow, recordTaskWakeFundingFailure, type Task, type TaskRun } from "@nautilo/db";
import { assertCanInvokeAgent, findActorByOwnerId, getUserCapabilities } from "@nautilo/trust";
import { TaskFundingError, taskFundingFailureCode, type TaskFundingPort, type TaskFundingAdmission } from "@nautilo/runtime";
import { parseTaskFundingBinding, type TaskFundingBinding, type TaskFundingFailureCode } from "@nautilo/types";
import { usageFundingFor } from "./foreground-chat-funding";
import { ModelFundingError, resolveModelFunding, withAdmittedPersonalCredential, type ModelFundingDecision } from "./model-funding";
import { getServerDirectDb } from "./server-direct-db";

import { callerTaskModelEnvironment, callerTaskModelIds, personalOnlyTaskModelIds } from "./caller-task-model-context";

type Candidate = Parameters<TaskFundingPort["prepareCreation"]>[0];

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

function supportedShape(task: Candidate): boolean {
  return (task.contentRepresentation ?? "ordinary") === "ordinary"
    && ["none", "auto", "whitelist"].includes(task.toolsMode ?? "auto")
    && (task.toolsWhitelist ?? []).every(isSupportedPersonalTool)
    && !["ping", "repo_docs"].includes(task.preset ?? "task")
    && Object.keys(task.metadata ?? {}).every((key) => NATIVE_TASK_METADATA_KEYS.has(key));
}

async function resolveCanonicalLineage(task: Candidate): Promise<Readonly<{
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

async function assertCanonicalShape(task: Candidate): Promise<void> {
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

function subscriptionPin(task: Candidate): Extract<TaskFundingBinding, { kind: "personal" }> | null {
  if (!Object.hasOwn(task.metadata ?? {}, "subscriptionFunding")) return null;
  try {
    const binding = parseTaskFundingBinding(task.metadata!["subscriptionFunding"]);
    if (binding.kind !== "personal" || binding.providerRoute !== "openai-chatgpt") throw new Error();
    return binding;
  } catch { throw new TaskFundingError("funding_source_changed"); }
}

function restoreDecision(task: Task, run: TaskRun): ModelFundingDecision {
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

type TaskSelection = Pick<Candidate,
  "agentId" | "requestorId" | "requestedModelId" | "selectionProfile" |
  "selectionSpec" | "toolsMode" | "toolsWhitelist">;

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
    toolsWhitelist: task.toolsWhitelist,
    env,
  });
}

async function selectTaskModel(task: TaskSelection, priorRun?: TaskRun): Promise<string> {
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

async function admit(task: Task, priorRun?: TaskRun): Promise<TaskFundingAdmission> {
  await assertCanonicalShape(task);
  const modelId = await selectTaskModel(task, priorRun);
  const pin = subscriptionPin(task);
  const priorDecision = priorRun ? restoreDecision(task, priorRun) : pin ? {
    ...pin, humanUserId: task.requestorId, payerHumanId: task.requestorId, modelId, workload: "native_text_task" as const,
  } : undefined;
  const decision = await resolveModelFunding({ humanUserId: task.requestorId, modelId,
    workload: "native_text_task", ...(priorDecision ? { priorDecision } : {}) });
  return { modelId, binding: bindingFor(decision) };
}

function sameBinding(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(parseTaskFundingBinding(left)) === JSON.stringify(parseTaskFundingBinding(right)); }
  catch { throw new TaskFundingError("funding_source_changed"); }
}

async function openSession(task: Task, run: TaskRun, modelId: string, wake: boolean): Promise<ForegroundChatFundingSession> {
  await assertCanonicalShape(task);
  const admitted = restoreDecision(task, run);
  const resolveCandidateUnchecked = async (candidateModelId: string, transport?: "direct" | "surplus") => {
    // Every retry/fallback rechecks exact Room authority and the original revision.
    const db = getServerDirectDb();
    const [currentTask, currentRun] = await Promise.all([
      getTaskById(db, task.id), getTaskRunForTask(db, task.id, run.id),
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
      || currentTask.contentRepresentation !== task.contentRepresentation
      || currentTask.contentNamespaceId !== task.contentNamespaceId
      || currentTask.contentRevision !== task.contentRevision
      || currentTask.cryptoObjectId !== task.cryptoObjectId
      || JSON.stringify(fundingRelevantTaskMetadata(currentTask.metadata))
        !== JSON.stringify(fundingRelevantTaskMetadata(task.metadata))
      || currentRun.modelId !== run.modelId || currentRun.graphThreadId !== run.graphThreadId
      || currentRun.fundingPredecessorRunId !== run.fundingPredecessorRunId
      || !sameBinding(currentRun.fundingBinding, run.fundingBinding)
      || (!wake && currentRun.status !== "running")
      || (wake && !["completed", "errored", "cancelled"].includes(currentRun.status))) {
      throw new TaskFundingError("funding_source_changed");
    }
    if (currentRun.fundingPredecessorRunId) {
      const predecessor = await getTaskRunForTask(db, task.id, currentRun.fundingPredecessorRunId);
      if (!predecessor || predecessor.id === currentRun.id
        || predecessor.status !== "paused" || predecessor.modelId !== currentRun.modelId
        || predecessor.graphThreadId !== currentRun.graphThreadId
        || !sameBinding(predecessor.fundingBinding, currentRun.fundingBinding)) {
        throw new TaskFundingError("funding_source_changed");
      }
    }
    await assertCanonicalShape(currentTask);
    assertNativeTaskRetainedModelSelection(candidateModelId, currentTask);
    if (!wake && task.requestedModelId && task.requestedModelId !== candidateModelId) {
      throw new TaskFundingError("funding_source_changed");
    }
    return resolveModelFunding({ humanUserId: task.requestorId, modelId: candidateModelId,
      workload: "native_text_task", priorDecision: admitted, ...(transport ? { transport } : {}) });
  };
  const resolveCandidate = async (candidateModelId: string, transport?: "direct" | "surplus") => {
    try { return await fundingBoundary(() => resolveCandidateUnchecked(candidateModelId, transport)); }
    catch (error) {
      if (wake && run.status === "completed" && error instanceof TaskFundingError) {
        await recordTaskWakeFundingFailure(getServerDirectDb(), { taskId: task.id,
          taskRunId: run.id, requestorId: task.requestorId, reason: error.code });
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
      bindingFor(admitted),
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
        if (decision.kind === "server") return await runAttempt({ usageFunding });
        return await withAdmittedPersonalCredential(decision,
          (personalCredential) => runAttempt({ usageFunding, personalCredential }), undefined, admitted);
      } catch (error) {
        const reason = taskFundingFailureCode(error);
        if (wake && run.status === "completed" && reason) {
          await recordTaskWakeFundingFailure(getServerDirectDb(), { taskId: task.id,
            taskRunId: run.id, requestorId: task.requestorId, reason });
        }
        throw error;
      }
    },
  };
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
