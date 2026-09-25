import type { Task, TaskRun } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import type { ProtectedTaskJobSchedulingFacts } from
  "./protected-task-execution-candidate";
import type { ProtectedTaskOccurrence } from "./task-observer";
import type {
  TaskEnvelopeMode,
  TaskEnvelopeResolution,
} from "./resolve-task-memory-envelope";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TASK_DEFINITION_OBJECT_ID = /^task-definition:v1:[0-9a-f]{64}$/u;

/**
 * Plaintext-safe Task columns required to bind one protected occurrence.
 * Prompt, expected output, last error, and metadata are deliberately absent.
 */
export type ProtectedTaskPredispatchTaskFacts = Readonly<Pick<Task,
  | "id"
  | "ownerId"
  | "requestorId"
  | "agentId"
  | "callingRoomId"
  | "status"
  | "preset"
  | "targetChat"
  | "targetChatHandle"
  | "targetRoomId"
  | "targetUserIds"
  | "useScope"
  | "scopeId"
  | "contentRepresentation"
  | "contentNamespaceId"
  | "contentRevision"
  | "cryptoObjectId"
  | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint"
  | "cryptoMappingState"
>>;

/** Closed, pre-execution TaskRun state accepted before authorization claim. */
export type ProtectedTaskPredispatchRunFacts = Readonly<Pick<TaskRun,
  | "id"
  | "taskId"
  | "jobId"
  | "graphThreadId"
  | "status"
  | "modelId"
  | "resultText"
  | "startedAt"
  | "completedAt"
  | "lastError"
  | "resultRepresentation"
  | "resultContentNamespaceId"
  | "resultRevision"
  | "resultCryptoObjectId"
  | "resultCryptoAccessRevision"
  | "resultCryptoRequiredNamespaceFingerprint"
  | "resultCryptoMappingState"
>>;

export type ProtectedTaskPredispatchTarget = Readonly<{
  roomId: string;
  /** Fresh target-user facts, including a peer resolved from a handle. */
  targetUserIds: readonly string[];
}>;

export interface ProtectedTaskPredispatchPorts {
  /** Revalidates current RBAC and provider-funding authority without mutation. */
  assertCurrentAuthority(input: Readonly<{
    taskId: string;
    requestorId: string;
    agentId: string;
    memoizedRoomId: string | null;
  }>): Promise<void>;

  /**
   * Resolves or memoizes the canonical target once. The returned target must
   * be reused after claim; protected dispatch must not run Room selection a
   * second time.
   */
  resolveTargetRoom(
    task: ProtectedTaskPredispatchTaskFacts,
  ): Promise<ProtectedTaskPredispatchTarget>;

  /** Resolves current Task Memory authority without opening Task content. */
  resolveMemoryEnvelope(input: Readonly<{
    task: ProtectedTaskPredispatchTaskFacts;
    laneKey: string;
    sessionRoomId: string;
    targetUserIds: readonly string[];
  }>): Promise<TaskEnvelopeResolution>;
}

export type ProtectedTaskPredispatchPlan = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  scheduling: ProtectedTaskJobSchedulingFacts;
  target: ProtectedTaskPredispatchTarget;
  memory: TaskEnvelopeResolution;
}>;

type ExactProtectedTaskFacts = ProtectedTaskPredispatchTaskFacts & Readonly<{
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  cryptoObjectId: string;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
}>;

type ExactProtectedTaskRunFacts = ProtectedTaskPredispatchRunFacts & Readonly<{
  jobId: null;
  status: "awaiting";
}>;

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function uniqueUuids(values: unknown): values is readonly string[] {
  if (!Array.isArray(values)) return false;
  const entries = values as unknown[];
  return entries.every(uuid) && new Set(entries).size === entries.length;
}

function expectedEnvelopeMode(
  task: ProtectedTaskPredispatchTaskFacts,
): TaskEnvelopeMode {
  if (task.useScope) return "scope";
  if (task.preset === "in_private_namespace") return "wide";
  return "namespace";
}

function assertOccurrence(
  task: ProtectedTaskPredispatchTaskFacts,
  run: ProtectedTaskPredispatchRunFacts,
): Readonly<{
  task: ExactProtectedTaskFacts;
  run: ExactProtectedTaskRunFacts;
}> {
  // Protected creation may only carry a Scope already proven by its read-only
  // execution-shape resolver. Ordinary dispatch's missing-Scope path derives
  // a new Scope purpose from `task.prompt`, which is unavailable here.
  if (task.useScope && !uuid(task.scopeId)) {
    throw new TypeError("Protected Task predispatch identity is invalid");
  }
  const fingerprint = task.cryptoRequiredNamespaceFingerprint;
  if (
    !uuid(task.id)
    || !uuid(task.ownerId)
    || !uuid(task.requestorId)
    || !uuid(task.agentId)
    || task.callingRoomId !== null && !uuid(task.callingRoomId)
    || !["pending", "awaiting", "running"].includes(task.status)
    || !uniqueUuids(task.targetUserIds)
    || task.targetRoomId !== null && !uuid(task.targetRoomId)
    || task.contentRepresentation !== "protected"
      && task.contentRepresentation !== "dual"
    || !uuid(task.contentNamespaceId)
    || !Number.isSafeInteger(task.contentRevision)
    || task.contentRevision < 1
    || typeof task.cryptoObjectId !== "string"
    || !TASK_DEFINITION_OBJECT_ID.test(task.cryptoObjectId)
    || !Number.isSafeInteger(task.cryptoAccessRevision)
    || task.cryptoAccessRevision < 0
    || !(fingerprint instanceof Uint8Array)
    || fingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || !uuid(run.id)
    || run.taskId !== task.id
    || run.jobId !== null
    || run.status !== "awaiting"
    || typeof run.graphThreadId !== "string"
    || run.graphThreadId.length === 0
    || run.modelId !== null
    || run.resultText !== null
    || !(run.startedAt instanceof Date)
    || !Number.isFinite(run.startedAt.getTime())
    || run.completedAt !== null
    || run.lastError !== null
    || run.resultRepresentation !== "ordinary"
    || run.resultContentNamespaceId !== null
    || run.resultRevision !== 0
    || run.resultCryptoObjectId !== null
    || run.resultCryptoAccessRevision !== 0
    || run.resultCryptoRequiredNamespaceFingerprint !== null
    || run.resultCryptoMappingState !== "unmapped"
  ) {
    throw new TypeError("Protected Task predispatch identity is invalid");
  }
  return {
    task: task as ExactProtectedTaskFacts,
    run: run as ExactProtectedTaskRunFacts,
  };
}

function assertTarget(
  task: ProtectedTaskPredispatchTaskFacts,
  target: ProtectedTaskPredispatchTarget,
): readonly string[] {
  if (
    !uuid(target.roomId)
    || task.targetRoomId !== null && target.roomId !== task.targetRoomId
    || !uniqueUuids(target.targetUserIds)
    || task.targetUserIds.some((id) => !target.targetUserIds.includes(id))
  ) {
    throw new TypeError("Protected Task target resolution is invalid");
  }
  return Object.freeze(Array.from(new Set([
    task.requestorId,
    ...target.targetUserIds,
  ])));
}

function copyEnvelope(envelope: MemoryAccessEnvelope): MemoryAccessEnvelope {
  if (envelope.memoryMode === "scope") {
    return Object.freeze({
      ...envelope,
      toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
    });
  }
  return Object.freeze({
    ...envelope,
    readableNamespaces: Object.freeze([...envelope.readableNamespaces]),
    mutableNamespaces: Object.freeze([...envelope.mutableNamespaces]),
    writableNamespaces: Object.freeze([...envelope.writableNamespaces]),
    toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
  }) as MemoryAccessEnvelope;
}

function exactMemory(
  task: ProtectedTaskPredispatchTaskFacts,
  resolved: TaskEnvelopeResolution,
): TaskEnvelopeResolution {
  const expectedMode = expectedEnvelopeMode(task);
  const envelope = resolved.envelope;
  if (
    resolved.authorityStatus !== "exact"
    || resolved.mode !== expectedMode
    || envelope.ownerId !== task.requestorId
    || envelope.agentId !== task.agentId
    || (
      expectedMode === "scope"
        ? envelope.memoryMode !== "scope" || envelope.scopeId !== task.scopeId
        : envelope.memoryMode === "scope"
          || envelope.readableNamespaces.length === 0
          || envelope.writableNamespaces.length === 0
          || !uniqueUuids(envelope.readableNamespaces)
          || !uniqueUuids(envelope.mutableNamespaces)
          || !uniqueUuids(envelope.writableNamespaces)
    )
  ) {
    throw new TypeError("Protected Task Memory authority is not exact");
  }
  return Object.freeze({
    ...resolved,
    envelope: copyEnvelope(envelope),
  });
}

/**
 * Resolves one protected occurrence's operational context before a grant is
 * requested or claimed. This function never receives Task plaintext and does
 * not persist, create a Job, or change Task/TaskRun lifecycle state.
 */
export async function planProtectedTaskPredispatch(input: Readonly<{
  task: ProtectedTaskPredispatchTaskFacts;
  run: ProtectedTaskPredispatchRunFacts;
  ports: ProtectedTaskPredispatchPorts;
}>): Promise<ProtectedTaskPredispatchPlan> {
  const { ports } = input;
  const { task, run } = assertOccurrence(input.task, input.run);
  await ports.assertCurrentAuthority({
    taskId: task.id,
    requestorId: task.requestorId,
    agentId: task.agentId,
    memoizedRoomId: task.targetRoomId,
  });

  const resolvedTarget = await ports.resolveTargetRoom(task);
  const targetUserIds = assertTarget(task, resolvedTarget);
  const target = Object.freeze({
    roomId: resolvedTarget.roomId,
    targetUserIds,
  });
  const laneKey = `task:${task.id}`;
  const memory = exactMemory(task, await ports.resolveMemoryEnvelope({
    task,
    laneKey,
    sessionRoomId: task.targetChat === "orphan" ? "" : target.roomId,
    targetUserIds,
  }));
  const occurrence: ProtectedTaskOccurrence = Object.freeze({
    task: Object.freeze({
      id: task.id,
      ownerId: task.ownerId,
      requestorId: task.requestorId,
      agentId: task.agentId,
      callingRoomId: task.callingRoomId,
      contentRepresentation: task.contentRepresentation,
      contentNamespaceId: task.contentNamespaceId,
      contentRevision: task.contentRevision,
      cryptoObjectId: task.cryptoObjectId,
      cryptoAccessRevision: task.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        new Uint8Array(task.cryptoRequiredNamespaceFingerprint),
    }),
    run: Object.freeze({
      id: run.id,
      taskId: run.taskId,
      jobId: run.jobId,
      graphThreadId: run.graphThreadId,
      status: run.status,
      startedAt: new Date(run.startedAt),
    }),
  });

  return Object.freeze({
    occurrence,
    scheduling: Object.freeze({
      ownerId: task.ownerId,
      requestorId: task.requestorId,
      agentId: task.agentId,
      roomId: target.roomId,
      callingRoomId: task.callingRoomId,
      graphThreadId: run.graphThreadId,
    }),
    target,
    memory,
  });
}
