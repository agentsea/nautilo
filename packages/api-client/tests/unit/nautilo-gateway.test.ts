import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

describe("Nautilo Gateway administration client", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("reads and updates the Gateway URL with the session bearer", async () => {
    const calls: Array<{ url: string; method: string; authorization: string; body: string }> = [];
    const responses = [
      { baseUrl: null },
      { baseUrl: "https://gateway.example/v1" },
    ];
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({
        url: typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json(responses.shift());
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:3001");
    client.setToken("session-bearer-gateway");

    expect(await client.getNautiloGateway()).toEqual({ baseUrl: null });
    expect(await client.updateNautiloGateway("https://gateway.example/v1")).toEqual({
      baseUrl: "https://gateway.example/v1",
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:3001/api/setup/nautilo-gateway",
        method: "GET",
        authorization: "Bearer session-bearer-gateway",
        body: "",
      },
      {
        url: "http://127.0.0.1:3001/api/setup/nautilo-gateway",
        method: "PUT",
        authorization: "Bearer session-bearer-gateway",
        body: '{"baseUrl":"https://gateway.example/v1"}',
      },
    ]);
  });
});
