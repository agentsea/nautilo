import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  invokeChatModelWithFallback,
  type UsageCallType,
} from "@nautilo/agent";

function extractText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      typeof part === "string"
        ? part
        : part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
    )
    .join("");
}

export interface RoomSideModelInvocationPolicy {
  readonly maximumElapsedMs: number;
  readonly modelFallbackMode: "agent_chain" | "none";
  readonly sameModelRetryMode: "none" | "short";
}

export { runBackgroundModelWithDeadline as runRoomSideModelWithDeadline } from "../background-processing/model-invocation";
import { runBackgroundModelInvocation } from "../background-processing/model-invocation";

export function createRoomSideModelInvoker(opts: {
  modelId: string;
  userId: string;
  roomId: string;
  laneKey: string;
  callType: Extract<
    UsageCallType,
    "room_stenographer" | "room_reflection" | "room_event_compaction"
  >;
  operationId: string;
  invocationPolicy?: RoomSideModelInvocationPolicy;
}): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    if (signal?.aborted) throw new Error("room_side_model_aborted");
    const { response } = await runBackgroundModelInvocation({
        usage: {
          callType: opts.callType,
          userId: opts.userId,
          roomId: opts.roomId,
          metadata: { operationId: opts.operationId },
        },
        ...(signal === undefined ? {} : { signal }),
        ...(opts.invocationPolicy === undefined ? {} : { maximumElapsedMs: opts.invocationPolicy.maximumElapsedMs }),
        invoke: (invocationSignal) =>
          invokeChatModelWithFallback(
            [new HumanMessage(prompt)],
            [],
            opts.modelId,
            opts.userId,
            null,
            opts.laneKey,
            invocationSignal === undefined ? undefined : { signal: invocationSignal },
            {
              reasoningOutput: false,
              modelFallbackMode: opts.invocationPolicy?.modelFallbackMode ?? "agent_chain",
              ...(opts.invocationPolicy === undefined ? {} : {
                sameModelRetryMode: opts.invocationPolicy.sameModelRetryMode,
                providerTimeoutMs: opts.invocationPolicy.maximumElapsedMs,
              }),
            },
          ),
      });
    return extractText(response);
  };
}

export function mapModelFailure(
  error: unknown,
): "provider" | "timeout" | "unknown" {
  const text = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
  if (
    text.includes("deadline_exceeded")
    || text.includes("timeout")
    || text.includes("timed out")
    || text.includes("abort")
  ) {
    return "timeout";
  }
  if (
    text.includes("provider")
    || text.includes("model")
    || text.includes("api key")
    || text.includes("rate limit")
  ) {
    return "provider";
  }
  return "unknown";
}
