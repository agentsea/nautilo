import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { modelRouteProvider } from "../providers/model-route";

function flattenContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return (content as unknown[])
    .map((block: unknown) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) {
        return String((block as { text: unknown }).text);
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function cloneSystemMessageWithContent(message: BaseMessage, content: string): SystemMessage {
  const cloned = new SystemMessage({
    content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
  if (message.id) cloned.id = message.id;
  return cloned;
}

/** Fold historical system messages into the leading system prompt without mutating the input. */
export function collapseNonLeadingSystemMessages(messages: BaseMessage[]): {
  messages: BaseMessage[];
  collapsed: number;
} {
  if (messages.length === 0) return { messages, collapsed: 0 };
  const leading = messages[0];
  if (!(leading instanceof SystemMessage)) return { messages, collapsed: 0 };

  const extraSystemText: string[] = [];
  const next: BaseMessage[] = [leading];
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message instanceof SystemMessage) {
      const text = flattenContentToString(message.content).trim();
      if (text) extraSystemText.push(text);
      continue;
    }
    next.push(message);
  }

  if (extraSystemText.length === 0) return { messages, collapsed: 0 };
  next[0] = cloneSystemMessageWithContent(
    leading,
    `${flattenContentToString(leading.content)}\n\n[Additional system context recovered from history]\n${extraSystemText.join("\n\n")}`,
  );
  return { messages: next, collapsed: extraSystemText.length };
}

/** Direct OpenAI accepts chronological developer messages; other routes retain the single-leading-system contract. */
export function projectSystemMessagesForProvider(
  messages: BaseMessage[],
  modelId: string,
): { messages: BaseMessage[]; collapsed: number } {
  return modelRouteProvider(modelId) === "openai"
    ? { messages, collapsed: 0 }
    : collapseNonLeadingSystemMessages(messages);
}
