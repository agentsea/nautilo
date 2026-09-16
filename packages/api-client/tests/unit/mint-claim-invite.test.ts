import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient, ApiError } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function readHeaders(init?: RequestInit): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (typeof h === "object" && !Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
    return out;
  }
  return {};
}

describe("NautiloApiClient.mintClaimInvite", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("200 success returns token with bootstrap bearer header", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    let headers: Record<string, string> = {};

    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? init.body : "";
      headers = readHeaders(init);
      return new Response(JSON.stringify({ token: "inv_x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const out = await client.mintClaimInvite("bootstrap-tok");

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/setup/mint-claim-invite");
    expect(seenBody).toBe("{}");
    expect(headers["authorization"]).toBe("Bearer bootstrap-tok");
    expect(headers["content-type"]).toBe("application/json");
    expect(out.token).toBe("inv_x");
  });

  test("409 throws ApiError with status 409", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "claim invite already unredeemed", existing: true }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let caught: ApiError | undefined;
    try {
      await client.mintClaimInvite("tok");
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught!.status).toBe(409);
    expect(caught!.message).toBe("claim invite already unredeemed");
  });

  test("500 throws ApiError with default message", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({}), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let caught: ApiError | undefined;
    try {
      await client.mintClaimInvite("tok");
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught!.status).toBe(500);
    expect(caught!.message).toBe("POST /api/setup/mint-claim-invite failed: 500");
  });
});
