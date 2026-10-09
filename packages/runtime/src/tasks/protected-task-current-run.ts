import type { Task, TaskRun } from "@nautilo/db";

import type {
  ProtectedTaskAuthorityOccurrence,
} from "./task-observer";

type CurrentTask = Pick<Task,
  | "id" | "ownerId" | "requestorId" | "agentId" | "callingRoomId"
  | "status" | "scheduleKind" | "contentRepresentation" | "contentNamespaceId"
  | "contentRevision" | "cryptoObjectId" | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint" | "cryptoMappingState"
>;

type CurrentRun = Pick<TaskRun,
  | "id" | "taskId" | "jobId" | "graphThreadId" | "status"
  | "resultRepresentation" | "resultContentNamespaceId" | "resultRevision"
  | "resultCryptoObjectId" | "resultCryptoAccessRevision"
  | "resultCryptoRequiredNamespaceFingerprint" | "resultCryptoMappingState"
>;

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Check the Task-owned operational identity before a device binds or a grant
 * opens. The caller must read these rows in its short canonical transaction;
 * this predicate never opens Task content or extends that transaction across
 * model execution.
 */
export function isCurrentProtectedTaskRunForGrant(input: Readonly<{
  occurrence: ProtectedTaskAuthorityOccurrence;
  task: CurrentTask;
  run: CurrentRun;
  requestorUserId: string;
  requestWorkId: string;
  sourceRoomId: string;
  requesterPrivateRoom: Readonly<{ roomId: string; namespaceId: string }> | null;
  phase: "awaiting" | "running";
}>): boolean {
  const { occurrence, task, run } = input;
  const sourceRoom = input.requesterPrivateRoom;
  return input.requestorUserId === task.requestorId
    && input.requestWorkId === run.id
    && sourceRoom !== null
    && input.sourceRoomId === sourceRoom.roomId
    && sourceRoom.namespaceId === task.contentNamespaceId
    && task.id === occurrence.task.id
    && task.ownerId === occurrence.task.ownerId
    && task.requestorId === occurrence.task.requestorId
    && task.agentId === occurrence.task.agentId
    && task.callingRoomId === occurrence.task.callingRoomId
    && task.scheduleKind === occurrence.task.scheduleKind
    && task.contentRepresentation === occurrence.task.contentRepresentation
    && task.contentNamespaceId === occurrence.task.contentNamespaceId
    && task.contentRevision === occurrence.task.contentRevision
    && task.cryptoObjectId === occurrence.task.cryptoObjectId
    && task.cryptoAccessRevision === occurrence.task.cryptoAccessRevision
    && sameBytes(task.cryptoRequiredNamespaceFingerprint,
      occurrence.task.cryptoRequiredNamespaceFingerprint)
    && task.cryptoMappingState === "verified"
    && (input.phase === "awaiting"
      ? task.status === "pending" || task.status === "awaiting" || task.status === "running"
      : occurrence.task.scheduleKind === "cron"
        ? task.status === "pending"
        : task.status === "running")
    && run.id === occurrence.run.id
    && run.taskId === task.id
    && run.graphThreadId === occurrence.run.graphThreadId
    && occurrence.run.status === input.phase
    && run.status === input.phase
    && run.jobId === occurrence.run.jobId
    && (input.phase === "awaiting"
      ? occurrence.run.jobId === null
      : typeof occurrence.run.jobId === "string"
        && occurrence.run.jobId.length > 0)
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}
