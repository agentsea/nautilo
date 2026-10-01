import { createHash } from "node:crypto";

const TASK_RUN_RESULT_OBJECT_ID_DOMAIN =
  "nautilo/task-run-result-crypto-object/v1";

export function protectedTaskRunOutputBindingId(taskRunId: string): string {
  return `task-run-output:${taskRunId}`;
}

export function protectedTaskRunResultOperationId(taskRunId: string): string {
  return `task-run-result:${taskRunId}`;
}

export function protectedTaskRunMessageOperationId(taskRunId: string): string {
  return `task-run-delivery-message:${taskRunId}`;
}

export function protectedTaskRunWakeOperationId(taskRunId: string): string {
  return `task-run-delivery-wake:${taskRunId}`;
}

/** Mirrors the canonical lattice-bridge V1 derivation without a package cycle. */
export function protectedTaskRunResultObjectId(
  taskId: string,
  taskRunId: string,
): string {
  const digest = createHash("sha256").update(
    `${TASK_RUN_RESULT_OBJECT_ID_DOMAIN}\n${taskId}\n${taskRunId}\n1`,
    "utf8",
  ).digest("hex");
  return `task-run-result:v1:${digest}`;
}

/** Stable UUID-shaped product identity for the one wake Job of this run. */
export function protectedTaskRunWakeJobId(taskRunId: string): string {
  const bytes = createHash("sha256").update(
    `nautilo/protected-task-run-wake-job/v1\n${taskRunId}`,
    "utf8",
  ).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
