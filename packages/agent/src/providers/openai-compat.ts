import {
  ChatOpenAICompletions,
  ChatOpenAIResponses,
  convertMessagesToResponsesInput,
  convertResponsesMessageToAIMessage,
} from "@langchain/openai";

type InvocationOptions = Parameters<ChatOpenAICompletions["invocationParams"]>[0];
type InvocationExtra = Parameters<ChatOpenAICompletions["invocationParams"]>[1];

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

/** Preserve provider usage that LangChain's non-streaming Responses converter omits. */
export class OpenAIUsageResponses extends ChatOpenAIResponses {
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
      input: convertMessagesToResponsesInput({ messages, zdrEnabled: this.zdrEnabled ?? false, model: this.model }),
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
