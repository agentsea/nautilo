import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import { describe, expect, spyOn, test } from "bun:test";
import * as db from "@nautilo/db";
import {
  classifySurplusFailedAttempt,
  invokeSurplusChatAttempt,
} from "../../src/providers/surplus-attempt";
import {
  createSurplusChatModel,
  isSafeSurplusDirectFallback,
  type SurplusWireReceipt,
} from "../../src/providers/surplus-transport";

const BASE_RECEIPT: SurplusWireReceipt = {
  marketplaceAttempts: 0,
  truncated: false,
};

const OPENAI_REASONING_ROUTE = {
  catalogModelId: "openai:gpt-6-sol",
  surplusModelId: "gpt-6-sol",
  providerPin: "openai" as const,
  supportsTools: true,
  supportsVision: true,
  supportsReasoning: true,
  maxContextTokens: 1_050_000,
  maxOutputTokens: 128_000,
};

describe("Surplus definitive refusal fallback", () => {
  test("accepts only documented pre-service status and code combinations", () => {
    expect(isSafeSurplusDirectFallback({}, 401, undefined, false)).toBe(true);
    expect(isSafeSurplusDirectFallback({}, 402, undefined, false)).toBe(true);
    expect(isSafeSurplusDirectFallback({ code: "invalid_api_key" }, 401, undefined, false)).toBe(true);
    expect(isSafeSurplusDirectFallback({ code: "insufficient_balance" }, 402, undefined, false)).toBe(true);
    expect(isSafeSurplusDirectFallback({ code: "no_sellers_for_model" }, 401, undefined, false)).toBe(false);
    expect(isSafeSurplusDirectFallback({ code: "invalid_api_key" }, 402, undefined, false)).toBe(false);

    for (const code of [
      "invalid_request",
      "minimum_discount_not_met",
      "model_does_not_support_images",
      "unresolvable_file_reference",
      "unsupported_provider",
    ]) {
      expect(isSafeSurplusDirectFallback({ error: { code } }, 400, undefined, false)).toBe(true);
    }
    expect(isSafeSurplusDirectFallback({}, 400, undefined, false)).toBe(false);
    expect(isSafeSurplusDirectFallback({ code: "invalid_request_error" }, 400, undefined, false)).toBe(false);

    expect(isSafeSurplusDirectFallback(
      { error: { code: "no_sellers_for_model" } },
      404,
      BASE_RECEIPT,
      false,
    )).toBe(true);
    expect(isSafeSurplusDirectFallback(
      { code: "no_sellers_for_model" },
      404,
      { truncated: false },
      false,
    )).toBe(false);
    expect(isSafeSurplusDirectFallback({}, 404, BASE_RECEIPT, false)).toBe(false);
    expect(isSafeSurplusDirectFallback({ code: "unsupported_provider" }, 404, BASE_RECEIPT, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(
      { code: "no_healthy_sellers" },
      503,
      BASE_RECEIPT,
      false,
    )).toBe(true);
    expect(isSafeSurplusDirectFallback(
      { code: "no_healthy_sellers" },
      503,
      { truncated: false },
      false,
    )).toBe(false);
    expect(isSafeSurplusDirectFallback({}, 503, BASE_RECEIPT, false)).toBe(false);
    expect(isSafeSurplusDirectFallback({ code: "no_sellers_for_model" }, 503, BASE_RECEIPT, false)).toBe(false);
    expect(isSafeSurplusDirectFallback({ code: "no_healthy_sellers" }, 500, BASE_RECEIPT, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(new Error("network timeout"), undefined, undefined, false)).toBe(false);
  });

  test("refuses replay after evidence of service, output, adaptation, or truncation", () => {
    const error = { code: "no_sellers_for_model" };
    expect(isSafeSurplusDirectFallback(error, 404, { ...BASE_RECEIPT, marketplaceAttempts: 1 }, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(error, 404, { ...BASE_RECEIPT, buyerCostMicro: 1 }, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(error, 404, BASE_RECEIPT, true)).toBe(false);
    expect(isSafeSurplusDirectFallback(error, 404, { ...BASE_RECEIPT, truncated: true }, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(error, 404, { ...BASE_RECEIPT, adaptedParameters: "reasoning" }, false)).toBe(false);
    expect(classifySurplusFailedAttempt({
      error,
      cancelled: true,
      responseStatus: 404,
      receipt: BASE_RECEIPT,
      deliveredOutput: false,
    })).toMatchObject({
      outcome: "cancelled",
      failureCode: "cancelled",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("connection lost"),
      cancelled: false,
      responseStatus: 500,
      receipt: { requestId: "request-visible", buyerCostMicro: 17, truncated: false },
      deliveredOutput: true,
    })).toMatchObject({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0.000017,
      directFallback: false,
    });
  });

  test("keeps fallback eligibility independent from honest cost knowledge", () => {
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      receipt: { requestId: "request-pending", marketplaceAttempts: 0, truncated: false },
      deliveredOutput: false,
    })).toEqual({
      outcome: "failed",
      costState: "pending",
      failureCode: "no_sellers_for_model",
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      receipt: BASE_RECEIPT,
      deliveredOutput: false,
    })).toEqual({
      outcome: "failed",
      costState: "unknown",
      failureCode: "no_sellers_for_model",
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: {},
      cancelled: false,
      responseStatus: 401,
      receipt: { requestId: "request-auth", truncated: false },
      deliveredOutput: false,
    })).toEqual({
      outcome: "failed",
      costState: "pending",
      failureCode: "pre_service_refusal",
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: {},
      cancelled: false,
      responseStatus: 402,
      receipt: { buyerCostMicro: 0, truncated: false },
      deliveredOutput: false,
    })).toEqual({
      outcome: "failed",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "pre_service_refusal",
      directFallback: true,
    });

    expect(classifySurplusFailedAttempt({
      error: { code: "no_healthy_sellers" },
      cancelled: false,
      responseStatus: 503,
      receipt: BASE_RECEIPT,
      deliveredOutput: false,
    })).toMatchObject({ outcome: "failed", directFallback: true });
    expect(classifySurplusFailedAttempt({
      error: { code: "no_healthy_sellers" },
      cancelled: false,
      responseStatus: 503,
      receipt: { ...BASE_RECEIPT, marketplaceAttempts: 1 },
      deliveredOutput: false,
    })).toMatchObject({ outcome: "unknown", directFallback: true });
    for (const responseStatus of [401, 402]) {
      expect(classifySurplusFailedAttempt({
        error: {},
        cancelled: false,
        responseStatus,
        receipt: BASE_RECEIPT,
        deliveredOutput: false,
      })).toMatchObject({ outcome: "failed", directFallback: true });
    }
  });

  test("recognizes the SDK error from a fake documented 404 without inventing zero cost", async () => {
    let receipt: SurplusWireReceipt | undefined;
    let status: number | undefined;
    const model = createSurplusChatModel({
      route: {
        catalogModelId: "openai:gpt-5.5",
        surplusModelId: "gpt-5.5",
        providerPin: "openai",
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        maxContextTokens: 100_000,
        maxOutputTokens: 8_000,
      },
      apiKey: "synthetic-key",
      maxOutputTokens: 32,
      onResponse: (next, nextStatus) => {
        receipt = next;
        status = nextStatus;
      },
      fetchImpl: (async () => new Response(JSON.stringify({
        error: {
          message: "No sellers for model",
          type: "invalid_request_error",
          code: "no_sellers_for_model",
        },
      }), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-http-404",
          "x-si-marketplace-attempts": "0",
        },
      })) as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await model.invoke([new HumanMessage("synthetic")]);
    } catch (error) {
      caught = error;
    }

    expect(status).toBe(404);
    expect(receipt).toEqual({
      requestId: "request-http-404",
      marketplaceAttempts: 0,
      truncated: false,
    });
    expect(isSafeSurplusDirectFallback(caught, status, receipt, false)).toBe(true);
    expect(classifySurplusFailedAttempt({
      error: caught,
      cancelled: false,
      responseStatus: status,
      receipt,
      deliveredOutput: false,
    })).toMatchObject({ costState: "pending", directFallback: true });
  });

  test("recognizes a fake documented 503 only with explicit zero marketplace attempts", async () => {
    for (const [attempts, expectedUnavailable] of [[0, true], [1, false]] as const) {
      let receipt: SurplusWireReceipt | undefined;
      let status: number | undefined;
      let fetches = 0;
      const model = createSurplusChatModel({
        route: {
          catalogModelId: "openrouter:minimax/minimax-m3",
          surplusModelId: "minimax/minimax-m3",
          providerPin: "openrouter",
          supportsTools: true,
          supportsVision: false,
          supportsReasoning: true,
          maxContextTokens: 204_800,
          maxOutputTokens: 131_072,
        },
        apiKey: "synthetic-key",
        maxOutputTokens: 32,
        onResponse: (next, nextStatus) => {
          receipt = next;
          status = nextStatus;
        },
        fetchImpl: (async () => {
          fetches++;
          return new Response(JSON.stringify({
            error: {
              message: "No healthy sellers",
              type: "service_unavailable",
              code: "no_healthy_sellers",
            },
          }), {
            status: 503,
            headers: {
              "content-type": "application/json",
              "x-request-id": `request-http-503-${attempts}`,
              "x-si-marketplace-attempts": String(attempts),
            },
          });
        }) as unknown as typeof fetch,
      });

      let caught: unknown;
      try {
        await model.invoke([new HumanMessage("synthetic")]);
      } catch (error) {
        caught = error;
      }

      expect(fetches).toBe(1);
      expect(status).toBe(503);
      const disposition = classifySurplusFailedAttempt({
        error: caught,
        cancelled: false,
        responseStatus: status,
        receipt,
        deliveredOutput: false,
      });
      expect(disposition.directFallback).toBe(true);
      expect(isSafeSurplusDirectFallback(caught, status, receipt, false)).toBe(expectedUnavailable);
    }
  });

  test("exposes model-supply recovery authority only for real zero-attempt 404/503 refusals", async () => {
    const beginSpy = spyOn(db, "beginSurplusLlmAttempt").mockResolvedValue(undefined);
    const attachSpy = spyOn(db, "attachSurplusRequestReceipt").mockResolvedValue(undefined);
    const settleSpy = spyOn(db, "settleSurplusLlmAttempt").mockResolvedValue(undefined);
    const fetchSpy = spyOn(globalThis, "fetch");
    const cases = [
      [404, "no_sellers_for_model", 0, true, true],
      [503, "no_healthy_sellers", 0, true, true],
      [503, "no_healthy_sellers", 1, false, false],
      [401, "invalid_api_key", 0, false, true],
      [402, "insufficient_balance", 0, false, true],
    ] as const;

    try {
      for (const [status, code, attempts, expectedUnavailable, returnsFallback] of cases) {
        let fetches = 0;
        fetchSpy.mockImplementation((async () => {
          fetches++;
          return new Response(JSON.stringify({
            error: { message: code, type: "invalid_request_error", code },
          }), {
            status,
            headers: {
              "content-type": "application/json",
              "x-request-id": `request-${status}-${attempts}`,
              "x-si-marketplace-attempts": String(attempts),
            },
          });
        }) as unknown as typeof fetch);
        const invocation = invokeSurplusChatAttempt({
          route: {
            catalogModelId: "openrouter:minimax/minimax-m3",
            surplusModelId: "minimax/minimax-m3",
            providerPin: "openrouter",
            supportsTools: true,
            supportsVision: false,
            supportsReasoning: true,
            maxContextTokens: 204_800,
            maxOutputTokens: 131_072,
          },
          apiKey: "synthetic-key",
          messages: [new HumanMessage("synthetic")],
          tools: [],
          config: { signal: new AbortController().signal },
          maxOutputTokens: 32,
          funding: { kind: "service", humanUserId: "user-1", providerRoute: "surplus" },
          hasDeliveredOutput: () => false,
          directFallbackPolicy: "pre_service_only",
          invokeModel: async (model, messages, config) =>
            await model.invoke(messages, config) as AIMessage,
        });

        if (!returnsFallback) {
          await Promise.resolve(expect(invocation).rejects.toThrow());
          expect(fetches).toBe(1);
          continue;
        }
        const result = await invocation;
        expect(fetches).toBe(1);
        expect(result).toMatchObject({ kind: "direct_fallback" });
        if (expectedUnavailable) {
          expect(result).toHaveProperty("modelUnavailableBeforeService", true);
        } else {
          expect(result).not.toHaveProperty("modelUnavailableBeforeService");
        }
      }
    } finally {
      fetchSpy.mockRestore();
      settleSpy.mockRestore();
      attachSpy.mockRestore();
      beginSpy.mockRestore();
    }
  });

  test("a failed attempt-ledger begin never grants model-supply recovery authority or sends a wire", async () => {
    const beginSpy = spyOn(db, "beginSurplusLlmAttempt")
      .mockRejectedValue(new Error("synthetic ledger unavailable"));
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("unexpected marketplace wire");
    }) as unknown as typeof fetch);

    try {
      const result = await invokeSurplusChatAttempt({
        route: OPENAI_REASONING_ROUTE,
        apiKey: "synthetic-key",
        messages: [new HumanMessage("synthetic")],
        tools: [],
        config: { signal: new AbortController().signal },
        maxOutputTokens: 32,
        funding: { kind: "service", humanUserId: "user-1", providerRoute: "surplus" },
        hasDeliveredOutput: () => false,
        directFallbackPolicy: "pre_service_only",
        invokeModel: async (model, messages, config) =>
          await model.invoke(messages, config) as AIMessage,
      });

      expect(result).toEqual({ kind: "direct_fallback" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      beginSpy.mockRestore();
    }
  });

  test("post-admission authorization and cancellation settle known-unsent without a Surplus wire", async () => {
    const abort = new AbortController();
    const errors = {
      policy: new Error("Soul Surplus policy changed"),
      key: new Error("Soul Surplus key changed"),
      rbac: Object.assign(new Error("Soul Surplus authorization changed"), { status: 403 }),
    } as const;
    const cancellation = new Error("Soul Surplus cancelled during admission");
    let mode: "policy" | "key" | "rbac" | "cancellation" = "policy";
    let policyEnabled = true;
    let credential = "synthetic-key";
    let authorized = true;
    const settlements: Array<Record<string, unknown>> = [];
    const beginSpy = spyOn(db, "beginSurplusLlmAttempt").mockImplementation(async () => {
      if (mode === "policy") policyEnabled = false;
      else if (mode === "key") credential = "replacement-key";
      else if (mode === "rbac") authorized = false;
      else abort.abort(cancellation);
    });
    const settleSpy = spyOn(db, "settleSurplusLlmAttempt").mockImplementation(async (input) => {
      settlements.push(input as unknown as Record<string, unknown>);
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("unexpected Surplus wire");
    }) as unknown as typeof fetch);
    let providerInvokes = 0;

    try {
      for (mode of ["policy", "key", "rbac", "cancellation"] as const) {
        policyEnabled = true;
        credential = "synthetic-key";
        authorized = true;
        const beforeSettlements = settlements.length;
        const signal = mode === "cancellation" ? abort.signal : new AbortController().signal;
        const expected = mode === "cancellation" ? cancellation : errors[mode];
        const thrown = await invokeSurplusChatAttempt({
          route: OPENAI_REASONING_ROUTE,
          apiKey: "synthetic-key",
          messages: [new HumanMessage("synthetic")],
          tools: [],
          config: { signal },
          maxOutputTokens: 32,
          funding: { kind: "service", humanUserId: "user-1", providerRoute: "surplus" },
          hasDeliveredOutput: () => false,
          directFallbackPolicy: "pre_service_only",
          assertStillAuthorized: () => {
            signal.throwIfAborted();
            if (!policyEnabled) throw errors.policy;
            if (credential !== "synthetic-key") throw errors.key;
            if (!authorized) throw errors.rbac;
          },
          invokeModel: async () => {
            providerInvokes++;
            throw new Error("must not dispatch");
          },
        }).then(() => null, (error: unknown) => error);

        expect(thrown).toBe(expected);
        if (mode === "rbac") expect(thrown).toMatchObject({ status: 403 });
        expect(settlements).toHaveLength(beforeSettlements + 1);
        expect(settlements.at(-1)).toMatchObject(mode === "cancellation"
          ? {
              outcome: "cancelled",
              costState: "actual",
              actualCostUsd: 0,
              failureCode: "cancelled",
            }
          : {
              outcome: "failed",
              costState: "actual",
              actualCostUsd: 0,
              failureCode: "authorization_changed",
            });
      }
      expect(providerInvokes).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(beginSpy).toHaveBeenCalledTimes(4);
    } finally {
      fetchSpy.mockRestore();
      settleSpy.mockRestore();
      beginSpy.mockRestore();
    }
  });
});

class CaptureLLMEnd extends BaseCallbackHandler {
  name = "capture_surplus_generic_terminal";
  readonly lc_prefer_streaming = true;
  output: LLMResult | undefined;

  override handleLLMEnd(output: LLMResult): void {
    this.output = output;
  }
}

describe("Surplus generic OpenAI-compatible stream projection", () => {
  test("sends exact nested reasoning intent for Responses-native OpenAI models", async () => {
    for (const [effort, expected] of [
      ["xhigh", "xhigh"],
      ["off", "none"],
    ] as const) {
      let requestBody: Record<string, unknown> | undefined;
      const model = createSurplusChatModel({
        route: OPENAI_REASONING_ROUTE,
        apiKey: "synthetic-key",
        maxOutputTokens: 32,
        reasoningEffort: effort,
        onResponse: () => {},
        fetchImpl: (async (request: string | URL | Request, init?: RequestInit) => {
          const rawBody = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
          requestBody = typeof rawBody === "string"
            ? JSON.parse(rawBody) as Record<string, unknown>
            : undefined;
          return new Response(
            `data: ${JSON.stringify({
              id: "synthetic",
              object: "chat.completion.chunk",
              model: "gpt-6-sol",
              created: 1,
              choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }) as typeof fetch,
      });

      expect((await model.invoke([new HumanMessage("synthetic")]) as AIMessage).content).toBe("OK");
      expect(requestBody?.["reasoning"]).toEqual({ effort: expected });
      expect(requestBody).not.toHaveProperty("reasoning_effort");
    }
  });

  test("projects terminal metadata through callback-preferred streaming", async () => {
    const frames = [
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        model: "gpt-5.5",
        created: 1,
        choices: [{
          index: 0,
          delta: { role: "assistant", reasoning: "synthetic progress", content: "OK" },
          finish_reason: "stop",
        }],
      },
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        model: "gpt-5.5",
        created: 1,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    const model = createSurplusChatModel({
      route: {
        catalogModelId: "openai:gpt-5.5",
        surplusModelId: "gpt-5.5",
        providerPin: "openai",
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        maxContextTokens: 100_000,
        maxOutputTokens: 8_000,
      },
      apiKey: "synthetic-key",
      maxOutputTokens: 32,
      onResponse: () => {},
      fetchImpl: (async () => new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch,
    });
    const capture = new CaptureLLMEnd();
    const response = await model.invoke(
      [new HumanMessage("synthetic")],
      { callbacks: [capture] },
    ) as AIMessage;
    const generation = capture.output?.generations[0]?.[0] as ChatGeneration | undefined;

    expect(response.content).toBe("OK");
    expect(response.additional_kwargs["reasoning"]).toBe("synthetic progress");
    expect(generation?.generationInfo?.["finish_reason"]).toBe("stop");
    expect(generation?.message.response_metadata["finish_reason"]).toBe("stop");
    expect(response.response_metadata["finish_reason"]).toBe("stop");
  });
});
