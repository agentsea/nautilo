/**
 * Sandboxed subprocess runner. D060 Phase 1 task 1.8.
 *
 * `spawnSandboxed()` is the convenience wrapper around `Sandbox.wrap()`
 * + `child_process.spawn()` + stdout/stderr collection. Callers
 * (relay's `run_shell` handler, future agent-side exec paths, test
 * harnesses) invoke this instead of hand-rolling the spawn.
 *
 * WHY this lives in `@nautilo/sandbox` rather than `@nautilo/relay`:
 *   - The wrap/spawn composition is identical whether the caller is
 *     the Electron-side relay, the agent-side pre-model exec, or a
 *     test harness. Duplicating it across packages invites drift
 *     (one caller forgets `--die-with-parent`, etc.).
 *   - Keeping it next to the wrap() dispatcher means a single test
 *     file exercises both layers.
 *
 * Consumption pattern (from the per-turn policy envelope the server
 * delivers to the relay — see ship plan §5.4):
 *
 *     import { Sandbox, spawnSandboxed, sandboxPolicyForLevel } from "@nautilo/sandbox";
 *
 *     // Server's Policy Resolver builds the envelope from the
 *     // Server's config.toml [security] section + session context,
 *     // and ships it to the relay in each tool-call dispatch.
 *     const sandbox = await Sandbox.create(envelope.sandboxProfile);
 *
 *     // Per request:
 *     const result = await spawnSandboxed(sandbox, "/bin/sh", ["-c", command], {
 *       cwd, timeoutMs: req.timeout,
 *     });
 *
 * The caller gets back stdout / stderr / exitCode / timedOut — same
 * shape the relay's current `execAsync` produces, so the
 * relay-handler diff is small: rename `execAsync(command,...)` to
 * `spawnSandboxed(sandbox, "/bin/sh", ["-c", command], ...)`.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { warn } from "@nautilo/logger";

import type { Sandbox } from "./sandbox";

export interface SpawnSandboxedOptions {
  /** Working directory for the subprocess. Must be accessible inside the sandbox. */
  readonly cwd: string;
  /** Per-invocation env overrides (RESERVED skipped, DANGEROUS dropped in wrap()). */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill after this many ms. Default 60s; null delegates lifetime to the host signal. */
  readonly timeoutMs?: number | null;
  /** Existing enclosing host cancellation. Aborting kills the whole process group. */
  readonly abortSignal?: AbortSignal;
  /**
   * Observe stdout incrementally. Return `"stop"` when the caller has a
   * complete bounded result; the shared process-group cleanup terminates the
   * child and reports `stoppedEarly:true`.
   */
  readonly onStdoutChunk?: (chunk: Buffer) => "stop" | void;
  /** Incremental stderr observer with the same early-stop contract. */
  readonly onStderrChunk?: (chunk: Buffer) => "stop" | void;
  /**
   * Inline budget per stream (chars) — the MODEL-FACING size. Output beyond
   * this keeps the first half + last half of the budget with a truncation
   * marker between (head+tail); the middle is dropped (no disk spill).
   * Default 16 KiB (env `NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES`); sized for
   * context. Memory is bounded to ~this budget regardless of total output.
   */
  readonly maxBytesPerStream?: number;
  /**
   * Optional stdin content written to the child process and then
   * EOF\u0027d. D073 `execute_artifact` uses this to pipe data into
   * short scripts (e.g. `python3 analyze.py < input.json`). When
   * omitted stdin is closed immediately (same as pre-D073 behavior).
   */
  readonly stdin?: string;
}

export interface SpawnSandboxedResult {
  /** Inline stdout: full when under budget, else head + marker + tail. */
  readonly stdout: string;
  /** Inline stderr: full when under budget, else head + marker + tail. */
  readonly stderr: string;
  /** Null when the process was killed by signal or timeout before exit. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signal: NodeJS.Signals | null;
  /** True when stdout exceeded the inline budget (kept head+tail; middle dropped). */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** The enclosing AbortSignal terminated this process. */
  readonly aborted: boolean;
  /** A streaming observer requested normal early termination. */
  readonly stoppedEarly: boolean;
  /** Monotonic wall-clock duration from spawn setup through process close. */
  readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function defaultInlineBytes(): number {
  const raw = process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 16 KiB (8 KiB head + 8 KiB tail). This is the *model-facing* budget: the
  // inline value becomes the tool result the LLM sees, so it must be sized for
  // context. Matches the field standard (Codex ~10k, OpenClaw 16k LLM gate;
  // gemini/opencode/hermes/spacebot 40–50k). Truncated output keeps head+tail
  // with a "re-run with head/tail/sed" hint (no disk spill). (Pre-D276 this
  // defaulted to 1 MiB, which fed ~1 MiB into the model context and could
  // overflow the window.)
  return 16 * 1024;
}

/**
 * Bounded, in-memory head+tail capture. NO disk spill.
 *
 * Keeps the first `headBudget` chars and the last `tailBudget` chars; the full
 * stream flows THROUGH `append()` and is dropped after updating head/tail/total.
 * Retained memory is ~`inlineBudget` (default 16 KiB) per stream regardless of
 * total output size — a multi-GB command retains ~16 KiB, not the whole stream.
 *
 * We deliberately do NOT persist the full output to disk: a shared temp file is
 * an at-rest exposure on a multi-user host and accumulates trash. When output
 * is truncated the agent re-runs the command piped through head/tail/sed/grep
 * to fetch a specific section (the field-standard no-spill pattern).
 */
class StreamCapture {
  private head = "";
  private tail = "";
  private total = 0;
  private overflowed = false;
  private readonly headBudget: number;
  private readonly tailBudget: number;

  constructor(inlineBudget: number) {
    this.headBudget = Math.floor(inlineBudget / 2);
    this.tailBudget = inlineBudget - this.headBudget;
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

  /** Append to the tail ring, trimmed to `tailBudget`. Bounds even a single
   *  pathologically large chunk before it touches the retained buffer. */
  private pushTail(chunk: string): void {
    this.overflowed = true;
    const piece =
      chunk.length > this.tailBudget ? chunk.slice(chunk.length - this.tailBudget) : chunk;
    this.tail += piece;
    if (this.tail.length > this.tailBudget) {
      this.tail = this.tail.slice(this.tail.length - this.tailBudget);
    }
  }

  finalize(): { inline: string; truncated: boolean } {
    if (!this.overflowed) return { inline: this.head, truncated: false };
    const omitted = Math.max(0, this.total - this.head.length - this.tail.length);
    const inline =
      `${this.head}\n…[${omitted} chars truncated — re-run the command piped through ` +
      `head/tail/sed/grep to view a specific section]…\n${this.tail}`;
    return { inline, truncated: true };
  }
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      // `detached: true` makes the child the leader of a new process
      // group. Killing `-pid` catches grandchildren that inherited the
      // group's stdout/stderr pipes, so timeouts resolve at timeout
      // rather than after a nested `sleep` exits naturally.
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (err) {
      warn(
        `[sandbox/spawn] process-group kill failed; falling back to child kill: ${String(err)}`,
      );
    }
  }
  child.kill("SIGKILL");
}

/**
 * Spawn `program args...` inside the sandbox. Returns stdout / stderr
 * / exitCode. Never throws from normal subprocess behavior (non-zero
 * exits are just a return value); only throws if the spawn itself
 * fails (ENOENT for the sandbox binary, etc.) or if `sandbox.wrap()`
 * throws (e.g., macOS Seatbelt stub throw in Phase 1).
 *
 * Stdout/stderr are captured with an inline budget (`maxBytesPerStream`,
 * default 16 KiB). Output beyond the budget keeps the first half + last half
 * (head+tail) with a truncation marker; the middle is dropped (NO disk spill).
 * `stdoutTruncated`/`stderrTruncated` flag the overflow. Memory is bounded to
 * ~the budget per stream regardless of total output. To recover an omitted
 * section, re-run the command piped through head/tail/sed/grep.
 */
export function spawnSandboxed(
  sandbox: Sandbox,
  program: string,
  args: readonly string[],
  opts: SpawnSandboxedOptions,
): Promise<SpawnSandboxedResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  const inlineBudget = opts.maxBytesPerStream ?? defaultInlineBytes();

  const spawnArgs = sandbox.wrap(program, args, opts.cwd, opts.env ?? {});

  return new Promise<SpawnSandboxedResult>((resolve, reject) => {
    const wantsStdin = opts.stdin !== undefined;
    const child: ChildProcess = spawn(spawnArgs.program, [...spawnArgs.args], {
      cwd: spawnArgs.cwd,
      ...(process.platform !== "win32" ? { detached: true } : {}),
      // Most sandbox paths set env explicitly. `undefined` here means
      // "use parent env" and is reserved for callers that intentionally
      // return env=null.
      ...(spawnArgs.env !== null ? { env: spawnArgs.env } : {}),
      // stdin "pipe" when the caller supplied stdin content, "ignore"
      // otherwise. Piping when there\u0027s nothing to write would leave
      // the child waiting on a stdin that never closes.
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (wantsStdin && child.stdin !== null) {
      // Write then close — a closed stdin signals EOF so the child
      // reads "all input available" + exits on its own schedule.
      child.stdin.end(opts.stdin, "utf8");
    }

    const outCapture = new StreamCapture(inlineBudget);
    const errCapture = new StreamCapture(inlineBudget);
    let timedOut = false;
    let aborted = false;
    let stoppedEarly = false;
    let settled = false;

    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      killProcessTree(child);
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (opts.abortSignal?.aborted) onAbort();

    const observe = (
      handler: ((chunk: Buffer) => "stop" | void) | undefined,
      chunk: Buffer,
    ): void => {
      if (stoppedEarly || handler === undefined) return;
      if (handler(chunk) === "stop") {
        stoppedEarly = true;
        killProcessTree(child);
      }
    };

    child.stdout?.on("data", (buf: Buffer) => {
      outCapture.append(buf.toString("utf8"));
      observe(opts.onStdoutChunk, buf);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      errCapture.append(buf.toString("utf8"));
      observe(opts.onStderrChunk, buf);
    });

    child.on("error", (err) => {
      settled = true;
      if (timer !== null) clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, signal) => {
      settled = true;
      if (timer !== null) clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      const out = outCapture.finalize();
      const err = errCapture.finalize();
      resolve({
        stdout: out.inline,
        stderr: err.inline,
        exitCode: code,
        timedOut,
        signal,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        aborted,
        stoppedEarly,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
