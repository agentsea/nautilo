import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import { describe, expect, test } from "bun:test";
import {
  classifySurplusFailedAttempt,
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
    })).toMatchObject({
      outcome: "cancelled",
      failureCode: "cancelled",
      directFallback: false,
    });
  });

  test("keeps fallback eligibility independent from honest cost knowledge", () => {
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      receipt: { requestId: "request-pending", marketplaceAttempts: 0, truncated: false },
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
    })).toEqual({
      outcome: "failed",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "pre_service_refusal",
      directFallback: true,
    });
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
        qualifiedAt: "fixture",
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
    })).toMatchObject({ costState: "pending", directFallback: true });
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
        qualifiedAt: "fixture",
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
