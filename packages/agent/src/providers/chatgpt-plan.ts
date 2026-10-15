import { ChatOpenAI, ChatOpenAIResponses, convertResponsesDeltaToChatGenerationChunk, type ResponsesInputItem } from "@langchain/openai";
import { convertCanonicalResponsesInput } from "./openai-compat";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "./errors";
import type { ChatModel, CreateModelOptions } from "./types";

import { ChatGPTSubscriptionError, subscriptionFailure } from "./chatgpt-plan-errors";

/** Closed wire contract for plan-funded Responses; no caller URL/headers/kwargs. */
export class ChatGPTPlanResponses extends ChatOpenAIResponses {
  override invocationParams(options?: Parameters<ChatOpenAIResponses["invocationParams"]>[0]) {
    const original = super.invocationParams(options);
    let tools = (original.tools ?? []).map(tool => {
      if (tool.type !== "function" && tool.type !== "custom") throw new ChatGPTSubscriptionError("unsupported_input");
      return tool;
    });
    let choice = original.tool_choice;
    if (choice && typeof choice !== "string") {
      if (choice.type !== "function" && choice.type !== "custom") throw new ChatGPTSubscriptionError("unsupported_input");
      const selected = choice;
      tools = tools.filter(tool => tool.type === selected.type && tool.name === selected.name);
      if (tools.length !== 1) throw new ChatGPTSubscriptionError("unsupported_input");
      // A required namespace containing only the requested tool preserves the
      // caller's policy without inventing an undocumented namespace selector.
      choice = "required";
    }
    return {
      model: this.model, store: false, stream: true,
      ...(original.reasoning ? { reasoning: original.reasoning } : {}),
      ...(original.text ? { text: original.text } : {}),
      include: ["reasoning.encrypted_content" as const],
      ...(choice ? { tool_choice: choice } : {}),
      ...(tools.length ? { tools: [{ type: "namespace" as const, name: "nautilo", description: "Nautilo tools", tools }] } : {}),
    };
  }

  override async *_streamResponseChunks(
    messages: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[0],
    options: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[1],
    runManager?: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[2],
  ) {
    const input = messages.flatMap(message => {
      const converted = convertCanonicalResponsesInput({ messages: [message], zdrEnabled: true, model: this.model });
      const output: unknown = message.response_metadata["output"];
      // LangChain retains completed output metadata but drops encrypted
      // reasoning from its incremental additional_kwargs. Replay the opaque
      // provider items in position; never request server-side stored history.
      const reasoning = Array.isArray(output) ? output.filter((item: unknown): item is ResponsesInputItem =>
        item !== null && typeof item === "object" && "type" in item && item.type === "reasoning"
          && "encrypted_content" in item && typeof item.encrypted_content === "string") : [];
      return reasoning.length ? [...reasoning, ...converted.filter(item => !("type" in item) || item.type !== "reasoning")] : converted;
    }).map(item => {
      if ("content" in item && Array.isArray(item.content)) {
        for (const part of item.content as unknown[]) {
          if (typeof part === "object" && part !== null && "type" in part
            && (part.type === "input_audio" || part.type === "input_video"
              || part.type === "input_file" && "file_id" in part)) throw new ChatGPTSubscriptionError("unsupported_input");
        }
      }
      if ("role" in item && item.role === "system") return { ...item, role: "developer" as const };
      if ("type" in item && (item.type === "function_call" || item.type === "custom_tool_call")) {
        return { ...item, namespace: "nautilo" };
      }
      if ("type" in item && (item.type === "computer_call" || item.type === "computer_call_output")) {
        throw new ChatGPTSubscriptionError("unsupported_input");
      }
      return item;
    });
    let completed = false;
    try {
      const events = await this.completionWithRetry({ ...this.invocationParams(options), input, stream: true }, { signal: options.signal });
      for await (const event of events) {
        options.signal?.throwIfAborted();
        if (event.type === "response.failed") {
          throw new ChatGPTSubscriptionError(subscriptionFailure(event.response.error));
        }
        if (event.type === "response.incomplete") throw new ChatGPTSubscriptionError("response_incomplete");
        if (event.type === "error") throw new ChatGPTSubscriptionError(subscriptionFailure(event));
        if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
          const item = event.item;
          if ((item.type === "function_call" || item.type === "custom_tool_call")
            && (!("namespace" in item) || item.namespace !== "nautilo")) throw new ChatGPTSubscriptionError("unsupported_input");
        }
        if (event.type === "response.completed") completed = true;
        const chunk = convertResponsesDeltaToChatGenerationChunk(event);
        if (!chunk) continue;
        yield chunk;
        await runManager?.handleLLMNewToken(chunk.text || "", { prompt: options.promptIndex ?? 0, completion: 0 }, undefined, undefined, undefined, { chunk });
      }
      if (!completed) throw new ChatGPTSubscriptionError("stream_interrupted");
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ChatGPTSubscriptionError) throw error;
      throw new ChatGPTSubscriptionError(subscriptionFailure(error));
    }
  }
}

export function createChatGPTPlanModel(options: CreateModelOptions, accessToken: string): ChatModel {
  if (!options.modelId.startsWith("openai:") || !accessToken) throw new ChatGPTSubscriptionError("unsupported_input");
  const timeout = options.timeoutMs === null ? undefined : options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const fields = {
    model: options.modelId.slice("openai:".length), apiKey: accessToken,
    streaming: true, useResponsesApi: true, zdrEnabled: true, maxRetries: 0,
    ...(timeout === undefined ? {} : { timeout }),
    ...(options.callbacks ? { callbacks: options.callbacks } : {}),
    // The installed SDK does not classify all current reasoning models.
    ...(options.reasoningEffort ? { modelKwargs: { reasoning: { effort: options.reasoningEffort === "off" ? "none" : options.reasoningEffort } } } : {}),
    configuration: { baseURL: "https://api.openai.com/v1", fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, { ...init, redirect: "error" }) },
  };
  return new ChatOpenAI({ ...fields, responses: new ChatGPTPlanResponses(fields) }) as unknown as ChatModel;
}
