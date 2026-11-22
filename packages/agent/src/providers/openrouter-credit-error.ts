/** A credit refusal from the direct OpenRouter adapter; contains no upstream text or key identifiers. */
export class OpenRouterCreditError extends Error {
  readonly status = 402;
  readonly code = "OPENROUTER_CREDIT_LIMIT";
  constructor(readonly allowance?: Readonly<{ requested: number; affordable: number }>) {
    super("OpenRouter could not fund this request within the available credits or spending limits.");
    this.name = "OpenRouterCreditError";
  }
}

/** Only the direct OpenRouter adapter may confer this provider-specific refusal evidence. */
export function openRouterCreditError(error: unknown, outputObserved = false): OpenRouterCreditError | null {
  if (error instanceof OpenRouterCreditError) return outputObserved ? new OpenRouterCreditError() : error;
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 402) return null;
  const nested = "error" in error && error.error && typeof error.error === "object" ? error.error : undefined;
  const message = nested && "message" in nested && typeof nested.message === "string" ? nested.message
    : "message" in error && typeof error.message === "string" ? error.message : "";
  // OpenRouter documents this pre-service refusal. Do not guess an allowance
  // from other 402 messages, prices, account balances, or arbitrary numbers.
  const match = /This request requires more credits, or fewer max_tokens\. You requested up to (\d+) tokens, but can only afford (\d+)\.(?:\s|$)/.exec(message);
  if (match && !outputObserved) {
    const requested = Number(match[1]), affordable = Number(match[2]);
    if (Number.isSafeInteger(requested) && requested > 0 && Number.isSafeInteger(affordable)
      && affordable >= 0 && affordable < requested) return new OpenRouterCreditError({ requested, affordable });
  }
  return new OpenRouterCreditError();
}
