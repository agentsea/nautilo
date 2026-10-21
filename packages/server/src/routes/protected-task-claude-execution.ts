import { isDeepStrictEqual } from "node:util";
import { CLAUDE_MESSAGE_BOUNDARY_PROTOCOL_VERSION } from "@nautilo/relay";
import type { ClaudeConnectionController, ClaudeExecutionAdmission } from "../claude/connection-controller";
import type { ClaudeHarnessExecution } from "../claude/harness-execution";
import { sameProtectedTaskClaudeSelection, type ProtectedTaskClaudeSelection } from "./protected-task-claude-selection";
import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";
import { createProtectedTaskExternalExecution, type ProtectedTaskExternalExecutionFactory, type ProtectedTaskExternalExecutionDependencies } from "./protected-task-external-execution";

/** Provider-specific admission; shared Task owners retain all crypto and lifecycle custody. */
export function createProtectedTaskClaudeExecution(input: ProductionProtectedTaskNativeExecutionInput & Readonly<{
  controller: Pick<ClaudeConnectionController, "admitExecution">;
  execution: Pick<ClaudeHarnessExecution, "start" | "hasLiveRequest" | "respond">;
  requests: Pick<ReturnType<typeof createProtectedTaskExternalRequests>, "register">;
}>, overrides: Partial<ProtectedTaskExternalExecutionDependencies> = {}): ProtectedTaskExternalExecutionFactory<ProtectedTaskClaudeSelection> {
  return createProtectedTaskExternalExecution<ProtectedTaskClaudeSelection, ClaudeExecutionAdmission>({
    ...input,
    provider: {
      matchesCurrentSelection: (current, selection) => sameProtectedTaskClaudeSelection(current.claudeExecutionSelection, selection),
      admit: async (ownerId, selection) => {
        const admitted = await input.controller.admitExecution(ownerId, selection);
        return admitted !== null && admitted.scope.selectedProtocolVersion >= CLAUDE_MESSAGE_BOUNDARY_PROTOCOL_VERSION ? admitted : null;
      },
      sameAdmission: (left, right) => isDeepStrictEqual(left, right),
      start: ({ occurrence, jobId, signal, assertCurrent, admission, payload }) => {
        if (Object.keys(payload.protectedMetadata).length !== 0) {
          throw new TypeError("Protected Claude definition contains unsupported execution content");
        }
        return {
          attribution: { taskId: occurrence.task.id, roomId: occurrence.task.callingRoomId!,
            bindingId: occurrence.run.id, bindingGeneration: jobId },
          outputs: input.execution.start({
            jobId, taskId: occurrence.task.id, taskRunId: occurrence.run.id,
            ownerId: occurrence.task.ownerId, requesterId: occurrence.task.requestorId,
            roomId: occurrence.task.callingRoomId!, laneKey: `task:${occurrence.task.id}`,
            source: "room", parentTaskId: null, prompt: payload.prompt,
            abortSignal: signal, claude: admission,
          }),
          hasLiveRequest: (requestId, ownerId) => input.execution.hasLiveRequest(requestId, ownerId),
          respond: async (response, authority, options) => {
            await assertCurrent();
            await input.execution.respond(response, authority, options);
          },
        };
      },
    },
  }, overrides);
}
