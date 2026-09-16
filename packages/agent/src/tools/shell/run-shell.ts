import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * run_shell timeout tiers (Stack 57).
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

const RUN_SHELL_DEFAULT_TIMEOUT_SECONDS = 60;
const RUN_SHELL_SOFT_TIMEOUT_SECONDS = readEnvSeconds(
  "NAUTILO_RUN_SHELL_SOFT_TIMEOUT_SECONDS",
  1800, // 30 min
);
const RUN_SHELL_HARD_TIMEOUT_SECONDS = readEnvSeconds(
  "NAUTILO_RUN_SHELL_HARD_TIMEOUT_SECONDS",
  14_400, // 4 h
);

const outputArtifactPageSchema = z
  .object({
    reference: z.string().min(32).describe("Opaque reference returned by a prior run_shell result."),
    offset_bytes: z.number().int().nonnegative().optional().describe("Page offset; omit for the first page."),
    max_bytes: z.number().int().positive().max(16 * 1024).optional().describe("Requested page bytes, capped at 16 KiB."),
    delete_after_read: z.boolean().optional().describe("Delete only when this read reaches the final page."),
  })
  .strict()
  .describe("Retrieve a bounded page from a short-lived Desktop-local run_shell continuation.");

const outputArtifactSearchSchema = z
  .object({
    reference: z.string().min(32).describe("Opaque reference returned by a prior run_shell result."),
    operation: z.literal("search"),
    query: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 1024, "Literal search query must be at most 1024 UTF-8 bytes.")
      .describe("Case-sensitive literal diagnostic, path, or test name to find; regex is not supported."),
    max_matches: z.number().int().positive().max(20).optional().describe("Maximum literal matches to return (at most 20)."),
    context_bytes: z.number().int().nonnegative().max(1024).optional().describe("Bytes of surrounding context per match (at most 1024)."),
  })
  .strict()
  .describe("Search already-retained output literally; this never reruns the original command.");

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

export function createRunShellTool() {
  return new DynamicStructuredTool({
    name: "run_shell",
    description:
      "Execute a one-shot shell command via the relay and return stdout/stderr. " +
      "Use for bounded development: git, tests, builds, file reads, and the baseline " +
      "(pwd / git rev-parse --show-toplevel / git status --short / runtime versions). " +
      "Starts from the user's selected Current Folder when one is available; otherwise it starts " +
      "from the visible Genie Workspace. Current Folder is only the initial working directory, " +
      "not a filesystem boundary after the shell starts. Nautilo derives the execution lane from " +
      "the live server policy and Desktop session; do not select an execution environment. An " +
      "active Developer Workstation supplies the requesting Human's approved local tools and CLI " +
      "identity while the command remains contained. Direct Mac changes containment only; it must " +
      "never make a tool, credential, Connection, or ordinary workstation capability appear. When " +
      "Direct Mac is active for this foreground Desktop, raw commands run as the " +
      "signed-in macOS user under `/bin/zsh -l -c`, are not sandboxed, and return command output " +
      "to the model. Critical destruction/elevation retains normal approval. For Bash-only or multiline scripts, use a literal single-quoted " +
      "heredoc (`/bin/bash <<'BASH'`), not a nested `/bin/bash -lc '…'` payload. Approval is " +
      "conditional: prove_it/ask by default, or auto-admitted for eligible profile-bound " +
      "attempts when Full Workstation Mode is active. Defaults to a 60s timeout; pass " +
      "timeout_seconds to wait on slow commands (up to " + RUN_SHELL_SOFT_TIMEOUT_SECONDS +
      "s freely, or up to " + RUN_SHELL_HARD_TIMEOUT_SECONDS + "s with a timeout_reason). " +
      "Do not use this for long-running/interactive work — use the terminal tool instead.\n\n" +
      "Exactly ONE of `command` (raw shell), `git` (a structured Git operation), or " +
      "`output_artifact` (bounded continuation retrieval). `git` is " +
      "routed to the typed GitBroker. Do NOT pass `git: \"...\"` as a string. A raw " +
      "`command: \"git ...\"` is never promoted into the broker. Use the structured `git` " +
      "variant only for its narrow broker-owned workflow while a Full Workstation profile " +
      "is active; `worktree-remove` only removes a broker-created worktree. For the user's " +
      "full installed Git/gh CLI, existing repositories/worktrees, host credentials, or " +
      "arbitrary Git operations, use raw `command`; Nautilo derives its lane from the live " +
      "Desktop session. The `git` " +
      "variant requires a Full Workstation profile-bound dispatch and an exact writable " +
      "grant for any worktree `target`; the broker preflights " +
      "identity, rejects alternates/submodules/symlinks/live-.env/pathspec magic, disables " +
      "hooks/filters/signing, and classifies sideEffectStarted/retrySafe. Never retry a " +
      "git disposition whose `retrySafe` is false. When a truncated raw-shell result includes " +
      "an opaque `outputArtifact.reference`, the preview is not evidence that you saw all " +
      "output. Its `capturedBytes`, `totalBytes`, and `truncated` fields are canonical: " +
      "`truncated: true` means Nautilo retained only a bounded prefix of sanitized output " +
      "after redaction and UTF-8 normalization, " +
      "while preview truncation can still have a complete retained capture. Use the mutually " +
      "exclusive `output_artifact` variant before its Desktop-local expiry: for a known error, " +
      "path, or test name, use literal `{operation: \"search\", query}` first; inspect each " +
      "returned stream-local match byte offset, artifact byte offset, and context, then use existing bounded " +
      "`{offset_bytes, max_bytes}` paging nearby (including a tail range) only as needed. " +
      "Do not blindly download every page or rerun an expensive or mutating command merely " +
      "to recover output. Search is bounded, case-sensitive literal matching, not regex. If a search " +
      "continuation returns `RUN_SHELL_OUTPUT_ARTIFACT_REQUEST_INVALID` from an older Desktop or " +
      "`RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_UNSUPPORTED`, fall back exactly once to legacy paging. " +
      "Missing or unavailable artifacts cannot be recovered by paging; never rerun the original command. Continue with " +
      "`nextOffsetBytes`; request deletion on the final page.",
    schema: z
      .object({
        command: z
          .string()
          .optional()
          .describe(
            "Raw shell command to execute (mutually exclusive with `git` and `output_artifact`). Nautilo " +
              "derives contained versus uncontained host execution from live authority; no lane selector is " +
              "accepted. A `command: \"git ...\"` string is NEVER parsed into the " +
              "typed broker.",
          ),
        git: z
          .discriminatedUnion("operation", [
            z.object({ operation: z.literal("status") }).describe(
              "git status --porcelain (read-only).",
            ),
            z
              .object({ operation: z.literal("diff"), ref: z.string().optional() })
              .describe("git diff (read-only); optional `ref` compares working tree to a ref/commit."),
            z
              .object({ operation: z.literal("add"), paths: z.array(z.string()).min(1) })
              .describe(
                "Stage explicit relative `paths` into the broker-owned index. No pathspecs, " +
                  "no magic, no live .env, no symlinks.",
              ),
            z
              .object({ operation: z.literal("commit"), message: z.string().min(1) })
              .describe(
                "Commit the broker-staged index with an explicit `message`. Requires a " +
                  "preceding `add`. Mutating; never retried when retrySafe is false.",
              ),
            z
              .object({
                operation: z.literal("worktree-add"),
                target: z.string(),
                ref: z.string(),
              })
              .describe(
                "git worktree add --no-checkout --detach <target> <ref>. `target` must be an " +
                  "empty directory inside an exact active writable grant — no implicit /tmp.",
              ),
            z
              .object({ operation: z.literal("worktree-remove"), target: z.string() })
              .describe(
                "Remove a broker-created worktree at `target`. Mutating; dirty removal is " +
                  "refused (no --force over operator files).",
              ),
          ])
          .optional()
          .describe(
            "Narrow structured GitBroker operation (mutually exclusive with `command`). " +
              "Requires an active Full Workstation profile; worktree-remove is only for a " +
              "broker-created worktree. For existing repositories/worktrees or the full " +
              "installed Git CLI, use raw `command`; Nautilo derives its execution lane.",
          ),
        output_artifact: z
          .union([outputArtifactPageSchema, outputArtifactSearchSchema])
          .optional()
          .describe("Retrieve a bounded page or literal-search a short-lived Desktop-local run_shell continuation."),
        cwd: z.string().optional().describe("Working directory (optional)"),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Max seconds before the command is killed. Defaults to ${RUN_SHELL_DEFAULT_TIMEOUT_SECONDS} ` +
              `when omitted. Up to ${RUN_SHELL_SOFT_TIMEOUT_SECONDS}s needs no justification; ` +
              `${RUN_SHELL_SOFT_TIMEOUT_SECONDS}–${RUN_SHELL_HARD_TIMEOUT_SECONDS}s requires timeout_reason. ` +
              `Note: a long command holds your turn for its whole duration and won't survive a restart — ` +
              `prefer background execution for very long work.`,
          ),
        timeout_reason: z
          .string()
          .optional()
          .describe(
            `Required only when timeout_seconds exceeds ${RUN_SHELL_SOFT_TIMEOUT_SECONDS}s. ` +
              "A non-empty description of the long wait. It is shown verbatim on a Human approval surface; " +
              "when execution is automatic, it is retained as execution intent/audit information.",
          ),
      })
      .superRefine((value, ctx) => {
        const hasCommand = typeof value.command === "string" && value.command.length > 0;
        const hasGit = value.git !== undefined;
        const hasArtifact = value.output_artifact !== undefined;
        if (Number(hasCommand) + Number(hasGit) + Number(hasArtifact) !== 1) {
          ctx.addIssue({
            code: "custom",
            message:
              "run_shell requires exactly one of `command`, `git`, or `output_artifact`.",
          });
        }
        if (hasArtifact && (value.timeout_seconds !== undefined || value.timeout_reason !== undefined)) {
          ctx.addIssue({
            code: "custom",
            message: "run_shell output_artifact retrieval does not accept shell timeout fields.",
          });
        }
      }),
    func: () => {
      return Promise.reject(new Error("run_shell is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken."));
    },
  });
}
