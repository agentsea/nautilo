import { spawn as nodeSpawn } from "node:child_process";
import { RELAY_SSH_HARD_TIMEOUT_SECONDS } from "@nautilo/relay";

/** Fixed Apple-supplied programs. This module deliberately has no arbitrary-command API. */
export const SYSTEM_OPENSSH_PATHS = Object.freeze({
  ssh: "/usr/bin/ssh",
  sshAdd: "/usr/bin/ssh-add",
  scp: "/usr/bin/scp",
  sshKeygen: "/usr/bin/ssh-keygen",
  sshKeyscan: "/usr/bin/ssh-keyscan",
});

export type StructuredSshExecutable = (typeof SYSTEM_OPENSSH_PATHS)[keyof typeof SYSTEM_OPENSSH_PATHS];
export type StructuredSshTermination = "exited" | "spawn_failed" | "timed_out" | "aborted" | "stdout_limit" | "stderr_limit";

export interface StructuredSshProcessResult {
  /** True only after the OS child-process creation call returned successfully. */
  readonly processStarted: boolean;
  readonly termination: StructuredSshTermination;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Bounded local-only parser input. Callers must never log or relay it. */
  readonly stdout: string;
  /** Bounded local-only parser input. Callers must never log or relay it. */
  readonly stderr: string;
}

export interface StructuredSshChild {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface StructuredSshSpawn {
  (file: StructuredSshExecutable, args: readonly string[], options: {
    readonly shell: false;
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
    readonly detached: boolean;
    readonly env: Readonly<Record<string, string>>;
  }): StructuredSshChild;
}

export interface StructuredSshProcessTimer {
  (callback: () => void, delay: number): ReturnType<typeof setTimeout>;
}

export interface StructuredSshProcessRunnerDependencies {
  readonly spawn?: StructuredSshSpawn;
  readonly setTimeout?: StructuredSshProcessTimer;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Test seam; production uses process.kill(-pid, signal) for detached macOS children. */
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface RunStructuredSshProcessInput {
  readonly executable: StructuredSshExecutable;
  readonly argv: readonly string[];
  /** Exact finite environment. The parent process environment is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Probes fail on overflow; exec may keep draining while a bounded continuation captures output. */
  readonly terminateOnOutputLimit?: boolean | undefined;
  readonly signal?: AbortSignal;
  /**
   * Non-blocking lifecycle observation, called only after child creation
   * succeeds. Observer failure never changes spawn, drainage, cancellation,
   * timeout, termination, or the final result.
   */
  readonly onStarted?: (() => void) | undefined;
  /**
   * Non-blocking local observation only. It receives the raw drained chunk
   * after bounded collection; failures are explicitly isolated from child
   * lifetime and the authoritative process result.
   */
  readonly onStdoutChunk?: ((chunk: Buffer) => void) | undefined;
  /** See onStdoutChunk. */
  readonly onStderrChunk?: ((chunk: Buffer) => void) | undefined;
}

// The fixed confinement fragment is 32 argv entries. A bounded SSH operation
// appends `-T -p <port> -- <user@host> <command>` and bounded SCP appends
// `-P <port> <source> <destination>`, so 38 admits the complete fixed lanes
// and nothing more.
const MAX_ARGV = 38;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 8;
const MAX_ENVIRONMENT_KEY_BYTES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 4 * 1024;
const MAX_TIMEOUT_MS = RELAY_SSH_HARD_TIMEOUT_SECONDS * 1_000;
const MAX_STREAM_BYTES = 64 * 1024;
const POST_KILL_SETTLE_MS = 1_000;
const ALLOWED_ENVIRONMENT_KEYS = new Set(["PATH", "LC_ALL", "LANG", "SSH_AUTH_SOCK"]);

function validEnvironmentEntry(key: string, value: string): boolean {
  if (!ALLOWED_ENVIRONMENT_KEYS.has(key) || !validText(key, MAX_ENVIRONMENT_KEY_BYTES) || !validText(value, MAX_ENVIRONMENT_VALUE_BYTES)) return false;
  if (key === "PATH") return value === "/usr/bin:/bin";
  if (key === "LC_ALL" || key === "LANG") return value === "C";
  return value.startsWith("/") && !/[\r\n]/.test(value);
}

const isExecutable = (value: string): value is StructuredSshExecutable =>
  Object.values(SYSTEM_OPENSSH_PATHS).includes(value as StructuredSshExecutable);

const validText = (value: string, maximum: number): boolean =>
  !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum;

function validInput(input: RunStructuredSshProcessInput): boolean {
  if (!isExecutable(input.executable) || input.argv.length > MAX_ARGV || !input.argv.every((arg) => validText(arg, MAX_ARGUMENT_BYTES))) return false;
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) return false;
  if (![input.maxStdoutBytes, input.maxStderrBytes].every((limit) => Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_STREAM_BYTES)) return false;
  const entries = Object.entries(input.env);
  return entries.length <= MAX_ENVIRONMENT_ENTRIES && entries.every(([key, value]) => validEnvironmentEntry(key, value));
}

function defaultKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

/**
 * Run one fixed Apple OpenSSH binary. It starts a detached process group on
 * macOS so abort/timeout/output limits cannot leave descendants running.
 * The result intentionally contains no diagnostic object or thrown child error.
 */
export async function runStructuredSshProcess(
  input: RunStructuredSshProcessInput,
  dependencies: StructuredSshProcessRunnerDependencies = {},
): Promise<StructuredSshProcessResult> {
  if (!validInput(input)) return { processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" };
  if (input.signal?.aborted) return { processStarted: false, termination: "aborted", code: null, signal: null, stdout: "", stderr: "" };

  const spawn = dependencies.spawn ?? (nodeSpawn as unknown as StructuredSshSpawn);
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancelSchedule = dependencies.clearTimeout ?? clearTimeout;
  const killProcessGroup = dependencies.killProcessGroup ?? defaultKillProcessGroup;
  let child: StructuredSshChild;
  try {
    child = spawn(input.executable, [...input.argv], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform === "darwin",
      env: { ...input.env },
    });
  } catch {
    return { processStarted: false, termination: "spawn_failed", code: null, signal: null, stdout: "", stderr: "" };
  }
  try { input.onStarted?.(); } catch { /* Observation cannot alter process control. */ }

  return new Promise((resolve) => {
    let termination: StructuredSshTermination = "exited";
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timers: { main?: ReturnType<typeof setTimeout>; postKill?: ReturnType<typeof setTimeout> } = {};
    function finish(code: number | null, signal: NodeJS.Signals | null, forced?: "spawn_failed"): void {
      if (settled) return;
      settled = true;
      if (timers.main !== undefined) cancelSchedule(timers.main);
      if (timers.postKill !== undefined) cancelSchedule(timers.postKill);
      input.signal?.removeEventListener("abort", abort);
      resolve({ processStarted: true, termination: forced ?? termination, code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    }
    function abort(): void {
      terminate("aborted");
    }
    const terminate = (reason: Exclude<StructuredSshTermination, "exited" | "spawn_failed">) => {
      if (termination !== "exited") return;
      termination = reason;
      try {
        if (process.platform === "darwin" && typeof child.pid === "number" && child.pid > 0) killProcessGroup(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* Child is already gone. */ }
      }
      // Node normally emits close after SIGKILL, but a broken adapter or OS
      // edge must not make this bounded lane wait forever.
      timers.postKill = schedule(() => finish(null, "SIGKILL"), POST_KILL_SETTLE_MS);
    };
    timers.main = schedule(() => terminate("timed_out"), input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    // Close the check/listener race: the signal may abort after the pre-spawn
    // check but before the listener is installed.
    if (input.signal?.aborted) abort();
    const collect = (
      chunks: Buffer[],
      current: () => number,
      update: (value: number) => void,
      limit: number,
      reason: "stdout_limit" | "stderr_limit",
      observe: ((chunk: Buffer) => void) | undefined,
    ) => (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - current();
      if (remaining > 0) chunks.push(Buffer.from(bytes.subarray(0, remaining)));
      update(current() + bytes.byteLength);
      try { observe?.(Buffer.from(bytes)); } catch { /* Observation cannot affect pipe drainage or process control. */ }
      if (bytes.byteLength > remaining && input.terminateOnOutputLimit !== false) terminate(reason);
    };
    child.stdout?.on("data", collect(stdout, () => stdoutBytes, (value) => { stdoutBytes = value; }, input.maxStdoutBytes, "stdout_limit", input.onStdoutChunk));
    child.stderr?.on("data", collect(stderr, () => stderrBytes, (value) => { stderrBytes = value; }, input.maxStderrBytes, "stderr_limit", input.onStderrChunk));
    child.once("close", (code, signal) => finish(code, signal));
    // A forced termination can race with Node's child-process error event.
    // Preserve the established timeout/abort/output-limit outcome in that case.
    child.once("error", () => finish(null, null, termination === "exited" ? "spawn_failed" : undefined));
  });
}
