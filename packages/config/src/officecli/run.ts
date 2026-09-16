// D372 P4 — OfficeCLI managed-binary groundwork.
//
// Thin node-only wrapper for locating and invoking a pinned/provided
// `officecli` binary. This module is intentionally NOT the OOJSON ⇄
// Wafflebase mapper; it only exposes safe, testable helpers for:
//
//   - resolving the binary path (override → OFFICECLI_PATH → PATH lookup)
//   - building the execution env (auto-update gated by
//     OFFICECLI_SKIP_UPDATE=1 per spec §R8)
//   - constructing `--version` / `dump` / `get` argv for a .docx input
//   - running the binary with an injectable execFile so callers can
//     probe a real or stub binary without touching the shell
//
// The actual dump/get JSON parsing + Document mapper lands in a later P4
// task. Vendoring / provisioning / checksum policy for the pinned binary
// is a separate product decision (see DEFERRAL note in the task report).
//
// Relocated from packages/server/src/officecli.ts to @nautilo/config (D396
// Wave 2a) so both @nautilo/agent and @nautilo/server can import the pure
// OfficeCLI core. Node-only subpath — uses node:child_process / node:fs.

import { spawn as spawnCb, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter as pathDelimiter, isAbsolute, join, resolve as pathResolve } from "node:path";
import {
  OFFICECLI_RUNNER_OUTPUT_LIMITS,
  OFFICECLI_STDIO_MAX_BYTES,
  type OfficeCliOutputStage,
} from "./capacity";

// Legacy export for callers that used the hotfix constant before the capacity
// policy existed. The value is defined only in capacity.ts.
export { OFFICECLI_STDIO_MAX_BYTES } from "./capacity";

// ============================================================================
// Path resolution
// ============================================================================

export interface OfficeCliPathInput {
  /** Explicit binary path; wins over env. Empty/whitespace treated as unset. */
  readonly override?: string;
  /** Env map to read OFFICECLI_PATH / PATH from. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Base directory for a relative override / OFFICECLI_PATH. Defaults to cwd. */
  readonly cwd?: string;
}

/**
 * Resolve the officecli binary path.
 *
 * Precedence (first non-empty wins):
 *   1. `input.override`
 *   2. `env.OFFICECLI_PATH`
 *   3. `officecli` found on `env.PATH` (executable bit checked)
 *   4. `null` — caller surfaces a clear "not installed" error
 *
 * Override / OFFICECLI_PATH are returned resolved against `cwd` when
 * relative; PATH lookup returns an absolute candidate. No filesystem check
 * is performed for override / OFFICECLI_PATH — execFile will fail loudly
 * if the configured path does not exist, which is the operator's signal to
 * fix the pin rather than silently fall back.
 */
export function resolveOfficeCliPath(input: OfficeCliPathInput = {}): string | null {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();

  const explicit = normalizeNonEmpty(input.override) ?? normalizeNonEmpty(env["OFFICECLI_PATH"]);
  if (explicit !== null) {
    return isAbsolute(explicit) ? explicit : pathResolve(cwd, explicit);
  }

  const pathEnv = typeof env["PATH"] === "string" ? env["PATH"] : "";
  if (pathEnv.length > 0) {
    for (const dir of pathEnv.split(pathDelimiter)) {
      if (dir.length === 0) continue;
      const candidate = join(dir, "officecli");
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function normalizeNonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Environment
// ============================================================================

export interface OfficeCliEnvOptions {
  /** Base env to layer onto. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Force `OFFICECLI_SKIP_UPDATE=1` (default true). The auto-update
   * background process spawns a child that hits the network and writes
   * to the binary path — never wanted in the server-controlled pipeline.
   */
  readonly skipUpdate?: boolean;
  /**
   * Force `OFFICECLI_NO_AUTO_RESIDENT=1` (default true). CRITICAL for our
   * execFile-per-command model: OfficeCLI's default background resident
   * applies mutations in memory and DEFERS the disk write until an explicit
   * `close`/`save`. Because we spawn a fresh process per command and read the
   * file back immediately after each mutation, a lingering resident means we
   * read STALE (pre-mutation / blank) bytes and persist an empty artifact
   * while reporting success (D396 blank-file bug). Disabling auto-resident
   * makes every invocation self-contained (open→op→save→close in one process),
   * so the on-disk file is always current before we read it. The resident is a
   * warm-latency optimization that is pure downside when each command is its
   * own process; we lose nothing by turning it off here.
   */
  readonly noAutoResident?: boolean;
  /** Overrides applied after the OFFICECLI_* defaults. Undefined deletes. */
  readonly overrides?: Record<string, string | undefined>;
}

/**
 * Build the env for an officecli invocation. Always returns a fresh object;
 * never mutates the input. Defaults to `OFFICECLI_SKIP_UPDATE=1` and
 * `OFFICECLI_NO_AUTO_RESIDENT=1`.
 */
export function buildOfficeCliEnv(options: OfficeCliEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.env ?? process.env;
  const result: NodeJS.ProcessEnv = { ...base };
  const skipUpdate = options.skipUpdate ?? true;
  if (skipUpdate) {
    result["OFFICECLI_SKIP_UPDATE"] = "1";
  } else {
    delete result["OFFICECLI_SKIP_UPDATE"];
  }
  const noAutoResident = options.noAutoResident ?? true;
  if (noAutoResident) {
    result["OFFICECLI_NO_AUTO_RESIDENT"] = "1";
  } else {
    delete result["OFFICECLI_NO_AUTO_RESIDENT"];
  }
  if (options.overrides) {
    for (const [k, v] of Object.entries(options.overrides)) {
      if (v === undefined) {
        delete result[k];
      } else {
        result[k] = v;
      }
    }
  }
  return result;
}

// ============================================================================
// Argv builders
// ============================================================================

export function buildVersionArgv(): string[] {
  return ["--version"];
}

export interface OfficeCliDumpArgvOptions {
  /** Path to the .docx (or .pptx/.xlsx) file to dump. Required. */
  readonly file: string;
  /** DOM subtree path. Defaults to "/" (whole document). */
  readonly path?: string;
  /** Output format. Currently only "batch" is supported by the binary. */
  readonly format?: string;
  /** `--out <file>` — write the batch JSON to a file instead of stdout. */
  readonly outPath?: string;
  /** Emit `--json` envelope (AI-friendly structured output). */
  readonly json?: boolean;
}

/**
 * Build the argv for `officecli dump <file> [path] [--format] [--out] [--json]`.
 * The `file` positional is required; an empty string is a programmer error.
 */
export function buildDumpArgv(options: OfficeCliDumpArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildDumpArgv: file is required");
  }
  const argv: string[] = ["dump", options.file];
  argv.push(options.path ?? "/");
  argv.push("--format", options.format ?? "batch");
  if (options.outPath !== undefined && options.outPath.length > 0) {
    argv.push("--out", options.outPath);
  }
  if (options.json) argv.push("--json");
  return argv;
}

export interface OfficeCliGetArgvOptions {
  /** Path to the .docx (or .pptx/.xlsx) file to read. Required. */
  readonly file: string;
  /** DOM path (e.g. /body/p[1]). Defaults to "/". */
  readonly path?: string;
  /** `--depth N` — depth of child nodes to include. Must be a non-negative integer. */
  readonly depth?: number;
  /** `--save <path>` — extract the backing binary payload to this file. */
  readonly savePath?: string;
  /** Emit `--json` envelope. */
  readonly json?: boolean;
}

/**
 * Build the argv for `officecli get <file> [path] [--depth] [--save] [--json]`.
 */
export function buildGetArgv(options: OfficeCliGetArgvOptions): string[] {
  if (options.file.length === 0) {
    throw new Error("buildGetArgv: file is required");
  }
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 0)) {
    throw new Error(`buildGetArgv: depth must be a non-negative integer (got ${options.depth})`);
  }
  const argv: string[] = ["get", options.file];
  argv.push(options.path ?? "/");
  if (options.depth !== undefined) {
    argv.push("--depth", String(options.depth));
  }
  if (options.savePath !== undefined && options.savePath.length > 0) {
    argv.push("--save", options.savePath);
  }
  if (options.json) argv.push("--json");
  return argv;
}

// ============================================================================
// Runner
// ============================================================================

export interface OfficeCliExecFileOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeout?: number;
  readonly maxBuffer?: number;
  readonly signal?: AbortSignal;
}

/**
 * Injectable execFile replacement. Mirrors the resolved shape of
 * `util.promisify(child_process.execFile)` so a mock can be dropped in for
 * unit tests without spawning a real process.
 */
export type OfficeCliExecFileFn = (
  file: string,
  args: string[],
  options: OfficeCliExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface OfficeCliSpawnOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

/** Injectable child-process factory for runner boundary tests. */
export type OfficeCliSpawnFn = (
  file: string,
  args: readonly string[],
  options: OfficeCliSpawnOptions,
) => ChildProcess;

export type OfficeCliRunFailureCode = "capacity" | "cancelled" | "deadline" | "runner";
export type OfficeCliRunFailureStage = OfficeCliOutputStage | "process";

/** A bounded process failure with explicit accounting where it is knowable. */
export class OfficeCliRunError extends Error {
  readonly code: OfficeCliRunFailureCode;
  readonly stage: OfficeCliRunFailureStage;
  readonly limitBytes: number | undefined;
  readonly observedBytes: number | undefined;
  readonly deadlineMs: number | undefined;

  constructor(
    message: string,
    info: Readonly<{
      code: OfficeCliRunFailureCode;
      stage: OfficeCliRunFailureStage;
      limitBytes?: number;
      observedBytes?: number;
      deadlineMs?: number;
    }>,
  ) {
    super(message);
    this.name = "OfficeCliRunError";
    this.code = info.code;
    this.stage = info.stage;
    this.limitBytes = info.limitBytes;
    this.observedBytes = info.observedBytes;
    this.deadlineMs = info.deadlineMs;
  }
}

export interface OfficeCliRunOptions {
  /** Absolute (or cwd-relative) path to the officecli binary. Required. */
  readonly binaryPath: string;
  /** Argv (without the binary path). */
  readonly argv: readonly string[];
  /** Env; defaults to `buildOfficeCliEnv()` (skip-update on). */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory passed to the child process. */
  readonly cwd?: string;
  /** Kill timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Cancels the real child process and waits for its cleanup. */
  readonly signal?: AbortSignal;
  /** Injectable execFile compatibility seam for existing unit callers. */
  readonly execFile?: OfficeCliExecFileFn;
  /** Injectable spawn; production defaults to `child_process.spawn`. */
  readonly spawn?: OfficeCliSpawnFn;
}

export interface OfficeCliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run officecli with the given argv and return a normalized result.
 *
 * Non-zero exits are NOT thrown — the caller gets `{ exitCode, stdout,
 * stderr }` so it can map officecli's structured error envelopes. Spawn
 * failures (including ENOENT) do throw. Output capacity, caller
 * cancellation, and timeout throw typed `OfficeCliRunError`s after the child
 * has exited and its streams have closed.
 */
export async function runOfficeCliRaw(
  options: OfficeCliRunOptions,
): Promise<OfficeCliRunResult> {
  if (options.binaryPath.length === 0) {
    throw new Error("runOfficeCliRaw: binaryPath is required");
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw new OfficeCliRunError("officecli run deadline has already elapsed", {
      code: "deadline",
      stage: "process",
      deadlineMs: options.timeoutMs,
    });
  }
  const env = options.env ?? buildOfficeCliEnv();

  // Kept solely as a source-compatible test seam for existing callers. The
  // production path below uses stream collectors, so stdout and stderr are
  // independently accounted for rather than sharing execFile's maxBuffer.
  if (options.execFile !== undefined) {
    return runWithExecFile(options, env);
  }

  const spawn: OfficeCliSpawnFn = options.spawn ?? ((file, args, spawnOptions) => spawnCb(
    file,
    [...args],
    { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] },
  ));
  return runWithSpawn(options, env, spawn);
}

async function runWithExecFile(
  options: OfficeCliRunOptions,
  env: NodeJS.ProcessEnv,
): Promise<OfficeCliRunResult> {
  const execOpts: OfficeCliExecFileOptions = {
    env,
    maxBuffer: OFFICECLI_STDIO_MAX_BYTES,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  try {
    const { stdout, stderr } = await options.execFile!(options.binaryPath, [...options.argv], execOpts);
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") {
      return {
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr: typeof e.stderr === "string" ? e.stderr : "",
        exitCode: e.code,
      };
    }
    throw err;
  }
}

function runWithSpawn(
  options: OfficeCliRunOptions,
  env: NodeJS.ProcessEnv,
  spawn: OfficeCliSpawnFn,
): Promise<OfficeCliRunResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new OfficeCliRunError("officecli run was cancelled before spawn", {
      code: "cancelled",
      stage: "process",
    }));
  }

  return new Promise<OfficeCliRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.binaryPath, [...options.argv], {
        env,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (child.stdout === null || child.stderr === null) {
      const pipeError = new Error("runOfficeCliRaw: spawned process did not expose stdout/stderr pipes");
      let spawnError: Error | undefined;
      child.once("error", (error: Error) => { spawnError = error; });
      child.once("close", () => reject(spawnError ?? pipeError));
      child.kill("SIGKILL");
      return;
    }

    const stdout = new BoundedOutputCollector("stdout");
    const stderr = new BoundedOutputCollector("stderr");
    let terminalError: Error | undefined;
    let settled = false;

    const terminate = (error: Error): void => {
      if (terminalError !== undefined) return;
      terminalError = error;
      // `close` is the cleanup boundary: do not reject until the owned child
      // and both stdio streams are closed. SIGKILL avoids an unbounded wait
      // when a child ignores SIGTERM; no retry or second deadline is hidden
      // behind this terminal path.
      child.kill("SIGKILL");
    };

    const onOutput = (collector: BoundedOutputCollector, chunk: Buffer | string): void => {
      const limitError = collector.push(chunk);
      if (limitError !== undefined) terminate(limitError);
    };
    const onAbort = (): void => terminate(new OfficeCliRunError("officecli run was cancelled", {
      code: "cancelled",
      stage: "process",
    }));
    const timeoutMs = options.timeoutMs;
    const timeout = timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => terminate(new OfficeCliRunError("officecli run timed out", {
        code: "deadline",
        stage: "process",
        deadlineMs: timeoutMs,
      })), timeoutMs)
      : undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("error", onStdoutError);
      child.stderr?.removeListener("error", onStderrError);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = (result: OfficeCliRunResult | Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onError = (error: Error): void => {
      // Do not wrap ENOENT or other spawn errors: callers need their native
      // code and message to diagnose the installed binary.
      terminalError ??= error;
    };
    const onClose = (code: number | null): void => {
      if (terminalError !== undefined) {
        finish(terminalError);
        return;
      }
      finish({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code ?? 1 });
    };
    const onStdout = (chunk: Buffer | string): void => onOutput(stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => onOutput(stderr, chunk);
    const onStdoutError = (): void => terminate(new OfficeCliRunError("officecli stdout stream failed", {
      code: "runner",
      stage: "stdout",
    }));
    const onStderrError = (): void => terminate(new OfficeCliRunError("officecli stderr stream failed", {
      code: "runner",
      stage: "stderr",
    }));

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdout.once("error", onStdoutError);
    child.stderr.once("error", onStderrError);
    child.once("error", onError);
    child.once("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may win the race between the first pre-spawn check and listener
    // installation. Re-check after the process is fully observable.
    if (options.signal?.aborted) onAbort();
  });
}

class BoundedOutputCollector {
  readonly #stage: OfficeCliOutputStage;
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #observed = 0;

  constructor(stage: OfficeCliOutputStage) {
    this.#stage = stage;
    this.#limit = OFFICECLI_RUNNER_OUTPUT_LIMITS[stage];
  }

  push(chunk: Buffer | string): OfficeCliRunError | undefined {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#observed += bytes.byteLength;
    if (this.#observed > this.#limit) {
      return new OfficeCliRunError(`officecli ${this.#stage} exceeded its byte limit`, {
        code: "capacity",
        stage: this.#stage,
        limitBytes: this.#limit,
        observedBytes: this.#observed,
      });
    }
    this.#chunks.push(bytes);
    return undefined;
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

// ============================================================================
// Version probe
// ============================================================================

const SEMVER_PREFIX_RE = /^\d+\.\d+\.\d+/;

export interface OfficeCliVersionOptions {
  readonly binaryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly execFile?: OfficeCliExecFileFn;
  readonly spawn?: OfficeCliSpawnFn;
}

export class OfficeCliVersionError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    info: { exitCode: number; stdout: string; stderr: string },
  ) {
    super(message);
    this.name = "OfficeCliVersionError";
    this.exitCode = info.exitCode;
    this.stdout = info.stdout;
    this.stderr = info.stderr;
  }
}

/**
 * Run `officecli --version` and return the leading semver string
 * (e.g. `"1.2.3"`). Throws `OfficeCliVersionError` on non-zero exit or
 * non-semver stdout — both indicate the resolved binary is not the
 * expected officecli build.
 */
export async function runOfficeCliVersion(
  options: OfficeCliVersionOptions,
): Promise<string> {
  const result = await runOfficeCliRaw({
    binaryPath: options.binaryPath,
    argv: buildVersionArgv(),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.execFile !== undefined ? { execFile: options.execFile } : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
  });
  const trimmed = result.stdout.trim();
  if (result.exitCode !== 0) {
    throw new OfficeCliVersionError(
      `officecli --version exited with code ${result.exitCode}`,
      { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    );
  }
  const match = SEMVER_PREFIX_RE.exec(trimmed);
  const version = match === null ? undefined : match[0];
  if (version === undefined) {
    throw new OfficeCliVersionError(
      `officecli --version output did not start with a semver string (got: ${JSON.stringify(trimmed)})`,
      { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    );
  }
  return version;
}
