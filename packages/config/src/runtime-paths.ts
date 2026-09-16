import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { fromRuntimeConfig, type NautiloConfig } from "./config";
import { resolveNautiloStorageRoot } from "./instance-id";

/**
 * Resolved absolute paths for every Nautilo storage zone.
 *
 * Zones (D049 artifact-centric pivot):
 * - `home/*` — permanent user-visible work product
 *   (workspace, research, notes, exports, transcripts, logs)
 * - `scratch/` — ephemeral tool working space (sibling of `home/`, not
 *   child)
 * - `data/*` — app-internal structured data (db, embeddings, caches)
 * - `vault/` — future encrypted credential store
 *
 * The pre-pivot D049 (Apr 17 morning) also defined an `inbox/` zone for
 * async user uploads. That zone was removed in the pivot — no real
 * consumer existed. Existing inbox contents remain untouched; they are
 * not part of the managed runtime paths.
 *
 * Relay adapters (v8 §9.1) only ever receive a subset of these — never
 * `dataDir`, `embeddingsDir`, or `vaultDir`. Structural isolation,
 * not policy.
 */
export interface NautiloRuntimePaths {
  rootDir: string;
  certsDir: string;
  sessionStateFile: string;

  // home zone — permanent user-visible work product
  homeRootDir: string;
  workspaceDir: string;
  researchDir: string;
  notesDir: string;
  exportsDir: string;
  logsDir: string;
  transcriptsDir: string;

  // scratch zone — ephemeral tool space (sibling of home/, not child)
  scratchDir: string;

  // data zone — app-internal structured storage
  dataDir: string;
  dbDataDir: string;
  embeddingsDir: string;
  voiceCacheDir: string;
  audioCacheDir: string;

  // vault zone — future encrypted credential store
  vaultDir: string;
}

interface ResolveRuntimePathsOptions {
  config?: NautiloConfig;
  env?: NodeJS.ProcessEnv;
  userHomeDir?: string;
}

function expandTildePrefix(pathValue: string, userHomeDir: string): string {
  const trimmed = pathValue.trim();
  if (trimmed === "~") return userHomeDir;
  if (trimmed.startsWith("~/")) {
    return join(userHomeDir, trimmed.slice(2));
  }
  return trimmed;
}

function resolveUnderRoot(
  pathValue: string,
  rootDir: string,
  userHomeDir: string,
): string {
  const expanded = expandTildePrefix(pathValue, userHomeDir);
  if (isAbsolute(expanded)) {
    return normalize(expanded);
  }
  return normalize(join(rootDir, expanded));
}

/**
 * Instance selector: trimmed `NAUTILO_INSTANCE_ID` (empty → default `~/.nautilo`).
 * Non-empty ids must pass {@link validateNautiloInstanceIdValue} and use `~/.nautilo-${id}/`.
 */
export function parseNautiloInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  return (env["NAUTILO_INSTANCE_ID"] ?? "").trim();
}

/** Non-empty trimmed string from env, or undefined. */
function envPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Effective user home for layout resolution.
 * Reads `env` (defaults to `process.env`) so tests can pass an isolated
 * env object, and prefers `HOME` / `USERPROFILE` over `homedir()` so
 * runtime updates to those variables are visible (some runtimes cache
 * `homedir()` per process).
 */
/** Effective user home for layout and sibling scans (tests may override via `HOME`). */
export function userHomeDirFromEnv(env: NodeJS.ProcessEnv): string {
  const win = process.platform === "win32";
  const fromEnv = win
    ? envPath(env, "USERPROFILE") ?? envPath(env, "HOME")
    : envPath(env, "HOME") ?? envPath(env, "USERPROFILE");
  if (fromEnv) return normalize(fromEnv);
  return homedir();
}

/**
 * Resolve nautilo's top-level runtime root.
 *
 * Default: `${userHome}/.nautilo` where `userHome` is `options.userHomeDir`,
 * `$HOME` / `$USERPROFILE` (from `env`), or the OS fallback from `homedir()`.
 *
 * `NAUTILO_HOME` is intentionally not supported — use `NAUTILO_INSTANCE_ID`
 * and the standard layout under the user home instead.
 */
export function resolveNautiloRootDir(
  options: Pick<ResolveRuntimePathsOptions, "env" | "userHomeDir"> = {},
): string {
  const env = options.env ?? process.env;
  const userHomeDir = options.userHomeDir ?? userHomeDirFromEnv(env);
  const instanceId = parseNautiloInstanceId(env);
  return resolveNautiloStorageRoot(userHomeDir, instanceId);
}

export function resolveNautiloRuntimePaths(
  options: ResolveRuntimePathsOptions = {},
): NautiloRuntimePaths {
  const config = options.config ?? fromRuntimeConfig();
  const env = options.env ?? process.env;
  const userHomeDir = options.userHomeDir ?? userHomeDirFromEnv(env);
  const rootDir = resolveNautiloRootDir({ env, userHomeDir });
  const r = (value: string) => resolveUnderRoot(value, rootDir, userHomeDir);

  return {
    rootDir,
    certsDir: join(rootDir, "certs"),
    sessionStateFile: r(config.nautilo_session_state_file),

    // home zone
    homeRootDir: r(config.nautilo_home_root_dir),
    workspaceDir: r(config.nautilo_home_workspace_dir),
    researchDir: r(config.nautilo_home_research_dir),
    notesDir: r(config.nautilo_home_notes_dir),
    exportsDir: r(config.nautilo_home_exports_dir),
    logsDir: r(config.nautilo_home_logs_dir),
    transcriptsDir: r(config.nautilo_home_transcripts_dir),

    // scratch zone — sibling of home, NOT home/scratch
    scratchDir: r(config.nautilo_scratch_dir),

    // data zone
    dataDir: r(config.nautilo_data_dir),
    dbDataDir: r(config.nautilo_db_data_dir),
    embeddingsDir: r(config.nautilo_embeddings_dir),
    voiceCacheDir: r(config.nautilo_voice_cache_dir),
    audioCacheDir: r(config.nautilo_audio_cache_dir),

    // vault zone
    vaultDir: r(config.nautilo_vault_dir),
  };
}
