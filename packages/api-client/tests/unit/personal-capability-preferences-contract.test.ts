import { afterEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const BASE = "http://127.0.0.1:9";
const originalFetch = globalThis.fetch;

const response = {
  revision: 2,
  overrides: { webSearchSynthesis: "openrouter:model-a" },
  fundingPreference: "server_first" as const,
  capabilities: [{
    role: "webSearchSynthesis" as const,
    label: "Search synthesis",
    description: "Writes an answer from the gathered sources.",
    selection: {
      source: "personal" as const,
      modelId: "openrouter:model-a",
      displayName: "Model A",
    },
    readiness: { status: "missing-credentials" as const, reason: "Add a compatible provider key.", fundingSource: null, providerRoute: null },
    options: [{
      modelId: "openrouter:model-a",
      displayName: "Model A",
      provider: "openrouter",
      readiness: { status: "missing-credentials" as const, reason: "Add a compatible provider key.", fundingSource: null, providerRoute: null },
    }],
  }],
};

afterEach(() => { globalThis.fetch = originalFetch; });

describe("personal capability preferences client contract", () => {
  test("uses authenticated self routes and exact sparse CAS replacement", async () => {
    const calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(response);
    }) as typeof fetch;
    const client = new NautiloApiClient(BASE);
    client.setToken("human-session");

    expect(await client.getPersonalCapabilityPreferences()).toEqual(response);
    expect(await client.replacePersonalCapabilityPreferences({
      expectedRevision: 2,
      overrides: {},
    })).toEqual(response);
    expect(calls).toEqual([
      {
        url: `${BASE}/api/account/capability-preferences`,
        method: "GET",
        body: undefined,
        authorization: "Bearer human-session",
      },
      {
        url: `${BASE}/api/account/capability-preferences`,
        method: "PUT",
        body: { expectedRevision: 2, overrides: {} },
        authorization: "Bearer human-session",
      },
    ]);
  });

  test("rejects unknown roles and malformed readiness instead of guessing", async () => {
    for (const invalid of [
      { ...response, overrides: { embeddings: "openai:text-embedding-3-small" } },
      {
        ...response,
        capabilities: [{ ...response.capabilities[0], readiness: { status: "ready", reason: undefined, fundingSource: "server", providerRoute: "openrouter" } }],
      },
    ]) {
      globalThis.fetch = (() => Promise.resolve(Response.json(invalid))) as unknown as typeof fetch;
      expect(new NautiloApiClient(BASE).getPersonalCapabilityPreferences()).rejects.toThrow();
    }
  });

  test("rejects unknown outgoing fields before sending", async () => {
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      return Promise.resolve(Response.json(response));
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);
    expect(client.replacePersonalCapabilityPreferences({
      expectedRevision: 0,
      overrides: { embeddings: "openai:text-embedding-3-small" },
    } as never)).rejects.toThrow();
    expect(called).toBe(false);
  });
});
