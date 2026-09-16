import {
  eq,
  tasks,
  type DirectDatabase,
} from "@nautilo/db";
import {
  TaskHarnessExecutionRouteFailure,
  isTaskHarnessExecutionDescriptor,
  type PersistedTaskHarnessRoute,
  type TaskHarnessExecutionDescriptor,
  type TaskHarnessExecutionRouteReader,
} from "./task-execution-route";

/**
 * The persisted Task reader for the generic routing seam. It deliberately
 * projects provider-private execution metadata into the three fixed fields
 * understood by the router; the raw metadata never leaves this module.
 */
class TaskHarnessExecutionRouteStore implements TaskHarnessExecutionRouteReader {
  constructor(private readonly db: DirectDatabase) {}

  async getTask(taskId: string): Promise<PersistedTaskHarnessRoute | null> {
    const [row] = await this.db
      .select({
        id: tasks.id,
        ownerId: tasks.ownerId,
        requestorId: tasks.requestorId,
        agentId: tasks.agentId,
        parentTaskId: tasks.parentTaskId,
        targetRoomId: tasks.targetRoomId,
        metadata: tasks.metadata,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      requestorId: row.requestorId,
      agentId: row.agentId,
      parentTaskId: row.parentTaskId,
      targetRoomId: row.targetRoomId,
      execution: projectTaskHarnessExecutionDescriptor(row.metadata),
    };
  }
}

export function createTaskHarnessExecutionRouteStore(
  db: DirectDatabase,
): TaskHarnessExecutionRouteStore {
  return new TaskHarnessExecutionRouteStore(db);
}

/**
 * Metadata without an execution entry is an ordinary Native Task. Once an
 * execution entry exists, its public base must be exact: malformed values are
 * a bounded routing failure, never a fallback to Native. Additional fields are
 * intentionally neither read nor returned because they remain provider-owned.
 */
export function projectTaskHarnessExecutionDescriptor(
  metadata: Readonly<Record<string, unknown>>,
): TaskHarnessExecutionDescriptor | null {
  if (!Object.hasOwn(metadata, "execution")) return null;
  const rawExecution = metadata["execution"];
  if (!rawExecution || typeof rawExecution !== "object" || Array.isArray(rawExecution)) {
    throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_DESCRIPTOR_INVALID");
  }
  const execution = rawExecution as Readonly<Record<string, unknown>>;
  const descriptor = {
    version: execution["version"],
    harnessId: execution["harnessId"],
    source: execution["source"],
  };
  if (!isTaskHarnessExecutionDescriptor(descriptor)) {
    throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_DESCRIPTOR_INVALID");
  }
  return Object.freeze(descriptor);
}
