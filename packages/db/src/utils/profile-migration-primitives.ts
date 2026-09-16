import { createHash } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { HANDLE_RE, normalizeHandle, type ProfileVoices } from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";
import { agents } from "../schema/agents";
import { profiles } from "../schema/profiles";
import { actors } from "../schema/trust";
import { users } from "../schema/users";
import { buildHandleCandidates } from "./rename-agent-profile-identity";

/**
 * D425 Wave 1A — transaction-aware profile/identity primitives for the
 * portable Genie profile importer.
 *
 * The existing `renameAgentProfileIdentity` / `setAgentHandle` helpers
 * (`./rename-agent-profile-identity.ts`) each open their OWN Postgres
 * transaction via `createDirectDb(1)`. That is fine for a single rename,
 * but a profile import MUST apply name + actor cache + handle as one
 * all-or-prior-target unit alongside the rest of the bundle's writes
 * (avatar finalization, etc.); a helper that commits its own sub-transaction
 * mid-import cannot provide the required "leave the target unchanged or
 * fully applied" result. These primitives take the caller's transaction
 * handle so the importer owns the commit boundary.
 *
 * Three concerns are covered here, matching the Wave 1A task:
 *
 *   1. **Approved Wave 1A profile allowlist** — `applyWave1AProfileAllowlist`
 *      filters a source profile to the portable, D425-approved fields only,
 *      dropping target-local / privacy-sensitive lifecycle state
 *      (`onboardingCompleted`, `welcomeMessageSent`, `publicProfile`) and
 *      any ID / timestamp / unknown key. Wave 0 freezes this allowlist.
 *   2. **Coherent profile name / actor cache / handle state** —
 *      `renameAgentProfileIdentityInTx`, `setAgentHandleInTx`, and the
 *      importer-facing `applyProfileIdentityInTx` perform the same
 *      single-sourced-name + synced-actor-cache + handle write as the
 *      existing helpers, but inside a caller-supplied transaction.
 *   3. **Target-state digest for stale-plan detection** —
 *      `computeTargetStateDigestInTx` produces a deterministic SHA-256 over
 *      the target identity surface so the importer can bind a dry-run plan
 *      to it and reject a commit when the target moved after the plan was
 *      formed.
 *
 * Scope guard: this module is DB/identity-only. It does NOT touch avatar
 * bytes, storage, server routes, CLI, schema, or migrations, and it wires
 * NO import endpoint. The future importer composes these primitives.
 */

/**
 * The Drizzle transaction handle a caller passes in. Derived from the
 * concrete `createDirectDb()` postgres-js connection so the full typed
 * query API (select / insert / update / returning / onConflict) is
 * preserved at the call site — same shape `db.transaction(async (tx) => …)`
 * hands to its callback.
 */
export type ProfileMigrationTx = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

// ---------------------------------------------------------------------------
// 1. Wave 1A profile allowlist
// ---------------------------------------------------------------------------

/**
 * D425 Wave 0 frozen allowlist — portable Agent Profile configuration only.
 * These are the profile fields a `GenieLiveV1` semantic bundle may carry
 * and a Wave 1A import may apply. Anything not listed here is refused by
 * `applyWave1AProfileAllowlist`.
 *
 * Source: ISSUE-D425 "Portable package contract" (`profile.json`: soul,
 * personality, voices, model/fallback preferences) and the locked
 * "Wave 0 freezes the Wave 1A allowlist" note.
 */
export const WAVE_1A_PROFILE_ALLOWED_FIELDS = [
  "name",
  "soulFile",
  "personalityPrompt",
  "personalityTone",
  "motherAnswer",
  "language",
  "voices",
  "voiceName",
  "voiceId",
  "defaultModel",
  "fallbackEnabled",
  "fallbackChain",
  "privacySpectrum",
  "workLifeMode",
] as const;

export type Wave1AProfileField = (typeof WAVE_1A_PROFILE_ALLOWED_FIELDS)[number];

/**
 * Explicitly EXCLUDED fields — target-local / privacy-sensitive lifecycle
 * state and all identity / timestamp / primary-key columns. Listed
 * separately so the importer can audit a source payload and surface a
 * precise "refused X" signal rather than silently dropping it.
 *
 * `onboardingCompleted`, `welcomeMessageSent`, `publicProfile` are the
 * three lifecycle fields ISSUE-D425 names verbatim as out-of-scope.
 */
export const WAVE_1A_PROFILE_EXCLUDED_LIFECYCLE_FIELDS = [
  "onboardingCompleted",
  "welcomeMessageSent",
  "publicProfile",
] as const;

export const WAVE_1A_PROFILE_EXCLUDED_IDENTITY_FIELDS = [
  "id",
  "userId",
  "agentId",
  "createdAt",
  "updatedAt",
] as const;

/** D487: known portable photo intent, owned by the photo-library lifecycle. */
export const WAVE_1A_PROFILE_EXCLUDED_PHOTO_FIELDS = ["avatarRef"] as const;

const WAVE_1A_ALLOWED_SET: ReadonlySet<string> = new Set(
  WAVE_1A_PROFILE_ALLOWED_FIELDS,
);

const WAVE_1A_EXCLUDED_SET: ReadonlySet<string> = new Set([
  ...WAVE_1A_PROFILE_EXCLUDED_LIFECYCLE_FIELDS,
  ...WAVE_1A_PROFILE_EXCLUDED_IDENTITY_FIELDS,
  ...WAVE_1A_PROFILE_EXCLUDED_PHOTO_FIELDS,
]);

/**
 * The typed portable payload that survives the allowlist. Every field is
 * optional: the importer applies only what the source carried.
 */
export interface Wave1AProfilePayload {
  name?: string;
  soulFile?: string | null;
  personalityPrompt?: string | null;
  personalityTone?: string | null;
  motherAnswer?: string | null;
  language?: string;
  voices?: ProfileVoices;
  voiceName?: string | null;
  voiceId?: string | null;
  defaultModel?: string | null;
  fallbackEnabled?: boolean;
  fallbackChain?: string[];
  privacySpectrum?: number | null;
  workLifeMode?: string | null;
}

export interface ApplyAllowlistResult {
  /** The portable payload — allowed fields only. */
  payload: Wave1AProfilePayload;
  /** Excluded lifecycle/identity keys that were present in the source. */
  refused: string[];
  /** Keys present in the source that are neither allowed nor known-excluded. */
  unknown: string[];
}

/**
 * Filter a source profile map (a decoded bundle entry, a raw row, etc.)
 * down to the D425 Wave 1A approved fields. Returns the typed payload
 * plus the refused (excluded) and unknown keys so the importer can report
 * them in the dry-run plan instead of silently swallowing scope creep.
 *
 * Pure / synchronous / no DB — exhaustively unit-testable.
 */
export function applyWave1AProfileAllowlist(
  input: Record<string, unknown>,
): ApplyAllowlistResult {
  const payload: Wave1AProfilePayload = {};
  const refused: string[] = [];
  const unknown: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (WAVE_1A_ALLOWED_SET.has(key)) {
      // Only copy defined values; `undefined` is treated as "absent" so a
      // sparse source doesn't overwrite target state with nothing.
      if (value !== undefined) {
        // `as keyof Wave1AProfilePayload` — key is provably in the allowlist.
        (payload as Record<string, unknown>)[key] = value;
      }
      continue;
    }
    if (WAVE_1A_EXCLUDED_SET.has(key)) {
      if (value !== undefined) refused.push(key);
      continue;
    }
    if (value !== undefined) unknown.push(key);
  }

  return { payload, refused, unknown };
}

/** True iff `key` is on the Wave 1A approved allowlist. */
export function isWave1AProfileFieldAllowed(key: string): boolean {
  return WAVE_1A_ALLOWED_SET.has(key);
}

// ---------------------------------------------------------------------------
// Handle intent — translating the SOURCE agent's handle state for import
// ---------------------------------------------------------------------------

/**
 * The source Agent's handle policy, as carried by the semantic bundle's
 * `agent.json` ("handle intent + portable customization only").
 *
 *   - `customized`: the person edited the handle by hand on the source
 *     (`agents.handle_customized = true`). Import requests that EXACT
 *     handle on the target and FAILS CLOSED on collision — no auto-suffix,
 *     because a surprising new identity is worse than a deterministic
 *     "pick another handle" prompt (D425 locked decision 3).
 *   - `auto`: the source handle was auto-derived from the name. Import
 *     REGENERATES the derived handle on the target from the portable name
 *     against the target's collision space; it never replays the source's
 *     allocated string.
 */
export type HandleIntent =
  | { kind: "customized"; handle: string }
  | { kind: "auto" };

/**
 * Derive the handle intent from a source agent row's identity projection.
 * The importer reads the source `agents` row once, then hands the intent
 * to `applyProfileIdentityInTx` on the target.
 */
export function extractHandleIntent(agentRow: {
  handle: string;
  handleCustomized: boolean;
}): HandleIntent {
  if (agentRow.handleCustomized) {
    return { kind: "customized", handle: agentRow.handle };
  }
  return { kind: "auto" };
}

// ---------------------------------------------------------------------------
// 2. Transaction-aware identity primitives
// ---------------------------------------------------------------------------

/**
 * Internal: write the canonical `profiles.name` (insert-or-update by
 * `agent_id`) and sync the agent-kind `actors.display_name` cache row.
 * Shared by every identity primitive below so the name + actor cache
 * commit as one unit inside the caller's transaction.
 *
 * Throws if the agent-kind actor mirror is missing or ambiguous — the
 * same invariant `renameAgentProfileIdentity` enforces, kept identical so
 * a failed actor sync rolls back the profile-name write with it.
 */
async function syncProfileNameAndActorInTx(
  tx: ProfileMigrationTx,
  args: { ownerUserId: string; agentId: string; name: string },
  now: Date,
): Promise<void> {
  // 1. Canonical name on the Profile (insert-or-update by agent_id).
  await tx
    .insert(profiles)
    .values({
      userId: args.ownerUserId,
      agentId: args.agentId,
      name: args.name,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: profiles.agentId,
      set: { name: args.name, updatedAt: now },
    });

  // 2. Synced participant-cache on the agent-kind actor row. Require
  //    exactly one local agent-kind actor; never blanket-update.
  const touchedActors = await tx
    .update(actors)
    .set({ displayName: args.name, updatedAt: now })
    .where(and(eq(actors.agentId, args.agentId), eq(actors.kind, "agent")))
    .returning({ id: actors.id });
  if (touchedActors.length !== 1) {
    throw new Error(
      `syncProfileNameAndActorInTx: expected exactly 1 agent-kind actor for agent ${args.agentId}, found ${touchedActors.length}`,
    );
  }
}

/**
 * Internal: walk `buildHandleCandidates` against the target's collision
 * space (other Agent handles + local Human handles) and allocate the first
 * free auto-derived handle for `agentId`. Mirrors the auto-derive branch
 * of `renameAgentProfileIdentity` exactly, lifted onto a caller-supplied
 * transaction.
 *
 * Returns the chosen handle. Throws if no candidate is free.
 */
async function allocateAutoHandleInTx(
  tx: ProfileMigrationTx,
  args: { agentId: string; name: string; ownerUserId: string },
  now: Date,
): Promise<string> {
  const [agentRow] = await tx
    .select({ handle: agents.handle, handleCustomized: agents.handleCustomized })
    .from(agents)
    .where(eq(agents.id, args.agentId))
    .limit(1);
  if (!agentRow) {
    throw new Error(`allocateAutoHandleInTx: agent ${args.agentId} not found`);
  }

  const [ownerRow] = await tx
    .select({ handle: users.handle })
    .from(users)
    .where(and(eq(users.id, args.ownerUserId), isNull(users.server)))
    .limit(1);
  const ownerHandle = ownerRow?.handle?.trim() || "owner";

  const candidates = buildHandleCandidates(args.name, ownerHandle);
  for (const candidate of candidates) {
    if (candidate === agentRow.handle) {
      // Already on a valid derived handle — keep it, no churn.
      return candidate;
    }
    const [agentClash] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.handle, candidate), ne(agents.id, args.agentId)))
      .limit(1);
    if (agentClash) continue;
    const [humanClash] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.handle, candidate), isNull(users.server)))
      .limit(1);
    if (humanClash) continue;

    await tx
      .update(agents)
      .set({ handle: candidate, handleCustomized: false, updatedAt: now })
      .where(eq(agents.id, args.agentId));
    return candidate;
  }

  throw new Error(
    `allocateAutoHandleInTx: could not allocate a handle for "${args.name}" (owner @${ownerHandle})`,
  );
}

/**
 * Internal: probe the shared `@handle@server` collision space (other Agent
 * handles + local Human handles) for `candidate` excluding `agentId`.
 * Returns true if the handle is free for `agentId`.
 */
async function isHandleFreeInTx(
  tx: ProfileMigrationTx,
  agentId: string,
  candidate: string,
): Promise<boolean> {
  const [agentClash] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.handle, candidate), ne(agents.id, agentId)))
    .limit(1);
  if (agentClash) return false;
  const [humanClash] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.handle, candidate), isNull(users.server)))
    .limit(1);
  return !humanClash;
}

/**
 * Transaction-aware twin of `renameAgentProfileIdentity` — identical
 * semantics (single-sourced name + synced actor cache + auto-derived or
 * frozen-customized handle), but on a caller-supplied transaction so the
 * importer can group it with the rest of the bundle's writes.
 *
 * A customized handle (`agents.handle_customized = true`) is FROZEN: the
 * name + actor cache still update, but the handle is left untouched. This
 * matches the local-rename contract; for import's customized-handle
 * REQUEST behavior use `applyProfileIdentityInTx`.
 */
export async function renameAgentProfileIdentityInTx(
  tx: ProfileMigrationTx,
  args: { ownerUserId: string; agentId: string; name: string },
): Promise<{ name: string; handle: string }> {
  const trimmedName = args.name.trim();
  if (!trimmedName) {
    throw new Error("renameAgentProfileIdentityInTx: name cannot be empty");
  }

  const now = new Date();
  await syncProfileNameAndActorInTx(tx, args, now);

  const [agentRow] = await tx
    .select({ handle: agents.handle, handleCustomized: agents.handleCustomized })
    .from(agents)
    .where(eq(agents.id, args.agentId))
    .limit(1);
  if (!agentRow) {
    throw new Error(`renameAgentProfileIdentityInTx: agent ${args.agentId} not found`);
  }
  if (agentRow.handleCustomized) {
    return { name: trimmedName, handle: agentRow.handle };
  }

  const handle = await allocateAutoHandleInTx(tx, args, now);
  return { name: trimmedName, handle };
}

/**
 * Transaction-aware twin of `setAgentHandle` — set the Agent handle by
 * hand and freeze auto-derivation (`handle_customized = true`). Uniqueness
 * spans other Agent handles and local Human handles, same as the original.
 * Caller MUST pre-validate format (`HANDLE_RE` + `normalizeHandle`).
 */
export async function setAgentHandleInTx(
  tx: ProfileMigrationTx,
  agentId: string,
  handle: string,
): Promise<{ ok: true } | { ok: false; code: "handle_taken" }> {
  if (!(await isHandleFreeInTx(tx, agentId, handle))) {
    return { ok: false, code: "handle_taken" };
  }
  await tx
    .update(agents)
    .set({ handle, handleCustomized: true, updatedAt: new Date() })
    .where(eq(agents.id, agentId));
  return { ok: true };
}

/**
 * The importer-facing identity primitive. Applies the portable name and
 * resolves the handle per the SOURCE handle intent, all inside the
 * caller's transaction:
 *
 *   - `customized` intent: requests that EXACT handle on the target.
 *     Validates format, probes the collision space, and FAILS CLOSED on
 *     any collision (no auto-suffix). On success freezes the handle
 *     (`handle_customized = true`). A collision throws
 *     `HandleCollisionError` so the importer can surface a deterministic
 *     "choose another handle" decision in the dry-run / commit report.
 *   - `auto` intent: REGENERATES the derived handle on the target from
 *     the portable name against the target's collision space, leaving
 *     `handle_customized = false`. The source's allocated handle string
 *     is never replayed.
 *
 * The name + actor cache sync always runs first; a handle failure rolls
 * the whole thing back with the caller's transaction.
 */
export async function applyProfileIdentityInTx(
  tx: ProfileMigrationTx,
  args: {
    ownerUserId: string;
    agentId: string;
    name: string;
    handleIntent: HandleIntent;
  },
): Promise<{ name: string; handle: string; handleCustomized: boolean }> {
  const trimmedName = args.name.trim();
  if (!trimmedName) {
    throw new Error("applyProfileIdentityInTx: name cannot be empty");
  }

  const now = new Date();
  await syncProfileNameAndActorInTx(tx, args, now);

  if (args.handleIntent.kind === "customized") {
    const normalized = normalizeHandle(args.handleIntent.handle);
    if (!HANDLE_RE.test(normalized)) {
      throw new Error(
        `applyProfileIdentityInTx: customized handle "${args.handleIntent.handle}" is not a valid handle`,
      );
    }
    if (!(await isHandleFreeInTx(tx, args.agentId, normalized))) {
      throw new HandleCollisionError(normalized, args.agentId);
    }
    await tx
      .update(agents)
      .set({ handle: normalized, handleCustomized: true, updatedAt: now })
      .where(eq(agents.id, args.agentId));
    return { name: trimmedName, handle: normalized, handleCustomized: true };
  }

  // auto: regenerate the derived handle on the target.
  const handle = await allocateAutoHandleInTx(tx, args, now);
  return { name: trimmedName, handle, handleCustomized: false };
}

/**
 * Transaction-aware writer for the Wave 1A portable profile fields — every
 * `Wave1AProfilePayload` field EXCEPT `name`, which is owned by
 * `applyProfileIdentityInTx` (so the name + actor cache + handle commit as
 * one identity unit). The importer calls the identity primitive first (which
 * insert-or-updates the profiles row by `agent_id`), then this writer to apply
 * the remaining portable fields, all inside the caller's single transaction.
 *
 * Sparse by construction: a field that is `undefined` in `payload` is left
 * untouched on the target — the importer applies only what the source bundle
 * carried. Agent-photo selection is intentionally absent: D487 requires the
 * owned photo-library lifecycle to create/select/clear photos so this generic
 * profile primitive cannot bypass ownership, history, or optimistic revision.
 *
 * Throws if no profiles row exists for `agentId`. The identity primitive's
 * insert-or-update guarantees one on the happy path; a missing row here is a
 * real invariant violation worth rolling the whole transaction back for.
 */
export async function applyWave1AProfileFieldsInTx(
  tx: ProfileMigrationTx,
  agentId: string,
  payload: Wave1AProfilePayload,
  now: Date = new Date(),
): Promise<void> {
  const set: Partial<typeof profiles.$inferInsert> = { updatedAt: now };
  if (payload.soulFile !== undefined) set.soulFile = payload.soulFile;
  if (payload.personalityPrompt !== undefined) set.personalityPrompt = payload.personalityPrompt;
  if (payload.personalityTone !== undefined) set.personalityTone = payload.personalityTone;
  if (payload.motherAnswer !== undefined) set.motherAnswer = payload.motherAnswer;
  if (payload.language !== undefined) set.language = payload.language;
  if (payload.voices !== undefined) set.voices = payload.voices;
  if (payload.voiceName !== undefined) set.voiceName = payload.voiceName;
  if (payload.voiceId !== undefined) set.voiceId = payload.voiceId;
  if (payload.defaultModel !== undefined) set.defaultModel = payload.defaultModel;
  if (payload.fallbackEnabled !== undefined) set.fallbackEnabled = payload.fallbackEnabled;
  if (payload.fallbackChain !== undefined) set.fallbackChain = payload.fallbackChain;
  if (payload.privacySpectrum !== undefined) set.privacySpectrum = payload.privacySpectrum;
  if (payload.workLifeMode !== undefined) set.workLifeMode = payload.workLifeMode;
  // `name` is intentionally NOT set here — owned by applyProfileIdentityInTx.

  const updated = await tx
    .update(profiles)
    .set(set)
    .where(eq(profiles.agentId, agentId))
    .returning({ id: profiles.id });
  if (updated.length !== 1) {
    throw new Error(
      `applyWave1AProfileFieldsInTx: expected exactly 1 profiles row for agent ${agentId}, updated ${updated.length}`,
    );
  }
}

/**
 * Raised by `applyProfileIdentityInTx` when a customized source handle
 * collides on the target. Distinct type so the importer can catch it
 * specifically and present a "choose another handle" decision rather than
 * a generic failure (D425 locked decision 3: fail closed + ask).
 */
export class HandleCollisionError extends Error {
  readonly code = "handle_collision" as const;
  readonly handle: string;
  readonly agentId: string;
  constructor(handle: string, agentId: string) {
    super(
      `applyProfileIdentityInTx: customized handle "${handle}" is taken on the target ` +
        `(agent ${agentId}); refusing to auto-suffix. Choose a different handle.`,
    );
    this.name = "HandleCollisionError";
    this.handle = handle;
    this.agentId = agentId;
  }
}

// ---------------------------------------------------------------------------
// 3. Target-state digest (stale-plan detection)
// ---------------------------------------------------------------------------

/**
 * The identity surface the import will mutate, captured for digesting.
 * Read from the target by `readTargetStateForDigestInTx`; the importer
 * binds a dry-run plan to the digest and rejects a commit if the digest
 * changed (the target moved after the plan was formed).
 */
export interface TargetStateDigestInput {
  profileName: string | null;
  profileUpdatedAt: string | number | Date | null;
  agentHandle: string | null;
  agentHandleCustomized: boolean | null;
  agentUpdatedAt: string | number | Date | null;
}

function normalizeTimestamp(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Deterministic canonical string for the target identity surface. Keyed
 * `field=value` pairs joined by `|`, keys sorted — independent of object
 * key order and JSON formatting quirks. Pure / synchronous.
 */
export function canonicalTargetState(input: TargetStateDigestInput): string {
  const entries: Array<[string, string]> = [
    ["agentHandle", String(input.agentHandle ?? "")],
    ["agentHandleCustomized", String(input.agentHandleCustomized ?? false)],
    ["agentUpdatedAt", normalizeTimestamp(input.agentUpdatedAt)],
    ["profileName", String(input.profileName ?? "")],
    ["profileUpdatedAt", normalizeTimestamp(input.profileUpdatedAt)],
  ];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("|");
}

/** SHA-256 hex of `canonicalTargetState(input)`. Pure / synchronous. */
export function computeTargetStateDigestFromState(
  input: TargetStateDigestInput,
): string {
  return createHash("sha256").update(canonicalTargetState(input)).digest("hex");
}

/**
 * Read the target identity surface for `agentId` inside the caller's
 * transaction. Returns the raw fields; pass to
 * `computeTargetStateDigestFromState` for the hex digest, or use
 * `computeTargetStateDigestInTx` for both at once.
 */
export async function readTargetStateForDigestInTx(
  tx: ProfileMigrationTx,
  agentId: string,
): Promise<TargetStateDigestInput> {
  const [agentRow] = await tx
    .select({
      handle: agents.handle,
      handleCustomized: agents.handleCustomized,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const [profileRow] = await tx
    .select({ name: profiles.name, updatedAt: profiles.updatedAt })
    .from(profiles)
    .where(eq(profiles.agentId, agentId))
    .limit(1);

  return {
    profileName: profileRow?.name ?? null,
    profileUpdatedAt: profileRow?.updatedAt ?? null,
    agentHandle: agentRow?.handle ?? null,
    agentHandleCustomized: agentRow?.handleCustomized ?? null,
    agentUpdatedAt: agentRow?.updatedAt ?? null,
  };
}

/**
 * Compute the target-state digest for `agentId` inside the caller's
 * transaction. The importer snapshots this at dry-run time, binds the
 * plan to it, and recomputes at commit; a mismatch means the target
 * moved and the plan is stale.
 */
export async function computeTargetStateDigestInTx(
  tx: ProfileMigrationTx,
  agentId: string,
): Promise<string> {
  const state = await readTargetStateForDigestInTx(tx, agentId);
  return computeTargetStateDigestFromState(state);
}
