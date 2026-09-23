import { stripAssistantArtifacts } from "../lib/strip-assistant-artifacts";

/** Suppress empty assistant chrome while retaining tool cards and attachments. */
export function hasVisibleAssistantContent(parts: readonly { type: string; text?: string }[]): boolean {
  return parts.some(part => part.type !== "text" || stripAssistantArtifacts(part.text ?? "").trim().length > 0);
}
