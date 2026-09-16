import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import { isCanonicalSshHost, type SshHostTrustTarget } from "./contracts.ts";
import { SYSTEM_OPENSSH_PATHS, type StructuredSshProcessResult } from "./process-runner.ts";
import { validateSystemAgentPublicKey } from "./system-agent.ts";

/** The Apple-supplied Seatbelt launcher is the only permitted observer parent. */
export const SYSTEM_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec" as const;

/**
 * This lane only reads its ssh-keygen input.  The last process rule admits the
 * initial fixed binary after the general child-exec denial; any attempted
 * helper remains denied.  It intentionally has no network or write authority.
 */
export const HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (literal "/dev/null"))
(deny process-exec)
(allow process-exec (literal "/usr/bin/ssh-keygen"))`;

const ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const POST_KILL_SETTLE_MS = 1_000;
const MAX_KNOWN_HOST_FILES = 64;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_OUTPUT_LINES = 64;
const MAX_OUTPUT_LINE_BYTES = 8 * 1024;

export type HumanKnownHostAlgorithm = "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" | "ssh-rsa";

/** Secret-free local evidence. It deliberately excludes key blobs and paths. */
export interface HumanKnownHostKey {
  readonly algorithm: HumanKnownHostAlgorithm;
  readonly fingerprint: string;
}

export type HumanKnownHostsObservationReason =
  | "invalid_request"
  | "observer_unavailable"
  | "lookup_failed"
  | "lookup_timed_out"
  | "lookup_aborted"
  | "lookup_output_limited"
  | "lookup_output_invalid";

/**
 * This is an advisory Electron-local observation, never a durable trust
 * record.  A caller still owns the decision to skip first-use ceremony.
 */
export type HumanKnownHostsObservationResult =
  | { readonly ok: true; readonly trust: "absent"; readonly hostKeys: readonly [] }
  | { readonly ok: true; readonly trust: "trusted"; readonly hostKeys: readonly HumanKnownHostKey[] }
  | { readonly ok: false; readonly reason: HumanKnownHostsObservationReason };

export interface ObserveHumanKnownHostsRequest {
  readonly target: SshHostTrustTarget;
  /** Electron-private values from OpenSshDestinationPlan. Never return these. */
  readonly knownHostFiles: readonly string[];
  readonly signal?: AbortSignal;
}

export interface HumanKnownHostsRunnerInput {
  readonly executable: typeof SYSTEM_OPENSSH_PATHS.sshKeygen;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}

export interface HumanKnownHostsChild {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface HumanKnownHostsSpawn {
  (file: typeof SYSTEM_SANDBOX_EXEC_PATH, args: readonly string[], options: {
    readonly shell: false;
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
    readonly detached: boolean;
    readonly env: Readonly<Record<string, string>>;
  }): HumanKnownHostsChild;
}

export interface RunHumanKnownHostsLookupDependencies {
  readonly sandboxAvailable?: () => boolean;
  readonly spawn?: HumanKnownHostsSpawn;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ObserveHumanKnownHostsDependencies {
  /** Test seam; production always uses the fixed Seatbelt runner below. */
  readonly run?: (input: HumanKnownHostsRunnerInput) => Promise<StructuredSshProcessResult>;
  /** Test seam; production resolves `~/` against the Electron user's home. */
  readonly homeDirectory?: () => string;
}

function unavailable(): StructuredSshProcessResult {
  return { processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" };
}

function validAbortSignal(value: unknown): value is AbortSignal {
  return value === undefined || (typeof value === "object" && value !== null
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function");
}

function validTarget(value: unknown): value is SshHostTrustTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && Object.prototype.hasOwnProperty.call(record, "host") && Object.prototype.hasOwnProperty.call(record, "port")
    && isCanonicalSshHost(record["host"])
    && typeof record["port"] === "number" && Number.isSafeInteger(record["port"]) && record["port"] >= 1 && record["port"] <= 65_535;
}

function hostToken(target: SshHostTrustTarget): string {
  return target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
}

function validHostToken(value: unknown): value is string {
  if (isCanonicalSshHost(value)) return true;
  if (typeof value !== "string") return false;
  const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  const port = match === null ? Number.NaN : Number(match[2]);
  return match !== null && isCanonicalSshHost(match[1]) && Number.isSafeInteger(port) && port >= 1 && port <= 65_535 && port !== 22;
}

function safeAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || !nodePath.posix.isAbsolute(value)) return false;
  if (/[\0\r\n\t\s%$~*?\x5b\x5d{}!'"`\\|&;<>()]/.test(value) || value.includes("//")) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

/** Resolve only V1 absolute paths or a child of the local user's home. */
function resolveKnownHostsPath(value: unknown, home: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("~/")) {
    if (!safeAbsolutePath(home) || value.length === 2) return null;
    const relative = value.slice(2);
    if (relative.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") || /[\0\r\n\t\s%$~*?\x5b\x5d{}!'"`\\|&;<>()]/.test(relative)) return null;
    const resolved = nodePath.posix.join(home, relative);
    return safeAbsolutePath(resolved) ? resolved : null;
  }
  return safeAbsolutePath(value) ? value : null;
}

function validRunnerInput(input: HumanKnownHostsRunnerInput): boolean {
  const [find, token, file, path] = input.argv;
  return input.executable === SYSTEM_OPENSSH_PATHS.sshKeygen
    && input.argv.length === 4 && find === "-F" && validHostToken(token)
    && file === "-f" && safeAbsolutePath(path)
    && input.timeoutMs === LOOKUP_TIMEOUT_MS && input.maxStdoutBytes === MAX_STDOUT_BYTES && input.maxStderrBytes === MAX_STDERR_BYTES
    && Object.keys(input.env).length === Object.keys(ENVIRONMENT).length
    && Object.entries(ENVIRONMENT).every(([key, value]) => input.env[key] === value)
    && validAbortSignal(input.signal);
}

function defaultSandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SYSTEM_SANDBOX_EXEC_PATH);
}

function defaultKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

/** Execute exactly one local `ssh-keygen -F … -f …` lookup inside Seatbelt. */
export async function runHumanKnownHostsLookup(
  input: HumanKnownHostsRunnerInput,
  dependencies: RunHumanKnownHostsLookupDependencies = {},
): Promise<StructuredSshProcessResult> {
  if (!validRunnerInput(input) || input.signal?.aborted || !(dependencies.sandboxAvailable ?? defaultSandboxAvailable)()) {
    return input.signal?.aborted
      ? { processStarted: false, termination: "aborted", code: null, signal: null, stdout: "", stderr: "" }
      : unavailable();
  }
  const spawn = dependencies.spawn ?? (nodeSpawn as unknown as HumanKnownHostsSpawn);
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancelSchedule = dependencies.clearTimeout ?? clearTimeout;
  const killProcessGroup = dependencies.killProcessGroup ?? defaultKillProcessGroup;
  let child: HumanKnownHostsChild;
  try {
    child = spawn(SYSTEM_SANDBOX_EXEC_PATH, ["-p", HUMAN_KNOWN_HOSTS_SEATBELT_PROFILE, SYSTEM_OPENSSH_PATHS.sshKeygen, ...input.argv], {
      shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform === "darwin", env: { ...ENVIRONMENT },
    });
  } catch {
    return unavailable();
  }
  return new Promise((resolve) => {
    let termination: StructuredSshProcessResult["termination"] = "exited";
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timers: { main?: ReturnType<typeof setTimeout>; postKill?: ReturnType<typeof setTimeout> } = {};
    const finish = (code: number | null, signal: NodeJS.Signals | null, forced?: "spawn_failed") => {
      if (settled) return;
      settled = true;
      if (timers.main !== undefined) cancelSchedule(timers.main);
      if (timers.postKill !== undefined) cancelSchedule(timers.postKill);
      input.signal?.removeEventListener("abort", abort);
      resolve({ processStarted: true, termination: forced ?? termination, code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const terminate = (reason: "timed_out" | "aborted" | "stdout_limit" | "stderr_limit") => {
      if (termination !== "exited") return;
      termination = reason;
      try {
        if (process.platform === "darwin" && typeof child.pid === "number" && child.pid > 0) killProcessGroup(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* Child is already gone. */ }
      }
      timers.postKill = schedule(() => finish(null, "SIGKILL"), POST_KILL_SETTLE_MS);
    };
    const abort = () => terminate("aborted");
    const collect = (chunks: Buffer[], current: () => number, update: (value: number) => void, limit: number, reason: "stdout_limit" | "stderr_limit") => (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - current();
      if (remaining > 0) chunks.push(Buffer.from(bytes.subarray(0, remaining)));
      update(current() + bytes.byteLength);
      if (bytes.byteLength > remaining) terminate(reason);
    };
    timers.main = schedule(() => terminate("timed_out"), input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdout?.on("data", collect(stdout, () => stdoutBytes, (value) => { stdoutBytes = value; }, input.maxStdoutBytes, "stdout_limit"));
    child.stderr?.on("data", collect(stderr, () => stderrBytes, (value) => { stderrBytes = value; }, input.maxStderrBytes, "stderr_limit"));
    child.once("close", (code, signal) => finish(code, signal));
    child.once("error", () => finish(null, null, termination === "exited" ? "spawn_failed" : undefined));
  });
}

function resultFailure(result: StructuredSshProcessResult): HumanKnownHostsObservationReason | null {
  if (result.termination === "aborted") return "lookup_aborted";
  if (result.termination === "timed_out") return "lookup_timed_out";
  if (result.termination === "stdout_limit" || result.termination === "stderr_limit") return "lookup_output_limited";
  if (result.termination === "spawn_failed" || !result.processStarted) return "observer_unavailable";
  return null;
}

function parseFoundOutput(stdout: string): readonly HumanKnownHostKey[] | null {
  const lines = stdout.split("\n");
  if (lines.length > MAX_OUTPUT_LINES + 1) return null;
  const found = new Map<string, HumanKnownHostKey>();
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_LINE_BYTES || /[\0\r]/.test(line)) return null;
    // ssh-keygen's informational line is discarded; host labels never leave
    // this function, including when the matching entry is hashed.
    if (/^# Host [^\r\n]{1,512} found: line [1-9][0-9]{0,8}[ \t]*$/.test(line)) continue;
    const match = /^[^\s\0\r\n]{1,2048} ((?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{0,4096})?$/.exec(line);
    const validated = match === null ? null : validateSystemAgentPublicKey(`${match[1]!} ${match[2]!}`);
    if (validated === null) return null;
    const algorithm = validated.canonical.split(" ", 1)[0] as HumanKnownHostAlgorithm;
    found.set(validated.fingerprint, { algorithm, fingerprint: validated.fingerprint });
  }
  return found.size === 0 ? null : [...found.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

/**
 * Observe pre-existing Human OpenSSH trust without reading bytes into the app
 * or establishing any new trust. Missing files and no match are ordinary
 * absence; every malformed, failed, or bounded lookup fails closed.
 */
export async function observeHumanKnownHosts(
  request: ObserveHumanKnownHostsRequest,
  dependencies: ObserveHumanKnownHostsDependencies = {},
): Promise<HumanKnownHostsObservationResult> {
  if (!validTarget(request?.target) || !Array.isArray(request.knownHostFiles) || request.knownHostFiles.length > MAX_KNOWN_HOST_FILES || !validAbortSignal(request.signal)) return { ok: false, reason: "invalid_request" };
  const home = (dependencies.homeDirectory ?? homedir)();
  const paths = request.knownHostFiles.map((path) => resolveKnownHostsPath(path, home));
  if (paths.some((path) => path === null)) return { ok: false, reason: "invalid_request" };
  const run = dependencies.run ?? runHumanKnownHostsLookup;
  const keys = new Map<string, HumanKnownHostKey>();
  for (const path of [...new Set(paths as string[])]) {
    // `ssh -G` lists conventional known_hosts paths even when they do not
    // exist. Apple ssh-keygen reports those as exit 255 plus a path-bearing
    // diagnostic, so skip absence before invoking the confined observer.
    // An injected runner owns its virtual filesystem semantics in tests.
    if (dependencies.run === undefined && !existsSync(path)) continue;
    let result: StructuredSshProcessResult;
    try {
      result = await run({ executable: SYSTEM_OPENSSH_PATHS.sshKeygen, argv: ["-F", hostToken(request.target), "-f", path], env: ENVIRONMENT, timeoutMs: LOOKUP_TIMEOUT_MS, maxStdoutBytes: MAX_STDOUT_BYTES, maxStderrBytes: MAX_STDERR_BYTES, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    } catch {
      return { ok: false, reason: "observer_unavailable" };
    }
    const failed = resultFailure(result);
    if (failed !== null) return { ok: false, reason: failed };
    // ssh-keygen uses exit 1 for no match and for a missing file. It must not
    // have emitted data or diagnostics for this to count as ordinary absence.
    if (result.code === 1 && result.stdout === "" && result.stderr === "") continue;
    if (result.code !== 0 || result.stderr !== "") return { ok: false, reason: "lookup_failed" };
    const found = parseFoundOutput(result.stdout);
    if (found === null) return { ok: false, reason: "lookup_output_invalid" };
    for (const key of found) keys.set(key.fingerprint, key);
  }
  const hostKeys = [...keys.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  return hostKeys.length === 0
    ? { ok: true, trust: "absent", hostKeys: [] }
    : { ok: true, trust: "trusted", hostKeys };
}
