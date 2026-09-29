import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
