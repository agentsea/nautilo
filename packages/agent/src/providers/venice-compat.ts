import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import {
  ChatOpenAICompletions,
  type convertCompletionsDeltaToBaseMessageChunk,
} from "@langchain/openai";
import type { ChatModel } from "./types";
import { ensureAnthropicObjectInputSchema } from "./anthropic-schema";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Venice routes every catalog model through its OpenAI-compatible endpoint,
 * including upstream Claude models. Those Claude routes enforce Anthropic's
 * object-root tool-schema requirement after receiving the OpenAI descriptor.
 * Keep the OpenAI wire envelope, projecting only its function parameters.
 * The original LangChain tool remains authoritative for execution validation.
 */
export function convertToolToVeniceTool(tool: unknown): unknown {
  if (!isObject(tool)) return tool;

  if (tool["type"] === "function" && isObject(tool["function"])) {
    const fn = tool["function"];
    return {
      ...tool,
      function: {
        ...fn,
        parameters: ensureAnthropicObjectInputSchema(fn["parameters"]),
      },
    };
  }

  // Provider-native definitions are already wire descriptors. Only ordinary
  // LangChain tools are converted into OpenAI function envelopes here.
  if (typeof tool["type"] === "string") return tool;
  if (typeof tool["name"] !== "string" || tool["schema"] === undefined) return tool;

  const converted = convertToOpenAITool(tool) as unknown as JsonObject;
  const fn = converted["function"];
  if (!isObject(fn)) return converted;
  return {
    ...converted,
    function: {
      ...fn,
      parameters: ensureAnthropicObjectInputSchema(fn["parameters"]),
    },
  };
}

/** Intercept every Venice bind, including binds on an already-bound model. */
export function wrapVeniceModelForToolSchemas<M extends ChatModel>(model: M): M {
  if (!model.bindTools) return model;
  const originalBindTools = model.bindTools.bind(model);
  const bindTools: NonNullable<ChatModel["bindTools"]> = (tools, options) => {
    const normalizedTools = Array.isArray(tools)
      ? tools.map(convertToolToVeniceTool)
      : tools;
    return wrapVeniceModelForToolSchemas(originalBindTools(normalizedTools, options));
  };

  return new Proxy(model as M & object, {
    get(target, property, receiver) {
      if (property === "bindTools") return bindTools;
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as M;
}

type CompletionDeltaConversion = Parameters<
  typeof convertCompletionsDeltaToBaseMessageChunk
>[0];

/**
 * A Chat Completions response choice is assistant output. Some compatible
 * providers omit `delta.role` even on the first streamed chunk. LangChain
 * otherwise creates a generic `ChatMessageChunk`, which bypasses Nautilo's AI
 * result checks and may be persisted with role `unknown`. Supply the endpoint's
 * semantic role as a converter default; content and tool calls still come only
 * from the provider payload.
 */
export class VeniceChatOpenAICompletions extends ChatOpenAICompletions {
  protected override _convertCompletionsDeltaToBaseMessageChunk(
    delta: CompletionDeltaConversion["delta"],
    rawResponse: CompletionDeltaConversion["rawResponse"],
    defaultRole?: CompletionDeltaConversion["defaultRole"],
  ) {
    return super._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      rawResponse,
      defaultRole ?? "assistant",
    );
  }
}
