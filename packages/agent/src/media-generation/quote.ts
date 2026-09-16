import { quoteEndpointFor, toVeniceQuotePricingRequest, type NormalizedMediaGenerationRequest, type VeniceQuotePricingRequest } from "./contracts";
import type { MediaGenerationFailure } from "./errors";

export type ExactVeniceQuote = Readonly<{
  quoteUsd: number;
  endpoint: "/video/quote" | "/audio/quote";
  pricingRequest: VeniceQuotePricingRequest;
}>;

export class VeniceQuoteParseError extends Error {
  readonly code = "VENICE_QUOTE_INVALID_RESPONSE" as const;
  constructor() {
    super("Venice returned an invalid price quote. No generation was started.");
    this.name = "VeniceQuoteParseError";
  }
}

/** Safe, classified quote failure. Raw provider bodies and credentials never cross this boundary. */
export class VeniceQuoteLifecycleError extends Error {
  readonly failure: MediaGenerationFailure;

  constructor(failure: MediaGenerationFailure) {
    super(failure.message);
    this.name = "VeniceQuoteLifecycleError";
    this.failure = failure;
  }
}

/** Parses only the documented price field. Unknown provider fields stay provider-private. */
export function parseVeniceQuoteResponse(body: unknown): number {
  if (!body || typeof body !== "object") throw new VeniceQuoteParseError();
  const quote = (body as Record<string, unknown>)["quote"];
  if (typeof quote !== "number" || !Number.isFinite(quote) || quote < 0) throw new VeniceQuoteParseError();
  return quote;
}

export function exactVeniceQuote(request: NormalizedMediaGenerationRequest, body: unknown): ExactVeniceQuote {
  return Object.freeze({
    quoteUsd: parseVeniceQuoteResponse(body),
    endpoint: quoteEndpointFor(request),
    pricingRequest: toVeniceQuotePricingRequest(request),
  });
}
