import type { AIMessage } from "@langchain/core/messages";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function openaiWebsearchCalled(msg: AIMessage | undefined): boolean {
  if (!msg) return false;
  const toolOutputs = msg.additional_kwargs?.["tool_outputs"];
  if (!Array.isArray(toolOutputs)) return false;
  return toolOutputs.some((entry) => {
    if (!isRecord(entry)) return false;
    const typeValue = entry["type"];
    return typeof typeValue === "string" && typeValue.toLowerCase() === "web_search_call";
  });
}

function anthropicWebsearchCalled(msg: AIMessage | undefined): boolean {
  if (!msg) return false;
  const responseMetadata = msg.response_metadata;
  if (!isRecord(responseMetadata)) return false;
  const usage = responseMetadata["usage"];
  if (!isRecord(usage)) return false;
  const serverToolUse = usage["server_tool_use"];
  if (!isRecord(serverToolUse)) return false;
  const webSearchRequests = serverToolUse["web_search_requests"];
  return typeof webSearchRequests === "number" && webSearchRequests > 0;
}

export function hasNativeWebsearch(msg: AIMessage | undefined): boolean {
  return openaiWebsearchCalled(msg) || anthropicWebsearchCalled(msg);
}
