import { agentDb as db, agents, eq, profiles, sql } from "@nautilo/db";
import { resolveNautiloRootDir } from "@nautilo/config";
import type { AvatarRef, ProfileVoices, VoiceRef } from "@nautilo/types";
import { DEFAULT_VOICE_KEY, VOICE_LANG_KEY_REGEX } from "@nautilo/types";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertProfileDefaultModelAllowed,
  normalizeProfileDefaultModel,
} from "../config/model-id-validation";
import { assertModelRunnable } from "../config/eligible-models";
import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";

export interface NautiloProfile {
  id: string;
  userId: string;
  /** M132 — the Agent this Profile describes (canonical 1:1 key). */
  agentId: string;
  name: string;
  soulFile: string | null;
  language: string;
  privacySpectrum: number | null;
  workLifeMode: string | null;
  voiceName: string | null;
  voiceId: string | null;
  /**
   * D261 — per-language voice map (`"default"` = primary). Canonical going
   * forward; `voiceName`/`voiceId` are the legacy single-voice columns being
   * retired. Read `voices.default` for the primary voice.
   */
  voices: ProfileVoices;
  personalityPrompt: string | null;
  motherAnswer: string | null;
  avatar: AvatarRef | null;
  publicProfile: boolean;
  personalityTone: string | null;
  defaultModel: string | null;
  onboardingCompleted: boolean;
  welcomeMessageSent: boolean;
  /**
   * D141 P2 / LD-1, LD-4 — per-user default for opt-in model fallback.
   * Default `false`. Overridable per-agent via `agents.customization.fallback.enabled`
   * (see `resolveFallbackPolicy`).
   */
  fallbackEnabled: boolean;
  /**
   * D141 P2 / LD-1, LD-4 — ordered list of catalog model IDs the user
   * has authored as their default fallback chain. `[]` by default.
   * Overridable per-agent via `agents.customization.fallback.chain`.
   */
  fallbackChain: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertProfileInput {
  name?: string;
  soulFile?: string | null;
  language?: string;
  privacySpectrum?: number | null;
  workLifeMode?: string | null;
  personalityPrompt?: string | null;
  motherAnswer?: string | null;
  publicProfile?: boolean;
  personalityTone?: string | null;
  defaultModel?: string | null;
  onboardingCompleted?: boolean;
  welcomeMessageSent?: boolean;
  /**
   * M087 — IANA timezone captured by the onboarding wizard. NOT stored on
   * the `profiles` row (timezone is account-level); `upsertProfile` ignores
   * it. The `PUT /api/profile` route extracts + validates it and persists to
   * `users.timezone` so a freshly-onboarded user has a stored timezone even
   * before their first chat send.
   */
  timezone?: string;
}

/**
 * Read the Profile by user. SAFE while the 1-Agent-per-Human invariant
 * holds (the only model today). If multi-Agent ships, this becomes
 * non-deterministic for a multi-Agent user — migrate such callers to
 * `getProfileByAgentId`. Tracked as M132 follow-up.
 */
export async function getProfile(userId: string): Promise<NautiloProfile | null> {
  const rows = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const row = rows[0];
  return row ? mapProfile(row) : null;
}

/**
 * M132 — read the Profile by its canonical key (the Agent). Prefer this
 * wherever an `agentId` is in scope.
 */
export async function getProfileByAgentId(agentId: string): Promise<NautiloProfile | null> {
  const rows = await db
    .select()
    .from(profiles)
    .where(eq(profiles.agentId, agentId))
    .limit(1);

  const row = rows[0];
  return row ? mapProfile(row) : null;
}

export type AgentExecutionProfileConfig = Readonly<{
  name: string;
  defaultModel: string | null;
  soulFile: string | null;
}>;

/** Narrow execution projection: identity/model plus the authored Soul exception. */
export async function getAgentExecutionConfigById(
  agentId: string,
): Promise<AgentExecutionProfileConfig | null> {
  const rows = await db
    .select({
      name: profiles.name,
      defaultModel: profiles.defaultModel,
      soulFile: profiles.soulFile,
    })
    .from(profiles)
    .where(eq(profiles.agentId, agentId));
  return rows[0] ?? null;
}

/** M156 — the Agent's name is single-sourced on `profiles.name` (M132 1:1). */
export async function getAgentDisplayNameById(agentId: string): Promise<string | null> {
  if (!agentId.trim()) return null;
  try {
    const rows = await db
      .select({ name: profiles.name })
      .from(profiles)
      .where(eq(profiles.agentId, agentId))
      .limit(1);
    return rows[0]?.name ?? null; // null → caller falls back to "Genie"
  } catch {
    return null;
  }
}

/**
 * M169 (R1) — resolve an Agent's `@handle` from `agents.handle` by `agentId`.
 *
 * No existing helper resolves `agentId → agents.handle`: the human-handle
 * resolvers (`findLocalUserByHandle` / `findAgentUserByNormalizedHandle`) look
 * humans up BY handle, and `getAgentDisplayNameById` reads `profiles.name`, not
 * the handle. The transcript reader needs the handle so labelled lines carry
 * `@handle` (never a raw agent id). Returns `null` (caller falls back to a
 * non-id sentinel) on a missing row or a read error.
 */
export async function getAgentHandleById(agentId: string): Promise<string | null> {
  if (!agentId.trim()) return null;
  try {
    const rows = await db
      .select({ handle: agents.handle })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return rows[0]?.handle ?? null;
  } catch {
    return null;
  }
}

export async function upsertProfile(
  userId: string,
  agentId: string,
  data: UpsertProfileInput,
): Promise<NautiloProfile> {
  const now = new Date();

  let coercedDefaultModel: string | null | undefined;
  if (data.defaultModel !== undefined) {
    coercedDefaultModel = normalizeProfileDefaultModel(data.defaultModel);
    const catalogIds = new Set(
      getActiveModelCatalogSync().catalog.entries
        .filter((entry) => entry.defaultEnabled)
        .map((entry) => entry.id),
    );
    assertProfileDefaultModelAllowed(coercedDefaultModel, catalogIds);
    if (coercedDefaultModel !== null) {
      assertModelRunnable(coercedDefaultModel, { purpose: "chat-tools" });
    }
  }

  const [row] = await db
    .insert(profiles)
    .values({
      userId,
      agentId,
      name: data.name ?? "Genie",
      soulFile: data.soulFile ?? null,
      language: data.language ?? "en",
      privacySpectrum: data.privacySpectrum ?? null,
      workLifeMode: data.workLifeMode ?? null,
      personalityPrompt: data.personalityPrompt ?? null,
      motherAnswer: data.motherAnswer ?? null,
      // D487: profile creation starts without a selected photo. Photo changes
      // belong exclusively to AgentPhotoLibraryService so history, ownership,
      // optimistic concurrency, and media lifecycle cannot be bypassed here.
      avatarRef: null,
      publicProfile: data.publicProfile ?? false,
      personalityTone: data.personalityTone ?? null,
      defaultModel:
        coercedDefaultModel !== undefined ? coercedDefaultModel : data.defaultModel ?? null,
      onboardingCompleted: data.onboardingCompleted ?? false,
      welcomeMessageSent: data.welcomeMessageSent ?? false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: profiles.agentId,
      set: {
        updatedAt: now,
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.soulFile !== undefined ? { soulFile: data.soulFile } : {}),
        ...(data.language !== undefined ? { language: data.language } : {}),
        ...(data.privacySpectrum !== undefined ? { privacySpectrum: data.privacySpectrum } : {}),
        ...(data.workLifeMode !== undefined ? { workLifeMode: data.workLifeMode } : {}),
        ...(data.personalityPrompt !== undefined ? { personalityPrompt: data.personalityPrompt } : {}),
        ...(data.motherAnswer !== undefined ? { motherAnswer: data.motherAnswer } : {}),
        ...(data.publicProfile !== undefined ? { publicProfile: data.publicProfile } : {}),
        ...(data.personalityTone !== undefined ? { personalityTone: data.personalityTone } : {}),
        ...(coercedDefaultModel !== undefined ? { defaultModel: coercedDefaultModel } : {}),
        ...(data.onboardingCompleted !== undefined
          ? { onboardingCompleted: data.onboardingCompleted }
          : {}),
        ...(data.welcomeMessageSent !== undefined ? { welcomeMessageSent: data.welcomeMessageSent } : {}),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert profile");
  }

  if (row.soulFile) {
    await mirrorSoulFileToDisk(row.soulFile);
  }

  return mapProfile(row);
}

function mapProfile(row: typeof profiles.$inferSelect): NautiloProfile {
  return {
    id: row.id,
    userId: row.userId,
    agentId: row.agentId,
    name: row.name,
    soulFile: row.soulFile,
    language: row.language,
    privacySpectrum: row.privacySpectrum,
    workLifeMode: row.workLifeMode,
    voiceName: row.voiceName,
    voiceId: row.voiceId,
    voices: row.voices ?? {},
    personalityPrompt: row.personalityPrompt,
    motherAnswer: row.motherAnswer,
    avatar: row.avatarRef ?? null,
    publicProfile: row.publicProfile,
    personalityTone: row.personalityTone,
    defaultModel: row.defaultModel,
    onboardingCompleted: row.onboardingCompleted,
    welcomeMessageSent: row.welcomeMessageSent,
    fallbackEnabled: row.fallbackEnabled,
    fallbackChain: row.fallbackChain,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * D141 P2 / LD-1 — dedicated writer for the fallback fields on
 * `profiles`. Kept separate from `upsertProfile` to keep its blast
 * radius narrow: this updates only `fallback_enabled` and
 * `fallback_chain`, returns the updated NautiloProfile. The PATCH
 * `/api/profile/fallback` route is the canonical caller.
 *
 * Chain validation (rejecting unknown model IDs) belongs at the route
 * layer, not here — the store trusts its callers to pre-validate.
 *
 * Errors:
 *   - throws if no profile row exists for `agentId` (caller must
 *     ensure `upsertProfile` has run first; in the standard flow
 *     this is guaranteed by the onboarding path)
 *
 * M307 — the fallback policy is Agent-owned profile state. The current UI
 * exposes one personal Agent per Human, but writes use the canonical Agent
 * key now so the setting does not need another ownership migration later.
 */
export async function updateFallbackPolicy(
  agentId: string,
  policy: { enabled: boolean; chain: string[] },
): Promise<NautiloProfile> {
  const now = new Date();
  const [row] = await db
    .update(profiles)
    .set({
      fallbackEnabled: policy.enabled,
      fallbackChain: policy.chain,
      updatedAt: now,
    })
    .where(eq(profiles.agentId, agentId))
    .returning();

  if (!row) {
    throw new Error(`updateFallbackPolicy: no profile row for agentId=${agentId}`);
  }

  return mapProfile(row);
}

/**
 * D261 — validate a `voices` map key: reserved `"default"` or a BCP-47
 * primary subtag. Throws on anything else (the strict charset also makes
 * the key safe to interpolate into the `jsonb_set` path below).
 */
export function assertValidVoiceLangKey(lang: string): void {
  if (!VOICE_LANG_KEY_REGEX.test(lang)) {
    throw new Error(
      `Invalid voice language key "${lang}" — use "default" or a BCP-47 subtag (e.g. "es", "fr-CA").`,
    );
  }
}

/**
 * D261 — read the speaking Agent's per-language voice map. Agent-keyed
 * (the canonical M132 key). Returns `{}` when unset or no profile.
 */
export async function getVoices(agentId: string): Promise<ProfileVoices> {
  const rows = await db
    .select({ voices: profiles.voices })
    .from(profiles)
    .where(eq(profiles.agentId, agentId))
    .limit(1);
  return rows[0]?.voices ?? {};
}

/**
 * D261 — set/replace one language slot. Atomic per-key via `jsonb_set`
 * (no read-modify-write, so concurrent `/voices/:lang` calls don't clobber
 * each other). `lang` is the reserved `"default"` (primary) or a BCP-47 key.
 */
export async function upsertVoiceAssignment(
  agentId: string,
  lang: string,
  voice: VoiceRef,
): Promise<void> {
  assertValidVoiceLangKey(lang);
  // lang is validated to a safe charset above, so raw interpolation into the
  // jsonb path literal cannot inject. value rides as a bound jsonb param.
  const path = sql.raw(`'{${lang}}'`);
  await db
    .update(profiles)
    .set({
      voices: sql`jsonb_set(${profiles.voices}, ${path}::text[], ${JSON.stringify(voice)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(profiles.agentId, agentId));
}

/**
 * D261 — remove one language slot. The primary (`"default"`) cannot be
 * removed (only replaced via `upsertVoiceAssignment`).
 */
export async function removeVoiceAssignment(agentId: string, lang: string): Promise<void> {
  assertValidVoiceLangKey(lang);
  if (lang === DEFAULT_VOICE_KEY) {
    throw new Error('Cannot remove the primary voice ("default") — replace it instead.');
  }
  await db
    .update(profiles)
    .set({
      voices: sql`${profiles.voices} - ${lang}`,
      updatedAt: new Date(),
    })
    .where(eq(profiles.agentId, agentId));
}

async function mirrorSoulFileToDisk(content: string): Promise<void> {
  const path = join(resolveNautiloRootDir(), "soul.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}
