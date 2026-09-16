/**
 * ISSUE-D202 — shared guard for DB-mutating dev commands targeting `(default)`.
 *
 * Policy (Wave 1 helper only; commands wire in later phases):
 * - Named instances: mutating commands proceed without this guard.
 * - `(default)` + dry-run/read-only: allowed (inspect dogfood state safely).
 * - `(default)` + mutating: requires explicit opt-in (`iKnowWhatIAmDoing` or
 *   `ALLOW_DEFAULT_DB_MUTATION=1`), including from the canonical `nautilo`
 *   checkout. Normal dogfood app use (dev-stack, server, desktop) is out of
 *   scope; only DB-mutating dev/fixture commands use this helper.
 * - Non-canonical `nautilo-*` worktrees: same refusal rule, with copy that
 *   calls out the worktree → default mismatch.
 *
 * Does not call `process.exit`; returns a decision object for callers.
 */
import { basename } from "node:path";
import { resolveDevInstanceId } from "./instance-id";

/** Env var escape hatch for intentional default DB mutation. */
export const ALLOW_DEFAULT_DB_MUTATION_ENV = "ALLOW_DEFAULT_DB_MUTATION";

/** Recommended disposable scratch instance (operator playbook). */
export const RECOMMENDED_SCRATCH_INSTANCE = "test-cruft";

const DEFAULT_INSTANCE_ALIASES = new Set(["default", "(default)"]);

export type WorktreeCheckoutKind = "canonical" | "nautilo-worktree" | "other";

export type DefaultInstanceMutationGuardInput = {
  /** Dev command name, e.g. `dev:restore`. */
  commandName: string;
  /** Resolved instance id (`""` = canonical default). */
  instanceId: string;
  /** Process cwd used for worktree classification in refusal copy. */
  cwd: string;
  /** True when the command will not write fixture/restore/migration state. */
  isDryRunOrReadOnly: boolean;
  /** CLI `--i-know-what-i-am-doing` (or equivalent) for intentional default mutation. */
  iKnowWhatIAmDoing?: boolean;
  /** Env snapshot; defaults to `process.env` when omitted in the resolver wrapper. */
  env?: NodeJS.ProcessEnv;
};

export type DefaultInstanceMutationGuardDecision =
  | {
      allowed: true;
      effectiveInstanceLabel: string;
      isDefaultInstance: boolean;
      worktreeCheckout: WorktreeCheckoutKind;
    }
  | {
      allowed: false;
      effectiveInstanceLabel: string;
      isDefaultInstance: true;
      worktreeCheckout: WorktreeCheckoutKind;
      message: string;
    };

function formatEffectiveInstanceLabel(instanceId: string): string {
  return instanceId === "" ? "(default)" : instanceId;
}

function isDefaultInstanceId(instanceId: string): boolean {
  const trimmed = instanceId.trim();
  if (trimmed === "") return true;
  return DEFAULT_INSTANCE_ALIASES.has(trimmed.toLowerCase());
}

/**
 * Classify cwd for D202 refusal context.
 * - `canonical`: basename exactly `nautilo` (dogfood checkout).
 * - `nautilo-worktree`: basename starts with `nautilo-`.
 * - `other`: everything else (still may resolve to default via explicit flags).
 */
export function classifyWorktreeCheckout(cwd: string): WorktreeCheckoutKind {
  const base = basename(cwd);
  if (base === "nautilo") return "canonical";
  if (base.startsWith("nautilo-")) return "nautilo-worktree";
  return "other";
}

function allowDefaultDbMutationFromEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  const raw = env?.[ALLOW_DEFAULT_DB_MUTATION_ENV];
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  return trimmed === "1" || trimmed.toLowerCase() === "true" || trimmed.toLowerCase() === "yes";
}

/**
 * Prefix the commandName with `bun run ` so the suggested commands in
 * the refusal message are copy-pasteable from the terminal. The
 * commandName as passed by callers is the npm-script alias (e.g.
 * `dev:migrate-add-agent-role`) — without `bun run ` it isn't a runnable
 * shell command. Plain identifiers without a `:` are left as-is in case
 * a caller passes a different format. See the original M118 follow-up
 * trail for why this matters.
 */
function asRunnableInvocation(commandName: string): string {
  if (commandName.includes(":")) return `bun run ${commandName}`;
  return commandName;
}

function buildRefusalMessage(input: {
  commandName: string;
  effectiveInstanceLabel: string;
  worktreeCheckout: WorktreeCheckoutKind;
  cwd: string;
}): string {
  const { commandName, effectiveInstanceLabel, worktreeCheckout, cwd } = input;
  const worktreeBase = basename(cwd);
  const invocation = asRunnableInvocation(commandName);
  const lines: string[] = [
    `Refusing ${commandName}: DB mutation against the protected ${effectiveInstanceLabel} instance.`,
    "",
    "The (default) instance holds operator dogfood state (real users, memories, recovery codes).",
    "DB-mutating dev commands must not touch it by accident from a feature worktree or agent guess.",
    "",
    `Use a scratch instance instead:`,
    `  ${invocation} --instance ${RECOMMENDED_SCRATCH_INSTANCE}`,
    `  # or: export NAUTILO_INSTANCE_ID=${RECOMMENDED_SCRATCH_INSTANCE}`,
  ];

  if (worktreeCheckout === "nautilo-worktree") {
    lines.push(
      "",
      `You are in worktree \`${worktreeBase}\` but this command resolved to (default).`,
      "Per-worktree isolation expects a named instance derived from the folder basename unless you explicitly pass --instance default.",
    );
  } else if (worktreeCheckout === "other") {
    lines.push(
      "",
      `Current directory basename is \`${worktreeBase}\` (not the canonical nautilo checkout).`,
      "Accidental (default) targeting is common when NAUTILO_INSTANCE_ID is unset in the shell.",
    );
  } else {
    lines.push(
      "",
      "Even in the canonical nautilo checkout, DB-mutating dev commands require explicit intent.",
      "Normal app/dogfood use (dev-stack, server, desktop) is unaffected.",
    );
  }

  lines.push(
    "",
    "Intentional (default) mutation (use only when you mean it):",
    `  ${invocation} --instance default --i-know-what-i-am-doing`,
    `  # or: ${ALLOW_DEFAULT_DB_MUTATION_ENV}=1 ${invocation} ...`,
  );

  return lines.join("\n");
}

/**
 * Pure decision: may this command mutate the DB for the given resolved instance?
 */
export function evaluateDefaultInstanceMutationGuard(
  input: DefaultInstanceMutationGuardInput,
): DefaultInstanceMutationGuardDecision {
  const effectiveInstanceLabel = formatEffectiveInstanceLabel(input.instanceId);
  const isDefault = isDefaultInstanceId(input.instanceId);
  const worktreeCheckout = classifyWorktreeCheckout(input.cwd);

  if (!isDefault) {
    return {
      allowed: true,
      effectiveInstanceLabel,
      isDefaultInstance: false,
      worktreeCheckout,
    };
  }

  if (input.isDryRunOrReadOnly) {
    return {
      allowed: true,
      effectiveInstanceLabel,
      isDefaultInstance: true,
      worktreeCheckout,
    };
  }

  if (input.iKnowWhatIAmDoing || allowDefaultDbMutationFromEnv(input.env)) {
    return {
      allowed: true,
      effectiveInstanceLabel,
      isDefaultInstance: true,
      worktreeCheckout,
    };
  }

  return {
    allowed: false,
    effectiveInstanceLabel,
    isDefaultInstance: true,
    worktreeCheckout,
    message: buildRefusalMessage({
      commandName: input.commandName,
      effectiveInstanceLabel,
      worktreeCheckout,
      cwd: input.cwd,
    }),
  };
}

export type ResolveDefaultInstanceMutationGuardOptions = {
  commandName: string;
  cwd: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  instanceOverride?: string;
  isDryRunOrReadOnly: boolean;
  iKnowWhatIAmDoing?: boolean;
};

/**
 * Resolve effective instance (same rules as dev-stack) then evaluate the guard.
 */
export function resolveAndEvaluateDefaultInstanceMutationGuard(
  opts: ResolveDefaultInstanceMutationGuardOptions,
): DefaultInstanceMutationGuardDecision {
  const argv = opts.argv ?? [];
  const env = opts.env ?? process.env;
  const instanceId = resolveDevInstanceId(
    argv,
    env,
    opts.cwd,
    opts.instanceOverride !== undefined ? { instance: opts.instanceOverride } : undefined,
  );

  const base: DefaultInstanceMutationGuardInput = {
    commandName: opts.commandName,
    instanceId,
    cwd: opts.cwd,
    isDryRunOrReadOnly: opts.isDryRunOrReadOnly,
    env,
  };
  if (opts.iKnowWhatIAmDoing !== undefined) {
    base.iKnowWhatIAmDoing = opts.iKnowWhatIAmDoing;
  }
  return evaluateDefaultInstanceMutationGuard(base);
}
