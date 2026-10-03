import {
  modelIdForCapabilityProjection, getProfileByAgentId, resolveTaskModel,
  validateExactTaskModelSelection, resolveRetainedModels, resolveCatalogModel,
  type ForegroundChatFundingSession,
} from "@nautilo/agent";
import { and, eq, rooms, namespaces, getServerProviderPolicy, getTaskById, getTaskRunForTask, getCachedServerModelConfigRow, recordTaskWakeFundingFailure, type Task, type TaskRun } from "@nautilo/db";
import { assertCanInvokeAgent, getUserCapabilities } from "@nautilo/trust";
import { TaskFundingError, taskFundingFailureCode, type TaskFundingPort, type TaskFundingAdmission } from "@nautilo/runtime";
import { parseTaskFundingBinding, type TaskFundingBinding, type TaskFundingFailureCode } from "@nautilo/types";
import { isOwnPrivateGenieRoom, usageFundingFor } from "./foreground-chat-funding";
import { ModelFundingError, resolveModelFunding, withAdmittedPersonalProviderKey, type ModelFundingDecision } from "./model-funding";
import { getServerDirectDb } from "./server-direct-db";

import { callerTaskModelEnvironment, callerTaskModelIds, personalOnlyTaskModelIds } from "./caller-task-model-context";

type Candidate = Parameters<TaskFundingPort["prepareCreation"]>[0];

function supportedShape(task: Candidate): boolean {
  return task.ownerId === task.requestorId && !task.parentTaskId && (task.depth ?? 0) === 0
    && (task.contentRepresentation ?? "ordinary") === "ordinary"
    && task.toolsMode === "none" && !(task.toolsWhitelist?.length)
    && !task.useScope && !task.scopeId && !task.targetChatHandle
    && (task.preset === "task" || task.preset === "in_background" || task.preset === "schedule")
    && (task.targetChat === "orphan" || task.targetChat === "last_in_namespace")
    && (task.targetUserIds ?? []).every((id) => id === task.requestorId)
    && !task.awaitResponse && Object.keys(task.metadata ?? {}).every((key) => key === "preparation");
}

async function assertOwnShape(task: Candidate): Promise<void> {
  if (!supportedShape(task) || !task.callingRoomId
    || !await isOwnPrivateGenieRoom(task.requestorId, task.callingRoomId, task.agentId)) {
    throw new TaskFundingError("unsupported_workload");
  }
  if (task.targetChat === "orphan" && task.targetRoomId) {
    const [room] = await getServerDirectDb().select({
      ownerId: rooms.ownerId, type: rooms.type, kind: rooms.kind,
      humanActorIds: rooms.humanActorIds, scope: namespaces.scope, label: namespaces.label,
    }).from(rooms).innerJoin(namespaces, eq(rooms.namespaceId, namespaces.id))
      .where(and(eq(rooms.id, task.targetRoomId), eq(rooms.ownerId, task.requestorId))).limit(1);
    if (!room || room.type !== "private" || room.kind !== "task"
      || room.humanActorIds.length !== 0 || room.scope !== "private"
      || room.label !== `task:${task.id}`) throw new TaskFundingError("unsupported_workload");
  }
  await assertCanInvokeAgent({ humanUserId: task.requestorId, origin: "task_dispatch",
    agentId: task.agentId, roomId: task.callingRoomId });
}

function bindingFor(decision: ModelFundingDecision): TaskFundingBinding {
  return decision.kind === "personal"
    ? { kind: "personal", providerRoute: decision.providerRoute,
      credentialId: decision.credentialId, credentialRevision: decision.credentialRevision }
    : { kind: "server", providerRoute: decision.providerRoute };
}

function restoreDecision(task: Task, run: TaskRun): ModelFundingDecision {
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

function assertSignedTextModel(modelId: string): void {
  const env = { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] };
  const row = resolveRetainedModels([modelId], { purpose: "chat", env })[0];
  const catalog = resolveCatalogModel(modelId, { env });
  if (!row || (row.availability !== "selectable" && row.availability !== "missing-key")) {
    throw new TaskFundingError("unsupported_provider");
  }
  if (catalog.workload !== "chat" || !catalog.output.includes("text")) throw new TaskFundingError("unsupported_workload");
}

type TaskSelection = Pick<Candidate, "agentId" | "requestorId" | "requestedModelId" | "selectionProfile" | "selectionSpec">;

async function selectTaskModel(task: TaskSelection, priorRun?: TaskRun): Promise<string> {
  if (priorRun) {
    if (!priorRun.modelId || (task.requestedModelId && task.requestedModelId !== priorRun.modelId)) {
      throw new TaskFundingError("funding_source_changed");
    }
    assertSignedTextModel(priorRun.modelId);
    return priorRun.modelId;
  }
  if (task.requestedModelId) {
    const failure = validateExactTaskModelSelection({ requestedModelId: task.requestedModelId,
      profile: task.selectionProfile, spec: task.selectionSpec, toolsMode: "none",
      env: { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] } });
    if (failure && failure.code !== "missing_credentials") throw new Error(`[task-model-selection] ${failure.message}`);
    assertSignedTextModel(task.requestedModelId);
    return task.requestedModelId;
  }
  const profile = await getProfileByAgentId(task.agentId);
  const baseModelId = modelIdForCapabilityProjection("chat", profile?.defaultModel?.trim()
    || process.env["NAUTILO_MODEL"]?.trim() || getCachedServerModelConfigRow()?.defaultChatModel?.trim());
  if (!task.selectionSpec && (!task.selectionProfile || task.selectionProfile === "balanced")) {
    assertSignedTextModel(baseModelId);
    return baseModelId;
  }
  const env = await callerTaskModelEnvironment(task.requestorId);
  return resolveTaskModel({ baseModelId,
    profile: task.selectionProfile ?? null, spec: task.selectionSpec ?? null, env, purpose: "chat" }).modelId;
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
  input: Omit<TaskSelection, "selectionProfile" | "selectionSpec"> & {
    callingRoomId: string;
    selectionProfile?: TaskSelection["selectionProfile"] | null;
    selectionSpec?: TaskSelection["selectionSpec"] | null;
  },
): Promise<boolean> {
  if (!await isOwnPrivateGenieRoom(input.requestorId, input.callingRoomId, input.agentId)) return false;
  const modelId = await selectRunnableTaskModel({ ...input,
    selectionProfile: input.selectionProfile ?? undefined,
    selectionSpec: input.selectionSpec ?? undefined });
  if (!modelId) return false;
  return (await personalOnlyTaskModelIds(input.requestorId, [modelId])).length === 1;
}

async function admit(task: Task, priorRun?: TaskRun): Promise<TaskFundingAdmission> {
  await assertOwnShape(task);
  const modelId = await selectTaskModel(task, priorRun);
  const decision = await resolveModelFunding({ humanUserId: task.requestorId, modelId,
    workload: "native_text_task", ...(priorRun ? { priorDecision: restoreDecision(task, priorRun) } : {}) });
  return { modelId, binding: bindingFor(decision) };
}

function sameBinding(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(parseTaskFundingBinding(left)) === JSON.stringify(parseTaskFundingBinding(right)); }
  catch { throw new TaskFundingError("funding_source_changed"); }
}

async function openSession(task: Task, run: TaskRun, modelId: string, wake: boolean): Promise<ForegroundChatFundingSession> {
  await assertOwnShape(task);
  const admitted = restoreDecision(task, run);
  const resolveCandidateUnchecked = async (candidateModelId: string) => {
    // Every retry/fallback rechecks exact Room authority and the original revision.
    const db = getServerDirectDb();
    const [currentTask, currentRun] = await Promise.all([
      getTaskById(db, task.id), getTaskRunForTask(db, task.id, run.id),
    ]);
    if (!currentTask || !currentRun || currentTask.fundingMode !== "caller"
      || currentTask.ownerId !== task.ownerId || currentTask.requestorId !== task.requestorId
      || currentTask.agentId !== task.agentId || currentTask.callingRoomId !== task.callingRoomId
      || currentTask.requestedModelId !== task.requestedModelId
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
    await assertOwnShape(currentTask);
    assertSignedTextModel(candidateModelId);
    if (!wake && task.requestedModelId && task.requestedModelId !== candidateModelId) {
      throw new TaskFundingError("funding_source_changed");
    }
    return resolveModelFunding({ humanUserId: task.requestorId, modelId: candidateModelId,
      workload: "native_text_task", priorDecision: admitted });
  };
  const resolveCandidate = async (candidateModelId: string) => {
    try { return await fundingBoundary(() => resolveCandidateUnchecked(candidateModelId)); }
    catch (error) {
      if (wake && run.status === "completed" && error instanceof TaskFundingError) {
        await recordTaskWakeFundingFailure(getServerDirectDb(), { taskId: task.id,
          taskRunId: run.id, requestorId: task.requestorId, reason: error.code });
      }
      throw error;
    }
  };
  await resolveCandidate(modelId);
  return {
    kind: admitted.kind,
    async recheckAttempt(candidate) { await resolveCandidate(candidate); },
    async runAttempt(candidate, runAttempt) {
      try {
        const decision = await resolveCandidate(candidate);
        const usageFunding = usageFundingFor(decision);
        if (decision.kind === "server") return await runAttempt({ usageFunding });
        return await withAdmittedPersonalProviderKey(decision,
          (apiKey) => runAttempt({ usageFunding, personalCredential: { apiKey } }), undefined, admitted);
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
    const caps = await getUserCapabilities(input.requestorId);
    const policy = await getServerProviderPolicy(getServerDirectDb());
    if (!policy.allowPersonalProviderKeys || !caps.includes("use_personal_provider_credentials")) return false;
    const originSupported = provenance.kind === "human_api"
      ? !provenance.requestedParentTaskId
      : provenance.kind === "agent_turn"
        && (provenance.entrypoint === "foreground.main" || provenance.entrypoint === "foreground.fork")
        && provenance.roomId === input.callingRoomId && !provenance.parentTaskId;
    if (!originSupported || input.targetRoomId || !supportedShape(input)
      || !input.callingRoomId || !await isOwnPrivateGenieRoom(input.requestorId, input.callingRoomId, input.agentId)) {
      if (caps.includes("use_server_provider_credentials")) return false;
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
