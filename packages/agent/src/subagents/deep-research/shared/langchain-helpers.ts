import { AIMessage, type BaseMessageLike, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const coerceString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
};

export const getStringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return coerceString(value);
};

export const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
};

export const getToolCalls = (message: AIMessage | undefined): ToolCall[] => {
  if (!message) return [];
  const { tool_calls: rawToolCalls } = message;
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.filter((call): call is ToolCall => Boolean(call && typeof call === "object"));
};

export const toAIMessage = (message: BaseMessageLike | undefined): AIMessage | undefined => {
  if (!message) return undefined;
  if (AIMessage.isInstance(message as BaseMessage)) return message as AIMessage;
  return undefined;
};
