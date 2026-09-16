import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import {
  modelRouteProvider,
  resolveUnderlyingModelFamily,
} from "../providers/model-route";

/**
 * Anthropic cache controls are supported on the direct Anthropic route and on
 * OpenRouter requests whose underlying model family is Anthropic.
 */
export function modelUsesAnthropicPromptCache(modelId: string): boolean {
  const routeProvider = modelRouteProvider(modelId);
  return resolveUnderlyingModelFamily(modelId) === "anthropic"
    && (routeProvider === "anthropic" || routeProvider === "openrouter");
}

/** Direct GPT-5.6 Responses routes support OpenAI's explicit content breakpoint. */
export function modelUsesOpenAIExplicitPromptCache(modelId: string): boolean {
  return modelRouteProvider(modelId) === "openai"
    && /^openai:gpt-5\.6(?:-|$)/i.test(modelId.trim());
}

export interface ModelContextCacheProjectionOptions {
  /** The actual attempt is confirmed to use OpenAI Responses explicit mode. */
  readonly openAIExplicitPromptCache?: boolean;
}

function flattenTextOnlySystemContent(content: BaseMessage["content"]): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  let text = "";
  for (const block of content) {
    const blockType = typeof block === "object" && block !== null
      ? (block as Record<string, unknown>)["type"]
      : undefined;
    if (
      typeof block !== "object"
      || block === null
      || (blockType !== "text" && blockType !== "input_text")
      || typeof (block as Record<string, unknown>)["text"] !== "string"
    ) {
      return null;
    }
    text += (block as Record<string, unknown>)["text"] as string;
  }
  return text;
}

/** Whether the supplied boundary can be projected without inspecting content. */
export function hasProjectableStableSystemPrefix(
  messages: BaseMessage[],
  stableSystemPrefixLength: number,
): boolean {
  const first = messages[0];
  if (!(first instanceof SystemMessage)) return false;
  if (
    !Number.isSafeInteger(stableSystemPrefixLength)
    || stableSystemPrefixLength < 1
  ) {
    return false;
  }
  const systemText = flattenTextOnlySystemContent(first.content);
  return systemText !== null && stableSystemPrefixLength <= systemText.length;
}

function cloneSystemMessageWithContent(
  message: BaseMessage,
  content: BaseMessage["content"],
): SystemMessage {
  const cloned = new SystemMessage({
    content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    ...(message.name ? { name: message.name } : {}),
  });
  if (message.id) cloned.id = message.id;
  return cloned;
}

/**
 * Project the byte-identical prepared system prompt for the provider that is
 * actually about to run. Room controls and fallback can change that provider
 * after pre-model, so cache-control shape belongs at this per-attempt seam.
 */
export function projectPreparedMessagesForModelCache(
  messages: BaseMessage[],
  modelId: string,
  stableSystemPrefixLength: number,
  options: ModelContextCacheProjectionOptions = {},
): BaseMessage[] {
  const first = messages[0];
  if (!(first instanceof SystemMessage)) return messages;
  if (!hasProjectableStableSystemPrefix(messages, stableSystemPrefixLength)) return messages;

  const systemText = flattenTextOnlySystemContent(first.content);
  if (systemText === null) return messages;

  const stableSystemPrefix = systemText.slice(0, stableSystemPrefixLength);
  const volatileSystemSuffix = systemText.slice(stableSystemPrefixLength);

  if (!modelUsesAnthropicPromptCache(modelId)) {
    if (
      options.openAIExplicitPromptCache === true
      && modelUsesOpenAIExplicitPromptCache(modelId)
    ) {
      const content = [
        {
          type: "input_text" as const,
          text: stableSystemPrefix,
          prompt_cache_breakpoint: { mode: "explicit" as const },
        },
        ...(volatileSystemSuffix.length > 0
          ? [{ type: "input_text" as const, text: volatileSystemSuffix }]
          : []),
      ];
      return [
        cloneSystemMessageWithContent(
          first,
          content as unknown as BaseMessage["content"],
        ),
        ...messages.slice(1),
      ];
    }
    if (typeof first.content === "string") return messages;
    return [cloneSystemMessageWithContent(first, systemText), ...messages.slice(1)];
  }

  const content = [
    {
      type: "text" as const,
      text: stableSystemPrefix,
      cache_control: { type: "ephemeral" as const },
    },
    ...(volatileSystemSuffix.length > 0
      ? [{ type: "text" as const, text: volatileSystemSuffix }]
      : []),
  ];
  return [cloneSystemMessageWithContent(first, content), ...messages.slice(1)];
}
