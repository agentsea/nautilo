import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import { isForegroundContextPreparationWaitingError } from "../conversation/foreground-context-preparation";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  imageAssistanceContext,
  ImageAssistanceError,
  imageAssistanceSummary,
  type ImageAssistanceResult,
} from "@nautilo/agent";
import type { RoomHistoryHit } from "../conductor/history-search";

/** Read only a canonical tool row from the already-authorized transcript. */
export function retainedImageAssistance(hits: readonly RoomHistoryHit[]): ImageAssistanceResult[] {
  return hits.flatMap((hit) => {
    if (hit.role !== "tool" || hit.toolName !== "image_assistance") return [];
    const content = hit.snippet.startsWith("tool:image_assistance ")
      ? hit.snippet.slice("tool:image_assistance ".length) : hit.snippet;
    try {
      const result = JSON.parse(content) as ImageAssistanceResult;
      if (result.status !== "completed" || typeof result.turnId !== "string" || typeof result.inputDigest !== "string"
        || typeof result.modelId !== "string" || typeof result.modelDisplayName !== "string"
        || typeof result.observations !== "string" || !result.observations.trim()
        || !Array.isArray(result.attachmentIds) || !result.attachmentIds.every((id) => typeof id === "string")) return [];
      return [result];
    } catch { return []; }
  });
}

/** History owns narration; never inject an unmatched provider ToolMessage. */
export function imageAssistanceHistory(hits: readonly RoomHistoryHit[]): RoomHistoryHit[] {
  return hits.map((hit) => {
    const result = retainedImageAssistance([hit])[0];
    return result ? { ...hit, snippet: imageAssistanceContext(result) } : hit;
  });
}

export function imageAssistanceObservation(result: ImageAssistanceResult): ToolMessage {
  return new ToolMessage({ name: "image_assistance", tool_call_id: `image-assistance:${result.turnId}:${result.inputDigest}`,
    status: "success", content: JSON.stringify(result) });
}

export function attributeImageAssistance(messages: readonly BaseMessage[], result: ImageAssistanceResult | null): void {
  if (!result) return;
  for (const message of messages) {
    if (AIMessage.isInstance(message) && !message.tool_calls?.length) {
      message.additional_kwargs["nautilo_image_assistance"] = imageAssistanceSummary(result);
    }
  }
}

/** Persist the existing canonical call/result pair; neither row enters graph state. */
export function imageAssistanceObservationMessages(result: ImageAssistanceResult): BaseMessage[] {
  const observation = imageAssistanceObservation(result);
  return [new AIMessage({ content: "", tool_calls: [{
    id: observation.tool_call_id, name: "image_assistance", args: {}, type: "tool_call",
  }] }), observation];
}

/** Preserve cancellation/authority waits while giving failed extraction a safe recovery code. */
export function failImageAssistance(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  if (error instanceof StrictShadowEnforcementError || isForegroundContextPreparationWaitingError(error)
    || (error instanceof Error && error.name === "AbortError")) throw error;
  throw new ImageAssistanceError();
}
