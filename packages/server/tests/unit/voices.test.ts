import { describe, expect, test } from "bun:test";
import {
  buildLanguageGroups,
  catalogCacheKey,
  catalogLanguageLabel,
  filterAndNormalizeSharedCatalog,
  isEmotionCompatibleVoice,
  isValidElevenLabsVoiceId,
  normalizeCatalogPageSize,
} from "../../src/routes/voices";
import { multilingualOnlyVoice, v3Voice } from "../helpers/voices-test-fixtures";

describe("emotion-compatible catalog filter", () => {
  test("keeps voices verified for eleven_v3", () => {
    expect(isEmotionCompatibleVoice(v3Voice())).toBe(true);
  });

  test("keeps voices with eleven_v3 in high_quality_base_model_ids", () => {
    expect(
      isEmotionCompatibleVoice(
        v3Voice({
          verified_languages: [],
          high_quality_base_model_ids: ["eleven_v3"],
        }),
      ),
    ).toBe(true);
  });

  test("keeps voices even when ElevenLabs metadata omits eleven_v3", () => {
    expect(isEmotionCompatibleVoice(multilingualOnlyVoice())).toBe(true);
  });

  test("filterAndNormalizeSharedCatalog keeps non-v3-verified voices", () => {
    const out = filterAndNormalizeSharedCatalog([v3Voice(), multilingualOnlyVoice()]);
    expect(out).toHaveLength(2);
    expect(out[0]?.voiceId).toBe("voice-v3");
    expect(out[1]?.voiceId).toBe("voice-v2");
    expect(out[0]?.languageLabel).toBe("English");
  });

  test("marks curated voices as curated even when provider metadata omits v3", () => {
    const out = filterAndNormalizeSharedCatalog([
      v3Voice({
        voice_id: "gJlzF5JxsCvM5hQAoRyD",
        name: "Beatriz",
        language: "es",
        verified_languages: [{ language: "es", model_id: "eleven_multilingual_v2" }],
        high_quality_base_model_ids: ["eleven_multilingual_v2"],
      }),
    ]);
    expect(out[0]?.source).toBe("curated");
  });

  test("keeps Carolyn's canonical name while treating her as a catalog voice", () => {
    const out = filterAndNormalizeSharedCatalog([
      v3Voice({
        voice_id: "JSWO6cw2AyFE324d5kEr",
        name: "untrusted provider listing title",
        language: "en",
      }),
    ]);
    expect(out[0]?.name).toBe("Carolyn");
    expect(out[0]?.source).toBe("provider");
  });

  test("normalizes language metadata from the v3 verified language when top-level fields are absent", () => {
    const out = filterAndNormalizeSharedCatalog([
      v3Voice({
        language: null,
        locale: null,
        accent: null,
        preview_url: null,
        verified_languages: [
          {
            language: "es",
            model_id: "eleven_v3",
            accent: "castilian",
            locale: "es-ES",
            preview_url: "https://example.com/es-preview.mp3",
          },
        ],
      }),
    ]);
    expect(out[0]?.language).toBe("es");
    expect(out[0]?.locale).toBe("es-ES");
    expect(out[0]?.languageLabel).toBe("Spanish");
    expect(out[0]?.accent).toBe("castilian");
    expect(out[0]?.previewUrl).toBe("https://example.com/es-preview.mp3");
  });
});

describe("catalog language grouping", () => {
  test("uses stable fallback label for unknown language", () => {
    expect(catalogLanguageLabel("")).toBe("Unknown language");
    expect(catalogLanguageLabel("xx")).toBe("XX");
  });

  test("sorts English and Spanish first, then alphabetical", () => {
    const voices = filterAndNormalizeSharedCatalog([
      v3Voice({ voice_id: "fr-1", language: "fr", locale: "fr-FR" }),
      v3Voice({ voice_id: "es-1", language: "es", locale: "es-ES" }),
      v3Voice({ voice_id: "en-1", language: "en", locale: "en-US" }),
      v3Voice({ voice_id: "de-1", language: "de", locale: "de-DE" }),
    ]);
    const groups = buildLanguageGroups(voices);
    expect(groups.map((g) => g.language)).toEqual(["en", "es", "fr", "de"]);
    expect(groups[0]?.label).toBe("English");
    expect(groups[0]?.count).toBe(1);
    expect(groups[1]?.label).toBe("Spanish");
  });

  test("normalizeCatalogPageSize defaults to 30 and caps at 100", () => {
    expect(normalizeCatalogPageSize(undefined)).toBe(30);
    expect(normalizeCatalogPageSize("999")).toBe(100);
    expect(normalizeCatalogPageSize("-5")).toBe(30);
  });

  test("catalogCacheKey is deterministic regardless of param order", () => {
    const a = catalogCacheKey({ page: "0", language: "en", page_size: "30" });
    const b = catalogCacheKey({ language: "en", page_size: "30", page: "0" });
    expect(a).toBe(b);
  });
});

describe("isValidElevenLabsVoiceId", () => {
  test("accepts typical ids", () => {
    expect(isValidElevenLabsVoiceId("JSWO6cw2AyFE324d5kEr")).toBe(true);
  });
  test("rejects path-ish values", () => {
    expect(isValidElevenLabsVoiceId("abc/def")).toBe(false);
  });
});
