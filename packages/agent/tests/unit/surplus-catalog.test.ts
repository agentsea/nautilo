import { afterEach, describe, expect, test } from "bun:test";
import {
  configureSurplusModelCatalog,
  getSurplusModelMetadataSync,
  hydrateSurplusModelCatalog,
  invalidateSurplusModelCatalog,
  resetSurplusModelCatalog,
} from "../../src/providers/surplus-catalog";

const LIST_URL = "https://api.surplusintelligence.ai/v1/models";

function modelRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    context_length: 200_000,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    top_provider: {
      context_length: 180_000,
      max_completion_tokens: 32_000,
    },
    supported_parameters: ["max_tokens"],
    supported_features: ["streaming"],
    ...overrides,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(
  implementation: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return implementation(url, init);
  }) as typeof fetch;
}

afterEach(() => resetSurplusModelCatalog());

describe("Surplus model catalog", () => {
  test("sync reads never initiate discovery", () => {
    let calls = 0;
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return json({ data: [modelRow("canonical")] });
      }),
    });

    expect(getSurplusModelMetadataSync("canonical")).toBeNull();
    expect(calls).toBe(0);
  });

  test("publishes conservative token limits and canonical capability fields", async () => {
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => json({
        data: [modelRow("capable", {
          context_length: 190_000,
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
          top_provider: {
            context_length: 180_000,
            max_completion_tokens: 220_000,
          },
          supported_parameters: ["max_tokens", "tools", "reasoning"],
          supported_features: ["streaming"],
        })],
      })),
    });

    await hydrateSurplusModelCatalog(["capable"]);

    expect(getSurplusModelMetadataSync("capable")).toEqual({
      id: "capable",
      contextTokens: 180_000,
      maxOutputTokens: 180_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsStreaming: true,
      supportedParameters: ["max_tokens", "tools", "reasoning"],
    });
  });

  test("accepts an exact alias only when its detail canonical id is in the same list", async () => {
    const urls: string[] = [];
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch((url, init) => {
        urls.push(url);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return url === LIST_URL
          ? json({ data: [modelRow("claude-sonnet-4.6")] })
          : json(modelRow("claude-sonnet-4.6"));
      }),
    });

    await hydrateSurplusModelCatalog(["anthropic/claude-sonnet-4.6"]);

    expect(urls).toEqual([
      LIST_URL,
      `${LIST_URL}/anthropic%2Fclaude-sonnet-4.6`,
    ]);
    expect(getSurplusModelMetadataSync("anthropic/claude-sonnet-4.6")?.id)
      .toBe("claude-sonnet-4.6");
  });

  test("rejects a detail canonical id missing from the validated list", async () => {
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch((url) => url === LIST_URL
        ? json({ data: [modelRow("listed")] })
        : json(modelRow("unlisted"))),
    });

    await hydrateSurplusModelCatalog(["vendor/requested"]);

    expect(getSurplusModelMetadataSync("vendor/requested")).toBeNull();
    expect(getSurplusModelMetadataSync("unlisted")).toBeNull();
  });

  test("caches 404 aliases for a snapshot but resolves a new requested alias against a fresh list", async () => {
    let listCalls = 0;
    const detailCalls = new Map<string, number>();
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch((url) => {
        if (url === LIST_URL) {
          listCalls += 1;
          return json({ data: [modelRow("canonical")] });
        }
        detailCalls.set(url, (detailCalls.get(url) ?? 0) + 1);
        if (url.endsWith("missing")) return json({ error: "missing" }, 404);
        return json(modelRow("canonical"));
      }),
    });

    await hydrateSurplusModelCatalog(["missing"]);
    await hydrateSurplusModelCatalog(["missing"]);
    await hydrateSurplusModelCatalog(["new/alias"]);

    expect(listCalls).toBe(1);
    expect(detailCalls.get(`${LIST_URL}/missing`)).toBe(1);
    expect(detailCalls.get(`${LIST_URL}/new%2Falias`)).toBe(1);
    expect(getSurplusModelMetadataSync("new/alias")?.id).toBe("canonical");
  });

  test("deduplicates list and exact detail work across concurrent hydrations", async () => {
    let listCalls = 0;
    let detailCalls = 0;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(async (url) => {
        if (url === LIST_URL) {
          listCalls += 1;
          await listGate;
          return json({ data: [modelRow("canonical")] });
        }
        detailCalls += 1;
        return json(modelRow("canonical"));
      }),
    });

    const first = hydrateSurplusModelCatalog(["vendor/alias"]);
    const second = hydrateSurplusModelCatalog(["vendor/alias"]);
    releaseList();
    await Promise.all([first, second]);

    expect(listCalls).toBe(1);
    expect(detailCalls).toBe(1);
    expect(getSurplusModelMetadataSync("vendor/alias")?.id).toBe("canonical");
  });

  test("cancelling one caller returns promptly without aborting its shared exact lookup", async () => {
    let detailCalls = 0;
    let detailSignal: AbortSignal | undefined;
    let detailStarted!: () => void;
    const started = new Promise<void>((resolve) => { detailStarted = resolve; });
    let releaseDetail!: () => void;
    const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(async (url, init) => {
        if (url === LIST_URL) return json({ data: [modelRow("canonical")] });
        detailCalls += 1;
        detailSignal = init?.signal ?? undefined;
        detailStarted();
        await detailGate;
        return json(modelRow("canonical"));
      }),
    });
    await hydrateSurplusModelCatalog();

    const first = hydrateSurplusModelCatalog(["vendor/shared"]);
    await started;
    const controller = new AbortController();
    const cancelled = hydrateSurplusModelCatalog(["vendor/shared"], { signal: controller.signal });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await Promise.race([
      cancelled,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("cancelled hydration did not return promptly")), 250);
      }),
    ]);

    expect(detailCalls).toBe(1);
    expect(detailSignal?.aborted).toBe(false);
    releaseDetail();
    await first;
    expect(getSurplusModelMetadataSync("vendor/shared")?.id).toBe("canonical");
  });

  test("caller cancellation removes zero-consumer queued work without network or backoff", async () => {
    const blockerReleases: Array<() => void> = [];
    let blockersStarted = 0;
    let fourStarted!: () => void;
    const started = new Promise<void>((resolve) => { fourStarted = resolve; });
    let cancelledAliasCalls = 0;
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(async (url) => {
        if (url === LIST_URL) return json({ data: [modelRow("canonical")] });
        if (url.endsWith("cancelled")) {
          cancelledAliasCalls += 1;
          return json(modelRow("canonical"));
        }
        blockersStarted += 1;
        if (blockersStarted === 4) fourStarted();
        await new Promise<void>((resolve) => blockerReleases.push(resolve));
        return json({ error: "missing" }, 404);
      }),
    });
    await hydrateSurplusModelCatalog();

    const blockers = hydrateSurplusModelCatalog(
      Array.from({ length: 4 }, (_, index) => `vendor/blocker-${index}`),
    );
    await started;
    const controller = new AbortController();
    const cancelled = hydrateSurplusModelCatalog(["vendor/cancelled"], { signal: controller.signal });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await cancelled;
    expect(cancelledAliasCalls).toBe(0);

    for (const release of blockerReleases) release();
    await blockers;
    await hydrateSurplusModelCatalog(["vendor/cancelled"]);
    expect(cancelledAliasCalls).toBe(1);
    expect(getSurplusModelMetadataSync("vendor/cancelled")?.id).toBe("canonical");
  });

  test("an exact waiter survives the broad hydration deadline on a shared queued job", async () => {
    const target = "vendor/exact-target";
    let detailStarts = 0;
    let firstFourStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstFourStarted = resolve; });
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch((url, init) => {
        if (url === LIST_URL) return json({ data: [modelRow("canonical")] });
        detailStarts += 1;
        if (url.endsWith(encodeURIComponent(target))) return json(modelRow("canonical"));
        if (detailStarts === 4) firstFourStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }),
    });

    const broadIds = [
      "vendor/broad-0", "vendor/broad-1", "vendor/broad-2", "vendor/broad-3",
      "vendor/broad-4", "vendor/broad-5", target,
    ];
    const broad = hydrateSurplusModelCatalog(broadIds);
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    const exact = hydrateSurplusModelCatalog([target]);

    await Promise.all([broad, exact]);
    expect(detailStarts).toBe(5);
    expect(getSurplusModelMetadataSync(target)?.id).toBe("canonical");
  }, 10_000);

  test("ignores bad and non-chat rows and removes ambiguous duplicate ids", async () => {
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => json({
        data: [
          modelRow("duplicate"),
          modelRow("duplicate", { context_length: 90_000 }),
          modelRow("media", {
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          }),
          modelRow("bad-token", {
            top_provider: { context_length: 180_000, max_completion_tokens: 0 },
          }),
          modelRow("usable", { supported_features: ["vision", "reasoning"] }),
          null,
        ],
      })),
    });

    await hydrateSurplusModelCatalog();

    expect(getSurplusModelMetadataSync("duplicate")).toBeNull();
    expect(getSurplusModelMetadataSync("media")).toBeNull();
    expect(getSurplusModelMetadataSync("bad-token")).toBeNull();
    expect(getSurplusModelMetadataSync("usable")).toMatchObject({
      supportsVision: true,
      supportsReasoning: false,
    });
  });

  test.each([
    ["reasoning", true], ["reasoning_effort", true], ["include_reasoning", false],
  ] as const)("reasoning capability requires an actionable %s parameter", async (parameter, expected) => {
    configureSurplusModelCatalog({ fetchImpl: fakeFetch(() => json({ data: [modelRow("reasoning-model", {
      supported_parameters: ["max_tokens", parameter],
      supported_features: ["streaming", "reasoning"],
    })] })) });
    await hydrateSurplusModelCatalog();
    expect(getSurplusModelMetadataSync("reasoning-model")?.supportsReasoning).toBe(expected);
  });

  test("retains a valid last-known-good snapshot on invalid refresh and fails closed after max stale", async () => {
    let clock = 0;
    let calls = 0;
    configureSurplusModelCatalog({
      now: () => clock,
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return calls === 1
          ? json({ data: [modelRow("known")] })
          : json({ data: [] });
      }),
    });
    await hydrateSurplusModelCatalog();

    clock = 60_000;
    await hydrateSurplusModelCatalog();
    expect(getSurplusModelMetadataSync("known")?.id).toBe("known");
    expect(calls).toBe(2);

    clock = 65_000;
    await hydrateSurplusModelCatalog();
    expect(calls).toBe(2);

    clock = 300_001;
    expect(getSurplusModelMetadataSync("known")).toBeNull();
  });

  test("transient detail errors are retryable after backoff and never become negative aliases", async () => {
    let clock = 0;
    let detailCalls = 0;
    configureSurplusModelCatalog({
      now: () => clock,
      fetchImpl: fakeFetch((url) => {
        if (url === LIST_URL) return json({ data: [modelRow("canonical")] });
        detailCalls += 1;
        if (detailCalls === 1) throw new Error("network unavailable");
        return json(modelRow("canonical"));
      }),
    });

    await hydrateSurplusModelCatalog(["vendor/alias"]);
    expect(getSurplusModelMetadataSync("vendor/alias")).toBeNull();
    clock = 9_999;
    await hydrateSurplusModelCatalog(["vendor/alias"]);
    expect(detailCalls).toBe(1);
    clock = 10_000;
    await hydrateSurplusModelCatalog(["vendor/alias"]);
    expect(detailCalls).toBe(2);
    expect(getSurplusModelMetadataSync("vendor/alias")?.id).toBe("canonical");
  });

  test("invalidate keeps the bounded LKG and makes the next hydration refresh", async () => {
    let calls = 0;
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return json({ data: [modelRow(calls === 1 ? "first" : "second")] });
      }),
    });
    await hydrateSurplusModelCatalog();

    invalidateSurplusModelCatalog();
    expect(calls).toBe(1);
    expect(getSurplusModelMetadataSync("first")?.id).toBe("first");

    await hydrateSurplusModelCatalog();
    expect(calls).toBe(2);
    expect(getSurplusModelMetadataSync("first")).toBeNull();
    expect(getSurplusModelMetadataSync("second")?.id).toBe("second");
  });

  test("reset fences an in-flight response from later publication", async () => {
    let release!: (response: Response) => void;
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => new Promise<Response>((resolve) => { release = resolve; })),
    });

    const hydration = hydrateSurplusModelCatalog();
    resetSurplusModelCatalog();
    configureSurplusModelCatalog({ enabled: false });
    release(json({ data: [modelRow("late")] }));
    await hydration;

    expect(getSurplusModelMetadataSync("late")).toBeNull();
  });

  test("reset aborts active details and drains queued work without starting it", async () => {
    let detailStarts = 0;
    let fourStarted!: () => void;
    const started = new Promise<void>((resolve) => { fourStarted = resolve; });
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch((url, init) => {
        if (url === LIST_URL) return json({ data: [modelRow("canonical")] });
        detailStarts += 1;
        if (detailStarts === 4) fourStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }),
    });

    const hydration = hydrateSurplusModelCatalog(
      Array.from({ length: 7 }, (_, index) => `vendor/queued-${index}`),
    );
    await started;
    resetSurplusModelCatalog();
    await Promise.race([
      hydration,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("reset did not drain detail waiters")), 250);
      }),
    ]);

    expect(detailStarts).toBe(4);
    expect(getSurplusModelMetadataSync("canonical")).toBeNull();
  });

  test("a slow older alias lookup cannot roll back a newer forced snapshot", async () => {
    let listCalls = 0;
    let aliasStarted!: () => void;
    const started = new Promise<void>((resolve) => { aliasStarted = resolve; });
    let releaseAlias!: () => void;
    const aliasGate = new Promise<void>((resolve) => { releaseAlias = resolve; });
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(async (url) => {
        if (url === LIST_URL) {
          listCalls += 1;
          return json({ data: [modelRow(listCalls === 1 ? "old" : "new")] });
        }
        aliasStarted();
        await aliasGate;
        return json(modelRow("old"));
      }),
    });

    const older = hydrateSurplusModelCatalog(["vendor/alias"]);
    await started;
    await hydrateSurplusModelCatalog([], { force: true });
    releaseAlias();
    await older;

    expect(getSurplusModelMetadataSync("old")).toBeNull();
    expect(getSurplusModelMetadataSync("vendor/alias")).toBeNull();
    expect(getSurplusModelMetadataSync("new")?.id).toBe("new");
  });

  test("network failure resolves without publishing and disabled discovery makes no request", async () => {
    let calls = 0;
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => {
        calls += 1;
        throw new Error("offline");
      }),
    });
    await hydrateSurplusModelCatalog(["model"]);
    expect(getSurplusModelMetadataSync("model")).toBeNull();

    configureSurplusModelCatalog({
      enabled: false,
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return json({ data: [modelRow("model")] });
      }),
    });
    await hydrateSurplusModelCatalog(["model"]);
    expect(calls).toBe(1);
  });

  test("one hydration deadline drops queued aliases, publishes canonical LKG, and backs off repeats", async () => {
    let listCalls = 0;
    let detailStarts = 0;
    const detailSignals: AbortSignal[] = [];
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch((url, init) => {
        if (url === LIST_URL) {
          listCalls += 1;
          return json({ data: [modelRow(listCalls === 1 ? "old" : "current")] });
        }
        detailStarts += 1;
        if (init?.signal) detailSignals.push(init.signal);
        // Deliberately ignore abort to prove the aggregate hydration race is
        // bounded independently from provider fetch compliance.
        return new Promise<Response>(() => undefined);
      }),
    });
    await hydrateSurplusModelCatalog();

    const aliases = Array.from({ length: 7 }, (_, index) => `vendor/alias-${index}`);
    await hydrateSurplusModelCatalog(aliases, { force: true });

    expect(listCalls).toBe(2);
    expect(detailStarts).toBe(4);
    expect(detailSignals).toHaveLength(4);
    expect(detailSignals.every((signal) => signal.aborted)).toBe(true);
    expect(getSurplusModelMetadataSync("old")).toBeNull();
    expect(getSurplusModelMetadataSync("current")?.id).toBe("current");
    for (const alias of aliases) expect(getSurplusModelMetadataSync(alias)).toBeNull();

    await hydrateSurplusModelCatalog(aliases);
    expect(detailStarts).toBe(4);
  }, 7_000);

  test("fails closed explicitly when the caller exceeds the requested-id bound", async () => {
    let calls = 0;
    configureSurplusModelCatalog({
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return json({ data: [modelRow("model")] });
      }),
    });

    let failure: unknown;
    try {
      await hydrateSurplusModelCatalog(
        Array.from({ length: 129 }, (_, index) => `model-${index}`),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });
});
