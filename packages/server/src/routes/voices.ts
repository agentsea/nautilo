import { getServerSpeechModel, resolveFundedSpeechModel, estimateSpeechCostUsd, readBoundedMediaBytes, readBoundedMediaJson, type SpeechModel, type UsageFundingProvenance } from "@nautilo/agent";
import { ATTACHMENT_POLICY } from "@nautilo/attachments";
import { dialogueSpeechResponse } from "../realtime/dialogue-speech";
import { splitSpeechText } from "../realtime/speech-text";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { renameWithWindowsRetry } from "@nautilo/config/private-filesystem";
import { basename, dirname, join } from "node:path";
import { requestAllowsOwnerOrLoopback } from "../lib/request-trust";
import {
  createDbProviderCatalogCache,
  providerAccountFingerprint,
  type ProviderCatalogCache,
} from "../lib/provider-catalog-cache";
import {
  ELEVENLABS_CURATED_VOICE_IDS,
  curatedVoiceDisplayNameForId,
  normalizeElevenLabsLabels,
  voicePreviewPathForCustomText,
  type VoiceCatalogEntry,
} from "@nautilo/voice";
import { isCloudManagedDeployment } from "@nautilo/config-guard";
import {
  beginServerProviderCostAttempt,
  settleServerProviderCostAttempt,
  type ServerProviderCostAttemptAdmission,
  type ServerProviderCostReceipt,
} from "../costs/provider-cost-recorder";
import {
  assertCanUseServerProviderCredentials,
  getUserCapabilities,
  ServerProviderCredentialsDeniedError,
  toActionCapabilityHttpDenial,
} from "@nautilo/trust";
import {
  directVoiceServiceFunding,
  type VoiceServiceFunding,
} from "../realtime/voice-service-funding";
import { createCapabilityFundingSession } from "../lib/capability-funding";
import { ModelFundingError, type ModelFundingErrorCode } from "../lib/model-funding";

/** Featured customization floor — six voices spanning EN / ES / FR / DE / JA. */
const FEATURED_CUSTOMIZATION_VOICE_IDS: Record<string, string> = {
  amy: "OZxMHsGaBmV5pjMIDIn0",
  jessica: ELEVENLABS_CURATED_VOICE_IDS["jessica"]!,
  beatriz: ELEVENLABS_CURATED_VOICE_IDS["beatriz"]!,
  augustin: ELEVENLABS_CURATED_VOICE_IDS["augustin"]!,
  daniel: ELEVENLABS_CURATED_VOICE_IDS["daniel"]!,
  kana: ELEVENLABS_CURATED_VOICE_IDS["kana"]!,
};

const CURATED_VOICE_META: Record<
  string,
  { language: "en" | "es" | "fr" | "de" | "ja"; label: string; description: string; previewUrl?: string }
> = {
  amy: { language: "en", label: "Amy", description: "Natural and Sweet" },
  jessica: { language: "en", label: "Jessica", description: "Playful & Bright" },
  beatriz: { language: "es", label: "Beatriz", description: "Cálida & Guía" },
  augustin: {
    language: "fr",
    label: "Augustin",
    description: "Conversationnel & Naturel",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/database/workspace/f453e6ece3844b538d2987595f62f0ce/voices/kKgyAHjGAbeWHCNd7qoC/JKUrofGQfxVO8svGxbtc.mp3",
  },
  daniel: {
    language: "de",
    label: "Daniel",
    description: "Calm & Real",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/database/workspace/2713c612d38b43508f102281808cb9a6/voices/wcqN36SUOZ0EhToc2OIu/5uJKmSbvCXz0O7tzCSfN.mp3",
  },
  kana: {
    language: "ja",
    label: "Kana",
    description: "Calm & Clear",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/database/workspace/395253eab87b40a191f2c1e16e78b4b3/voices/dhGvgIx0X6G3xzSWqOye/58f90a22-1816-44a0-a3a8-a0bdccda5ba0.mp3",
  },
};
const CURATED_VOICE_ID_SET = new Set(Object.values(FEATURED_CUSTOMIZATION_VOICE_IDS));

function voiceProviderUnavailableMessage(): string {
  return isCloudManagedDeployment()
    ? "Managed voice service is unavailable"
    : "Voice provider credentials are not available";
}

type VoiceFundingFailureProjection = Readonly<{
  status: number;
  body: {
    error: string;
    errorCode: ModelFundingErrorCode;
    repairAction: string;
    href: string;
  };
}>;

async function voiceFundingFailureProjection(
  error: ModelFundingError,
  humanUserId: string,
  getCapabilities: typeof getUserCapabilities,
): Promise<VoiceFundingFailureProjection> {
  switch (error.code) {
    case "personal_credentials_disabled":
      return {
        status: 403,
        body: {
          error: "Personal voice funding is disabled.",
          errorCode: error.code,
          repairAction: "contact_operator",
          href: "/settings#personal-provider-keys",
        },
      };
    case "personal_credentials_forbidden":
    case "server_credentials_forbidden":
      return {
        status: 403,
        body: {
          error: "Voice funding is not permitted for this account.",
          errorCode: error.code,
          repairAction: "contact_operator",
          href: "/settings#personal-provider-keys",
        },
      };
    case "personal_credential_missing":
      return {
        status: 409,
        body: {
          error: "Voice provider credentials are not configured.",
          errorCode: error.code,
          repairAction: "configure_provider_credentials",
          href: "/settings#personal-provider-keys",
        },
      };
    case "provider_credentials_missing": {
      let providerAdmin = false;
      try {
        const capabilities = await getCapabilities(humanUserId);
        providerAdmin = capabilities.includes("manage_connection_providers")
          || capabilities.includes("manage_server_settings");
      } catch {
        // Repair destinations are authority-bearing UI affordances. If the
        // fresh capability read fails, do not advertise the admin surface.
      }
      return {
        status: 409,
        body: {
          error: "Voice provider credentials are not configured.",
          errorCode: error.code,
          repairAction: providerAdmin
            ? "configure_server_provider_credentials"
            : "contact_operator",
          href: providerAdmin
            ? "/admin#provider-credentials"
            : "/settings#personal-provider-keys",
        },
      };
    }
    case "personal_credential_stale":
      return {
        status: 409,
        body: {
          error: "The saved voice provider credential changed.",
          errorCode: error.code,
          repairAction: "replace_provider_credential",
          href: "/settings#personal-provider-keys",
        },
      };
    case "personal_credential_unavailable":
      return {
        status: 503,
        body: {
          error: "The saved voice provider credential is unavailable.",
          errorCode: error.code,
          repairAction: "repair_provider_credential",
          href: "/settings#personal-provider-keys",
        },
      };
    case "funding_source_changed":
      return {
        status: 409,
        body: {
          error: "Voice funding changed before the request completed.",
          errorCode: error.code,
          repairAction: "retry_voice_operation",
          href: "/settings#personal-provider-keys",
        },
      };
    case "unsupported_provider":
    case "unsupported_workload":
      return {
        status: 422,
        body: {
          error: "The selected speech model cannot use voice funding.",
          errorCode: error.code,
          repairAction: "choose_supported_speech_model",
          href: "/settings#capability-models",
        },
      };
  }
}

function isMissingVoiceCredential(error: unknown): boolean {
  return error instanceof ModelFundingError &&
    (error.code === "personal_credential_missing" || error.code === "provider_credentials_missing");
}

async function isRegularPreviewFile(path: string): Promise<boolean> {
  if (!GENERATED_PREVIEW_BASENAME.test(basename(path))) return false;
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function writePreviewAtomically(path: string, bytes: Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await renameWithWindowsRetry(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  CatalogLanguageGroup,
  CatalogQuery,
  CatalogResponse,
  CatalogVerifiedLanguage,
  CatalogVoice,
  VoiceCustomizationHydrationResponse,
} from "@nautilo/types";

const CATALOG_TTL_MS = 15 * 60 * 1000;
const SHARED_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const SHARED_CATALOG_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const ELEVENLABS_MODELS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CATALOG_PAGE_SIZE = 30;
const MAX_CATALOG_PAGE_SIZE = 100;
const LANGUAGE_COUNT_CONCURRENCY = 8;
const COMPATIBLE_CATALOG_SCAN_PAGE_SIZE = MAX_CATALOG_PAGE_SIZE;
const COMPATIBLE_CATALOG_MAX_UPSTREAM_PAGES_PER_REQUEST = 25;
const VOICE_CATALOG_CACHE_PROVIDER = "elevenlabs";
// metadata compatibility semantics changed. `verified_languages` is now
// a badge signal, not an exclusion filter, so older cache rows contain
// under-populated result sets (e.g. Spanish female = only 3 v3-verified voices).
const VOICE_CATALOG_CACHE_SCHEMA_VERSION = "voice-reference-languages-v5";
const PREVIEW_RATE_WINDOW_MS = 60_000;
const PREVIEW_RATE_MAX = 20;
const MAX_PREVIEW_TEXT_CHARACTERS = 500;
const GENERATED_PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GENERATED_PREVIEW_MAX_FILES = 1_000;
const GENERATED_PREVIEW_BASENAME = /^[A-Za-z0-9]{4,64}_t_[0-9a-f]{24}\.mp3$/;

/**
 * Versioned audition line for preview cache invalidation.
 *
 * Audition script bumped 2026-04-25: the previous line led
 * with a baked-in assistant name which presumes a specific identity — but the user
 * picks their Genie's name during onboarding. The new line is name-neutral so the preview works for
 * every voice across every user without baking in someone else's
 * name choice.
 *
 * Cache invalidation: `VOICE_PREVIEW_SCRIPT_VERSION` in
 * `@nautilo/voice/preview-path` was bumped `v1` → `v2` in the same
 * commit, so any previously-cached MP3s become unreachable by the
 * filename convention and the new line gets synthesized fresh on
 * next preview.
 */
const AUDITION_SCRIPT_V2 =
  "Hey — nice to meet you. [laughs] Okay, that sounded dramatic. But seriously, glad you're here.";

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1.0,
};

export type { VoiceCatalogEntry };

type CatalogCache = { entries: VoiceCatalogEntry[]; expiresAt: number; cachedAt: number };

const catalogCache = new Map<string, CatalogCache>();

type CompatibleCatalogCacheEntry = {
  voices: CatalogVoice[];
  nextUpstreamPage: number;
  upstreamHasMore: boolean;
  totalCount: number;
  cachedAt: number;
  expiresAt: number;
};
type LanguageGroupCacheEntry = { groups: CatalogLanguageGroup[]; expiresAt: number };
type ElevenLabsModelLanguageCache = { languages: Set<string>; expiresAt: number };
type CompatibleCatalogPersistentPayload = CompatibleCatalogCacheEntry & {
  kind: "compatible";
};
type LanguageGroupPersistentPayload = {
  kind: "language-groups";
  groups: CatalogLanguageGroup[];
  cachedAt: number;
  expiresAt: number;
};
export type VoiceCatalogPersistentPayload =
  | CompatibleCatalogPersistentPayload
  | LanguageGroupPersistentPayload;
export type VoiceCatalogPersistentCache = ProviderCatalogCache<VoiceCatalogPersistentPayload>;
export interface VoiceRouteDeps {
  catalogCache?: VoiceCatalogPersistentCache | null | undefined;
  assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
  funding?: VoiceServiceFunding;
  beginCost?: (receipt: ServerProviderCostAttemptAdmission) => Promise<void>;
  settleCost?: (receipt: ServerProviderCostReceipt) => Promise<void>;
  resolveSpeechModel?: (humanUserId: string, configuredId?: string) => Promise<SpeechModel>;
  getCapabilities?: typeof getUserCapabilities;
}
const compatibleCatalogCache = new Map<string, CompatibleCatalogCacheEntry>();
const languageGroupCache = new Map<string, LanguageGroupCacheEntry>();
const compatibleCatalogInflight = new Map<string, Promise<CompatibleCatalogCacheEntry>>();
const languageGroupInflight = new Map<string, Promise<CatalogLanguageGroup[]>>();
const compatibleCatalogRefreshInflight = new Map<string, Promise<void>>();
const languageGroupRefreshInflight = new Map<string, Promise<void>>();
const providerLanguageCache = new Map<string, ElevenLabsModelLanguageCache>();
const providerLanguageInflight = new Map<string, Promise<Set<string>>>();
const previewTimestamps = new Map<string, number[]>();
const activePreviewPaths = new Map<string, number>();
const previewDeletionInflight = new Map<string, Promise<boolean>>();

function retainPreviewPath(path: string): () => void {
  activePreviewPaths.set(path, (activePreviewPaths.get(path) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activePreviewPaths.get(path) ?? 1) - 1;
    if (remaining <= 0) activePreviewPaths.delete(path);
    else activePreviewPaths.set(path, remaining);
  };
}

function sendPreviewStream(
  reply: FastifyReply,
  path: string,
): FastifyReply {
  const release = retainPreviewPath(path);
  const stream = createReadStream(path);
  stream.once("close", release);
  stream.once("error", release);
  return reply.send(stream);
}

type GeneratedPreviewCandidate = Readonly<{
  path: string;
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
}>;

async function unlinkUnchangedGeneratedPreview(candidate: GeneratedPreviewCandidate): Promise<boolean> {
  if (activePreviewPaths.has(candidate.path)) return false;
  try {
    const current = await lstat(candidate.path);
    if (
      !current.isFile() || current.isSymbolicLink() ||
      current.dev !== candidate.dev || current.ino !== candidate.ino ||
      current.size !== candidate.size || current.mtimeMs !== candidate.mtimeMs ||
      activePreviewPaths.has(candidate.path)
    ) return false;
    const deletion = unlink(candidate.path).then(() => true, () => false);
    previewDeletionInflight.set(candidate.path, deletion);
    try {
      return await deletion;
    } finally {
      if (previewDeletionInflight.get(candidate.path) === deletion) {
        previewDeletionInflight.delete(candidate.path);
      }
    }
  } catch {
    return false;
  }
}

/** Bounded cleanup for files created by the custom voice-preview cache only. */
export async function cleanupGeneratedVoicePreviewCache(
  directory: string,
  now = Date.now(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates: GeneratedPreviewCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !GENERATED_PREVIEW_BASENAME.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      candidates.push({ path, mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino });
    } catch {
      // A concurrent writer or cleanup may have moved the entry already.
    }
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const removed = new Set<string>();
  for (const candidate of candidates) {
    if (now - candidate.mtimeMs <= GENERATED_PREVIEW_MAX_AGE_MS) continue;
    if (await unlinkUnchangedGeneratedPreview(candidate)) removed.add(candidate.path);
  }

  let remaining = candidates.length - removed.size;
  for (const candidate of candidates) {
    if (remaining <= GENERATED_PREVIEW_MAX_FILES) break;
    if (removed.has(candidate.path)) continue;
    if (await unlinkUnchangedGeneratedPreview(candidate)) {
      removed.add(candidate.path);
      remaining -= 1;
    }
  }
}

type VoiceProviderAccount = Readonly<{
  fingerprint: string;
  signal?: AbortSignal;
  run<T>(callback: (attempt: { apiKey: string; usageFunding: UsageFundingProvenance }) => Promise<T>): Promise<T>;
}>;

function requestAbortSignal(
  request: { raw: { once(event: "aborted", listener: () => void): unknown } },
  reply: { raw: { once(event: "close", listener: () => void): unknown } },
): AbortSignal {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  request.raw.once("aborted", cancel);
  reply.raw.once("close", cancel);
  return abort.signal;
}

/**
 * Generation guard for test resets. Incremented every time the shared catalog
 * cache is cleared. Background refresh/fill promises capture the generation
 * active when they resolve; if a clear happened in the meantime, they skip
 * their cache writes so a stale refresh cannot repopulate a cleared cache.
 *
 * In production this is always 0 (clear is never called), so behavior is
 * unchanged. The guard is a second layer of defense on top of the draining
 * loop in {@link clearSharedCatalogCacheForTests}.
 */
let catalogCacheGeneration = 0;

function pruneExpiredVoiceState(now = Date.now()): void {
  for (const [key, entry] of catalogCache) {
    if (entry.expiresAt <= now) catalogCache.delete(key);
  }
  for (const [key, entry] of compatibleCatalogCache) {
    if (entry.expiresAt <= now) compatibleCatalogCache.delete(key);
  }
  for (const [key, entry] of languageGroupCache) {
    if (entry.expiresAt <= now) languageGroupCache.delete(key);
  }
  for (const [key, entry] of providerLanguageCache) {
    if (entry.expiresAt <= now) providerLanguageCache.delete(key);
  }

  const previewCutoff = now - PREVIEW_RATE_WINDOW_MS;
  for (const [key, timestamps] of previewTimestamps) {
    while (timestamps.length > 0 && timestamps[0]! < previewCutoff) timestamps.shift();
    if (timestamps.length === 0) previewTimestamps.delete(key);
  }
}

function prunePreviewTimestamps(accountKey: string): number[] {
  const now = Date.now();
  pruneExpiredVoiceState(now);
  return previewTimestamps.get(accountKey) ?? [];
}

function allowPreview(accountKey: string): boolean {
  const timestamps = prunePreviewTimestamps(accountKey);
  if (timestamps.length >= PREVIEW_RATE_MAX) return false;
  timestamps.push(Date.now());
  previewTimestamps.set(accountKey, timestamps);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompatiblePayload(value: unknown): value is CompatibleCatalogPersistentPayload {
  return (
    isRecord(value) &&
    value["kind"] === "compatible" &&
    Array.isArray(value["voices"]) &&
    typeof value["nextUpstreamPage"] === "number" &&
    typeof value["upstreamHasMore"] === "boolean" &&
    typeof value["totalCount"] === "number" &&
    typeof value["cachedAt"] === "number" &&
    typeof value["expiresAt"] === "number"
  );
}

function isLanguageGroupPayload(value: unknown): value is LanguageGroupPersistentPayload {
  return (
    isRecord(value) &&
    value["kind"] === "language-groups" &&
    Array.isArray(value["groups"]) &&
    typeof value["cachedAt"] === "number" &&
    typeof value["expiresAt"] === "number"
  );
}

const dbVoiceCatalogCache = createDbProviderCatalogCache<VoiceCatalogPersistentPayload>({
  provider: VOICE_CATALOG_CACHE_PROVIDER,
  validatePayload: (kind, payload): payload is VoiceCatalogPersistentPayload =>
    kind === "compatible" ? isCompatiblePayload(payload) : isLanguageGroupPayload(payload),
});

async function getPersistentCache(
  cache: VoiceCatalogPersistentCache | null | undefined,
  args: Parameters<VoiceCatalogPersistentCache["get"]>[0],
): ReturnType<VoiceCatalogPersistentCache["get"]> {
  if (!cache) return null;
  try {
    return await cache.get(args);
  } catch {
    return null;
  }
}

async function setPersistentCache(
  cache: VoiceCatalogPersistentCache | null | undefined,
  args: Parameters<VoiceCatalogPersistentCache["set"]>[0],
): Promise<void> {
  if (!cache) return;
  try {
    await cache.set(args);
  } catch {
    // Cache persistence is an optimization; provider-backed responses
    // should not fail just because the cache write failed.
  }
}

export function isValidElevenLabsVoiceId(id: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(id) && id.length >= 4 && id.length <= 64;
}

/** Raw ElevenLabs shared-voice shape (subset used for normalization). */
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
  high_quality_base_model_ids?: string[] | null;
};

type ElevenLabsModelRaw = {
  model_id?: string;
  can_do_text_to_speech?: boolean;
  languages?: Array<{
    language_id?: string;
    name?: string;
  }> | null;
};

const LANGUAGE_LABELS: Record<string, string> = {
  af: "Afrikaans",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  hi: "Hindi",
  ar: "Arabic",
  bg: "Bulgarian",
  hr: "Croatian",
  ru: "Russian",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  tr: "Turkish",
  id: "Indonesian",
  fil: "Filipino",
  ms: "Malay",
  ro: "Romanian",
  uk: "Ukrainian",
  sk: "Slovak",
  cs: "Czech",
  el: "Greek",
  fi: "Finnish",
  da: "Danish",
  no: "Norwegian",
  hu: "Hungarian",
  ta: "Tamil",
  vi: "Vietnamese",
};

const UNKNOWN_LANGUAGE_LABEL = "Unknown language";

/** Whether a shared voice itself advertises expressive emotion support. */
export function isEmotionCompatibleVoice(voice: ElevenLabsSharedVoiceRaw): boolean {
  //  field report: ElevenLabs shared-catalog metadata is not a reliable
  // hard gate for `eleven_v3` compatibility. Beatriz (gJlzF5JxsCvM5hQAoRyD)
  // does not list `eleven_v3` in `verified_languages`, but direct synthesis
  // with model_id=eleven_v3 succeeds and `[laughs]` is interpreted. Treat
  // verified_languages as a UI signal, not as an exclusion filter.
  return Boolean(voice.voice_id && voice.name);
}

export function catalogLanguageLabel(language: string | null | undefined): string {
  const code = (language ?? "").trim().toLowerCase();
  if (!code) return UNKNOWN_LANGUAGE_LABEL;
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
  return normalizeVerifiedLanguages(raw)[0] ?? null;
}

/** Map a raw ElevenLabs shared voice into the stable catalog shape. */
function normalizeSharedVoice(voice: ElevenLabsSharedVoiceRaw): CatalogVoice {
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

function normalizeLanguageCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toLowerCase();
  if (!code) return null;
  return code.split("-")[0] ?? code;
}

type LanguageGroupKey = { language: string; locale: string | null };

function languageGroupKey(voice: CatalogVoice): LanguageGroupKey {
  return { language: voice.language, locale: null };
}

function languageGroupSortRank(group: CatalogLanguageGroup): number {
  const lang = group.language.toLowerCase();
  if (lang === "en") return 0;
  if (lang === "es") return 1;
  return 2;
}

function regionLabel(locale: string | null): string | null {
  if (!locale) return null;
  const parts = locale.split("-");
  const region = parts[parts.length - 1]?.trim().toUpperCase();
  if (!region || region.length === 0) return null;
  return region;
}

/** Build deterministic language groups from catalog voices (en, es, then alpha). */
export function buildLanguageGroups(voices: CatalogVoice[]): CatalogLanguageGroup[] {
  const counts = new Map<string, { key: LanguageGroupKey; count: number }>();
  for (const voice of voices) {
    const key = languageGroupKey(voice);
    const mapKey = `${key.language}\0${key.locale ?? ""}`;
    const existing = counts.get(mapKey);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(mapKey, { key, count: 1 });
    }
  }

  const groups: CatalogLanguageGroup[] = [...counts.values()].map(({ key, count }) => ({
    language: key.language,
    locale: key.locale,
    label:
      regionLabel(key.locale) ?
        `${catalogLanguageLabel(key.language)} (${regionLabel(key.locale)})`
      : catalogLanguageLabel(key.language),
    count,
  }));

  groups.sort((a, b) => {
    const rankDiff = languageGroupSortRank(a) - languageGroupSortRank(b);
    if (rankDiff !== 0) return rankDiff;
    const labelDiff = a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    if (labelDiff !== 0) return labelDiff;
    const localeA = a.locale ?? "";
    const localeB = b.locale ?? "";
    return localeA.localeCompare(localeB, undefined, { sensitivity: "base" });
  });

  return groups;
}

function normalizeCatalogPage(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function normalizeCatalogPageSize(raw: unknown): number {
  const n =
    typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CATALOG_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_CATALOG_PAGE_SIZE);
}

function pickCatalogQueryString(
  query: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const language = query["language"];
  if (typeof language === "string" && language.trim()) out["language"] = language.trim();
  const category = query["category"];
  if (typeof category === "string" && category.trim()) out["category"] = category.trim();
  const gender = query["gender"];
  if (typeof gender === "string" && gender.trim()) out["gender"] = gender.trim();
  const age = query["age"];
  if (typeof age === "string" && age.trim()) out["age"] = age.trim();
  const accent = query["accent"];
  if (typeof accent === "string" && accent.trim()) out["accent"] = accent.trim();
  const useCases = query["use_cases"];
  if (typeof useCases === "string" && useCases.trim()) out["use_cases"] = useCases.trim();
  const search = query["search"];
  if (typeof search === "string" && search.trim()) out["search"] = search.trim();
  out["page"] = String(normalizeCatalogPage(query["page"]));
  out["page_size"] = String(normalizeCatalogPageSize(query["page_size"]));
  return out;
}

/** Stable cache key from normalized catalog query params. */
export function catalogCacheKey(params: Record<string, string>): string {
  return [...Object.entries(params)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
}

/** L1 memory key — scopes in-process cache to provider account + filter key. */
function memoryCacheKey(fingerprint: string, filterKey: string): string {
  return `${fingerprint}:${filterKey}`;
}

function catalogCountParams(params: Record<string, string>): Record<string, string> {
  const out = { ...params };
  delete out["page"];
  delete out["page_size"];
  delete out["language"];
  return out;
}

function catalogFilterParams(params: Record<string, string>): Record<string, string> {
  const out = { ...params };
  delete out["page"];
  delete out["page_size"];
  return out;
}

async function fetchSharedVoicesPage(
  account: VoiceProviderAccount,
  params: Record<string, string>,
): Promise<{
  voices: ElevenLabsSharedVoiceRaw[];
  hasMore: boolean;
  totalCount: number;
}> {
  const url = new URL("https://api.elevenlabs.io/v1/shared-voices");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await account.run(({ apiKey }) => fetch(url.toString(), {
    headers: { "xi-api-key": apiKey },
    ...(account.signal ? { signal: account.signal } : {}),
  }));
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`ElevenLabs shared-voices request failed (HTTP ${res.status})`);
  }
  const data = await readBoundedMediaJson(res);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid shared voice metadata");
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record["voices"])) throw new Error("Invalid shared voice metadata");
  const voices = record["voices"];
  if (!voices.every((voice): voice is ElevenLabsSharedVoiceRaw => (
    Boolean(voice)
    && typeof voice === "object"
    && !Array.isArray(voice)
    && typeof (voice as Record<string, unknown>)["voice_id"] === "string"
    && typeof (voice as Record<string, unknown>)["name"] === "string"
  ))) throw new Error("Invalid shared voice metadata");
  const hasMore = record["has_more"];
  const totalCount = record["total_count"];
  if (hasMore !== undefined && typeof hasMore !== "boolean") throw new Error("Invalid shared voice metadata");
  if (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0)) throw new Error("Invalid shared voice metadata");
  return {
    voices,
    hasMore: hasMore ?? false,
    totalCount: typeof totalCount === "number" ? totalCount : 0,
  };
}

async function fetchProviderLanguages(
  account: VoiceProviderAccount,
): Promise<Set<string>> {
  const fingerprint = account.fingerprint;
  const now = Date.now();
  const cached = providerLanguageCache.get(fingerprint);
  if (cached && cached.expiresAt > now) {
    return cached.languages;
  }
  const inflight = providerLanguageInflight.get(fingerprint);
  if (inflight) return inflight;

  const promise = (async () => {
    const res = await account.run(({ apiKey }) => fetch("https://api.elevenlabs.io/v1/models", {
      headers: { "xi-api-key": apiKey },
      ...(account.signal ? { signal: account.signal } : {}),
    }));
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`ElevenLabs models ${res.status}`);
    }
    const models = await readBoundedMediaJson(res);
    if (!Array.isArray(models) || !models.every((model): model is ElevenLabsModelRaw => (
      Boolean(model) && typeof model === "object" && !Array.isArray(model)
    ))) throw new Error("Invalid ElevenLabs models metadata");
    // These are discovery categories, not a selected-model capability claim.
    // Provider reference samples can use other models; generated auditions use
    // the exact server model and expose unsupported combinations truthfully.
    const languages = new Set(
      models.filter(model => model.can_do_text_to_speech !== false).flatMap(model => model.languages ?? [])
        .map((language) => normalizeLanguageCode(language.language_id))
        .filter((language): language is string => language !== null),
    );
    if (languages.size === 0) {
      throw new Error("ElevenLabs models response did not include reference languages");
    }
    providerLanguageCache.set(fingerprint, { languages, expiresAt: Date.now() + ELEVENLABS_MODELS_TTL_MS });
    return languages;
  })();
  providerLanguageInflight.set(fingerprint, promise);
  try {
    return await promise;
  } finally {
    if (providerLanguageInflight.get(fingerprint) === promise) providerLanguageInflight.delete(fingerprint);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < values.length; i += concurrency) {
    results.push(...await Promise.all(values.slice(i, i + concurrency).map(fn)));
  }
  return results;
}

async function fetchLanguageGroupsWithCounts(
  account: VoiceProviderAccount,
  params: Record<string, string>,
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
): Promise<CatalogLanguageGroup[]> {
  const countParams = catalogCountParams(params);
  const cacheKey = catalogCacheKey(countParams);
  const fingerprint = account.fingerprint;
  const memoryKey = memoryCacheKey(fingerprint, cacheKey);
  const now = Date.now();
  const cached = languageGroupCache.get(memoryKey);
  if (cached && cached.expiresAt > now) return cached.groups;
  const stored = await getPersistentCache(persistentCache, {
    kind: "language-groups",
    cacheKey,
    accountFingerprint: fingerprint,
    schemaVersion: VOICE_CATALOG_CACHE_SCHEMA_VERSION,
    now,
  });
  if (stored?.payload.kind === "language-groups") {
    const entry = { groups: stored.payload.groups, expiresAt: stored.payload.expiresAt };
    if (stored.state === "fresh") languageGroupCache.set(memoryKey, entry);
    if (stored.state === "stale") {
      refreshLanguageGroupsCache(account, countParams, cacheKey, persistentCache);
    }
    return entry.groups;
  }
  const inflight = languageGroupInflight.get(memoryKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const providerLanguages = await fetchProviderLanguages(account);
    const languages = [...providerLanguages].sort((a, b) => {
      const rankDiff =
        languageGroupSortRank({ language: a, locale: null, label: "", count: 0 }) -
        languageGroupSortRank({ language: b, locale: null, label: "", count: 0 });
      if (rankDiff !== 0) return rankDiff;
      return catalogLanguageLabel(a).localeCompare(catalogLanguageLabel(b), undefined, {
        sensitivity: "base",
      });
    });

    const groups: CatalogLanguageGroup[] = (
      await mapWithConcurrency(languages, LANGUAGE_COUNT_CONCURRENCY, async (language) => {
        const response = await fetchSharedVoicesPage(account, {
          ...countParams,
          language,
          page: "0",
          page_size: "1",
        });
        return response.totalCount > 0 ?
            {
              language,
              locale: null as string | null,
              label: catalogLanguageLabel(language),
              count: response.totalCount,
            }
          : null;
      })
    ).filter((group): group is CatalogLanguageGroup => group !== null);

    const cachedAt = Date.now();
    languageGroupCache.set(memoryKey, { groups, expiresAt: cachedAt + SHARED_CATALOG_TTL_MS });
    await persistLanguageGroups(persistentCache, cacheKey, fingerprint, {
      kind: "language-groups",
      groups,
      cachedAt,
      expiresAt: cachedAt + SHARED_CATALOG_TTL_MS,
    });
    return groups;
  })();
  languageGroupInflight.set(memoryKey, promise);
  try {
    return await promise;
  } finally {
    if (languageGroupInflight.get(memoryKey) === promise) languageGroupInflight.delete(memoryKey);
  }
}

async function persistLanguageGroups(
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
  cacheKey: string,
  fingerprint: string,
  payload: LanguageGroupPersistentPayload,
): Promise<void> {
  await setPersistentCache(persistentCache, {
    kind: "language-groups",
    cacheKey,
    accountFingerprint: fingerprint,
    schemaVersion: VOICE_CATALOG_CACHE_SCHEMA_VERSION,
    payload,
    now: payload.cachedAt,
    ttlMs: SHARED_CATALOG_TTL_MS,
    staleMs: SHARED_CATALOG_STALE_MS,
  });
}

function refreshLanguageGroupsCache(
  account: VoiceProviderAccount,
  countParams: Record<string, string>,
  cacheKey: string,
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
): void {
  const memoryKey = memoryCacheKey(account.fingerprint, cacheKey);
  if (languageGroupRefreshInflight.has(memoryKey)) return;
  const startedGeneration = catalogCacheGeneration;
  const promise = (async () => {
    const providerLanguages = await fetchProviderLanguages(account);
    const languages = [...providerLanguages].sort((a, b) => {
      const rankDiff =
        languageGroupSortRank({ language: a, locale: null, label: "", count: 0 }) -
        languageGroupSortRank({ language: b, locale: null, label: "", count: 0 });
      if (rankDiff !== 0) return rankDiff;
      return catalogLanguageLabel(a).localeCompare(catalogLanguageLabel(b), undefined, {
        sensitivity: "base",
      });
    });
    const groups: CatalogLanguageGroup[] = (
      await mapWithConcurrency(languages, LANGUAGE_COUNT_CONCURRENCY, async (language) => {
        const response = await fetchSharedVoicesPage(account, {
          ...countParams,
          language,
          page: "0",
          page_size: "1",
        });
        return response.totalCount > 0 ?
            {
              language,
              locale: null as string | null,
              label: catalogLanguageLabel(language),
              count: response.totalCount,
            }
          : null;
      })
    ).filter((group): group is CatalogLanguageGroup => group !== null);
    const cachedAt = Date.now();
    if (catalogCacheGeneration !== startedGeneration) return;
    languageGroupCache.set(memoryKey, { groups, expiresAt: cachedAt + SHARED_CATALOG_TTL_MS });
    await persistLanguageGroups(persistentCache, cacheKey, account.fingerprint, {
      kind: "language-groups",
      groups,
      cachedAt,
      expiresAt: cachedAt + SHARED_CATALOG_TTL_MS,
    });
  })().finally(() => {
    languageGroupRefreshInflight.delete(memoryKey);
  });
  languageGroupRefreshInflight.set(memoryKey, promise);
}

export function filterAndNormalizeSharedCatalog(rawVoices: ElevenLabsSharedVoiceRaw[]): CatalogVoice[] {
  return rawVoices
    .filter((voice) => isEmotionCompatibleVoice(voice))
    .map(normalizeSharedVoice);
}

/**
 * @internal Test hook — clears the shared catalog in-memory cache.
 *
 * Async since the cache is populated by fire-and-forget refresh/fill promises
 * ({@link refreshCompatibleCatalogCache}, {@link refreshLanguageGroupsCache})
 * that write to the cache maps when they resolve and delete themselves from
 * the inflight maps in a `.finally`. Clearing the maps synchronously would
 * lose the references to those promises, letting a still-running refresh
 * repopulate the freshly-cleared cache and contaminate the next test.
 *
 * The fix drains the inflight maps first: it gathers every active fill and
 * refresh promise, awaits them with `Promise.allSettled` (so a rejecting
 * promise cannot abort cleanup), and repeats in a bounded loop until no new
 * inflight appeared while waiting. Only once the maps are quiescent does it
 * bump the generation guard and clear the maps. The generation guard is a
 * second layer of defense: any refresh that resolves after the drain still
 * skips its cache write because its captured generation is now stale.
 *
 * `Promise.allSettled` is used deliberately — a rejected refresh must not abort
 * the drain — but rejections are NOT swallowed in production paths: the
 * underlying promises still reject and surface through their callers; only
 * the test-cleanup await is settlement-tolerant.
 */
export async function clearSharedCatalogCacheForTests(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const active = [
      ...compatibleCatalogInflight.values(),
      ...compatibleCatalogRefreshInflight.values(),
      ...languageGroupInflight.values(),
      ...languageGroupRefreshInflight.values(),
      ...providerLanguageInflight.values(),
    ];
    if (active.length === 0) break;
    await Promise.allSettled(active);
  }
  catalogCacheGeneration += 1;
  compatibleCatalogCache.clear();
  languageGroupCache.clear();
  compatibleCatalogInflight.clear();
  languageGroupInflight.clear();
  compatibleCatalogRefreshInflight.clear();
  languageGroupRefreshInflight.clear();
  providerLanguageCache.clear();
  providerLanguageInflight.clear();
  catalogCache.clear();
  previewTimestamps.clear();
}

async function scanCompatibleCatalogEntry(
  account: VoiceProviderAccount,
  filterParams: Record<string, string>,
  entry: CompatibleCatalogCacheEntry,
  targetCompatibleCount: number,
): Promise<CompatibleCatalogCacheEntry> {
  let scanned = 0;
  while (
    entry.voices.length < targetCompatibleCount &&
    entry.upstreamHasMore &&
    scanned < COMPATIBLE_CATALOG_MAX_UPSTREAM_PAGES_PER_REQUEST
  ) {
    const upstream = await fetchSharedVoicesPage(account, {
      ...filterParams,
      page: String(entry.nextUpstreamPage),
      page_size: String(COMPATIBLE_CATALOG_SCAN_PAGE_SIZE),
    });
    entry.voices.push(...filterAndNormalizeSharedCatalog(upstream.voices));
    entry.nextUpstreamPage += 1;
    entry.upstreamHasMore = upstream.hasMore;
    entry.totalCount = upstream.totalCount;
    scanned += 1;
  }

  return entry;
}

async function fillCompatibleCatalogCache(
  account: VoiceProviderAccount,
  params: Record<string, string>,
  targetCompatibleCount: number,
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
): Promise<CompatibleCatalogCacheEntry> {
  const filterParams = catalogFilterParams(params);
  const cacheKey = catalogCacheKey(filterParams);
  const fingerprint = account.fingerprint;
  const memoryKey = memoryCacheKey(fingerprint, cacheKey);

  while (true) {
    const now = Date.now();
    const entry = compatibleCatalogCache.get(memoryKey);
    if (entry && entry.expiresAt > now) {
      if (entry.voices.length >= targetCompatibleCount || !entry.upstreamHasMore) return entry;
    }

    const inflight = compatibleCatalogInflight.get(memoryKey);
    if (inflight) {
      await inflight;
      continue;
    }

    const promise = loadOrScanCompatibleCatalogEntry(
      account,
      filterParams,
      cacheKey,
      memoryKey,
      targetCompatibleCount,
      persistentCache,
    );
    compatibleCatalogInflight.set(memoryKey, promise);
    try {
      return await promise;
    } finally {
      if (compatibleCatalogInflight.get(memoryKey) === promise) compatibleCatalogInflight.delete(memoryKey);
    }
  }
}

async function loadOrScanCompatibleCatalogEntry(
  account: VoiceProviderAccount,
  filterParams: Record<string, string>,
  cacheKey: string,
  memoryKey: string,
  targetCompatibleCount: number,
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
): Promise<CompatibleCatalogCacheEntry> {
  const now = Date.now();
  const fingerprint = account.fingerprint;
  const memoryEntry = compatibleCatalogCache.get(memoryKey);
  if (memoryEntry && memoryEntry.expiresAt > now) {
    if (memoryEntry.voices.length >= targetCompatibleCount || !memoryEntry.upstreamHasMore) {
      return memoryEntry;
    }
    const filled = await scanCompatibleCatalogEntry(
      account,
      filterParams,
      memoryEntry,
      targetCompatibleCount,
    );
    await persistCompatibleCatalogEntry(persistentCache, cacheKey, fingerprint, filled);
    return filled;
  }

  const stored = await getPersistentCache(persistentCache, {
    kind: "compatible",
    cacheKey,
    accountFingerprint: fingerprint,
    schemaVersion: VOICE_CATALOG_CACHE_SCHEMA_VERSION,
    now,
  });
  if (stored?.payload.kind === "compatible") {
    const storedEntry: CompatibleCatalogCacheEntry = {
      voices: stored.payload.voices,
      nextUpstreamPage: stored.payload.nextUpstreamPage,
      upstreamHasMore: stored.payload.upstreamHasMore,
      totalCount: stored.payload.totalCount,
      cachedAt: stored.payload.cachedAt,
      expiresAt: stored.payload.expiresAt,
    };
    if (stored.state === "fresh") compatibleCatalogCache.set(memoryKey, storedEntry);
    const usable = storedEntry.voices.length >= targetCompatibleCount || !storedEntry.upstreamHasMore;
    if (stored.state === "stale" && usable) {
      refreshCompatibleCatalogCache(account, filterParams, cacheKey, memoryKey, targetCompatibleCount, persistentCache);
      return storedEntry;
    }
    if (stored.state === "fresh" && usable) return storedEntry;
  }

  const entry: CompatibleCatalogCacheEntry = {
    voices: [],
    nextUpstreamPage: 0,
    upstreamHasMore: true,
    totalCount: 0,
    cachedAt: now,
    expiresAt: now + SHARED_CATALOG_TTL_MS,
  };
  compatibleCatalogCache.set(memoryKey, entry);
  const filled = await scanCompatibleCatalogEntry(account, filterParams, entry, targetCompatibleCount);
  await persistCompatibleCatalogEntry(persistentCache, cacheKey, fingerprint, filled);
  return filled;
}

async function persistCompatibleCatalogEntry(
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
  cacheKey: string,
  fingerprint: string,
  entry: CompatibleCatalogCacheEntry,
): Promise<void> {
  await setPersistentCache(persistentCache, {
    kind: "compatible",
    cacheKey,
    accountFingerprint: fingerprint,
    schemaVersion: VOICE_CATALOG_CACHE_SCHEMA_VERSION,
    payload: { kind: "compatible", ...entry },
    now: entry.cachedAt,
    ttlMs: SHARED_CATALOG_TTL_MS,
    staleMs: SHARED_CATALOG_STALE_MS,
  });
}

function refreshCompatibleCatalogCache(
  account: VoiceProviderAccount,
  filterParams: Record<string, string>,
  cacheKey: string,
  memoryKey: string,
  targetCompatibleCount: number,
  persistentCache: VoiceCatalogPersistentCache | null | undefined,
): void {
  if (compatibleCatalogRefreshInflight.has(memoryKey)) return;
  const startedGeneration = catalogCacheGeneration;
  const now = Date.now();
  const entry: CompatibleCatalogCacheEntry = {
    voices: [],
    nextUpstreamPage: 0,
    upstreamHasMore: true,
    totalCount: 0,
    cachedAt: now,
    expiresAt: now + SHARED_CATALOG_TTL_MS,
  };
  const promise = scanCompatibleCatalogEntry(account, filterParams, entry, targetCompatibleCount)
    .then(async (filled) => {
      if (catalogCacheGeneration !== startedGeneration) return;
      compatibleCatalogCache.set(memoryKey, filled);
      await persistCompatibleCatalogEntry(persistentCache, cacheKey, account.fingerprint, filled);
    })
    .finally(() => {
      compatibleCatalogRefreshInflight.delete(memoryKey);
    });
  compatibleCatalogRefreshInflight.set(memoryKey, promise);
}

// voice preview cache lives under data/voice-previews/ (internal
// zone, never exposed to the relay). Filename conventions live in
// @nautilo/voice/preview-path so voices.ts and find-voice.ts share one
// source of truth.
const previewFilePathForCustom = voicePreviewPathForCustomText;

function curatedPayload(): VoiceCustomizationHydrationResponse["curated"] {
  return Object.entries(FEATURED_CUSTOMIZATION_VOICE_IDS).map(([slug, voiceId]) => {
    const meta = CURATED_VOICE_META[slug];
    if (!meta) {
      throw new Error(`CURATED_VOICE_META missing for slug "${slug}"`);
    }
    return {
      slug,
      label: meta.label,
      voiceId,
      language: meta.language,
      description: meta.description,
      previewUrl:
        meta.previewUrl ?? `/api/onboarding/audio/${meta.language}/voices/${slug}-sample.mp3`,
    };
  });
}

async function synthesizePreviewMp3(
  account: VoiceProviderAccount,
  voiceId: string,
  text: string,
  model: SpeechModel,
  cost: Readonly<{
    userId: string;
    begin: (receipt: ServerProviderCostAttemptAdmission) => Promise<void>;
    settle: (receipt: ServerProviderCostReceipt) => Promise<void>;
  }>,
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let totalBytes = 0;
  for (const part of splitSpeechText(text, model.speech.maxInputCharacters)) {
    let admission: ServerProviderCostAttemptAdmission | undefined;
    let attemptBegun = false;
    let submitted = false;
    let accepted = false;
    let completed = false;
    try {
      const buffer = await account.run(async ({ apiKey, usageFunding }) => {
        admission = {
          identity: `elevenlabs:voice-preview:${randomUUID()}`,
          userId: cost.userId,
          usageFunding,
          provider: "elevenlabs",
          operation: "voice_preview",
        };
        await cost.begin(admission);
        attemptBegun = true;
        account.signal?.throwIfAborted();
        const res = model.speech.transport === "elevenlabs-dialogue-http"
          ? await dialogueSpeechResponse({
              text: part,
              voiceId,
              model: model.providerModelId,
              format: "mp3_44100_128",
              apiKey,
              signal: account.signal ?? new AbortController().signal,
              onSubmitted() { submitted = true; },
            })
          : await (() => {
              submitted = true;
              return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
                method: "POST",
                headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ text: part, model_id: model.providerModelId, voice_settings: VOICE_SETTINGS }),
                ...(account.signal ? { signal: account.signal } : {}),
              });
            })();
        accepted = res.ok;
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error("Speech preview provider unavailable");
        }
        const remainingBytes = ATTACHMENT_POLICY.maxAudioBytes - totalBytes;
        if (remainingBytes < 1) throw new Error("Speech preview response too large");
        const bytes = Buffer.from(await readBoundedMediaBytes(res, remainingBytes));
        totalBytes += bytes.byteLength;
        completed = true;
        return bytes;
      });
      buffers.push(buffer);
    } finally {
      if (attemptBegun && admission) {
        await cost.settle({
          ...admission,
          estimatedCostUsd: accepted ? estimateSpeechCostUsd(part, model) : null,
          evidenceState: accepted ? "estimated" : "unknown",
          attemptOutcome: completed ? "succeeded" : account.signal?.aborted ? "cancelled" : submitted ? "failed" : "unknown",
          ...(completed ? {} : { failureCode: account.signal?.aborted ? "cancelled" : "provider_error" }),
        }).catch(() => {});
      }
    }
  }
  return Buffer.concat(buffers);
}

export function voiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps = {}): void {
  const persistentCache = deps.catalogCache === undefined ? dbVoiceCatalogCache : deps.catalogCache;
  const assertServerFunding = deps.assertCanUseServerProviderCredentials
    ?? assertCanUseServerProviderCredentials;
  const funding = deps.funding ?? directVoiceServiceFunding;
  const getCapabilities = deps.getCapabilities ?? getUserCapabilities;
  const legacyServerTestSeam = Boolean(deps.assertCanUseServerProviderCredentials && !deps.funding);
  const beginCost = deps.beginCost ?? (legacyServerTestSeam ? async () => {} : beginServerProviderCostAttempt);
  const settleCost = deps.settleCost ?? (legacyServerTestSeam ? async () => {} : settleServerProviderCostAttempt);
  const resolveSpeechModel = deps.resolveSpeechModel
    ?? (deps.assertCanUseServerProviderCredentials && !deps.funding
      ? () => Promise.resolve(getServerSpeechModel())
      : async (humanUserId: string) => {
          const selection = await createCapabilityFundingSession(humanUserId).resolveModel("speech");
          return resolveFundedSpeechModel(selection.modelId);
        });
  const resolveAccount = async (humanUserId: string, origin: string, signal?: AbortSignal): Promise<VoiceProviderAccount> => {
    pruneExpiredVoiceState();
    // Existing route unit seams model a server-only account. Production uses
    // the durable service funding owner even when the selected account is the server.
    if (deps.assertCanUseServerProviderCredentials && !deps.funding) {
      const apiKey = process.env["ELEVENLABS_API_KEY"]?.trim();
      if (!apiKey) throw new Error("provider_credentials_missing");
      return {
        fingerprint: providerAccountFingerprint(apiKey),
        ...(signal ? { signal } : {}),
        run: async callback => {
          await assertServerFunding(humanUserId, origin);
          return callback({ apiKey, usageFunding: { kind: "server", humanUserId, providerRoute: "elevenlabs" } });
        },
      };
    }
    const binding = await funding.admit(humanUserId, "elevenlabs");
    return {
      fingerprint: binding.credentialFingerprint,
      ...(signal ? { signal } : {}),
      run: callback => funding.run(binding, "spend", callback),
    };
  };
  app.get("/api/voices", async (request, reply) => {
    const curated = curatedPayload();
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const ownerOrLoopback = requestAllowsOwnerOrLoopback(request);
    if (!ownerOrLoopback && request.policyContext?.actorRole === "guest") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const signal = requestAbortSignal(request, reply);
    let account: VoiceProviderAccount | null = null;
    try { account = await resolveAccount(request.sessionUserId, "voice_catalog_hydration", signal); }
    catch (error) {
      if (error instanceof ModelFundingError && !isMissingVoiceCredential(error)) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send(projection.body);
      }
      // Missing credentials remain a steady-state hydration result.
    }

    // remote customization needs the guided curated floor and an
    // optional-voice capability, but must never enumerate provider-account
    // voices or call ElevenLabs merely to hydrate that screen.
    if (!ownerOrLoopback) {
      const response: VoiceCustomizationHydrationResponse = {
        curated,
        voices: [],
        elevenLabsConfigured: Boolean(account),
        cachedAt: null,
      };
      return reply.send(response);
    }

    if (!account) {
      const response: VoiceCustomizationHydrationResponse = {
        curated,
        voices: [],
        elevenLabsConfigured: false,
        cachedAt: null,
      };
      return reply.send(response);
    }

    const now = Date.now();
    const cachedCatalog = catalogCache.get(account.fingerprint);
    if (cachedCatalog && cachedCatalog.expiresAt > now) {
      const response: VoiceCustomizationHydrationResponse = {
        curated,
        voices: cachedCatalog.entries,
        elevenLabsConfigured: true,
        cachedAt: cachedCatalog.cachedAt,
      };
      return reply.send(response);
    }

    try {
      const entries = await account.run(async ({ apiKey }) => {
        const res = await fetch("https://api.elevenlabs.io/v1/voices", {
          headers: { "xi-api-key": apiKey },
          ...(account.signal ? { signal: account.signal } : {}),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`ElevenLabs voices request failed (HTTP ${res.status})`);
        }
        const data = await readBoundedMediaJson(res);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid voice metadata");
        const voices = (data as Record<string, unknown>)["voices"];
        if (!Array.isArray(voices)) throw new Error("Invalid voice metadata");
        return voices.map((voice): VoiceCatalogEntry => {
          if (!voice || typeof voice !== "object" || Array.isArray(voice)) throw new Error("Invalid voice metadata");
          const row = voice as Record<string, unknown>;
          if (typeof row["voice_id"] !== "string" || typeof row["name"] !== "string") throw new Error("Invalid voice metadata");
          if (row["labels"] !== undefined && (!row["labels"] || typeof row["labels"] !== "object" || Array.isArray(row["labels"]))) throw new Error("Invalid voice metadata");
          if (row["description"] !== undefined && row["description"] !== null && typeof row["description"] !== "string") throw new Error("Invalid voice metadata");
          return {
            voiceId: row["voice_id"],
            name: row["name"],
            labels: normalizeElevenLabsLabels(row["labels"] as Record<string, unknown> | undefined),
            description: row["description"] ?? null,
          };
        });
      });
      catalogCache.set(account.fingerprint, { entries, expiresAt: now + CATALOG_TTL_MS, cachedAt: now });
      const response: VoiceCustomizationHydrationResponse = {
        curated,
        voices: entries,
        elevenLabsConfigured: true,
        cachedAt: now,
      };
      return reply.send(response);
    } catch (error) {
      if (error instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(error));
      }
      if (error instanceof ModelFundingError) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send(projection.body);
      }
      return reply.code(502).send({
        curated,
        voices: [],
        elevenLabsConfigured: true,
        // Provider responses may contain account-specific diagnostics. This
        // stable message is safe for both the Desktop and browser callers.
        error: "Failed to load voices.",
        cachedAt: null,
      });
    }
  });

  app.get<{ Querystring: CatalogQuery }>("/api/voices/catalog", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (request.policyContext?.actorRole === "guest") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const signal = requestAbortSignal(request, reply);
    let account: VoiceProviderAccount;
    try { account = await resolveAccount(request.sessionUserId, "voice_catalog", signal); }
    catch (error) {
      if (error instanceof ModelFundingError) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send({
          ...projection.body,
          voices: [] as CatalogVoice[],
          languageGroups: [] as CatalogLanguageGroup[],
          page: 0,
          pageSize: DEFAULT_CATALOG_PAGE_SIZE,
          hasMore: false,
          totalCount: 0,
          elevenLabsConfigured: false,
          cachedAt: null,
        });
      }
      return reply.code(400).send({
        error: voiceProviderUnavailableMessage(),
        voices: [] as CatalogVoice[],
        languageGroups: [] as CatalogLanguageGroup[],
        page: 0,
        pageSize: DEFAULT_CATALOG_PAGE_SIZE,
        hasMore: false,
        totalCount: 0,
        elevenLabsConfigured: false,
        cachedAt: null,
      });
    }

    const queryRecord = request.query as Record<string, unknown>;
    const upstreamParams = pickCatalogQueryString(queryRecord);
    const now = Date.now();
    try {
      const page = normalizeCatalogPage(upstreamParams["page"]);
      const pageSize = normalizeCatalogPageSize(upstreamParams["page_size"]);
      const neededCompatibleCount = (page + 1) * pageSize;
      const compatibleCache = await fillCompatibleCatalogCache(
        account,
        upstreamParams,
        neededCompatibleCount,
        persistentCache,
      );
      const start = page * pageSize;
      const voices = compatibleCache.voices.slice(start, start + pageSize);
      const languageGroups = await fetchLanguageGroupsWithCounts(
        account,
        upstreamParams,
        persistentCache,
      );
      const response: CatalogResponse = {
        voices,
        languageGroups,
        page,
        pageSize,
        hasMore: compatibleCache.voices.length > start + voices.length || compatibleCache.upstreamHasMore,
        totalCount: compatibleCache.totalCount,
        elevenLabsConfigured: true,
        cachedAt: now,
      };
      return reply.send(response);
    } catch (error) {
      if (error instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(error));
      }
      if (error instanceof ModelFundingError) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send({
          ...projection.body,
          voices: [] as CatalogVoice[],
          languageGroups: [] as CatalogLanguageGroup[],
          page: normalizeCatalogPage(upstreamParams["page"]),
          pageSize: normalizeCatalogPageSize(upstreamParams["page_size"]),
          hasMore: false,
          totalCount: 0,
          elevenLabsConfigured: true,
          cachedAt: null,
        });
      }
      return reply.code(502).send({
        // Provider responses can include account-specific diagnostics. This
        // route is available to every authenticated non-guest user, so do
        // not reflect upstream detail (or provider credentials) to callers.
        error: "Failed to load voice catalog.",
        voices: [] as CatalogVoice[],
        languageGroups: [] as CatalogLanguageGroup[],
        page: normalizeCatalogPage(upstreamParams["page"]),
        pageSize: normalizeCatalogPageSize(upstreamParams["page_size"]),
        hasMore: false,
        totalCount: 0,
        elevenLabsConfigured: true,
        cachedAt: null,
      });
    }
  });

  app.post<{ Params: { voiceId: string }; Body?: { text?: string } }>(
    "/api/voices/:voiceId/preview",
    async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (request.policyContext?.actorRole === "guest") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const voiceId = request.params.voiceId;
    if (!isValidElevenLabsVoiceId(voiceId)) {
      return reply.code(400).send({ error: "Invalid voice id" });
    }

    const body = request.body;
    const raw =
      typeof body === "object" && body !== null && "text" in body ?
        (body as { text?: unknown }).text
      : undefined;
    if (typeof raw === "string" && raw.length > MAX_PREVIEW_TEXT_CHARACTERS) {
      return reply.code(400).send({
        error: `Voice preview text must be ${MAX_PREVIEW_TEXT_CHARACTERS} characters or fewer.`,
        errorCode: "preview_text_too_long",
      });
    }
    const customText = typeof raw === "string" ? raw.trim() : "";
    const textToSpeak = customText.length > 0 ? customText : AUDITION_SCRIPT_V2;

    const signal = requestAbortSignal(request, reply);
    let account: VoiceProviderAccount;
    try { account = await resolveAccount(request.sessionUserId, "voice_preview", signal); }
    catch (error) {
      if (error instanceof ModelFundingError) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send(projection.body);
      }
      return reply.code(400).send({ error: voiceProviderUnavailableMessage() });
    }

    if (!allowPreview(account.fingerprint)) {
      return reply
        .code(429)
        .send({ error: "Too many preview requests; try again in a minute." });
    }

    let model: SpeechModel;
    try { model = await resolveSpeechModel(request.sessionUserId); }
    catch (error) {
      if (error instanceof ModelFundingError) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send(projection.body);
      }
      return reply.code(503).send({ error: "The server speech model is unavailable." });
    }
    const path = previewFilePathForCustom(voiceId, JSON.stringify(["speech-preview-v2", account.fingerprint, model.id, model.providerModelId, model.speech.transport, "mp3_44100_128", VOICE_SETTINGS, textToSpeak]));
    const releaseWriter = retainPreviewPath(path);

    try {
      await previewDeletionInflight.get(path);
      if (await isRegularPreviewFile(path)) {
        reply.header("Content-Type", "audio/mpeg");
        reply.header("Cache-Control", "private, no-store");
        return sendPreviewStream(reply, path);
      }
      // Ensure the parent directory exists. Both previewFilePath and
      // previewFilePathForCustom return paths under data/voice-previews/
      // which ensureDirectoryTree() creates on boot — the mkdir is
      // cheap insurance in case the zone was deleted at runtime.
      await mkdir(dirname(path), { recursive: true });
      const buf = await synthesizePreviewMp3(account, voiceId, textToSpeak, model, {
        userId: request.sessionUserId,
        begin: beginCost,
        settle: settleCost,
      });
      await writePreviewAtomically(path, buf);
      await cleanupGeneratedVoicePreviewCache(dirname(path)).catch(() => {});
      reply.header("Content-Type", "audio/mpeg");
      reply.header("Cache-Control", "private, no-store");
      return sendPreviewStream(reply, path);
    } catch (error) {
      if (error instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(error));
      }
      if (error instanceof ModelFundingError) {
        const projection = await voiceFundingFailureProjection(error, request.sessionUserId, getCapabilities);
        return reply.code(projection.status).send(projection.body);
      }
      // Preview is deliberately callable by ordinary users. Keep provider
      // error detail server-side so an upstream diagnostic cannot expose a
      // configured key or account information through this proxy.
      return reply.code(502).send({ error: "Voice preview failed." });
    } finally {
      releaseWriter();
    }
    },
  );
}
