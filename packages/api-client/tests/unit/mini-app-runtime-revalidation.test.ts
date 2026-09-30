import { describe, expect, test } from "bun:test";
import { NautiloApiClient, type MiniAppRuntimeResponse } from "../../src/client";

const runtime: MiniAppRuntimeResponse = {
  appId: "sample-app",
  sourceHash: "a".repeat(64),
  srcDoc: "<!doctype html><p>Sample editor</p>",
  manifest: {
    id: "sample-app", name: "Sample App", version: "1.0.0",
    fileAssociations: { extensions: [] }, capabilities: {},
  },
};

function body(etag = 'W/"runtime-a"', payload = runtime): Response {
  return Response.json(payload, { headers: { etag } });
}

describe("mini-app runtime revalidation", () => {
  test("revalidates every reopen, shares concurrent requests and isolates retained bodies", async () => {
    const requests: RequestInit[] = [];
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async (_url, init) => {
      requests.push(init!);
      return requests.length === 1 ? body() : new Response(null, {
        status: 304, headers: { etag: 'W/"runtime-a"' },
      });
    } });
    client.setToken("session-a");
    const [first] = await Promise.all([
      client.getMiniAppRuntime("sample-app"), client.getMiniAppRuntime("sample-app"),
    ]);
    expect(requests).toHaveLength(1);
    first.srcDoc = "mutated by consumer";
    expect(await client.getMiniAppRuntime("sample-app")).toEqual(runtime);
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[1]!.headers).get("if-none-match")).toBe('W/"runtime-a"');
    expect(requests.every((request) => request.cache === "no-store")).toBe(true);
  });

  test("replaces changed runtimes and supports servers without validators", async () => {
    const requests: Headers[] = [];
    const updated = { ...runtime, srcDoc: "new runtime" };
    const responses = [body(), body('W/"runtime-b"', updated), Response.json(updated), Response.json(updated)];
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return responses.shift()!;
    } });
    await client.getMiniAppRuntime("sample-app");
    expect(await client.getMiniAppRuntime("sample-app")).toEqual(updated);
    await client.getMiniAppRuntime("sample-app");
    await client.getMiniAppRuntime("sample-app");
    expect(requests.map((headers) => headers.get("if-none-match"))).toEqual([
      null, 'W/"runtime-a"', 'W/"runtime-b"', null,
    ]);
  });

  test("clears bodies across logout, credential changes and server clients", async () => {
    const validators: (string | null)[] = [];
    const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      validators.push(new Headers(init?.headers).get("if-none-match"));
      return body();
    };
    const client = new NautiloApiClient("https://example.test", { fetchImpl });
    client.setToken("session-a");
    await client.getMiniAppRuntime("sample-app");
    client.setToken(null);
    client.setToken("session-a");
    await client.getMiniAppRuntime("sample-app");
    client.setToken("session-b");
    await client.getMiniAppRuntime("sample-app");
    const other = new NautiloApiClient("https://other.example.test", { fetchImpl });
    other.setToken("session-b");
    await other.getMiniAppRuntime("sample-app");
    expect(validators).toEqual([null, null, null, null]);
  });

  test.each([401, 403, 404, 409, 500])("never falls back to retained content after HTTP %i", async (status) => {
    let calls = 0;
    let finalValidator: string | null = null;
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async (_url, init) => {
      calls += 1;
      finalValidator = new Headers(init?.headers).get("if-none-match");
      return calls === 2 ? Response.json({ error: "unavailable" }, { status }) : body();
    } });
    await client.getMiniAppRuntime("sample-app");
    expect(await client.getMiniAppRuntime("sample-app").catch((error: unknown) => error)).toMatchObject({ status });
    await client.getMiniAppRuntime("sample-app");
    expect(finalValidator).toBeNull();
  });

  test("refreshes credentials before selecting a retained validator", async () => {
    const requests: Headers[] = [];
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return body();
    } });
    client.setToken("old-session");
    await client.getMiniAppRuntime("sample-app");
    client.setTokenProvider(async () => "fresh-session");
    await client.getMiniAppRuntime("sample-app");
    expect(requests[1]!.get("authorization")).toBe("Bearer fresh-session");
    expect(requests[1]!.get("if-none-match")).toBeNull();
  });

  test("recovers an unexpected 304 without a retained body using a full fetch", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async (_url, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBeNull();
      return ++calls === 1 ? new Response(null, { status: 304 }) : body();
    } });
    expect(await client.getMiniAppRuntime("sample-app")).toEqual(runtime);
    expect(calls).toBe(2);
  });

  test("rejects a repeated bodyless 304 without retrying indefinitely", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 304 });
    } });
    expect(await client.getMiniAppRuntime("sample-app").catch((error: unknown) => error)).toMatchObject({ status: 304 });
    expect(calls).toBe(2);
  });

  test.each([200, 304])("rejects an old-session HTTP %i completing after an account switch", async (status) => {
    let release!: (response: Response) => void;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => { dispatched = resolve; });
    let calls = 0;
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async () => {
      if (++calls !== 2) return body();
      dispatched();
      return new Promise<Response>((resolve) => { release = resolve; });
    } });
    client.setToken("session-a");
    await client.getMiniAppRuntime("sample-app");
    const pending = client.getMiniAppRuntime("sample-app");
    await started;
    client.setToken("session-b");
    release(status === 200 ? body() : new Response(null, {
      status: 304, headers: { etag: 'W/"runtime-a"' },
    }));
    expect(await pending.catch((error: unknown) => error)).toMatchObject({ status: 409 });
    expect(await client.getMiniAppRuntime("sample-app")).toEqual(runtime);
  });
});
