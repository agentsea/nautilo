/**
 * Voice catalog HTTP routes — hermetic. Mocks `@nautilo/db`, mounts only
 * `voiceRoutes` (no full `createApp` boot), and injects `catalogCache: null`
 * or `FakeVoiceCatalogCache` on every route test so handlers never use the
 * default DB-backed provider catalog cache or open pools at boot/request time.
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { voicePreviewPathForCustomText } from "@nautilo/voice";
import type { ViewerRole } from "@nautilo/types";
import type { VoiceCatalogPersistentCache } from "../../src/routes/voices";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import {
  FakeVoiceCatalogCache,
  multilingualOnlyVoice,
  v3Voice,
} from "../helpers/voices-test-fixtures";

type NoopDb = {
  select: () => {
    from: () => {
      where: () => { limit: () => Promise<unknown[]> };
      limit: () => Promise<unknown[]>;
    };
  };
  insert: () => {
    values: () => {
      onConflictDoUpdate: () => Promise<void>;
      returning: () => Promise<unknown[]>;
    };
  };
  transaction: (fn: (tx: NoopDb) => Promise<unknown>) => Promise<unknown>;
};

function makeNoopDb(): NoopDb {
  const limit = async () => [] as unknown[];
  const where = () => ({ limit });
  const from = () => ({ where, limit });
  return {
    select: () => ({ from }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(),
        returning: () => Promise.resolve([]),
      }),
    }),
    transaction: async (fn: (tx: NoopDb) => Promise<unknown>) => fn(makeNoopDb()),
  };
}

type VoiceHydrationBody = {
  curated: unknown[];
  voices: unknown[];
  elevenLabsConfigured: boolean;
  cachedAt: number | null;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVoiceHydrationBody(body: string): VoiceHydrationBody {
  const parsed: unknown = JSON.parse(body);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed["curated"]) ||
    !Array.isArray(parsed["voices"]) ||
    typeof parsed["elevenLabsConfigured"] !== "boolean" ||
    (parsed["cachedAt"] !== null && typeof parsed["cachedAt"] !== "number") ||
    (parsed["error"] !== undefined && typeof parsed["error"] !== "string")
  ) {
    throw new Error("Expected a voice customization hydration response");
  }
  return {
    curated: parsed["curated"],
    voices: parsed["voices"],
    elevenLabsConfigured: parsed["elevenLabsConfigured"],
    cachedAt: parsed["cachedAt"],
    ...(parsed["error"] === undefined ? {} : { error: parsed["error"] }),
  };
}

const noopDb = makeNoopDb();
const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  db: noopDb,
  getSharedDirectDb: () => noopDb,
  refreshServerModelConfigCache: async () => null,
  hasAdminUser: async () => false,
  hasClaimedOwner: async () => false,
  hasUnredeemedClaimInvite: async () => false,
}));

const {
  clearSharedCatalogCacheForTests,
  filterAndNormalizeSharedCatalog,
  voiceRoutes,
} = await import("../../src/routes/voices");

describe("voice catalog routes", () => {
  const instances: FastifyInstance[] = [];
  let realFetch: typeof fetch;

  function createVoicesRouteApp(
    catalogCache: VoiceCatalogPersistentCache | null,
    input: {
      viewerRole?: ViewerRole;
      sessionUserId?: string | null;
      serverFunding?: boolean;
    } = {},
  ): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionUserId", null);
    voiceRoutes(app, {
      catalogCache,
      assertCanUseServerProviderCredentials: async (humanUserId) => {
        if (input.serverFunding === false) {
          throw new ServerProviderCredentialsDeniedError(humanUserId, "voice_test");
        }
      },
    });
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = input.sessionUserId === undefined ? "ordinary-user" : input.sessionUserId;
      request.policyContext = {
        actorRole: input.viewerRole ?? "member",
        actorId: request.sessionUserId ?? "guest",
      } as typeof request.policyContext;
    });
    instances.push(app);
    return app;
  }

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    clearSharedCatalogCacheForTests();
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  test("GET /api/voices returns curated entries from loopback", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        curated: {
          slug: string;
          voiceId: string;
          previewUrl: string;
          language: string;
          label: string;
          description: string;
        }[];
        elevenLabsConfigured: boolean;
      };
      expect(body.curated.length).toBe(6);
      expect(body.curated[0]).toMatchObject({
        slug: "amy",
        label: "Amy",
        voiceId: "OZxMHsGaBmV5pjMIDIn0",
        description: "Natural and Sweet",
        previewUrl: "/api/onboarding/audio/en/voices/amy-sample.mp3",
        language: "en",
      });
      expect(body.curated.some((c) => c.slug === "carolyn")).toBe(false);
      const beatriz = body.curated.find((c) => c.slug === "beatriz");
      expect(beatriz?.previewUrl).toBe("/api/onboarding/audio/es/voices/beatriz-sample.mp3");
      expect(beatriz?.language).toBe("es");
      expect(body.curated.some((c) => c.slug === "jessica")).toBe(true);
      expect(body.curated.some((c) => c.slug === "augustin")).toBe(true);
      expect(body.curated.some((c) => c.slug === "daniel")).toBe(true);
      expect(body.curated.some((c) => c.slug === "kana")).toBe(true);
      const augustin = body.curated.find((c) => c.slug === "augustin");
      expect(augustin?.language).toBe("fr");
      expect(augustin?.previewUrl).toMatch(/^https:\/\//);
      expect(body.elevenLabsConfigured).toBe(false);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("voice catalog and preview deny unauthenticated and guest callers", async () => {
    const unauthenticated = createVoicesRouteApp(null, { sessionUserId: null });
    const guest = createVoicesRouteApp(null, {
      viewerRole: "guest",
      sessionUserId: "guest-session-user",
    });

    for (const endpoint of [
      { method: "GET" as const, url: "/api/voices/catalog" },
      { method: "POST" as const, url: "/api/voices/JSWO6cw2AyFE324d5kEr/preview" },
    ]) {
      const unauthenticatedRes = await unauthenticated.inject({
        ...endpoint,
        remoteAddress: "203.0.113.10",
      });
      expect(unauthenticatedRes.statusCode).toBe(401);

      const guestRes = await guest.inject({
        ...endpoint,
        remoteAddress: "203.0.113.10",
      });
      expect(guestRes.statusCode).toBe(403);
    }
  });

  test("GET /api/voices gives authenticated remote non-guests curated capability without a provider call", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    let providerCalls = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-provider-key";
      globalThis.fetch = Object.assign(
        async () => {
          providerCalls += 1;
          return new Response("unexpected provider call", { status: 500 });
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(200);
      const body = parseVoiceHydrationBody(res.body);
      expect(body.curated.length).toBeGreaterThan(0);
      expect(body.voices).toEqual([]);
      expect(body.elevenLabsConfigured).toBe(true);
      expect(body.cachedAt).toBeNull();
      expect(providerCalls).toBe(0);
    } finally {
      if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices treats no ElevenLabs key as a browser-safe steady state without a provider call", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    let providerCalls = 0;
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      globalThis.fetch = Object.assign(
        async () => {
          providerCalls += 1;
          return new Response("unexpected provider call", { status: 500 });
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(200);
      const body = parseVoiceHydrationBody(res.body);
      expect(body.curated.length).toBeGreaterThan(0);
      expect(body.voices).toEqual([]);
      expect(body.elevenLabsConfigured).toBe(false);
      expect(body.cachedAt).toBeNull();
      expect(providerCalls).toBe(0);
    } finally {
      if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices denies unauthenticated and guest remote callers with sanitized errors", async () => {
    const unauthenticated = createVoicesRouteApp(null, { sessionUserId: null });
    const guest = createVoicesRouteApp(null, {
      viewerRole: "guest",
      sessionUserId: "guest-session-user",
    });

    const unauthenticatedRes = await unauthenticated.inject({
      method: "GET",
      url: "/api/voices",
      remoteAddress: "203.0.113.10",
    });
    expect(unauthenticatedRes.statusCode).toBe(401);
    expect(JSON.parse(unauthenticatedRes.body)).toEqual({ error: "Authentication required" });

    const guestRes = await guest.inject({
      method: "GET",
      url: "/api/voices",
      remoteAddress: "203.0.113.10",
    });
    expect(guestRes.statusCode).toBe(403);
    expect(JSON.parse(guestRes.body)).toEqual({ error: "Forbidden" });
  });

  test("GET /api/voices preserves owner provider hydration but sanitizes provider failures", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-provider-secret";
      globalThis.fetch = Object.assign(
        async () => new Response("upstream account detail: test-provider-secret", { status: 500 }),
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null, { viewerRole: "owner" });
      const res = await app.inject({
        method: "GET",
        url: "/api/voices",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(502);
      const body = parseVoiceHydrationBody(res.body);
      expect(body.curated.length).toBeGreaterThan(0);
      expect(body.voices).toEqual([]);
      expect(body.elevenLabsConfigured).toBe(true);
      expect(body.error).toBe("Failed to load voices.");
      expect(body.cachedAt).toBeNull();
      expect(res.body).not.toContain("test-provider-secret");
      expect(res.body).not.toContain("upstream account detail");
    } finally {
      if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices denies provider hydration before dispatch without server funding", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    let providerCalls = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-provider-key";
      globalThis.fetch = Object.assign(async () => {
        providerCalls += 1;
        return new Response("unexpected", { status: 500 });
      }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
      const app = createVoicesRouteApp(null, { viewerRole: "owner", serverFunding: false });
      const res = await app.inject({ method: "GET", url: "/api/voices", remoteAddress: "203.0.113.10" });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: "server_provider_credentials_required",
        code: "server_provider_credentials_required",
        capability: "use_server_provider_credentials",
      });
      expect(providerCalls).toBe(0);
    } finally {
      if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices preserves the full provider list for a remote owner", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    let providerCalls = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-provider-key";
      globalThis.fetch = Object.assign(
        async () => {
          providerCalls += 1;
          return new Response(
            JSON.stringify({
              voices: [
                {
                  voice_id: "provider-account-voice",
                  name: "Provider Account Voice",
                  labels: { accent: "warm" },
                  description: "owner-only catalog row",
                },
                {
                  voice_id: "JSWO6cw2AyFE324d5kEr",
                  name: "Carolyn",
                  labels: { language: "en" },
                  description: "Still discoverable in the full catalog",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null, { viewerRole: "owner" });
      const res = await app.inject({
        method: "GET",
        url: "/api/voices",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        elevenLabsConfigured: true,
        voices: [
          {
            voiceId: "provider-account-voice",
            name: "Provider Account Voice",
            labels: { accent: "warm" },
            description: "owner-only catalog row",
          },
          {
            voiceId: "JSWO6cw2AyFE324d5kEr",
            name: "Carolyn",
            labels: { language: "en" },
            description: "Still discoverable in the full catalog",
          },
        ],
      });
      expect(providerCalls).toBe(1);
    } finally {
      if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog returns 400 when ElevenLabs key missing", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices/catalog",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string; elevenLabsConfigured: boolean };
      expect(body.error).toBe("ELEVENLABS_API_KEY is not set");
      expect(body.elevenLabsConfigured).toBe(false);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog keeps shared voices even when metadata omits eleven_v3", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    let fetchCalls = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [
                    { language_id: "en", name: "English" },
                    { language_id: "es", name: "Spanish" },
                  ],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            fetchCalls += 1;
            return new Response(
              JSON.stringify({
                voices: [
                  {
                    voice_id: "keep-me",
                    name: "Keep",
                    accent: "american",
                    gender: "female",
                    age: "young",
                    descriptive: "warm",
                    category: "professional",
                    language: "es",
                    locale: "en-US",
                    preview_url: "https://example.com/keep.mp3",
                    verified_languages: [{ language: "es", model_id: "eleven_v3" }],
                  },
                  {
                    voice_id: "keep-v2-metadata",
                    name: "V2 metadata only",
                    accent: "american",
                    gender: "male",
                    age: "middle",
                    descriptive: "calm",
                    category: "professional",
                    language: "es",
                    verified_languages: [{ language: "es", model_id: "eleven_multilingual_v2" }],
                  },
                ],
                has_more: false,
                total_count: 2,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?language=es&page_size=30",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        voices: { voiceId: string; verifiedLanguages: { modelId: string }[] }[];
        languageGroups: { language: string; locale: string | null; label: string; count: number }[];
        pageSize: number;
        cachedAt: number;
      };
      expect(body.voices).toHaveLength(2);
      expect(body.voices[0]?.voiceId).toBe("keep-me");
      expect(body.voices[0]?.verifiedLanguages.some((v) => v.modelId === "eleven_v3")).toBe(true);
      expect(body.voices[1]?.voiceId).toBe("keep-v2-metadata");
      expect(body.voices[1]?.verifiedLanguages.some((v) => v.modelId === "eleven_v3")).toBe(false);
      expect(body.languageGroups.find((g) => g.language === "es")?.count).toBe(2);
      expect(body.pageSize).toBe(30);
      expect(body.cachedAt).toBeTypeOf("number");

      const res2 = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?language=es&page_size=30",
        remoteAddress: "127.0.0.1",
      });
      expect(res2.statusCode).toBe(200);
      expect(fetchCalls).toBe(3);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog paginates upstream rows without skipping non-v3 metadata", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    const sharedVoiceUrls: string[] = [];
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            sharedVoiceUrls.push(url);
            const parsed = new URL(url);
            const page = parsed.searchParams.get("page");
            const pageSize = parsed.searchParams.get("page_size");
            if (pageSize === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                voices: page === "0" ? [multilingualOnlyVoice()] : [v3Voice({ voice_id: "later-v3" })],
                has_more: page === "0",
                total_count: 2,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        voices: { voiceId: string }[];
        hasMore: boolean;
      };
      expect(body.voices.map((voice) => voice.voiceId)).toEqual(["voice-v2"]);
      expect(body.hasMore).toBe(true);
      expect(sharedVoiceUrls.some((url) => url.includes("page=0") && url.includes("page_size=100"))).toBe(true);
      expect(sharedVoiceUrls.some((url) => url.includes("page=1") && url.includes("page_size=100"))).toBe(false);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog reuses compatible cache across Load More pages", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    const compatibleScanUrls: string[] = [];
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            const page = parsed.searchParams.get("page");
            const pageSize = parsed.searchParams.get("page_size");
            if (pageSize === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 3 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            compatibleScanUrls.push(url);
            const payload =
              page === "0" ?
                { voices: [multilingualOnlyVoice()], has_more: true, total_count: 3 }
              : page === "1" ?
                { voices: [v3Voice({ voice_id: "first-v3" })], has_more: true, total_count: 3 }
              : { voices: [v3Voice({ voice_id: "second-v3" })], has_more: false, total_count: 3 };
            return new Response(JSON.stringify(payload), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(null);
      const first = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body) as {
        voices: { voiceId: string }[];
        hasMore: boolean;
      };
      expect(firstBody.voices.map((voice) => voice.voiceId)).toEqual(["voice-v2"]);
      expect(firstBody.hasMore).toBe(true);

      const second = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=1&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(second.statusCode).toBe(200);
      const secondBody = JSON.parse(second.body) as {
        voices: { voiceId: string }[];
        hasMore: boolean;
      };
      expect(secondBody.voices.map((voice) => voice.voiceId)).toEqual(["first-v3"]);
      expect(secondBody.hasMore).toBe(true);

      expect(
        compatibleScanUrls.filter((url) => url.includes("page=0") && url.includes("page_size=100")),
      ).toHaveLength(1);
      expect(
        compatibleScanUrls.filter((url) => url.includes("page=2") && url.includes("page_size=100")),
      ).toHaveLength(0);

      const filtered = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?language=es&page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(filtered.statusCode).toBe(200);
      expect(
        compatibleScanUrls.filter((url) => url.includes("page=0") && url.includes("page_size=100")),
      ).toHaveLength(2);
      expect(compatibleScanUrls.some((url) => url.includes("language=es"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog keeps broad language counts separate from compatible rows", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            if (parsed.searchParams.get("page_size") === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 7 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                voices: [v3Voice({ voice_id: "compatible-only-row" })],
                has_more: false,
                total_count: 11,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=30",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        voices: { voiceId: string }[];
        languageGroups: { language: string; locale: string | null; label: string; count: number }[];
        totalCount: number;
      };
      expect(body.voices.map((voice) => voice.voiceId)).toEqual(["compatible-only-row"]);
      expect(body.languageGroups).toEqual([
        { language: "en", locale: null, label: "English", count: 7 },
      ]);
      expect(body.totalCount).toBe(11);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog deduplicates concurrent cache fills", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    let modelFetches = 0;
    const compatibleScanUrls: string[] = [];
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          if (url.includes("/v1/models")) {
            modelFetches += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            if (parsed.searchParams.get("page_size") === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            compatibleScanUrls.push(url);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return new Response(
              JSON.stringify({
                voices: [v3Voice({ voice_id: "deduped-v3" })],
                has_more: false,
                total_count: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(null);
      const [first, second] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/api/voices/catalog?page=0&page_size=1",
          remoteAddress: "127.0.0.1",
        }),
        app.inject({
          method: "GET",
          url: "/api/voices/catalog?page=0&page_size=1",
          remoteAddress: "127.0.0.1",
        }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(modelFetches).toBe(1);
      expect(compatibleScanUrls).toHaveLength(1);
      for (const res of [first, second]) {
        const body = JSON.parse(res.body) as { voices: { voiceId: string }[] };
        expect(body.voices.map((voice) => voice.voiceId)).toEqual(["deduped-v3"]);
      }
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog serves warm persistent cache after memory clear", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    const cache = new FakeVoiceCatalogCache();
    let providerFetches = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          providerFetches += 1;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            if (parsed.searchParams.get("page_size") === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                voices: [v3Voice({ voice_id: "persisted-v3" })],
                has_more: false,
                total_count: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(cache);
      const first = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(first.statusCode).toBe(200);
      expect((JSON.parse(first.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["persisted-v3"]);
      expect(providerFetches).toBeGreaterThan(0);

      clearSharedCatalogCacheForTests();
      providerFetches = 0;
      const second = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(second.statusCode).toBe(200);
      expect((JSON.parse(second.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["persisted-v3"]);
      expect(providerFetches).toBe(0);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog serves stale persistent cache while refreshing", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    const cache = new FakeVoiceCatalogCache();
    let providerFetches = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          providerFetches += 1;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            if (parsed.searchParams.get("page_size") === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                voices: [v3Voice({ voice_id: "refreshed-v3" })],
                has_more: false,
                total_count: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(cache);
      const warm = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(warm.statusCode).toBe(200);

      const now = Date.now();
      for (const row of cache.rows.values()) {
        row.expiresAt = now - 1;
        row.staleAt = now + 60_000;
        if (row.payload.kind === "compatible") {
          row.payload = {
            ...row.payload,
            voices: [filterAndNormalizeSharedCatalog([v3Voice({ voice_id: "stale-v3" })])[0]!],
            expiresAt: now - 1,
          };
        }
      }
      clearSharedCatalogCacheForTests();
      providerFetches = 0;
      const stale = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(stale.statusCode).toBe(200);
      expect((JSON.parse(stale.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["stale-v3"]);

      for (let i = 0; i < 20 && providerFetches === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(providerFetches).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog misses L1 memory cache when provider account changes", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    let compatibleVoiceId = "first-account-v3";
    let providerFetches = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "first-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          providerFetches += 1;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            if (parsed.searchParams.get("page_size") === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                voices: [v3Voice({ voice_id: compatibleVoiceId })],
                has_more: false,
                total_count: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(null);
      const first = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(first.statusCode).toBe(200);
      expect((JSON.parse(first.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["first-account-v3"]);
      const fetchesAfterWarm = providerFetches;

      process.env["ELEVENLABS_API_KEY"] = "second-key";
      compatibleVoiceId = "second-account-v3";
      providerFetches = 0;
      const second = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(second.statusCode).toBe(200);
      expect((JSON.parse(second.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["second-account-v3"]);
      expect(providerFetches).toBeGreaterThan(0);
      expect(fetchesAfterWarm).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog misses persistent cache when provider account changes", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    const cache = new FakeVoiceCatalogCache();
    let compatibleVoiceId = "first-account-v3";
    let providerFetches = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "first-key";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          providerFetches += 1;
          if (url.includes("/v1/models")) {
            return new Response(
              JSON.stringify([
                {
                  model_id: "eleven_v3",
                  can_do_text_to_speech: true,
                  languages: [{ language_id: "en", name: "English" }],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("shared-voices")) {
            const parsed = new URL(url);
            if (parsed.searchParams.get("page_size") === "1") {
              return new Response(
                JSON.stringify({ voices: [v3Voice()], has_more: false, total_count: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                voices: [v3Voice({ voice_id: compatibleVoiceId })],
                has_more: false,
                total_count: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input);
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;

      const app = createVoicesRouteApp(cache);
      const first = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(first.statusCode).toBe(200);
      expect((JSON.parse(first.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["first-account-v3"]);

      clearSharedCatalogCacheForTests();
      process.env["ELEVENLABS_API_KEY"] = "second-key";
      compatibleVoiceId = "second-account-v3";
      providerFetches = 0;
      const second = await app.inject({
        method: "GET",
        url: "/api/voices/catalog?page=0&page_size=1",
        remoteAddress: "127.0.0.1",
      });
      expect(second.statusCode).toBe(200);
      expect((JSON.parse(second.body) as { voices: { voiceId: string }[] }).voices.map((v) => v.voiceId))
        .toEqual(["second-account-v3"]);
      expect(providerFetches).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("GET /api/voices/catalog reaches provider configuration for an authenticated ordinary user", async () => {
    const app = createVoicesRouteApp(null);
    const res = await app.inject({
      method: "GET",
      url: "/api/voices/catalog",
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ elevenLabsConfigured: false });
  });

  test("POST /api/voices/:voiceId/preview returns 400 for bad voice id", async () => {
    const app = createVoicesRouteApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/voices/no_underscore/preview",
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/voices/:voiceId/preview returns 400 when ElevenLabs key missing", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      const app = createVoicesRouteApp(null);
      const res = await app.inject({
        method: "POST",
        url: "/api/voices/JSWO6cw2AyFE324d5kEr/preview",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(400);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  test("POST /api/voices/:voiceId/preview serves authenticated users, contains no provider secret, and remains throttled", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const voiceId = "PreviewThrottleVoice";
    const text = "A synthetic preview sentence. ".repeat(100).trim();
    const identity = JSON.stringify(["speech-preview-v1", "elevenlabs:eleven_v3_conversational", "eleven_v3_conversational", "elevenlabs-dialogue-http", "mp3_44100_128", { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 }, text]);
    const previewPath = voicePreviewPathForCustomText(voiceId, identity);
    const providerRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    try {
      process.env["ELEVENLABS_API_KEY"] = "test-provider-secret";
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url;
          if (typeof init?.body === "string" && init.body.includes("PreviewSecretVoice")) {
            return new Response("upstream diagnostic test-provider-secret", { status: 500 });
          }
          const requestBody = typeof init?.body === "string" ? init.body : "{}";
          const parsedBody: unknown = JSON.parse(requestBody);
          providerRequests.push({
            url,
            body: parsedBody as Record<string, unknown>,
          });
          return new Response(Buffer.from(`mp3-preview-bytes:${url}`), { status: 200 });
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null);

      const providerFailure = await app.inject({
        method: "POST",
        url: "/api/voices/PreviewSecretVoice/preview",
        remoteAddress: "203.0.113.10",
        payload: { text },
      });
      expect(providerFailure.statusCode).toBe(502);
      expect(providerFailure.body).not.toContain("test-provider-secret");
      expect(providerFailure.body).not.toContain("upstream diagnostic");

      const first = await app.inject({
        method: "POST",
        url: `/api/voices/${voiceId}/preview`,
        remoteAddress: "203.0.113.10",
        payload: { text },
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers["content-type"]).toContain("audio/mpeg");
      expect(first.body).not.toContain("test-provider-secret");
      expect(providerRequests[0]?.url).toBe(
        "https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=mp3_44100_128",
      );
      expect(providerRequests.length).toBeGreaterThan(1);
      const spoken = providerRequests.flatMap(request => {
        expect(request.body["model_id"]).toBe("eleven_v3_conversational");
        const inputs = request.body["inputs"] as { text: string; voice_id: string }[];
        for (const input of inputs) expect(input.voice_id).toBe(voiceId);
        return inputs.map(input => input.text);
      }).join("");
      expect(spoken).toBe(text);

      // The rejected provider attempt above also consumes one of the global
      // preview slots, so 18 cached requests take this window to its limit.
      for (let i = 0; i < 18; i += 1) {
        const allowed = await app.inject({
          method: "POST",
          url: `/api/voices/${voiceId}/preview`,
          remoteAddress: "203.0.113.10",
        payload: { text },
        });
        expect(allowed.statusCode).toBe(200);
      }

      const throttled = await app.inject({
        method: "POST",
        url: `/api/voices/${voiceId}/preview`,
        remoteAddress: "203.0.113.10",
        payload: { text },
      });
      expect(throttled.statusCode).toBe(429);
    } finally {
      if (existsSync(previewPath)) await unlink(previewPath);
      if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
      else delete process.env["ELEVENLABS_API_KEY"];
    }
  });
});
