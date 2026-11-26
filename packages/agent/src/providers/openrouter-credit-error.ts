/** A credit refusal from the direct OpenRouter adapter; contains no upstream text or key identifiers. */
export class OpenRouterCreditError extends Error {
  readonly status = 402;
  get code(): string { return this.inFlightBudget ? "OPENROUTER_IN_FLIGHT_BUDGET" : "OPENROUTER_CREDIT_LIMIT"; }
  constructor(
    readonly allowance?: Readonly<{ requested: number; affordable: number }>,
    readonly inFlightBudget?: Readonly<{ retryAfterMs?: number }>,
  ) {
    super("OpenRouter could not fund this request within the available credits or spending limits.");
    this.name = "OpenRouterCreditError";
  }
}

function retryAfterMilliseconds(error: object): number | undefined {
  const headers = "headers" in error ? error.headers : undefined;
  const raw = headers instanceof Headers ? headers.get("retry-after")
    : headers && typeof headers === "object" && "retry-after" in headers ? headers["retry-after"] : undefined;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      ? Math.max(0, Date.parse(value) - Date.now()) : NaN;
  // Reject values outside the JavaScript timer range: they otherwise become
  // an immediate timer, violating the provider's minimum wait.
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 2_147_483_647
    ? milliseconds : undefined;
}

/** Only the direct OpenRouter adapter may confer this provider-specific refusal evidence. */
export function openRouterCreditError(error: unknown, outputObserved = false): OpenRouterCreditError | null {
  if (error instanceof OpenRouterCreditError) return outputObserved ? new OpenRouterCreditError() : error;
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 402) return null;
  const nested = "error" in error && error.error && typeof error.error === "object" ? error.error : undefined;
  const metadata = nested && "metadata" in nested && nested.metadata && typeof nested.metadata === "object"
    ? nested.metadata : undefined;
  if (!outputObserved && metadata && "limit_source" in metadata && "reason" in metadata
    && metadata.limit_source === "openrouter_in_flight_budget" && metadata.reason === "in_flight_budget_exhausted") {
    const retryAfterMs = retryAfterMilliseconds(error);
    return new OpenRouterCreditError(undefined, retryAfterMs === undefined ? {} : { retryAfterMs });
  }
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
