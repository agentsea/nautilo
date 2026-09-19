import { afterEach, describe, expect, test } from "bun:test";
import { checkKeysHealth, checkProviderHealth, checkServerHealth } from "../../src/health-checker";
import { MODEL_CAPABILITY_OVERRIDES } from "@nautilo/model-capabilities";

const originalFetch = globalThis.fetch;

/**
 * Pull real provider-namespaced model ids from the Nautilo model catalog so
 * mocked Anthropic responses stay in sync with reality. Mocks are content-
 * agnostic (the validator only branches on HTTP status), but using a real
 * id keeps the fixture honest if anyone diffs the JSON.
 */
function realAnthropicModelIds(): string[] {
  return Object.keys(MODEL_CAPABILITY_OVERRIDES)
    .filter((k) => k.startsWith("anthropic:"))
    .map((k) => k.slice("anthropic:".length));
}

describe("health-checker", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("anthropic 401 maps to invalid_key", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const r = await checkProviderHealth("anthropic", "sk-ant-api03-123456789012345678901");
    expect(r.status).toBe("invalid_key");
  });

  test("anthropic 200 from /v1/models maps to verified", async () => {
    const ids = realAnthropicModelIds();
    expect(ids.length).toBeGreaterThan(0);
    const data = ids.map((id) => ({ type: "model", id }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch;
    const r = await checkProviderHealth("anthropic", "sk-ant-api03-123456789012345678901");
    expect(r.status).toBe("verified");
  });

  test("anthropic surfaces error.message in invalid_key detail", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const r = await checkProviderHealth("anthropic", "sk-ant-api03-123456789012345678901");
    expect(r.status).toBe("invalid_key");
    expect(r.detail).toBe("invalid x-api-key");
  });

  test("anthropic 404 (deprecated model would have caused this on POST /v1/messages) is now NOT possible from /v1/models, but still maps to unreachable if hit", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await checkProviderHealth("anthropic", "sk-ant-api03-123456789012345678901");
    expect(r.status).toBe("unreachable");
  });

  test("openai 401 maps to invalid_key", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const r = await checkProviderHealth("openai", "sk-123456789012345678901234");
    expect(r.status).toBe("invalid_key");
  });

  test("openai 200 maps to verified", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const r = await checkProviderHealth("openai", "sk-123456789012345678901234");
    expect(r.status).toBe("verified");
  });

  test("openai 500 maps to unreachable", async () => {
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const r = await checkProviderHealth("openai", "sk-123456789012345678901234");
    expect(r.status).toBe("unreachable");
  });

  test("Nautilo Gateway validates the candidate key against the configured /v1/key endpoint", async () => {
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(Response.json({ data: { label: "QA", limit: 10, usage: null } }));
    }) as unknown as typeof fetch;
    const key = `ngw_${"a".repeat(43)}`;
    expect(await checkProviderHealth("nautilo-gateway", key, {
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "http://localhost:4010/v1/",
    })).toEqual({ status: "verified" });
    expect(seenUrl).toBe("http://localhost:4010/v1/key");
    expect(seenAuth).toBe(`Bearer ${key}`);
  });

  test("Nautilo Gateway health rejects a missing or unsafe operator base URL without fetching", async () => {
    let requested = false;
    globalThis.fetch = (async () => {
      requested = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const key = `ngw_${"a".repeat(43)}`;
    expect((await checkProviderHealth("nautilo-gateway", key, {})).status).toBe("unreachable");
    expect((await checkProviderHealth("nautilo-gateway", key, {
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "http://gateway.example/v1",
    })).status).toBe("unreachable");
    expect(requested).toBe(false);
  });

  test("venice uses the models endpoint and bearer header", async () => {
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const key = "vapi_opaque-format-1234567890";
    const r = await checkProviderHealth("venice", key);
    expect(r.status).toBe("verified");
    expect(seenUrl).toBe("https://api.venice.ai/api/v1/models");
    expect(seenAuth).toBe(`Bearer ${key}`);
  });

  test("venice 401 and 403 map to invalid_key while other failures are unreachable", async () => {
    for (const status of [401, 403]) {
      globalThis.fetch = (async () => new Response("", { status })) as unknown as typeof fetch;
      expect((await checkProviderHealth("venice", "vapi_opaque-format-1234567890")).status)
        .toBe("invalid_key");
    }
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await checkProviderHealth("venice", "vapi_opaque-format-1234567890"))
      .toEqual({ status: "unreachable", detail: "HTTP 500" });
  });

  test("network error maps to unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkProviderHealth("tavily", "tvly-12345678901");
    expect(r.status).toBe("unreachable");
    expect(r.detail).toContain("ECONNREFUSED");
  });

  test("checkServerHealth ok on 200", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await checkServerHealth("http://127.0.0.1:9/health");
    expect(r.ok).toBe(true);
  });

  test("unknown key id returns unreachable", async () => {
    const r = await checkProviderHealth("invalid" as never, "x");
    expect(r.status).toBe("unreachable");
    expect(r.detail).toContain("unknown");
  });

  test("Browser Use validation stays present without creating a provider resource", async () => {
    let requested = false;
    globalThis.fetch = (async () => {
      requested = true;
      throw new Error("Browser Use validation must not call the provider");
    }) as unknown as typeof fetch;
    expect(await checkKeysHealth(
      { BROWSER_USE_API_KEY: "bu_12345678901234567890" },
      ["browser-use"],
    )).toEqual({});
    expect(requested).toBe(false);
  });

  test("google 200 from /v1beta/models maps to verified", async () => {
    let seenUrl = "";
    let seenKey = "";
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (typeof input === "string") seenUrl = input;
      else if (input instanceof URL) seenUrl = input.href;
      else seenUrl = input.url;
      seenKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      return Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;
    const key = "AQ.Ab8RN6KMRdJWBR7PpH7JDKKrkJVstiPHi2";
    const r = await checkProviderHealth("google", key);
    expect(r.status).toBe("verified");
    expect(seenUrl).toContain("generativelanguage.googleapis.com/v1beta/models");
    expect(seenKey).toBe(key);
  });

  test("google 400 API key not valid maps to invalid_key (not unreachable)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const r = await checkProviderHealth("google", "AIzaSy-dead-key-xxxxxxxxxxxxxx");
    expect(r.status).toBe("invalid_key");
    expect(r.detail).toContain("API key not valid");
  });

  test("cloudconvert 401 maps to invalid_key and surfaces message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Unauthenticated.", code: "UNAUTHENTICATED" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await checkProviderHealth(
      "cloudconvert",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cloudconvert-test",
    );
    expect(r.status).toBe("invalid_key");
    expect(r.detail).toContain("Unauthenticated.");
    expect(r.detail).toContain("truncated");
  });

  test("cloudconvert 200 from /v2/jobs maps to verified", async () => {
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (typeof input === "string") seenUrl = input;
      else if (input instanceof URL) seenUrl = input.href;
      else seenUrl = input.url;
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cloudconvert-test";
    const r = await checkProviderHealth("cloudconvert", key);
    expect(r.status).toBe("verified");
    expect(seenUrl).toContain("https://api.cloudconvert.com/v2/jobs");
    expect(seenAuth).toBe(`Bearer ${key}`);
  });

  test("cloudconvert 500 maps to unreachable", async () => {
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const r = await checkProviderHealth(
      "cloudconvert",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cloudconvert-test",
    );
    expect(r.status).toBe("unreachable");
    expect(r.detail).toBe("HTTP 500");
  });
});
