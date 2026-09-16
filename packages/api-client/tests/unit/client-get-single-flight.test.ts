/**
 * ISSUE-M214 Phase 1 — GET single-flight and whoami coalescing.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient, ApiError } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function readAuthHeader(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    return h.get("authorization") ?? h.get("Authorization");
  }
  if (typeof h === "object" && !Array.isArray(h)) {
    const r = h as Record<string, string>;
    return r["authorization"] ?? r["Authorization"] ?? null;
  }
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("NautiloApiClient GET single-flight (ISSUE-M214 Phase 1)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("credentialGeneration bumps only when normalized token value changes", () => {
    const client = new NautiloApiClient("http://127.0.0.1:3001");
    expect(client.getCredentialGeneration()).toBe(0);
    client.setToken("alpha");
    expect(client.getCredentialGeneration()).toBe(1);
    client.setToken("alpha");
    expect(client.getCredentialGeneration()).toBe(1);
    client.setToken("beta");
    expect(client.getCredentialGeneration()).toBe(2);
    client.setToken("");
    expect(client.getCredentialGeneration()).toBe(3);
    client.setToken(null);
    expect(client.getCredentialGeneration()).toBe(3);
  });

  test("concurrent same GET performs one fetch and shares parsed result", async () => {
    let fetchCount = 0;
    const gate = deferred<void>();
    const client = new NautiloApiClient("http://127.0.0.1:3001");

    globalThis.fetch = Object.assign(
      async () => {
        fetchCount += 1;
        await gate.promise;
        return new Response(JSON.stringify({ status: "ok", version: "1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const p1 = client.getHealth();
    const p2 = client.getHealth();
    expect(client.getInFlightGetCount()).toBe(1);
    expect(fetchCount).toBe(1);

    gate.resolve();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.status).toBe("ok");
    expect(b).toEqual(a);
    expect(fetchCount).toBe(1);
    expect(client.getInFlightGetCount()).toBe(0);
  });

  test("same GET after failure refetches once in-flight map is cleared", async () => {
    let fetchCount = 0;
    const client = new NautiloApiClient("http://127.0.0.1:3001");

    globalThis.fetch = Object.assign(
      async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Response(JSON.stringify({ error: "down" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "ok-v2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    let firstError: unknown;
    try {
      await client.getHealth();
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(ApiError);
    expect(client.getInFlightGetCount()).toBe(0);

    const out = await client.getHealth();
    expect(out.status).toBe("ok-v2");
    expect(fetchCount).toBe(2);
  });

  test("changing token separates concurrent protected GET work", async () => {
    let fetchCount = 0;
    const gate = deferred<void>();
    const authSeen: string[] = [];
    const client = new NautiloApiClient("http://127.0.0.1:3001");
    client.setToken("token-a");

    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchCount += 1;
        authSeen.push(readAuthHeader(init) ?? "");
        await gate.promise;
        return new Response(
          JSON.stringify({ viewerRole: "owner", agent: { name: "Jeannie" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const first = client.getProfile();
    client.setToken("token-b");
    const second = client.getProfile();
    expect(fetchCount).toBe(2);
    expect(client.getInFlightGetCount()).toBe(2);

    gate.resolve();
    await Promise.all([first, second]);
    expect(authSeen).toEqual(["Bearer token-a", "Bearer token-b"]);
    expect(client.getInFlightGetCount()).toBe(0);
  });

  test("concurrent whoami shares one fetch and preserves guest fallback on 401", async () => {
    let fetchCount = 0;
    let providerCalls = 0;
    const gate = deferred<void>();
    const client = new NautiloApiClient("http://127.0.0.1:3001");
    client.setToken("latched-token");
    client.setTokenProvider(async () => {
      providerCalls += 1;
      return "provider-token";
    });

    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchCount += 1;
        expect(requestUrl(input)).toBe("http://127.0.0.1:3001/api/auth/whoami");
        expect(readAuthHeader(init)).toBe("Bearer latched-token");
        await gate.promise;
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const p1 = client.whoami();
    const p2 = client.whoami();
    expect(fetchCount).toBe(1);
    expect(providerCalls).toBe(0);

    gate.resolve();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.sessionUserId).toBeNull();
    expect(b).toEqual(a);
    expect(fetchCount).toBe(1);
    expect(providerCalls).toBe(0);
  });

  test("concurrent whoami shares one fetch and preserves 5xx throw", async () => {
    let fetchCount = 0;
    const gate = deferred<void>();
    const client = new NautiloApiClient("http://127.0.0.1:3001");
    client.setToken("tok");

    globalThis.fetch = Object.assign(
      async () => {
        fetchCount += 1;
        await gate.promise;
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const p1 = client.whoami();
    const p2 = client.whoami();
    expect(fetchCount).toBe(1);

    gate.resolve();
    let whoamiError: unknown;
    try {
      await Promise.all([p1, p2]);
    } catch (error) {
      whoamiError = error;
    }
    expect(whoamiError).toBeInstanceOf(ApiError);
    expect(fetchCount).toBe(1);
  });

  test("mutation requests never coalesce", async () => {
    let fetchCount = 0;
    let providerCalls = 0;
    const client = new NautiloApiClient("http://127.0.0.1:3001");
    client.setToken("stale-token");
    client.setTokenProvider(async () => {
      providerCalls += 1;
      return "fresh-token";
    });

    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchCount += 1;
        expect(requestUrl(input)).toBe("http://127.0.0.1:3001/api/profile");
        expect(init?.method).toBe("PUT");
        expect(readAuthHeader(init)).toBe("Bearer fresh-token");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const p1 = client.updateProfile({ defaultModel: "openai:gpt-5" });
    const p2 = client.updateProfile({ defaultModel: "openai:gpt-5" });
    expect(client.getInFlightGetCount()).toBe(0);

    await Promise.all([p1, p2]);
    expect(fetchCount).toBe(2);
    expect(providerCalls).toBe(2);
  });

  test("normalizeRequestPath sorts query params for stable in-flight keys", () => {
    const client = new NautiloApiClient("http://127.0.0.1:3001");
    const normalize = (
      client as unknown as { normalizeRequestPath(path: string): string }
    ).normalizeRequestPath.bind(client);

    expect(normalize("/api/items?limit=10&cursor=c1&include_federated=true")).toBe(
      "/api/items?cursor=c1&include_federated=true&limit=10",
    );
    expect(normalize("/api/items")).toBe("/api/items");
    expect(normalize("/api/items?")).toBe("/api/items");
  });
});
