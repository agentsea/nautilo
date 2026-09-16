import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "../../src/client";
import type { CatalogResponse, VoiceCustomizationHydrationResponse } from "@nautilo/types";

const customizationHydration: VoiceCustomizationHydrationResponse = {
  curated: [
    {
      slug: "carolyn",
      label: "Carolyn",
      voiceId: "JSWO6cw2AyFE324d5kEr",
      language: "en",
      description: "Warm & Confident",
      previewUrl: "/api/onboarding/audio/en/voices/carolyn-sample.mp3",
    },
  ],
  voices: [],
  elevenLabsConfigured: false,
  cachedAt: null,
};

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

const sampleCatalog: CatalogResponse = {
  voices: [
    {
      voiceId: "voice-1",
      name: "Lucia",
      accent: "castilian",
      gender: "female",
      age: "young",
      descriptive: "warm",
      category: "professional",
      language: "es",
      locale: "es-ES",
      languageLabel: "Spanish",
      previewUrl: "https://example.com/lucia.mp3",
      verifiedLanguages: [{ language: "es", modelId: "eleven_v3", accent: null, locale: "es-ES", previewUrl: null }],
      source: "provider",
    },
  ],
  languageGroups: [{ language: "es", locale: "es-ES", label: "Spanish", count: 1 }],
  page: 0,
  pageSize: 30,
  hasMore: false,
  totalCount: 1,
  elevenLabsConfigured: true,
  cachedAt: 1_700_000_000_000,
};

describe("listVoiceCatalog (D215)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("encodes query params and parses catalog response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let authHeader = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      authHeader = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(sampleCatalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    const out = await client.listVoiceCatalog({
      language: "es",
      category: "professional",
      page: 0,
      page_size: 30,
    });

    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/voices/catalog?language=es&category=professional&page=0&page_size=30",
    );
    expect(authHeader).toBe("Bearer session-tok");
    expect(out).toEqual(sampleCatalog);
  });

  test("omits query string when query is omitted", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleCatalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    await client.listVoiceCatalog();

    expect(seenUrl).toBe("http://127.0.0.1:9/api/voices/catalog");
  });

  test("throws ApiError when provider key is missing", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          error: "ELEVENLABS_API_KEY is not set",
          elevenLabsConfigured: false,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    try {
      await client.listVoiceCatalog();
      throw new Error("Expected listVoiceCatalog to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 400,
        message: "ELEVENLABS_API_KEY is not set",
      });
    }
  });
});

describe("getVoiceCustomizationHydration (D510)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("uses the authenticated no-query hydration endpoint and preserves the optional capability", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let authHeader = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      authHeader = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(customizationHydration), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    const out = await client.getVoiceCustomizationHydration();

    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/voices");
    expect(authHeader).toBe("Bearer session-tok");
    expect(out).toEqual(customizationHydration);
  });
});

describe("previewVoice (D215)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs custom text and returns audio blob", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    let authHeader = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = init?.body as string;
      authHeader = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(new Uint8Array([0xff, 0xfb]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    const blob = await client.previewVoice("voice1234", {
      text: "Hi, I'm your Genie. [laughs]",
    });

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/voices/voice1234/preview");
    expect(authHeader).toBe("Bearer session-tok");
    expect(JSON.parse(seenBody)).toEqual({
      text: "Hi, I'm your Genie. [laughs]",
    });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/mpeg");
  });

  test("omits JSON body when text is not provided", async () => {
    let seenBody: string | undefined;
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenBody = init?.body as string | undefined;
      return new Response(new Uint8Array([0xff]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    await client.previewVoice("voice1234");

    expect(seenBody).toBeUndefined();
  });

  test("throws ApiError with server message on failure", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "Invalid voice id" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");
    try {
      await client.previewVoice("bad", { text: "test" });
      throw new Error("Expected previewVoice to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 400,
        message: "Invalid voice id",
      });
    }
  });

  test("never treats a successful JSON or empty response as playable voice audio", async () => {
    const responses = [
      new Response(JSON.stringify({ text: "generic fallback" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array(), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    ];
    const mockFetch = async () => responses.shift()!;
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-tok");

    const expectedMessages = [
      "Voice preview did not return provider audio.",
      "Voice preview returned empty provider audio.",
    ];
    for (const message of expectedMessages) {
      try {
        await client.previewVoice("voice1234");
        throw new Error("Expected previewVoice to reject invalid provider audio");
      } catch (error) {
        expect(error).toMatchObject({ status: 502, message });
      }
    }
  });
});
