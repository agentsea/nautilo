import type { BaseMessage } from "@langchain/core/messages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** True when a LangChain-style content block represents image bytes or URLs. */
export function isImageContentBlock(block: unknown): boolean {
  if (!isRecord(block)) return false;
  const type = stringValue(block["type"]).toLowerCase();
  const mimeType = (
    stringValue(block["mimeType"]) ||
    stringValue(block["mime_type"]) ||
    stringValue(block["media_type"]) ||
    stringValue(block["contentType"])
  ).toLowerCase();
  const data = stringValue(block["data"]) || stringValue(block["url"]);

  if (type === "image" || type === "image_url" || type === "input_image") return true;
  if (type.includes("image")) return true;
  if (mimeType.startsWith("image/")) return true;
  if (data.startsWith("data:image/")) return true;

  const imageUrl = block["image_url"];
  if (typeof imageUrl === "string" && imageUrl.startsWith("data:image/")) return true;
  if (isRecord(imageUrl) && stringValue(imageUrl["url"]).startsWith("data:image/")) return true;
  return false;
}

/** True when a LangChain-style content block is a PDF carried as a native file/document block. */
export function isPdfDocumentContentBlock(block: unknown): boolean {
  if (!isRecord(block)) return false;
  const type = stringValue(block["type"]).toLowerCase();
  const mimeType = (
    stringValue(block["mimeType"]) ||
    stringValue(block["mime_type"]) ||
    ""
  ).toLowerCase();
  const url = stringValue(block["url"]);
  if (mimeType === "application/pdf") return true;
  if (type === "file" && mimeType.includes("pdf")) return true;
  if (url.startsWith("data:application/pdf")) return true;
  return false;
}

export function hasPdfDocumentContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isPdfDocumentContentBlock);
}

export function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isImageContentBlock);
}

/** True when any block needs multimodal sanitization (vision + PDF tool results). */
export function hasMultimodalToolContent(content: unknown): boolean {
  return hasImageContent(content) || hasPdfDocumentContent(content);
}

/** True if any message still carries image blocks (capability-aware routing / fallback). */
export function messagesContainImageInputs(messages: BaseMessage[]): boolean {
  for (const msg of messages) {
    if (Array.isArray(msg.content) && hasImageContent(msg.content)) return true;
  }
  return false;
}
