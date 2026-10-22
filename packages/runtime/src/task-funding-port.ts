import { personalProviderInvocationFailureCategory, type ForegroundChatFundingSession } from "@nautilo/agent";
import { getTaskById, getTaskRunForTask, type Task, type TaskRun } from "@nautilo/db";
import {
  assertAcceptedInvocationAuthoritySubject,
  getAcceptedInvocationAuthorityOrigin,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { TASK_FUNDING_FAILURE_CODES, type TaskFundingBinding, type TaskFundingFailureCode } from "@nautilo/types";
import type { TaskCreateInput } from "./tasks/create-task";
import type { TaskCreationProvenance } from "./tasks/task-creation-admission";
import { getTaskRunDb } from "./tasks/task-runtime-context";
import { getCurrentProtectedTaskWakeForegroundContext } from
  "./conversation/live-shadow-turn-context";

export class TaskFundingError extends Error {
  constructor(readonly code: TaskFundingFailureCode) {
    super(code);
    this.name = "TaskFundingError";
  }
}

/** Recognize only safe funding reasons, including provider recheck wrappers. */
export function taskFundingFailureCode(error: unknown): TaskFundingFailureCode | null {
  const providerFailure = personalProviderInvocationFailureCategory(error);
  if (providerFailure !== null) return providerFailure === "TIMEOUT" || providerFailure === "NETWORK_ERROR"
    ? "funding_interrupted_uncertain" : "personal_provider_unavailable";
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === "string"
    && (TASK_FUNDING_FAILURE_CODES as readonly string[]).includes(value.code)) {
    return value.code as TaskFundingFailureCode;
  }
  return value.cause && value.cause !== error ? taskFundingFailureCode(value.cause) : null;
}

export interface TaskFundingAdmission {
  readonly modelId: string;
  readonly binding: TaskFundingBinding;
}

/**
 * The operational Task definition needed to select and retain caller funding.
 * Protected callers can provide this closed projection without materializing
 * the Task prompt, expected output, or error columns.
 */
export type TaskFundingTaskSource = Readonly<Omit<Pick<Task,
  | "id" | "ownerId" | "requestorId" | "agentId" | "preset"
  | "callingRoomId" | "targetChat" | "targetChatHandle" | "targetRoomId"
  | "targetUserIds" | "resultDelivery" | "useScope" | "scopeId" | "toolsMode"
  | "toolsWhitelist" | "awaitResponse" | "selectionProfile"
  | "selectionSpec" | "requestedModelId" | "parentTaskId" | "depth"
  | "fundingMode" | "metadata" | "contentRepresentation"
  | "contentNamespaceId" | "contentRevision" | "cryptoObjectId"
  | "cryptoAccessRevision" | "cryptoRequiredNamespaceFingerprint"
  | "cryptoMappingState"
>, "targetUserIds" | "toolsWhitelist" | "cryptoRequiredNamespaceFingerprint">> & Readonly<{
  targetUserIds: readonly string[];
  toolsWhitelist: readonly string[];
  cryptoRequiredNamespaceFingerprint: Uint8Array | null;
}>;

/** The operational Run coordinates needed by caller funding. */
export type TaskFundingRunSource = Readonly<Pick<TaskRun,
  | "id" | "taskId" | "jobId" | "graphThreadId" | "status" | "modelId"
  | "fundingBinding" | "fundingPredecessorRunId"
>>;

/** Server composition owns live funding policy and custody; Runtime owns Task identity. */
export interface TaskFundingPort {
  prepareCreation(input: TaskCreateInput, provenance: TaskCreationProvenance): Promise<boolean | TaskFundingAdmission>;
  admit(task: TaskFundingTaskSource, priorRun?: TaskFundingRunSource): Promise<TaskFundingAdmission>;
  openSession(task: TaskFundingTaskSource, run: TaskFundingRunSource,
    modelId: string, wake: boolean): Promise<ForegroundChatFundingSession>;
}

let installedPort: TaskFundingPort | undefined;

export function installTaskFundingPort(port: TaskFundingPort): void {
  if (installedPort && installedPort !== port) throw new Error("task_funding_port_already_installed");
  installedPort = port;
}

export function uninstallTaskFundingPort(): void {
  installedPort = undefined;
}

export async function prepareTaskCreationFunding(
  input: TaskCreateInput,
  provenance: TaskCreationProvenance,
): Promise<boolean | TaskFundingAdmission> {
  return installedPort ? installedPort.prepareCreation(input, provenance) : false;
}

export async function assertTaskFundingAdmission(
  task: TaskFundingTaskSource,
  priorRun?: TaskFundingRunSource,
): Promise<TaskFundingAdmission | null> {
  if ((task.fundingMode ?? "legacy_server") === "legacy_server") return null;
  if (task.fundingMode !== "caller" || !installedPort) throw new TaskFundingError("funding_source_changed");
  return installedPort.admit(task, priorRun);
}

/** A serialized Job/TaskRun is consistency data, never an invocation authority. */
export async function openTaskFundingSession(input: Readonly<{
  task: TaskFundingTaskSource;
  run: TaskFundingRunSource;
  authority: AcceptedInvocationAuthority | undefined;
  requestorId: string;
  modelId: string;
  jobId?: string;
  graphThreadId?: string;
  wake?: boolean;
}>): Promise<ForegroundChatFundingSession | null> {
  if (!input.authority || input.requestorId !== input.task.requestorId
    || input.run.taskId !== input.task.id
    || (input.jobId !== undefined && input.run.jobId !== input.jobId)
    || (input.graphThreadId !== undefined && input.run.graphThreadId !== input.graphThreadId)
    || (!input.wake && input.modelId !== input.run.modelId)) {
    throw new TaskFundingError("funding_source_changed");
  }
  assertAcceptedInvocationAuthoritySubject(input.authority, input.task.requestorId);
  if ((input.task.fundingMode ?? "legacy_server") === "legacy_server") return null;
  if (input.task.fundingMode !== "caller" || !installedPort
    || getAcceptedInvocationAuthorityOrigin(input.authority).originTaskId !== input.task.id) {
    throw new TaskFundingError("funding_source_changed");
  }
  return installedPort.openSession(input.task, input.run, input.modelId, input.wake === true);
}

/** Task report-back bypasses the ordinary foreground port deliberately. */
export async function openTaskWakeFundingSessionForInvocation(input: Readonly<{
  authority: AcceptedInvocationAuthority | undefined;
  jobInput: Readonly<Record<string, unknown>>;
  causalHumanUserId: string | null;
  modelId: string;
  roomId: string;
  agentId: string;
}>): Promise<ForegroundChatFundingSession | null> {
  const wake = getCurrentProtectedTaskWakeForegroundContext();
  if (wake !== undefined) {
    const scheduling = wake.scheduling;
    if (input.authority === undefined) {
      throw new TaskFundingError("funding_source_changed");
    }
    assertAcceptedInvocationAuthoritySubject(input.authority, scheduling.requestorId);
    if (input.causalHumanUserId !== null
      || input.roomId !== scheduling.roomId || input.agentId !== scheduling.agentId
      || input.jobInput["ownerId"] !== scheduling.ownerId
      || input.jobInput["requestorId"] !== scheduling.requestorId
      || input.jobInput["graphThreadId"] !== scheduling.graphThreadId
      || input.jobInput["threadId"] !== scheduling.graphThreadId
      || input.jobInput["turnId"] !== wake.evidence.invocation.operationId
      || getAcceptedInvocationAuthorityOrigin(input.authority).originTaskId
        !== scheduling.taskId
      || wake.fundingSession?.admission !== undefined
        && wake.fundingSession.admission.modelId !== input.modelId) {
      throw new TaskFundingError("funding_source_changed");
    }
    return wake.fundingSession;
  }
  const metadata = input.jobInput["metadata"] as Record<string, unknown> | undefined;
  if (metadata?.["originatedBy"] !== "task") return null;
  const taskId = metadata["taskId"];
  const runId = metadata["taskRunId"];
  if (typeof taskId !== "string") throw new TaskFundingError("funding_source_changed");
  const task = await getTaskById(getTaskRunDb(), taskId);
  if (!task) throw new TaskFundingError("funding_source_changed");
  if ((task.fundingMode ?? "legacy_server") === "legacy_server") return null;
  if (typeof runId !== "string" || task.callingRoomId !== input.roomId
    || task.agentId !== input.agentId || task.requestorId !== input.causalHumanUserId
    || task.ownerId !== input.jobInput["ownerId"] || task.requestorId !== input.jobInput["requestorId"]) {
    throw new TaskFundingError("funding_source_changed");
  }
  const run = await getTaskRunForTask(getTaskRunDb(), task.id, runId);
  if (!run || !["completed", "errored", "cancelled"].includes(run.status)) {
    throw new TaskFundingError("funding_source_changed");
  }
  return openTaskFundingSession({ task, run, authority: input.authority,
    requestorId: task.requestorId, modelId: input.modelId, wake: true });
}
