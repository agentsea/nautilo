import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { setConfigOverrides } from "@nautilo/config";
import * as db from "@nautilo/db";
import * as serviceAttempt from "../../src/usage/service-embedding-attempt";
import * as surplusEmbeddingAttempt from "../../src/usage/surplus-embedding-attempt";
import {
  EmbeddingProviderError,
  embedTextWithProvenance,
  embedTexts,
  getProtectedMemoryEmbeddingConfiguration,
  getMemoryEmbeddingDisclosure,
} from "../../src/store/embeddings";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_KEY = process.env["OPENAI_API_KEY"];
const ORIGINAL_OPENROUTER_KEY = process.env["OPENROUTER_API_KEY"];
const ORIGINAL_VENICE_KEY = process.env["VENICE_API_KEY"];
const ORIGINAL_MANAGED_GATEWAY_KEY = process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
const ORIGINAL_MANAGED_GATEWAY_BASE_URL = process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
const ORIGINAL_SURPLUS_KEY = process.env["SURPLUS_API_KEY"];
type ServerModelConfigRow = NonNullable<ReturnType<typeof db.getCachedServerModelConfigRow>>;

let serverEmbeddingModel: string | null | undefined;
let serverPreferSurplus: boolean;
let serverConfigSpy: Mock<typeof db.getCachedServerModelConfigRow>;
let serviceAttemptSpy: Mock<typeof serviceAttempt.runServiceEmbeddingAttempt>;
let surplusAttemptSpy: Mock<typeof surplusEmbeddingAttempt.invokeSurplusEmbeddingAttempt>;

function restoreEnv(name: "OPENAI_API_KEY" | "OPENROUTER_API_KEY" | "VENICE_API_KEY" | "SURPLUS_API_KEY" | "NAUTILO_MANAGED_GATEWAY_API_KEY" | "NAUTILO_MANAGED_GATEWAY_BASE_URL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function embeddingResponse(
  data: Array<{ index: number; embedding: number[] }>,
  status = 200,
): Response {
  return Response.json({ data, usage: { prompt_tokens: 0, total_tokens: 0 } }, { status });
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body !== "string") throw new Error("Expected a JSON string request body");
  return JSON.parse(body) as unknown;
}

describe("memory embedding providers", () => {
  beforeEach(() => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["VENICE_API_KEY"];
    delete process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
    delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
    delete process.env["SURPLUS_API_KEY"];
    setConfigOverrides({
      nautilo_embedding_model: "text-embedding-3-small",
      nautilo_embedding_dims: 3,
    });
    serverEmbeddingModel = undefined;
    serverPreferSurplus = false;
    serverConfigSpy = spyOn(db, "getCachedServerModelConfigRow").mockImplementation(() =>
      serverEmbeddingModel === undefined
        ? null
        : ({ embeddingModel: serverEmbeddingModel, preferSurplus: serverPreferSurplus } as ServerModelConfigRow));
    serviceAttemptSpy = spyOn(serviceAttempt, "runServiceEmbeddingAttempt")
      .mockImplementation(async (input) => {
        input.assertStillAuthorized?.();
        return input.invoke(() => {});
      });
    surplusAttemptSpy = spyOn(surplusEmbeddingAttempt, "invokeSurplusEmbeddingAttempt")
      .mockImplementation(async (input) => {
        input.assertStillAuthorized();
        return input.parseResponse({
          model: "text-embedding-3-large",
          data: [{ index: 0, embedding: Array.from({ length: 1_536 }, (_, index) => index) }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      });
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    restoreEnv("OPENAI_API_KEY", ORIGINAL_OPENAI_KEY);
    restoreEnv("OPENROUTER_API_KEY", ORIGINAL_OPENROUTER_KEY);
    restoreEnv("VENICE_API_KEY", ORIGINAL_VENICE_KEY);
    restoreEnv("NAUTILO_MANAGED_GATEWAY_API_KEY", ORIGINAL_MANAGED_GATEWAY_KEY);
    restoreEnv("NAUTILO_MANAGED_GATEWAY_BASE_URL", ORIGINAL_MANAGED_GATEWAY_BASE_URL);
    restoreEnv("SURPLUS_API_KEY", ORIGINAL_SURPLUS_KEY);
    serverConfigSpy.mockRestore();
    serviceAttemptSpy.mockRestore();
    surplusAttemptSpy.mockRestore();
    setConfigOverrides({});
  });

  test("uses Surplus only for the explicit qualified large space and discloses its recipients", async () => {
    serverEmbeddingModel = "venice:text-embedding-3-large";
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });

    const canonical = getProtectedMemoryEmbeddingConfiguration();
    expect(canonical).toEqual({
      provider: "venice", model: "text-embedding-3-large", dimensions: 1_536,
    });
    const disclosure = getMemoryEmbeddingDisclosure();
    expect(disclosure).toEqual({
      contractVersion: 2,
      canonicalSpace: {
        provider: "venice", model: "text-embedding-3-large", dimensions: 1_536,
      },
      processingRoute: {
        transport: "surplus_marketplace",
        marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
        dataRecipientClasses: ["surplus", "marketplace_seller", "seller_upstream_processor"],
      },
    });
    expect(Object.isFrozen(disclosure)).toBe(true);

    const legacyError = await embedTextWithProvenance("memory", undefined, canonical)
      .catch((error: unknown) => error);
    expect(legacyError).toMatchObject({
      code: "unsupported_provider",
    });
    expect(surplusAttemptSpy).not.toHaveBeenCalled();

    const embedded = await embedTextWithProvenance("memory", undefined, {
      ...canonical, disclosure,
    });
    expect(embedded).toMatchObject({
      provider: "venice",
      canonicalModel: "text-embedding-3-large",
      dimensions: 1_536,
    });
    expect(embedded.vector).toHaveLength(1_536);
    expect(surplusAttemptSpy).toHaveBeenCalledTimes(1);
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
  });

  test("rechecks marketplace policy after durable admission and before dispatch", async () => {
    serverEmbeddingModel = "venice:text-embedding-3-large";
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    const canonical = getProtectedMemoryEmbeddingConfiguration();
    const disclosure = getMemoryEmbeddingDisclosure();
    surplusAttemptSpy.mockImplementationOnce(async (input) => {
      serverPreferSurplus = false;
      input.assertStillAuthorized();
      throw new Error("must not dispatch");
    });
    const error = await embedTextWithProvenance("memory", undefined, {
      ...canonical, disclosure,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "unsupported_provider",
      message: "The approved embedding configuration changed. Prepare the Memory request again.",
    });
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
  });

  test("rejects a marketplace response that names a different embedding model", async () => {
    serverEmbeddingModel = "venice:text-embedding-3-large";
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    surplusAttemptSpy.mockImplementationOnce(async (input) => {
      try {
        return input.parseResponse({
          model: "text-embedding-3-small",
          data: [{ index: 0, embedding: Array.from({ length: 1_536 }, () => 0) }],
        });
      } catch {
        throw new surplusEmbeddingAttempt.SurplusEmbeddingAttemptError(
          "invalid_response", 200, true,
        );
      }
    });
    const error = await embedTexts(["memory"]).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_response", provider: "venice" });
  });

  test("uses qualified Surplus as Auto's fallback when no direct credential is runnable", async () => {
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    serverEmbeddingModel = "";

    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "venice", model: "text-embedding-3-large", dimensions: 1_536,
    });
    expect(getMemoryEmbeddingDisclosure()).toMatchObject({
      canonicalSpace: {
        provider: "venice", model: "text-embedding-3-large", dimensions: 1_536,
      },
      processingRoute: { transport: "surplus_marketplace" },
    });
    expect((await embedTexts(["memory"]))[0]).toHaveLength(1_536);
    expect(surplusAttemptSpy).toHaveBeenCalledTimes(1);
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
  });

  test("never rewrites explicit small or Qwen selections to the large marketplace space", async () => {
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    for (const selection of [
      "venice:text-embedding-3-small",
      "openrouter:qwen/qwen3-embedding-8b",
    ]) {
      serverEmbeddingModel = selection;
      const error = await embedTexts(["memory"]).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "missing_credentials" });
    }
    expect(surplusAttemptSpy).not.toHaveBeenCalled();
  });

  test("distinguishes inherited explicit configuration from an explicit Auto override", async () => {
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({
      nautilo_embedding_model: "openrouter:qwen/qwen3-embedding-8b",
      nautilo_embedding_dims: 1_536,
    });

    serverEmbeddingModel = null;
    expect(await embedTexts(["memory"]).catch((caught: unknown) => caught))
      .toMatchObject({ code: "missing_credentials", provider: "openrouter" });
    expect(surplusAttemptSpy).not.toHaveBeenCalled();

    serverEmbeddingModel = "";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "venice", model: "text-embedding-3-large", dimensions: 1_536,
    });
    expect((await embedTexts(["memory"]))[0]).toHaveLength(1_536);
    expect(surplusAttemptSpy).toHaveBeenCalledTimes(1);
  });

  test("Auto refuses Surplus without the complete policy, credential, and dimension admission", async () => {
    serverEmbeddingModel = "";
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    for (const configure of [
      () => { serverPreferSurplus = false; process.env["SURPLUS_API_KEY"] = "surplus-secret"; },
      () => { serverPreferSurplus = true; delete process.env["SURPLUS_API_KEY"]; },
      () => {
        serverPreferSurplus = true;
        process.env["SURPLUS_API_KEY"] = "surplus-secret";
        setConfigOverrides({ nautilo_embedding_dims: 3 });
      },
    ]) {
      configure();
      expect(await embedTexts(["memory"]).catch((caught: unknown) => caught))
        .toMatchObject({ code: "missing_credentials" });
    }
    expect(surplusAttemptSpy).not.toHaveBeenCalled();
  });

  test("Auto does not retry a Surplus provider 503", async () => {
    serverEmbeddingModel = "";
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    surplusAttemptSpy.mockRejectedValueOnce(new surplusEmbeddingAttempt.SurplusEmbeddingAttemptError(
      "provider_unavailable", 503, true,
    ));

    expect(await embedTexts(["memory"]).catch((caught: unknown) => caught))
      .toMatchObject({ code: "request_failed", status: 503, retryable: true });
    expect(surplusAttemptSpy).toHaveBeenCalledTimes(1);
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
  });

  test("Auto rechecks its marketplace binding before dispatch", async () => {
    serverEmbeddingModel = "";
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    let dispatches = 0;
    surplusAttemptSpy.mockImplementationOnce(async (input) => {
      delete process.env["SURPLUS_API_KEY"];
      input.assertStillAuthorized();
      dispatches += 1;
      throw new Error("must not dispatch");
    });

    expect(await embedTexts(["memory"]).catch((caught: unknown) => caught)).toMatchObject({
      code: "unsupported_provider",
      message: "The approved embedding configuration changed. Prepare the Memory request again.",
    });
    expect(dispatches).toBe(0);
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
  });

  test("policy-off large remains an exact direct Venice request with dimensions", async () => {
    serverEmbeddingModel = "venice:text-embedding-3-large";
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    process.env["VENICE_API_KEY"] = "venice-secret";
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    let body: unknown;
    globalThis.fetch = (async (_input, init) => {
      body = parseRequestBody(init?.body);
      return Response.json({
        data: [{ index: 0, embedding: Array.from({ length: 1_536 }, () => 0) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }) as typeof fetch;
    const result = await embedTexts(["memory"]);
    expect(result[0]).toHaveLength(1_536);
    expect(body).toEqual({
      model: "text-embedding-3-large", input: ["memory"], dimensions: 1_536,
    });
    expect(serviceAttemptSpy).toHaveBeenCalledTimes(1);
    expect(surplusAttemptSpy).not.toHaveBeenCalled();
    expect(getMemoryEmbeddingDisclosure().processingRoute).toEqual({ transport: "direct" });
  });

  test("rechecks direct route, key, model, and disclosure after durable admission", async () => {
    setConfigOverrides({ nautilo_embedding_dims: 1_536 });
    process.env["VENICE_API_KEY"] = "venice-original";
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return embeddingResponse([{
        index: 0,
        embedding: Array.from({ length: 1_536 }, (_, index) => index / 1_536),
      }]);
    }) as unknown as typeof fetch;

    const cases: Array<{
      configure: () => void;
      drift: () => void;
    }> = [
      {
        configure: () => {
          serverEmbeddingModel = "venice:text-embedding-3-large";
          serverPreferSurplus = false;
          process.env["SURPLUS_API_KEY"] = "surplus-secret";
          process.env["VENICE_API_KEY"] = "venice-original";
        },
        drift: () => { serverPreferSurplus = true; },
      },
      {
        configure: () => {
          serverEmbeddingModel = "venice:text-embedding-3-large";
          serverPreferSurplus = false;
          delete process.env["SURPLUS_API_KEY"];
          process.env["VENICE_API_KEY"] = "venice-original";
        },
        drift: () => { process.env["VENICE_API_KEY"] = "venice-replaced"; },
      },
      {
        configure: () => {
          serverEmbeddingModel = "venice:text-embedding-3-large";
          serverPreferSurplus = false;
          delete process.env["SURPLUS_API_KEY"];
          process.env["VENICE_API_KEY"] = "venice-original";
        },
        drift: () => { serverEmbeddingModel = "venice:text-embedding-3-small"; },
      },
    ];

    for (const scenario of cases) {
      scenario.configure();
      const canonical = getProtectedMemoryEmbeddingConfiguration();
      const disclosure = getMemoryEmbeddingDisclosure();
      serviceAttemptSpy.mockImplementationOnce(async (input) => {
        scenario.drift();
        input.assertStillAuthorized?.();
        return input.invoke(() => {});
      });
      const error = await embedTextWithProvenance("private memory", undefined, {
        ...canonical,
        disclosure,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "unsupported_provider",
        message: "The approved embedding configuration changed. Prepare the Memory request again.",
      });
    }
    expect(fetches).toBe(0);
  });

  test("publishes only configured disclosure metadata and rejects stale consent before fetch", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    const approved = getProtectedMemoryEmbeddingConfiguration();
    expect(approved).toEqual({ provider: "openrouter",
      model: "openai/text-embedding-3-small", dimensions: 3 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as unknown as typeof fetch;
    process.env["VENICE_API_KEY"] = "new-venice-secret";
    const rejected: unknown = await embedTextWithProvenance("private Memory", undefined, approved)
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(EmbeddingProviderError);
    expect(rejected).toMatchObject({ message:
      "The approved embedding configuration changed. Prepare the Memory request again." });
    expect(calls).toBe(0);
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
    delete process.env["VENICE_API_KEY"];
    expect(await embedTextWithProvenance("private Memory", undefined, approved))
      .toMatchObject({ provider: "openrouter", canonicalModel: approved.model });
    expect(calls).toBe(1);
  });

  test("prefers OpenRouter over OpenAI when both keys exist", async () => {
    process.env["OPENAI_API_KEY"] = "openai-secret";
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    let request: { url: string; init: Parameters<typeof fetch>[1] } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: fetchInputUrl(input), init };
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    expect(await embedTexts(["hello"])).toEqual([[1, 2, 3]]);
    expect(request?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(request?.init?.headers).toEqual({
      Authorization: "Bearer openrouter-secret",
      "Content-Type": "application/json",
    });
    expect(request?.init?.redirect).toBeUndefined();
    expect(parseRequestBody(request?.init?.body)).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["hello"],
      dimensions: 3,
    });
  });

  test("retired managed Gateway variables do not redirect Venice embeddings", async () => {
    process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = `ngw_${"a".repeat(43)}`;
    process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = "https://gateway.qa.example/v1/";
    process.env["OPENROUTER_API_KEY"] = "direct-openrouter-secret-must-not-be-used";
    process.env["VENICE_API_KEY"] = "existing-venice-secret";
    let request: { url: string; init: Parameters<typeof fetch>[1] } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: fetchInputUrl(input), init };
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    expect(await embedTexts(["hello"])).toEqual([[1, 2, 3]]);
    expect(request?.url).toBe("https://api.venice.ai/api/v1/embeddings");
    expect(request?.init?.headers).toEqual({
      Authorization: "Bearer existing-venice-secret",
      "Content-Type": "application/json",
    });
    expect(parseRequestBody(request?.init?.body)).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 3,
    });
  });

  test("retired managed Gateway variables do not redirect OpenRouter embeddings", async () => {
    process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = `ngw_${"a".repeat(43)}`;
    process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = "https://gateway.qa.example/v1/";
    process.env["OPENROUTER_API_KEY"] = "direct-openrouter-secret";
    let request: { url: string; init: Parameters<typeof fetch>[1] } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: fetchInputUrl(input), init };
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    expect(await embedTexts(["hello"])).toEqual([[1, 2, 3]]);
    expect(request?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(request?.init?.headers).toEqual({
      Authorization: "Bearer direct-openrouter-secret",
      "Content-Type": "application/json",
    });
    expect(request?.init?.redirect).toBeUndefined();
    expect(parseRequestBody(request?.init?.body)).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["hello"],
      dimensions: 3,
    });
  });

  test("preserves a bare legacy model while using Venice, OpenRouter, then OpenAI credential priority", () => {
    process.env["OPENAI_API_KEY"] = "openai-secret";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "openrouter",
      model: "openai/text-embedding-3-small",
      dimensions: 3,
    });

    process.env["VENICE_API_KEY"] = "venice-secret";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "venice",
      model: "text-embedding-3-small",
      dimensions: 3,
    });
  });

  test("automatic selection uses Qwen3 8B on Venice and OpenRouter, then OpenAI small", () => {
    serverEmbeddingModel = "";
    serverPreferSurplus = true;
    process.env["SURPLUS_API_KEY"] = "surplus-secret";
    setConfigOverrides({
      nautilo_embedding_model: "",
      nautilo_embedding_dims: 1536,
    });

    process.env["OPENAI_API_KEY"] = "openai-secret";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3-embedding-8b",
      dimensions: 1536,
    });

    process.env["VENICE_API_KEY"] = "venice-secret";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "venice",
      model: "text-embedding-qwen3-8b",
      dimensions: 1536,
    });
    expect(surplusAttemptSpy).not.toHaveBeenCalled();
  });

  test("automatic OpenRouter dispatch requests Qwen3 8B at 1,536 dimensions", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    setConfigOverrides({
      nautilo_embedding_model: "",
      nautilo_embedding_dims: 1536,
    });
    let body: unknown;
    globalThis.fetch = (async (_input, init) => {
      body = parseRequestBody(init?.body);
      return embeddingResponse([{
        index: 0,
        embedding: Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0),
      }]);
    }) as typeof fetch;

    await embedTexts(["hello"]);
    expect(body).toEqual({
      model: "qwen/qwen3-embedding-8b",
      input: ["hello"],
      dimensions: 1536,
    });
  });

  test("uses OpenRouter with its canonical model id when OpenAI is absent", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    let request: { url: string; init: Parameters<typeof fetch>[1] } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: fetchInputUrl(input), init };
      return embeddingResponse([
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ]);
    }) as typeof fetch;

    expect(await embedTexts(["first", "second"])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(request?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(request?.init?.headers).toEqual({
      Authorization: "Bearer openrouter-secret",
      "Content-Type": "application/json",
    });
    expect(parseRequestBody(request?.init?.body)).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["first", "second"],
      dimensions: 3,
    });
  });

  test("returns exact OpenRouter provenance for Record embedding composition", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    const abort = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal;
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    expect(await embedTextWithProvenance("record statement", abort.signal)).toEqual({
      vector: [1, 2, 3],
      provider: "openrouter",
      canonicalModel: "openai/text-embedding-3-small",
      dimensions: 3,
      contractVersion: 1,
    });
    expect(requestSignal).toBe(abort.signal);
  });

  test("hands exact resolved service provenance and zero-token actual evidence to accounting", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    let attempt: serviceAttempt.ServiceEmbeddingAttemptInput<unknown> | undefined;
    let evidence: serviceAttempt.ServiceEmbeddingAttemptEvidence | undefined;
    serviceAttemptSpy.mockImplementation(async (input) => {
      attempt = input;
      return input.invoke((observed) => { evidence = observed; });
    });
    globalThis.fetch = (async () => Response.json({
      data: [{ index: 0, embedding: [1, 2, 3] }],
      usage: { prompt_tokens: 0, total_tokens: 0, cost: 0 },
    }, { headers: { "x-request-id": "embedding-request-1" } })) as unknown as typeof fetch;

    expect(await embedTexts(["hello"])).toEqual([[1, 2, 3]]);
    expect(attempt).toMatchObject({
      provider: "openrouter",
      model: "openai/text-embedding-3-small",
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      dimensions: 3,
    });
    expect(evidence).toEqual({
      inputTokens: 0,
      totalTokens: 0,
      actualCostUsd: 0,
      providerRequestId: "embedding-request-1",
    });
  });

  test("accepts an explicit OpenRouter-prefixed embedding model", async () => {
    process.env["OPENAI_API_KEY"] = "openai-secret-that-must-not-win";
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    setConfigOverrides({
      nautilo_embedding_model: "openrouter:qwen/qwen3-embedding-0.6b",
      nautilo_embedding_dims: 3,
    });
    let body: unknown;
    globalThis.fetch = (async (_input, init) => {
      body = parseRequestBody(init?.body);
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    await embedTexts(["hello"]);
    expect(body).toEqual({
      model: "qwen/qwen3-embedding-0.6b",
      input: ["hello"],
      dimensions: 3,
    });
  });

  test("pins an explicit provider and does not fall back when its credential is missing", async () => {
    process.env["VENICE_API_KEY"] = "venice-secret-that-must-not-win";
    setConfigOverrides({
      nautilo_embedding_model: "openai:text-embedding-3-small",
      nautilo_embedding_dims: 3,
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as unknown as typeof fetch;

    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "missing_credentials",
      provider: "openai",
      retryable: false,
    });
    expect(calls).toBe(0);
    expect(serviceAttemptSpy).not.toHaveBeenCalled();
  });

  test("preserves a custom bare model in OpenRouter canonical form", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    setConfigOverrides({
      nautilo_embedding_model: "custom-embedding-model",
      nautilo_embedding_dims: 3,
    });
    let body: unknown;
    globalThis.fetch = (async (_input, init) => {
      body = parseRequestBody(init?.body);
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    await embedTexts(["hello"]);
    expect(body).toEqual({
      model: "openai/custom-embedding-model",
      input: ["hello"],
      dimensions: 3,
    });
  });

  test("uses the cached server model override while null inherits runtime config", () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    process.env["OPENAI_API_KEY"] = "openai-secret";
    setConfigOverrides({
      nautilo_embedding_model: "runtime-custom-model",
      nautilo_embedding_dims: 3,
    });

    serverEmbeddingModel = "openai:server-custom-model";
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "openai",
      model: "server-custom-model",
      dimensions: 3,
    });

    serverEmbeddingModel = null;
    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "venice",
      model: "runtime-custom-model",
      dimensions: 3,
    });
  });

  test("distinguishes an explicit empty override from bypassing the server row", () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    setConfigOverrides({
      nautilo_embedding_model: "runtime-custom-model",
      nautilo_embedding_dims: 3,
    });
    serverEmbeddingModel = "";

    expect(getProtectedMemoryEmbeddingConfiguration()).toEqual({
      provider: "venice",
      model: "text-embedding-qwen3-8b",
      dimensions: 3,
    });

    serverEmbeddingModel = "venice:server-custom-model";

    expect(getProtectedMemoryEmbeddingConfiguration("")).toEqual({
      provider: "venice",
      model: "text-embedding-qwen3-8b",
      dimensions: 3,
    });
    expect(getProtectedMemoryEmbeddingConfiguration(null)).toEqual({
      provider: "venice",
      model: "runtime-custom-model",
      dimensions: 3,
    });
  });

  test("uses Venice embeddings when Venice is the only configured provider", async () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    let request: { url: string; init: Parameters<typeof fetch>[1] } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: fetchInputUrl(input), init };
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as typeof fetch;

    expect(await embedTexts(["hello"])).toEqual([[1, 2, 3]]);
    expect(request?.url).toBe("https://api.venice.ai/api/v1/embeddings");
    expect(parseRequestBody(request?.init?.body)).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 3,
    });
  });

  test("returns exact Venice provenance for Record embedding composition", async () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    globalThis.fetch = (async () => {
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as unknown as typeof fetch;

    expect(await embedTextWithProvenance("record statement")).toEqual({
      vector: [1, 2, 3],
      provider: "venice",
      canonicalModel: "text-embedding-3-small",
      dimensions: 3,
      contractVersion: 1,
    });
  });

  test("publishes Venice disclosure metadata and rejects provider drift before fetch", async () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    const approved = getProtectedMemoryEmbeddingConfiguration();
    expect(approved).toEqual({
      provider: "venice",
      model: "text-embedding-3-small",
      dimensions: 3,
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);
    }) as unknown as typeof fetch;
    delete process.env["VENICE_API_KEY"];
    process.env["OPENAI_API_KEY"] = "new-openai-secret";

    const failure = await embedTextWithProvenance("record statement", undefined, approved)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmbeddingProviderError);
    expect(failure).toMatchObject({
      code: "unsupported_provider",
      provider: "openai",
      status: null,
      retryable: false,
    });
    expect((failure as Error).message).toBe(
      "The approved embedding configuration changed. Prepare the Memory request again.",
    );
    expect(fetchCalls).toBe(0);
  });

  test("returns an actionable typed error when neither credential exists", async () => {
    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingProviderError);
    expect(failure).toMatchObject({
      code: "missing_credentials",
      provider: null,
      status: null,
      retryable: false,
    });
    expect((failure as Error).message).toContain("Venice, OpenRouter, or OpenAI");
  });

  test("redacts provider response bodies from request failures", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    const providerResponse = new Response('{"error":"openrouter-secret must never escape"}', {
      status: 401,
    });
    globalThis.fetch = (async () => providerResponse) as unknown as typeof fetch;

    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingProviderError);
    expect(failure).toMatchObject({
      code: "request_failed",
      provider: "openrouter",
      status: 401,
      retryable: false,
    });
    expect((failure as Error).message).toContain("Verify the OpenRouter credential");
    expect((failure as Error).message).not.toContain("openrouter-secret");
    expect(providerResponse.bodyUsed).toBe(false);
  });

  test("points model-not-found failures to both server and operator configuration", async () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("Server → Models");
    expect((failure as Error).message).toContain("operator embedding configuration");
    expect((failure as Error).message).not.toContain("NAUTILO_EMBEDDING_MODEL");
  });

  test("does not fail over after the selected provider returns an API error", async () => {
    process.env["VENICE_API_KEY"] = "venice-secret";
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    process.env["OPENAI_API_KEY"] = "openai-secret";
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(fetchInputUrl(input));
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "request_failed",
      provider: "venice",
      status: 503,
      retryable: true,
    });
    expect(urls).toEqual(["https://api.venice.ai/api/v1/embeddings"]);
  });

  test("rejects a dimension mismatch without exposing the response", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    globalThis.fetch = (async () =>
      embeddingResponse([{ index: 0, embedding: [1, 2] }])) as unknown as typeof fetch;

    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingProviderError);
    expect(failure).toMatchObject({
      code: "invalid_response",
      provider: "openrouter",
      status: null,
      retryable: true,
    });
    expect((failure as Error).message).toContain("Server → Models");
    expect((failure as Error).message).toContain("operator embedding configuration");
    expect((failure as Error).message).toContain("NAUTILO_EMBEDDING_DIMS");
    expect((failure as Error).message).not.toContain("[1,2]");
  });

  test("turns network failures into retryable provider-safe errors", async () => {
    process.env["OPENROUTER_API_KEY"] = "openrouter-secret";
    globalThis.fetch = (async () => {
      throw new Error("request leaked openrouter-secret");
    }) as unknown as typeof fetch;

    const failure = await embedTexts(["hello"]).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "request_failed",
      provider: "openrouter",
      status: null,
      retryable: true,
    });
    expect((failure as Error).message).not.toContain("openrouter-secret");
  });
});
