import { describe, expect, test } from "bun:test";
import { getQualifiedSurplusEmbeddingRoute } from "../../src/providers/surplus-embedding-route";
import {
  invokeSurplusEmbeddingAttempt,
  SurplusEmbeddingAttemptError,
} from "../../src/usage/surplus-embedding-attempt";

const route = getQualifiedSurplusEmbeddingRoute("venice:text-embedding-3-large", 1_536)!;

function response(options: {
  status?: number;
  cost?: number;
  requestId?: string;
  provider?: string;
  adapted?: string;
  data?: Array<{ index: number; embedding: number[] }>;
} = {}): Response {
  const headers = new Headers();
  headers.set("x-request-id", options.requestId ?? "embedding-request-1");
  headers.set("x-si-provider-family", options.provider ?? "mordiem");
  if (options.cost !== undefined) headers.set("x-si-buyer-cost-micro", String(options.cost));
  if (options.adapted !== undefined) headers.set("x-si-adapted-params", options.adapted);
  return Response.json({
    model: "text-embedding-3-large",
    data: options.data ?? [{ index: 0, embedding: [1, 2, 3] }],
    usage: { prompt_tokens: 4, total_tokens: 4 },
  }, { status: options.status ?? 200, headers });
}

function deps(events: string[], settlements: unknown[]) {
  return {
    mintAttemptId: () => "11111111-1111-4111-8111-111111111111",
    begin: async (input: unknown) => { events.push("begin"); expect(input).toMatchObject({
      model: "venice:text-embedding-3-large",
      provider: "venice",
      endpoint: "/v1/embeddings",
      fundingKind: "service",
      callType: "embedding",
      metadata: {
        surplusEmbeddingPolicy: "surplus-embedding-marketplace-v1",
        surplusEmbeddingReceiptModel: "venice-embed-1",
        surplusEmbeddingServingProviders: ["mordiem", "venice"],
      },
    }); },
    attach: async (input: unknown) => { events.push("attach"); expect(input).toMatchObject({
      providerRequestId: "embedding-request-1",
      servingProvider: "mordiem",
      endpoint: "/v1/embeddings",
    }); },
    settle: async (input: unknown) => { events.push("settle"); settlements.push(input); },
  };
}

describe("Surplus embedding durable attempt", () => {
  test("begins before one wire and persists an explicit zero-cost receipt", async () => {
    const events: string[] = [];
    const settlements: unknown[] = [];
    let requests = 0;
    const result = await invokeSurplusEmbeddingAttempt({
      route,
      apiKey: "surplus-key",
      texts: ["private memory"],
      assertStillAuthorized: () => { events.push("authorize"); },
      fetchImpl: (async (input, init) => {
        requests++;
        events.push("fetch");
        expect(input).toBe("https://api.surplusintelligence.ai/v1/embeddings");
        expect(init?.redirect).toBe("error");
        if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
        expect(JSON.parse(init.body)).toEqual({
          model: "text-embedding-3-large",
          input: ["private memory"],
          dimensions: 1_536,
        });
        return response({ cost: 0 });
      }) as typeof fetch,
      parseResponse: (value) => value,
    }, deps(events, settlements));
    expect(result).toMatchObject({ model: "text-embedding-3-large" });
    expect(requests).toBe(1);
    expect(events).toEqual(["begin", "authorize", "fetch", "attach", "settle"]);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0,
      inputTokens: 4,
      totalTokens: 4,
      servingProvider: "mordiem",
    });
  });

  test("accepts the qualified live response shape with the observed safe_mode adaptation", async () => {
    const vector = Array.from({ length: 1_536 }, (_, index) => index / 1_536);
    const result = await invokeSurplusEmbeddingAttempt({
      route,
      apiKey: "surplus-key",
      texts: ["first", "second"],
      assertStillAuthorized: () => {},
      fetchImpl: (async () => response({
        provider: "Mordiem",
        adapted: "safe_mode",
        cost: 0,
        data: [
          { index: 0, embedding: vector },
          { index: 1, embedding: [...vector] },
        ],
      })) as unknown as typeof fetch,
      parseResponse: (value) => {
        const fixture = value as {
          model: unknown;
          data: Array<{ index: number; embedding: number[] }>;
        };
        expect(fixture.model).toBe("text-embedding-3-large");
        expect(fixture.data.map((entry) => entry.index)).toEqual([0, 1]);
        expect(fixture.data.every((entry) => entry.embedding.length === 1_536)).toBe(true);
        return fixture.data.map((entry) => entry.embedding);
      },
    }, deps([], []));
    expect(result).toHaveLength(2);
  });

  test("leaves an identified receipt pending when the response omits cost", async () => {
    const settlements: unknown[] = [];
    await invokeSurplusEmbeddingAttempt({
      route, apiKey: "surplus-key", texts: ["x"], assertStillAuthorized: () => {},
      fetchImpl: (async () => response()) as unknown as typeof fetch,
      parseResponse: () => [1, 2, 3],
    }, deps([], settlements));
    expect(settlements[0]).toMatchObject({ costState: "pending", outcome: "succeeded" });
  });

  test("does not send a wire when durable begin or the current authorization fails", async () => {
    for (const failure of ["begin", "authorization"] as const) {
      let requests = 0;
      const settlements: unknown[] = [];
      const dependencies = deps([], settlements);
      if (failure === "begin") dependencies.begin = async () => { throw new Error("db unavailable"); };
      const error = await invokeSurplusEmbeddingAttempt({
        route, apiKey: "surplus-key", texts: ["x"],
        assertStillAuthorized: () => {
          if (failure === "authorization") throw new Error("policy changed");
        },
        fetchImpl: (async () => { requests++; return response(); }) as unknown as typeof fetch,
        parseResponse: () => [1, 2, 3],
      }, dependencies).catch((caught: unknown) => caught);
      expect(requests).toBe(0);
      if (failure === "begin") expect(error).toBeInstanceOf(SurplusEmbeddingAttemptError);
      else {
        expect(error).toMatchObject({ message: "policy changed" });
        expect(settlements).toHaveLength(1);
        expect(settlements[0]).toMatchObject({
          outcome: "failed",
          costState: "actual",
          actualCostUsd: 0,
          failureCode: "pre_wire_authorization_changed",
        });
        expect(settlements[0]).not.toHaveProperty("providerRequestId");
      }
    }
  });

  test("never repeats a paid wire when completed settlement fails", async () => {
    let requests = 0;
    let settlements = 0;
    const result = await invokeSurplusEmbeddingAttempt({
      route, apiKey: "surplus-key", texts: ["x"], assertStillAuthorized: () => {},
      fetchImpl: (async () => { requests++; return response({ cost: 2 }); }) as unknown as typeof fetch,
      parseResponse: () => "accepted",
    }, {
      ...deps([], []),
      settle: async () => { settlements++; throw new Error("write lost"); },
    });
    expect(result).toBe("accepted");
    expect(requests).toBe(1);
    expect(settlements).toBe(2);
  });

  test("surfaces one intermittent-supply failure and records its zero-cost receipt", async () => {
    let requests = 0;
    const settlements: unknown[] = [];
    const error = await invokeSurplusEmbeddingAttempt({
      route, apiKey: "surplus-key", texts: ["x"], assertStillAuthorized: () => {},
      fetchImpl: (async () => { requests++; return response({ status: 503, cost: 0 }); }) as unknown as typeof fetch,
      parseResponse: () => { throw new Error("must not parse"); },
    }, deps([], settlements)).catch((caught: unknown) => caught);
    expect(requests).toBe(1);
    expect(error).toMatchObject({
      name: "SurplusEmbeddingAttemptError",
      failureCode: "provider_unavailable",
      status: 503,
      retryable: true,
    });
    expect(settlements[0]).toMatchObject({
      outcome: "failed", costState: "actual", actualCostUsd: 0,
      failureCode: "provider_unavailable",
    });
  });

  test("keeps a documented zero-attempt routing trace out of financial receipt recovery", async () => {
    const events: string[] = [];
    const settlements: unknown[] = [];
    const traceId = "trace-no-healthy-1";
    const error = await invokeSurplusEmbeddingAttempt({
      route, apiKey: "surplus-key", texts: ["x"], assertStillAuthorized: () => {},
      fetchImpl: (async () => Response.json({
        error: { code: "no_healthy_sellers", message: "discarded" },
        request_id: traceId,
      }, {
        status: 503,
        headers: {
          "x-request-id": traceId,
          "x-si-marketplace-attempts": "0",
        },
      })) as unknown as typeof fetch,
      parseResponse: () => { throw new Error("must not parse"); },
    }, deps(events, settlements)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "SurplusEmbeddingAttemptError",
      failureCode: "provider_unavailable",
      vendorCode: "no_healthy_sellers",
    });
    expect(events).not.toContain("attach");
    expect(settlements[0]).toMatchObject({
      outcome: "failed",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "provider_unavailable",
      metadata: {
        surplusErrorCode: "no_healthy_sellers",
        surplusResponseStatus: 503,
        surplusTraceId: traceId,
        surplusMarketplaceAttempts: 0,
      },
    });
    expect(settlements[0]).not.toHaveProperty("providerRequestId");
  });

  test("fails closed on an unqualified response adaptation without replay", async () => {
    let requests = 0;
    let parsed = false;
    const settlements: unknown[] = [];
    const error = await invokeSurplusEmbeddingAttempt({
      route, apiKey: "surplus-key", texts: ["x"], assertStillAuthorized: () => {},
      fetchImpl: (async () => {
        requests++;
        return response({ adapted: "safe_mode,dimensions", cost: 0 });
      }) as unknown as typeof fetch,
      parseResponse: () => { parsed = true; },
    }, deps([], settlements)).catch((caught: unknown) => caught);
    expect(requests).toBe(1);
    expect(parsed).toBe(false);
    expect(error).toBeInstanceOf(SurplusEmbeddingAttemptError);
    expect(settlements[0]).toMatchObject({ outcome: "failed", costState: "actual" });
  });

  test("classifies cancellation and an uncertain transport failure without replay", async () => {
    for (const cancelled of [true, false]) {
      let requests = 0;
      const settlements: unknown[] = [];
      const controller = new AbortController();
      if (cancelled) controller.abort(new Error("cancelled by caller"));
      const error = await invokeSurplusEmbeddingAttempt({
        route,
        apiKey: "surplus-key",
        texts: ["x"],
        signal: controller.signal,
        assertStillAuthorized: () => {},
        fetchImpl: (async () => {
          requests++;
          throw new Error("connection lost");
        }) as unknown as typeof fetch,
        parseResponse: () => { throw new Error("must not parse"); },
      }, deps([], settlements)).catch((caught: unknown) => caught);
      expect(requests).toBe(cancelled ? 0 : 1);
      expect(error).toBeInstanceOf(Error);
      expect(settlements[0]).toMatchObject(cancelled
        ? { outcome: "cancelled", costState: "actual", actualCostUsd: 0,
            failureCode: "cancelled" }
        : { outcome: "unknown", costState: "unknown", failureCode: "outcome_unknown" });
    }
  });
});
