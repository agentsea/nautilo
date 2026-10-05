import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  NautiloApiClient,
  ProviderCredentialApiError,
} from "../../src/client";

const BASE = "http://127.0.0.1:9";
const credential = {
  provider: "openai/custom",
  id: "credential-1",
  revision: 2,
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:01:00.000Z",
  validationStatus: "accepted" as const,
  validatedAt: "2026-09-28T10:01:00.000Z",
  requiresReplacement: false,
  masked: "sk-proj-...",
  destination: "https://api.openai.com/v1",
  receiptReadStatus: "available" as const,
};
const providers = [{
  id: "openai",
  name: "OpenAI",
  purpose: "GPT models + embeddings",
  signupUrl: "https://platform.openai.com/api-keys",
  formatHint: "sk-proj-...",
  personalCapabilities: ["chat" as const],
  destination: "https://api.openai.com/v1",
}, {
  id: "tavily",
  name: "Tavily",
  purpose: "Web search — enables internet access",
  signupUrl: "https://app.tavily.com/home",
  formatHint: "tvly-...",
  personalCapabilities: [],
  destination: null,
}];

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("personal provider credentials client contract", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses authenticated account routes with exact revision-fenced bodies", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (method === "GET") return json(200, { credentials: [credential], providers });
      if (method === "PUT") return json(200, { credential, committed: true });
      if (url.endsWith("/validate")) {
        return json(200, { credential, committed: false });
      }
      return json(200, { deleted: true, committed: true });
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    client.setToken("human-session");

    expect(await client.listProviderCredentials()).toEqual({ credentials: [credential], providers });
    expect(await client.putProviderCredential("openai/custom", {
      apiKey: "sk-request-only",
      expectedRevision: 1,
    })).toEqual({ credential, committed: true });
    expect(await client.validateProviderCredential("openai/custom", {
      expectedRevision: 2,
    })).toEqual({ credential, committed: false });
    expect(await client.deleteProviderCredential("openai/custom", {
      expectedRevision: 2,
    })).toEqual({ deleted: true, committed: true });

    expect(calls).toEqual([
      {
        url: `${BASE}/api/account/provider-credentials`,
        method: "GET",
        authorization: "Bearer human-session",
        body: undefined,
      },
      {
        url: `${BASE}/api/account/provider-credentials/openai%2Fcustom`,
        method: "PUT",
        authorization: "Bearer human-session",
        body: { apiKey: "sk-request-only", expectedRevision: 1 },
      },
      {
        url: `${BASE}/api/account/provider-credentials/openai%2Fcustom/validate`,
        method: "POST",
        authorization: "Bearer human-session",
        body: { expectedRevision: 2 },
      },
      {
        url: `${BASE}/api/account/provider-credentials/openai%2Fcustom`,
        method: "DELETE",
        authorization: "Bearer human-session",
        body: { expectedRevision: 2 },
      },
    ]);
  });

  test("defaults a missing provider catalogue during rolling server upgrades", async () => {
    globalThis.fetch = (async () => json(200, {
      credentials: [credential],
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient(BASE);
    expect(await client.listProviderCredentials()).toEqual({
      credentials: [credential],
      providers: [],
    });
  });

  test("defaults a missing masked preview from an older server to null", async () => {
    const {
      masked: _masked,
      destination: _destination,
      receiptReadStatus: _receiptReadStatus,
      ...olderCredential
    } = credential;
    const olderProviders = providers.map(({ destination: _providerDestination, ...provider }) => provider);
    globalThis.fetch = (async () => json(200, {
      credentials: [olderCredential],
      providers: olderProviders,
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient(BASE);
    const result = await client.listProviderCredentials();
    expect(result.credentials[0]).toMatchObject({
      masked: null,
      destination: null,
      receiptReadStatus: "unknown",
    });
    expect(result.providers[0]?.destination).toBeNull();
  });

  test("rejects a success response that contains secret material", async () => {
    globalThis.fetch = (async () => json(200, {
      credentials: [{ ...credential, apiKey: "must-never-cross-the-boundary" }],
      providers,
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient(BASE);
    expect(client.listProviderCredentials()).rejects.toThrow();
  });

  test("rejects provider catalogue fields outside the sanitized contract", async () => {
    globalThis.fetch = (async () => json(200, {
      credentials: [],
      providers: [{ ...providers[0], envVar: "OPENAI_API_KEY" }],
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient(BASE);
    expect(client.listProviderCredentials()).rejects.toThrow();
  });

  test("preserves structured recovery fields without reflecting the request key", async () => {
    globalThis.fetch = (async () => json(422, {
      error: "credential_conflict",
      committed: false,
      retryable: false,
      repair: "reread_metadata",
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient(BASE);
    const error = await client.putProviderCredential("openai", {
      apiKey: "sk-request-only",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderCredentialApiError);
    expect(error).toMatchObject({
      status: 422,
      error: "credential_conflict",
      message: "credential_conflict",
      committed: false,
      retryable: false,
      repair: "reread_metadata",
    });
    expect((error as Record<string, unknown>)["apiKey"]).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("sk-request-only");
  });

  test("preserves fixed-destination repair without turning it into a user URL choice", async () => {
    globalThis.fetch = (async () => json(409, {
      error: "credential_destination_changed",
      committed: false,
      retryable: false,
      repair: "replace_credential",
    })) as unknown as typeof fetch;
    const error = await new NautiloApiClient(BASE).putProviderCredential("gateway", {
      apiKey: "request-only",
      expectedRevision: 2,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderCredentialApiError);
    expect(error).toMatchObject({ error: "credential_destination_changed", repair: "replace_credential" });
  });

  test("does not reflect an unrecognized server error containing a key", async () => {
    const sentinel = "provider-secret-in-error";
    globalThis.fetch = (async () => json(503, {
      error: sentinel,
      committed: false,
      retryable: true,
      repair: sentinel,
    })) as unknown as typeof fetch;

    const client = new NautiloApiClient(BASE);
    const error = await client.listProviderCredentials().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sentinel);
  });
});
