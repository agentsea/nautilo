import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { browserObservationFromResult, type BrowserDecisionObservation } from "../../graph/browser-decision";
import { isImageContentBlock } from "../../utils/message-modalities";

function liveObservation(message: BaseMessage): BrowserDecisionObservation | null {
  if (!ToolMessage.isInstance(message) || !["browser_snapshot", "browser_open", "browser_back", "browser_forward", "browser_reload", "control_connected_web_operation"].includes(message.name ?? "")
    || message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error"
    || typeof message.content !== "string") return null;
  return browserObservationFromResult(message.name, message.content);
}

/** Recognize successful full page reads; leave errors and targeted find/range evidence intact. */
function pageRead(message: BaseMessage): Record<string, unknown> | null {
  if (!ToolMessage.isInstance(message) || message.name !== "browser_read_page"
    || message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error"
    || typeof message.content !== "string") return null;
  try {
    const value = JSON.parse(message.content) as Record<string, unknown>;
    return value["failure"] === "none" && typeof value["content"] === "string"
      && typeof value["finalUrl"] === "string" && Array.isArray(value["blocks"])
      && typeof value["totalCharacters"] === "number" && value["historical"] !== true ? value : null;
  } catch { return null; }
}

/** Reads only the current conversation's retained canonical result; never dispatches to a browser. */
export function readBrowserHistory(messages: BaseMessage[], toolCallId: string): string | null {
  const matches = messages.filter(message => ToolMessage.isInstance(message) && message.tool_call_id === toolCallId);
  if (matches.length !== 1) return null;
  const observation = liveObservation(matches[0]!);
  const page = pageRead(matches[0]!);
  return observation || page ? JSON.stringify({ version: 1, historical: true, sourceToolCallId: toolCallId,
    warning: matches[0]!.name === "control_connected_web_operation"
      ? "Historical evidence only. Its refs are stale; take a fresh snapshot through control_connected_web_operation before acting."
      : "Historical evidence only. Its refs are stale; take a fresh browser_snapshot before acting.", ...(observation ? { observation } : { result: page }) }) : null;
}

/** Provider-only view. Baseline/current observations and all action/error receipts stay intact. */
export function projectBrowserHistory(messages: BaseMessage[]): {
  messages: BaseMessage[];
  originals: Map<string, ToolMessage>;
} {
  const originals = new Map<string, ToolMessage>();
  const pages = new Map<number, Record<string, unknown>>();
  const observations = new Map<number, BrowserDecisionObservation>();
  const callCounts = new Map<string, number>();
  const historicalCalls = new Map<string, string>();
  let latestScreenshotImage: { messageIndex: number; blockIndex: number } | null = null;
  for (const message of messages) {
    if (ToolMessage.isInstance(message)) callCounts.set(message.tool_call_id, (callCounts.get(message.tool_call_id) ?? 0) + 1);
    if (AIMessage.isInstance(message)) for (const call of message.tool_calls ?? []) {
      if (call.id && ["browser_snapshot", "control_connected_web_operation"].includes(call.name) && typeof call.args["historyToolCallId"] === "string") {
        historicalCalls.set(call.id, call.args["historyToolCallId"]);
      }
    }
  }
  for (let messageIndex = messages.length - 1; messageIndex >= 0 && latestScreenshotImage === null; messageIndex--) {
    const message = messages[messageIndex]!;
    if (!ToolMessage.isInstance(message) || message.name !== "browser_screenshot" || !Array.isArray(message.content)) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      if (isImageContentBlock(message.content[blockIndex])) {
        latestScreenshotImage = { messageIndex, blockIndex };
        break;
      }
    }
  }
  const current = new Set<string>();
  const baseline = new Set<string>();
  const retain = new Set<number>();
  let newestLiveIndex = -1;
  let newestPageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const page = pageRead(message);
    if (page && ToolMessage.isInstance(message) && callCounts.get(message.tool_call_id) === 1) {
      pages.set(index, page);
      originals.set(message.tool_call_id, message);
      if (newestPageIndex < 0) { newestPageIndex = index; retain.add(index); }
    }
    const observation = liveObservation(message);
    if (!observation || !ToolMessage.isInstance(message) || callCounts.get(message.tool_call_id) !== 1) continue;
    observations.set(index, observation);
    originals.set(message.tool_call_id, message);
    if (newestLiveIndex < 0) newestLiveIndex = index;
    // These are the before/after evidence roles, not a configurable snapshot quota.
    if (!current.has(observation.browserSessionId)) {
      current.add(observation.browserSessionId); retain.add(index);
    } else if (!baseline.has(observation.browserSessionId)) {
      baseline.add(observation.browserSessionId); retain.add(index);
    }
  }
  const projected = messages.map((message, index) => {
    if (ToolMessage.isInstance(message) && message.name === "browser_screenshot" && Array.isArray(message.content)
      && message.content.some(isImageContentBlock)) {
      if (callCounts.get(message.tool_call_id) === 1) originals.set(message.tool_call_id, message);
      if (index === latestScreenshotImage?.messageIndex
        && message.content.filter(isImageContentBlock).length === 1) return message;
      const content = index === latestScreenshotImage?.messageIndex
        ? message.content.filter((block, blockIndex) => !isImageContentBlock(block)
          || blockIndex === latestScreenshotImage?.blockIndex)
        : JSON.stringify({ version: 1, historical: true, screenshotOmitted: true,
          sourceToolCallId: message.tool_call_id,
          notice: "Older browser screenshot omitted from this prompt. Only the latest browser screenshot is visible; its canonical result remains in this conversation." });
      return new ToolMessage({
        content,
        tool_call_id: message.tool_call_id,
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.id === undefined ? {} : { id: message.id }),
        ...(message.status === undefined ? {} : { status: message.status }),
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
        ...(message.artifact === undefined ? {} : { artifact: message.artifact as unknown }),
      });
    }
    if (!ToolMessage.isInstance(message) || callCounts.get(message.tool_call_id) !== 1) return message;
    const observation = observations.get(index);
    const historicalSource = historicalCalls.get(message.tool_call_id);
    const isHistory = historicalSource !== undefined && ["browser_snapshot", "control_connected_web_operation"].includes(message.name ?? "") && message.status !== "error"
      && message.additional_kwargs["nautilo_tool_status"] !== "error";
    if (isHistory) originals.set(message.tool_call_id, message);
    const page = pages.get(index);
    if (((!observation && !page) || retain.has(index)) && (!isHistory || index > Math.max(newestLiveIndex, newestPageIndex))) return message;
    // Keep all navigation/action receipt fields; only its obsolete observation is projected.
    const envelope = observation && message.name !== "browser_snapshot" && typeof message.content === "string"
      ? JSON.parse(message.content) as Record<string, unknown> : {};
    const { observation: _observation, ...receipt } = envelope;
    const { content: _content, blocks: _blocks, ...pageMetadata } = page ?? {};
    const sourceToolCallId = historicalSource ?? message.tool_call_id;
    return new ToolMessage({
      content: JSON.stringify({ ...receipt, ...pageMetadata, version: 1, historical: true, sourceToolCallId,
        ...(observation ? { pageUrl: observation.pageUrl, browserSessionId: observation.browserSessionId,
          observationId: observation.observationId } : {}),
        originalCharacters: typeof message.content === "string" ? message.content.length : null,
        notice: "Older browser evidence omitted from this prompt. Canonical content is retained in this conversation; these are not current action refs.",
        retrieve: { tool: message.name === "control_connected_web_operation" ? message.name : "browser_snapshot", args: { historyToolCallId: sourceToolCallId } },
      }),
      tool_call_id: message.tool_call_id,
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.status === undefined ? {} : { status: message.status }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      ...(message.artifact === undefined ? {} : { artifact: message.artifact as unknown }),
    });
  });
  return { messages: projected, originals };
}
