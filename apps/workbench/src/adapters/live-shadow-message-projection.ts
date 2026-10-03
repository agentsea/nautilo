import {
  projectToolResultForEvent,
  type FullEncryptionMessageRealtimeContentEventV2,
  type LiveShadowMessageRealtimeEventV1,
  type ServerEvent,
} from "@nautilo/types";
import type {
  VaultLiveShadowReceiveResult,
} from "@nautilo/lattice-bridge/client/browser";

type OpenedProjection = Extract<VaultLiveShadowReceiveResult, {
  status: "frame_verified" | "durable_verified";
}> | NonNullable<Extract<VaultLiveShadowReceiveResult, {
  status: "failed";
}>["ordinaryFallback"]>;

type ProjectableLiveShadowMessageEvent = Extract<
  LiveShadowMessageRealtimeEventV1,
  { type:
    | "message.shadow_stream_start"
    | "message.shadow_stream_frame"
    | "message.shadow_durable"
    | "message.shared_agent_stream_start"
    | "message.shared_agent_stream_frame"
    | "message.shared_agent_output_shadow" }
> | Extract<FullEncryptionMessageRealtimeContentEventV2, { type:
  | "message.shadow_stream_start"
  | "message.shadow_stream_frame"
  | "message.shadow_durable"
  | "message.shared_agent_stream_start"
  | "message.shared_agent_stream_frame"
  | "message.shared_agent_output_shadow"
}>;

function openedProjection(
  result: VaultLiveShadowReceiveResult,
): OpenedProjection | null {
  if (result.status === "start_verified") return null;
  // Integrity failure is never permission to display a plaintext sibling.
  // Eligible availability fallbacks are still unverified and must pass the
  // bound data-operation owner before reaching a transcript.
  if (result.status === "failed") return result.reason === "unavailable"
    ? result.ordinaryFallback ?? null
    : null;
  return result;
}

/** Preflight rejections use this exact envelope inside the protected payload. */
export function isShareRejection(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 1 && "error" in value
      && typeof value.error === "string" && value.error.length > 0;
  } catch {
    return false;
  }
}

/** Project only locally opened-or-explicit-plaintext-fallback bytes to UI events. */
export function projectLiveShadowMessageResult(input: Readonly<{
  event: ProjectableLiveShadowMessageEvent;
  result: VaultLiveShadowReceiveResult;
}>): readonly ServerEvent[] {
  const opened = openedProjection(input.result);
  if (opened === null) return Object.freeze([]);
  if ("ordinaryChunk" in opened) {
    return Object.freeze([Object.freeze({
      type: "message.tokens" as const,
      laneKey: input.event.laneKey,
      content: opened.ordinaryChunk,
      chunkSequence: opened.chunkSequence,
      done: opened.done,
      authorAgentId: opened.authorAgentId,
      turnId: input.event.operationId,
      assistantMessageKey: opened.assistantMessageKey,
    })]);
  }

  const payload = opened.payload;
  if (payload.role === "assistant") {
    const events: ServerEvent[] = [];
    for (const call of payload.toolCalls ?? []) {
      if (typeof call.id !== "string" || call.id.length === 0) continue;
      events.push(Object.freeze({
        type: "tool.start" as const,
        laneKey: input.event.laneKey,
        toolCallId: call.id,
        toolName: call.name,
        argsSummary: JSON.stringify(call.args),
        authorAgentId: opened.authorAgentId,
        turnId: input.event.operationId,
      }));
    }
    if (payload.content.length > 0) {
      events.push(Object.freeze({
        type: "message.new" as const,
        laneKey: input.event.laneKey,
        messageId: opened.messageId,
        ...("protectedMessage" in input.event ? { createdAt: input.event.protectedMessage.projection.createdAt } : {}),
        role: "ai" as const,
        content: payload.content,
        authorAgentId: opened.authorAgentId,
        ...(opened.assistantMessageKey === null
          ? {}
          : { assistantMessageKey: opened.assistantMessageKey }),
      }));
    }
    return Object.freeze(events);
  }

  const callId = payload.sensitiveMetadata?.["toolCallId"];
  if (
    payload.role !== "tool"
    || typeof callId !== "string"
    || callId.length === 0
    || typeof payload.toolName !== "string"
  ) return Object.freeze([]);
  const explicitStatus = payload.sensitiveMetadata?.["toolStatus"];
  const status = explicitStatus === "error"
    || (explicitStatus === undefined && payload.toolName === "share_memory"
      && isShareRejection(payload.content))
    ? "error"
    : "success";
  const projected = projectToolResultForEvent(payload.toolName, payload.content);
  return Object.freeze([Object.freeze({
    type: "tool.end" as const,
    laneKey: input.event.laneKey,
    toolCallId: callId,
    toolName: payload.toolName,
    duration: 0,
    status,
    ...(status === "error" ? { error: projected.result } : {}),
    result: projected.result,
    ...(projected.truncated ? { resultTruncated: true } : {}),
    authorAgentId: opened.authorAgentId,
    turnId: input.event.operationId,
  })]);
}
