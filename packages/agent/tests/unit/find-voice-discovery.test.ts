/**
 * find_voice structured discovery, filters, honesty warnings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FindVoiceToolResult } from "@nautilo/types";
import { ELEVENLABS_CURATED_VOICE_IDS } from "@nautilo/voice";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import type { CapabilityFundingSession } from "../../src/runtime/capability-funding";
import {
  createFindVoiceTool,
  localeConflictsWithLanguage,
  normalizeSharedVoice,
  type ElevenLabsSharedVoiceRaw,
} from "../../src/tools/config/find-voice";

const ORIGINAL_FETCH = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];

function inputUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockSharedVoices(voices: ElevenLabsSharedVoiceRaw[]) {
  globalThis.fetch = (async (input: FetchInput) => {
    const url = inputUrl(input);
    if (url.includes("shared-voices")) {
      return new Response(JSON.stringify({ voices, has_more: false, total_count: voices.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return ORIGINAL_FETCH(input);
  }) as typeof fetch;
}

function parseFindResult(raw: string): FindVoiceToolResult {
  return JSON.parse(raw) as FindVoiceToolResult;
}

function fundedFindVoiceTool() {
  return createFindVoiceTool(
    { causalHumanUserId: "voice-human" },
    { assertCanUseServerProviderCredentials: async () => {} },
  );
}

describe("find_voice discovery", () => {
  const prevKey = process.env["ELEVENLABS_API_KEY"];

  beforeEach(() => {
    process.env["ELEVENLABS_API_KEY"] = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (prevKey !== undefined) process.env["ELEVENLABS_API_KEY"] = prevKey;
    else delete process.env["ELEVENLABS_API_KEY"];
  });

  test("returns structured JSON with voiceId, badge, matchReason", async () => {
    mockSharedVoices([
      {
        voice_id: "pen-1",
        name: "Lucía",
        language: "es",
        accent: "peninsular",
        gender: "female",
        age: "young",
        locale: "es-ES",
        verified_languages: [{ language: "es", model_id: "eleven_v3", accent: "peninsular", locale: "es-ES" }],
      },
    ]);
    const tool = fundedFindVoiceTool();
    const raw = await tool.invoke({ query: "", language: "es", accent: "peninsular", limit: 12 });
    const result = parseFindResult(raw);
    expect(result.candidates.length).toBeGreaterThan(0);
    const lucia = result.candidates.find((c) => c.voiceId === "pen-1");
    expect(lucia).toBeDefined();
    expect(lucia!.accent).toBe("peninsular");
    expect(lucia!.language).toBe("es");
    expect(lucia!.languageLabel).toBe("Spanish");
    expect(lucia!.badge).toBe("provider_verified");
    expect(lucia!.matchReason).toContain("peninsular");
    expect(lucia!.voiceId).toBe("pen-1");
  });

  test("peninsular Spanish filter returns only peninsular provider rows", async () => {
    mockSharedVoices([
      {
        voice_id: "pen-1",
        name: "Lucía",
        language: "es",
        accent: "peninsular",
        gender: "female",
        age: "young",
      },
      {
        voice_id: "lat-1",
        name: "Sofía",
        language: "es",
        accent: "mexican",
        gender: "female",
        age: "young",
      },
    ]);
    const tool = fundedFindVoiceTool();
    const raw = await tool.invoke({ query: "", language: "es", accent: "peninsular", limit: 15 });
    const result = parseFindResult(raw);
    const providerIds = result.candidates
      .filter((c) => c.voiceId === "pen-1" || c.voiceId === "lat-1")
      .map((c) => c.voiceId);
    expect(providerIds).toContain("pen-1");
    expect(providerIds).not.toContain("lat-1");
  });

  test("flags locale conflict for ro-RO row under ru language filter", () => {
    const voice = normalizeSharedVoice({
      voice_id: "mis-1",
      name: "Mislabeled",
      language: "ru",
      locale: "ro-RO",
      accent: "standard",
    });
    expect(localeConflictsWithLanguage(voice, "ru")).toBe(true);
  });

  test("uses the canonical Nautilo name for Carolyn's curated voice ID", () => {
    const voice = normalizeSharedVoice({
      voice_id: ELEVENLABS_CURATED_VOICE_IDS["carolyn"]!,
      name: "untrusted provider listing title",
      language: "en",
    });
    expect(voice.name).toBe("Carolyn");
    expect(voice.source).toBe("curated");
  });

  test("locale-conflict row is demoted and carries honestyWarning in results", async () => {
    mockSharedVoices([
      {
        voice_id: "good-ru",
        name: "Ivan",
        language: "ru",
        locale: "ru-RU",
        accent: "moscow",
      },
      {
        voice_id: "bad-ru",
        name: "Mislabeled RO",
        language: "ru",
        locale: "ro-RO",
        accent: "standard",
      },
    ]);
    const tool = fundedFindVoiceTool();
    const raw = await tool.invoke({ query: "", language: "ru", limit: 12 });
    const result = parseFindResult(raw);
    const bad = result.candidates.find((c) => c.voiceId === "bad-ru");
    const good = result.candidates.find((c) => c.voiceId === "good-ru");
    expect(bad?.honestyWarning).toMatch(/locale ro-RO/i);
    if (bad && good) {
      const badIdx = result.candidates.indexOf(bad);
      const goodIdx = result.candidates.indexOf(good);
      expect(goodIdx).toBeLessThan(badIdx);
    }
  });

  test("curated beatriz included without API when key unset", async () => {
    delete process.env["ELEVENLABS_API_KEY"];
    const tool = createFindVoiceTool();
    const raw = await tool.invoke({ query: "", language: "es", limit: 10 });
    const result = parseFindResult(raw);
    expect(result.elevenLabsConfigured).toBe(false);
    expect(result.candidates.some((c) => c.voiceId === ELEVENLABS_CURATED_VOICE_IDS["beatriz"])).toBe(
      true,
    );
    expect(result.candidates.find((c) => c.badge === "curated")?.name).toMatch(/beatriz/i);
  });

  test("uses the causal Human's admitted personal ElevenLabs account", async () => {
    delete process.env["ELEVENLABS_API_KEY"];
    let serviceRuns = 0;
    globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("xi-api-key")).toBe("personal-voice-key");
      return Response.json({ voices: [{ voice_id: "personal-voice", name: "Personal", language: "en" }], has_more: false });
    }) as typeof fetch;
    const capability: CapabilityFundingSession = {
      humanUserId: "voice-human",
      parentFundingKind: "personal",
      resolveModel: async () => { throw new Error("unused"); },
      openModel: async () => { throw new Error("unused"); },
      openService: async provider => ({
        binding: { kind: "personal", providerRoute: provider, credentialId: "credential", credentialRevision: 1 },
        runAttempt: async callback => {
          serviceRuns += 1;
          return callback({
            apiKey: "personal-voice-key",
            usageFunding: { kind: "personal", humanUserId: "voice-human", payerHumanId: "voice-human", providerRoute: provider, credentialId: "credential", credentialRevision: 1 },
          });
        },
      }),
    };
    const tool = createFindVoiceTool(
      { causalHumanUserId: "voice-human" },
      { getCapabilityFundingSession: () => capability },
    );
    const result = parseFindResult(await tool.invoke({ query: "Personal", limit: 10 }));
    expect(result.elevenLabsConfigured).toBe(true);
    expect(result.candidates.some(candidate => candidate.voiceId === "personal-voice")).toBe(true);
    const noMatch = JSON.parse(await tool.invoke({ query: "impossible-no-match", limit: 10 })) as FindVoiceToolResult & { error?: string };
    expect(noMatch.elevenLabsConfigured).toBe(true);
    expect(noMatch.error).not.toContain("ELEVENLABS_API_KEY");
    expect(serviceRuns).toBe(2);
  });

  test("does not expose provider response bodies in discovery warnings", async () => {
    const secret = "synthetic-provider-secret-account-diagnostic";
    globalThis.fetch = (async () => new Response(secret, { status: 401 })) as unknown as typeof fetch;
    const tool = fundedFindVoiceTool();

    const raw = await tool.invoke({ query: "", language: "es", limit: 10 });
    const result = parseFindResult(raw);

    expect(result.warnings).toEqual([
      "Voice catalog request failed (HTTP 401); showing curated voices only.",
    ]);
    expect(raw).not.toContain(secret);
    expect(result.elevenLabsConfigured).toBe(true);
  });

  test.each([undefined, "not-a-number"])(
    "bounds streamed catalog metadata with content-length %s and cancels the provider body",
    async (contentLength) => {
      let cancelled = false;
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(600_000));
        },
        cancel() { cancelled = true; },
      });
      globalThis.fetch = (async () => new Response(stream, {
        status: 200,
        headers: contentLength === undefined ? {} : { "content-length": contentLength },
      })) as unknown as typeof fetch;
      const tool = fundedFindVoiceTool();

      const raw = await tool.invoke({ query: "", language: "es", limit: 10 });
      const result = parseFindResult(raw);

      expect(pulls).toBeGreaterThanOrEqual(2);
      expect(cancelled).toBe(true);
      expect(result.warnings).toEqual([
        "Voice catalog request failed; showing curated voices only.",
      ]);
      expect(raw).not.toContain("too_large");
    },
  );

  test("reports a closed funding code without exposing funding diagnostics", async () => {
    const secret = "synthetic-custody-diagnostic-secret";
    const capability = {
      humanUserId: "voice-human",
      parentFundingKind: "personal" as const,
      resolveModel: async () => { throw new Error("unused"); },
      openModel: async () => { throw new Error("unused"); },
      openService: async () => {
        throw Object.assign(new Error(secret), { code: "personal_credential_unavailable" });
      },
    } as CapabilityFundingSession;
    const tool = createFindVoiceTool(
      { causalHumanUserId: "voice-human" },
      { getCapabilityFundingSession: () => capability },
    );

    const raw = await tool.invoke({ query: "", language: "es", limit: 10 });
    const result = parseFindResult(raw);

    expect(result.warnings).toEqual([
      "Voice funding is unavailable (personal_credential_unavailable); showing curated voices only.",
    ]);
    expect(raw).not.toContain(secret);
    expect(result.elevenLabsConfigured).toBe(false);
  });

  test("denies remote discovery before fetch for the exact causal Human", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ voices: [], has_more: false });
    }) as unknown as typeof fetch;
    const tool = createFindVoiceTool(
      { causalHumanUserId: "voice-human-denied" },
      {
        assertCanUseServerProviderCredentials: async (humanUserId, origin) => {
          throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      },
    );
    const error = await tool.invoke({ query: "", language: "es", limit: 10 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "server_provider_credentials_required",
      humanUserId: "voice-human-denied",
      origin: "voice_catalog_discovery",
    });
    expect(fetchCalls).toBe(0);
  });
});
