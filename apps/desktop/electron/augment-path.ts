/**
 * D384 Phase 5 — repair the Electron main-process environment so child
 * processes we spawn (relay-hosted stdio MCP servers, CLI tools) behave the
 * way they do in the user's own terminal.
 *
 * THE PROBLEM: a macOS/Linux GUI app launched from Finder/Dock/Spotlight
 * inherits a minimal environment. Two distinct failures fall out:
 *
 *   1. Stripped `PATH` — `~/.maestro/bin`, `/opt/homebrew/bin`, `~/.local/bin`
 *      etc. are missing, so bare commands fail with `spawn <cmd> ENOENT`.
 *   2. Missing toolchain vars — `JAVA_HOME`, `ANDROID_HOME`, `GOPATH`, … are
 *      set in `~/.zshrc` but never reach the app, so a binary that DOES spawn
 *      can't find its runtime (maestro → "Unable to locate a Java Runtime").
 *
 * THE FIX: capture the user's login+interactive shell environment once at
 * startup ($SHELL -lic, sentinel-wrapped, bounded timeout, best-effort):
 *
 *   - `augmentProcessPath()` merges the captured PATH + curated common bin
 *     dirs into `process.env.PATH` (idempotent).
 *   - `loginShellSpawnEnvBase()` returns the captured env for use as the
 *     MCP child-spawn baseline (`spawnEnvBase`) — Claude Desktop / Cursor
 *     parity: local MCP children see the user's real shell environment on
 *     the user's own machine.
 */
import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ENV_START = "__NAUTILO_ENV_START__";
const ENV_END = "__NAUTILO_ENV_END__";

/**
 * Vars that must NOT leak from the shell env into either the main process
 * or MCP children: process-identity / display-server vars owned by Electron,
 * plus shell-function exports (handled separately by value prefix).
 */
const EXCLUDED_VARS = new Set([
  "_",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "DISPLAY",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_ENV",
]);

let captured: Record<string, string> | null | undefined;

/**
 * The user's environment as their login+interactive shell sees it, captured
 * once (memoized) via `$SHELL -lic env`. Sentinel-wrapped so rc-file banner
 * noise can't corrupt the parse; bounded timeout so a broken rc can't hang
 * boot. Returns null on any failure.
 */
function loginShellEnvironment(): Record<string, string> | null {
  if (captured !== undefined) return captured;
  captured = captureLoginShellEnv();
  return captured;
}

function captureLoginShellEnv(): Record<string, string> | null {
  if (process.platform === "win32") return null;
  const shells = shellCandidates();
  const merged: Record<string, string> = {};
  const paths: string[] = [];

  for (const shell of shells) {
    const env = captureOneShellEnv(shell);
    if (!env) continue;
    if (env["PATH"]) paths.push(...env["PATH"].split(path.delimiter).filter(Boolean));
    for (const [key, value] of Object.entries(env)) {
      // First shell wins for conflicting vars, but alternate shells can fill
      // missing toolchain vars. This handles machines where Electron reports
      // SHELL=/bin/bash while the operator's real toolchain exports live in
      // ~/.zshrc (the exact maestro/JAVA_HOME failure).
      if (merged[key] === undefined) merged[key] = value;
    }
  }

  const javaHome = resolveJavaHome(merged);
  if (javaHome) merged["JAVA_HOME"] = javaHome;

  const mergedPath = dedupe([
    ...(merged["PATH"] ?? "").split(path.delimiter).filter(Boolean),
    ...(javaHome ? [path.join(javaHome, "bin")] : []),
    ...paths,
  ]);
  if (mergedPath.length > 0) merged["PATH"] = mergedPath.join(path.delimiter);

  return Object.keys(merged).length > 0 ? merged : null;
}

function shellCandidates(): string[] {
  return dedupe(
    [
      process.env["SHELL"],
      "/bin/zsh",
      "/opt/homebrew/bin/zsh",
      "/bin/bash",
      "/usr/local/bin/bash",
      "/opt/homebrew/bin/bash",
    ].filter((s): s is string => typeof s === "string" && s.length > 0),
  ).filter((shell) => {
    try {
      return fsSync.statSync(shell).isFile();
    } catch {
      return false;
    }
  });
}

function captureOneShellEnv(shell: string): Record<string, string> | null {
  try {
    const script = `printf %s '${ENV_START}'; env; printf %s '${ENV_END}'`;
    const out = execFileSync(shell, ["-lic", script], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
    const start = out.indexOf(ENV_START);
    const end = out.indexOf(ENV_END);
    if (start === -1 || end === -1 || end <= start) return null;
    const raw = out.slice(start + ENV_START.length, end);
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue; // skip malformed / continuation lines
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (EXCLUDED_VARS.has(key)) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      // Skip exported shell functions (security, matches MCP SDK behavior).
      if (value.startsWith("()")) continue;
      env[key] = value;
    }
    return Object.keys(env).length > 0 ? env : null;
  } catch {
    return null;
  }
}

function resolveJavaHome(env: Record<string, string>): string | null {
  const declared = env["JAVA_HOME"];
  if (declared && hasJava(declared)) return declared;

  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/opt/openjdk@17",
    "/usr/local/opt/openjdk@17",
    "/opt/homebrew/opt/openjdk",
    "/usr/local/opt/openjdk",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    path.join(home, "Library", "Java", "JavaVirtualMachines", "openjdk-17.jdk", "Contents", "Home"),
  ];
  for (const candidate of candidates) {
    if (hasJava(candidate)) return candidate;
  }
  return null;
}

function hasJava(javaHome: string): boolean {
  try {
    return fsSync.statSync(path.join(javaHome, "bin", "java")).isFile();
  } catch {
    return false;
  }
}

/**
 * The env baseline for relay-hosted MCP child spawns: the login-shell env
 * (or {} when capture failed — buildSpawnEnv's SDK baseline still applies),
 * with PATH replaced by the merged/augmented PATH so curated fallback dirs
 * are included even when shell capture failed.
 */
export function loginShellSpawnEnvBase(): Record<string, string> {
  const env = { ...(loginShellEnvironment() ?? {}) };
  const mergedPath = buildMergedPath();
  if (mergedPath.length > 0) env["PATH"] = mergedPath;
  return env;
}

let pathApplied = false;

/**
 * Repair `process.env.PATH` for this (Electron main) process. Idempotent —
 * safe to call more than once; only the first call does work. Returns the
 * number of directories added (0 if nothing changed / skipped).
 */
export function augmentProcessPath(): number {
  if (pathApplied) return 0;
  pathApplied = true;
  if (process.platform === "win32") return 0;

  const before = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const merged = buildMergedPath().split(path.delimiter).filter(Boolean);
  if (merged.length === 0) return 0;
  process.env["PATH"] = merged.join(path.delimiter);
  return Math.max(0, merged.length - before.length);
}

/** Login-shell PATH + curated existing bin dirs + current PATH, deduped. */
function buildMergedPath(): string {
  const shellPath = (loginShellEnvironment()?.["PATH"] ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const current = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  return dedupe([...shellPath, ...curatedBinDirs(), ...current]).join(path.delimiter);
}

/** Common bin dirs that exist on disk (fallback + belt-and-suspenders). */
function curatedBinDirs(): string[] {
  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/homebrew/opt/openjdk@17/bin",
    "/opt/homebrew/opt/openjdk/bin",
    "/usr/local/bin",
    "/usr/local/opt/openjdk@17/bin",
    "/usr/local/opt/openjdk/bin",
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".maestro", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".deno", "bin"),
  ];
  return candidates.filter((dir) => {
    try {
      return fsSync.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
