import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

const TOOL_PRESENTATION_KEY = "nautilo_tool_result";
export interface TranscriptToolPresentation { toolCallId?: string; toolStatus?: "success" | "error" }

/** Presentation facts from the actual tool result, never from source text. */
export function withTranscriptToolPresentation(message: BaseMessage, metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!ToolMessage.isInstance(message)) return metadata;
  const { [TOOL_PRESENTATION_KEY]: _ignored, ...rest } = metadata ?? {};
  const toolStatus = message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error" ? "error"
    : message.status === "success" || message.additional_kwargs["nautilo_tool_status"] === "success" ? "success" : undefined;
  return { ...rest, [TOOL_PRESENTATION_KEY]: {
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}), ...(toolStatus ? { toolStatus } : {}),
  } };
}

/** Expose only closed display fields; host sidecars and source bytes stay private. */
export function readTranscriptToolPresentation(metadata: unknown): TranscriptToolPresentation {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const value = (metadata as Record<string, unknown>)[TOOL_PRESENTATION_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  return {
    ...(typeof fields["toolCallId"] === "string" && fields["toolCallId"].length > 0 ? { toolCallId: fields["toolCallId"] } : {}),
    ...(fields["toolStatus"] === "success" || fields["toolStatus"] === "error" ? { toolStatus: fields["toolStatus"] } : {}),
  };
}
