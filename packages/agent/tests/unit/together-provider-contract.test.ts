import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseMessageLike } from "@langchain/core/messages";
import {
  createTogetherWithDependencies,
  type TogetherFactoryDependencies,
} from "../../src/providers/factory";
import type { ChatModel } from "../../src/providers/types";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

beforeAll(async () => {
  await activateModelCatalogForTests([
    "together:test-model",
  ]);
});

afterAll(() => resetRuntimeModelCatalog());

function model(overrides: Partial<ChatModel<BaseMessageLike, unknown>> = {}): ChatModel<BaseMessageLike, unknown> {
  return { invoke: async () => "ok", bindTools: () => model(), ...overrides };
}

function harness(client: () => ChatModel<BaseMessageLike, unknown>): {
  dependencies: TogetherFactoryDependencies;
  clientFields: Record<string, unknown>[];
} {
  const clientFields: Record<string, unknown>[] = [];
  return {
    clientFields,
    dependencies: {
      createClient(fields) { clientFields.push(fields); return client(); },
    },
  };
}

const options = {
  modelId: "together:test-model",
  apiKey: "together-test-key",
  maxTokens: 4096,
  timeoutMs: 12_345,
} as const;

describe("D490 Together provider behavior contract", () => {
  test("uses the OpenAI-compatible endpoint with exact model, credential, limits, and tool binding", async () => {
    const bound = model({ invoke: async () => "tool-bound" });
    const client = model({ bindTools: (tools) => {
      expect(tools).toEqual([{ name: "lookup" }]);
      return bound;
    } });
    const h = harness(() => client);
    const created = await createTogetherWithDependencies(options, h.dependencies);
    expect(await created.bindTools?.([{ name: "lookup" }]).invoke([])).toBe("tool-bound");
    expect(h.clientFields).toEqual([{
      model: "test-model",
      maxTokens: 4096,
      configuration: { baseURL: "https://api.together.xyz/v1" },
      streamUsage: true,
      timeout: 12_345,
      apiKey: "together-test-key",
    }]);
  });

  test("custom base URL is honored exactly", async () => {
    const h = harness(() => model());
    await createTogetherWithDependencies({ ...options, baseUrl: "https://together-proxy.example/v1" }, h.dependencies);
    expect(h.clientFields[0]).toMatchObject({ configuration: { baseURL: "https://together-proxy.example/v1" } });
  });

  test("invocation errors propagate and never trigger a second-provider retry", async () => {
    const upstream = Object.assign(new Error("Together: rate limited"), { status: 429 });
    const h = harness(() => model({ invoke: async () => { throw upstream; } }));
    const created = await createTogetherWithDependencies(options, h.dependencies);
    try {
      await created.invoke([]);
      throw new Error("expected invocation failure");
    } catch (error) {
      expect(error).toBe(upstream);
      expect((error as { status?: number }).status).toBe(429);
    }
    expect(h.clientFields).toHaveLength(1);
  });
});
