import type { HarnessControlPlane } from "@nautilo/runtime";
import {
  isCodexHarnessExecutionMetadata,
  type CodexTaskExecutionRouteReader,
} from "./harness-admission";
import { CODEX_HARNESS_ID } from "./harness-driver";
import type { HarnessTurnReference } from "@nautilo/runtime";

export type CodexHarnessTaskControlFailureCode =
  | "CODEX_TASK_FORBIDDEN"
  | "CODEX_TURN_UNAVAILABLE"
  | "CODEX_STEER_UNAVAILABLE";

export class CodexHarnessTaskControlFailure extends Error {
  constructor(readonly code: CodexHarnessTaskControlFailureCode) {
    super(code);
    this.name = "CodexHarnessTaskControlFailure";
  }
}

export interface SteerCodexHarnessTaskInput {
  readonly taskId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly text: string;
}

/**
 * Exact Task control seam used by the ordinary `task` Tool. The model provides
 * only a Task id and concise instruction; server code re-derives authority,
 * resolves the exact active upstream turn, and constructs protocol input.
 */
export async function steerCodexHarnessTask(
  deps: {
    readonly tasks: CodexTaskExecutionRouteReader;
    readonly controlPlane: HarnessControlPlane;
    readonly execution: {
      activeTurnForTask(input: {
        readonly taskId: string;
        readonly ownerId: string;
        readonly roomId: string;
      }): HarnessTurnReference | null;
    };
  },
  input: SteerCodexHarnessTaskInput,
): Promise<{ readonly ok: true; readonly status: "steered" }> {
  const task = await deps.tasks.getTask(input.taskId);
  if (
    !task
    || task.ownerId !== input.ownerId
    || task.agentId !== input.agentId
    || task.callingRoomId !== input.roomId
    || task.targetRoomId !== input.roomId
    || !isCodexHarnessExecutionMetadata(task.metadata)
  ) {
    throw new CodexHarnessTaskControlFailure("CODEX_TASK_FORBIDDEN");
  }

  const turn = deps.execution.activeTurnForTask({
    taskId: input.taskId,
    ownerId: input.ownerId,
    roomId: input.roomId,
  });
  if (!turn) {
    throw new CodexHarnessTaskControlFailure("CODEX_TURN_UNAVAILABLE");
  }

  try {
    const driver = await deps.controlPlane.requireOperation(CODEX_HARNESS_ID, "steer");
    await driver.execution.steer!({ ...turn, text: input.text });
  } catch (cause) {
    if (cause instanceof CodexHarnessTaskControlFailure) throw cause;
    throw new CodexHarnessTaskControlFailure("CODEX_STEER_UNAVAILABLE");
  }
  return { ok: true, status: "steered" };
}
