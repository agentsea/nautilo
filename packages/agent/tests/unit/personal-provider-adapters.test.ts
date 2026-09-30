import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import {
  createUnmeteredEvaluationModel,
} from "../../src/providers/universal";
import { resolveOpenRouterTransport } from "../../src/providers/openrouter-transport";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

const MODEL_IDS: string[] = [
  "anthropic:claude-sonnet-4-6",
  "openai:gpt-5.6-luna",
  "openrouter:moonshotai/kimi-k2.6",
  "google:gemini-2.5-pro",
  "xai:grok-personal-test",
  "fireworks:accounts/fireworks/models/glm-5p3",
  "together:personal-test",
  "venice:kimi-k3",
];

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_AI_API_KEY",
  "VENICE_API_KEY",
  "NAUTILO_MANAGED_GATEWAY_API_KEY",
  "NAUTILO_MANAGED_GATEWAY_BASE_URL",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function modelUsesExactApiKey(model: unknown, apiKey: string): boolean {
  if (!model || typeof model !== "object") return false;
  const candidate = model as {
    apiKey?: unknown;
    anthropicApiKey?: unknown;
    fireworksApiKey?: unknown;
    bound?: unknown;
  };
  return candidate.apiKey === apiKey
    || candidate.anthropicApiKey === apiKey
    || candidate.fireworksApiKey === apiKey
    || (candidate.bound !== model && modelUsesExactApiKey(candidate.bound, apiKey));
}

beforeAll(async () => activateModelCatalogForTests(MODEL_IDS));
afterAll(() => {
  resetRuntimeModelCatalog();
  restoreEnv();
});
afterEach(restoreEnv);

describe("personal provider chat adapters", () => {
  test.each(MODEL_IDS)("injects the exact personal key into %s", async (modelId) => {
    for (const key of ENV_KEYS) process.env[key] = "server-key-must-not-be-used";
    process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = `ngw_${"a".repeat(43)}`;
    process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = "https://gateway.qa.example/v1";
    const apiKey = "  exact-personal-key  ";

    const model = await createUnmeteredEvaluationModel(modelId, {
      personalCredential: { apiKey },
    });

    expect(modelUsesExactApiKey(model, apiKey)).toBe(true);
  });

  test.each([
    undefined,
    null,
    {},
    { apiKey: "" },
    { apiKey: "   " },
    { apiKey: 42 },
  ])("fails closed for an invalid personal credential", async (personalCredential) => {
    process.env["OPENAI_API_KEY"] = "server-key-must-not-be-used";
    expect(createUnmeteredEvaluationModel("openai:gpt-5.6-luna", {
      personalCredential,
    } as Record<string, unknown>)).rejects.toThrow("valid personal provider credential");
  });

  test("rejects personal credentials for the managed gateway and unknown providers", async () => {
    for (const modelId of ["gateway:local-model", "unknown:model"]) {
      expect(createUnmeteredEvaluationModel(modelId, {
        personalCredential: { apiKey: "personal-key" },
      })).rejects.toThrow("Personal credentials are not supported");
    }
  });
});

describe("personal OpenRouter transport", () => {
  test("sends the personal key through direct OpenRouter transport without leaking it into the request body", async () => {
    const personalApiKey = "sk-personal-openrouter-transport";
    const serverDirectApiKey = "sk-server-openrouter-must-not-be-used";
    const serverGatewayKey = `ngw_${"d".repeat(43)}`;
    process.env["OPENROUTER_API_KEY"] = serverDirectApiKey;
    process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = serverGatewayKey;
    process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = "https://gateway.qa.example/v1";

    const requests: Array<{ authorization: string | null; body: string; url: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(init?.headers ?? request?.headers);
      const body = typeof init?.body === "string"
        ? init.body
        : request
          ? await request.clone().text()
          : "";
      requests.push({
        authorization: headers.get("authorization"),
        body,
        url: typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      });
      return Response.json({
        id: "chatcmpl-personal-transport",
        object: "chat.completion",
        created: 1,
        model: "moonshotai/kimi-k2.6",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "personal transport success" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    try {
      const model = await createUnmeteredEvaluationModel(
        "openrouter:moonshotai/kimi-k2.6",
        { personalCredential: { apiKey: personalApiKey } },
      );
      const response = await model.invoke([new HumanMessage("hello")]) as {
        content: unknown;
      };

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(requests[0]?.authorization).toBe(`Bearer ${personalApiKey}`);
      expect(requests[0]?.authorization).not.toContain(serverDirectApiKey);
      expect(requests[0]?.authorization).not.toContain(serverGatewayKey);
      expect(requests[0]?.body).not.toContain(personalApiKey);
      expect(requests[0]?.body).not.toContain(serverDirectApiKey);
      expect(requests[0]?.body).not.toContain(serverGatewayKey);
      expect(JSON.stringify(response)).not.toContain(personalApiKey);
      expect(response.content).toBe("personal transport success");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("personal funding selects direct OpenRouter even when managed Gateway is configured", () => {
    const personalApiKey = "  exact-personal-openrouter-key  ";
    expect(resolveOpenRouterTransport({
      personalApiKey,
      env: {
        NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"b".repeat(43)}`,
        NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.qa.example/v1",
        OPENROUTER_API_KEY: "server-openrouter-key",
      },
    })).toEqual({
      kind: "openrouter",
      apiKey: personalApiKey,
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  test("server funding retains managed Gateway precedence over direct OpenRouter", () => {
    const gatewayKey = `ngw_${"c".repeat(43)}`;
    expect(resolveOpenRouterTransport({
      directApiKey: "explicit-server-openrouter-key",
      env: {
        NAUTILO_MANAGED_GATEWAY_API_KEY: gatewayKey,
        NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.qa.example/v1/",
        OPENROUTER_API_KEY: "server-openrouter-key",
      },
    })).toEqual({
      kind: "managed-gateway",
      apiKey: gatewayKey,
      baseUrl: "https://gateway.qa.example/v1",
    });
  });
});
