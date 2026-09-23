/**
 * D261 Phase 4 — audition_voices slate, convenience mode, read-only contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditionVoicesToolResult, VoiceDiscoveryCandidate } from "@nautilo/types";
import { createAuditionVoicesTool } from "../../src/tools/config/audition-voices";
import { createManageVoicesTool } from "../../src/tools/config/manage-voices";
import type { ElevenLabsSharedVoiceRaw } from "../../src/tools/config/find-voice";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

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

function parseAudition(raw: unknown): AuditionVoicesToolResult {
  if (typeof raw !== "string") throw new Error("expected string tool result");
  return JSON.parse(raw) as AuditionVoicesToolResult;
}

function fundedAuditionVoicesTool() {
  return createAuditionVoicesTool(
    { causalHumanUserId: "voice-human" },
    { assertCanUseServerProviderCredentials: async () => {} },
  );
}

function candidate(overrides: Partial<VoiceDiscoveryCandidate> = {}): VoiceDiscoveryCandidate {
  return {
    voiceId: "candidate-1",
    name: "Candidate One",
    language: "de",
    languageLabel: "German",
    accent: "standard",
    gender: "female",
    age: "young",
    badge: "unverified",
    previewUrl: "https://example.test/candidate-1.mp3",
    verifiedLanguages: [
      {
        language: "de",
        modelId: "eleven_turbo_v2_5",
        accent: "standard",
        locale: "de-DE",
        previewUrl: "https://example.test/candidate-1-verified.mp3",
      },
    ],
    matchReason: "German, female, natural",
    ...overrides,
  };
}

describe("D261 P4 — audition_voices", () => {
  const prevKey = process.env["ELEVENLABS_API_KEY"];

  beforeEach(() => {
    process.env["ELEVENLABS_API_KEY"] = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (prevKey !== undefined) process.env["ELEVENLABS_API_KEY"] = prevKey;
    else delete process.env["ELEVENLABS_API_KEY"];
  });

  test("candidate slate is stateless and preserves metadata without API key", async () => {
    delete process.env["ELEVENLABS_API_KEY"];
    globalThis.fetch = Object.assign(
      async (_input: FetchInput) => {
        throw new Error("candidate slate should not fetch");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    );

    const tool = fundedAuditionVoicesTool();
    const raw = await tool.invoke({
      role: "de",
      sampleText: "Hallo, ich bin Jeannie.",
      candidates: [
        candidate({ voiceId: "shared-a", name: "Darinka" }),
        candidate({ voiceId: "shared-b", name: "Miriam", previewUrl: "https://example.test/miriam.mp3" }),
      ],
    });
    const result = parseAudition(raw);

    expect(result.role).toBe("de");
    expect(result.sampleText).toBe("Hallo, ich bin Jeannie.");
    expect(result.consideredCount).toBe(2);
    expect(result.slate.map((c) => c.voiceId)).toEqual(["shared-a", "shared-b"]);
    expect(result.slate[1]?.previewUrl).toBe("https://example.test/miriam.mp3");
    expect(raw).not.toMatch(/Unknown or unavailable/);
  });

  test("explicit candidate slate preserves every supplied candidate", async () => {
    const tool = fundedAuditionVoicesTool();
    const raw = await tool.invoke({
      candidates: [
        candidate({ voiceId: "one" }),
        candidate({ voiceId: "two" }),
        candidate({ voiceId: "three" }),
        candidate({ voiceId: "four" }),
      ],
    });
    const result = parseAudition(raw);
    expect(result.consideredCount).toBe(4);
    expect(result.slate.map((c) => c.voiceId)).toEqual(["one", "two", "three", "four"]);
  });

  test("convenience query mode defaults to a suggested slate of 3 with consideredCount", async () => {
    mockSharedVoices(
      Array.from({ length: 5 }, (_, i) => ({
        voice_id: `v-${i}`,
        name: `Voice ${i}`,
        language: "es",
        accent: "peninsular",
      })),
    );
    const tool = fundedAuditionVoicesTool();
    const raw = await tool.invoke({
      language: "es",
      accent: "peninsular",
      sampleText: "Hola, probemos esta voz.",
      query: "",
      limit: 3,
    });
    const result = parseAudition(raw);
    expect(result.suggestedSlate).toBe(true);
    expect(result.sampleText).toBe("Hola, probemos esta voz.");
    expect(result.slate.length).toBeLessThanOrEqual(3);
    expect(result.consideredCount).toBeGreaterThan(0);
  });

  test("convenience mode passes a requested size to discovery without a second audition cap", async () => {
    mockSharedVoices(
      Array.from({ length: 5 }, (_, i) => ({
        voice_id: `v-${i}`,
        name: `Voice ${i}`,
        language: "es",
        accent: "peninsular",
      })),
    );
    const tool = fundedAuditionVoicesTool();
    const raw = await tool.invoke({ language: "es", limit: 4 });
    const result = parseAudition(raw);
    expect(result.suggestedSlate).toBe(true);
    expect(result.slate).toHaveLength(4);
  });

  test("does not write profile (manage_voices is separate)", () => {
    const audition = createAuditionVoicesTool();
    const manage = createManageVoicesTool({ ownerId: "user-1", agentId: "agent-1" } as never);
    expect(audition.name).toBe("audition_voices");
    expect(manage.name).toBe("manage_voices");
    expect(audition.description).toMatch(/read-only/i);
    expect(audition.description).not.toMatch(/add.*profile/i);
  });

  test("convenience discovery preserves funding denial and makes no provider call", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ voices: [], has_more: false });
    }) as unknown as typeof fetch;
    const tool = createAuditionVoicesTool(
      { causalHumanUserId: "voice-human-denied" },
      {
        assertCanUseServerProviderCredentials: async (humanUserId, origin) => {
          throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      },
    );
    const error = await tool.invoke({ language: "es", limit: 3 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "server_provider_credentials_required",
      humanUserId: "voice-human-denied",
    });
    expect(fetchCalls).toBe(0);
  });
});
