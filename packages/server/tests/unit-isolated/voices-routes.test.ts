/**
 * Voice catalog HTTP routes — hermetic. Mocks `@nautilo/db`, mounts only
 * `voiceRoutes` (no full `createApp` boot), and injects `catalogCache: null`
 * or `FakeVoiceCatalogCache` on every route test so handlers never use the
 * default DB-backed provider catalog cache or open pools at boot/request time.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { getServerSpeechModel } from "@nautilo/agent";
import { ATTACHMENT_POLICY } from "@nautilo/attachments";
import { voicePreviewPathForCustomText } from "@nautilo/voice";
import type { ViewerRole } from "@nautilo/types";
import type { VoiceCatalogPersistentCache, VoiceRouteDeps } from "../../src/routes/voices";
import type { VoiceServiceFunding } from "../../src/realtime/voice-service-funding";
import type { ServerProviderCostAttemptAdmission, ServerProviderCostReceipt } from "../../src/costs/provider-cost-recorder";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import { providerAccountFingerprint } from "../../src/lib/provider-catalog-cache";
import { ModelFundingError } from "../../src/lib/model-funding";
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

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
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
  cleanupGeneratedVoicePreviewCache,
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
      funding?: VoiceServiceFunding;
      beginCost?: (receipt: ServerProviderCostAttemptAdmission) => Promise<void>;
      settleCost?: (receipt: ServerProviderCostReceipt) => Promise<void>;
      resolveSpeechModel?: VoiceRouteDeps["resolveSpeechModel"];
      getCapabilities?: VoiceRouteDeps["getCapabilities"];
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
      ...(input.funding ? { funding: input.funding } : {}),
      ...(input.beginCost ? { beginCost: input.beginCost } : {}),
      ...(input.settleCost ? { settleCost: input.settleCost } : {}),
      ...(input.resolveSpeechModel ? { resolveSpeechModel: input.resolveSpeechModel } : {}),
      getCapabilities: input.getCapabilities ?? (async () => []),
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
      { method: "GET" as const, url: "/api/voices" },
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

  test.each([undefined, "false"])(
    "GET /api/voices bounds streamed provider metadata with content-length %s",
    async (contentLength) => {
      const previousKey = process.env["ELEVENLABS_API_KEY"];
      let cancelled = false;
      try {
        process.env["ELEVENLABS_API_KEY"] = "bounded-hydration-key";
        globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
          cancel() { cancelled = true; },
        }), {
          status: 200,
          headers: contentLength === undefined ? {} : { "content-length": contentLength },
        }), { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
        const app = createVoicesRouteApp(null, { viewerRole: "owner" });

        const res = await app.inject({ method: "GET", url: "/api/voices", remoteAddress: "127.0.0.1" });

        expect(res.statusCode).toBe(502);
        expect(cancelled).toBe(true);
        expect(JSON.parse(res.body)).toMatchObject({ error: "Failed to load voices." });
        expect(res.body).not.toContain("too_large");
      } finally {
        if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
        else delete process.env["ELEVENLABS_API_KEY"];
      }
    },
  );

  test.each(["models", "shared-voices"] as const)(
    "GET /api/voices/catalog bounds streamed %s metadata and cancels the provider body",
    async (oversizedEndpoint) => {
      const previousKey = process.env["ELEVENLABS_API_KEY"];
      let cancelled = false;
      try {
        process.env["ELEVENLABS_API_KEY"] = `bounded-${oversizedEndpoint}-key`;
        globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
          const url = inputUrl(input);
          if (url.includes(oversizedEndpoint)) {
            return new Response(new ReadableStream<Uint8Array>({
              pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
              cancel() { cancelled = true; },
            }), { status: 200, headers: { "content-length": "unknown" } });
          }
          if (url.includes("/v1/models")) {
            return Response.json([{ can_do_text_to_speech: true, languages: [{ language_id: "en" }] }]);
          }
          return Response.json({ voices: [], has_more: false, total_count: 0 });
        }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
        const app = createVoicesRouteApp(null);

        const res = await app.inject({ method: "GET", url: "/api/voices/catalog", remoteAddress: "127.0.0.1" });

        expect(res.statusCode).toBe(502);
        expect(cancelled).toBe(true);
        expect(JSON.parse(res.body)).toMatchObject({ error: "Failed to load voice catalog." });
        expect(res.body).not.toContain("too_large");
      } finally {
        if (previousKey !== undefined) process.env["ELEVENLABS_API_KEY"] = previousKey;
        else delete process.env["ELEVENLABS_API_KEY"];
      }
    },
  );

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

  test("GET /api/voices uses the admitted personal ElevenLabs account without a server key", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const humanUserId = "11111111-1111-4111-8111-111111111111";
    let rechecks = 0;
    const funding: VoiceServiceFunding = {
      admit: async () => ({
        humanUserId,
        provider: "elevenlabs",
        binding: { kind: "personal", providerRoute: "elevenlabs", credentialId: "22222222-2222-4222-8222-222222222222", credentialRevision: 7 },
        credentialFingerprint: "a".repeat(64),
      }),
      run: async (_binding, intent, callback) => {
        expect(intent).toBe("spend");
        rechecks += 1;
        return callback({
          apiKey: "personal-elevenlabs-key",
          usageFunding: { kind: "personal", humanUserId, payerHumanId: humanUserId, providerRoute: "elevenlabs", credentialId: "22222222-2222-4222-8222-222222222222", credentialRevision: 7 },
        });
      },
    };
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(new Headers(init?.headers).get("xi-api-key")).toBe("personal-elevenlabs-key");
        return Response.json({ voices: [{ voice_id: "PersonalVoice", name: "Personal voice" }] });
      }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
      const app = createVoicesRouteApp(null, { sessionUserId: humanUserId, funding });
      const res = await app.inject({ method: "GET", url: "/api/voices", remoteAddress: "127.0.0.1" });
      expect(res.statusCode).toBe(200);
      const body = parseVoiceHydrationBody(res.body);
      expect(body.elevenLabsConfigured).toBe(true);
      expect(body.voices).toEqual([expect.objectContaining({ voiceId: "PersonalVoice" })]);
      expect(rechecks).toBe(1);
    } finally {
      if (previousKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previousKey;
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
      expect(body.error).toBe("Voice provider credentials are not available");
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

  test("preview rejects text over 500 characters before funding admission or provider dispatch", async () => {
    let admissions = 0;
    let providerCalls = 0;
    const funding: VoiceServiceFunding = {
      admit: async () => {
        admissions += 1;
        throw new Error("must not admit");
      },
      run: async () => { throw new Error("must not run"); },
    };
    globalThis.fetch = Object.assign(async () => {
      providerCalls += 1;
      return new Response("must not dispatch", { status: 500 });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const app = createVoicesRouteApp(null, { funding });

    const response = await app.inject({
      method: "POST",
      url: "/api/voices/PreviewLengthVoice/preview",
      remoteAddress: "127.0.0.1",
      payload: { text: "x".repeat(501) },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ errorCode: "preview_text_too_long" });
    expect(admissions).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("voice funding failures keep a stable repair destination and do not dispatch", async () => {
    let providerCalls = 0;
    const funding: VoiceServiceFunding = {
      admit: async () => { throw new ModelFundingError("personal_credential_stale"); },
      run: async () => { throw new Error("must not run"); },
    };
    globalThis.fetch = Object.assign(async () => {
      providerCalls += 1;
      return new Response("must not dispatch", { status: 500 });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const app = createVoicesRouteApp(null, { funding });

    const response = await app.inject({
      method: "POST",
      url: "/api/voices/PreviewFundingVoice/preview",
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "The saved voice provider credential changed.",
      errorCode: "personal_credential_stale",
      repairAction: "replace_provider_credential",
      href: "/settings#personal-provider-keys",
    });
    expect(providerCalls).toBe(0);
  });

  test.each([
    [
      "member",
      "provider_credentials_missing",
      "configure_server_provider_credentials",
      "/admin#provider-credentials",
      ["manage_connection_providers"],
    ],
    [
      "member",
      "provider_credentials_missing",
      "configure_server_provider_credentials",
      "/admin#provider-credentials",
      ["manage_server_settings"],
    ],
    [
      "owner",
      "provider_credentials_missing",
      "contact_operator",
      "/settings#personal-provider-keys",
      [],
    ],
    [
      "member",
      "unsupported_provider",
      "choose_supported_speech_model",
      "/settings#capability-models",
      ["manage_connection_providers"],
    ],
  ] as const)(
    "voice funding repair for %s and %s uses current capabilities for its destination",
    async (viewerRole, code, repairAction, href, capabilities) => {
      let capabilityLookups = 0;
      const funding: VoiceServiceFunding = {
        admit: async () => { throw new ModelFundingError(code); },
        run: async () => { throw new Error("must not run"); },
      };
      const app = createVoicesRouteApp(null, {
        viewerRole,
        funding,
        getCapabilities: async (humanUserId) => {
          expect(humanUserId).toBe("ordinary-user");
          capabilityLookups += 1;
          return [...capabilities];
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/voices/PreviewRepairVoice/preview",
        remoteAddress: "127.0.0.1",
      });

      expect(JSON.parse(response.body)).toMatchObject({
        errorCode: code,
        repairAction,
        href,
      });
      expect(capabilityLookups).toBe(code === "provider_credentials_missing" ? 1 : 0);
    },
  );

  test("preview cost attempts preserve an accepted first part when a later part fails", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const settled: ServerProviderCostReceipt[] = [];
    let providerCalls = 0;
    try {
      process.env["ELEVENLABS_API_KEY"] = "preview-partial-cost-key";
      const baseModel = getServerSpeechModel("elevenlabs:eleven_v3", process.env);
      const model = {
        ...baseModel,
        speech: { ...baseModel.speech, maxInputCharacters: 5 },
      };
      globalThis.fetch = Object.assign(
        async () => {
          providerCalls += 1;
          return providerCalls === 1
            ? new Response(Buffer.from("first-part"), { status: 200 })
            : new Response("later failure", { status: 502 });
        },
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null, {
        resolveSpeechModel: async () => model,
        beginCost: async () => {},
        settleCost: async receipt => { settled.push(receipt); },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/voices/PreviewPartialCostVoice/preview",
        remoteAddress: "127.0.0.1",
        payload: { text: "abcdefghij" },
      });

      expect(response.statusCode).toBe(502);
      expect(providerCalls).toBe(2);
      expect(settled).toHaveLength(2);
      expect(settled[0]).toMatchObject({
        evidenceState: "estimated",
        attemptOutcome: "succeeded",
      });
      expect(settled[0]?.estimatedCostUsd).not.toBeNull();
      expect(settled[1]).toMatchObject({
        estimatedCostUsd: null,
        evidenceState: "unknown",
        attemptOutcome: "failed",
        failureCode: "provider_error",
      });
    } finally {
      if (previousKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previousKey;
    }
  });

  test("preview cost records an accepted response whose body read fails", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const settled: ServerProviderCostReceipt[] = [];
    try {
      process.env["ELEVENLABS_API_KEY"] = "preview-body-failure-key";
      const model = getServerSpeechModel("elevenlabs:eleven_v3", process.env);
      globalThis.fetch = Object.assign(
        async () => new Response(new ReadableStream({
          start(controller) { controller.error(new Error("body read failed")); },
        }), { status: 200 }),
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null, {
        resolveSpeechModel: async () => model,
        beginCost: async () => {},
        settleCost: async receipt => { settled.push(receipt); },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/voices/PreviewBodyFailureVoice/preview",
        remoteAddress: "127.0.0.1",
        payload: { text: "charged response body" },
      });

      expect(response.statusCode).toBe(502);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        evidenceState: "estimated",
        attemptOutcome: "failed",
        failureCode: "provider_error",
      });
      expect(settled[0]?.estimatedCostUsd).not.toBeNull();
    } finally {
      if (previousKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previousKey;
    }
  });

  test("preview bounds aggregate audio across parts and cancels an oversized streamed part", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const settled: ServerProviderCostReceipt[] = [];
    let providerCalls = 0;
    let cancelled = false;
    try {
      process.env["ELEVENLABS_API_KEY"] = "preview-aggregate-limit-key";
      const baseModel = getServerSpeechModel("elevenlabs:eleven_v3", process.env);
      const model = { ...baseModel, speech: { ...baseModel.speech, maxInputCharacters: 1 } };
      globalThis.fetch = Object.assign(async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return new Response(new Uint8Array(ATTACHMENT_POLICY.maxAudioBytes - 1), { status: 200 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(2)); },
          cancel() { cancelled = true; },
        }), { status: 200, headers: { "content-length": "unknown" } });
      }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
      const app = createVoicesRouteApp(null, {
        resolveSpeechModel: async () => model,
        beginCost: async () => {},
        settleCost: async receipt => { settled.push(receipt); },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/voices/PreviewAggregateLimitVoice/preview",
        remoteAddress: "127.0.0.1",
        payload: { text: "ab" },
      });

      expect(response.statusCode).toBe(502);
      expect(providerCalls).toBe(2);
      expect(cancelled).toBe(true);
      expect(response.body).toBe('{"error":"Voice preview failed."}');
      expect(settled.map(receipt => receipt.attemptOutcome)).toEqual(["succeeded", "failed"]);
      expect(settled.every(receipt => receipt.evidenceState === "estimated")).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previousKey;
    }
  });

  test("preview delivery succeeds when post-provider cost settlement fails", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const voiceId = "PreviewSettlementFailureVoice";
    const text = "valid paid preview";
    let previewPath = "";
    try {
      process.env["ELEVENLABS_API_KEY"] = "preview-settlement-failure-key";
      const model = getServerSpeechModel("elevenlabs:eleven_v3", process.env);
      previewPath = voicePreviewPathForCustomText(voiceId, JSON.stringify([
        "speech-preview-v2",
        providerAccountFingerprint("preview-settlement-failure-key"),
        model.id,
        model.providerModelId,
        model.speech.transport,
        "mp3_44100_128",
        { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
        text,
      ]));
      globalThis.fetch = Object.assign(
        async () => new Response(Buffer.from("valid-preview"), { status: 200 }),
        { preconnect: realFetch.preconnect.bind(realFetch) },
      ) as typeof fetch;
      const app = createVoicesRouteApp(null, {
        resolveSpeechModel: async () => model,
        beginCost: async () => {},
        settleCost: async () => { throw new Error("settlement unavailable"); },
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/voices/${voiceId}/preview`,
        remoteAddress: "127.0.0.1",
        payload: { text },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("valid-preview");
    } finally {
      if (previewPath && existsSync(previewPath)) await unlink(previewPath);
      if (previousKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previousKey;
    }
  });

  test("preview cleanup does not remove a path while its generation is active", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const key = "preview-active-writer-key";
    const voiceId = "PreviewActiveWriterVoice";
    const text = "active preview writer";
    const model = getServerSpeechModel("elevenlabs:eleven_v3", { ELEVENLABS_API_KEY: key });
    const previewPath = voicePreviewPathForCustomText(voiceId, JSON.stringify([
      "speech-preview-v2",
      providerAccountFingerprint(key),
      model.id,
      model.providerModelId,
      model.speech.transport,
      "mp3_44100_128",
      { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
      text,
    ]));
    let markStarted!: () => void;
    let finishProvider!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const providerGate = new Promise<void>(resolve => { finishProvider = resolve; });
    try {
      process.env["ELEVENLABS_API_KEY"] = key;
      await mkdir(dirname(previewPath), { recursive: true });
      await unlink(previewPath).catch(() => {});
      globalThis.fetch = Object.assign(async () => {
        markStarted();
        await providerGate;
        return new Response(Buffer.from("finished-preview"), { status: 200 });
      }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
      const app = createVoicesRouteApp(null, { resolveSpeechModel: async () => model });

      const request = app.inject({
        method: "POST",
        url: `/api/voices/${voiceId}/preview`,
        remoteAddress: "127.0.0.1",
        payload: { text },
      });
      await started;
      await writeFile(previewPath, "in-progress-placeholder");
      await utimes(previewPath, new Date(0), new Date(0));

      await cleanupGeneratedVoicePreviewCache(dirname(previewPath));
      expect(existsSync(previewPath)).toBe(true);

      finishProvider();
      const response = await request;
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("finished-preview");
    } finally {
      finishProvider();
      await unlink(previewPath).catch(() => {});
      if (previousKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previousKey;
    }
  });

  test("POST /api/voices/:voiceId/preview serves authenticated users, contains no provider secret, and remains throttled", async () => {
    const previousKey = process.env["ELEVENLABS_API_KEY"];
    const voiceId = "PreviewThrottleVoice";
    const text = "A synthetic preview sentence. ".repeat(10).trim();
    const identity = JSON.stringify(["speech-preview-v2", providerAccountFingerprint("test-provider-secret"), "elevenlabs:eleven_v3_conversational", "eleven_v3_conversational", "elevenlabs-dialogue-http", "mp3_44100_128", { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 }, text]);
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
      expect(first.headers["cache-control"]).toBe("private, no-store");
      expect(first.body).not.toContain("test-provider-secret");
      expect(providerRequests[0]?.url).toBe(
        "https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=mp3_44100_128",
      );
      expect(providerRequests.length).toBeGreaterThanOrEqual(1);
      const spoken = providerRequests.flatMap(request => {
        expect(request.body["model_id"]).toBe("eleven_v3_conversational");
        const inputs = request.body["inputs"] as { text: string; voice_id: string }[];
        for (const input of inputs) expect(input.voice_id).toBe(voiceId);
        return inputs.map(input => input.text);
      }).join("");
      expect(spoken).toBe(text);

      // The rejected provider attempt above also consumes one slot for this
      // exact provider account, so 18 cached requests take it to the limit.
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

  test("generated preview cleanup removes only old canonical files and bounds the remainder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-voice-preview-cleanup-"));
    const externalTarget = join(directory, "external-target.mp3");
    const unrelated = join(directory, "keep-me.mp3");
    try {
      await writeFile(externalTarget, "external");
      await writeFile(unrelated, "unrelated");
      const oldGenerated = join(directory, `OldVoice_t_${"a".repeat(24)}.mp3`);
      await writeFile(oldGenerated, "old");
      await utimes(oldGenerated, new Date(0), new Date(0));
      await symlink(externalTarget, join(directory, `LinkVoice_t_${"b".repeat(24)}.mp3`));

      const writes: Promise<void>[] = [];
      for (let index = 0; index < 1_002; index += 1) {
        const hash = index.toString(16).padStart(24, "0");
        writes.push(writeFile(join(directory, `BoundVoice_t_${hash}.mp3`), String(index)));
      }
      await Promise.all(writes);

      await cleanupGeneratedVoicePreviewCache(directory);

      const names = await readdir(directory);
      expect(names).toContain("external-target.mp3");
      expect(names).toContain("keep-me.mp3");
      expect(names).toContain(`LinkVoice_t_${"b".repeat(24)}.mp3`);
      expect(names).not.toContain(`OldVoice_t_${"a".repeat(24)}.mp3`);
      expect(names.filter(name => /^BoundVoice_t_[0-9a-f]{24}\.mp3$/.test(name))).toHaveLength(1_000);
      expect(await Bun.file(externalTarget).text()).toBe("external");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
