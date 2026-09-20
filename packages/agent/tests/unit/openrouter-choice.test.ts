import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import { ModelCatalogV4Schema, type ModelCatalog } from "@nautilo/types";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  ChoiceRequestError,
  invokeOpenRouterChoice,
  type OpenRouterChoiceInput,
} from "../../src/providers/openrouter-choice";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";
import { recordLlmUsage, type RecordUsageInput } from "../../src/usage/record-usage";
import { runWithUsageContext } from "../../src/usage/usage-context";

const JEV_ID = "openrouter:typesafe/jev-1.13";
const API_KEY = "openrouter-test-key-canary";
const PRIVATE_CANARY = "private-state-instructions-canary";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function input(overrides: Partial<OpenRouterChoiceInput> = {}): OpenRouterChoiceInput {
  return {
    modelId: JEV_ID,
    state: { page: PRIVATE_CANARY, controls: ["open", "wait"] },
    instructions: `Choose the next action for ${PRIVATE_CANARY}`,
    choices: [
      { id: "open", description: `Open details for ${PRIVATE_CANARY}` },
      { id: "wait", description: "Observe again" },
    ],
    signal: new AbortController().signal,
    tenantContext: { tenantId: "tenant-test" },
    ...overrides,
  };
}

function successPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "decision-safe-1",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: {
      candidate: {
        type: "choice",
        choice: "open",
        confidence: 0.9,
        probabilities: { open: 0.9, wait: 0.1 },
      },
    },
    usage: {
      input_tokens: 324,
      output_tokens: 31,
      cost: 0.000013608,
    },
    ...overrides,
  };
}

function fetchJson(
  payload: unknown,
  capture?: (url: string, init: RequestInit | undefined) => void,
): typeof fetch {
  return (async (
    request: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof request === "string"
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
    capture?.(url, init);
    return Response.json(payload);
  }) as unknown as typeof fetch;
}

function usageRecorder(onRecord?: () => void): {
  records: RecordUsageInput[];
  recordUsage: typeof recordLlmUsage;
} {
  const records: RecordUsageInput[] = [];
  return {
    records,
    recordUsage: (entry) => {
      records.push(entry);
      onRecord?.();
    },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ChoiceRequestError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ChoiceRequestError);
  return error as ChoiceRequestError;
}

function expectSafeFailure(
  error: ChoiceRequestError,
  expected: { code: ChoiceRequestError["code"]; status: number | null; retryable: boolean },
): void {
  expect(error).toMatchObject(expected);
  expect(error.message).not.toContain(PRIVATE_CANARY);
  expect(error.message).not.toContain(API_KEY);
  expect(error.message).not.toContain("provider-body-canary");
}

async function installCatalog(catalog: ModelCatalog): Promise<void> {
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-09-18T12:00:00.000Z",
        originUrl: "https://catalog.invalid/choice-test.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

function catalogWithOnlyDecisionProvider(provider: "openrouter" | "venice"): ModelCatalog {
  const current = getActiveModelCatalogSync().catalog;
  if (current.version !== 4 && current.version !== 5 && current.version !== 6) throw new Error("expected checked-in model catalog");
  const source = current.entries.find((entry) => entry.id === JEV_ID);
  if (!source || source.workload !== "decision") throw new Error("expected checked-in Jev row");
  const jev = { ...source, decision: { operations: ["choice"], inputTokens: 32000, maxChoices: 255 } };
  return ModelCatalogV4Schema.parse({
    ...current,
    version: 4,
    catalogVersion: "2026.09.18.2",
    entries: provider === "openrouter"
      ? [jev]
      : [{
          ...jev,
          id: "venice:jev-decision-test",
          displayName: "Unsupported Venice Decision Test",
          provider: "venice",
          routing: "venice-hosted",
        }],
  });
}

describe("invokeOpenRouterChoice", () => {
  let priorOpenRouterKey: string | undefined;
  let priorSkipVeniceRefresh: string | undefined;
  let priorVeniceCachePath: string | undefined;

  beforeEach(() => {
    resetRuntimeModelCatalog();
    resetModelCapabilitiesCacheForTests();
    resetVeniceCatalogCacheModuleForTests();
    priorOpenRouterKey = process.env["OPENROUTER_API_KEY"];
    priorSkipVeniceRefresh = process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    priorVeniceCachePath = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    delete process.env["OPENROUTER_API_KEY"];
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
    process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] =
      `/tmp/nautilo-choice-model-missing-${process.pid}/venice-models.json`;
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    resetModelCapabilitiesCacheForTests();
    resetVeniceCatalogCacheModuleForTests();
    if (priorOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorOpenRouterKey;
    if (priorSkipVeniceRefresh === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = priorSkipVeniceRefresh;
    if (priorVeniceCachePath === undefined) delete process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    else process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = priorVeniceCachePath;
  });

  test("posts the exact Choice envelope, returns safe identifiers, and records provider usage once", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const usage = usageRecorder();
    const result = await runWithUsageContext({
      callType: "subagent",
      userId: "user-safe",
      roomId: ROOM_ID,
      metadata: { agentId: "agent-safe", turnId: "turn-safe" },
    }, () => invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload(), (url, init) => requests.push({ url, ...(init ? { init } : {}) })),
      recordUsage: usage.recordUsage,
    }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.redirect).toBe("error");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    const requestBody = requests[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") throw new Error("expected JSON request body");
    expect(JSON.parse(requestBody)).toEqual({
      model: "typesafe/jev-1.13",
      state: { page: PRIVATE_CANARY, controls: ["open", "wait"] },
      questions: {
        candidate: {
          type: "choice",
          instructions: `Choose the next action for ${PRIVATE_CANARY}`,
          criteria: {
            open: `Open details for ${PRIVATE_CANARY}`,
            wait: "Observe again",
          },
        },
      },
    });
    expect(result).toEqual({
      selectedId: "open",
      requestedModelId: JEV_ID,
      resolvedModelId: "typesafe/jev-1.13-20260917",
      confidence: 0.9,
      probabilities: { open: 0.9, wait: 0.1 },
      provider: "TypeSafe",
      responseId: "decision-safe-1",
      usage: { inputTokens: 324, outputTokens: 31, actualCostUsd: 0.000013608 },
    });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      model: JEV_ID,
      callType: "subagent",
      userId: "user-safe",
      roomId: ROOM_ID,
      inputTokens: 324,
      outputTokens: 31,
      totalTokens: 355,
      actualCostUsd: 0.000013608,
      metadata: {
        agentId: "agent-safe",
        turnId: "turn-safe",
        operation: "choice",
        resolvedProviderModel: "typesafe/jev-1.13-20260917",
        providerRoute: "TypeSafe",
        providerResponseId: "decision-safe-1",
      },
    });
    expect(JSON.stringify(usage.records[0])).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(usage.records[0])).not.toContain(API_KEY);
  });

  test("accepts missing optional response fields and records null actual cost", async () => {
    const usage = usageRecorder();
    const result = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson({
        model: "typesafe/jev-1.13",
        answers: { candidate: { type: "choice", choice: "wait" } },
        usage: { input_tokens: 8, output_tokens: 2 },
      }),
      recordUsage: usage.recordUsage,
    });

    expect(result).toEqual({
      selectedId: "wait",
      requestedModelId: JEV_ID,
      resolvedModelId: "typesafe/jev-1.13",
      usage: { inputTokens: 8, outputTokens: 2, actualCostUsd: null },
    });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      model: JEV_ID,
      callType: "other",
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
    });
    expect(usage.records[0]?.actualCostUsd).toBeUndefined();
  });

  test("rejects invalid local requests before credentials or fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json(successPayload());
    }) as unknown as typeof fetch;
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const invalid: OpenRouterChoiceInput[] = [
      input({ choices: [] }),
      input({ choices: [{ id: "", description: "empty id" }] }),
      input({ choices: [{ id: "a", description: "A" }, { id: "a", description: "Again" }] }),
      input({ choices: Array.from({ length: 256 }, (_, index) => ({ id: `c${index}`, description: `C${index}` })) }),
      input({ state: circular }),
      input({ state: { invalid: 1n } }),
      input({ modelId: 42 as unknown as string }),
      input({ instructions: { invalid: true } as unknown as string }),
      input({ choices: "invalid" as unknown as OpenRouterChoiceInput["choices"] }),
      input({
        choices: [{ id: "open", description: 42 as unknown as string }],
      }),
    ];

    for (const candidate of invalid) {
      const error = await failureOf(invokeOpenRouterChoice(candidate, { apiKey: API_KEY, fetch: fetchImpl }));
      expectSafeFailure(error, { code: "invalid_request", status: null, retryable: false });
    }
    expect(fetchCalls).toBe(0);
  });

  test("requires a credential after local request validation", async () => {
    let fetchCalls = 0;
    const error = await failureOf(invokeOpenRouterChoice(input(), {
      fetch: (async () => {
        fetchCalls += 1;
        return Response.json(successPayload());
      }) as unknown as typeof fetch,
    }));
    expectSafeFailure(error, { code: "missing_credentials", status: null, retryable: false });
    expect(fetchCalls).toBe(0);
  });

  test("prefers an injected credential and otherwise falls back to the environment key", async () => {
    const environmentKey = "environment-openrouter-key";
    process.env["OPENROUTER_API_KEY"] = environmentKey;
    const authorizations: string[] = [];
    const fetchImpl = fetchJson(successPayload(), (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    });

    await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchImpl,
      recordUsage: usageRecorder().recordUsage,
    });
    await invokeOpenRouterChoice(input(), {
      fetch: fetchImpl,
      recordUsage: usageRecorder().recordUsage,
    });

    expect(authorizations).toEqual([
      `Bearer ${API_KEY}`,
      `Bearer ${environmentKey}`,
    ]);
  });

  test("rejects chat rows and unsupported decision-provider pairs before fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json(successPayload());
    }) as unknown as typeof fetch;

    const chatError = await failureOf(invokeOpenRouterChoice(input({
      modelId: "openrouter:minimax/minimax-m3",
    }), { apiKey: API_KEY, fetch: fetchImpl }));
    expectSafeFailure(chatError, { code: "unsupported_model", status: null, retryable: false });

    await installCatalog(catalogWithOnlyDecisionProvider("venice"));
    const providerError = await failureOf(invokeOpenRouterChoice(input({
      modelId: "venice:jev-decision-test",
    }), { apiKey: API_KEY, fetch: fetchImpl }));
    expectSafeFailure(providerError, { code: "unsupported_model", status: null, retryable: false });
    expect(fetchCalls).toBe(0);
  });

  test("re-resolves catalog authority and refuses a row revoked after an earlier success", async () => {
    let fetchCalls = 0;
    const usage = usageRecorder();
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json(successPayload());
    }) as unknown as typeof fetch;

    await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchImpl,
      recordUsage: usage.recordUsage,
    });
    expect(fetchCalls).toBe(1);
    expect(usage.records).toHaveLength(1);

    const current = catalogWithOnlyDecisionProvider("openrouter");
    if (current.version !== 4 && current.version !== 5 && current.version !== 6) throw new Error("expected v4 decision catalog");
    const revoked = ModelCatalogV4Schema.parse({
      ...current,
      version: 4,
      catalogVersion: "2026.09.18.3",
      entries: current.entries.map((entry) => ({ ...entry, defaultEnabled: false })),
    });
    await installCatalog(revoked);

    const error = await failureOf(invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchImpl,
      recordUsage: usage.recordUsage,
    }));
    expectSafeFailure(error, { code: "unsupported_model", status: null, retryable: false });
    expect(fetchCalls).toBe(1);
    expect(usage.records).toHaveLength(1);
  });

  test("recognizes a structured upstream context error without exposing the response body", async () => {
    for (const payload of [
      { error: { message: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}', code: 400 } },
      { detail: { error_type: "max_tokens_exceeded" } },
      { error: { code: "context_length_exceeded" } },
    ]) {
      const failure = await invokeOpenRouterChoice(input(), { apiKey: API_KEY,
        fetch: (async () => Response.json(payload, { status: 400 })) as unknown as typeof fetch,
        recordUsage: usageRecorder().recordUsage,
      }).catch((error: unknown) => error);
      if (!(failure instanceof ChoiceRequestError)) throw new Error("Expected a classified Choice failure");
      expectSafeFailure(failure, { code: "context_length_exceeded", status: 400, retryable: false });
    }
  });

  test("classifies every HTTP status without echoing provider bodies and never retries", async () => {
    for (const status of [400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529]) {
      let fetchCalls = 0;
      const error = await failureOf(invokeOpenRouterChoice(input(), {
        apiKey: API_KEY,
        fetch: (async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ error: `provider-body-canary ${PRIVATE_CANARY} ${API_KEY}` }), {
            status,
            statusText: "provider-body-canary",
          });
        }) as unknown as typeof fetch,
      }));
      expectSafeFailure(error, {
        code: "provider_error",
        status,
        retryable: [429, 500, 502, 503, 524, 529].includes(status),
      });
      expect(fetchCalls).toBe(1);
    }
  });

  test("turns network failures into one retryable, secret-safe error without retrying", async () => {
    let fetchCalls = 0;
    const error = await failureOf(invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: (async () => {
        fetchCalls += 1;
        throw new Error(`provider-body-canary ${PRIVATE_CANARY} ${API_KEY}`);
      }) as unknown as typeof fetch,
    }));
    expectSafeFailure(error, { code: "network_error", status: null, retryable: true });
    expect(fetchCalls).toBe(1);
  });

  test("honors cancellation before, during, after fetch, and after a billed response", async () => {
    const pre = new AbortController();
    pre.abort(new Error(PRIVATE_CANARY));
    let preFetches = 0;
    const preError = await failureOf(invokeOpenRouterChoice(input({ signal: pre.signal }), {
      apiKey: API_KEY,
      fetch: (async () => {
        preFetches += 1;
        return Response.json(successPayload());
      }) as unknown as typeof fetch,
    }));
    expectSafeFailure(preError, { code: "cancelled", status: null, retryable: false });
    expect(preFetches).toBe(0);

    const during = new AbortController();
    const forwardedSignals: AbortSignal[] = [];
    const duringPromise = invokeOpenRouterChoice(input({ signal: during.signal }), {
      apiKey: API_KEY,
      fetch: ((_, init) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal) forwardedSignals.push(init.signal);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as typeof fetch,
    });
    await Promise.resolve();
    during.abort();
    const duringError = await failureOf(duringPromise);
    expectSafeFailure(duringError, { code: "cancelled", status: null, retryable: false });
    expect(forwardedSignals).toEqual([during.signal]);

    const afterFetch = new AbortController();
    const afterFetchUsage = usageRecorder();
    const afterFetchError = await failureOf(invokeOpenRouterChoice(input({ signal: afterFetch.signal }), {
      apiKey: API_KEY,
      fetch: (async () => {
        afterFetch.abort();
        return Response.json(successPayload());
      }) as unknown as typeof fetch,
      recordUsage: afterFetchUsage.recordUsage,
    }));
    expectSafeFailure(afterFetchError, { code: "cancelled", status: null, retryable: false });
    expect(afterFetchUsage.records).toHaveLength(1);

    const post = new AbortController();
    const postUsage = usageRecorder(() => post.abort());
    const postError = await failureOf(invokeOpenRouterChoice(input({ signal: post.signal }), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload()),
      recordUsage: postUsage.recordUsage,
    }));
    expectSafeFailure(postError, { code: "cancelled", status: null, retryable: false });
    expect(postUsage.records).toHaveLength(1);
  });

  test("records valid provider usage once before rejecting a malformed answer envelope", async () => {
    const payloads = [
      successPayload({
        answers: { candidate: { type: "choice", choice: "private-out-of-set-answer" } },
      }),
      successPayload({ model: undefined }),
      successPayload({ answers: { candidate: { choice: "open" } } }),
    ];
    for (const payload of payloads) {
      const usage = usageRecorder();
      const error = await failureOf(invokeOpenRouterChoice(input(), {
        apiKey: API_KEY,
        fetch: fetchJson(payload),
        recordUsage: usage.recordUsage,
      }));
      expectSafeFailure(error, { code: "invalid_response", status: null, retryable: false });
      expect(error.message).not.toContain("private-out-of-set-answer");
      expect(usage.records).toHaveLength(1);
    }
  });

  test("omits control-bearing optional provider identifiers from results and usage metadata", async () => {
    const usage = usageRecorder();
    const result = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload({
        id: "provider-body-canary\nunsafe",
        provider: "provider-body-canary\nunsafe",
      })),
      recordUsage: usage.recordUsage,
    });
    expect(result.provider).toBeUndefined();
    expect(result.responseId).toBeUndefined();
    expect(usage.records[0]?.metadata).toEqual({
      operation: "choice",
      resolvedProviderModel: "typesafe/jev-1.13-20260917",
    });
    expect(JSON.stringify(usage.records[0])).not.toContain("provider-body-canary");
  });

  test("omits optional identifiers containing the actual credential", async () => {
    const usage = usageRecorder();
    const result = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload({
        id: `decision ${API_KEY}`,
        provider: `TypeSafe ${API_KEY}`,
      })),
      recordUsage: usage.recordUsage,
    });
    expect(result.provider).toBeUndefined();
    expect(result.responseId).toBeUndefined();
    expect(usage.records[0]?.metadata).toEqual({
      operation: "choice",
      resolvedProviderModel: "typesafe/jev-1.13-20260917",
    });
    expect(JSON.stringify(usage.records[0])).not.toContain(API_KEY);
  });

  test("accepts the provider's required model string without a local slug whitelist", async () => {
    const usage = usageRecorder();
    const providerModel = "routing-layer/model@2026.09";
    const result = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload({
        model: providerModel,
        id: "decision_[route]@2026",
        provider: "TypeSafe (routed)",
      })),
      recordUsage: usage.recordUsage,
    });

    expect(result.selectedId).toBe("open");
    expect(result.resolvedModelId).toBe(providerModel);
    expect(result.responseId).toBe("decision_[route]@2026");
    expect(result.provider).toBe("TypeSafe (routed)");
    expect(usage.records[0]?.model).toBe(JEV_ID);
    expect(usage.records[0]?.metadata).toMatchObject({
      operation: "choice",
      resolvedProviderModel: providerModel,
      providerRoute: "TypeSafe (routed)",
      providerResponseId: "decision_[route]@2026",
    });
  });

  test("redacts a credential-bearing model string without discarding an in-set choice", async () => {
    const usage = usageRecorder();
    const unsafeModel = `typesafe/jev-1.13-${API_KEY}`;
    const result = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload({ model: unsafeModel })),
      recordUsage: usage.recordUsage,
    });

    expect(result.selectedId).toBe("open");
    expect(result.resolvedModelId).toBeNull();
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]?.model).toBe(JEV_ID);
    expect(usage.records[0]?.metadata).not.toHaveProperty("resolvedProviderModel");
    expect(JSON.stringify(usage.records[0])).not.toContain(API_KEY);
  });

  test("does not record malformed JSON or missing/invalid usage", async () => {
    const cases: Array<{ response: Response; label: string }> = [
      { response: new Response("{provider-body-canary", { status: 200 }), label: "malformed JSON" },
      {
        response: Response.json({
          model: "typesafe/jev-1.13",
          answers: { candidate: { type: "choice", choice: "open" } },
        }),
        label: "missing usage",
      },
      {
        response: Response.json({
          model: "typesafe/jev-1.13",
          answers: { candidate: { type: "choice", choice: "open" } },
          usage: { input_tokens: -1, output_tokens: 2 },
        }),
        label: "invalid usage",
      },
    ];
    for (const { response, label } of cases) {
      const usage = usageRecorder();
      const error = await failureOf(invokeOpenRouterChoice(input(), {
        apiKey: API_KEY,
        fetch: (async () => response) as unknown as typeof fetch,
        recordUsage: usage.recordUsage,
      }));
      expectSafeFailure(error, { code: "invalid_response", status: null, retryable: false });
      expect(usage.records, label).toHaveLength(0);
    }
  });

  test("retains valid confidence and probability metadata, including selected ties", async () => {
    const result = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload({
        answers: {
          candidate: {
            type: "choice",
            choice: "wait",
            confidence: 1,
            probabilities: { open: 0.25, wait: 0.75 },
          },
        },
      })),
      recordUsage: usageRecorder().recordUsage,
    });
    expect(result.selectedId).toBe("wait");
    expect(result.probabilities).toEqual({ open: 0.25, wait: 0.75 });

    const tied = await invokeOpenRouterChoice(input(), {
      apiKey: API_KEY,
      fetch: fetchJson(successPayload({
        answers: {
          candidate: { type: "choice", choice: "open", probabilities: { open: 0.5, wait: 0.5 } },
        },
      })),
      recordUsage: usageRecorder().recordUsage,
    });
    expect(tied.selectedId).toBe("open");
  });

  test("accepts optional probability metadata without completeness, argmax, or normalization policy", async () => {
    const providerProbabilities: Array<Record<string, number>> = [
      { open: 1 },
      { open: 0.5, wait: 0.4, extra: 0.1 },
      { open: 0.7, wait: 0.4 },
      { open: 0.4, wait: 0.6 },
    ];
    for (const probabilities of providerProbabilities) {
      const result = await invokeOpenRouterChoice(input(), {
        apiKey: API_KEY,
        fetch: fetchJson(successPayload({
          answers: { candidate: { type: "choice", choice: "open", probabilities } },
        })),
        recordUsage: usageRecorder().recordUsage,
      });
      expect(result.selectedId).toBe("open");
      expect(result.probabilities).toEqual(probabilities);
    }
  });

  test("drops malformed or out-of-range optional score metadata without discarding selection", async () => {
    const usage = usageRecorder();
    const optionalMetadata = [
      { confidence: "not-a-number", probabilities: { open: "not-a-number" } },
      { confidence: -0.1, probabilities: { open: -0.1, wait: 1.1 } },
      { confidence: 1.1, probabilities: { open: 1.1, wait: -0.1 } },
    ];
    for (const metadata of optionalMetadata) {
      const result = await invokeOpenRouterChoice(input(), {
        apiKey: API_KEY,
        fetch: fetchJson(successPayload({
          answers: {
            candidate: {
              type: "choice",
              choice: "open",
              ...metadata,
            },
          },
        })),
        recordUsage: usage.recordUsage,
      });
      expect(result.selectedId).toBe("open");
      expect(result.confidence).toBeUndefined();
      expect(result.probabilities).toBeUndefined();
    }
    expect(usage.records).toHaveLength(optionalMetadata.length);
  });
});
