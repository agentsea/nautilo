import { join } from "node:path";
import { resolveNautiloRootDir } from "@nautilo/config";
import { resolveDotenvPath as canonicalResolveDotenvPath } from "@nautilo/config-guard";

const DEV_SNAPSHOTS_DIR = "dev-snapshots";

export function resolveSnapshotsDir(): string {
  return join(resolveNautiloRootDir(), DEV_SNAPSHOTS_DIR);
}

export function resolveSnapshotDir(name: string): string {
  return join(resolveSnapshotsDir(), name);
}

export function resolveNautiloHome(): string {
  return resolveNautiloRootDir();
}

/**
 * Delegates to `@nautilo/config-guard`'s canonical resolver so the dev
 * CLI sees the same file (post-M091: `~/.nautilo${suffix}/instance.env`)
 * as the server. This module previously hard-coded the pre-M091 name
 * `config.env`, which made every dev CLI command that uses
 * `loadConfigEnvIntoProcess` silently load nothing on M091+ installs —
 * surfaced first by M107's `migrate-to-username-identity` because it's
 * the only command that needs Logto env vars without the server pre-
 * running.
 */
export function resolveDotenvPath(): string {
  const override = process.env["NAUTILO_DOTENV_PATH"]?.trim();
  if (override) return override;
  return canonicalResolveDotenvPath();
}

/** Safety backup location for config.env during clean/restore. */
export function resolveEnvBackupPath(): string {
  return join(resolveSnapshotsDir(), "_env-safety-backup");
}
