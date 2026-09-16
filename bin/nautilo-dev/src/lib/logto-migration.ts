/**
 * M053: shared types + helpers for the migrate-to-logto /
 * migrate-from-logto / verify-user-link commands.
 *
 * This module is dependency-injection-shaped so the commands can be
 * unit-tested without a real Postgres handle or a real Logto endpoint.
 * Production code constructs the real `MigrationDeps` once at the entry
 * point (`createDirectDb(1)` + `getLogtoAdminClient()` + `chmod 600`
 * file writer); tests pass an in-memory `MigrationDeps` that records
 * calls and returns canned data.
 */
import { LOGTO_REQUIRED_KEYS } from "@nautilo/config-guard";

/** Subset of `users` columns the migration tool touches. */
export interface MigrationUser {
  id: string;
  name: string;
  email: string | null;
  handle: string | null;
  externalId: string | null;
}

/** Logto user shape echoed back by `findUserByEmailOrUsername` + `getUser`. */
export interface LogtoUser {
  id: string;
  isSuspended: boolean;
  primaryEmail: string | null;
  username: string | null;
}

/** Logto Management API surface the commands reach for. */
export interface LogtoAdmin {
  getAccessToken(audience?: string): Promise<string>;
  createUser(args: {
    username: string;
    primaryEmail?: string;
    name?: string;
    password?: string;
  }): Promise<{ id: string }>;
  /** M053 — set / rotate a user's password (used for re-attach reset). */
  setUserPassword(userId: string, password: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  findUserByEmailOrUsername(
    email: string | null | undefined,
    username: string | null | undefined,
  ): Promise<LogtoUser | null>;
  getUser(userId: string): Promise<LogtoUser | null>;
  /**
   * M107 — `PATCH /api/users/{id}`. Returns HTTP status (caller handles 409).
   */
  patchUser(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<number>;
}

/** Postgres surface — kept narrow so the fake doesn't reproduce drizzle. */
export interface MigrationDb {
  /**
   * Select local PIN-mode users (`server IS NULL`). When
   * `onlyMissingExternalId` is true (migrate-to-logto), filters
   * to `external_id IS NULL`; when false (migrate-from-logto), filters
   * to `external_id IS NOT NULL` (rows with a link to clear).
   */
  listLocalUsers(
    onlyMissingExternalId: boolean,
  ): Promise<MigrationUser[]>;
  /** UPDATE users SET external_id = $sub WHERE id = $userId. */
  setExternalId(userId: string, externalId: string): Promise<void>;
  /** UPDATE users SET external_id = NULL WHERE id IN (...). */
  clearAllExternalIds(): Promise<number>;
  /** SELECT for verify-user-link: row by email (server IS NULL). */
  findLocalUserByEmail(email: string): Promise<MigrationUser | null>;
  /**
   * D104 — all local rows (`server IS NULL`) with exact email (may be
   * empty, one, or many — caller resolves ambiguity).
   */
  findLocalUsersByEmail(email: string): Promise<MigrationUser[]>;
  /**
   * D104 — all local rows with exact handle (may be empty / one / many).
   */
  findLocalUsersByHandle(handle: string): Promise<MigrationUser[]>;
  /** D104 — local row by primary key when `server IS NULL`. */
  findLocalUserById(userId: string): Promise<MigrationUser | null>;
  /** D104 break-glass: mark mandatory password rotation after operator reset. */
  markOperatorPasswordResetRequired(userId: string): Promise<void>;
  /** Pre-flight: confirm `users.external_id` column exists (M051 marker). */
  hasExternalIdColumn(): Promise<boolean>;
  /** Pre-flight: confirm D104 account-security metadata table exists. */
  hasLogtoAccountSecurityTable(): Promise<boolean>;
  /** D104 migration path: require password rotation after temp password issuance. */
  markMigrationTempPasswordRequired(userId: string): Promise<void>;
  /**
   * M107 — set `users.handle` when NULL (idempotent back-fill from chosen
   * Logto username).
   */
  backfillUserHandleIfNull(userId: string, handle: string): Promise<void>;
  /**
   * M107 — local rows (`server IS NULL`) whose normalized handle appears
   * on more than one row (case-insensitive). Used for `--apply` pre-flight.
   */
  listUsersInHandleCollisionGroups(): Promise<MigrationUser[]>;
  /** Release the underlying connection. Must be safe to call once. */
  end(): Promise<void>;
}

/** A single block in `~/.nautilo/claim-invitations.txt`. */
export interface ClaimInvitation {
  nautiloUserId: string;
  name: string;
  email: string;
  handle: string;
  logtoSub: string;
  /**
   * One-time-use temporary password. NULL means the migration
   * re-attached an already-existing Logto account: that account's
   * existing credentials are intentionally left intact (rotating
   * someone else's Logto password without consent is destructive),
   * and the operator is reminded out of band.
   */
  temporaryPassword: string | null;
}

/** Console + file IO so unit tests can capture output. */
export interface MigrationLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Tabular stdout for `--dry-run`. */
  table(rows: ReadonlyArray<Record<string, unknown>>): void;
}

export function consoleMigrationLogger(): MigrationLogger {
  return {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
    table: (rows) => console.table(rows),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight (config + Logto reachability)
// ---------------------------------------------------------------------------

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string; remediation: string };

/**
 * Pure check over `process.env`: every `LOGTO_*` key from MODE_REGISTRY
 * is present and non-empty. Returns the first miss as a single result
 * (loud-fail without flooding the operator).
 *
 * Intentionally does not consult removed env toggles — the migration
 * tool must run against partially upgraded installs and stay safe when
 * re-run after Logto keys are already live.
 */
export function checkLogtoEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  for (const key of LOGTO_REQUIRED_KEYS) {
    const v = env[key];
    if (!v || v.trim() === "") {
      return {
        ok: false,
        reason: `Missing required env var ${key}`,
        remediation:
          "Run `bun run infra:start` to bring up Logto and seed " +
          "`LOGTO_*` keys, or set them manually in ~/.nautilo/instance.env.",
      };
    }
  }
  return { ok: true };
}

/**
 * Probe Logto's OIDC discovery doc. Pure-ish — fetch is injectable.
 * Returns 200=ok or wraps any failure in a remediation message.
 */
export async function checkLogtoReachable(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const url = `${endpoint.replace(/\/+$/, "")}/oidc/.well-known/openid-configuration`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return {
        ok: false,
        reason: `Logto discovery probe failed: ${res.status}`,
        remediation: `Check that Logto is up at ${endpoint}. Try \`bun run infra:status\`.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `Logto unreachable at ${endpoint}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      remediation: `Try \`bun run infra:start\` to bring up the Logto compose stack.`,
    };
  }
}

/**
 * Verify M2M creds work by minting a Management API token. Catches the
 * "LOGTO_* keys are present but secret rotated" failure mode early,
 * before any DB mutation.
 */
export async function checkM2MCredentials(
  admin: Pick<LogtoAdmin, "getAccessToken">,
): Promise<PreflightResult> {
  try {
    await admin.getAccessToken("https://default.logto.app/api");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `M2M token mint failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      remediation:
        "Re-run `bun run infra:start` so bootstrap-logto refreshes " +
        "LOGTO_M2M_APP_ID / LOGTO_M2M_APP_SECRET in ~/.nautilo/instance.env.",
    };
  }
}

// ---------------------------------------------------------------------------
// Claim-invitations file
// ---------------------------------------------------------------------------

const CLAIM_HEADER = (now: string) =>
  `# Nautilo → Logto migration — claim invitations
# Generated ${now}
#
# Each block below is the credential set for one user. Hand the block
# to the corresponding human OUT OF BAND (1Password / Signal / etc.)
# and tell them:
#   1. Sign in to Nautilo with their email + the temporary password.
#   2. IMMEDIATELY change the password in their Logto profile.
#
# Blocks marked "Logto account already existed" mean migrate-to-logto
# re-attached an existing Logto user (typical re-run-after-rollback).
# Their existing credentials are unchanged — no temporary password is
# minted.
#
# THIS FILE IS chmod 600 AND CONTAINS PLAINTEXT PASSWORDS. Delete it
# (\`rm ~/.nautilo/claim-invitations.txt\`) once every user has signed
# in and rotated.
`;

const SEPARATOR =
  "────────────────────────────────────────────────────────────";

export function renderClaimInvitations(
  claims: ReadonlyArray<ClaimInvitation>,
  now: Date = new Date(),
): string {
  const blocks = claims.map((c) => {
    const credentialLines =
      c.temporaryPassword === null
        ? [`(Logto account already existed — credentials unchanged.)`, ``]
        : [
            `Sign-in identifier: ${c.email} (or username @${c.handle})`,
            `Temporary password: ${c.temporaryPassword}`,
            `  ⚠ Rotate immediately after first sign-in.`,
            ``,
          ];
    return [
      SEPARATOR,
      `${c.name}  <${c.email}>`,
      `Handle: @${c.handle}`,
      `Logto sub: ${c.logtoSub}`,
      ``,
      ...credentialLines,
    ].join("\n");
  });
  return `${CLAIM_HEADER(now.toISOString())}\n${blocks.join("\n")}`;
}
