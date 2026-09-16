import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";

/** Tool display name for `session_messages.tool_name` (tool rows only). */
export function transcriptToolNameForRow(message: BaseMessage): string | null {
  if (!(message instanceof ToolMessage)) return null;
  const n = message.name;
  if (typeof n !== "string") return null;
  const t = n.trim();
  return t.length > 0 ? t : null;
}
