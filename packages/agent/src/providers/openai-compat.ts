import { ChatOpenAICompletions } from "@langchain/openai";

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
