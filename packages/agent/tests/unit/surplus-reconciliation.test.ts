import { describe, expect, test } from "bun:test";
import {
  fetchSurplusSettlement,
  readConfirmedSurplusSettlement,
  surplusCredentialFingerprint,
  surplusReceiptTelemetry,
} from "../../src/providers/surplus-reconciliation";
import {
  provenPreRoutingSurplusTrace,
  readBoundedSurplusErrorBody,
  safeSurplusErrorDiagnostics,
} from "../../src/providers/surplus-error";

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
  test("retains only bounded stable error diagnostics and proves routing traces narrowly", async () => {
    expect(safeSurplusErrorDiagnostics({ error: { code: " NO_HEALTHY_SELLERS " } }, 503)).toEqual({
      vendorCode: "no_healthy_sellers",
      responseStatus: 503,
    });
    expect(safeSurplusErrorDiagnostics({ code: "bad-code!", message: "private" }, 700)).toEqual({});
    expect(provenPreRoutingSurplusTrace({
      error: { code: "no_healthy_sellers" },
      responseStatus: 503,
      receipt: { requestId: "trace-1", marketplaceAttempts: 0, truncated: false },
    })).toEqual({ vendorCode: "no_healthy_sellers", responseStatus: 503, traceId: "trace-1" });
    expect(provenPreRoutingSurplusTrace({
      error: { code: "no_healthy_sellers" },
      responseStatus: 503,
      receipt: { requestId: "request-1", marketplaceAttempts: 1, truncated: false },
    })).toBeNull();
    for (const conflicting of [
      { truncated: true }, { adaptedParameters: "reasoning" }, { buyerCostMicro: 1 },
    ]) {
      expect(provenPreRoutingSurplusTrace({
        error: { code: "no_healthy_sellers" }, responseStatus: 503,
        receipt: { requestId: "trace-1", marketplaceAttempts: 0, truncated: false, ...conflicting },
      })).toBeNull();
    }

    expect(await readBoundedSurplusErrorBody(Response.json({
      error: { code: "no_sellers_for_model", message: "discarded" },
      request_id: "trace-body-1",
      extra: "discarded",
    }).body?.getReader())).toEqual({ vendorCode: "no_sellers_for_model", requestId: "trace-body-1" });
  });

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
    expect(await fetchSurplusSettlement({ binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl })).toEqual({
      status: "settled", costMicro: 283,
    });
    expect(calls).toEqual([{
      url: "https://api.surplusintelligence.ai/v1/requests/request-1", method: "GET", redirect: "error",
    }]);
    const forbidden = (async () => new Response("not a receipt", { status: 403 })) as unknown as typeof fetch;
    expect(await fetchSurplusSettlement({ binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl: forbidden })).toEqual({
      status: "blocked_repair", failureCode: "receipt_read_unauthorized",
    });
    expect(await fetchSurplusSettlement({ binding: { ...binding, requestId: "../keys" }, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl })).toEqual({
      status: "blocked_repair", failureCode: "receipt_request_rejected",
    });
    expect(calls).toHaveLength(1);
  });

  test("bounds and ignores malformed or oversized response bodies", async () => {
    for (const body of ["{", "x".repeat(65_537)]) {
      const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
      expect(await fetchSurplusSettlement({ binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl })).toEqual({
        status: "retryable", failureCode: "receipt_not_confirmed",
      });
    }
  });

  test("keeps undocumented request-detail absence retryable", async () => {
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await fetchSurplusSettlement({
      binding, apiKey: "synthetic-key", signal: new AbortController().signal, fetchImpl: notFound,
    })).toEqual({ status: "retryable", failureCode: "receipt_not_found" });
  });
});


test("explicitly unpinned media receipts bind exact request and model without claiming provider containment", () => {
  const media = { requestId: "image-request", surplusModelId: "venice-gpt-image-2", providerPin: null };
  const value = { ...receipt, request_id: media.requestId, model: media.surplusModelId, provider: "different-marketplace-processor" };
  expect(readConfirmedSurplusSettlement(value, media)).toBe(283);
  expect(readConfirmedSurplusSettlement({ ...value, request_id: "other-request" }, media)).toBeNull();
  expect(readConfirmedSurplusSettlement({ ...value, model: "other-model" }, media)).toBeNull();
  expect(readConfirmedSurplusSettlement({ ...value, provider: "" }, media)).toBeNull();
});

test("explicitly unpinned model receipts accept provider and model aliases for the exact request", () => {
  const unpinned = {
    requestId: "chat-request",
    surplusModelId: "openai/gpt-5.6-sol",
    providerPin: null,
    unpinnedModel: true as const,
  };
  const value = {
    ...receipt,
    request_id: unpinned.requestId,
    model: "canonical-gpt-5.6-sol-alias",
    provider: "actual-serving-provider",
  };
  expect(readConfirmedSurplusSettlement(value, unpinned)).toBe(283);
  expect(readConfirmedSurplusSettlement({ ...value, request_id: "other" }, unpinned)).toBeNull();
  expect(readConfirmedSurplusSettlement({ ...value, provider: "" }, unpinned)).toBeNull();
  expect(readConfirmedSurplusSettlement(value, { ...unpinned, providerPin: "openrouter" })).toBeNull();
});
