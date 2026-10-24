import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ReasoningEffort } from "../../src/providers/types";
import type { QualifiedSurplusChatRoute } from "../../src/providers/surplus-route";
import { createSurplusChatModel } from "../../src/providers/surplus-transport";

interface CapturedRequest {
  readonly body: Record<string, unknown>;
  readonly calls: number;
}

function route(input: {
  catalogModelId: string;
  surplusModelId: string;
  providerPin: QualifiedSurplusChatRoute["providerPin"];
  supportedParameters?: readonly string[];
}): QualifiedSurplusChatRoute {
  return {
    ...input,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    maxContextTokens: 100_000,
    maxOutputTokens: 8_000,
  };
}

async function captureRequest(input: {
  route: QualifiedSurplusChatRoute;
  reasoningEffort?: ReasoningEffort;
  reasoningOutput?: boolean;
  maxOutputTokens?: number;
}): Promise<CapturedRequest> {
  let calls = 0;
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (request: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const rawBody = init?.body
      ?? (request instanceof Request ? await request.clone().text() : undefined);
    if (typeof rawBody !== "string") throw new Error("Missing Surplus request body");
    body = JSON.parse(rawBody) as Record<string, unknown>;
    const chunk = {
      id: "chatcmpl-surplus-parameters",
      object: "chat.completion.chunk",
      created: 1,
      model: input.route.surplusModelId,
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "OK" },
        finish_reason: "stop",
      }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const model = createSurplusChatModel({
    route: input.route,
    apiKey: "synthetic-key",
    maxOutputTokens: input.maxOutputTokens ?? 321,
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: input.reasoningEffort }),
    ...(input.reasoningOutput === undefined
      ? {}
      : { reasoningOutput: input.reasoningOutput }),
    onResponse: () => {},
    fetchImpl,
  });

  const response = await model.invoke([new HumanMessage("Reply OK")]) as AIMessage;
  expect(response.content).toBe("OK");
  if (!body) throw new Error("Surplus request was not captured");
  return { body, calls };
}

describe("Surplus discovered parameter projection", () => {
  test("converts Venice's reviewed flat effort to the discovered nested spelling", async () => {
    const qualifiedRoute = route({
      catalogModelId: "venice:minimax-m3-preview",
      surplusModelId: "minimax-m3-preview",
      providerPin: "venice",
      supportedParameters: ["max_tokens", "reasoning"],
    });

    const captured = await captureRequest({
      route: qualifiedRoute,
      reasoningEffort: "medium",
    });

    expect(captured.calls).toBe(1);
    expect(captured.body["model"]).toBe("minimax-m3-preview");
    expect(captured.body["reasoning"]).toEqual({ effort: "medium" });
    expect(captured.body).not.toHaveProperty("reasoning_effort");
    expect(captured.body).not.toHaveProperty("include_reasoning");
  });

  test("converts reviewed nested effort to the discovered flat spelling", async () => {
    const qualifiedRoute = route({
      catalogModelId: "openrouter:openai/gpt-6-sol",
      surplusModelId: "openai/gpt-6-sol",
      providerPin: "openrouter",
      supportedParameters: ["max_tokens", "reasoning_effort"],
    });

    const captured = await captureRequest({
      route: qualifiedRoute,
      reasoningEffort: "high",
    });

    expect(captured.body["model"]).toBe("openai/gpt-6-sol");
    expect(captured.body["max_tokens"]).toBe(321);
    expect(captured.body["reasoning_effort"]).toBe("high");
    expect(captured.body).not.toHaveProperty("max_completion_tokens");
    expect(captured.body).not.toHaveProperty("reasoning");
    expect(captured.body).not.toHaveProperty("include_reasoning");
  });

  test("converts reviewed nested disabled reasoning to flat none", async () => {
    const qualifiedRoute = route({
      catalogModelId: "openrouter:openai/gpt-6-sol",
      surplusModelId: "openai/gpt-6-sol",
      providerPin: "openrouter",
      supportedParameters: ["max_tokens", "reasoning_effort"],
    });

    const captured = await captureRequest({
      route: qualifiedRoute,
      reasoningEffort: "off",
    });

    expect(captured.body["reasoning_effort"]).toBe("none");
    expect(captured.body).not.toHaveProperty("reasoning");
  });

  test("preserves the factory-reviewed spelling when both knobs are advertised", async () => {
    const openRouter = await captureRequest({
      route: route({
        catalogModelId: "openrouter:openai/gpt-6-sol",
        surplusModelId: "openai/gpt-6-sol",
        providerPin: "openrouter",
        supportedParameters: ["max_tokens", "reasoning", "reasoning_effort"],
      }),
      reasoningEffort: "high",
    });
    const venice = await captureRequest({
      route: route({
        catalogModelId: "venice:minimax-m3-preview",
        surplusModelId: "minimax-m3-preview",
        providerPin: "venice",
        supportedParameters: ["max_tokens", "reasoning", "reasoning_effort"],
      }),
      reasoningEffort: "medium",
    });

    expect(openRouter.body["reasoning"]).toEqual({ effort: "high", exclude: false });
    expect(openRouter.body).not.toHaveProperty("reasoning_effort");
    expect(venice.body["reasoning_effort"]).toBe("medium");
    expect(venice.body).not.toHaveProperty("reasoning");
  });

  test("rejects an explicit effort before the wire when no reasoning knob is advertised", () => {
    let calls = 0;
    expect(() => createSurplusChatModel({
      route: route({
        catalogModelId: "venice:minimax-m3-preview",
        surplusModelId: "minimax-m3-preview",
        providerPin: "venice",
        supportedParameters: ["max_tokens", "include_reasoning"],
      }),
      apiKey: "synthetic-key",
      maxOutputTokens: 321,
      reasoningEffort: "medium",
      onResponse: () => {},
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("fetch must not run");
      }) as unknown as typeof fetch,
    })).toThrow("does not advertise a reasoning control");
    expect(calls).toBe(0);
  });

  test("omits an implicit default when no reasoning knob is advertised", async () => {
    const captured = await captureRequest({
      route: route({
        catalogModelId: "openrouter:openai/gpt-6-sol",
        surplusModelId: "openai/gpt-6-sol",
        providerPin: "openrouter",
        supportedParameters: ["max_tokens", "include_reasoning"],
      }),
      reasoningOutput: true,
      maxOutputTokens: 4_096,
    });

    expect(captured.body["max_tokens"]).toBe(4_096);
    expect(captured.body).not.toHaveProperty("reasoning");
    expect(captured.body).not.toHaveProperty("reasoning_effort");
    expect(captured.body).not.toHaveProperty("include_reasoning");
  });

  test("preserves the offline injected-route reasoning seam when discovery is absent", async () => {
    const captured = await captureRequest({
      route: route({
        catalogModelId: "venice:minimax-m3-preview",
        surplusModelId: "minimax-m3-preview",
        providerPin: "venice",
      }),
      reasoningEffort: "medium",
    });

    expect(captured.body["reasoning_effort"]).toBe("medium");
    expect(captured.body).not.toHaveProperty("reasoning");
  });
});
