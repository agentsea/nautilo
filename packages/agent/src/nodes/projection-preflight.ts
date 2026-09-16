import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import type { NautiloState } from "../agent/state";
import {
  isProjectionLikeShareCall,
  preflightProjectionShareCalls,
  preflightProtectedProjectionShareCalls,
} from "../tools/memory/projection-sharing";
import type { ProtectedAgentMemoryProjectionPort } from "../tools/memory/protected-memory-ports";
import {
  __assertProtectedMemoryToolsNodeTestAuthorityForTesting,
  type ProtectedMemoryToolsNodeTestAuthority,
} from "./tools";

const MAX_PROJECTION_ROOM_CHOICES = 50;

function boundedActiveRoomChoices(
  choices: NonNullable<NautiloState["projectionRoomChoices"]>,
): NonNullable<NautiloState["projectionRoomChoices"]> {
  const now = Date.now();
  return choices
    .filter((choice) => choice.expiresAt > now)
    .slice(-MAX_PROJECTION_ROOM_CHOICES);
}

/**
 * D476's deterministic boundary. This runs after the model authors a proposal
 * but before the generic post-model approval classifier sees it.
 */
export function createProjectionPreflightNode(
  preflight: typeof preflightProjectionShareCalls = preflightProjectionShareCalls,
  options: Readonly<{ sanitizeProjectionToolArgs?: boolean }> = {},
) {
  return async function projectionPreflightNode(
    state: NautiloState,
  ): Promise<Partial<NautiloState>> {
  const last = state.modelRejectedToolCallIds?.length
    ? [...state.messages].reverse().find((message) => AIMessage.isInstance(message))
    : state.messages[state.messages.length - 1];
  if (!last || !AIMessage.isInstance(last) || !last.tool_calls?.length) {
    return {
      projectionSnapshots: [],
      projectionRejectedToolCallIds: [],
      projectionRoomChoices: boundedActiveRoomChoices(state.projectionRoomChoices ?? []),
    };
  }
  const rejectedModelIds = new Set(state.modelRejectedToolCallIds ?? []);
  const result = await preflight(state, last.tool_calls.filter((call) => !rejectedModelIds.has(call.id ?? "")));
  const roomChoices = boundedActiveRoomChoices([
    ...(state.projectionRoomChoices ?? []),
    ...result.choiceMappings,
  ]);
  // Every rejected tool call must receive a paired ToolMessage, including a
  // mixed batch where a sibling projection remains valid for approval.
  const checkpointMessages = options.sanitizeProjectionToolArgs === true
    ? state.messages.map((message) => {
      if (message !== last || !AIMessage.isInstance(message)) return message;
      const hasProjection = message.tool_calls?.some((call) =>
        isProjectionLikeShareCall(call)) === true;
      if (!hasProjection) return message;
      const additionalKwargs = Object.fromEntries(
        Object.entries(message.additional_kwargs).filter(([key]) =>
          key !== "tool_calls" && key !== "function_call"),
      );
      const sanitized = new AIMessage({
        content: "",
        additional_kwargs: additionalKwargs,
        response_metadata: message.response_metadata,
        tool_calls: message.tool_calls?.map((call) =>
          isProjectionLikeShareCall(call)
            ? { ...call, args: { mode: "project" } }
            : call),
      } as ConstructorParameters<typeof AIMessage>[0]);
      if (message.id) sanitized.id = message.id;
      return sanitized;
    })
    : state.messages;
  const messages = result.messages.length > 0
    ? mergeMessagesPreservingInvariants(
        checkpointMessages,
        result.messages.map((message) => new ToolMessage({
          content: result.rejectedToolCallIds.includes(message.toolCallId)
            ? JSON.stringify({ error: message.content })
            : message.content,
          tool_call_id: message.toolCallId,
          name: "share_memory",
          ...(result.rejectedToolCallIds.includes(message.toolCallId)
            ? { status: "error" as const, additional_kwargs: { nautilo_tool_status: "error" } }
            : {}),
        })),
      )
    : checkpointMessages;
  return {
    messages,
    projectionSnapshots: [...result.snapshots],
    projectionRoomChoices: roomChoices,
    projectionRejectedToolCallIds: [...result.rejectedToolCallIds],
  };
  };
}


/** Dormant protected preflight; never selected by the production graph. */
export function createProtectedMemoryTestProjectionPreflightNode(input: Readonly<{
  authority: ProtectedMemoryToolsNodeTestAuthority;
  projection: ProtectedAgentMemoryProjectionPort;
}>): ReturnType<typeof createProjectionPreflightNode> {
  __assertProtectedMemoryToolsNodeTestAuthorityForTesting(input.authority);
  return createProjectionPreflightNode((state, calls) =>
    preflightProtectedProjectionShareCalls(state, calls, input.projection), {
    sanitizeProjectionToolArgs: true,
  });
}
