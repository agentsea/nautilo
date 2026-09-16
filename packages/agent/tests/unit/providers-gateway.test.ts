import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGatewayCreateModelOptions,
  withGatewayErrorLabel,
} from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";
import { classifyErrorSimple } from "../../src/utils/errors";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "NAUTILO_GATEWAY_API_KEY",
  "NAUTILO_GATEWAY_BASE_URL",
  "NAUTILO_GATEWAY_LABEL",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("generic gateway provider options", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv();
  });

  test("requires gateway key and does not fall back to OPENAI_API_KEY", () => {
    process.env["OPENAI_API_KEY"] = "sk-proj-openai-key-that-must-not-be-used";
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "http://localhost:4000/v1";

    expect(() => buildGatewayCreateModelOptions("gateway:local-model", {})).toThrow(
      "Missing NAUTILO_GATEWAY_API_KEY",
    );
  });

  test("requires an explicit http(s) gateway base URL", () => {
    process.env["NAUTILO_GATEWAY_API_KEY"] = "local-gateway-key";
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "file:///tmp/not-an-api";

    expect(() => buildGatewayCreateModelOptions("gateway:local-model", {})).toThrow(
      "Missing NAUTILO_GATEWAY_BASE_URL",
    );
  });

  test("rejects malformed gateway base URLs", () => {
    process.env["NAUTILO_GATEWAY_API_KEY"] = "local-gateway-key";
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://";

    expect(() => buildGatewayCreateModelOptions("gateway:local-model", {})).toThrow(
      "Missing NAUTILO_GATEWAY_BASE_URL",
    );
  });

  test("builds gateway options from environment and trims trailing URL slashes", () => {
    process.env["NAUTILO_GATEWAY_API_KEY"] = "local-gateway-key";
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "http://localhost:4000/v1///";
    process.env["NAUTILO_GATEWAY_LABEL"] = "Local Gateway";

    expect(buildGatewayCreateModelOptions("gateway:openai/gpt-oss-120b", {})).toEqual({
      label: "Local Gateway",
      options: {
        modelId: "gateway:openai/gpt-oss-120b",
        apiKey: "local-gateway-key",
        baseUrl: "http://localhost:4000/v1",
      },
    });
  });

  test("explicit options win over gateway environment", () => {
    process.env["NAUTILO_GATEWAY_API_KEY"] = "env-gateway-key";
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "http://localhost:4000/v1";

    expect(buildGatewayCreateModelOptions("gateway:custom-model", {
      apiKey: "explicit-gateway-key",
      baseURL: "https://gateway.example.test/v1",
      gatewayLabel: "Example Gateway",
    })).toEqual({
      label: "Example Gateway",
      options: {
        modelId: "gateway:custom-model",
        apiKey: "explicit-gateway-key",
        baseUrl: "https://gateway.example.test/v1",
      },
    });
  });
});

describe("gateway error labeling", () => {
  test("prefixes invoke errors with gateway label", () => {
    const model: ChatModel = {
      invoke: async () => {
        throw new Error("401 unauthorized");
      },
    };

    expect(withGatewayErrorLabel(model, "Local Gateway").invoke([])).rejects.toThrow(
      "Local Gateway: 401 unauthorized",
    );
  });

  test("preserves HTTP status fields when labeling gateway errors", async () => {
    const model: ChatModel = {
      invoke: async () => {
        const error = new Error("provider overloaded") as Error & { status: number };
        error.status = 429;
        throw error;
      },
    };

    try {
      await withGatewayErrorLabel(model, "Local Gateway").invoke([]);
      throw new Error("expected invoke to throw");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(429);
      expect(classifyErrorSimple(error)).toBe("retriable");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Local Gateway: provider overloaded");
    }
  });

  test("preserves bindTools through the wrapper", async () => {
    const toolBoundModel: ChatModel = {
      invoke: async () => "tool-bound response",
    };
    const model: ChatModel = {
      invoke: async () => "base response",
      bindTools: () => toolBoundModel,
    };

    const wrapped = withGatewayErrorLabel(model, "Local Gateway").bindTools?.([]);
    expect(await wrapped?.invoke([])).toBe("tool-bound response");
  });
});

