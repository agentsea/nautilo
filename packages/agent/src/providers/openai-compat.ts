import {
  ChatOpenAICompletions,
  ChatOpenAIResponses,
  convertMessagesToResponsesInput,
  convertResponsesMessageToAIMessage,
  convertResponsesDeltaToChatGenerationChunk,
} from "@langchain/openai";
import { AIMessage } from "@langchain/core/messages";

type InvocationOptions = Parameters<ChatOpenAICompletions["invocationParams"]>[0];
type InvocationExtra = Parameters<ChatOpenAICompletions["invocationParams"]>[1];

const TOOL_INVOCATION_IDENTITY_KEY = "nautilo_tool_invocations";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

/**
 * OpenAI owns returned Responses item IDs. Once admission replaces call_id with
 * a canonical execution ID, replaying the provider item ID would bind the item
 * back to its original call_id. Remove that opaque reference only from matching
 * serialized request items; admitted messages and checkpoints remain unchanged.
 */
function convertCanonicalResponsesInput(
  params: Parameters<typeof convertMessagesToResponsesInput>[0],
): ReturnType<typeof convertMessagesToResponsesInput> {
  const admittedIds = new Set(params.messages.flatMap((message) => {
    if (!AIMessage.isInstance(message)) return [];
    const identity = record(message.additional_kwargs[TOOL_INVOCATION_IDENTITY_KEY]);
    if (identity?.["version"] !== 1 || !Array.isArray(identity["calls"])) return [];
    return identity["calls"].flatMap((value) => {
      const id = record(value)?.["id"];
      return typeof id === "string" ? [id] : [];
    });
  }));
  const input = convertMessagesToResponsesInput(params);
  if (admittedIds.size === 0) return input;
  return input.map((value) => {
    if (!("type" in value)
      || (value.type !== "function_call" && value.type !== "custom_tool_call" && value.type !== "computer_call")
      || !("call_id" in value) || typeof value.call_id !== "string"
      || !admittedIds.has(value.call_id)) return value;
    const projected = { ...value };
    Reflect.deleteProperty(projected, "id");
    return projected;
  });
}

export function isDirectGpt6Model(modelId: string): boolean {
  return /^openai:gpt-(?:6-(?:astra|sol|luna)|6\.1-sol)$/.test(modelId);
}

/**
 * The installed LangChain release recognizes GPT-5 and o-series reasoning
 * models, but not GPT-6. OpenAI rejects `max_tokens` for GPT-6 and requires
 * `max_completion_tokens`; preserve Chat Completions while correcting that
 * one provider-wire classification at the shared adapter boundary.
 */
export class OpenAIGpt6Completions extends ChatOpenAICompletions {
  override invocationParams(options?: InvocationOptions, extra?: InvocationExtra) {
    const params = super.invocationParams(options, extra);
    if (/^gpt-6(?:[.-]|$)/i.test(this.model)) {
      if (typeof this.maxTokens === "number" && this.maxTokens !== -1) {
        params.max_completion_tokens = this.maxTokens;
      } else {
        delete params.max_completion_tokens;
      }
      delete params.max_tokens;
    }
    return params;
  }
}

/** Preserve usage and scoped request fields omitted by the installed Responses adapter. */
export class OpenAIUsageResponses extends ChatOpenAIResponses {
  override invocationParams(
    options?: Parameters<ChatOpenAIResponses["invocationParams"]>[0],
  ): ReturnType<ChatOpenAIResponses["invocationParams"]> {
    const params = super.invocationParams(options);
    // The installed serializer handles named choices but drops these standard
    // string choices. Keep the caller's tool policy on direct GPT-6 requests.
    if (isDirectGpt6Model(`openai:${this.model}`)
      && (options?.tool_choice === "auto" || options?.tool_choice === "none" || options?.tool_choice === "required")) {
      params.tool_choice = options.tool_choice;
    }
    return params;
  }

  override async *_streamResponseChunks(
    messages: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[0],
    options: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[1],
    runManager?: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[2],
  ) {
    const stream = await this.completionWithRetry({
      ...this.invocationParams(options),
      input: convertCanonicalResponsesInput({
        messages,
        zdrEnabled: this.zdrEnabled ?? false,
        model: this.model,
      }),
      stream: true,
    }, options);
    for await (const event of stream) {
      options.signal?.throwIfAborted();
      // The installed converter only retains terminal metadata for completed
      // events. Reuse that conversion for incomplete responses while preserving
      // their actual status and reason; never turn partial output into success.
      const chunk = convertResponsesDeltaToChatGenerationChunk(event.type === "response.incomplete"
        ? { ...event, type: "response.completed" } : event);
      if (chunk === null) continue;
      yield chunk;
      await runManager?.handleLLMNewToken(chunk.text || "", {
        prompt: options.promptIndex ?? 0, completion: 0,
      }, undefined, undefined, undefined, { chunk });
    }
    options.signal?.throwIfAborted();
  }

  override async _generate(
    messages: Parameters<ChatOpenAIResponses["_generate"]>[0],
    options: Parameters<ChatOpenAIResponses["_generate"]>[1],
    runManager?: Parameters<ChatOpenAIResponses["_generate"]>[2],
  ) {
    options.signal?.throwIfAborted();
    const params = this.invocationParams(options);
    // The streaming adapter already retains raw usage on response.completed.
    if (params.stream) return super._generate(messages, options, runManager);
    const response = await this.completionWithRetry({
      input: convertCanonicalResponsesInput({
        messages,
        zdrEnabled: this.zdrEnabled ?? false,
        model: this.model,
      }),
      ...params,
      stream: false,
    }, { signal: options.signal, ...options.options });
    const message = convertResponsesMessageToAIMessage(response);
    if (response.usage) message.response_metadata["usage"] = response.usage;
    return {
      generations: [{ text: response.output_text, message }],
      llmOutput: {
        id: response.id,
        ...(response.usage ? { tokenUsage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        } } : {}),
      },
    };
  }
}
