/**
 * D261 Phase 4 — find_voice structured discovery, filters, honesty warnings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FindVoiceToolResult } from "@nautilo/types";
import { ELEVENLABS_CURATED_VOICE_IDS } from "@nautilo/voice";
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

describe("D261 P4 — find_voice discovery", () => {
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
    const tool = createFindVoiceTool();
    const raw = await tool.invoke({ query: "", language: "es", accent: "peninsular", limit: 12 });
    const result = parseFindResult(raw);
    expect(result.candidates.length).toBeGreaterThan(0);
    const lucia = result.candidates.find((c) => c.voiceId === "pen-1");
    expect(lucia).toBeDefined();
    expect(lucia!.accent).toBe("peninsular");
    expect(lucia!.language).toBe("es");
    expect(lucia!.languageLabel).toBe("Spanish");
    expect(lucia!.badge).toBe("provider_v3");
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
    const tool = createFindVoiceTool();
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
    const tool = createFindVoiceTool();
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
});
