import { basename, dirname, join } from "node:path";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { appendAuditEntrySync } from "./audit-log";
import { isForbiddenInInstanceEnv } from "./mode-registry";
import { migrateSetupTomlToDeployToml } from "./setup-toml-migration";

function m091IsoCompactStamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function envKeyFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const withoutExport = trimmed.replace(/^export\s+/i, "");
  const eq = withoutExport.indexOf("=");
  if (eq === -1) return null;
  return withoutExport.slice(0, eq).trim();
}

export interface RetiredIdentityEnvCleanupResult {
  removedKeys: string[];
  backupPath: string | null;
}

/**
 * One-time M091: `config.env` → `instance.env` in the given Nautilo root.
 * Idempotent. Appends a config-audit row on rename.
 */
export function migrateConfigEnvToInstanceEnv(
  rootDir: string,
): { renamed: boolean; from: string; to: string } | null {
  const instanceEnv = join(rootDir, "instance.env");
  const configEnv = join(rootDir, "config.env");

  if (existsSync(instanceEnv)) {
    return null;
  }
  if (!existsSync(configEnv)) {
    return null;
  }

  renameSync(configEnv, instanceEnv);
  const from = configEnv;
  const to = instanceEnv;
  console.error(
    `[m091] Renamed ${from} → ${to} (one-time migration; backup not needed — file content unchanged)`,
  );

  try {
    appendAuditEntrySync(join(rootDir, "config-audit.jsonl"), {
      ts: new Date().toISOString(),
      actor: "cli",
      reason: "m091.rename: config.env→instance.env",
      ops: [{ type: "set", key: "__m091_rename__" }],
      result: "applied",
    });
  } catch {
    /* best effort — audit must not block boot */
  }

  return { renamed: true, from, to };
}

/**
 * M091 — strip keys that must not live in instance.env (setup-time prefixes,
 * retired identity keys, AUTH_MODE). Writes `.bak-m091-stale-keys-<ts>` when
 * anything is removed, plus a config-audit row.
 */
export function stripForbiddenKeysFromInstanceEnv(
  path: string,
  opts: { now?: Date; auditLogPath?: string } = {},
): RetiredIdentityEnvCleanupResult {
  if (!existsSync(path)) return { removedKeys: [], backupPath: null };

  const lines = readFileSync(path, "utf8").split(/(?<=\n)/);
  const removed = new Set<string>();
  const kept = lines.filter((line) => {
    const key = envKeyFromLine(line);
    if (key && isForbiddenInInstanceEnv(key)) {
      removed.add(key);
      return false;
    }
    return true;
  });

  if (removed.size === 0) return { removedKeys: [], backupPath: null };

  const backupPath = join(
    dirname(path),
    `${basename(path)}.bak-m091-stale-keys-${m091IsoCompactStamp(opts.now)}`,
  );
  copyFileSync(path, backupPath);
  try {
    chmodSync(backupPath, 0o600);
  } catch {
    /* Windows may not support chmod */
  }
  writeFileSync(path, kept.join(""), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }

  const auditPath = opts.auditLogPath ?? resolveAuditLogPath();
  try {
    appendAuditEntrySync(auditPath, {
      ts: new Date().toISOString(),
      actor: "cli",
      reason: `m091.strip: ${removed.size} forbidden keys removed`,
      ops: Array.from(removed)
        .sort()
        .map((key) => ({ type: "remove" as const, key })),
      result: "applied",
    });
  } catch {
    /* best effort */
  }

  return { removedKeys: Array.from(removed).sort(), backupPath };
}

/** Back-compat alias for `stripForbiddenKeysFromInstanceEnv` (M091). */
export function stripRetiredIdentityEnvVars(
  path: string,
  opts: { now?: Date; auditLogPath?: string } = {},
): RetiredIdentityEnvCleanupResult {
  return stripForbiddenKeysFromInstanceEnv(path, opts);
}

/**
 * Resolve the path to the env file that stores API keys and provider config.
 *
 * Default: `~/.nautilo/instance.env` (M091; renamed from `config.env`)
 * Override: `NAUTILO_DOTENV_PATH` env var
 *
 * Backward compat: if `instance.env` doesn't exist but `cwd/.env`
 * does, copy it to the new location and warn. Creates the file (empty, 0600)
 * if it doesn't exist anywhere.
 */
export function resolveDotenvPath(): string {
  const override = process.env["NAUTILO_DOTENV_PATH"]?.trim();
  if (override) {
    stripForbiddenKeysFromInstanceEnv(override);
    try {
      migrateSetupTomlToDeployToml(resolveNautiloRootDir());
    } catch (err) {
      console.error(
        "[m091] setup.toml migration error:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return override;
  }

  const nautiloRoot = resolveNautiloRootDir();
  migrateConfigEnvToInstanceEnv(nautiloRoot);

  // Compose deployments migrate the authority into this narrow directory and
  // leave `<root>/instance.env` as a compatibility symlink. Prefer the real
  // target whenever it exists so atomic rename never replaces that symlink or
  // creates a second writable copy.
  const runtimeConfigPath = join(nautiloRoot, "runtime-config", "instance.env");
  const newPath = existsSync(runtimeConfigPath)
    ? runtimeConfigPath
    : join(nautiloRoot, "instance.env");
  const legacyPath = join(process.cwd(), ".env");

  if (!existsSync(newPath)) {
    mkdirSync(dirname(newPath), { recursive: true });

    if (existsSync(legacyPath)) {
      copyFileSync(legacyPath, newPath);
      try {
        chmodSync(newPath, 0o600);
      } catch {
        /* Windows */
      }
      console.warn(
        `[config] Migrated ${legacyPath} → ${newPath}\n` +
          `  Your API keys now live in ~/.nautilo/instance.env.\n` +
          `  The old .env in the repo root is no longer used.`,
      );
    } else {
      writeFileSync(
        newPath,
        "# Nautilo configuration — API keys and provider settings\n",
        { mode: 0o600 },
      );
    }
  }

  stripForbiddenKeysFromInstanceEnv(newPath);
  try {
    migrateSetupTomlToDeployToml(nautiloRoot);
  } catch (err) {
    console.error(
      "[m091] setup.toml migration error:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return newPath;
}

export function resolveSnapshotDir(): string {
  return join(resolveConfigAuthorityDir(), "config-snapshots");
}

export function resolveAuditLogPath(): string {
  return join(resolveConfigAuthorityDir(), "config-audit.jsonl");
}

/**
 * D445 Phase 0 — snapshots and audit must live beside an explicit canonical
 * dotenv target. In compose that parent is the narrowly mounted
 * `runtime-config/` directory, so the full transaction record survives
 * container recreation with `instance.env`.
 *
 * Local/dev callers without `NAUTILO_DOTENV_PATH` retain the historical
 * `~/.nautilo${suffix}` authority and layout.
 */
export function resolveConfigAuthorityDir(): string {
  const override = process.env["NAUTILO_DOTENV_PATH"]?.trim();
  if (override) return dirname(override);
  const root = resolveNautiloRootDir();
  const runtimeConfigDir = join(root, "runtime-config");
  return existsSync(join(runtimeConfigDir, "instance.env"))
    ? runtimeConfigDir
    : root;
}

export function resolveHealthCheckUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveInstance(env).server.url.replace(/\/$/, "");
  return `${base}/health`;
}
