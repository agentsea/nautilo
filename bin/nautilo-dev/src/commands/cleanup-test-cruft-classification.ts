/**
 * D266 Wave 2 — pure identity classification for `cleanup-test-cruft`.
 *
 * Extracted so the destructive selection logic is exhaustively unit-testable
 * without a live Postgres. The classifier separates candidate users into the
 * identity classes that drive cleanup refusals / overrides:
 *
 *   - `bootstrap-seed`           — the real `seedDefaultOwner` placeholder.
 *   - `half-redeemed`             — M105 in-flight claim (no credentials,
 *                                   external_id set). Refusal by default.
 *   - `unknown-credentialless`    — no credentials, no external_id, but NOT
 *                                   the seed owner. Refusal by default.
 *   - `ordinary-authenticated`    — has credentials. Automatic candidate.
 *
 * Known fixture handle patterns (see `bucketUserHandle` in
 * `cleanup-test-cruft.ts`) are REPORTING-ONLY here. They never independently
 * authorize deletion and never participate in identity classification — a
 * credentialless fixture is still a refusal until an explicit UUID override
 * says otherwise.
 *
 * The real `seedDefaultOwner` shape is grounded in
 * `packages/db/src/utils/seed-default-owner.ts`: a fresh install inserts
 * `{ name: "user", email: "owner@example.com" }` with no credentials and no
 * external_id, and the runtime deterministically picks the OLDEST user when
 * the table is non-empty. We mirror that exactly: the seed placeholder is the
 * oldest user whose `name`/`email` match the seeded values, with no
 * credentials and no external_id. We deliberately do NOT key it by handle —
 * the handle is derived later by `deriveUniqueHandle` and is absent on a
 * fresh install.
 */

/** Seeded name used by `seedDefaultOwner`. */
export const SEED_DEFAULT_OWNER_NAME = "user";
/** Seeded email used by `seedDefaultOwner`. */
export const SEED_DEFAULT_OWNER_EMAIL = "owner@example.com";

/**
 * Minimal user row projected for classification. Callers populate this from
 * the `users` table plus a `hasCredentials` flag derived from the
 * `credentials` join.
 */
export interface CleanupUserRecord {
  readonly id: string;
  readonly handle: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly externalId: string | null;
  readonly hasCredentials: boolean;
  readonly createdAt: Date;
}

export type UserIdentityClass =
  | "bootstrap-seed"
  | "half-redeemed"
  | "unknown-credentialless"
  | "ordinary-authenticated";

/**
 * Deterministic "oldest user" pick, mirroring `seedDefaultOwner`'s
 * `ORDER BY created_at ASC LIMIT 1`. Ties resolve to the first encountered
 * row so the result is stable for a given input ordering (the runtime query
 * is `created_at NULLS LAST`, but cleanup projects a non-null `createdAt`).
 */
export function findOldestUserId(
  rows: readonly CleanupUserRecord[],
): string | null {
  if (rows.length === 0) return null;
  let oldest = rows[0]!;
  for (const r of rows) {
    if (r.createdAt < oldest.createdAt) oldest = r;
  }
  return oldest.id;
}

/**
 * Does this row match the actual `seedDefaultOwner` placeholder shape?
 * Requires the oldest position — a credentialless, external-id-less row that
 * is NOT the oldest user is `unknown-credentialless`, not the seed.
 */
export function isSeedDefaultOwnerShape(
  user: CleanupUserRecord,
  isOldest: boolean,
): boolean {
  return (
    isOldest &&
    user.name === SEED_DEFAULT_OWNER_NAME &&
    user.email === SEED_DEFAULT_OWNER_EMAIL &&
    user.externalId === null &&
    !user.hasCredentials
  );
}

/**
 * Classify a single user row. Pure: given the row and whether it is the
 * oldest user, returns its identity class. Order matters — the seed shape
 * is checked before the generic credentialless branches because the seed is
 * a strict subset of "no credentials + no external_id".
 */
export function classifyUserIdentity(
  user: CleanupUserRecord,
  isOldest: boolean,
): UserIdentityClass {
  if (isSeedDefaultOwnerShape(user, isOldest)) return "bootstrap-seed";
  if (!user.hasCredentials && user.externalId !== null) return "half-redeemed";
  if (!user.hasCredentials && user.externalId === null) {
    return "unknown-credentialless";
  }
  return "ordinary-authenticated";
}

/**
 * Classify every user in a set. The oldest user is computed from the full set
 * so `bootstrap-seed` is only assigned to the single oldest row that matches
 * the seed shape. Returns a map of user id → identity class.
 */
export function classifyAllUsers(
  rows: readonly CleanupUserRecord[],
): Map<string, UserIdentityClass> {
  const oldestId = findOldestUserId(rows);
  const out = new Map<string, UserIdentityClass>();
  for (const r of rows) {
    out.set(r.id, classifyUserIdentity(r, r.id === oldestId));
  }
  return out;
}

/**
 * Whether an identity class is a "protected refusal" — i.e. the user is NOT
 * an automatic delete candidate and requires an explicit UUID override to
 * be removed. `bootstrap-seed` is NEVER overridable; the other two refusals
 * may be permitted by `--allow-fixture-user-ids`.
 */
export function isProtectedRefusalClass(cls: UserIdentityClass): boolean {
  return (
    cls === "bootstrap-seed" ||
    cls === "half-redeemed" ||
    cls === "unknown-credentialless"
  );
}

/** Whether an identity class may be permitted by an explicit UUID override. */
export function isExplicitOverrideEligible(cls: UserIdentityClass): boolean {
  return cls === "half-redeemed" || cls === "unknown-credentialless";
}

/**
 * D266 Wave 3 — canonical plan fingerprint + manifest validation.
 *
 * Pure helpers (no DB, no filesystem) for the cautious manifest-and-plan-hash
 * apply gate. `--plan-json` emits a `planFingerprint` = SHA-256 over the
 * canonical stable representation of the review-relevant current plan. An
 * operator saves that output as a fixture plan and later supplies it with
 * `--fixture-plan <path>` + `--approve-plan <sha256>` to authorize deletion
 * of protected credentialless / half-redeemed candidates.
 *
 * The fingerprint is stable for semantically identical DB state and changes
 * when a reviewed deletion target, protected identity, keep set, deletion
 * cap, or override set changes. Volatile / cosmetic fields (warnings text,
 * preserved-agent message tallies, orphan footprint rollups) are excluded
 * so an identical review surface yields an identical hash.
 */

import { createHash, type Hash } from "node:crypto";

const FINGERPRINT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Canonical keep-set entry projected into the fingerprint. `createdAt` is
 * the ISO string the plan emits (stable for identical DB rows).
 */
export interface FingerprintKeepEntry {
  readonly id: string;
  readonly handle: string | null;
  readonly name: string | null;
  readonly createdAt: string;
}

/** Canonical candidate entry projected into the fingerprint. */
export interface FingerprintCandidateEntry {
  readonly id: string;
  readonly identityClass: UserIdentityClass;
}

/**
 * The review-relevant plan surface that feeds the fingerprint. This is the
 * DB-state-derived surface ONLY — it deliberately excludes any field that
 * depends on the operator's `--allow-fixture-user-ids` choice (e.g. the
 * explicit-override split), so the fingerprint is stable for semantically
 * identical DB state and varies only when a reviewed deletion target,
 * protected identity, keep set, deletion cap, or override-eligible set
 * changes. `protectedIdentities` is the exact-UUID override-eligible set
 * (credentialless / half-redeemed); bootstrap-seed is never eligible and
 * never appears there. Builders sort semantically; the helpers re-sort
 * defensively.
 */
export interface CanonicalPlanFingerprintInput {
  readonly command: string;
  readonly keepSet: readonly FingerprintKeepEntry[];
  readonly deletionCap: number;
  readonly automaticCandidates: readonly FingerprintCandidateEntry[];
  /** Full protected set (bootstrap-seed + credentialless + half-redeemed). */
  readonly protectedRefusals: readonly FingerprintCandidateEntry[];
  /** Override-eligible subset (credentialless + half-redeemed), exact UUIDs. */
  readonly protectedIdentities: readonly FingerprintCandidateEntry[];
  readonly orphanAgentsToDelete: readonly { id: string; handle: string }[];
}

/**
 * Canonicalize an arbitrary value into a stable JSON string: keys sorted
 * recursively, arrays preserved in caller-supplied order (builders sort
 * semantically before hashing). Used only for fingerprint derivation, not
 * for emitting the human-facing plan.
 */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonString((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function sortByKey<T>(arr: readonly T[], key: (t: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Build the canonical object that feeds the fingerprint. Pure and
 * deterministic: arrays are re-sorted by id/handle so caller ordering
 * cannot perturb the hash.
 */
export function buildCanonicalPlanObject(
  input: CanonicalPlanFingerprintInput,
): Record<string, unknown> {
  const keep = sortByKey(input.keepSet, (e) => e.id).map((e) => ({
    id: e.id,
    handle: e.handle,
    name: e.name,
    createdAt: e.createdAt,
  }));
  const autos = sortByKey(input.automaticCandidates, (e) => e.id).map((e) => ({
    id: e.id,
    cls: e.identityClass,
  }));
  const protecteds = sortByKey(input.protectedRefusals, (e) => e.id).map((e) => ({
    id: e.id,
    cls: e.identityClass,
  }));
  const protectedIds = sortByKey(input.protectedIdentities, (e) => e.id).map(
    (e) => ({ id: e.id, cls: e.identityClass }),
  );
  const orphans = sortByKey(input.orphanAgentsToDelete, (e) => e.id).map((e) => ({
    id: e.id,
    handle: e.handle,
  }));
  return {
    command: input.command,
    deletionCap: input.deletionCap,
    keepSet: keep,
    automaticCandidates: autos,
    protectedRefusals: protecteds,
    protectedIdentities: protectedIds,
    orphanAgentsToDelete: orphans,
  };
}

/**
 * Compute the SHA-256 `planFingerprint` for a canonical plan input. Returns
 * a lowercase 64-char hex digest. Pure: identical inputs always hash alike.
 */
export function computePlanFingerprint(
  input: CanonicalPlanFingerprintInput,
): string {
  const canonical = buildCanonicalPlanObject(input);
  const hash: Hash = createHash("sha256");
  hash.update(canonicalJsonString(canonical));
  return hash.digest("hex");
}

/** Structural manifest shape we validate against (a saved `--plan-json`). */
export interface CleanupPlanManifest {
  readonly command: unknown;
  readonly mode?: unknown;
  readonly planFingerprint: unknown;
  readonly deletionCap: unknown;
  readonly keepSet?: unknown;
  readonly allowFixtureUserIds?: unknown;
  readonly candidates?: unknown;
  readonly protectedIdentities?: unknown;
  readonly orphanAgentsToDelete?: unknown;
  readonly [key: string]: unknown;
}

export interface ManifestValidationOk {
  readonly ok: true;
  readonly manifest: CleanupPlanManifest;
  readonly planFingerprint: string;
  readonly protectedIdentities: string[];
}
export interface ManifestValidationErr {
  readonly ok: false;
  readonly reason: string;
}
export type ManifestValidationResult =
  | ManifestValidationOk
  | ManifestValidationErr;


/**
 * Structurally validate a parsed manifest (a saved `--plan-json` output).
 * Pure: takes the already-parsed object, returns a typed result. Checks:
 *  - `command` is exactly `dev:cleanup-test-cruft`
 *  - `planFingerprint` is a 64-char lowercase hex SHA-256
 *  - `deletionCap` is a positive integer
 *  - `protectedIdentities` is an array of exact UUIDs (no prefixes/wildcards)
 *  - `candidates.protectedRefusals` is an array of `{id, identityClass}` rows
 *
 * Does NOT compare the fingerprint to a current plan — that is the caller's
 * job (the manifest must match the freshly computed current fingerprint).
 */
export function validateCleanupPlanManifest(
  raw: unknown,
  expectedCommand: string,
): ManifestValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "manifest is not a JSON object" };
  }
  const m = raw as CleanupPlanManifest;
  if (m.command !== expectedCommand) {
    return {
      ok: false,
      reason: `manifest command mismatch: expected ${expectedCommand}, got ${String(m.command)}`,
    };
  }
  if (
    typeof m.planFingerprint !== "string" ||
    !SHA256_HEX_RE.test(m.planFingerprint)
  ) {
    return {
      ok: false,
      reason:
        "manifest planFingerprint missing or not a 64-char lowercase hex SHA-256",
    };
  }
  const cap = Number(m.deletionCap);
  if (!Number.isInteger(cap) || cap < 1) {
    return {
      ok: false,
      reason: "manifest deletionCap missing or not a positive integer",
    };
  }
  let protectedIdentities: string[];
  if (Array.isArray(m.protectedIdentities)) {
    const rawIds = m.protectedIdentities as readonly unknown[];
    if (
      !rawIds.every(
        (v) => typeof v === "string" && FINGERPRINT_UUID_RE.test(v),
      )
    ) {
      return {
        ok: false,
        reason:
          "manifest protectedIdentities must be an array of exact UUIDs (no prefixes / wildcards)",
      };
    }
    protectedIdentities = rawIds as string[];
  } else {
    protectedIdentities = [];
  }
  if (m.candidates !== undefined) {
    if (m.candidates === null || typeof m.candidates !== "object" || Array.isArray(m.candidates)) {
      return { ok: false, reason: "manifest candidates is not a JSON object" };
    }
    const candidatesRec = m.candidates as Record<string, unknown>;
    const pr = candidatesRec["protectedRefusals"];
    if (pr !== undefined) {
      if (!Array.isArray(pr)) {
        return {
          ok: false,
          reason: "manifest candidates.protectedRefusals is not an array",
        };
      }
      for (const entry of pr) {
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>)["id"] !== "string"
        ) {
          return {
            ok: false,
            reason:
              "manifest candidates.protectedRefusals entries must be {id: string, ...}",
          };
        }
      }
    }
  }
  return {
    ok: true,
    manifest: m,
    planFingerprint: m.planFingerprint,
    protectedIdentities,
  };
}

/** True iff `v` is a 64-char lowercase hex SHA-256 string. */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && SHA256_HEX_RE.test(v);
}

/** True iff `v` is an exact UUID (no prefixes / wildcards). */
export function isExactUuid(v: unknown): v is string {
  return typeof v === "string" && FINGERPRINT_UUID_RE.test(v);
}
