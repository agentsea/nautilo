import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PersonalProviderId } from "@nautilo/db";
import { validatePersonalProviderCredential } from "../../src/lib/personal-provider-validation";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("validatePersonalProviderCredential", () => {
  test("maps authentication success, rejection, and transient failures", async () => {
    const statuses = [200, 401, 403, 429, 503];
    globalThis.fetch = (async () =>
      new Response(null, { status: statuses.shift()! })) as unknown as typeof fetch;

    expect(await validatePersonalProviderCredential("openai", "submitted-key"))
      .toEqual({ status: "accepted" });
    expect(await validatePersonalProviderCredential("openai", "submitted-key"))
      .toEqual({ status: "rejected" });
    expect(await validatePersonalProviderCredential("openai", "submitted-key"))
      .toEqual({ status: "unavailable" });
    expect(await validatePersonalProviderCredential("openai", "submitted-key"))
      .toEqual({ status: "unavailable" });
    expect(await validatePersonalProviderCredential("openai", "submitted-key"))
      .toEqual({ status: "unavailable" });
  });

  test("recognizes Google's documented invalid-key response without generalizing HTTP 400", async () => {
    const invalidKeyBytes = new TextEncoder().encode(
      '{"error":{"details":[{"reason" : "API_KEY_INVALID"}]}}',
    );
    const responses = [
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of invalidKeyBytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }), { status: 400 }),
      new Response('{"error":{"details":[{"reason":"FAILED_PRECONDITION"}]}}', { status: 400 }),
      new Response(null, { status: 400 }),
      new Response(null, { status: 400 }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    expect(await validatePersonalProviderCredential("google", "invalid-google-key"))
      .toEqual({ status: "rejected" });
    expect(await validatePersonalProviderCredential("google", "valid-but-not-eligible-key"))
      .toEqual({ status: "unavailable" });
    expect(await validatePersonalProviderCredential("google", "submitted-key"))
      .toEqual({ status: "unavailable" });
    expect(await validatePersonalProviderCredential("openai", "submitted-key"))
      .toEqual({ status: "unavailable" });
  });

  test("uses only fixed provider endpoints and the explicitly submitted key", async () => {
    const observed: Array<Readonly<{
      provider: PersonalProviderId;
      url: string;
      init: RequestInit | undefined;
    }>> = [];
    let activeProvider: PersonalProviderId = "openai";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      observed.push({ provider: activeProvider, url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const networkProviders = [
      "anthropic",
      "openai",
      "openrouter",
      "google",
      "xai",
      "venice",
    ] as const satisfies readonly PersonalProviderId[];
    for (const provider of networkProviders) {
      activeProvider = provider;
      expect(await validatePersonalProviderCredential(provider, `key-for-${provider}`))
        .toEqual({ status: "accepted" });
    }

    expect(observed.map(({ provider, url }) => [provider, url])).toEqual([
      ["anthropic", "https://api.anthropic.com/v1/models?limit=1"],
      ["openai", "https://api.openai.com/v1/models"],
      ["openrouter", "https://openrouter.ai/api/v1/key"],
      ["google", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"],
      ["xai", "https://api.x.ai/v1/models"],
      ["venice", "https://api.venice.ai/api/v1/api_keys/rate_limits"],
    ]);

    for (const { provider, url, init } of observed) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(url).not.toContain(`key-for-${provider}`);
      const headers = new Headers(init?.headers);
      const suppliedKey = provider === "anthropic" || provider === "google"
        ? headers.get(provider === "anthropic" ? "x-api-key" : "x-goog-api-key")
        : headers.get("authorization")?.replace(/^Bearer /, "");
      expect(suppliedKey).toBe(`key-for-${provider}`);
    }
  });

  test("returns unverified without network for providers lacking a documented free auth check", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const providers = [
      "typesafe",
      "nautilo-gateway",
      "gateway",
      "fireworks",
      "together",
      "elevenlabs",
      "groq",
      "tavily",
      "browser-use",
      "cloudconvert",
    ] as const satisfies readonly PersonalProviderId[];
    for (const provider of providers) {
      expect(await validatePersonalProviderCredential(provider, `private-${provider}-key`))
        .toEqual({ status: "unverified" });
    }
    expect(fetchCalls).toBe(0);
  });

  test("is cancellation-bounded and reduces fetch failures to a secret-free result", async () => {
    const submittedKey = "do-not-leak-this-provider-key";
    const controller = new AbortController();
    let observedSignal: AbortSignal | null = null;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error(`upstream echoed ${submittedKey}`));
        }, { once: true });
      });
    }) as typeof fetch;

    const pending = validatePersonalProviderCredential("openai", submittedKey, controller.signal);
    controller.abort();
    const result = await pending;

    expect(observedSignal).not.toBeNull();
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(submittedKey);
  });
});
