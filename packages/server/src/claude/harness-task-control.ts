import type { CodexTaskExecutionRouteReader } from "../codex/harness-admission";
import type { ClaudeHarnessExecution } from "./harness-execution";
import { parseClaudeTaskExecutionMetadata } from "./task-execution-route";

export type ClaudeHarnessTaskControlFailureCode =
  | "CLAUDE_TASK_FORBIDDEN"
  | "CLAUDE_TURN_UNAVAILABLE"
  | "CLAUDE_STEER_UNAVAILABLE";

export class ClaudeHarnessTaskControlFailure extends Error {
  constructor(readonly code: ClaudeHarnessTaskControlFailureCode) {
    super(code);
    this.name = "ClaudeHarnessTaskControlFailure";
  }
}

export interface SteerClaudeHarnessTaskInput {
  readonly taskId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly text: string;
}

/**
 * Re-reads the server-owned Task and admits only its exact current Claude
 * execution. The caller never chooses a profile, model, relay, or session.
 */
export async function steerClaudeHarnessTask(
  deps: {
    readonly tasks: CodexTaskExecutionRouteReader;
    readonly execution: Pick<ClaudeHarnessExecution, "steerActiveTask">;
  },
  input: SteerClaudeHarnessTaskInput,
): Promise<{ readonly ok: true; readonly status: "steered" }> {
  const task = await deps.tasks.getTask(input.taskId);
  const metadata = task ? parseClaudeTaskExecutionMetadata(task.metadata) : null;
  if (
    !task
    || task.ownerId !== input.ownerId
    || task.requestorId !== input.ownerId
    || task.agentId !== input.agentId
    || task.parentTaskId !== null
    || task.callingRoomId !== input.roomId
    || task.targetRoomId !== input.roomId
    || metadata === null
  ) throw new ClaudeHarnessTaskControlFailure("CLAUDE_TASK_FORBIDDEN");

  try {
    const steered = await deps.execution.steerActiveTask({
      taskId: task.id,
      ownerId: task.ownerId,
      roomId: input.roomId,
      profileRef: metadata.execution.profileRef,
      catalogModelId: metadata.execution.catalogModelId,
      selectedModel: metadata.execution.selectedModel,
      text: input.text,
    });
    if (!steered) throw new ClaudeHarnessTaskControlFailure("CLAUDE_TURN_UNAVAILABLE");
  } catch (error) {
    if (error instanceof ClaudeHarnessTaskControlFailure) throw error;
    throw new ClaudeHarnessTaskControlFailure("CLAUDE_STEER_UNAVAILABLE");
  }
  return { ok: true, status: "steered" };
}
