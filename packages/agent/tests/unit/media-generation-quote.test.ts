import { describe, expect, test } from "bun:test";
import {
  VENICE_MEDIA_MODELS,
  VeniceQuoteParseError,
  exactVeniceQuote,
  normalizeMediaGenerationRequest,
  parseVeniceQuoteResponse,
} from "../../src/media-generation";

describe("Venice media quote contract", () => {
  test("parses the documented exact USD quote and keeps the provider payload private", () => {
    const request = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "ocean at dawn", durationSeconds: 10 });
    const quote = exactVeniceQuote(request, { quote: 0.42, ignored_provider_field: "https://signed.example/secret" });
    expect(quote).toEqual({ quoteUsd: 0.42, endpoint: "/video/quote", pricingRequest: { model: VENICE_MEDIA_MODELS.seedance, duration: "10s", aspect_ratio: "16:9", resolution: "720p", audio: true } });
    expect(JSON.stringify(quote)).not.toContain("signed.example");
    expect(JSON.stringify(quote)).not.toContain("ocean at dawn");
  });

  test("maps music models to their documented audio pricing inputs only", () => {
    const request = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxMusic, prompt: "gentle acoustic song with hopeful chorus", lyrics: "private chorus", forceInstrumental: false });
    expect(exactVeniceQuote(request, { quote: 0.18 })).toEqual({ quoteUsd: 0.18, endpoint: "/audio/quote", pricingRequest: { model: VENICE_MEDIA_MODELS.minimaxMusic } });
    const sonilo = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.sonilo, prompt: "private ambient pulse", durationSeconds: 90 });
    const soniloQuote = exactVeniceQuote(sonilo, { quote: 0.27 });
    expect(soniloQuote).toEqual({ quoteUsd: 0.27, endpoint: "/audio/quote", pricingRequest: { model: VENICE_MEDIA_MODELS.sonilo, duration_seconds: 90 } });
    expect(JSON.stringify(soniloQuote)).not.toContain("private ambient pulse");
  });

  test("rejects malformed, negative, non-finite, and string quotes without queueing", () => {
    for (const body of [null, {}, { quote: -0.01 }, { quote: "0.18" }, { quote: Number.NaN }, { quote: Infinity }]) {
      expect(() => parseVeniceQuoteResponse(body)).toThrow(VeniceQuoteParseError);
    }
  });
});
