import { z } from "zod";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { copyModelInputExposure } from "../../memory/model-input-exposure";
import { resultReceipt, resultVersion, resultReferenceSchema } from "./result-window";

/** A retained-result reader is a read-only dependency of admitted output producers. */
export function withResultReader(whitelist: readonly string[] | undefined): string[] | undefined {
  if (whitelist === undefined) return undefined;
  return whitelist.some((name) => name === "officecli" || name === "file" || name === "task")
    ? [...new Set([...whitelist, "read_tool_result"])] : [...whitelist];
}

export function projectToolResults(messages: BaseMessage[], maxBytes: number): BaseMessage[] {
  const candidates = messages.filter((message) => ToolMessage.isInstance(message)
    && (message.name === "officecli" || message.name === "read_tool_result") && typeof message.content === "string");
  const allowance = Math.floor(Math.max(0, maxBytes) / Math.max(1, candidates.length));
  return messages.map((message) => {
    if (!ToolMessage.isInstance(message) || !candidates.includes(message) || typeof message.content !== "string"
      || message.additional_kwargs["nautilo_retained_result_projection"] === true
      || Buffer.byteLength(message.content) <= allowance) return message;
    const reference = { kind: "call" as const, callId: message.tool_call_id, sourceVersion: resultVersion(message.content) };
    let content = JSON.stringify(resultReceipt(reference, message.content,
      message.status ?? (message.additional_kwargs["nautilo_tool_status"] === "error" ? "error" : "unknown")));
    if (message.name === "read_tool_result") {
      try {
        const page = z.object({ reference: resultReferenceSchema, path: z.array(z.string()).nullable().optional(), startByte: z.number().int().nonnegative().optional() }).parse(JSON.parse(message.content));
        if (page.reference) content = JSON.stringify({ version: "tool-result-v1", kind: "replay",
          read: { reference: page.reference, operation: "read", ...(Array.isArray(page.path) ? { path: page.path } : {}),
            ...(Number.isSafeInteger(page.startByte) ? { offset: page.startByte } : {}) },
          disclosure: "An earlier retrieved page was omitted from this request. Reread the original result if needed; no new output file was created." });
      } catch { /* Non-page failures retain their canonical call reference. */ }
    }
    const projected = new ToolMessage({ ...message, content,
      additional_kwargs: { ...message.additional_kwargs, nautilo_retained_result_projection: true } });
    copyModelInputExposure(message, projected);
    return projected;
  });
}

/** Conservative allowance for newly retrieved text: reserve half of the unoccupied window.
 * UTF-8 bytes replace the four-characters-per-token assumption for dense result data. */
export function resultResponseByteBudget(maxMessageTokens: number, messages: BaseMessage[]): number {
  const occupied = messages.reduce((total, message) => total + Buffer.byteLength(
    JSON.stringify({ content: message.content, ...("tool_calls" in message ? { toolCalls: message.tool_calls } : {}) }), "utf8"), 0);
  return Math.floor(Math.max(0, maxMessageTokens - occupied) / 2);
}
