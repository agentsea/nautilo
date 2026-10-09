import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export const RETIRED_LOCAL_EXECUTION_MESSAGE =
  "This legacy local execution interface has been retired. Update Nautilo Desktop and use exec_command, write_stdin, or read_shell_output. No command was run.";

/**
 * run_shell timeout tiers.
 *
 * A blocking run_shell holds the bot's turn/lane for the command's whole
 * duration, and it CANNOT survive a server restart. So we tier the timeout:
 *
 *   - omitted            → relay default (60s)
 *   - ≤ soft cap         → used as-is, no justification
 *   - soft < t ≤ hard    → allowed ONLY with a non-empty timeout_reason. When
 *                          a Human approval surface occurs, Nautilo shows the
 *                          reason verbatim; automatic execution has no Human
 *                          judge, so it remains execution-intent/audit data.
 *   - > hard cap         → refused; long work should run in the background,
 *                          not block here (durability + lane-hold)
 *
 * Caps are env-overridable for deployments that know the tradeoff.
 */
function readEnvSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RUN_SHELL_SOFT_TIMEOUT_SECONDS = readEnvSeconds(
  "NAUTILO_RUN_SHELL_SOFT_TIMEOUT_SECONDS",
  1800, // 30 min
);
const RUN_SHELL_HARD_TIMEOUT_SECONDS = readEnvSeconds(
  "NAUTILO_RUN_SHELL_HARD_TIMEOUT_SECONDS",
  14_400, // 4 h
);

export type RunShellTimeoutResolution =
  | { ok: true; timeoutMs: number | undefined; requiresReason: boolean }
  | { ok: false; error: string };

/**
 * Pure resolver for the run_shell timeout tier. Returns the ms value to send
 * to the relay (or `undefined` to let the relay apply its 60s default), or a
 * coherent error to return to the model WITHOUT dispatching. Exported for tests.
 */
export function resolveRunShellTimeout(
  args: Record<string, unknown>,
  opts?: { soft?: number; hard?: number },
): RunShellTimeoutResolution {
  const soft = opts?.soft ?? RUN_SHELL_SOFT_TIMEOUT_SECONDS;
  const hard = opts?.hard ?? RUN_SHELL_HARD_TIMEOUT_SECONDS;

  if (
    args["output_artifact"] !== undefined &&
    (args["timeout_seconds"] !== undefined || args["timeout_reason"] !== undefined)
  ) {
    return {
      ok: false,
      error: "run_shell output_artifact retrieval does not accept shell timeout fields.",
    };
  }

  const raw = args["timeout_seconds"];
  if (raw === undefined || raw === null) {
    return { ok: true, timeoutMs: undefined, requiresReason: false };
  }

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: "run_shell: timeout_seconds must be a number of seconds." };
  }
  const secs = Math.ceil(raw);
  if (secs < 1) {
    return { ok: false, error: "run_shell: timeout_seconds must be at least 1 second." };
  }

  if (secs <= soft) {
    return { ok: true, timeoutMs: secs * 1000, requiresReason: false };
  }

  const reasonRaw = args["timeout_reason"];
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";

  if (secs <= hard) {
    if (!reason) {
      return {
        ok: false,
        error:
          `run_shell: timeout_seconds=${secs}s exceeds the ${soft}s soft cap. ` +
          "Pass a non-empty timeout_reason describing the wait, or lower the timeout.",
      };
    }
    return { ok: true, timeoutMs: secs * 1000, requiresReason: true };
  }

  return {
    ok: false,
    error:
      `run_shell: timeout_seconds=${secs}s exceeds the ${hard}s hard cap. ` +
      `A blocking shell can't survive a server restart and holds the turn the whole time — ` +
      `run long-running work in the background instead of waiting on it here.`,
  };
}

/**
 * A narrow tombstone retained only so persisted calls receive an actionable,
 * deterministic refusal. It is permanently unavailable to discovery and
 * activation in register-all.ts and intentionally carries no execution
 * arguments.
 */
export function createRetiredRunShellTool() {
  return new DynamicStructuredTool({
    name: "run_shell",
    description: RETIRED_LOCAL_EXECUTION_MESSAGE,
    schema: z.object({}).strict(),
    func: () => Promise.reject(new Error(RETIRED_LOCAL_EXECUTION_MESSAGE)),
  });
}
