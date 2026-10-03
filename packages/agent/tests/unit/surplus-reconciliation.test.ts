import { describe, expect, test } from "bun:test";
import {
  fetchSurplusSettlement,
  readConfirmedSurplusSettlement,
  surplusCredentialFingerprint,
  surplusReceiptTelemetry,
} from "../../src/providers/surplus-reconciliation";

const binding = { requestId: "request-1", surplusModelId: "gpt-5.5", providerPin: "venice" };
const receipt = {
  request_id: binding.requestId,
  model: binding.surplusModelId,
  provider: binding.providerPin,
  buyer_cost_micro: 283,
  settlement_status: "accrued",
  settlement_type: "credit",
  settlement_error: null,
  confirmed_at: "2026-10-02T09:35:43.734Z",
};

describe("Surplus financial receipt boundary", () => {
  test("accepts confirmed charge and explicit zero, rejecting absent or unrelated evidence", () => {
    expect(readConfirmedSurplusSettlement(receipt, binding)).toBe(283);
    expect(readConfirmedSurplusSettlement({ ...receipt, buyer_cost_micro: 0 }, binding)).toBe(0);
    for (const change of [
      { request_id: "other" }, { provider: "openai" },
      { buyer_cost_micro: undefined }, { buyer_cost_micro: -1 }, { buyer_cost_micro: 1.5 },
      { settlement_status: "pending" }, { settlement_type: "onchain" },
      { settlement_error: "unconfirmed" }, { confirmed_at: null }, { confirmed_at: "garbage" },
    ]) expect(readConfirmedSurplusSettlement({ ...receipt, ...change }, binding)).toBeNull();
  });

  test("retains the actual charge when request detail canonicalizes a provider alias", () => {
    expect(readConfirmedSurplusSettlement(
      { ...receipt, model: "gpt-5.5" },
      { ...binding, surplusModelId: "openai-gpt-55" },
    )).toBe(283);
  });

  test("credential binding does not retain the secret and distinguishes rotations", () => {
    const fingerprint = surplusCredentialFingerprint("synthetic-key");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(surplusCredentialFingerprint(" synthetic-key "));
    expect(fingerprint).not.toBe(surplusCredentialFingerprint("rotated-key"));
  });

  test("stores protocol telemetry without arbitrary header strings", () => {
    expect(surplusReceiptTelemetry({
      servedBy: "marketplace", marketplaceAttempts: 1, truncated: false,
      adaptedParameters: "temperature, reasoning_effort",
    })).toEqual({
      surplusServedBy: "marketplace", surplusMarketplaceAttempts: 1,
      surplusTruncated: false, surplusAdaptedParameters: ["temperature", "reasoning_effort"],
    });
    expect(surplusReceiptTelemetry({
      servedBy: "raw upstream credential or content", truncated: true,
      adaptedParameters: "content with spaces or secrets",
    })).toEqual({ surplusTruncated: true });
  });

  test("only reads fixed-origin request detail and refuses redirects/refusals", async () => {
    const calls: Array<{ url: string; method?: string; redirect?: string }> = [];
    const fetchImpl = (async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(init?.redirect ? { redirect: init.redirect } : {}) });
      return Response.json(receipt);
    }) as typeof fetch;
    expect(await fetchSurplusSettlement({ binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl })).toBe(283);
    expect(calls).toEqual([{
      url: "https://api.surplusintelligence.ai/v1/requests/request-1", method: "GET", redirect: "error",
    }]);
    const forbidden = (async () => new Response("not a receipt", { status: 403 })) as unknown as typeof fetch;
    expect(await fetchSurplusSettlement({ binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl: forbidden })).toBeNull();
    expect(await fetchSurplusSettlement({ binding: { ...binding, requestId: "../keys" }, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("bounds and ignores malformed or oversized response bodies", async () => {
    for (const body of ["{", "x".repeat(65_537)]) {
      const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
      expect(await fetchSurplusSettlement({ binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl })).toBeNull();
    }
  });
});
