import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
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
import { resetSurplusModelCatalog } from "../../src/providers/surplus-catalog";
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
import { installSurplusCatalogFixture } from "../helpers/surplus-catalog-fixture";

const VENICE_ROUTE = {
  catalogModelId: "venice:openai-gpt-55",
  surplusModelId: "gpt-5.5",
  providerPin: "venice" as const,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  maxContextTokens: 100_000,
  maxOutputTokens: 8_000,
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
};

class CaptureSurplusLLMEnd extends BaseCallbackHandler {
  name = "capture_surplus_llm_end";
  readonly lc_prefer_streaming = true;
  output: LLMResult | undefined;

  override handleLLMEnd(output: LLMResult): void {
    this.output = output;
  }
}

class CaptureSurplusTokens extends BaseCallbackHandler {
  name = "capture_surplus_tokens";
  readonly lc_prefer_streaming = true;
  readonly tokens: string[] = [];

  override handleLLMNewToken(token: string): void {
    if (token) this.tokens.push(token);
  }
}

beforeEach(installSurplusCatalogFixture);
afterEach(resetSurplusModelCatalog);

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

  test("same-model direct fallback accepts a definitive unserved refusal", () => {
    const refusal = { code: "no_sellers_for_model" };
    const receipt = { marketplaceAttempts: 0, buyerCostMicro: 0, truncated: false };
    expect(isSafeSurplusDirectFallback(refusal, 404, receipt, false)).toBe(true);
    expect(isSafeSurplusDirectFallback(refusal, 404, receipt, true)).toBe(false);
    expect(isSafeSurplusDirectFallback(refusal, 404, { ...receipt, marketplaceAttempts: 1 }, false)).toBe(false);
    expect(isSafeSurplusDirectFallback(refusal, 404, { marketplaceAttempts: 0, truncated: false }, false)).toBe(true);
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

  test("Venice callback-preferred invoke preserves text, tools, terminal metadata, and final usage", async () => {
    const route = resolveQualifiedSurplusChatRoute("venice:minimax-m3-preview");
    if (!route) throw new Error("Expected the discovered Venice route to remain qualified");
    const frames = [
      {
        id: "chatcmpl-surplus-venice-callback",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{ index: 0, delta: { content: "Checking " }, finish_reason: null }],
      },
      {
        id: "chatcmpl-surplus-venice-callback",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{
          index: 0,
          delta: {
            content: "now",
            tool_calls: [{
              index: 0,
              id: "call-report",
              type: "function",
              function: { name: "report_probe", arguments: "{" },
            }],
          },
          finish_reason: null,
        }],
      },
      ...["\"status\": ", "\"ok", "\"", "}"].map((argumentsFragment) => ({
        id: "chatcmpl-surplus-venice-callback",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: null,
              type: "function",
              function: { arguments: argumentsFragment },
            }],
          },
          finish_reason: null,
        }],
      })),
      {
        id: "chatcmpl-surplus-venice-callback",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      {
        id: "chatcmpl-surplus-venice-callback",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [],
        usage: {
          prompt_tokens: 379,
          completion_tokens: 55,
          total_tokens: 434,
          prompt_tokens_details: { cached_tokens: 107 },
          cache_read_input_tokens: 107,
          completion_tokens_details: { reasoning_tokens: 27 },
          buyer_cost_micro: 116,
        },
      },
    ];
    const model = createSurplusChatModel({
      route,
      apiKey: "synthetic-key",
      maxOutputTokens: 256,
      onResponse: () => {},
      fetchImpl: (async () => new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch,
    }).bindTools!([{
      type: "function",
      function: {
        name: "report_probe",
        description: "Record the synthetic probe.",
        parameters: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    } as never]);
    const capture = new CaptureSurplusLLMEnd();

    const response = await model.invoke(
      [new HumanMessage("Run the probe")],
      { callbacks: [capture] },
    ) as AIMessage;
    const generation = capture.output?.generations[0]?.[0] as ChatGeneration | undefined;

    expect(response.content).toBe("Checking now");
    expect(response.tool_calls).toEqual([{
      id: "call-report",
      name: "report_probe",
      args: { status: "ok" },
      type: "tool_call",
    }]);
    expect(response.response_metadata["finish_reason"]).toBe("tool_calls");
    expect(generation?.generationInfo?.["finish_reason"]).toBe("tool_calls");
    expect(generation?.message.response_metadata["finish_reason"]).toBe("tool_calls");
    expect(readSurplusResponseUsage(response)).toMatchObject({
      inputTokens: 379,
      outputTokens: 55,
      totalTokens: 434,
      reasoningTokens: 27,
      cachedInputTokens: 107,
      buyerCostMicro: 116,
    });
    expect(() => assertCompleteSurplusResponse(
      { providerFamily: "venice", truncated: false },
      response,
    )).not.toThrow();
  });

  test("Venice callback-preferred invoke deduplicates its final marker without doubling cost", async () => {
    const route = resolveQualifiedSurplusChatRoute("venice:minimax-m3-preview");
    if (!route) throw new Error("Expected the discovered Venice route to remain qualified");
    const frames = [
      {
        id: "chatcmpl-surplus-venice-final",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "Done" },
          finish_reason: "stop",
        }],
      },
      {
        id: "chatcmpl-surplus-venice-final",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 70,
          completion_tokens: 42,
          total_tokens: 112,
          buyer_cost_micro: 129,
        },
      },
    ];
    const model = createSurplusChatModel({
      route,
      apiKey: "synthetic-key",
      maxOutputTokens: 256,
      onResponse: () => {},
      fetchImpl: (async () => new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch,
    });
    const capture = new CaptureSurplusLLMEnd();

    const response = await model.invoke(
      [new HumanMessage("Reply Done")],
      { callbacks: [capture] },
    ) as AIMessage;

    expect(response.content).toBe("Done");
    expect(response.response_metadata["finish_reason"]).toBe("stop");
    expect(readSurplusResponseUsage(response)).toMatchObject({
      inputTokens: 70,
      outputTokens: 42,
      totalTokens: 112,
      buyerCostMicro: 129,
    });
    expect(() => assertCompleteSurplusResponse(
      { providerFamily: "venice", truncated: false },
      response,
    )).not.toThrow();
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

  test("same-model unpinned requests omit only the provider pin", async () => {
    const route = {
      ...VENICE_ROUTE,
      catalogModelId: "openai:gpt-5.5",
      providerPin: "openai" as const,
    };
    let requestBody: Record<string, unknown> | undefined;
    const model = createSurplusChatModel({
      route,
      apiKey: "test-key",
      providerMode: "any",
      maxOutputTokens: 100,
      onResponse: (receipt, status) => {
        assertSuccessfulSurplusProviderReceipt(route, receipt, status, "any");
      },
      fetchImpl: (async (request: string | URL | Request, init?: RequestInit) => {
        const rawBody = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
        requestBody = typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
        const chunk = {
          id: "chatcmpl-surplus-any",
          object: "chat.completion.chunk",
          created: 1,
          model: route.surplusModelId,
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "request-any",
            "x-si-provider-family": "alternate-provider",
          },
        });
      }) as typeof fetch,
    });

    expect((await model.invoke([new HumanMessage("Reply OK")]) as AIMessage).content).toBe("OK");
    expect(requestBody?.["model"]).toBe(route.surplusModelId);
    expect(requestBody).not.toHaveProperty("provider");
    expect(() => assertSuccessfulSurplusProviderReceipt(
      route,
      { truncated: false },
      200,
      "any",
    )).toThrow(SurplusProviderRouteMismatchError);
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

  test("qualified OpenRouter vision preserves text and image_url on the SDK wire", async () => {
    const route = resolveQualifiedSurplusChatRoute(QUALIFIED_OPENROUTER_ROUTE.catalogModelId);
    if (!route) throw new Error("Expected the signed vision route to remain qualified");
    const personalFunding = {
      kind: "personal" as const,
      humanUserId: "user-vision",
      payerHumanId: "user-vision",
      providerRoute: "surplus",
      credentialId: "credential-surplus",
      credentialRevision: 1,
    };
    expect(route).toMatchObject({
      surplusModelId: "gpt-5.6-sol",
      providerPin: "openrouter",
      supportsVision: true,
    });
    expect(canUseQualifiedSurplusChatRoute({
      route,
      funding: personalFunding,
      prefersSurplus: true,
      hasSurplusCredential: true,
      needsVision: true,
      requiresTools: false,
      reasoningRequested: false,
      hasRequestChangingServingProfile: false,
      estimatedInputTokens: 100,
      maxOutputTokens: 32,
    })).toBe(true);
    expect(canUseQualifiedSurplusChatRoute({
      route: VENICE_ROUTE,
      funding: { kind: "server", providerRoute: "venice", humanUserId: "user-vision" },
      prefersSurplus: true,
      hasSurplusCredential: true,
      needsVision: true,
      requiresTools: false,
      reasoningRequested: false,
      hasRequestChangingServingProfile: false,
      estimatedInputTokens: 100,
      maxOutputTokens: 32,
    })).toBe(false);

    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (request: string | URL | Request, init?: RequestInit) => {
      const rawBody = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
      requestBody = typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
      const chunk = {
        id: "chatcmpl-surplus-vision",
        object: "chat.completion.chunk",
        created: 1,
        model: route.surplusModelId,
        choices: [{ index: 0, delta: { role: "assistant", content: "Seen" }, finish_reason: "stop" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "request-vision",
          "x-si-provider-family": route.providerPin,
        },
      });
    }) as typeof fetch;
    const model = createSurplusChatModel({
      route,
      apiKey: "synthetic-key",
      maxOutputTokens: 32,
      onResponse: () => {},
      fetchImpl,
    });

    const response = await model.invoke([new HumanMessage({ content: [
      { type: "text", text: "What is shown?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
    ] })]) as AIMessage;

    expect(response.content).toBe("Seen");
    expect(requestBody?.["model"]).toBe(route.surplusModelId);
    expect(requestBody?.["provider"]).toBe(route.providerPin);
    expect(requestBody?.["messages"]).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "What is shown?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ],
    }]);
  });

  test("OpenRouter conflicting terminal signals retain actual cost and can replay before publication", async () => {
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
      deliveredOutput: false,
      terminalUsage: readSurplusResponseUsage(response),
    })).toMatchObject({ outcome: "interrupted", costState: "actual", actualCostUsd: 0.000162, directFallback: true });
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
    )).not.toThrow();
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      { truncated: false },
      404,
    )).not.toThrow();
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE,
      { providerFamily: "alternate-provider", truncated: false },
      200,
      "any",
    )).not.toThrow();
  });

  test("defers only output-ceiling aliases while preserving provider and inference guards", () => {
    const receipt = { providerFamily: "venice", truncated: false };
    for (const adaptation of [
      " prompt_cache_key ", "stream_options", "stream_options, prompt_cache_key",
      "max_tokens", "max_completion_tokens", "prompt_cache_key,max_tokens",
      "stream_options,max_completion_tokens", "max_tokens,max_completion_tokens",
    ]) {
      expect(() => assertSuccessfulSurplusProviderReceipt(
        VENICE_ROUTE, { ...receipt, adaptedParameters: adaptation }, 200,
      )).not.toThrow();
    }
    for (const adaptation of [
      "model", "reasoning_effort", "response_format",
      "prompt_cache_retention", "session_id", "unknown_setting", "PROMPT_CACHE_KEY",
      "prompt_cache_key,reasoning_effort", "prompt_cache_key,", ",prompt_cache_key",
      "stream_options,reasoning_effort", "stream_options,", "STREAM_OPTIONS",
      "max_tokens,reasoning_effort", "max_tokens,max_tokens",
    ]) {
      expect(() => assertSuccessfulSurplusProviderReceipt(
        VENICE_ROUTE, { ...receipt, adaptedParameters: adaptation }, 200,
      )).toThrow(SurplusAdaptedParametersError);
    }
    expect(() => assertSuccessfulSurplusProviderReceipt(
      VENICE_ROUTE, { ...receipt, providerFamily: "openai", adaptedParameters: "prompt_cache_key" }, 200,
    )).toThrow(SurplusProviderRouteMismatchError);
  });

  test.each(["prompt_cache_key", "stream_options", "prompt_cache_key,stream_options"])("benign adaptation %s retains the complete answer and terminal usage once", async (adaptation) => {
    const route = { ...QUALIFIED_OPENROUTER_ROUTE, catalogModelId: "openai:gpt-5.6-luna", surplusModelId: "gpt-5.6-luna", providerPin: "openai" as const };
    const chunks = [{
      id: "chatcmpl-surplus-cache-hint", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna",
      choices: [{ index: 0, delta: { role: "assistant", content: '{"operations":[]}' }, finish_reason: "stop" }],
    }, {
      id: "chatcmpl-surplus-cache-hint", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna",
      choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57, buyer_cost_micro: 91 },
    }];
    let requests = 0;
    let receipt: Parameters<typeof assertSuccessfulSurplusProviderReceipt>[1] | undefined;
    const model = createSurplusChatModel({
      route, apiKey: "test-key", maxOutputTokens: 100,
      onResponse: (next, status) => { receipt = next; assertSuccessfulSurplusProviderReceipt(route, next, status); },
      fetchImpl: (async () => {
        requests++;
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "request-cache-hint",
            "x-si-provider-family": "openai", "x-si-adapted-params": adaptation },
        });
      }) as unknown as typeof fetch,
    });
    const response = await model.invoke([new HumanMessage("Extract the journal")]) as AIMessage;
    expect(response.content).toBe('{"operations":[]}');
    expect(() => assertCompleteSurplusResponse(receipt, response)).not.toThrow();
    expect(readSurplusResponseUsage(response)).toMatchObject({ inputTokens: 50, outputTokens: 7, totalTokens: 57, buyerCostMicro: 91 });
    expect(receipt?.adaptedParameters).toBe(adaptation);
    expect(requests).toBe(1);
    expect(classifySurplusFailedAttempt({
      error: new Error("connection lost"), cancelled: false, responseStatus: 200, receipt, deliveredOutput: false,
    })).toMatchObject({ outcome: "unknown", costState: "pending", failureCode: "outcome_unknown", directFallback: true });
    expect(isSafeSurplusDirectFallback({ code: "no_sellers_for_model" }, 404,
      { ...receipt!, marketplaceAttempts: 0 }, false)).toBe(false);
  });

  test("rejects another semantic adaptation before the SDK can assemble its output", async () => {
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
          "x-si-adapted-params": "reasoning_effort",
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
      adaptedParameters: "reasoning_effort",
    });
  });

  test("accepts a naturally completed full-catalogue Kimi request with max_tokens adaptation and bound tools", async () => {
    const route = resolveQualifiedSurplusChatRoute("openrouter:moonshotai/kimi-k3");
    if (!route) throw new Error("Expected the discovered Kimi route to remain qualified");
    expect(route.maxOutputTokens).toBe(131_072);
    const frames = [{
      id: "chatcmpl-surplus-kimi-ceiling", object: "chat.completion.chunk", created: 1,
      model: route.surplusModelId,
      choices: [{ index: 0, delta: { role: "assistant", content: "Complete" }, finish_reason: "stop" }],
    }, {
      id: "chatcmpl-surplus-kimi-ceiling", object: "chat.completion.chunk", created: 1,
      model: route.surplusModelId, choices: [],
      usage: { prompt_tokens: 37, completion_tokens: 19, total_tokens: 56, buyer_cost_micro: 62 },
    }];
    let requestBody: Record<string, unknown> | undefined;
    let receipt: Parameters<typeof assertCompleteSurplusResponse>[0];
    const model = createSurplusChatModel({
      route,
      apiKey: "synthetic-key",
      providerMode: "any",
      maxOutputTokens: 131_072,
      onResponse: (next, status) => {
        receipt = next;
        assertSuccessfulSurplusProviderReceipt(route, next, status, "any");
      },
      fetchImpl: (async (request: string | URL | Request, init?: RequestInit) => {
        const rawBody = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
        requestBody = typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { status: 200, headers: {
            "content-type": "text/event-stream",
            "x-request-id": "request-kimi-ceiling",
            "x-si-provider-family": "openai",
            "x-si-marketplace-attempts": "1",
            "x-si-adapted-params": "max_tokens",
          } },
        );
      }) as typeof fetch,
    }).bindTools!([{
      type: "function",
      function: {
        name: "record_probe",
        description: "Record a synthetic probe.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    } as never]);

    const response = await model.invoke([new HumanMessage("Complete the probe")]) as AIMessage;

    expect(requestBody?.["max_tokens"]).toBe(131_072);
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(requestBody?.["provider"]).toBeUndefined();
    expect(requestBody?.["tools"]).toHaveLength(1);
    expect(receipt).toMatchObject({
      requestId: "request-kimi-ceiling",
      providerFamily: "openai",
      marketplaceAttempts: 1,
      adaptedParameters: "max_tokens",
      truncated: false,
    });
    expect(response.content).toBe("Complete");
    expect(() => assertCompleteSurplusResponse(receipt, response, 131_072)).not.toThrow();
  });

  test("output-ceiling adaptation requires a natural terminal and authoritative usage within the original cap", () => {
    const receipt = {
      requestId: "request-output-ceiling",
      providerFamily: "venice",
      adaptedParameters: "max_completion_tokens",
      truncated: false,
    };
    const response = (
      finishReason: string,
      completionTokens: unknown,
      fields: string | {
        content: string;
        additional_kwargs?: Record<string, unknown>;
        response_metadata?: Record<string, unknown>;
        tool_calls?: Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
          type: "tool_call";
        }>;
      } = "done",
    ) => new AIMessage(typeof fields === "string" ? {
      content: fields,
      response_metadata: {
        finish_reason: finishReason,
        usage: { prompt_tokens: 5, completion_tokens: completionTokens, total_tokens: 105 },
      },
    } : {
      ...fields,
      response_metadata: {
        ...fields.response_metadata,
        finish_reason: finishReason,
        usage: { prompt_tokens: 5, completion_tokens: completionTokens, total_tokens: 105 },
      },
    });

    expect(() => assertCompleteSurplusResponse(receipt, response("stop", 100), 100)).not.toThrow();
    expect(() => assertCompleteSurplusResponse(
      { ...receipt, adaptedParameters: "max_tokens,prompt_cache_key" },
      response("tool_calls", 100, {
        content: "",
        tool_calls: [{ id: "call-1", name: "record_probe", args: {}, type: "tool_call" }],
      }),
      100,
    )).not.toThrow();
    expect(() => assertCompleteSurplusResponse(receipt, response("function_call", 1, {
      content: "",
      additional_kwargs: { function_call: { name: "record_probe", arguments: "{}" } },
    }), 100)).not.toThrow();
    expect(() => assertCompleteSurplusResponse(receipt, response("content_filter", 0, ""), 100)).not.toThrow();

    expect(() => assertCompleteSurplusResponse(receipt, response("stop", 101), 100))
      .toThrow(SurplusAdaptedParametersError);
    expect(() => assertCompleteSurplusResponse(receipt, response("length", 100), 100))
      .toThrow(SurplusAdaptedParametersError);
    expect(() => assertCompleteSurplusResponse(receipt, response("stop", 100)))
      .toThrow(SurplusAdaptedParametersError);
    const normalizedOnlyUsage = new AIMessage({
      content: "done",
      response_metadata: { finish_reason: "stop", usage: { prompt_tokens: 5, total_tokens: 5 } },
    });
    normalizedOnlyUsage.usage_metadata = {
      input_tokens: 5,
      output_tokens: 0,
      total_tokens: 5,
    } as never;
    expect(() => assertCompleteSurplusResponse(receipt, normalizedOnlyUsage, 100))
      .toThrow(SurplusAdaptedParametersError);
    for (const malformed of [-1, 1.5, "100", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCompleteSurplusResponse(receipt, response("stop", malformed), 100))
        .toThrow(SurplusAdaptedParametersError);
    }
    expect(() => assertCompleteSurplusResponse(
      { ...receipt, adaptedParameters: "max_tokens,reasoning_effort" }, response("stop", 1), 100,
    )).toThrow(SurplusAdaptedParametersError);
    expect(() => assertCompleteSurplusResponse(
      { ...receipt, truncated: true }, response("stop", 1), 100,
    )).toThrow(SurplusIncompleteResponseError);
    expect(() => assertCompleteSurplusResponse(receipt, response("stop", 1, "   "), 100))
      .toThrow(SurplusIncompleteResponseError);
  });

  test("a rejected ceiling-adapted stream exposes callbacks but cannot replay after delivered text", async () => {
    const frames = [{
      id: "chatcmpl-surplus-visible-ceiling", object: "chat.completion.chunk", created: 1, model: "gpt-5.5",
      choices: [{ index: 0, delta: { role: "assistant", content: "visible" }, finish_reason: "stop" }],
    }, {
      id: "chatcmpl-surplus-visible-ceiling", object: "chat.completion.chunk", created: 1, model: "gpt-5.5",
      choices: [], usage: { prompt_tokens: 3, completion_tokens: 11, total_tokens: 14, buyer_cost_micro: 62 },
    }];
    let receipt: Parameters<typeof assertCompleteSurplusResponse>[0];
    const model = createSurplusChatModel({
      route: VENICE_ROUTE, apiKey: "test-key", maxOutputTokens: 10,
      onResponse: (next, status) => {
        receipt = next;
        assertSuccessfulSurplusProviderReceipt(VENICE_ROUTE, next, status);
      },
      fetchImpl: (async () => new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream", "x-request-id": "request-visible-ceiling",
          "x-si-provider-family": "venice", "x-si-adapted-params": "max_tokens" } },
      )) as unknown as typeof fetch,
    });
    const capture = new CaptureSurplusTokens();

    const response = await model.invoke([new HumanMessage("Reply")], { callbacks: [capture] }) as AIMessage;
    let completionError: unknown;
    try {
      assertCompleteSurplusResponse(receipt, response, 10);
    } catch (error) {
      completionError = error;
    }

    expect(capture.tokens.join("")).toBe("visible");
    expect(completionError).toBeInstanceOf(SurplusAdaptedParametersError);
    expect(classifySurplusFailedAttempt({
      error: completionError,
      cancelled: false,
      responseStatus: 200,
      receipt,
      deliveredOutput: capture.tokens.length > 0,
      terminalUsage: readSurplusResponseUsage(response),
    })).toEqual({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0.000062,
      failureCode: "adapted_parameters",
      directFallback: false,
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
    expect(() => assertCompleteSurplusResponse(
      { requestId: "request-empty", providerFamily: "venice", truncated: false },
      new AIMessage({ content: "   ", response_metadata: { finish_reason: "stop" } }),
    )).toThrow(SurplusIncompleteResponseError);
    expect(() => assertCompleteSurplusResponse(
      { requestId: "request-filtered", providerFamily: "venice", truncated: false },
      new AIMessage({ content: "", response_metadata: { finish_reason: "content_filter" } }),
    )).not.toThrow();
    expect(() => assertCompleteSurplusResponse(
      { requestId: "request-tool", providerFamily: "venice", truncated: false },
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: "record_probe", args: {}, type: "tool_call" }],
        response_metadata: { finish_reason: "tool_calls" },
      }),
    )).not.toThrow();
  });

  test("SDK stream without terminal completion metadata is interrupted and can replay before publication", async () => {
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
      deliveredOutput: false,
      terminalUsage: readSurplusResponseUsage(response),
    })).toEqual({
      outcome: "interrupted",
      costState: "actual",
      actualCostUsd: 0.000283,
      failureCode: "incomplete_response",
      directFallback: true,
    });
  });

  test("failure classification preserves known header cost and fences truncation and route mismatch", () => {
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
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
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
      receipt: { requestId: "request-truncated", providerFamily: "venice", truncated: true },
    })).toEqual({
      outcome: "interrupted",
      costState: "pending",
      failureCode: "truncated_response",
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
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
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: new Error("deadline"),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
      receipt: { requestId: "request-truncated-zero", providerFamily: "venice", truncated: true },
      terminalUsage: { buyerCostMicro: 0 },
    })).toEqual({
      outcome: "interrupted",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "truncated_response",
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: new SurplusProviderRouteMismatchError(),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
      receipt: { buyerCostMicro: 0, providerFamily: "openai", truncated: false },
    })).toEqual({
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "provider_route_mismatch",
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      deliveredOutput: false,
      receipt: { marketplaceAttempts: 0, buyerCostMicro: 0, truncated: false },
    })).toEqual({
      outcome: "failed",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "no_sellers_for_model",
      directFallback: true,
    });
  });

  test("adapted responses preserve charge state while undelivered attempts can replay", () => {
    expect(classifySurplusFailedAttempt({
      error: new SurplusAdaptedParametersError(),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
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
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: new SurplusAdaptedParametersError(),
      cancelled: false,
      responseStatus: 200,
      deliveredOutput: false,
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
      directFallback: true,
    });
    expect(classifySurplusFailedAttempt({
      error: { code: "no_sellers_for_model" },
      cancelled: false,
      responseStatus: 404,
      deliveredOutput: false,
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
      directFallback: true,
    });
  });
});

describe("qualified Surplus route selection", () => {
  test("derives supported routes from signed catalog rows", () => {
    expect(resolveQualifiedSurplusChatRoute(QUALIFIED_OPENROUTER_ROUTE.catalogModelId))
      .toMatchObject({
        catalogModelId: QUALIFIED_OPENROUTER_ROUTE.catalogModelId,
        surplusModelId: "gpt-5.6-sol",
        providerPin: "openrouter",
      });
    expect(resolveQualifiedSurplusChatRoute("venice:minimax-m3-preview")).not.toBeNull();
    expect(resolveQualifiedSurplusChatRoute("openrouter:anthropic/claude-sonnet-4.6")).not.toBeNull();
    expect(resolveQualifiedSurplusChatRoute("openai:gpt-5.6-sol")).not.toBeNull();
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
    };
    expect(resolveQualifiedSurplusChatRoute(candidate.catalogModelId, [candidate])).toEqual(candidate);
    expect(resolveQualifiedSurplusChatRoute(candidate.catalogModelId, [{ ...candidate, providerPin: "openrouter" }])).toBeNull();
    expect(resolveQualifiedSurplusChatRoute("openai:not-signed", [{ ...candidate, catalogModelId: "openai:not-signed", providerPin: "openai" }])).toBeNull();
  });

  test("projects catalog support, policy, credentials, and funding", () => {
    const routes = [VENICE_ROUTE];
    expect(resolveSurplusChatServingAvailability({
      policyEnabled: true, keyConfigured: true,
    }).status).toBe("available");
    expect(resolveSurplusChatServingAvailability({
      policyEnabled: false, keyConfigured: true,
    }).status).toBe("qualified-unavailable");
    expect(resolveSurplusChatServingAvailability({
      policyEnabled: true, keyConfigured: false,
    }).status).toBe("qualified-unavailable");
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
    }).status).toBe("available");
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
      hasRequestChangingServingProfile: false,
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
