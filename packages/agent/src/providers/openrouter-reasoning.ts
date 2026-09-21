import { ChatOpenAICompletions, convertCompletionsDeltaToBaseMessageChunk } from "@langchain/openai";

type DeltaInput = Parameters<typeof convertCompletionsDeltaToBaseMessageChunk>[0];

/**
 * OpenRouter uses reasoning/reasoning_details, which the installed LangChain
 * completions converter drops. Preserve these nonvisible delta fields so the
 * attempt watchdog can observe ongoing reasoning without publishing its text.
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
export class OpenRouterReasoningCompletions extends ChatOpenAICompletions {
  protected override _convertCompletionsDeltaToBaseMessageChunk(
    delta: DeltaInput["delta"],
    rawResponse: DeltaInput["rawResponse"],
    defaultRole?: DeltaInput["defaultRole"],
  ) {
    const chunk = super._convertCompletionsDeltaToBaseMessageChunk(delta, rawResponse, defaultRole);
    // OpenRouter can attach its cumulative usage receipt to a frame that also
    // has a choice. LangChain retains that receipt on this choice chunk and
    // then emits the same last-seen receipt in its synthetic final usage
    // chunk. Message concatenation adds numeric response metadata, which would
    // otherwise double cost and cache-write tokens (or sum every cumulative
    // receipt). Keep the SDK's canonical final usage chunk as the sole copy.
    delete chunk.response_metadata["usage"];
    const reasoning: unknown = delta["reasoning"];
    const details: unknown = delta["reasoning_details"];
    chunk.additional_kwargs = {
      ...chunk.additional_kwargs,
      ...(typeof reasoning === "string" ? { reasoning } : {}),
      ...(Array.isArray(details) ? { reasoning_details: details } : {}),
    };
    return chunk;
  }
}
