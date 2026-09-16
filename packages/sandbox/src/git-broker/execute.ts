/**
 * D440 Phase 2 — bounded sandboxed executor for the Git broker.
 *
 * Runs `/usr/bin/sandbox-exec -p <profile> <git> <args...>` with an
 * explicit, hardened env map and bounded in-memory stdout/stderr
 * capture (head+tail, no disk spill — mirrors `spawn.ts`'s
 * `StreamCapture` discipline). Returns the raw exec result; the
 * broker classifies sideEffectStarted / retrySafe from it.
 *
 * The env map is the broker's hardened Git env:
 *   - `GIT_CONFIG_NOSYSTEM=1` and `HOME=<broker scratch>`: ignore
 *     system + global config (the contract requires ignoring
 *     system/global config and aliases).
 *   - `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_SYSTEM=/dev/null`:
 *     belt-and-suspenders so no global/system file is read even if
 *     an older Git ignores `GIT_CONFIG_NOSYSTEM`.
 *   - `GIT_ALTERNATE_OBJECT_DIRECTORIES` UNSET: drop alternates.
 *   - `GIT_TEMPLATE_DIR` UNSET: no custom templates.
 *   - per-operation `-c` overrides that disable hooks, editor,
 *     signing, external diff, textconv, and filters.
 *
 * The executor is platform-gated: it refuses to run on non-Darwin
 * backends (returns `platform-unsupported`) because the compiled
 * profile is SBPL. The broker surfaces that as a typed disposition
 * rather than silently executing unsandboxed.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface ExecInputs {
  readonly sandboxExecutable: string;
  readonly profile: string;
  readonly gitExecutable: string;
  readonly gitArgs: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Exact stdin bytes for plumbing commands such as hash-object/commit-tree. */
  readonly stdin?: Buffer;
  /** Broker-controlled Git environment overrides (index/quarantine only). */
  readonly env?: Readonly<Record<string, string>>;
  /** When true, skip sandbox-exec and run git directly (tests only). */
  readonly disableSandboxForTests?: boolean;
  /**
   * Override the in-memory stdout/stderr capture budget in bytes.
   * Defaults to 16 KiB (head+tail). Operations that emit bounded but
   * large structured output (e.g. `ls-tree -z` of a manifest) pass a
   * larger budget so the output is not truncated. The broker still
   * bounds the underlying operation via manifest validation, so a
   * larger budget does not widen the threat surface.
   */
  readonly captureBudget?: number;
  /**
   * HOME for the sandboxed git. MUST be a path the compiled profile
   * ALLOWS (the broker uses the granted repository working tree).
   * Setting HOME to a DENIED path makes git block on HOME-relative
   * reads/writes and hang the whole invocation.
   */
  readonly homeDir: string;
  /**
   * When true, capture stdout as a raw Buffer (no utf8 string conversion)
   * bounded by `captureBudget`. Used for `cat-file blob` so binary blobs
   * are materialized byte-exact. When set, `stdoutBinary` is populated
   * on the result and `stdout` is the empty string.
   */
  readonly captureBinary?: boolean;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Raw stdout Buffer when `captureBinary` was set; undefined otherwise. */
  readonly stdoutBinary?: Buffer;
  /** True when binary capture exceeded `captureBudget` (memory bounded). */
  readonly stdoutOverflow?: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Build the hardened env map the broker runs Git with. Returned as a
 * fresh object so callers never mutate shared state.
 *
 * `homeDir` MUST be a path the compiled profile allows (the broker
 * passes the granted repository working tree). It is NOT the
 * broker's denied scratch — a denied HOME makes git hang.
 */
export function buildGitBrokerEnv(homeDir: string): Record<string, string> {
  const env: Record<string, string> = {
    // Ignore system + global config entirely.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // No alternates, no custom templates, no pager.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_TEMPLATE_DIR: "",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // Editor: never invoke one. `:` is a no-op true; commit plumbing
    // does not invoke an editor when a message is supplied on argv.
    GIT_EDITOR: ":",
    EDITOR: ":",
    VISUAL: ":",
    // No credential helpers.
    GIT_TERMINAL_PROMPT: "0",
    // HOME = the granted working tree (an ALLOWED path). Never the
    // broker's denied scratch.
    HOME: homeDir,
    TMPDIR: "/tmp",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  return env;
}

/**
 * The per-operation `-c` overrides that disable every
 * execution-bearing Git config key. These run AFTER the env block
 * so they win over any local config the broker's config audit
 * missed (defense in depth on top of the audit).
 */
export function gitBrokerConfigOverrides(): readonly string[] {
  return [
    "-c",
    "core.hooksPath=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "commit.verbose=false",
    "-c",
    "core.askpass=",
    "-c",
    "credential.helper=",
    "-c",
    "diff.external=",
    "-c",
    "diff.textconv=",
    "-c",
    "diff.cachetextconv=false",
    "-c",
    "log.mailmap=false",
  ] as const;
}

class BoundedCapture {
  private head = "";
  private tail = "";
  private total = 0;
  private overflowed = false;
  private readonly headBudget: number;
  private readonly tailBudget: number;
  constructor(budget: number) {
    this.headBudget = Math.floor(budget / 2);
    this.tailBudget = budget - this.headBudget;
  }
  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    if (this.head.length < this.headBudget) {
      const room = this.headBudget - this.head.length;
      this.head += chunk.slice(0, room);
      const rest = chunk.slice(room);
      if (rest.length > 0) this.pushTail(rest);
    } else {
      this.pushTail(chunk);
    }
  }
  private pushTail(chunk: string): void {
    this.overflowed = true;
    const piece =
      chunk.length > this.tailBudget
        ? chunk.slice(chunk.length - this.tailBudget)
        : chunk;
    this.tail += piece;
    if (this.tail.length > this.tailBudget) {
      this.tail = this.tail.slice(this.tail.length - this.tailBudget);
    }
  }
  finalize(): string {
    if (!this.overflowed) return this.head;
    const omitted = Math.max(0, this.total - this.head.length - this.tail.length);
    return `${this.head}\n…[${omitted} chars truncated]…\n${this.tail}`;
  }
}

class BinaryCapture {
  private chunks: Buffer[] = [];
  private total = 0;
  private overflow = false;
  constructor(private readonly budget: number) {}
  append(buf: Buffer): void {
    if (this.overflow) return;
    if (this.total + buf.length > this.budget) {
      // Bound memory: keep only up to the budget, flag overflow.
      const room = Math.max(0, this.budget - this.total);
      if (room > 0) this.chunks.push(buf.subarray(0, room));
      this.total += buf.length;
      this.overflow = true;
      return;
    }
    this.chunks.push(buf);
    this.total += buf.length;
  }
  finalize(): { buffer: Buffer; overflow: boolean } {
    return { buffer: Buffer.concat(this.chunks), overflow: this.overflow };
  }
}

function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // fall through to child kill
    }
  }
  child.kill("SIGKILL");
}

/**
 * Run Git under the compiled sandbox profile. Never throws for
 * subprocess behavior; only throws if the spawn itself fails
 * (ENOENT for sandbox-exec). The broker catches and converts to a
 * typed disposition.
 */
export function runGitSandboxed(inputs: ExecInputs): Promise<ExecResult> {
  const env = {
    ...buildGitBrokerEnv(inputs.homeDir),
    ...inputs.env,
  };
  const program = inputs.disableSandboxForTests
    ? inputs.gitExecutable
    : inputs.sandboxExecutable;
  const argv = inputs.disableSandboxForTests
    ? [...inputs.gitArgs]
    : ["-p", inputs.profile, inputs.gitExecutable, ...inputs.gitArgs];

  return new Promise<ExecResult>((resolve, reject) => {
    const child: ChildProcess = spawn(program, [...argv], {
      cwd: inputs.cwd,
      ...(process.platform !== "win32" ? { detached: true } : {}),
      env,
      stdio: [inputs.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const useBinary = inputs.captureBinary === true;
    const out = useBinary
      ? null
      : new BoundedCapture(inputs.captureBudget ?? 16 * 1024);
    const binOut = useBinary
      ? new BinaryCapture(inputs.captureBudget ?? 16 * 1024)
      : null;
    const err = new BoundedCapture(16 * 1024);
    let timedOut = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Hard fallback: if the `close` event does not fire within 2s
      // of the SIGKILL (e.g. a grandchild git holds the stdio pipe
      // open and the process-group kill did not reach it), force-
      // resolve so the broker never hangs. The disposition will be
      // exec-timeout; the broker classifies it as unknown-outcome
      // for side-effect-begun ops.
      graceTimer = setTimeout(() => {
        const bin = binOut !== null ? binOut.finalize() : null;
        finish({
          stdout: out !== null ? out.finalize() : "",
          stderr: err.finalize(),
          ...(bin !== null ? { stdoutBinary: bin.buffer, stdoutOverflow: bin.overflow } : {}),
          exitCode: null,
          timedOut: true,
          signal: null,
        });
      }, 2000);
    }, inputs.timeoutMs);
    let graceTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (buf: Buffer) => {
      if (out !== null) out.append(buf.toString("utf8"));
      else if (binOut !== null) binOut.append(buf);
    });
    child.stderr?.on("data", (buf: Buffer) => err.append(buf.toString("utf8")));
    if (inputs.stdin !== undefined) {
      child.stdin?.end(inputs.stdin);
    }
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      const bin = binOut !== null ? binOut.finalize() : null;
      finish({
        stdout: out !== null ? out.finalize() : "",
        stderr: err.finalize(),
        ...(bin !== null ? { stdoutBinary: bin.buffer, stdoutOverflow: bin.overflow } : {}),
        exitCode: code,
        timedOut,
        signal,
      });
    });
  });
}
