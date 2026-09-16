/**
 * One-shot helper that migrates a legacy `~/.nautilo/profiles/<name>.env`
 * bootstrap-token line into the new `~/.nautilo/bootstrap-tokens/<name>`
 * file location (M091 Phase 6).
 *
 * Invoked by `nautilo doctor migrate-config`. It is NOT called from
 * `resolveTransport` — runtime reads only hit the new location, and the
 * doctor command is the single supported migration entry point.
 */

import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { bootstrapTokenPath, writeBootstrapToken } from "./bootstrap-tokens.ts";

/** Same line shape previously used in `resolveTransport` for legacy `NAUTILO_BOOTSTRAP_TOKEN` (value may be empty). */
const LEGACY_BOOTSTRAP_TOKEN_RE = /^NAUTILO_BOOTSTRAP_TOKEN=(.*)$/m;

export interface BootstrapTokenMigrationResult {
  migrated: boolean;
  tokenLength?: number;
  backupPath?: string;
  legacyArchived?: boolean;
  reason?:
    | "no-legacy-file"
    | "no-bootstrap-token-line"
    | "empty-bootstrap-token-line"
    | "new-location-already-populated";
}

function legacyProfileEnvPath(home: string, profileName: string): string {
  return join(home, ".nautilo", "profiles", `${profileName}.env`);
}

/** Phase 4 / config-guard shape: `YYYYMMDDTHHMMSSZ`. */
function m091IsoCompactStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function migrateProfileEnvBootstrapTokenIfPresent(
  profileName: string,
  opts?: { home?: string; now?: Date },
): BootstrapTokenMigrationResult {
  const home = opts?.home ?? process.env["HOME"] ?? "";
  const legacyPath = legacyProfileEnvPath(home, profileName);
  const newPath = bootstrapTokenPath(profileName, home);
  const now = opts?.now ?? new Date();

  if (existsSync(newPath)) {
    if (existsSync(legacyPath)) {
      const backupPath = `${legacyPath}.bak-m091-${m091IsoCompactStamp(now)}`;
      renameSync(legacyPath, backupPath);
      chmodSync(backupPath, 0o600);
      process.stderr.write(
        `[m091] Archived legacy profile env (bootstrap token already at ~/.nautilo/bootstrap-tokens/${profileName}). Backup: ${backupPath}\n`,
      );
      return {
        migrated: false,
        reason: "new-location-already-populated",
        legacyArchived: true,
        backupPath,
      };
    }
    return { migrated: false, reason: "new-location-already-populated" };
  }

  if (!existsSync(legacyPath)) {
    return { migrated: false, reason: "no-legacy-file" };
  }

  const envText = readFileSync(legacyPath, "utf8");
  const tokenMatch = envText.match(LEGACY_BOOTSTRAP_TOKEN_RE);
  if (!tokenMatch) {
    return { migrated: false, reason: "no-bootstrap-token-line" };
  }
  const token = tokenMatch[1]?.trim() ?? "";
  if (!token) {
    return { migrated: false, reason: "empty-bootstrap-token-line" };
  }

  writeBootstrapToken(profileName, token, { home });
  const backupPath = `${legacyPath}.bak-m091-${m091IsoCompactStamp(now)}`;
  renameSync(legacyPath, backupPath);
  chmodSync(backupPath, 0o600);
  process.stderr.write(
    `[m091] Migrated bootstrap token: ~/.nautilo/profiles/${profileName}.env → ~/.nautilo/bootstrap-tokens/${profileName} (one-time; legacy backed up)\n`,
  );
  return { migrated: true, tokenLength: token.length, backupPath };
}

export interface ProfileEnvSweepEntry {
  profileName: string;
  result: BootstrapTokenMigrationResult;
}

/**
 * Sweep every `~/.nautilo/profiles/*.env` file and run the bootstrap-token
 * migration for each. Idempotent. Returns one entry per discovered legacy
 * file. Missing profiles directory → empty array (no-op).
 *
 * Used by `nautilo doctor migrate-config` to retire `<name>.env` files in one
 * pass alongside the operator-secrets / per-instance work.
 */
export function sweepLegacyProfileEnvBootstrapTokens(
  opts?: { home?: string; now?: Date },
): ProfileEnvSweepEntry[] {
  const home = opts?.home ?? process.env["HOME"] ?? "";
  const profilesDir = join(home, ".nautilo", "profiles");
  if (!existsSync(profilesDir)) return [];

  const entries: ProfileEnvSweepEntry[] = [];
  for (const name of readdirSync(profilesDir)) {
    if (!name.endsWith(".env")) continue;
    if (name.startsWith(".")) continue; // skip dotfiles like `.active`
    const full = join(profilesDir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const profileName = name.slice(0, -".env".length);
    if (profileName.length === 0) continue;
    const result = migrateProfileEnvBootstrapTokenIfPresent(profileName, {
      home,
      ...(opts?.now ? { now: opts.now } : {}),
    });
    entries.push({ profileName, result });
  }
  return entries;
}
