import type { ServerEvent } from "@nautilo/types";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { eventBus } from "../../src/event-bus";
import { persistMessages } from "../../src/executors/persist-messages";

function stringField(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/**
 * Deterministic “one turn” executor for transcript contract tests — no LLM.
 * Persists exactly one human (with humanTurnId) + one assistant reply.
 */
export async function* stubSingleTurnTranscriptExecutor(
  input: Record<string, unknown>,
  _jobId: string,
  _laneKey: string | null,
  _signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const ownerId = stringField(input, "ownerId");
  const threadId = stringField(input, "threadId");
  const turnId = typeof input["turnId"] === "string" && input["turnId"] ? input["turnId"] : "";
  const message = stringField(input, "message");
  const assistantReply =
    typeof input["__stubAssistantReply"] === "string"
      ? String(input["__stubAssistantReply"])
      : "Stub assistant reply.";

  const saved = new Set<string>();
  await persistMessages(threadId, ownerId, [new HumanMessage(message)], saved, {
    eventBus,
    ...(turnId ? { humanTurnId: turnId } : {}),
  });
  await persistMessages(threadId, ownerId, [new AIMessage(assistantReply)], saved, { eventBus });

  yield {
    type: "message.new",
    laneKey: String(_laneKey ?? threadId),
    messageId: `stub-${threadId}-done`,
    role: "ai",
    content: assistantReply,
  };
}

/**
 * One turn with a tool result row (session_messages role `tool`).
 */
export async function* stubTurnWithToolExecutor(
  input: Record<string, unknown>,
  _jobId: string,
  _laneKey: string | null,
  _signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const ownerId = stringField(input, "ownerId");
  const threadId = stringField(input, "threadId");
  const turnId = typeof input["turnId"] === "string" && input["turnId"] ? input["turnId"] : "";
  const saved = new Set<string>();

  await persistMessages(threadId, ownerId, [new HumanMessage("Run tool")], saved, {
    eventBus,
    ...(turnId ? { humanTurnId: turnId } : {}),
  });
  await persistMessages(
    threadId,
    ownerId,
    [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: "search_memory", args: {}, type: "tool_call" }],
      }),
    ],
    saved,
    { eventBus },
  );
  await persistMessages(threadId, ownerId, [new ToolMessage({ content: "[]", tool_call_id: "call-1", name: "search_memory" })], saved, {
    eventBus,
  });

  yield {
    type: "message.new",
    laneKey: String(_laneKey ?? threadId),
    messageId: `stub-tool-${threadId}`,
    role: "ai",
    content: "done",
  };
}
