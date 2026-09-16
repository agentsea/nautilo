import type { BaseMessageLike } from "@langchain/core/messages";

/**
 * Extract text content from an LLM response object.
 * Handles AIMessage, string, and array content formats.
 */
export function extractTextFromResponse(resp: unknown): string {
  if (typeof resp === "string") return resp;
  if (!resp || typeof resp !== "object") return "";
  const record = resp as Record<string, unknown>;
  const content = record["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string"
          ? block
          : block && typeof block === "object" && "text" in block
            ? String((block as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Stringify a BaseMessageLike's content to a plain string.
 */
export function messageContentToString(msg: BaseMessageLike): string {
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) return msg.map(String).join(" ");
  if (msg && typeof msg === "object") {
    const record = msg as Record<string, unknown>;
    const content = record["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) =>
          typeof c === "string"
            ? c
            : c && typeof c === "object" && "text" in c
              ? String((c as { text: unknown }).text)
              : "",
        )
        .join("");
    }
  }
  return "";
}

/**
 * Safely parse a JSON string, returning null on failure.
 */
export function parseJsonSafely<T>(text: string): T | null {
  try {
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/**
 * LangGraph state reducer that replaces the list instead of appending.
 */
export function overrideListReducer<T>(_existing: T[], update: T[]): T[] {
  return update;
}
