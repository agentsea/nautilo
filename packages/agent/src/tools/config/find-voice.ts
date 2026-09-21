import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  ELEVENLABS_CURATED_VOICE_IDS,
  curatedVoiceDisplayName,
  curatedVoiceDisplayNameForId,
  type VoiceCatalogEntry,
} from "@nautilo/voice";
import type {
  CatalogVerifiedLanguage,
  CatalogVoice,
  FindVoiceToolResult,
  VoiceDiscoveryBadge,
  VoiceDiscoveryCandidate,
} from "@nautilo/types";

/** Curated slug → primary language subtag (matches server catalog metadata). */
const CURATED_VOICE_LANGUAGE: Record<string, string> = {
  carolyn: "en",
  jessica: "en",
  beatriz: "es",
  augustin: "fr",
  daniel: "de",
  kana: "ja",
};

const CURATED_VOICE_ID_SET = new Set(Object.values(ELEVENLABS_CURATED_VOICE_IDS));


const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  ja: "Japanese",
  ru: "Russian",
  zh: "Chinese",
  ro: "Romanian",
};

const DEFAULT_BROWSE_LIMIT = 12;
const MAX_BROWSE_LIMIT = 15;
const MAX_SHARED_PAGES = 4;
const SHARED_PAGE_SIZE = 30;

export type ElevenLabsSharedVoiceRaw = {
  voice_id: string;
  name: string;
  accent?: string | null;
  gender?: string;
  age?: string;
  descriptive?: string;
  category?: string;
  language?: string | null;
  locale?: string | null;
  preview_url?: string | null;
  verified_languages?: Array<{
    language: string;
    model_id: string;
    accent?: string | null;
    locale?: string | null;
    preview_url?: string | null;
  }> | null;
};

export type DiscoverVoicesInput = {
  query?: string;
  language?: string;
  accent?: string;
  gender?: string;
  age?: string;
  qualityPreference?: "high_quality" | "any";
  limit?: number;
};

function catalogLanguageLabel(language: string | null | undefined): string {
  const code = (language ?? "").trim().toLowerCase();
  if (!code) return "Unknown language";
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

function normalizeVerifiedLanguages(
  raw: ElevenLabsSharedVoiceRaw["verified_languages"],
): CatalogVerifiedLanguage[] {
  if (!raw) return [];
  return raw.map((entry) => ({
    language: entry.language,
    modelId: entry.model_id,
    accent: entry.accent ?? null,
    locale: entry.locale ?? null,
    previewUrl: entry.preview_url ?? null,
  }));
}

function firstVerifiedLanguage(
  raw: ElevenLabsSharedVoiceRaw["verified_languages"],
): CatalogVerifiedLanguage | null {
  return (
    normalizeVerifiedLanguages(raw)[0] ??
    null
  );
}

export function normalizeSharedVoice(voice: ElevenLabsSharedVoiceRaw): CatalogVoice {
  const verifiedReference = firstVerifiedLanguage(voice.verified_languages);
  const language = (voice.language ?? verifiedReference?.language ?? "").trim() || "unknown";
  const locale = voice.locale ?? verifiedReference?.locale ?? null;
  const canonicalCuratedName = curatedVoiceDisplayNameForId(voice.voice_id);
  return {
    voiceId: voice.voice_id,
    name: canonicalCuratedName ?? voice.name,
    accent: voice.accent ?? verifiedReference?.accent ?? "",
    gender: voice.gender ?? "",
    age: voice.age ?? "",
    descriptive: voice.descriptive ?? "",
    category: voice.category ?? "",
    language,
    locale,
    languageLabel: catalogLanguageLabel(language),
    previewUrl: voice.preview_url ?? verifiedReference?.previewUrl ?? null,
    verifiedLanguages: normalizeVerifiedLanguages(voice.verified_languages),
    source: CURATED_VOICE_ID_SET.has(voice.voice_id) ? "curated" : "provider",
  };
}

function filterAndNormalizeSharedCatalog(rawVoices: ElevenLabsSharedVoiceRaw[]): CatalogVoice[] {
  return rawVoices
    .filter((voice) => Boolean(voice.voice_id && voice.name))
    .map(normalizeSharedVoice);
}

function curatedCatalogVoices(): CatalogVoice[] {
  return Object.entries(ELEVENLABS_CURATED_VOICE_IDS).map(([slug, voiceId]) => ({
    voiceId,
    name: curatedVoiceDisplayName(slug),
    accent: "",
    gender: "",
    age: "",
    descriptive: "Built-in default; works without ElevenLabs catalog fetch.",
    category: "",
    language: CURATED_VOICE_LANGUAGE[slug] ?? "unknown",
    locale: null,
    languageLabel: catalogLanguageLabel(CURATED_VOICE_LANGUAGE[slug]),
    previewUrl: null,
    verifiedLanguages: [],
    source: "curated" as const,
  }));
}

function catalogHaystack(v: CatalogVoice | VoiceCatalogEntry): string {
  const labels =
    "labels" in v ?
      Object.entries(v.labels)
        .map(([k, val]) => `${k}=${val}`)
        .join(" ")
    : [
        v.name,
        v.accent,
        v.gender,
        v.age,
        v.descriptive,
        v.language,
        v.languageLabel,
        v.category,
      ].join(" ");
  return [v.name, "description" in v ? (v.description ?? "") : v.descriptive, labels]
    .join(" ")
    .toLowerCase();
}

function matchesQuery(voice: CatalogVoice, query: string | undefined): boolean {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = catalogHaystack(voice);
  const words = q.split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function matchesLanguage(voice: CatalogVoice, language: string | undefined): boolean {
  if (!language?.trim()) return true;
  const want = language.trim().toLowerCase();
  const wantPrimary = want.split("-")[0]!;
  const entryLang = voice.language.trim().toLowerCase();
  const entryPrimary = entryLang.split("-")[0]!;
  return entryLang === want || entryPrimary === wantPrimary;
}

function matchesAccent(voice: CatalogVoice, accent: string | undefined): boolean {
  if (!accent?.trim()) return true;
  const want = normalizeToken(accent);
  const voiceAccent = normalizeToken(voice.accent);
  if (voiceAccent && voiceAccent === want) return true;
  return voice.verifiedLanguages.some((v) => normalizeToken(v.accent ?? "") === want);
}

function matchesGender(voice: CatalogVoice, gender: string | undefined): boolean {
  if (!gender?.trim()) return true;
  return normalizeToken(voice.gender) === normalizeToken(gender);
}

function matchesAge(voice: CatalogVoice, age: string | undefined): boolean {
  if (!age?.trim()) return true;
  return normalizeToken(voice.age) === normalizeToken(age);
}

/** Locale primary subtag disagrees with requested language (e.g. ro-RO under ru filter). */
export function localeConflictsWithLanguage(
  voice: CatalogVoice,
  language: string | undefined,
): boolean {
  if (!language?.trim() || !voice.locale) return false;
  const wantPrimary = language.trim().toLowerCase().split("-")[0]!;
  const localePrimary = voice.locale.trim().toLowerCase().split("-")[0]!;
  const voiceLangPrimary = voice.language.trim().toLowerCase().split("-")[0]!;
  if (voiceLangPrimary !== wantPrimary) return false;
  return localePrimary !== wantPrimary;
}

function voiceDiscoveryBadge(voice: CatalogVoice): VoiceDiscoveryBadge {
  if (voice.source === "curated") return "curated";
  if (voice.verifiedLanguages.length > 0) {
    return "provider_verified";
  }
  return "unverified";
}

function honestyWarningFor(
  voice: CatalogVoice,
  input: DiscoverVoicesInput,
): string | undefined {
  const warnings: string[] = [];
  if (localeConflictsWithLanguage(voice, input.language)) {
    warnings.push(
      `locale ${voice.locale} may not match requested language ${input.language} — verify before assign`,
    );
  }
  if (input.accent?.trim() && !voice.accent.trim()) {
    warnings.push("accent metadata missing on this catalog row");
  }
  return warnings.length > 0 ? warnings.join("; ") : undefined;
}

function buildMatchReason(voice: CatalogVoice, input: DiscoverVoicesInput): string {
  const parts: string[] = [];
  if (voice.source === "curated") parts.push("curated Nautilo default");
  if (input.language?.trim()) parts.push(`language=${input.language.trim()}`);
  if (input.accent?.trim()) parts.push(`accent=${input.accent.trim()}`);
  if (input.gender?.trim()) parts.push(`gender=${input.gender.trim()}`);
  if (input.age?.trim()) parts.push(`age=${input.age.trim()}`);
  if (input.qualityPreference === "high_quality") parts.push("quality=high_quality");
  if (input.query?.trim()) parts.push(`keywords="${input.query.trim()}"`);
  if (voiceDiscoveryBadge(voice) === "provider_verified") parts.push("provider language reference; audition with the server speech model");
  if (parts.length === 0) return "catalog match";
  return parts.join("; ");
}

function toDiscoveryCandidate(
  voice: CatalogVoice,
  input: DiscoverVoicesInput,
): VoiceDiscoveryCandidate {
  const candidate: VoiceDiscoveryCandidate = {
    voiceId: voice.voiceId,
    name: voice.name,
    language: voice.language,
    languageLabel: voice.languageLabel,
    accent: voice.accent,
    gender: voice.gender,
    age: voice.age,
    badge: voiceDiscoveryBadge(voice),
    previewUrl: voice.previewUrl,
    verifiedLanguages: voice.verifiedLanguages,
    matchReason: buildMatchReason(voice, input),
  };
  const warning = honestyWarningFor(voice, input);
  if (warning !== undefined) candidate.honestyWarning = warning;
  return candidate;
}

function rankScore(voice: CatalogVoice, input: DiscoverVoicesInput): number {
  let score = 0;
  if (voice.source === "curated") score += 1_000;
  if (voiceDiscoveryBadge(voice) === "provider_verified") score += 100;
  if (input.accent?.trim() && matchesAccent(voice, input.accent)) score += 50;
  if (matchesQuery(voice, input.query)) score += 10;
  if (localeConflictsWithLanguage(voice, input.language)) score -= 500;
  return score;
}

function dedupeVoices(voices: CatalogVoice[]): CatalogVoice[] {
  const seen = new Set<string>();
  const out: CatalogVoice[] = [];
  for (const v of voices) {
    if (seen.has(v.voiceId)) continue;
    seen.add(v.voiceId);
    out.push(v);
  }
  return out;
}

function buildUpstreamParams(input: DiscoverVoicesInput): Record<string, string> {
  const out: Record<string, string> = { page: "0", page_size: String(SHARED_PAGE_SIZE) };
  if (input.language?.trim()) out["language"] = input.language.trim();
  if (input.accent?.trim()) out["accent"] = input.accent.trim();
  if (input.gender?.trim()) out["gender"] = input.gender.trim();
  if (input.age?.trim()) out["age"] = input.age.trim();
  if (input.qualityPreference === "high_quality") out["category"] = "high_quality";
  if (input.query?.trim()) out["search"] = input.query.trim();
  return out;
}

async function fetchSharedVoicesPage(
  apiKey: string,
  params: Record<string, string>,
): Promise<{ voices: ElevenLabsSharedVoiceRaw[]; hasMore: boolean }> {
  const url = new URL("https://api.elevenlabs.io/v1/shared-voices");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url.toString(), { headers: { "xi-api-key": apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs shared-voices ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    voices?: ElevenLabsSharedVoiceRaw[];
    has_more?: boolean;
  };
  return { voices: data.voices ?? [], hasMore: data.has_more ?? false };
}

async function fetchSharedCatalog(
  apiKey: string,
  input: DiscoverVoicesInput,
  targetCount: number,
): Promise<{ voices: CatalogVoice[]; consideredCount: number }> {
  const params = buildUpstreamParams(input);
  const collected: CatalogVoice[] = [];
  let considered = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore && page < MAX_SHARED_PAGES && collected.length < targetCount * 3) {
    const upstream = await fetchSharedVoicesPage(apiKey, {
      ...params,
      page: String(page),
      page_size: String(SHARED_PAGE_SIZE),
    });
    const normalized = filterAndNormalizeSharedCatalog(upstream.voices);
    considered += normalized.length;
    collected.push(...normalized);
    hasMore = upstream.hasMore;
    page += 1;
  }

  return { voices: collected, consideredCount: considered };
}

function applyLocalFilters(voices: CatalogVoice[], input: DiscoverVoicesInput): CatalogVoice[] {
  return voices.filter(
    (v) =>
      matchesLanguage(v, input.language) &&
      matchesAccent(v, input.accent) &&
      matchesGender(v, input.gender) &&
      matchesAge(v, input.age) &&
      matchesQuery(v, input.query),
  );
}

function rankAndLimit(
  voices: CatalogVoice[],
  input: DiscoverVoicesInput,
  limit: number,
): CatalogVoice[] {
  return [...voices]
    .sort((a, b) => rankScore(b, input) - rankScore(a, input))
    .slice(0, limit);
}

export async function discoverVoices(
  input: DiscoverVoicesInput,
): Promise<FindVoiceToolResult> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_BROWSE_LIMIT, 1),
    MAX_BROWSE_LIMIT,
  );
  const apiKey = process.env["ELEVENLABS_API_KEY"]?.trim();
  const warnings: string[] = [];

  let pool = curatedCatalogVoices();
  let consideredCount = pool.length;

  if (apiKey) {
    try {
      const remote = await fetchSharedCatalog(apiKey, input, limit);
      pool = dedupeVoices([...pool, ...remote.voices]);
      consideredCount = remote.consideredCount + curatedCatalogVoices().length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`ElevenLabs catalog fetch failed (${msg}); showing curated voices only.`);
    }
  } else {
    warnings.push("ELEVENLABS_API_KEY not set; curated defaults only.");
  }

  const filtered = applyLocalFilters(pool, input);
  const ranked = rankAndLimit(filtered, input, limit);
  const candidates = ranked.map((v) => toDiscoveryCandidate(v, input));

  const result: FindVoiceToolResult = {
    candidates,
    consideredCount,
    elevenLabsConfigured: Boolean(apiKey),
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export function createFindVoiceTool() {
  return new DynamicStructuredTool({
    name: "find_voice",
    description: `Discovery ("see") over assistant voices — returns structured JSON candidates.

Filters: query keywords, language (BCP-47), accent, gender, age, optional qualityPreference (high_quality).
Browse window defaults to ~12 (max 15). Curated defaults always included.
After the user listens via audition_voices, lock in with manage_voices add.`,

    schema: z.object({
      query: z
        .string()
        .default("")
        .describe("Keywords: name, accent, gender, vibe (e.g. warm peninsular female)"),
      language: z
        .string()
        .optional()
        .describe('BCP-47 filter (e.g. "es", "ru") — pushed to shared-voices when API key set'),
      accent: z
        .string()
        .optional()
        .describe('Regional accent slug (e.g. "peninsular", "moscow")'),
      gender: z.string().optional().describe('e.g. "female", "male"'),
      age: z.string().optional().describe('e.g. "young", "middle aged"'),
      qualityPreference: z
        .enum(["high_quality", "any"])
        .default("any")
        .describe("Prefer high_quality catalog category when set"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_BROWSE_LIMIT)
        .default(DEFAULT_BROWSE_LIMIT)
        .describe("Max candidates (10–15 browse window)"),
    }),

    func: async ({ query, language, accent, gender, age, qualityPreference, limit }) => {
      try {
        const input: DiscoverVoicesInput = { query, qualityPreference, limit };
        if (language !== undefined) input.language = language;
        if (accent !== undefined) input.accent = accent;
        if (gender !== undefined) input.gender = gender;
        if (age !== undefined) input.age = age;
        const result = await discoverVoices(input);
        if (result.candidates.length === 0) {
          return JSON.stringify({
            ...result,
            error: `No voices matched the filters. Try broader keywords or set ELEVENLABS_API_KEY for the full catalog.`,
          });
        }
        return JSON.stringify(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({
          candidates: [],
          consideredCount: 0,
          elevenLabsConfigured: Boolean(process.env["ELEVENLABS_API_KEY"]?.trim()),
          error: `find_voice failed: ${msg}`,
        } satisfies FindVoiceToolResult);
      }
    },
  });
}
