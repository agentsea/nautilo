/**
 * D429 Phase 7.4 — api-client contract for `fetchExplainerMedia`.
 *
 * Verifies the bearer-authenticated GET to `/api/explainers/:id/media`, that
 * the method returns a Blob plus byte-length/format metadata (never a direct
 * CDN/media URL), id encoding, and ApiError propagation on non-2xx.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("fetchExplainerMedia (D429 Phase 7.4)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function installFetch(
    handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
  ): { seenUrl: string; seenMethod: string; authHeader: string } {
    const seen = { seenUrl: "", seenMethod: "", authHeader: "" };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.seenUrl = requestUrl(input);
      seen.seenMethod = init?.method ?? "GET";
      seen.authHeader = new Headers(init?.headers).get("authorization") ?? "";
      return handler(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    return seen;
  }

  test("sends a bearer-authenticated GET and returns Blob + metadata", async () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20]);
    const seen = installFetch(async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    const out = await client.fetchExplainerMedia("customize-your-genie");

    expect(seen.seenMethod).toBe("GET");
    expect(seen.seenUrl).toBe("http://127.0.0.1:9/api/explainers/customize-your-genie/media");
    expect(seen.authHeader).toBe("Bearer session-tok");
    expect(out.blob).toBeInstanceOf(Blob);
    expect(out.blob.type).toBe("video/mp4");
    expect(out.blob.size).toBe(bytes.length);
    expect(out.byteLength).toBe(bytes.length);
    expect(out.format).toBe("mp4");
  });

  test("encodes the explainer id in the path", async () => {
    const seen = installFetch(async () =>
      new Response(new Uint8Array([0x00]), { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    await client.fetchExplainerMedia("co-create-in-writer");

    expect(seen.seenUrl).toBe("http://127.0.0.1:9/api/explainers/co-create-in-writer/media");
  });

  test("throws ApiError on 401 (unauthenticated)", async () => {
    installFetch(async () =>
      new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    try {
      await client.fetchExplainerMedia("customize-your-genie");
      throw new Error("Expected fetchExplainerMedia to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 401, message: "Authentication required" });
    }
  });

  test("throws ApiError on 404 (unknown id)", async () => {
    installFetch(async () =>
      new Response(JSON.stringify({ error: "Unknown explainer" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    try {
      await client.fetchExplainerMedia("not-in-catalog");
      throw new Error("Expected fetchExplainerMedia to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 404, message: "Unknown explainer" });
    }
  });

  test("throws ApiError on 502 (verification failure)", async () => {
    installFetch(async () =>
      new Response(JSON.stringify({ error: "Explainer media verification failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    try {
      await client.fetchExplainerMedia("customize-your-genie");
      throw new Error("Expected fetchExplainerMedia to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 502, message: "Explainer media verification failed" });
    }
  });

  test("the returned contract exposes no CDN/media URL field", async () => {
    installFetch(async () =>
      new Response(new Uint8Array([0x00, 0x01]), { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    const out = (await client.fetchExplainerMedia("customize-your-genie")) as Record<string, unknown>;
    expect(out).not.toHaveProperty("url");
    expect(out).not.toHaveProperty("src");
    expect(out).not.toHaveProperty("cdnUrl");
    expect(out).not.toHaveProperty("origin");
    expect(JSON.stringify(out)).not.toContain("media.nautilo.ai");
  });
});
