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
