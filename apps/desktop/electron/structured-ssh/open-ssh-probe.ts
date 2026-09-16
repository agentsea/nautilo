import { existsSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

import { SYSTEM_OPENSSH_PATHS, type StructuredSshProcessResult } from "./process-runner.ts";
import { OPEN_SSH_NAMED_CONNECTION_PROBE_SENTINEL, type OpenSshPlanRunnerInput } from "./open-ssh-plan.ts";

/** The Apple-supplied Seatbelt launcher is the only permitted probe parent. */
export const SYSTEM_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec" as const;

/**
 * `ssh -G` parses Match blocks, including `Match exec`.  The generic desktop
 * Seatbelt profile permits process execution, so this observation lane uses a
 * deliberately smaller profile: the initial trusted ssh image is allowed, but
 * no shell, helper, or other descendant may exec.
 *
 * The final allow is intentional. Seatbelt resolves later matching rules last:
 * it permits sandbox-exec's initial hand-off to exactly /usr/bin/ssh after the
 * general deny, while Match exec's /bin/sh hand-off remains denied.
 */
export const OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (literal "/dev/null"))
(deny process-exec)
(allow process-exec (literal "/usr/bin/ssh"))`;

const PROBE_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_STDOUT_BYTES = 64 * 1024;
const PROBE_MAX_STDERR_BYTES = 8 * 1024;
const PROBE_POST_KILL_SETTLE_MS = 1_000;
const MAX_HOST_BYTES = 253;
const MAX_USER_BYTES = 64;

export interface OpenSshConfigProbeChild {
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface OpenSshConfigProbeSpawn {
  (file: typeof SYSTEM_SANDBOX_EXEC_PATH, args: readonly string[], options: {
    readonly shell: false;
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
    readonly detached: boolean;
    readonly env: Readonly<Record<string, string>>;
  }): OpenSshConfigProbeChild;
}

export interface OpenSshConfigProbeDependencies {
  /** Test seam. Production requires Darwin and the fixed Apple binary to exist. */
  readonly sandboxAvailable?: () => boolean;
  readonly spawn?: OpenSshConfigProbeSpawn;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

function unavailable(): StructuredSshProcessResult {
  return { processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" };
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && !/[\0\r\n]/.test(value);
}

function isNamedProbeStdin(stdin: string): boolean {
  const match = /^Include ~\/\.ssh\/config\nHost \*\n {2}User ([^\n]+)\n$/.exec(stdin);
  return match !== null && OPEN_SSH_NAMED_CONNECTION_PROBE_SENTINEL.test(match[1]!);
}

/** Accept ordinary exact-endpoint probes and one bounded synthetic named probe. */
function isFixedProbeArgv(argv: readonly string[], stdin: string | undefined): boolean {
  if (argv[0] !== "-G") return false;
  let index = 1;
  if (argv[index] === "-F") {
    return argv.length === 5 &&
      argv[1] === "-F" && argv[2] === "/dev/stdin" && argv[3] === "--" &&
      stdin !== undefined && isNamedProbeStdin(stdin) &&
      isText(argv[4], MAX_HOST_BYTES) && !argv[4].startsWith("-") && !/[\s@]/.test(argv[4]);
  }
  if (stdin !== undefined) return false;
  if (argv[index] === "-l") {
    if (!isText(argv[index + 1], MAX_USER_BYTES) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(argv[index + 1]!)) return false;
    index += 2;
  }
  if (argv[index] === "-p") {
    const port = argv[index + 1];
    if (typeof port !== "string" || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) return false;
    index += 2;
  }
  return argv.length === index + 2 && argv[index] === "--" && isText(argv[index + 1], MAX_HOST_BYTES) && !argv[index + 1]!.startsWith("-") && !/[\s@]/.test(argv[index + 1]!);
}

function validInput(input: OpenSshPlanRunnerInput): boolean {
  if (input.executable !== SYSTEM_OPENSSH_PATHS.ssh || !isFixedProbeArgv(input.argv, input.stdin)) return false;
  if (input.timeoutMs !== PROBE_TIMEOUT_MS || input.maxStdoutBytes !== PROBE_MAX_STDOUT_BYTES || input.maxStderrBytes !== PROBE_MAX_STDERR_BYTES) return false;
  const entries = Object.entries(input.env);
  return entries.length === Object.keys(PROBE_ENVIRONMENT).length && entries.every(([key, value]) => PROBE_ENVIRONMENT[key as keyof typeof PROBE_ENVIRONMENT] === value);
}

function defaultSandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SYSTEM_SANDBOX_EXEC_PATH);
}

function defaultKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

/**
 * Safely observe effective OpenSSH configuration for the destination resolver.
 * It does not establish an SSH session or network connection; Seatbelt prevents
 * Match exec from launching its configured child process. Missing Seatbelt fails
 * closed.
 */
export async function runOpenSshConfigProbe(
  input: OpenSshPlanRunnerInput,
  dependencies: OpenSshConfigProbeDependencies = {},
): Promise<StructuredSshProcessResult> {
  if (!validInput(input) || input.signal?.aborted || !(dependencies.sandboxAvailable ?? defaultSandboxAvailable)()) {
    return input.signal?.aborted
      ? { processStarted: false, termination: "aborted", code: null, signal: null, stdout: "", stderr: "" }
      : unavailable();
  }

  const spawn = dependencies.spawn ?? (nodeSpawn as unknown as OpenSshConfigProbeSpawn);
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancelSchedule = dependencies.clearTimeout ?? clearTimeout;
  const killProcessGroup = dependencies.killProcessGroup ?? defaultKillProcessGroup;
  let child: OpenSshConfigProbeChild;
  try {
    child = spawn(SYSTEM_SANDBOX_EXEC_PATH, ["-p", OPEN_SSH_CONFIG_PROBE_SEATBELT_PROFILE, SYSTEM_OPENSSH_PATHS.ssh, ...input.argv], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform === "darwin",
      env: { ...PROBE_ENVIRONMENT },
    });
  } catch {
    return unavailable();
  }
  try { child.stdin?.end(input.stdin ?? ""); } catch {
    try { child.kill("SIGKILL"); } catch { /* The child has already exited. */ }
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
        try { child.kill("SIGKILL"); } catch { /* The child has already exited. */ }
      }
      timers.postKill = schedule(() => finish(null, "SIGKILL"), PROBE_POST_KILL_SETTLE_MS);
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
