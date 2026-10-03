import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  createSurplusChatModel,
  createSurplusObservedFetch,
  isSafeSurplusDirectFallback,
  readSurplusWireReceipt,
} from "../../src/providers/surplus-transport";
import {
  resolveQualifiedSurplusChatRoute,
  resolveSurplusChatServingAvailability,
} from "../../src/providers/surplus-route";
import {
  assertCompleteSurplusResponse,
  assertSuccessfulSurplusProviderReceipt,
  canUseQualifiedSurplusChatRoute,
  classifySurplusFailedAttempt,
  readSurplusResponseUsage,
  SurplusAdaptedParametersError,
  SurplusIncompleteResponseError,
  SurplusProviderRouteMismatchError,
} from "../../src/providers/surplus-attempt";
import { createManageConnectedWebOperationTool } from "../../src/tools/connected-web-accounts/manage-connected-web-operation";

const VENICE_ROUTE = {
  catalogModelId: "venice:openai-gpt-55",
  surplusModelId: "gpt-5.5",
  providerPin: "venice" as const,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  maxContextTokens: 100_000,
  maxOutputTokens: 8_000,
  qualifiedAt: "2026-10-01",
};

const QUALIFIED_OPENROUTER_ROUTE = {
  catalogModelId: "openrouter:openai/gpt-5.6-sol",
  surplusModelId: "gpt-5.6-sol",
  providerPin: "openrouter" as const,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: true,
  maxContextTokens: 1_050_000,
  maxOutputTokens: 128_000,
  qualifiedAt: "2026-10-03",
};

describe("Surplus wire boundary", () => {
  test("retains real zero cost and omits absent cost", () => {
    const withZero = readSurplusWireReceipt(new Headers({
      "x-request-id": "request-1",
      "x-si-buyer-cost-micro": "0",
      "x-si-marketplace-attempts": "0",
      "x-si-provider-family": "venice",
      "x-si-truncated": "1",
    }));
    expect(withZero).toEqual({
      requestId: "request-1",
      buyerCostMicro: 0,
      marketplaceAttempts: 0,
      providerFamily: "venice",
      truncated: true,
    });
    expect(readSurplusWireReceipt(new Headers()).buyerCostMicro).toBeUndefined();
    expect(readSurplusWireReceipt(new Headers({ "x-si-buyer-cost-micro": "NaN" })).buyerCostMicro).toBeUndefined();
    expect(readSurplusWireReceipt(new Headers({ "x-si-truncated": "unknown" })).truncated).toBe(true);
  });

  test("only calls the fixed HTTPS chat endpoint and refuses redirects", async () => {
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      seen.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) });
      return new Response("{}", { headers: { "x-request-id": "request-2" } });
    }) as typeof fetch;
    const receipts: string[] = [];
    const observed = createSurplusObservedFetch((receipt) => {
      if (receipt.requestId) receipts.push(receipt.requestId);
    }, fakeFetch);
    await observed("https://api.surplusintelligence.ai/v1/chat/completions");
    expect(seen).toEqual([{
      url: "https://api.surplusintelligence.ai/v1/chat/completions",
      redirect: "error",
    }]);
    expect(receipts).toEqual(["request-2"]);
    expect(observed("https://other.example/v1/chat/completions")).rejects.toThrow("outside the qualified chat endpoint");
    expect(observed("https://api.surplusintelligence.ai/v1/images/generations")).rejects.toThrow("outside the qualified chat endpoint");
    expect(seen).toHaveLength(1);
  });

  test("cancels an unread response while preserving a receipt rejection", async () => {
    const rejection = new Error("receipt rejected");
    let fetchCalls = 0;
    let cancelCalls = 0;
    let bodyReads = 0;
    const response = {
      status: 200,
      headers: new Headers({ "x-request-id": "request-rejected" }),
      body: {
        cancel: async () => {
          cancelCalls += 1;
          throw new Error("cancel failed");
        },
        getReader: () => {
          bodyReads += 1;
          throw new Error("body must remain unread");
        },
      },
      text: async () => {
        bodyReads += 1;
        return "must remain unread";
      },
      json: async () => {
        bodyReads += 1;
        return { content: "must remain unread" };
      },
      arrayBuffer: async () => {
        bodyReads += 1;
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
    const observed = createSurplusObservedFetch(
      () => { throw rejection; },
      (async () => {
        fetchCalls += 1;
        return response;
      }) as unknown as typeof fetch,
    );

    let caught: unknown;
    try {
      await observed("https://api.surplusintelligence.ai/v1/chat/completions");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(rejection);
    expect(fetchCalls).toBe(1);
    expect(cancelCalls).toBe(1);
    expect(bodyReads).toBe(0);
  });

  test("same-model direct fallback needs an unserved zero-cost refusal", () => {
    const refusal = { code: "no_sellers_for_model" };
    const receipt = { marketplaceAttempts: 0, buyerCostMicro: 0, truncated: false };
    expect(isSafeSurplusDirectFallback(refusal, 404, receipt, false)).toBe(true);
    expect(isSafeSurplusDirectFallback(refusal, 404, receipt, true)).toBe(false);
    expect(isSafeSurplusDirectFallback(refusal, 404, { ...receipt, marketplaceAttempts: 1 }, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(refusal, 404, { marketplaceAttempts: 0, truncated: false }, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(refusal, 503, receipt, false)).toBe(false);
    expect(isSafeSurplusDirectFallback({ code: "other" }, 404, receipt, false)).toBe(false);
  });

  test("refuses an output budget above the qualified ceiling instead of clipping it", () => {
    expect(() => createSurplusChatModel({
      route: VENICE_ROUTE,
      apiKey: "test-key",
      maxOutputTokens: VENICE_ROUTE.maxOutputTokens + 1,
      onResponse: () => {},
    })).toThrow("exceeds the qualified route limit");
  });

  test("reuses the canonical Venice object-root tool normalization for Venice pins", () => {
    const model = createSurplusChatModel({
      route: VENICE_ROUTE,
      apiKey: "test-key",
      maxOutputTokens: 100,
      onResponse: () => {},
    });
    const bound = model.bindTools!([createManageConnectedWebOperationTool()]);
    const tools = (bound as unknown as {
      defaultOptions?: { tools?: Array<{ function?: { parameters?: Record<string, unknown> } }> };
    }).defaultOptions?.tools;
    expect(tools).toHaveLength(1);
    expect(tools?.[0]?.function?.parameters?.["type"]).toBe("object");
    expect(tools?.[0]?.function?.parameters).not.toHaveProperty("anyOf");
  });

  test("Venice SDK request preserves safety options and assembles a roleless streamed answer", async () => {
    const chunks = [
      {
        id: "chatcmpl-surplus-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [{ index: 0, delta: { content: "O" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-surplus-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [{
          index: 0,
          delta: {
            content: "K",
            tool_calls: [{
              index: 0,
              id: "call-status",
              type: "function",
              function: { name: "status", arguments: "{}" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-surplus-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      {
        id: "chatcmpl-surplus-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 17,
          total_tokens: 28,
          completion_tokens_details: { reasoning_tokens: 10 },
          buyer_cost_micro: 283,
        },
      },
    ];
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (request: string | URL | Request, init?: RequestInit) => {
      const rawBody = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
      requestBody = typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "request-stream",
          "x-si-provider-family": "Venice",
        },
      });
    }) as typeof fetch;
    const receipts: string[] = [];
    const model = createSurplusChatModel({
      route: VENICE_ROUTE,
      apiKey: "test-key",
      maxOutputTokens: 100,
      onResponse: (receipt) => {
        if (receipt.requestId) receipts.push(receipt.requestId);
      },
      fetchImpl,
    });

    const response = await model.invoke([new HumanMessage("Reply OK")]) as AIMessage;

    expect(AIMessage.isInstance(response)).toBe(true);
    expect(response.content).toBe("OK");
    expect(response.tool_calls).toEqual([{
      id: "call-status",
      name: "status",
      args: {},
      type: "tool_call",
    }]);
    expect(response.response_metadata["finish_reason"]).toBe("tool_calls");
    expect(requestBody?.["stream"]).toBe(true);
    expect(requestBody?.["stream_options"]).toEqual({ include_usage: true });
    expect(requestBody?.["max_completion_tokens"]).toBe(100);
    expect(requestBody?.["venice_parameters"]).toEqual({
      include_venice_system_prompt: false,
    });
    expect(receipts).toEqual(["request-stream"]);
    expect(readSurplusResponseUsage(response)).toEqual({
      inputTokens: 11,
      outputTokens: 17,
      totalTokens: 28,
      reasoningTokens: 10,
      buyerCostMicro: 283,
    });
  });

  test("non-Venice SDK requests omit Venice-only options", async () => {
    const openAIRoute = {
      ...VENICE_ROUTE,
      catalogModelId: "openai:gpt-5.5",
      providerPin: "openai" as const,
    };
    let requestBody: Record<string, unknown> | undefined;
    const model = createSurplusChatModel({
      route: openAIRoute,
      apiKey: "test-key",
      maxOutputTokens: 100,
      onResponse: () => {},
      fetchImpl: (async (request: string | URL | Request, init?: RequestInit) => {
        const rawBody = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
        requestBody = typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
        const chunk = {
          id: "chatcmpl-surplus-openai",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.5",
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "request-openai",
            "x-si-provider-family": "openai",
          },
        });
      }) as typeof fetch,
    });

    const response = await model.invoke([new HumanMessage("Reply OK")]) as AIMessage;

    expect(response.content).toBe("OK");
    expect(requestBody?.["provider"]).toBe("openai");
    expect(requestBody).not.toHaveProperty("venice_parameters");
  });

  test("OpenRouter repeated terminal usage preserves one finish signal and actual charge", async () => {
    const route = QUALIFIED_OPENROUTER_ROUTE;
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning: "synthetic progress" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-probe", type: "function", function: { name: "record_probe", arguments: '{"value":"ok"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls" }] },
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 72, completion_tokens: 18, total_tokens: 90, buyer_cost_micro: 162, cost: 0.000648 } },
    ];
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Missing SDK request body");
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
      `${frames.map((frame) => `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: route.surplusModelId, created: 1, ...frame })}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    }) as unknown as typeof fetch;
    const model = createSurplusChatModel({ route, apiKey: "test-key", maxOutputTokens: 256, reasoningEffort: "medium", reasoningOutput: true, openrouterSessionId: "22222222-2222-4222-8222-222222222222", onResponse: () => {}, fetchImpl });
    const response = await model.invoke([new HumanMessage("Synthetic tool test")]) as AIMessage;

    expect(requestBody?.["max_tokens"]).toBe(256);
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(requestBody?.["reasoning"]).toEqual({ effort: "medium", exclude: false });
    expect(requestBody?.["session_id"]).toBe("22222222-2222-4222-8222-222222222222");
    expect(response.tool_calls).toEqual([{ id: "call-probe", name: "record_probe", args: { value: "ok" }, type: "tool_call" }]);
    expect(response.additional_kwargs["reasoning"]).toBe("synthetic progress");
    expect(response.response_metadata["finish_reason"]).toBe("tool_calls");
    expect(response.response_metadata["model_name"]).toBe("gpt-5.6-sol");
    expect(readSurplusResponseUsage(response)).toMatchObject({ inputTokens: 72, outputTokens: 18, totalTokens: 90, buyerCostMicro: 162 });
    expect(() => assertCompleteSurplusResponse({ truncated: false }, response)).not.toThrow();
  });

  test("OpenRouter conflicting terminal signals retain actual cost without permitting replay", async () => {
    let requests = 0;
    const route = QUALIFIED_OPENROUTER_ROUTE;
    const fetchImpl = (async () => {
      requests += 1;
      const frames = ["tool_calls", "stop"].map((finishReason, index) => ({ id: "synthetic", object: "chat.completion.chunk", model: route.surplusModelId, created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: finishReason }], ...(index === 1 ? { usage: { prompt_tokens: 72, completion_tokens: 18, total_tokens: 90, buyer_cost_micro: 162 } } : {}) }));
      return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const model = createSurplusChatModel({ route, apiKey: "test-key", maxOutputTokens: 256, onResponse: () => {}, fetchImpl });
    const response = await model.invoke([new HumanMessage("Synthetic test")]) as AIMessage;
    const receipt = { providerFamily: "openrouter", marketplaceAttempts: 1, truncated: false };
    expect(response.response_metadata["finish_reason"]).toBe("tool_callsstop");
    expect(() => assertCompleteSurplusResponse(receipt, response)).toThrow(SurplusIncompleteResponseError);
    expect(classifySurplusFailedAttempt({
      error: new SurplusIncompleteResponseError(),
      cancelled: false,
      responseStatus: 200,
      receipt,
      terminalUsage: readSurplusResponseUsage(response),
    })).toMatchObject({ outcome: "interrupted", costState: "actual", actualCostUsd: 0.000162, directFallback: false });
    expect(requests).toBe(1);
  });

  test("successful receipts must confirm the exact qualified provider family", () => {
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      { providerFamily: "Venice", truncated: false },
      200,
    )).not.toThrow();
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      { providerFamily: "openai", truncated: false },
      200,
    )).toThrow(SurplusProviderRouteMismatchError);
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      { truncated: false },
      200,
    )).toThrow(SurplusProviderRouteMismatchError);
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      {
        providerFamily: "Venice",
        adaptedParameters: "max_completion_tokens",
        truncated: false,
      },
      200,
    )).toThrow(SurplusAdaptedParametersError);
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      { truncated: false },
      404,
    )).not.toThrow();
  });

  test("rejects a successful adapted response before the SDK can assemble its output", async () => {
    const chunk = {
      id: "chatcmpl-surplus-adapted",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-5.5",
      choices: [{ index: 0, delta: { role: "assistant", content: "must not escape" }, finish_reason: "stop" }],
    };
    let observedReceipt: Parameters<typeof assertSuccessfulSurplusProviderReceipt>[1] | undefined;
    const model = createSurplusChatModel({
      route: VENICE_ROUTE,
      apiKey: "test-key",
      maxOutputTokens: 100,
      onResponse: (receipt, status) => {
        observedReceipt = receipt;
        assertSuccessfulSurplusProviderReceipt(VENICE_ROUTE, receipt, status);
      },
      fetchImpl: (async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "request-adapted",
          "x-si-provider-family": "Venice",
          "x-si-adapted-params": "max_completion_tokens",
        },
      })) as unknown as typeof fetch,
    });

    let invokeError: unknown;
    try {
      await model.invoke([new HumanMessage("Reply")]);
    } catch (error) {
      invokeError = error;
    }

    expect(invokeError).toBeInstanceOf(Error);
    expect(observedReceipt).toMatchObject({
      requestId: "request-adapted",
      adaptedParameters: "max_completion_tokens",
    });
  });

  test("deadline-truncated responses cannot become successful answers", () => {
    expect(() => assertCompleteSurplusResponse({
      requestId: "request-truncated",
      providerFamily: "venice",
      truncated: true,
    }, new AIMessage({ content: "partial", response_metadata: { finish_reason: "stop" } })))
      .toThrow(SurplusIncompleteResponseError);
    expect(() => assertCompleteSurplusResponse({
      requestId: "request-complete",
      providerFamily: "venice",
      truncated: false,
    }, new AIMessage({ content: "done", response_metadata: { finish_reason: "stop" } }))).not.toThrow();
    for (const finishReason of ["tool_calls", "length"] as const) {
      expect(() => assertCompleteSurplusResponse(
        { requestId: `request-${finishReason}`, providerFamily: "venice", truncated: false },
        new AIMessage({ content: "done", response_metadata: { finish_reason: finishReason } }),
      )).not.toThrow();
    }
  });

  test("SDK stream without terminal completion metadata is interrupted and cannot replay", async () => {
    const chunks = [
      {
        id: "chatcmpl-surplus-incomplete",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-surplus-incomplete",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          buyer_cost_micro: 283,
        },
      },
    ];
    let receipt: Parameters<typeof assertCompleteSurplusResponse>[0];
    const model = createSurplusChatModel({
      route: VENICE_ROUTE,
      apiKey: "test-key",
      maxOutputTokens: 100,
      onResponse: (next) => { receipt = next; },
      fetchImpl: (async (_request: string | URL | Request, _init?: RequestInit) => new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "request-incomplete",
            "x-si-provider-family": "Venice",
          },
        },
      )) as typeof fetch,
    });

    const response = await model.invoke([new HumanMessage("Reply completely")]) as AIMessage;
    let completionError: unknown;
    try {
      assertCompleteSurplusResponse(receipt, response);
    } catch (error) {
      completionError = error;
    }

    expect(response.content).toBe("partial");
    expect(response.response_metadata["finish_reason"] ?? null).toBeNull();
    expect(completionError).toBeInstanceOf(SurplusIncompleteResponseError);
    expect(classifySurplusFailedAttempt({
      error: completionError,
      cancelled: false,
      responseStatus: 200,
      receipt,
      terminalUsage: readSurplusResponseUsage(response),
    })).toEqual({
      outcome: "interrupted",
      costState: "actual",
      actualCostUsd: 0.000283,
      failureCode: "incomplete_response",
      directFallback: false,
    });
  });

  test("failure classification preserves known header cost and fences truncation and route mismatch", () => {
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      receipt: {
        requestId: "request-truncated",
        providerFamily: "venice",
        buyerCostMicro: 268,
        truncated: true,
      },
    })).toEqual({
      outcome: "interrupted",
      costState: "actual",
      actualCostUsd: 0.000268,
      failureCode: "truncated_response",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      receipt: { requestId: "request-truncated", providerFamily: "venice", truncated: true },
    })).toEqual({
      outcome: "interrupted",
      costState: "pending",
      failureCode: "truncated_response",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      receipt: { requestId: "request-truncated", providerFamily: "venice", truncated: true },
      terminalUsage: {
        inputTokens: 11,
        outputTokens: 17,
        totalTokens: 28,
        reasoningTokens: 10,
        buyerCostMicro: 283,
      },
    })).toEqual({
      outcome: "interrupted",
      costState: "actual",
      actualCostUsd: 0.000283,
      failureCode: "truncated_response",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      receipt: { requestId: "request-truncated-zero", providerFamily: "venice", truncated: true },
      terminalUsage: { buyerCostMicro: 0 },
    })).toEqual({
      outcome: "interrupted",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "truncated_response",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: new SurplusProviderRouteMismatchError(),
      cancelled: false,
      responseStatus: 200,
      receipt: { buyerCostMicro: 0, providerFamily: "openai", truncated: false },
    })).toEqual({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "provider_route_mismatch",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      receipt: { marketplaceAttempts: 0, buyerCostMicro: 0, truncated: false },
    })).toEqual({
      outcome: "failed",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "no_sellers_for_model",
      directFallback: true,
    });
  });

  test("adapted responses preserve charge state and can never replay", () => {
    expect(classifySurplusFailedAttempt({
      error: new SurplusAdaptedParametersError(),
      cancelled: false,
      responseStatus: 200,
      receipt: {
        requestId: "request-adapted-cost",
        providerFamily: "venice",
        adaptedParameters: "max_completion_tokens",
        buyerCostMicro: 268,
        truncated: false,
      },
    })).toEqual({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0.000268,
      failureCode: "adapted_parameters",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: new SurplusAdaptedParametersError(),
      cancelled: false,
      responseStatus: 200,
      receipt: {
        requestId: "request-adapted-pending",
        providerFamily: "venice",
        adaptedParameters: "max_completion_tokens",
        truncated: false,
      },
    })).toEqual({
      outcome: "unknown",
      costState: "pending",
      failureCode: "adapted_parameters",
      directFallback: false,
    });
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      receipt: {
        requestId: "request-adapted-contradictory",
        marketplaceAttempts: 0,
        adaptedParameters: "max_completion_tokens",
        buyerCostMicro: 0,
        truncated: false,
      },
    })).toEqual({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "adapted_parameters",
      directFallback: false,
    });
  });
});

describe("qualified Surplus route selection", () => {
  test("releases only the exact signed OpenRouter GPT-5.6 Sol route", () => {
    expect(resolveQualifiedSurplusChatRoute(QUALIFIED_OPENROUTER_ROUTE.catalogModelId))
      .toEqual(QUALIFIED_OPENROUTER_ROUTE);
    expect(resolveQualifiedSurplusChatRoute("venice:openai-gpt-55")).toBeNull();
    expect(resolveQualifiedSurplusChatRoute("openrouter:openai/gpt-5.6-terra")).toBeNull();
    expect(resolveQualifiedSurplusChatRoute("openai:gpt-5.6-sol")).toBeNull();
  });

  test("requires signed chat membership and an exact provider pin", () => {
    const candidate = {
      catalogModelId: "venice:openai-gpt-55",
      surplusModelId: "gpt-5.5",
      providerPin: "venice" as const,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 8_000,
      qualifiedAt: "2026-10-01",
    };
    expect(resolveQualifiedSurplusChatRoute(candidate.catalogModelId, [candidate])).toEqual(candidate);
    expect(resolveQualifiedSurplusChatRoute(candidate.catalogModelId, [{ ...candidate, providerPin: "openrouter" }])).toBeNull();
    expect(resolveQualifiedSurplusChatRoute("openai:not-signed", [{ ...candidate, catalogModelId: "openai:not-signed", providerPin: "openai" }])).toBeNull();
  });

  test("projects qualification, policy, credentials, and funding without widening the release list", () => {
    const routes = [VENICE_ROUTE];
    expect(resolveSurplusChatServingAvailability({
      policyEnabled: true, keyConfigured: true,
    })).toEqual({ status: "available", route: QUALIFIED_OPENROUTER_ROUTE });
    expect(resolveSurplusChatServingAvailability({
      policyEnabled: false, keyConfigured: true,
    })).toEqual({ status: "qualified-unavailable", route: QUALIFIED_OPENROUTER_ROUTE });
    expect(resolveSurplusChatServingAvailability({
      policyEnabled: true, keyConfigured: false,
    })).toEqual({ status: "qualified-unavailable", route: QUALIFIED_OPENROUTER_ROUTE });
    expect(resolveSurplusChatServingAvailability({
      catalogModelId: VENICE_ROUTE.catalogModelId,
      policyEnabled: false, keyConfigured: true, routes,
    }).status).toBe("qualified-unavailable");
    expect(resolveSurplusChatServingAvailability({
      catalogModelId: VENICE_ROUTE.catalogModelId,
      policyEnabled: true, keyConfigured: false, routes,
    }).status).toBe("qualified-unavailable");
    expect(resolveSurplusChatServingAvailability({
      catalogModelId: VENICE_ROUTE.catalogModelId,
      policyEnabled: true, keyConfigured: true, fundingKind: "personal", routes,
    }).status).toBe("qualified-unavailable");
    expect(resolveSurplusChatServingAvailability({
      catalogModelId: VENICE_ROUTE.catalogModelId,
      policyEnabled: true, keyConfigured: true, fundingKind: "server", routes,
    })).toEqual({ status: "available", route: VENICE_ROUTE });
    expect(resolveSurplusChatServingAvailability({
      catalogModelId: "openai:not-signed",
      policyEnabled: true, keyConfigured: true, routes,
    })).toEqual({ status: "not-qualified", route: null });
    expect(resolveSurplusChatServingAvailability({
      catalogModelId: VENICE_ROUTE.catalogModelId,
      policyEnabled: true, keyConfigured: true,
      routes: [{ ...VENICE_ROUTE, maxOutputTokens: Number.MAX_SAFE_INTEGER }],
    })).toEqual({ status: "not-qualified", route: null });
    for (const invalidLimit of [Number.NaN, 1.5]) {
      expect(resolveSurplusChatServingAvailability({
        catalogModelId: VENICE_ROUTE.catalogModelId,
        policyEnabled: true, keyConfigured: true,
        routes: [{ ...VENICE_ROUTE, maxOutputTokens: invalidLimit }],
      })).toEqual({ status: "not-qualified", route: null });
    }
  });

  test("server-only admission cannot expand unproven feature or context limits", () => {
    const route = VENICE_ROUTE;
    const base = {
      route,
      funding: { kind: "server" as const, providerRoute: "venice", humanUserId: "user-1" },
      prefersSurplus: true,
      hasSurplusCredential: true,
      needsVision: false,
      requiresTools: true,
      reasoningRequested: false,
      usesResponsesApi: false,
      hasServingProfile: false,
      estimatedInputTokens: 1_000,
      maxOutputTokens: 2_000,
    };
    expect(canUseQualifiedSurplusChatRoute(base)).toBe(true);
    expect(canUseQualifiedSurplusChatRoute({ ...base, funding: {
      kind: "personal", humanUserId: "user-1", payerHumanId: "user-1", providerRoute: "venice",
      credentialId: "credential", credentialRevision: 1,
    } })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({ ...base, needsVision: true })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({ ...base, reasoningRequested: true })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({ ...base, estimatedInputTokens: 99_000 })).toBe(false);
    expect(canUseQualifiedSurplusChatRoute({ ...base, maxOutputTokens: 8_001 })).toBe(false);
  });
});

describe("Surplus usage receipt", () => {
  test("parses terminal streamed cost including zero", () => {
    const message = {
      content: "done",
      response_metadata: { usage: {
        prompt_tokens: 8,
        completion_tokens: 5,
        buyer_cost_micro: 0,
      } },
      usage_metadata: { input_tokens: 8, output_tokens: 5, total_tokens: 13 },
    } as unknown as AIMessage;
    expect(readSurplusResponseUsage(message)).toEqual({
      inputTokens: 8, outputTokens: 5, totalTokens: 13, buyerCostMicro: 0,
    });
  });
});
